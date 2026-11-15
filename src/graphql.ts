// graphql.ts — GitHub GraphQL v4 at /api/graphql.
//
// A small parser + executor for the documents gh and github-mcp-server actually send
// (viewer, repository, node, __type introspection, issue/pull-request reads and the five
// mutations), plus JSON-array batching (two operations in one body answer two results
// in order). Unknown fields are HTTP 200 with an errors array naming the field; an
// unknown repository is data.repository null with no errors; no token is exactly 401.
//
// Global ids are opaque base64 strings: R_<repoId>, I_<repoId>_<number>,
// PR_<repoId>_<number>, C_<repoId>_<number>_<commentId>, U_<userId> — the same ids
// the REST shapes use, so a mutation's id round-trips through node(id:).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER, publicUser, trialNowIso } from './scenario.ts';
import { store, type Issue, type Pull, type Repo } from './store.ts';
import { hasValidAuth, isRecord, parseJsonBody, pathOf, readBody, sendError, sendJson } from './http.ts';
import { diffTrees, mergeConflicts, pullMergeable } from './rest.ts';
import { parseCommit } from './gitobj.ts';

// ---------------------------------------------------------------- global ids

export function encodeGlobalId(raw: string): string {
  return Buffer.from(raw, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const raw = Buffer.from(id, 'base64').toString('utf8');
    const parts = raw.split('_');
    if (parts.length < 2) return null;
    return { kind: parts[0], parts: parts.slice(1) };
  } catch {
    return null;
  }
}

function repoGlobalId(repo: Repo): string {
  return encodeGlobalId(`R_${repo.id}`);
}
function issueGlobalId(repo: Repo, issue: Issue): string {
  return encodeGlobalId(`I_${repo.id}_${issue.number}`);
}
function pullGlobalId(repo: Repo, pull: Pull): string {
  return encodeGlobalId(`PR_${repo.id}_${pull.number}`);
}

// ---------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'Variable'; name: string }
  | { kind: 'Literal'; value: unknown }
  | { kind: 'Enum'; value: string }
  | { kind: 'Object'; fields: Record<string, ValueNode> }
  | { kind: 'List'; items: ValueNode[] };

interface FieldNode {
  kind: 'Field';
  name: string;
  alias: string | null;
  args: Record<string, ValueNode>;
  selection: SelectionNode[] | null;
}

interface FragmentSpreadNode {
  kind: 'FragmentSpread';
  name: string;
}

interface InlineFragmentNode {
  kind: 'InlineFragment';
  typeCondition: string | null;
  selection: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

interface OperationNode {
  kind: 'Operation';
  operation: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variableDefinitions: string[];
  selection: SelectionNode[];
}

interface FragmentNode {
  kind: 'Fragment';
  name: string;
  typeCondition: string;
  selection: SelectionNode[];
}

type DocumentNode = (OperationNode | FragmentNode)[];

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push('...');
      i += 3;
      continue;
    }
    if (ch === '$') {
      let j = i + 1;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j += 1;
      tokens.push(source.slice(i, j));
      i = j;
      continue;
    }
    if ('{}()[]:!=@&|'.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j += 1;
      tokens.push(source.slice(i, j));
      i = j;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j])) j += 1;
      tokens.push(source.slice(i, j));
      i = j;
      continue;
    }
    if (ch === '$') {
      let j = i + 1;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j += 1;
      tokens.push(source.slice(i, j));
      i = j;
      continue;
    }
    i += 1;
  }
  return tokens;
}

class Parser {
  #tokens: string[];
  #pos = 0;

  constructor(source: string) {
    this.#tokens = tokenize(source);
  }

  peek(): string | undefined {
    return this.#tokens[this.#pos];
  }

  next(): string {
    const token = this.#tokens[this.#pos];
    this.#pos += 1;
    return token;
  }

  expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new Error(`expected ${token}, got ${got ?? 'end of document'}`);
  }

  parseDocument(): DocumentNode {
    const nodes: DocumentNode = [];
    while (this.#pos < this.#tokens.length) {
      const token = this.peek();
      if (token === 'query' || token === 'mutation' || token === 'subscription') {
        nodes.push(this.parseOperation());
      } else if (token === 'fragment') {
        nodes.push(this.parseFragment());
      } else if (token === '{') {
        nodes.push({ kind: 'Operation', operation: 'query', name: null, variableDefinitions: [], selection: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected token ${token ?? 'end'}`);
      }
    }
    return nodes;
  }

  parseOperation(): OperationNode {
    const operation = this.next() as 'query' | 'mutation' | 'subscription';
    let name: string | null = null;
    const next = this.peek();
    if (next !== undefined && next !== '(' && next !== '{' && next !== '@') {
      name = this.next();
    }
    const variableDefinitions: string[] = [];
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')' && this.peek() !== undefined) {
        const token = this.next();
        if (token.startsWith('$')) variableDefinitions.push(token.slice(1));
        if (this.peek() === ':') {
          this.next();
          this.skipType();
        }
        if (this.peek() === '=') {
          this.next();
          this.parseValue();
        }
      }
      this.expect(')');
    }
    while (this.peek() === '@') this.parseDirective();
    return { kind: 'Operation', operation, name, variableDefinitions, selection: this.parseSelectionSet() };
  }

  skipType(): void {
    if (this.peek() === '[') {
      this.next();
      this.skipType();
      this.expect(']');
    } else {
      this.next();
    }
    if (this.peek() === '!') this.next();
  }

  parseDirective(): void {
    this.expect('@');
    this.next();
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')' && this.peek() !== undefined) {
        this.next();
        if (this.peek() === ':') {
          this.next();
          this.parseValue();
        }
      }
      this.expect(')');
    }
  }

  parseFragment(): FragmentNode {
    this.expect('fragment');
    const name = this.next();
    this.expect('on');
    const typeCondition = this.next();
    while (this.peek() === '@') this.parseDirective();
    return { kind: 'Fragment', name, typeCondition, selection: this.parseSelectionSet() };
  }

  parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const out: SelectionNode[] = [];
    while (this.peek() !== '}' && this.peek() !== undefined) {
      out.push(this.parseSelection());
    }
    this.expect('}');
    return out;
  }

  parseSelection(): SelectionNode {
    if (this.peek() === '...') {
      this.next();
      const token = this.next();
      if (token === 'on') {
        const typeCondition = this.next();
        while (this.peek() === '@') this.parseDirective();
        return { kind: 'InlineFragment', typeCondition, selection: this.parseSelectionSet() };
      }
      while (this.peek() === '@') this.parseDirective();
      return { kind: 'FragmentSpread', name: token };
    }
    let name = this.next();
    let alias: string | null = null;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args: Record<string, ValueNode> = {};
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')' && this.peek() !== undefined) {
        const argName = this.next();
        this.expect(':');
        args[argName] = this.parseValue();
      }
      this.expect(')');
    }
    while (this.peek() === '@') this.parseDirective();
    const selection = this.peek() === '{' ? this.parseSelectionSet() : null;
    return { kind: 'Field', name, alias, args, selection };
  }

  parseValue(): ValueNode {
    const token = this.next();
    if (token.startsWith('$')) return { kind: 'Variable', name: token.slice(1) };
    if (token === '{') {
      const fields: Record<string, ValueNode> = {};
      while (this.peek() !== '}' && this.peek() !== undefined) {
        const key = this.next();
        this.expect(':');
        fields[key] = this.parseValue();
      }
      this.expect('}');
      return { kind: 'Object', fields };
    }
    if (token === '[') {
      const items: ValueNode[] = [];
      while (this.peek() !== ']' && this.peek() !== undefined) items.push(this.parseValue());
      this.expect(']');
      return { kind: 'List', items };
    }
    if (token.startsWith('"')) return { kind: 'Literal', value: JSON.parse(token) as unknown };
    if (token === 'true') return { kind: 'Literal', value: true };
    if (token === 'false') return { kind: 'Literal', value: false };
    if (token === 'null') return { kind: 'Literal', value: null };
    if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(token)) return { kind: 'Literal', value: Number(token) };
    return { kind: 'Enum', value: token };
  }
}

// ---------------------------------------------------------------- schema

/** The fields each object type exposes (introspection answers read these lists). */
const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'email', 'avatarUrl', 'url', 'databaseId'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest',
  ],
  Ref: ['id', 'name', 'prefix', 'target'],
  Issue: ['id', 'number', 'title', 'state', 'body'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequest: ['id', 'number', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'title', 'body'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'filename', 'additions', 'deletions', 'changes'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  IssueComment: ['id', 'body'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'inputFields', 'interfaces', 'possibleTypes', 'ofType'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __TypeRef: ['kind', 'name', 'ofType'],
  __Schema: ['queryType', 'mutationType', 'subscriptionType', 'types', 'directives'],
};

const TYPE_KINDS: Record<string, string> = {
  Query: 'OBJECT',
  Mutation: 'OBJECT',
  User: 'OBJECT',
  Repository: 'OBJECT',
  Ref: 'OBJECT',
  Issue: 'OBJECT',
  IssueConnection: 'OBJECT',
  IssueEdge: 'OBJECT',
  PullRequest: 'OBJECT',
  PullRequestConnection: 'OBJECT',
  PullRequestEdge: 'OBJECT',
  PullRequestChangedFileConnection: 'OBJECT',
  PullRequestChangedFile: 'OBJECT',
  PageInfo: 'OBJECT',
  CreateIssuePayload: 'OBJECT',
  CloseIssuePayload: 'OBJECT',
  CreatePullRequestPayload: 'OBJECT',
  MergePullRequestPayload: 'OBJECT',
  AddCommentPayload: 'OBJECT',
  IssueCommentEdge: 'OBJECT',
  IssueComment: 'OBJECT',
  SearchType: 'ENUM',
  IssueState: 'ENUM',
  PullRequestState: 'ENUM',
  MergeMethod: 'ENUM',
  MergeableState: 'ENUM',
  OrderDirection: 'ENUM',
  IssueOrderField: 'ENUM',
  __Type: 'OBJECT',
  __Field: 'OBJECT',
  __InputValue: 'OBJECT',
  __EnumValue: 'OBJECT',
  __TypeRef: 'OBJECT',
  __Schema: 'OBJECT',
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'MILESTONE', 'COMMIT', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
};

function typeInfo(name: string): Record<string, unknown> | null {
  const kind = TYPE_KINDS[name];
  if (kind === undefined) return null;
  const info: Record<string, unknown> = { name, kind, description: null };
  if (kind === 'OBJECT' || kind === 'INTERFACE') {
    info.fields = (TYPE_FIELDS[name] ?? []).map((field) => ({
      name: field,
      description: null,
      args: [],
      type: { kind: 'SCALAR', name: 'String', ofType: null },
      isDeprecated: false,
      deprecationReason: null,
    }));
  }
  if (kind === 'ENUM') {
    info.enumValues = (ENUM_VALUES[name] ?? []).map((value) => ({
      name: value,
      description: null,
      isDeprecated: false,
      deprecationReason: null,
    }));
  }
  return info;
}

// ---------------------------------------------------------------- execution

interface ExecCtx {
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
  errors: { message: string }[];
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'Variable':
      return variables[node.name];
    case 'Literal':
      return node.value;
    case 'Enum':
      return node.value;
    case 'List':
      return node.items.map((item) => resolveValue(item, variables));
    case 'Object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = resolveValue(value, variables);
      return out;
    }
  }
}

function argValue(field: FieldNode, name: string, variables: Record<string, unknown>): unknown {
  const node = field.args[name];
  return node === undefined ? undefined : resolveValue(node, variables);
}

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexFromCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor === '') return -1;
  try {
    const raw = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(raw);
    return match === null ? -1 : Number(match[1]);
  } catch {
    return -1;
  }
}

interface ConnectionItem {
  node: unknown;
}

function paginateConnection<T>(items: readonly T[], first: number | undefined, after: string | undefined): { nodes: T[]; pageInfo: Record<string, unknown>; totalCount: number } {
  const start = indexFromCursor(after) + 1;
  const page = first === undefined ? items.slice(start) : items.slice(start, start + first);
  const endIndex = start + page.length - 1;
  return {
    nodes: page,
    pageInfo: {
      hasNextPage: endIndex + 1 < items.length,
      hasPreviousPage: start > 0,
      startCursor: page.length === 0 ? null : cursorFor(start),
      endCursor: page.length === 0 ? null : cursorFor(endIndex),
    },
    totalCount: items.length,
  };
}

type Value =
  | { __type: 'user'; user: { id: number; login: string } }
  | { __type: 'repo'; repo: Repo }
  | { __type: 'ref'; repo: Repo; name: string }
  | { __type: 'issue'; repo: Repo; issue: Issue }
  | { __type: 'pull'; repo: Repo; pull: Pull }
  | { __type: 'issueConn'; repo: Repo; issues: Issue[] }
  | { __type: 'pullConn'; repo: Repo; pulls: Pull[] }
  | { __type: 'fileConn'; repo: Repo; pull: Pull }
  | { __type: 'type'; name: string }
  | { __type: 'schema' }
  | { __type: 'payload'; kind: string; repo: Repo; issue?: Issue; pull?: Pull; comment?: { id: string; body: string } }
  | { __type: 'commentEdge'; comment: { id: string; body: string } }
  | { __type: 'comment'; comment: { id: string; body: string } }
  | { __type: 'file'; path: string }
  | { __type: 'query' }
  | { __type: 'mutation' };

function typeNameOf(value: Value): string {
  switch (value.__type) {
    case 'user': return 'User';
    case 'repo': return 'Repository';
    case 'ref': return 'Ref';
    case 'issue': return 'Issue';
    case 'pull': return 'PullRequest';
    case 'issueConn': return 'IssueConnection';
    case 'pullConn': return 'PullRequestConnection';
    case 'fileConn': return 'PullRequestChangedFileConnection';
    case 'type': return '__Type';
    case 'schema': return '__Schema';
    case 'payload': return value.kind;
    case 'commentEdge': return 'IssueCommentEdge';
    case 'comment': return 'IssueComment';
    case 'file': return 'PullRequestChangedFile';
    case 'query': return 'Query';
    case 'mutation': return 'Mutation';
  }
}

function executeSelection(
  selection: SelectionNode[],
  parentType: string,
  parentValue: Value | null,
  ctx: ExecCtx,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const node of selection) {
    if (node.kind === 'FragmentSpread') {
      const fragment = ctx.fragments.get(node.name);
      if (fragment !== undefined) Object.assign(out, executeSelection(fragment.selection, parentType, parentValue, ctx));
      continue;
    }
    if (node.kind === 'InlineFragment') {
      if (node.typeCondition === null || node.typeCondition === parentType) {
        Object.assign(out, executeSelection(node.selection, parentType, parentValue, ctx));
      }
      continue;
    }
    const field = node;
    const responseKey = field.alias ?? field.name;
    const allowed = TYPE_FIELDS[parentType] ?? [];
    if (!allowed.includes(field.name) && field.name !== '__typename') {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${parentType}".` });
      out[responseKey] = null;
      continue;
    }
    out[responseKey] = executeField(field, parentType, parentValue, ctx);
  }
  return out;
}

