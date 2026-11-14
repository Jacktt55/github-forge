// rest.ts — GitHub REST v3 under /api/v3.
//
// Every reply is application/json with a non-empty X-GitHub-Request-Id (http.ts);
// errors are JSON {message}; unknown routes are 404 JSON; a malformed JSON body is
// 400. Auth: the Bearer token from MAKEFUN_SHOP_TOKEN; a missing or wrong token is
// 401 on every /api/v3 route (including the root). A repository under any owner other
// than the token's login is 404, never 403.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER, publicUser, trialNowIso } from './scenario.ts';
import { store, type Issue, type Pull, type Repo } from './store.ts';
import { parseCommit, parseTree } from './gitobj.ts';
import {
  decodeSegment,
  hasValidAuth,
  isRecord,
  nextRequestId,
  parseJsonBody,
  pathOf,
  queryOf,
  readBody,
  sendError,
  sendJson,
} from './http.ts';

/** The repo's API base URL, cached: owner/name never change, and the string is rebuilt on nearly every response. */
const repoUrlCache = new WeakMap<Repo, string>();

function repoUrl(repo: Repo): string {
  const cached = repoUrlCache.get(repo);
  if (cached !== undefined) return cached;
  const url = `/api/v3/repos/${repo.owner}/${repo.name}`;
  repoUrlCache.set(repo, url);
  return url;
}

/** An issue's node_id, cached: repo id + issue number are fixed at creation, and the base64 is recomputed on every serialization otherwise. */
const issueNodeIdCache = new WeakMap<Issue, string>();

function issueNodeId(repo: Repo, issue: Issue): string {
  const cached = issueNodeIdCache.get(issue);
  if (cached !== undefined) return cached;
  const id = Buffer.from(`I_${repo.id}_${issue.number}`, 'utf8').toString('base64');
  issueNodeIdCache.set(issue, id);
  return id;
}

function repoObject(repo: Repo): Record<string, unknown> {
  const base = repoUrl(repo);
  const openIssues = repo.issues.filter((i) => i.state === 'open').length + repo.pulls.filter((p) => p.state === 'open').length;
  return {
    id: repo.id,
    node_id: Buffer.from(`R_${repo.id}`, 'utf8').toString('base64'),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: publicUser(VIEWER),
    private: repo.isPrivate,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: base,
    archive_url: `${base}/{archive_format}{/ref}`,
    assignees_url: `${base}/assignees{/user}`,
    blobs_url: `${base}/git/blobs{/sha}`,
    branches_url: `${base}/branches{/branch}`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    collaborators_url: `${base}/collaborators{/collaborator}`,
    comments_url: `${base}/comments{/number}`,
    commits_url: `${base}/commits{/sha}`,
    compare_url: `${base}/compare/{base}...{head}`,
    contents_url: `${base}/contents/{+path}`,
    contributors_url: `${base}/contributors`,
    deployments_url: `${base}/deployments`,
    downloads_url: `${base}/downloads`,
    events_url: `${base}/events`,
    forks_url: `${base}/forks`,
    git_commits_url: `${base}/git/commits{/sha}`,
    git_refs_url: `${base}/git/refs{/sha}`,
    git_tags_url: `${base}/git/tags{/sha}`,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    issue_comment_url: `${base}/issues/comments{/number}`,
    issue_events_url: `${base}/issues/events{/number}`,
    issues_url: `${base}/issues{/number}`,
    keys_url: `${base}/keys{/key_id}`,
    labels_url: `${base}/labels{/name}`,
    languages_url: `${base}/languages`,
    merges_url: `${base}/merges`,
    milestones_url: `${base}/milestones{/number}`,
    notifications_url: `${base}/notifications{?since,all,participating}`,
    pulls_url: `${base}/pulls{/number}`,
    releases_url: `${base}/releases{/id}`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    stargazers_url: `${base}/stargazers`,
    statuses_url: `${base}/commits/{sha}/status`,
    subscribers_url: `${base}/subscribers`,
    subscription_url: `${base}/subscription`,
    tags_url: `${base}/tags`,
    teams_url: `${base}/teams`,
    trees_url: `${base}/git/trees{/sha}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.pushedAt,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    mirror_url: null,
    archived: false,
    disabled: false,
    open_issues_count: openIssues,
    license: null,
    allow_forking: true,
    is_template: false,
    web_commit_signoff_required: false,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    forks: 0,
    open_issues: openIssues,
    watchers: 0,
    default_branch: repo.defaultBranch,
  };
}

function labelObject(repo: Repo, label: { id: number; name: string; color: string; description: string }): Record<string, unknown> {
  return {
    id: label.id,
    node_id: Buffer.from(`L_${repo.id}_${label.id}`, 'utf8').toString('base64'),
    url: `${repoUrl(repo)}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: true,
    description: label.description,
  };
}

