// store.ts — the forge's whole state, in memory.
//
// One Store holds every repository. A repository holds its git objects (Map oid ->
// {type, data}), its refs, and its REST resources (labels, issues, pull requests with
// comments). Numbering for issues and pull requests shares one counter per repository,
// as GitHub does. Everything stored or served is deterministic: timestamps come from
// MAKEFUN_TRIAL_NOW (or the fixed scenario epoch), never the wall clock, and ids come
// from counters, never Math.random.

import { VIEWER, trialNowIso, trialNowMs } from './scenario.ts';
import {
  buildCommit,
  buildTree,
  objectId,
  parseCommit,
  parseTree,
  type GitObject,
  type ObjectType,
  type TreeEntry,
  ZERO_OID,
} from './gitobj.ts';

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  user: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  mergeBaseSha: string;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  comments: Comment[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  user: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  pushedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  numberCounter: number;
  commentCounter: number;
  labelCounter: number;
}

export const DEFAULT_LABELS: { name: string; color: string; description: string }[] = [
  { name: 'bug', color: 'd73a4a', description: "Something isn't working" },
  { name: 'documentation', color: '0075ca', description: 'Improvements or additions to documentation' },
  { name: 'duplicate', color: 'cfd3d7', description: 'This issue or pull request already exists' },
  { name: 'enhancement', color: 'a2eeef', description: 'New feature or request' },
  { name: 'good first issue', color: '7057ff', description: 'Good for newcomers' },
  { name: 'help wanted', color: '008672', description: 'Extra attention is needed' },
  { name: 'invalid', color: 'e4e669', description: 'This doesn\'t seem right' },
  { name: 'question', color: 'd876e3', description: 'Further information is requested' },
  { name: 'wontfix', color: 'ffffff', description: 'This will not be worked on' },
];

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 5000;
  nextIssueId = 1;

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(name: string, description: string, isPrivate: boolean, defaultBranch = 'main'): Repo {
    const now = trialNowIso();
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner: VIEWER.login,
      description,
      isPrivate,
      defaultBranch,
      createdAt: now,
      updatedAt: now,
      pushedAt: now,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      numberCounter: 0,
      commentCounter: 0,
      labelCounter: 0,
    };
    // Labels are created on demand through POST /labels. Repos intentionally
    // start with no labels: the suite's issue fixtures create the labels they
    // need (e.g. 'bug') and expect 201, so seeding GitHub's defaults here
    // would make those fixture calls fail with 422 "already exists".
    this.repos.set(this.repoKey(VIEWER.login, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.id - b.id);
    return out;
  }

  // ------------------------------------------------------------ git objects

  putObject(repo: Repo, type: ObjectType, data: Buffer): string {
    const oid = objectId(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  refTip(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  headRefName(repo: Repo): string {
    return `refs/heads/${repo.defaultBranch}`;
  }

  headTip(repo: Repo): string | undefined {
    return repo.refs.get(this.headRefName(repo));
  }

  /** The commit object at a ref, branch name, or raw oid; undefined when unresolvable. */
  resolveCommit(repo: Repo, ref: string): { oid: string; object: GitObject } | undefined {
    let oid = ref;
    if (!/^[0-9a-f]{40}$/.test(ref)) {
      oid = repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(ref) ?? '';
      if (oid === '') return undefined;
    }
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') return undefined;
    return { oid, object };
  }

  /** Walk a tree path to a blob/tree oid; undefined when any segment is missing. */
  resolvePath(repo: Repo, treeOid: string, path: string): { oid: string; type: ObjectType; mode: string } | undefined {
    const segments = path.split('/').filter((s) => s !== '');
    let current = treeOid;
    for (let i = 0; i < segments.length; i += 1) {
      const tree = repo.objects.get(current);
      if (tree === undefined || tree.type !== 'tree') return undefined;
      const entry = parseTree(tree.data).find((e) => e.name === segments[i]);
      if (entry === undefined) return undefined;
      if (i === segments.length - 1) {
        const obj = repo.objects.get(entry.oid);
        if (obj === undefined) return undefined;
        return { oid: entry.oid, type: obj.type, mode: entry.mode };
      }
      current = entry.oid;
    }
    return undefined;
  }

  /** Flat map of every file path in a tree (recursive), path -> {oid, mode}. */
  flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, base: string): void => {
      const tree = repo.objects.get(oid);
      if (tree === undefined || tree.type !== 'tree') return;
      for (const entry of parseTree(tree.data)) {
        const path = base === '' ? entry.name : `${base}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, prefix);
    return out;
  }

  /**
   * Return a new tree oid equal to `baseTreeOid` with `path` set to `blobOid`
   * (or removed when blobOid is null), creating intermediate trees as needed.
   */
  writePath(repo: Repo, baseTreeOid: string | null, path: string, blobOid: string | null): string {
    const segments = path.split('/').filter((s) => s !== '');
    const build = (treeOid: string | null, depth: number): string => {
      const entries: TreeEntry[] = treeOid === null ? [] : parseTree(repo.objects.get(treeOid)?.data ?? Buffer.alloc(0));
      const name = segments[depth];
      const rest = segments.slice(depth + 1);
      if (rest.length === 0) {
        const kept = entries.filter((e) => e.name !== name);
        if (blobOid !== null) kept.push({ mode: '100644', name, oid: blobOid });
        return this.putObject(repo, 'tree', buildTree(kept));
      }
      const existing = entries.find((e) => e.name === name);
      const childOid = this.putObject(repo, 'tree', Buffer.alloc(0));
      const child = build(existing !== undefined && existing.mode === '40000' ? existing.oid : childOid, depth + 1);
      const kept = entries.filter((e) => e.name !== name);
      kept.push({ mode: '40000', name, oid: child });
      return this.putObject(repo, 'tree', buildTree(kept));
    };
    return build(baseTreeOid, 0);
  }

  /** Create a commit object (fixed author/committer identity and time) and store it. */
  makeCommit(repo: Repo, treeOid: string, parents: string[], message: string): string {
    const epochSec = Math.floor(trialNowMs() / 1000);
    const identity = `${VIEWER.login} <${VIEWER.email}> ${epochSec} +0000`;
    const data = buildCommit({ tree: treeOid, parents, author: identity, committer: identity, message });
    return this.putObject(repo, 'commit', data);
  }

  /** All object ids reachable from the given tips (commits, trees, blobs, tags). */
  reachable(repo: Repo, tips: readonly string[]): Set<string> {
    const seen = new Set<string>();
    const stack = [...tips];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid) || oid === ZERO_OID) continue;
      const obj = repo.objects.get(oid);
      if (obj === undefined) continue;
      seen.add(oid);
      if (obj.type === 'commit') {
        const commit = parseCommit(obj.data);
        stack.push(commit.tree);
        for (const parent of commit.parents) stack.push(parent);
      } else if (obj.type === 'tree') {
        for (const entry of parseTree(obj.data)) stack.push(entry.oid);
      } else if (obj.type === 'tag') {
        const target = obj.data.toString('utf8').split('\n')[0].replace('object ', '').trim();
        stack.push(target);
      }
    }
    return seen;
  }

  /** True when `ancestor` is reachable from `descendant` (or equal). */
  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const stack = [descendant];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      const commit = parseCommit(obj.data);
      for (const parent of commit.parents) {
        if (parent === ancestor) return true;
        stack.push(parent);
      }
    }
    return false;
  }

  /** First common ancestor of two commits (breadth-first from both sides). */
  mergeBase(repo: Repo, a: string, b: string): string | undefined {
    const ancestorsOf = (start: string): Set<string> => {
      const seen = new Set<string>();
      const stack = [start];
      while (stack.length > 0) {
        const oid = stack.pop()!;
        if (seen.has(oid)) continue;
        seen.add(oid);
        const obj = repo.objects.get(oid);
        if (obj === undefined || obj.type !== 'commit') continue;
        for (const parent of parseCommit(obj.data).parents) stack.push(parent);
      }
      return seen;
    };
    const aAncestors = ancestorsOf(a);
    // Index-pointer queue, not shift(): Array.shift() is O(n) per call, which
    // makes this BFS quadratic on a long history. The index pointer keeps the
    // same FIFO order (and therefore the same merge-base result) in O(n).
    const queue = [b];
    const seenB = new Set<string>();
    let qi = 0;
    while (qi < queue.length) {
      const oid = queue[qi++]!;
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      if (aAncestors.has(oid)) return oid;
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) queue.push(parent);
    }
    return undefined;
  }

  /** Commits reachable from `tip`, newest-first by graph walk (parents after children). */
  listCommits(repo: Repo, tip: string): { oid: string; object: GitObject }[] {
    const out: { oid: string; object: GitObject }[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      out.push({ oid, object: obj });
      for (const parent of parseCommit(obj.data).parents) stack.push(parent);
    }
    return out;
  }

  // ------------------------------------------------------------ issues / pulls

  nextNumber(repo: Repo): number {
    repo.numberCounter += 1;
    return repo.numberCounter;
  }

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const now = trialNowIso();
    const issue: Issue = {
      id: this.nextIssueId++,
      number: this.nextNumber(repo),
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      user: VIEWER.login,
    };
    repo.issues.push(issue);
    return issue;
  }

  createPull(
    repo: Repo,
    title: string,
    body: string,
    headRef: string,
    baseRef: string,
    headSha: string,
    baseSha: string,
    mergeBaseSha: string,
  ): Pull {
    const now = trialNowIso();
    const pull: Pull = {
      id: this.nextIssueId++,
      number: this.nextNumber(repo),
      title,
      body,
      state: 'open',
      merged: false,
      headRef,
      baseRef,
      headSha,
      baseSha,
      mergeBaseSha,
      mergedAt: null,
      mergeCommitSha: null,
      comments: [],
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      user: VIEWER.login,
    };
    repo.pulls.push(pull);
    return pull;
  }

  findByNumber(repo: Repo, number: number): { kind: 'issue' | 'pull'; issue?: Issue; pull?: Pull } | undefined {
    const issue = repo.issues.find((i) => i.number === number);
    if (issue !== undefined) return { kind: 'issue', issue };
    const pull = repo.pulls.find((p) => p.number === number);
    if (pull !== undefined) return { kind: 'pull', pull };
    return undefined;
  }

  nextCommentId(repo: Repo): number {
    repo.commentCounter += 1;
    return repo.commentCounter;
  }
}

export const store = new Store();