function executeField(field: FieldNode, parentType: string, parentValue: Value | null, ctx: ExecCtx): unknown {
  if (field.name === '__typename') return parentType;
  const selection = field.selection ?? [];

  if (parentType === 'Query') {
    if (field.name === 'viewer') {
      const value: Value = { __type: 'user', user: { id: VIEWER.id, login: VIEWER.login } };
      return executeSelection(selection, 'User', value, ctx);
    }
    if (field.name === 'repository') {
      const owner = argValue(field, 'owner', ctx.variables) as string | undefined;
      const name = argValue(field, 'name', ctx.variables) as string | undefined;
      if (owner !== VIEWER.login) return null;
      const repo = store.getRepo(owner ?? '', name ?? '');
      if (repo === undefined) return null;
      const value: Value = { __type: 'repo', repo };
      return executeSelection(selection, 'Repository', value, ctx);
    }
    if (field.name === 'node') {
      const id = argValue(field, 'id', ctx.variables) as string | undefined;
      const decoded = id === undefined ? null : decodeGlobalId(id);
      if (decoded === null) return null;
      if (decoded.kind === 'R') {
        const repoId = Number(decoded.parts[0]);
        for (const repo of store.repos.values()) {
          if (repo.id === repoId) {
            const value: Value = { __type: 'repo', repo };
            return executeSelection(selection, 'Repository', value, ctx);
          }
        }
        return null;
      }
      if (decoded.kind === 'I') {
        const repoId = Number(decoded.parts[0]);
        const number = Number(decoded.parts[1]);
        for (const repo of store.repos.values()) {
          if (repo.id !== repoId) continue;
          const issue = repo.issues.find((i) => i.number === number);
          if (issue === undefined) return null;
          const value: Value = { __type: 'issue', repo, issue };
          return executeSelection(selection, 'Issue', value, ctx);
        }
        return null;
      }
      if (decoded.kind === 'PR') {
        const repoId = Number(decoded.parts[0]);
        const number = Number(decoded.parts[1]);
        for (const repo of store.repos.values()) {
          if (repo.id !== repoId) continue;
          const pull = repo.pulls.find((p) => p.number === number);
          if (pull === undefined) return null;
          const value: Value = { __type: 'pull', repo, pull };
          return executeSelection(selection, 'PullRequest', value, ctx);
        }
        return null;
      }
      return null;
    }
    if (field.name === '__type') {
      const name = argValue(field, 'name', ctx.variables) as string | undefined;
      if (name === undefined) return null;
      const value: Value = { __type: 'type', name };
      return executeSelection(selection, '__Type', value, ctx);
    }
    if (field.name === '__schema') {
      const value: Value = { __type: 'schema' };
      return executeSelection(selection, '__Schema', value, ctx);
    }
    return null;
  }

  if (parentType === 'Mutation' && parentValue !== null) {
    return executeMutation(field, ctx);
  }

  if (parentValue === null) return null;
  const value = parentValue;

  switch (value.__type) {
    case 'user': {
      switch (field.name) {
        case 'id': return encodeGlobalId(`U_${value.user.id}`);
        case 'login': return value.user.login;
        case 'name': return publicUser(VIEWER).name;
        case 'email': return VIEWER.email;
        case 'databaseId': return value.user.id;
        case 'avatarUrl': return `https://avatars.githubusercontent.com/u/${value.user.id}?v=4`;
        case 'url': return `https://github.com/${value.user.login}`;
        default: return null;
      }
    }
    case 'repo': {
      const repo = value.repo;
      switch (field.name) {
        case 'id': return repoGlobalId(repo);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
        case 'owner': {
          const owner: Value = { __type: 'user', user: { id: VIEWER.id, login: repo.owner } };
          return executeSelection(selection, 'User', owner, ctx);
        }
        case 'defaultBranchRef': {
          const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          if (tip === undefined) return null;
          const ref: Value = { __type: 'ref', repo, name: repo.defaultBranch };
          return executeSelection(selection, 'Ref', ref, ctx);
        }
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'issue': {
          const number = argValue(field, 'number', ctx.variables) as number | undefined;
          const issue = repo.issues.find((i) => i.number === number);
          if (issue === undefined) return null;
          const issueValue: Value = { __type: 'issue', repo, issue };
          return executeSelection(selection, 'Issue', issueValue, ctx);
        }
        case 'issues': {
          const first = argValue(field, 'first', ctx.variables) as number | undefined;
          const after = argValue(field, 'after', ctx.variables) as string | undefined;
          const states = argValue(field, 'states', ctx.variables) as string[] | undefined;
          const orderBy = argValue(field, 'orderBy', ctx.variables) as { field?: string; direction?: string } | undefined;
          let issues = [...repo.issues];
          if (states !== undefined) {
            const wanted = new Set(states.map((s) => String(s).toLowerCase()));
            issues = issues.filter((i) => wanted.has(i.state));
          }
          const direction = orderBy?.direction ?? 'DESC';
          issues.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
          const conn: Value = { __type: 'issueConn', repo, issues };
          return executeConnection(field, conn, issues, first, after, ctx, 'Issue');
        }
        case 'pullRequests': {
          const first = argValue(field, 'first', ctx.variables) as number | undefined;
          const after = argValue(field, 'after', ctx.variables) as string | undefined;
          const conn: Value = { __type: 'pullConn', repo, pulls: [...repo.pulls] };
          return executeConnection(field, conn, [...repo.pulls], first, after, ctx, 'PullRequest');
        }
        case 'pullRequest': {
          const number = argValue(field, 'number', ctx.variables) as number | undefined;
          const pull = repo.pulls.find((p) => p.number === number);
          if (pull === undefined) return null;
          const pullValue: Value = { __type: 'pull', repo, pull };
          return executeSelection(selection, 'PullRequest', pullValue, ctx);
        }
        default: return null;
      }
    }
    case 'ref': {
      switch (field.name) {
        case 'id': return encodeGlobalId(`Ref_${value.repo.id}_${value.name}`);
        case 'name': return value.name;
        case 'prefix': return 'refs/heads/';
        case 'target': return null;
        default: return null;
      }
    }
    case 'issue': {
      const issue = value.issue;
      switch (field.name) {
        case 'id': return issueGlobalId(value.repo, issue);
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'state': return issue.state.toUpperCase();
        case 'body': return issue.body;
        default: return null;
      }
    }
    case 'pull': {
      const pull = value.pull;
      switch (field.name) {
        case 'id': return pullGlobalId(value.repo, pull);
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        case 'merged': return pull.merged;
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'mergeable': {
          const mergeable = pullMergeable(value.repo, pull);
          return mergeable === null ? 'UNKNOWN' : mergeable ? 'MERGEABLE' : 'CONFLICTING';
        }
        case 'files': {
          const first = argValue(field, 'first', ctx.variables) as number | undefined;
          const after = argValue(field, 'after', ctx.variables) as string | undefined;
          const headCommit = value.repo.objects.get(pull.headSha);
          const baseCommit = value.repo.objects.get(pull.mergeBaseSha);
          if (headCommit === undefined || baseCommit === undefined) {
            return executeConnection(field, { __type: 'fileConn', repo: value.repo, pull }, [], first, after, ctx, 'PullRequestChangedFile');
          }
          const files = diffTrees(value.repo, parseCommit(baseCommit.data).tree, parseCommit(headCommit.data).tree);
          const conn: Value = { __type: 'fileConn', repo: value.repo, pull };
          return executeConnection(field, conn, files.map((f) => ({ path: f.filename })), first, after, ctx, 'PullRequestChangedFile');
        }
        default: return null;
      }
    }
    case 'type': {
      const info = typeInfo(value.name);
      if (info === null) return null;
      switch (field.name) {
        case 'name': return info.name;
        case 'kind': return info.kind;
        case 'description': return info.description;
        case 'fields': return info.fields ?? null;
        case 'enumValues': return info.enumValues ?? null;
        case 'inputFields': return null;
        case 'interfaces': return [];
        case 'possibleTypes': return null;
        case 'ofType': return null;
        default: return null;
      }
    }
    case 'schema': {
      switch (field.name) {
        case 'queryType': return { name: 'Query' };
        case 'mutationType': return { name: 'Mutation' };
        case 'subscriptionType': return null;
        case 'types': return Object.keys(TYPE_KINDS).map((name) => ({ name, kind: TYPE_KINDS[name] }));
        case 'directives': return [];
        default: return null;
      }
    }
    case 'payload': {
      switch (field.name) {
        case 'issue': {
          if (value.issue === undefined) return null;
          const issueValue: Value = { __type: 'issue', repo: value.repo, issue: value.issue };
          return executeSelection(selection, 'Issue', issueValue, ctx);
        }
        case 'pullRequest': {
          if (value.pull === undefined) return null;
          const pullValue: Value = { __type: 'pull', repo: value.repo, pull: value.pull };
          return executeSelection(selection, 'PullRequest', pullValue, ctx);
        }
        case 'commentEdge': {
          if (value.comment === undefined) return null;
          const edge: Value = { __type: 'commentEdge', comment: value.comment };
          return executeSelection(selection, 'IssueCommentEdge', edge, ctx);
        }
        case 'clientMutationId': return null;
        default: return null;
      }
    }
    case 'commentEdge': {
      switch (field.name) {
        case 'node': {
          const comment: Value = { __type: 'comment', comment: value.comment };
          return executeSelection(selection, 'IssueComment', comment, ctx);
        }
        case 'cursor': return cursorFor(0);
        default: return null;
      }
    }
    case 'comment': {
      switch (field.name) {
        case 'id': return value.comment.id;
        case 'body': return value.comment.body;
        default: return null;
      }
    }
    case 'file': {
      switch (field.name) {
        case 'path': return value.path;
        case 'filename': return value.path;
        case 'additions': return 0;
        case 'deletions': return 0;
        case 'changes': return 0;
        default: return null;
      }
    }
    default:
      return null;
  }
}