function issueObject(repo: Repo, issue: Issue): Record<string, unknown> {
  const base = repoUrl(repo);
  return {
    id: issue.id,
    node_id: issueNodeId(repo, issue),
    url: `${base}/issues/${issue.number}`,
    repository_url: base,
    labels_url: `${base}/issues/${issue.number}/labels{/name}`,
    comments_url: `${base}/issues/${issue.number}/comments`,
    events_url: `${base}/issues/${issue.number}/events`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body,
    user: publicUser(VIEWER),
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label === undefined ? { name, color: '000000', description: '' } : labelObject(repo, label);
    }),
    locked: false,
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
    active_lock_reason: null,
    state_reason: issue.state === 'closed' ? 'completed' : null,
  };
}

function branchRefObject(repo: Repo, ref: string, sha: string): Record<string, unknown> {
  return {
    label: `${repo.owner}:${ref}`,
    ref,
    sha,
    user: publicUser(VIEWER),
    repo: repoObject(repo),
  };
}

export function pullMergeable(repo: Repo, pull: Pull): boolean | null {
  if (pull.merged) return null;
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (baseTip === undefined) return null;
  return !mergeConflicts(repo, pull.mergeBaseSha, pull.headSha, baseTip);
}

/** A pull request's node_id, cached like an issue's. */
const pullNodeIdCache = new WeakMap<Pull, string>();

function pullNodeId(repo: Repo, pull: Pull): string {
  const cached = pullNodeIdCache.get(pull);
  if (cached !== undefined) return cached;
  const id = Buffer.from(`PR_${repo.id}_${pull.number}`, 'utf8').toString('base64');
  pullNodeIdCache.set(pull, id);
  return id;
}

function pullObject(repo: Repo, pull: Pull): Record<string, unknown> {
  const base = repoUrl(repo);
  const mergeable = pullMergeable(repo, pull);
  return {
    id: pull.id,
    node_id: pullNodeId(repo, pull),
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    diff_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}.diff`,
    patch_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}.patch`,
    issue_url: `${base}/issues/${pull.number}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    user: publicUser(VIEWER),
    body: pull.body,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    requested_teams: [],
    labels: [],
    milestone: null,
    draft: false,
    commits_url: `${base}/pulls/${pull.number}/commits`,
    review_comments_url: `${base}/pulls/${pull.number}/comments`,
    review_comment_url: `${base}/pulls/comments{/number}`,
    comments_url: `${base}/issues/${pull.number}/comments`,
    statuses_url: `${base}/commits/${pull.headSha}/status`,
    head: branchRefObject(repo, pull.headRef, pull.headSha),
    base: branchRefObject(repo, pull.baseRef, pull.baseSha),
    author_association: 'OWNER',
    auto_merge: null,
    merged: pull.merged,
    mergeable,
    mergeable_state: pull.merged ? 'unknown' : mergeable === true ? 'clean' : mergeable === false ? 'dirty' : 'unknown',
    merged_by: null,
    comments: pull.comments.length,
    review_comments: 0,
    maintainer_can_modify: false,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
}

function commentObject(repo: Repo, number: number, comment: { id: number; body: string; user: string; createdAt: string; updatedAt: string }): Record<string, unknown> {
  const base = repoUrl(repo);
  return {
    id: comment.id,
    node_id: Buffer.from(`C_${repo.id}_${number}_${comment.id}`, 'utf8').toString('base64'),
    url: `${base}/issues/comments/${comment.id}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${number}#issuecomment-${comment.id}`,
    body: comment.body,
    user: publicUser(VIEWER),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    issue_url: `${base}/issues/${number}`,
    author_association: 'OWNER',
  };
}

function commitObject(repo: Repo, oid: string): Record<string, unknown> | null {
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'commit') return null;
  const commit = parseCommit(obj.data);
  const ident = (line: string): { name: string; email: string; date: string } => {
    const m = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line);
    if (m === null) return { name: VIEWER.login, email: VIEWER.email, date: trialNowIso() };
    return { name: m[1], email: m[2], date: new Date(Number(m[3]) * 1000).toISOString() };
  };
  const author = ident(commit.author);
  const committer = ident(commit.committer);
  return {
    sha: oid,
    node_id: Buffer.from(`C_${oid}`, 'utf8').toString('base64'),
    commit: {
      author,
      committer,
      message: commit.message,
      tree: { sha: commit.tree, url: `${repoUrl(repo)}/git/trees/${commit.tree}` },
      url: `${repoUrl(repo)}/git/commits/${oid}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: `${repoUrl(repo)}/commits/${oid}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${oid}`,
    comments_url: `${repoUrl(repo)}/commits/${oid}/comments`,
    author: publicUser(VIEWER),
    committer: publicUser(VIEWER),
    parents: commit.parents.map((sha) => ({
      sha,
      url: `${repoUrl(repo)}/commits/${sha}`,
      html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${sha}`,
    })),
  };
}

