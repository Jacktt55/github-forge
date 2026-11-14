// mcp.ts — Model Context Protocol over streamable HTTP at /mcp.
//
// JSON-RPC 2.0, plain-JSON answers (no SSE). Modern revision 2026-07-28 via
// server/discover (supportedVersions + capabilities + serverInfo), with the legacy
// initialize + notifications/initialized handshake as a fallback. tools/list is a
// static array, byte-identical across calls. tools/call echoes the request id, so
// concurrent calls keep their own answers. No Authorization is exactly 401; a body
// that is not JSON is HTTP 400 with JSON-RPC -32700; an unknown tool is -32602;
// a missing required argument is a tool result with isError:true. The tools act on
// the same store as REST.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER, trialNowIso } from './scenario.ts';
import { store, type Repo } from './store.ts';
import { hasValidAuth, isRecord, parseJsonBody, readBody } from './http.ts';
import { mergeConflicts } from './rest.ts';
import { parseCommit } from './gitobj.ts';

const SERVER_INFO = { name: 'github-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required: string[];
  };
}

/** The static tool list: one object, serialized the same way every time. */
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login (the authenticated user).' },
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Issue state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function sendRpc(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function toolResult(result: Record<string, unknown>, isError = false): Record<string, unknown> {
  const out: Record<string, unknown> = {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
  };
  if (isError) out.isError = true;
  return out;
}

function toolError(message: string): Record<string, unknown> {
  return toolResult({ error: message, message }, true);
}

function stringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function numberArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function repoFor(args: Record<string, unknown>): Repo | null {
  const owner = stringArg(args, 'owner');
  const repo = stringArg(args, 'repo');
  if (owner === undefined || repo === undefined) return null;
  if (owner !== VIEWER.login) return null;
  return store.getRepo(owner, repo) ?? null;
}

function missingRequired(args: Record<string, unknown>, required: string[]): string | null {
  for (const name of required) {
    if (args[name] === undefined || args[name] === null || args[name] === '') return name;
  }
  return null;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const tool = TOOLS.find((t) => t.name === name);
  if (tool === undefined) return { __rpcError: -32602, __message: `Unknown tool: ${name}` };
  const missing = missingRequired(args, tool.inputSchema.required);
  if (missing !== null) return toolError(`Missing required argument: ${missing}`);

  if (name === 'create_repo') {
    const repoName = stringArg(args, 'name')!;
    const owner = stringArg(args, 'owner');
    if (owner !== undefined && owner !== VIEWER.login) return toolError(`Repository owner must be ${VIEWER.login}`);
    if (store.getRepo(VIEWER.login, repoName) !== undefined) return toolError(`Validation Failed: name already exists on this account`);
    const description = stringArg(args, 'description') ?? '';
    const isPrivate = args.private === true;
    const repo = store.createRepo(repoName, description, isPrivate);
    return toolResult({
      id: repo.id,
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      private: repo.isPrivate,
      default_branch: repo.defaultBranch,
      owner: { login: repo.owner },
      description: repo.description,
      html_url: `https://github.com/${repo.owner}/${repo.name}`,
      created_at: repo.createdAt,
      updated_at: repo.updatedAt,
    });
  }

  if (name === 'get_repo') {
    const repo = repoFor(args);
    if (repo === null) return toolError('Not Found');
    return toolResult({
      id: repo.id,
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      private: repo.isPrivate,
      default_branch: repo.defaultBranch,
      owner: { login: repo.owner },
      description: repo.description,
      html_url: `https://github.com/${repo.owner}/${repo.name}`,
      created_at: repo.createdAt,
      updated_at: repo.updatedAt,
    });
  }

  if (name === 'create_issue') {
    const repo = repoFor(args);
    if (repo === null) return toolError('Not Found');
    const title = stringArg(args, 'title')!;
    const body = stringArg(args, 'body') ?? '';
    const issue = store.createIssue(repo, title, body, []);
    return toolResult({
      id: issue.id,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
      html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
      user: { login: VIEWER.login },
      labels: [],
      created_at: issue.createdAt,
      updated_at: issue.updatedAt,
    });
  }

  if (name === 'list_issues') {
    const repo = repoFor(args);
    if (repo === null) return toolError('Not Found');
    const state = stringArg(args, 'state') ?? 'open';
    let issues = [...repo.issues];
    if (state !== 'all') issues = issues.filter((i) => i.state === state);
    issues.sort((a, b) => b.number - a.number);
    return toolResult({
      issues: issues.map((i) => ({
        id: i.id,
        number: i.number,
        title: i.title,
        body: i.body,
        state: i.state,
        user: { login: VIEWER.login },
        labels: i.labels,
        created_at: i.createdAt,
        updated_at: i.updatedAt,
      })),
    });
  }

  if (name === 'create_pull_request') {
    const repo = repoFor(args);
    if (repo === null) return toolError('Not Found');
    const title = stringArg(args, 'title')!;
    const body = stringArg(args, 'body') ?? '';
    const head = stringArg(args, 'head')!;
    const base = stringArg(args, 'base')!;
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (headSha === undefined || baseSha === undefined) return toolError('Validation Failed: head and base branches must exist');
    const mergeBaseSha = store.mergeBase(repo, headSha, baseSha) ?? baseSha;
    const pull = store.createPull(repo, title, body, head, base, headSha, baseSha, mergeBaseSha);
    return toolResult({
      id: pull.id,
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      head: { ref: head, sha: headSha },
      base: { ref: base, sha: baseSha },
      headRefName: head,
      baseRefName: base,
      url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
      html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
      created_at: pull.createdAt,
      updated_at: pull.updatedAt,
    });
  }

  if (name === 'merge_pull_request') {
    const repo = repoFor(args);
    if (repo === null) return toolError('Not Found');
    const number = numberArg(args, 'pull_number');
    if (number === undefined) return toolError('Missing required argument: pull_number');
    const pull = repo.pulls.find((p) => p.number === number);
    if (pull === undefined) return toolError('Not Found');
    if (pull.state === 'closed') return toolError('Pull request is already closed');
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (baseTip === undefined) return toolError('Not Found');
    if (mergeConflicts(repo, pull.mergeBaseSha, pull.headSha, baseTip)) return toolError('Merge conflict: this pull request cannot be merged');
    const headCommit = repo.objects.get(pull.headSha);
    if (headCommit === undefined) return toolError('Not Found');
    const headTree = parseCommit(headCommit.data).tree;
    const squashOid = store.makeCommit(repo, headTree, [baseTip], `${pull.title} (#${pull.number})`);
    repo.refs.set(`refs/heads/${pull.baseRef}`, squashOid);
    repo.updatedAt = trialNowIso();
    repo.pushedAt = trialNowIso();
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = trialNowIso();
    pull.mergeCommitSha = squashOid;
    pull.closedAt = trialNowIso();
    pull.updatedAt = trialNowIso();
    return toolResult({
      number: pull.number,
      merged: true,
      sha: squashOid,
      state: pull.state,
      merge_commit_sha: squashOid,
      message: 'Pull request successfully merged',
    });
  }

  return { __rpcError: -32602, __message: `Unknown tool: ${name}` };
}

/** Route the request; returns true when it was an /mcp request. */
export async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = (() => {
    try {
      return new URL(req.url ?? '/', 'http://entry').pathname;
    } catch {
      return '/';
    }
  })();
  if (path !== '/mcp') return false;
  if ((req.method ?? 'GET') !== 'POST') {
    sendRpc(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Method Not Allowed' } });
    return true;
  }
  if (!hasValidAuth(req)) {
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ message: 'Requires authentication' }));
    return true;
  }
  const raw = await readBody(req);
  const parsed = parseJsonBody(raw);
  if (!parsed.ok || !isRecord(parsed.value)) {
    sendRpc(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  const body = parsed.value;
  const id = body.id ?? null;
  const method = typeof body.method === 'string' ? body.method : '';
  const params = isRecord(body.params) ? body.params : {};

  // Notifications (no id) get 202 with an empty body.
  if (id === null && (method === 'notifications/initialized' || method.startsWith('notifications/'))) {
    res.writeHead(202);
    res.end();
    return true;
  }

  if (method === 'server/discover') {
    sendRpc(res, 200, rpcResult(id, {
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
      _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
    }));
    return true;
  }

  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : null;
    const chosen = requested !== null && SUPPORTED_VERSIONS.includes(requested) ? requested : '2026-07-28';
    sendRpc(res, 200, rpcResult(id, {
      protocolVersion: chosen,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    }));
    return true;
  }

  if (method === 'ping') {
    sendRpc(res, 200, rpcResult(id, {}));
    return true;
  }

  if (method === 'tools/list') {
    sendRpc(res, 200, rpcResult(id, { tools: TOOLS }));
    return true;
  }

  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    const outcome = await callTool(toolName, args);
    if (typeof outcome.__rpcError === 'number') {
      sendRpc(res, 200, rpcError(id, outcome.__rpcError, String(outcome.__message ?? 'Unknown tool')));
      return true;
    }
    sendRpc(res, 200, rpcResult(id, outcome));
    return true;
  }

  sendRpc(res, 200, rpcError(id, -32601, `Method not found: ${method}`));
  return true;
}