function executeConnection(
  field: FieldNode,
  connValue: Value,
  items: readonly unknown[],
  first: number | undefined,
  after: string | undefined,
  ctx: ExecCtx,
  itemType: string,
): Record<string, unknown> {
  const selection = field.selection ?? [];
  const page = paginateConnection(items, first, after);
  const out: Record<string, unknown> = {};
  for (const node of selection) {
    if (node.kind !== 'Field') continue;
    const responseKey = node.alias ?? node.name;
    if (node.name === 'nodes') {
      out[responseKey] = page.nodes.map((item, index) => {
        const child = connectionChild(connValue, item, itemType);
        if (child === null) return null;
        if (node.selection === null) return child;
        return executeSelection(node.selection, itemType, child, ctx);
      });
    } else if (node.name === 'edges') {
      out[responseKey] = page.nodes.map((item, index) => {
        const child = connectionChild(connValue, item, itemType);
        if (child === null) return null;
        const edgeSelection = node.selection ?? [];
        const edgeOut: Record<string, unknown> = {};
        for (const edgeField of edgeSelection) {
          if (edgeField.kind !== 'Field') continue;
          const key = edgeField.alias ?? edgeField.name;
          if (edgeField.name === 'node') {
            edgeOut[key] = edgeField.selection === null ? child : executeSelection(edgeField.selection, itemType, child, ctx);
          } else if (edgeField.name === 'cursor') {
            edgeOut[key] = cursorFor(indexFromCursor(after) + 1 + index);
          }
        }
        return edgeOut;
      });
    } else if (node.name === 'pageInfo') {
      const infoSelection = node.selection ?? [];
      const infoOut: Record<string, unknown> = {};
      for (const infoField of infoSelection) {
        if (infoField.kind !== 'Field') continue;
        const key = infoField.alias ?? infoField.name;
        infoOut[key] = page.pageInfo[infoField.name] ?? null;
      }
      out[responseKey] = infoOut;
    } else if (node.name === 'totalCount') {
      out[responseKey] = page.totalCount;
    }
  }
  return out;
}