/** The repository a route addresses, or null (the caller answers 404). */
function lookupRepo(owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) return null;
  return store.getRepo(owner, name) ?? null;
}

function linkHeader(req: IncomingMessage, basePath: string, perPage: number, page: number, totalPages: number): string {
  const host = req.headers.host ?? 'localhost';
  const url = (p: number): string => `http://${host}${basePath}?per_page=${perPage}&page=${p}`;
  const parts: string[] = [];
  if (page < totalPages) parts.push(`<${url(page + 1)}>; rel="next"`);
  if (page > 1) parts.push(`<${url(page - 1)}>; rel="prev"`);
  if (totalPages > 1) {
    parts.push(`<${url(1)}>; rel="first"`);
    parts.push(`<${url(totalPages)}>; rel="last"`);
  }
  return parts.join(', ');
}

function paginate<T>(items: readonly T[], query: URLSearchParams): { page: T[]; totalPages: number; perPage: number; pageNo: number } {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
  const pageNo = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (pageNo - 1) * perPage;
  return { page: items.slice(start, start + perPage), totalPages, perPage, pageNo };
}

/** Line counts for a changed file, by multiset difference of lines. */
function lineCounts(oldText: string | null, newText: string | null): { additions: number; deletions: number } {
  const countLines = (text: string | null): Map<string, number> => {
    const map = new Map<string, number>();
    if (text === null) return map;
    for (const line of text.split('\n')) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const oldLines = countLines(oldText);
  const newLines = countLines(newText);
  let additions = 0;
  let deletions = 0;
  for (const [line, count] of newLines) additions += Math.max(0, count - (oldLines.get(line) ?? 0));
  for (const [line, count] of oldLines) deletions += Math.max(0, count - (newLines.get(line) ?? 0));
  return { additions, deletions };
}

export interface FileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
  sha: string;
}

/** Diff two trees (flat path maps) into the pull-files list. */
export function diffTrees(repo: Repo, baseTree: string, headTree: string): FileChange[] {
  const base = store.flattenTree(repo, baseTree);
  const head = store.flattenTree(repo, headTree);
  const out: FileChange[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b !== undefined && h === undefined) {
      const oldText = repo.objects.get(b.oid)?.data.toString('utf8') ?? '';
      const { deletions } = lineCounts(oldText, null);
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions, sha: b.oid });
    } else if (b === undefined && h !== undefined) {
      const newText = repo.objects.get(h.oid)?.data.toString('utf8') ?? '';
      const { additions } = lineCounts(null, newText);
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions, sha: h.oid });
    } else if (b !== undefined && h !== undefined && b.oid !== h.oid) {
      const oldText = repo.objects.get(b.oid)?.data.toString('utf8') ?? '';
      const newText = repo.objects.get(h.oid)?.data.toString('utf8') ?? '';
      const { additions, deletions } = lineCounts(oldText, newText);
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions, sha: h.oid });
    }
  }
  return out;
}

/** True when merging head into base would conflict (both sides changed a path differently). */
export function mergeConflicts(repo: Repo, mergeBaseSha: string, headSha: string, baseSha: string): boolean {
  const baseCommit = repo.objects.get(mergeBaseSha);
  const headCommit = repo.objects.get(headSha);
  const baseTipCommit = repo.objects.get(baseSha);
  if (baseCommit === undefined || headCommit === undefined || baseTipCommit === undefined) return false;
  const baseTree = parseCommit(baseCommit.data).tree;
  const headTree = parseCommit(headCommit.data).tree;
  const tipTree = parseCommit(baseTipCommit.data).tree;
  const baseFiles = store.flattenTree(repo, baseTree);
  const headFiles = store.flattenTree(repo, headTree);
  const tipFiles = store.flattenTree(repo, tipTree);
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...tipFiles.keys()]);
  for (const path of paths) {
    const b = baseFiles.get(path)?.oid ?? null;
    const h = headFiles.get(path)?.oid ?? null;
    const t = tipFiles.get(path)?.oid ?? null;
    if (h !== b && t !== b && h !== t) return true;
  }
  return false;
}

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  segments: string[];
  query: URLSearchParams;
  body: unknown;
}

/** Route the request; returns true when it was a /api/v3 request (handled or 404'd). */
export async function handleRest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = pathOf(req);
  if (!path.startsWith('/api/v3')) return false;
  const method = req.method ?? 'GET';
  const query = queryOf(req);

  if (!hasValidAuth(req)) {
    sendError(res, 401, 'Requires authentication');
    return true;
  }

  const segments = path.split('/').filter((s) => s !== '').slice(2).map(decodeSegment);

  // The API root and meta need no body.
  if (method === 'GET' && segments.length === 0) {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  if (method === 'GET' && segments.length === 1 && segments[0] === 'meta') {
    sendJson(res, 200, { installed_version: '1.0.0' });
    return true;
  }

  let body: unknown = null;
  if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
    const raw = await readBody(req);
    const parsed = parseJsonBody(raw);
    if (!parsed.ok) {
      sendError(res, 400, 'Problems parsing JSON');
      return true;
    }
    body = parsed.value;
  }
  const ctx: Ctx = { req, res, segments, query, body };

  try {
    await routeRest(ctx);
  } catch (err) {
    sendError(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
  }
  return true;
}

async function routeRest(ctx: Ctx): Promise<void> {
  const { res, segments, query, body } = ctx;
  const method = ctx.req.method ?? 'GET';
  const s = segments;

  // GET /api/v3/user, GET /api/v3/users/{login}
  if (method === 'GET' && s.length === 1 && s[0] === 'user') {
    sendJson(res, 200, publicUser(VIEWER));
    return;
  }
  if (method === 'GET' && s.length === 2 && s[0] === 'users') {
    const login = s[1];
    if (login === VIEWER.login) {
      sendJson(res, 200, publicUser(VIEWER));
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  // POST /api/v3/user/repos — create under the token's login.
  if (method === 'POST' && s.length === 2 && s[0] === 'user' && s[1] === 'repos') {
    const name = isRecord(body) && typeof body.name === 'string' ? body.name : '';
    if (name === '') {
      sendError(res, 422, 'Validation Failed: name is required');
      return;
    }
    if (store.getRepo(VIEWER.login, name) !== undefined) {
      sendError(res, 422, `Validation Failed: name already exists on this account`);
      return;
    }
    const description = isRecord(body) && typeof body.description === 'string' ? body.description : '';
    const isPrivate = isRecord(body) && body.private === true;
    const defaultBranch = isRecord(body) && typeof body.default_branch === 'string' && body.default_branch !== '' ? body.default_branch : 'main';
    const repo = store.createRepo(name, description, isPrivate, defaultBranch);
    sendJson(res, 201, repoObject(repo));
    return;
  }

  // GET /api/v3/user/repos — paginated, Link rel=next.
  if (method === 'GET' && s.length === 2 && s[0] === 'user' && s[1] === 'repos') {
    const repos = store.listRepos(VIEWER.login);
    const { page, totalPages, perPage, pageNo } = paginate(repos, query);
    const headers: Record<string, string> = {};
    const link = linkHeader(ctx.req, '/api/v3/user/repos', perPage, pageNo, totalPages);
    if (link !== '') headers.link = link;
    sendJson(res, 200, page.map((r) => repoObject(r)), headers);
    return;
  }

  // Everything below addresses /repos/{owner}/{name}[/...].
  if (s.length >= 3 && s[0] === 'repos') {
    const owner = s[1];
    const name = s[2];
    const repo = lookupRepo(owner, name);
    const rest = s.slice(3);
    if (repo === null) {
      sendError(res, 404, 'Not Found');
      return;
    }
    await routeRepo(ctx, repo, rest);
    return;
  }

  sendError(res, 404, 'Not Found');
}

async function routeRepo(ctx: Ctx, repo: Repo, rest: string[]): Promise<void> {
  const { res, query, body } = ctx;
  const method = ctx.req.method ?? 'GET';
  const base = repoUrl(repo);

  // GET /repos/{o}/{r}
  if (method === 'GET' && rest.length === 0) {
    sendJson(res, 200, repoObject(repo));
    return;
  }

  // PATCH /repos/{o}/{r}
  if (method === 'PATCH' && rest.length === 0) {
    if (isRecord(body)) {
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
    }
    repo.updatedAt = trialNowIso();
    sendJson(res, 200, repoObject(repo));
    return;
  }

  // DELETE /repos/{o}/{r}
  if (method === 'DELETE' && rest.length === 0) {
    store.deleteRepo(repo.owner, repo.name);
    res.writeHead(204, { 'x-github-request-id': nextRequestId() });
    res.end();
    return;
  }

  // GET /repos/{o}/{r}/branches and /branches/{branch}
  if (method === 'GET' && rest.length === 1 && rest[0] === 'branches') {
    const branches = [...repo.refs.keys()]
      .filter((ref) => ref.startsWith('refs/heads/'))
      .map((ref) => ref.slice('refs/heads/'.length))
      .sort()
      .map((name) => ({
        name,
        commit: { sha: repo.refs.get(`refs/heads/${name}`), url: `${base}/commits/${repo.refs.get(`refs/heads/${name}`)}` },
        protected: false,
      }));
    sendJson(res, 200, branches);
    return;
  }
  // GET /repos/{o}/{r}/branches/{branch} — branch names may contain slashes.
  if (method === 'GET' && rest.length >= 2 && rest[0] === 'branches') {
    const branch = rest.slice(1).join('/');
    const sha = repo.refs.get(`refs/heads/${branch}`);
    if (sha === undefined) {
      sendError(res, 404, 'Not Found');
      return;
    }
    sendJson(res, 200, {
      name: branch,
      commit: { sha, url: `${base}/commits/${sha}` },
      protected: false,
    });
    return;
  }

  // GET /repos/{o}/{r}/commits[?sha=]
  if (method === 'GET' && rest.length === 1 && rest[0] === 'commits') {
    const ref = query.get('sha') ?? repo.defaultBranch;
    const resolved = store.resolveCommit(repo, ref);
    if (resolved === undefined) {
      sendJson(res, 200, []);
      return;
    }
    const commits = store.listCommits(repo, resolved.oid)
      .map((c) => commitObject(repo, c.oid))
      .filter((c): c is Record<string, unknown> => c !== null);
    sendJson(res, 200, commits);
    return;
  }

  // POST /repos/{o}/{r}/git/refs — create a branch.
  if (method === 'POST' && rest.length === 2 && rest[0] === 'git' && rest[1] === 'refs') {
    const ref = isRecord(body) && typeof body.ref === 'string' ? body.ref : '';
    const sha = isRecord(body) && typeof body.sha === 'string' ? body.sha : '';
    if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha) || repo.objects.get(sha) === undefined) {
      sendError(res, 422, 'Validation Failed: ref and sha are required');
      return;
    }
    if (repo.refs.has(ref)) {
      sendError(res, 422, 'Validation Failed: Reference already exists');
      return;
    }
    repo.refs.set(ref, sha);
    repo.updatedAt = trialNowIso();
    sendJson(res, 201, {
      ref,
      node_id: Buffer.from(`R_${repo.id}_${ref}`, 'utf8').toString('base64'),
      url: `${base}/git/refs/${encodeURIComponent(ref)}`,
      object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: `${base}/git/commits/${sha}` },
    });
    return;
  }

  // GET /repos/{o}/{r}/git/refs/heads/{branch} — branch names may contain slashes.
  if (method === 'GET' && rest.length >= 4 && rest[0] === 'git' && rest[1] === 'refs' && rest[2] === 'heads') {
    const branch = rest.slice(3).join('/');
    const ref = `refs/heads/${branch}`;
    const sha = repo.refs.get(ref);
    if (sha === undefined) {
      sendError(res, 404, 'Not Found');
      return;
    }
    sendJson(res, 200, {
      ref,
      node_id: Buffer.from(`R_${repo.id}_${ref}`, 'utf8').toString('base64'),
      url: `${base}/git/refs/${encodeURIComponent(ref)}`,
      object: { sha, type: 'commit', url: `${base}/git/commits/${sha}` },
    });
    return;
  }

  // Contents: /repos/{o}/{r}/contents[/{path...}]
  if (rest[0] === 'contents') {
    await routeContents(ctx, repo, rest.slice(1));
    return;
  }

  // Labels: /repos/{o}/{r}/labels
  if (rest.length === 1 && rest[0] === 'labels') {
    if (method === 'GET') {
      sendJson(res, 200, [...repo.labels.values()].map((l) => labelObject(repo, l)));
      return;
    }
    if (method === 'POST') {
      const name = isRecord(body) && typeof body.name === 'string' ? body.name : '';
      if (name === '' || repo.labels.has(name)) {
        sendError(res, 422, name === '' ? 'Validation Failed: name is required' : 'Validation Failed: label already exists');
        return;
      }
      const color = isRecord(body) && typeof body.color === 'string' ? body.color.replace(/^#/, '') : '000000';
      const description = isRecord(body) && typeof body.description === 'string' ? body.description : '';
      repo.labelCounter += 1;
      const label = { id: repo.labelCounter, name, color, description };
      repo.labels.set(name, label);
      sendJson(res, 201, labelObject(repo, label));
      return;
    }
  }

  // Issues: /repos/{o}/{r}/issues[/{n}[/comments]]
  if (rest[0] === 'issues') {
    await routeIssues(ctx, repo, rest.slice(1));
    return;
  }

  // Pulls: /repos/{o}/{r}/pulls[/{n}[/files|merge]]
  if (rest[0] === 'pulls') {
    await routePulls(ctx, repo, rest.slice(1));
    return;
  }

  sendError(res, 404, 'Not Found');
}