function connectionChild(connValue: Value, item: unknown, itemType: string): Value | null {
  if (itemType === 'Issue' && connValue.__type === 'issueConn') {
    return { __type: 'issue', repo: connValue.repo, issue: item as Issue };
  }
  if (itemType === 'PullRequest' && connValue.__type === 'pullConn') {
    return { __type: 'pull', repo: connValue.repo, pull: item as Pull };
  }
  if (itemType === 'PullRequestChangedFile') {
    const path = isRecord(item) ? (item.path as string | undefined) ?? '' : '';
    return { __type: 'file', path };
  }
  return null;
}

function executeMutation(field: FieldNode, ctx: ExecCtx): unknown {
  const selection = field.selection ?? [];
  const input = argValue(field, 'input', ctx.variables) as Record<string, unknown> | undefined;
  const repoOf = (globalId: string | undefined): Repo | null => {
    if (globalId === undefined) return null;
    const decoded = decodeGlobalId(globalId);
    if (decoded === null || decoded.kind !== 'R') return null;
    const repoId = Number(decoded.parts[0]);
    for (const repo of store.repos.values()) if (repo.id === repoId) return repo;
    return null;
  };

  if (field.name === 'createIssue') {
    const repo = repoOf(input?.repositoryId as string | undefined);
    if (repo === null) return null;
    const title = (input?.title as string | undefined) ?? '';
    const body = (input?.body as string | undefined) ?? '';
    const issue = store.createIssue(repo, title, body, []);
    const payload: Value = { __type: 'payload', kind: 'CreateIssuePayload', repo, issue };
    return executeSelection(selection, 'CreateIssuePayload', payload, ctx);
  }
  if (field.name === 'closeIssue') {
    const issueId = input?.issueId as string | undefined;
    const decoded = issueId === undefined ? null : decodeGlobalId(issueId);
    if (decoded === null || decoded.kind !== 'I') return null;
    const repoId = Number(decoded.parts[0]);
    const number = Number(decoded.parts[1]);
    for (const repo of store.repos.values()) {
      if (repo.id !== repoId) continue;
      const issue = repo.issues.find((i) => i.number === number);
      if (issue === undefined) return null;
      issue.state = 'closed';
      issue.closedAt = trialNowIso();
      // The issue's serialized REST response changed: invalidate its cache.
      issue.version += 1;
      const payload: Value = { __type: 'payload', kind: 'CloseIssuePayload', repo, issue };
      return executeSelection(selection, 'CloseIssuePayload', payload, ctx);
    }
    return null;
  }
  if (field.name === 'createPullRequest') {
    const repo = repoOf(input?.repositoryId as string | undefined);
    if (repo === null) return null;
    const head = (input?.headRefName as string | undefined) ?? '';
    const base = (input?.baseRefName as string | undefined) ?? repo.defaultBranch;
    const title = (input?.title as string | undefined) ?? '';
    const body = (input?.body as string | undefined) ?? '';
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (headSha === undefined || baseSha === undefined) return null;
    const mergeBaseSha = store.mergeBase(repo, headSha, baseSha) ?? baseSha;
    const pull = store.createPull(repo, title, body, head, base, headSha, baseSha, mergeBaseSha);
    const payload: Value = { __type: 'payload', kind: 'CreatePullRequestPayload', repo, pull };
    return executeSelection(selection, 'CreatePullRequestPayload', payload, ctx);
  }
  if (field.name === 'mergePullRequest') {
    const pullId = input?.pullRequestId as string | undefined;
    const decoded = pullId === undefined ? null : decodeGlobalId(pullId);
    if (decoded === null || decoded.kind !== 'PR') return null;
    const repoId = Number(decoded.parts[0]);
    const number = Number(decoded.parts[1]);
    for (const repo of store.repos.values()) {
      if (repo.id !== repoId) continue;
      const pull = repo.pulls.find((p) => p.number === number);
      if (pull === undefined || pull.state === 'closed') return null;
      const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
      if (baseTip === undefined) return null;
      if (mergeConflicts(repo, pull.mergeBaseSha, pull.headSha, baseTip)) {
        ctx.errors.push({ message: 'Merge conflict: this pull request cannot be merged' });
        return null;
      }
      const headCommit = repo.objects.get(pull.headSha);
      if (headCommit === undefined) return null;
      const headTree = parseCommit(headCommit.data).tree;
      const squashOid = store.makeCommit(repo, headTree, [baseTip], `${pull.title} (#${pull.number})`);
      repo.refs.set(`refs/heads/${pull.baseRef}`, squashOid);
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = trialNowIso();
      pull.mergeCommitSha = squashOid;
      pull.closedAt = pull.mergedAt;
      const payload: Value = { __type: 'payload', kind: 'MergePullRequestPayload', repo, pull };
      return executeSelection(selection, 'MergePullRequestPayload', payload, ctx);
    }
    return null;
  }
  if (field.name === 'addComment') {
    const subjectId = input?.subjectId as string | undefined;
    const body = (input?.body as string | undefined) ?? '';
    const decoded = subjectId === undefined ? null : decodeGlobalId(subjectId);
    if (decoded === null) return null;
    const repoId = Number(decoded.parts[0]);
    const number = Number(decoded.parts[1]);
    for (const repo of store.repos.values()) {
      if (repo.id !== repoId) continue;
      const target = decoded.kind === 'I'
        ? repo.issues.find((i) => i.number === number)
        : decoded.kind === 'PR'
          ? repo.pulls.find((p) => p.number === number)
          : undefined;
      if (target === undefined) return null;
      const commentId = store.nextCommentId(repo);
      const comment = { id: commentId, body, user: VIEWER.login, createdAt: trialNowIso(), updatedAt: trialNowIso() };
      target.comments.push(comment);
      // A comment on an issue changes its REST response (comments count).
      if (decoded.kind === 'I') (target as Issue).version += 1;
      const globalId = encodeGlobalId(`C_${repo.id}_${number}_${commentId}`);
      const payload: Value = {
        __type: 'payload',
        kind: 'AddCommentPayload',
        repo,
        comment: { id: globalId, body },
      };
      return executeSelection(selection, 'AddCommentPayload', payload, ctx);
    }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------- handler

function executeOperation(operation: OperationNode, fragments: Map<string, FragmentNode>, variables: Record<string, unknown>): Record<string, unknown> {
  const ctx: ExecCtx = { variables, fragments, errors: [] };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const rootValue: Value = operation.operation === 'mutation' ? { __type: 'mutation' } : { __type: 'query' };
  const data = executeSelection(operation.selection, rootType, rootValue, ctx);
  const out: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) out.errors = ctx.errors;
  return out;
}

/** Route the request; returns true when it was a /api/graphql request. */
export async function handleGraphql(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = pathOf(req);
  if (path !== '/api/graphql') return false;
  if ((req.method ?? 'GET') !== 'POST') {
    sendError(res, 405, 'Method Not Allowed');
    return true;
  }
  if (!hasValidAuth(req)) {
    sendError(res, 401, 'Requires authentication');
    return true;
  }
  const raw = await readBody(req);
  const parsed = parseJsonBody(raw);
  if (!parsed.ok) {
    sendError(res, 400, 'Problems parsing JSON');
    return true;
  }
  const operations = Array.isArray(parsed.value) ? parsed.value : [parsed.value];
  const results: Record<string, unknown>[] = [];
  for (const operation of operations) {
    if (!isRecord(operation) || typeof operation.query !== 'string') {
      results.push({ data: null, errors: [{ message: 'A GraphQL operation needs a query string.' }] });
      continue;
    }
    const variables = isRecord(operation.variables) ? (operation.variables as Record<string, unknown>) : {};
    let document: DocumentNode;
    try {
      document = new Parser(operation.query).parseDocument();
    } catch (err) {
      results.push({ data: null, errors: [{ message: err instanceof Error ? err.message : 'Failed to parse the query.' }] });
      continue;
    }
    const fragments = new Map<string, FragmentNode>();
    const ops: OperationNode[] = [];
    for (const node of document) {
      if (node.kind === 'Fragment') fragments.set(node.name, node);
      else ops.push(node);
    }
    const target = operation.operationName !== undefined && typeof operation.operationName === 'string'
      ? ops.find((op) => op.name === operation.operationName) ?? ops[0]
      : ops[0];
    if (target === undefined) {
      results.push({ data: null, errors: [{ message: 'No operation in the document.' }] });
      continue;
    }
    try {
      results.push(executeOperation(target, fragments, variables));
    } catch (err) {
      results.push({ data: null, errors: [{ message: err instanceof Error ? err.message : 'Execution failed.' }] });
    }
  }
  sendJson(res, 200, Array.isArray(parsed.value) ? results : results[0]);
  return true;
}