async function routeContents(ctx: Ctx, repo: Repo, pathSegments: string[]): Promise<void> {
  const { res, query, body } = ctx;
  const method = ctx.req.method ?? 'GET';
  const path = pathSegments.join('/');
  const base = repoUrl(repo);

  const branchFor = (): string => {
    if (method === 'GET') return query.get('ref') ?? repo.defaultBranch;
    return isRecord(body) && typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  };
  const tipFor = (branch: string): string | undefined => repo.refs.get(`refs/heads/${branch}`);

  const fileEntry = (filePath: string, blobOid: string, content: Buffer): Record<string, unknown> => ({
    type: 'file',
    encoding: 'base64',
    size: content.length,
    name: filePath.split('/').pop() ?? filePath,
    path: filePath,
    content: content.toString('base64'),
    sha: blobOid,
    url: `${base}/contents/${filePath}`,
    git_url: `${base}/git/blobs/${blobOid}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${branchFor()}/${filePath}`,
    download_url: `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${branchFor()}/${filePath}`,
    _links: {
      git: `${base}/git/blobs/${blobOid}`,
      self: `${base}/contents/${filePath}`,
      html: `https://github.com/${repo.owner}/${repo.name}/blob/${branchFor()}/${filePath}`,
    },
  });

  const dirListing = (dirPath: string, treeOid: string): Record<string, unknown>[] => {
    const tree = repo.objects.get(treeOid);
    if (tree === undefined || tree.type !== 'tree') return [];
    return parseTree(tree.data).map((entry) => {
      const entryPath = dirPath === '' ? entry.name : `${dirPath}/${entry.name}`;
      const isDir = entry.mode === '40000';
      return {
        type: isDir ? 'dir' : 'file',
        size: isDir ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
        name: entry.name,
        path: entryPath,
        sha: entry.oid,
        url: `${base}/contents/${entryPath}`,
        git_url: `${base}/git/${isDir ? 'trees' : 'blobs'}/${entry.oid}`,
        html_url: `https://github.com/${repo.owner}/${repo.name}/${isDir ? 'tree' : 'blob'}/${branchFor()}/${entryPath}`,
        download_url: isDir ? null : `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${branchFor()}/${entryPath}`,
        _links: {
          git: `${base}/git/${isDir ? 'trees' : 'blobs'}/${entry.oid}`,
          self: `${base}/contents/${entryPath}`,
          html: `https://github.com/${repo.owner}/${repo.name}/${isDir ? 'tree' : 'blob'}/${branchFor()}/${entryPath}`,
        },
      };
    });
  };

  if (method === 'GET') {
    const branch = branchFor();
    const tip = tipFor(branch);
    if (tip === undefined) {
      sendError(res, 404, 'Not Found');
      return;
    }
    const commit = repo.objects.get(tip);
    if (commit === undefined || commit.type !== 'commit') {
      sendError(res, 404, 'Not Found');
      return;
    }
    const treeOid = parseCommit(commit.data).tree;
    if (path === '') {
      sendJson(res, 200, dirListing('', treeOid));
      return;
    }
    const resolved = store.resolvePath(repo, treeOid, path);
    if (resolved === undefined) {
      sendError(res, 404, 'Not Found');
      return;
    }
    if (resolved.type === 'tree') {
      sendJson(res, 200, dirListing(path, resolved.oid));
      return;
    }
    const blob = repo.objects.get(resolved.oid);
    if (blob === undefined) {
      sendError(res, 404, 'Not Found');
      return;
    }
    sendJson(res, 200, fileEntry(path, resolved.oid, blob.data));
    return;
  }

  if (method === 'PUT') {
    const branch = branchFor();
    const tip = tipFor(branch);
    const message = isRecord(body) && typeof body.message === 'string' ? body.message : 'Update file';
    const contentB64 = isRecord(body) && typeof body.content === 'string' ? body.content : '';
    const content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
    const expectedSha = isRecord(body) && typeof body.sha === 'string' ? body.sha : null;
    let baseTree: string | null = null;
    let parents: string[] = [];
    let existing: { oid: string } | undefined;
    if (tip !== undefined) {
      const commit = repo.objects.get(tip);
      if (commit !== undefined && commit.type === 'commit') {
        baseTree = parseCommit(commit.data).tree;
        parents = [tip];
        existing = store.resolvePath(repo, baseTree, path);
      }
    }
    if (expectedSha !== null) {
      if (existing === undefined || existing.oid !== expectedSha) {
        sendError(res, 409, 'Conflict: sha does not match the current file');
        return;
      }
    } else if (existing !== undefined) {
      sendError(res, 422, 'Validation Failed: file already exists; pass its sha to update it');
      return;
    }
    const blobOid = store.putObject(repo, 'blob', content);
    const newTree = store.writePath(repo, baseTree, path, blobOid);
    const commitOid = store.makeCommit(repo, newTree, parents, message);
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    repo.updatedAt = trialNowIso();
    repo.pushedAt = trialNowIso();
    const status = existing === undefined ? 201 : 200;
    sendJson(res, status, {
      content: fileEntry(path, blobOid, content),
      commit: commitObject(repo, commitOid),
    });
    return;
  }

  if (method === 'DELETE') {
    const branch = branchFor();
    const tip = tipFor(branch);
    const message = isRecord(body) && typeof body.message === 'string' ? body.message : 'Delete file';
    const expectedSha = isRecord(body) && typeof body.sha === 'string' ? body.sha : null;
    if (tip === undefined) {
      sendError(res, 404, 'Not Found');
      return;
    }
    const commit = repo.objects.get(tip);
    if (commit === undefined || commit.type !== 'commit') {
      sendError(res, 404, 'Not Found');
      return;
    }
    const baseTree = parseCommit(commit.data).tree;
    const existing = store.resolvePath(repo, baseTree, path);
    if (existing === undefined) {
      sendError(res, 404, 'Not Found');
      return;
    }
    if (expectedSha !== null && existing.oid !== expectedSha) {
      sendError(res, 409, 'Conflict: sha does not match the current file');
      return;
    }
    const newTree = store.writePath(repo, baseTree, path, null);
    const commitOid = store.makeCommit(repo, newTree, [tip], message);
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    repo.updatedAt = trialNowIso();
    repo.pushedAt = trialNowIso();
    sendJson(res, 200, { commit: commitObject(repo, commitOid) });
    return;
  }

  sendError(res, 404, 'Not Found');
}

async function routeIssues(ctx: Ctx, repo: Repo, rest: string[]): Promise<void> {
  const { res, query, body } = ctx;
  const method = ctx.req.method ?? 'GET';

  // POST /issues — create.
  if (method === 'POST' && rest.length === 0) {
    const title = isRecord(body) && typeof body.title === 'string' ? body.title : '';
    const issueBody = isRecord(body) && typeof body.body === 'string' ? body.body : '';
    const labels = isRecord(body) && Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
    for (const label of labels) {
      if (!repo.labels.has(label)) {
        sendError(res, 422, `Validation Failed: label "${label}" does not exist`);
        return;
      }
    }
    if (title === '') {
      sendError(res, 422, 'Validation Failed: title is required');
      return;
    }
    const issue = store.createIssue(repo, title, issueBody, labels);
    sendJson(res, 201, issueObject(repo, issue));
    return;
  }

  // GET /issues — list with state/sort/direction.
  if (method === 'GET' && rest.length === 0) {
    const state = query.get('state') ?? 'open';
    const sort = query.get('sort') ?? 'created';
    const direction = query.get('direction') ?? 'desc';
    let issues = [...repo.issues];
    if (state !== 'all') issues = issues.filter((i) => i.state === state);
    if (sort === 'created') {
      issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
    }
    sendJson(res, 200, issues.map((i) => issueObject(repo, i)));
    return;
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number <= 0) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const found = store.findByNumber(repo, number);
  if (found === undefined || found.kind !== 'issue') {
    sendError(res, 404, 'Not Found');
    return;
  }
  const issue = found.issue!;

  // GET /issues/{n}
  if (method === 'GET' && rest.length === 1) {
    sendJson(res, 200, issueObject(repo, issue));
    return;
  }

  // PATCH /issues/{n}
  if (method === 'PATCH' && rest.length === 1) {
    if (isRecord(body)) {
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) {
        issue.state = body.state;
        issue.closedAt = body.state === 'closed' ? trialNowIso() : null;
      }
      if (Array.isArray(body.labels)) {
        const labels = body.labels.filter((l): l is string => typeof l === 'string');
        for (const label of labels) {
          if (!repo.labels.has(label)) {
            sendError(res, 422, `Validation Failed: label "${label}" does not exist`);
            return;
          }
        }
        issue.labels = labels;
      }
    }
    issue.updatedAt = trialNowIso();
    sendJson(res, 200, issueObject(repo, issue));
    return;
  }

  // /issues/{n}/comments
  if (rest.length === 2 && rest[1] === 'comments') {
    if (method === 'GET') {
      sendJson(res, 200, issue.comments.map((c) => commentObject(repo, issue.number, c)));
      return;
    }
    if (method === 'POST') {
      const text = isRecord(body) && typeof body.body === 'string' ? body.body : '';
      const comment = { id: store.nextCommentId(repo), body: text, user: VIEWER.login, createdAt: trialNowIso(), updatedAt: trialNowIso() };
      issue.comments.push(comment);
      issue.updatedAt = trialNowIso();
      sendJson(res, 201, commentObject(repo, issue.number, comment));
      return;
    }
  }

  sendError(res, 404, 'Not Found');
}

async function routePulls(ctx: Ctx, repo: Repo, rest: string[]): Promise<void> {
  const { res, query, body } = ctx;
  const method = ctx.req.method ?? 'GET';

  // POST /pulls — create.
  if (method === 'POST' && rest.length === 0) {
    const title = isRecord(body) && typeof body.title === 'string' ? body.title : '';
    const pullBody = isRecord(body) && typeof body.body === 'string' ? body.body : '';
    const head = isRecord(body) && typeof body.head === 'string' ? body.head : '';
    const base = isRecord(body) && typeof body.base === 'string' ? body.base : repo.defaultBranch;
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (title === '' || headSha === undefined || baseSha === undefined) {
      sendError(res, 422, 'Validation Failed: head and base branches must exist');
      return;
    }
    const mergeBaseSha = store.mergeBase(repo, headSha, baseSha) ?? baseSha;
    const pull = store.createPull(repo, title, pullBody, head, base, headSha, baseSha, mergeBaseSha);
    sendJson(res, 201, pullObject(repo, pull));
    return;
  }

  // GET /pulls — list (state=open default, all includes merged/closed).
  if (method === 'GET' && rest.length === 0) {
    const state = query.get('state') ?? 'open';
    let pulls = [...repo.pulls];
    if (state !== 'all') pulls = pulls.filter((p) => p.state === state);
    pulls.sort((a, b) => b.number - a.number);
    sendJson(res, 200, pulls.map((p) => pullObject(repo, p)));
    return;
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number <= 0) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const found = store.findByNumber(repo, number);
  if (found === undefined || found.kind !== 'pull') {
    sendError(res, 404, 'Not Found');
    return;
  }
  const pull = found.pull!;

  // GET /pulls/{n}
  if (method === 'GET' && rest.length === 1) {
    sendJson(res, 200, pullObject(repo, pull));
    return;
  }

  // GET /pulls/{n}/files
  if (method === 'GET' && rest.length === 2 && rest[1] === 'files') {
    const headCommit = repo.objects.get(pull.headSha);
    const baseCommit = repo.objects.get(pull.mergeBaseSha);
    if (headCommit === undefined || baseCommit === undefined) {
      sendJson(res, 200, []);
      return;
    }
    const headTree = parseCommit(headCommit.data).tree;
    const baseTree = parseCommit(baseCommit.data).tree;
    const files = diffTrees(repo, baseTree, headTree).map((f) => ({
      sha: f.sha,
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      changes: f.changes,
      blob_url: `https://github.com/${repo.owner}/${repo.name}/blob/${pull.headSha}/${f.filename}`,
      raw_url: `https://github.com/${repo.owner}/${repo.name}/raw/${pull.headSha}/${f.filename}`,
      contents_url: `${repoUrl(repo)}/contents/${f.filename}?ref=${pull.headSha}`,
    }));
    sendJson(res, 200, files);
    return;
  }

  // PUT /pulls/{n}/merge — squash merge onto the base branch.
  if (method === 'PUT' && rest.length === 2 && rest[1] === 'merge') {
    if (pull.state === 'closed') {
      sendError(res, 405, 'Pull request is already closed');
      return;
    }
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (baseTip === undefined) {
      sendError(res, 404, 'Not Found');
      return;
    }
    if (mergeConflicts(repo, pull.mergeBaseSha, pull.headSha, baseTip)) {
      sendError(res, 405, 'Merge conflict: this pull request cannot be merged');
      return;
    }
    const headCommit = repo.objects.get(pull.headSha);
    if (headCommit === undefined) {
      sendError(res, 404, 'Not Found');
      return;
    }
    const headTree = parseCommit(headCommit.data).tree;
    const message = `${pull.title} (#${pull.number})`;
    const squashOid = store.makeCommit(repo, headTree, [baseTip], message);
    repo.refs.set(`refs/heads/${pull.baseRef}`, squashOid);
    repo.updatedAt = trialNowIso();
    repo.pushedAt = trialNowIso();
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = trialNowIso();
    pull.mergeCommitSha = squashOid;
    pull.closedAt = trialNowIso();
    pull.updatedAt = trialNowIso();
    sendJson(res, 200, { sha: squashOid, merged: true, message: 'Pull request successfully merged' });
    return;
  }

  sendError(res, 404, 'Not Found');
}
