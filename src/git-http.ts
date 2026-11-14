// git-http.ts — git smart HTTP at /{owner}/{repo}.git.
//
// upload-pack speaks protocol v2 when the client sends `Git-Protocol: version=2`
// (advertisement `version 2` + capability lines; fetch with `command=fetch` and the
// acknowledgments / shallow-info / packfile sections) and v0 otherwise (the
// `# service=git-upload-pack` advertisement with ref lines, `want`/`have`/`done`,
// `NAK` + sideband pack). receive-pack is v0 only, advertising report-status,
// side-band-64k and delete-refs. Packs are written with plain objects (no deltas);
// pushed packs are read with full OFS_DELTA / REF_DELTA resolution. Ref updates are
// fast-forward only: a non-fast-forward update is refused per ref with
// `ng <ref> non-fast-forward` while the other refs in the same push still apply.
// A missing repository is 404; a missing or wrong token is 401; a malformed
// pkt-line body is 400 and never crashes the server.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER, trialNowIso } from './scenario.ts';
import { store, type Repo } from './store.ts';
import {
  DELIM_PKT,
  FLUSH_PKT,
  ZERO_OID,
  parseCommit,
  parsePktLines,
  parseTag,
  parseTree,
  pktLine,
  readPack,
  sidebandPackets,
  writePack,
  type GitObject,
} from './gitobj.ts';
import { hasValidAuth, pathOf, queryOf, readBody, sendError } from './http.ts';

const AGENT = 'github-forge/1.0.0';
const UPLOAD_CAPS_V0 = `side-band-64k shallow thin-pack ofs-delta agent=${AGENT}`;
const RECEIVE_CAPS = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;

/** All refs of a repo, sorted, as [name, oid] pairs (HEAD first for advertisements). */
function sortedRefs(repo: Repo): [string, string][] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function headTarget(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** The oid HEAD points at, or ZERO when the repo has no commits yet. */
function headOid(repo: Repo): string {
  return repo.refs.get(headTarget(repo)) ?? ZERO_OID;
}

function refLinesV0(repo: Repo, caps: string): Buffer {
  const refs = sortedRefs(repo);
  const chunks: Buffer[] = [];
  const head = headOid(repo);
  if (refs.length === 0) {
    chunks.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    chunks.push(pktLine(`${head} HEAD\0${caps}\n`));
    for (const [name, oid] of refs) {
      chunks.push(pktLine(`${oid} ${name}\n`));
      const obj = repo.objects.get(oid);
      if (obj !== undefined && obj.type === 'tag') {
        const target = obj.data.toString('utf8').split('\n')[0].replace('object ', '').trim();
        if (/^[0-9a-f]{40}$/.test(target)) chunks.push(pktLine(`${target} ${name}^{}\n`));
      }
    }
  }
  chunks.push(FLUSH_PKT);
  return Buffer.concat(chunks);
}

function advertisementUploadPack(repo: Repo, v2: boolean): Buffer {
  if (v2) {
    const chunks: Buffer[] = [
      pktLine('# service=git-upload-pack\n'),
      FLUSH_PKT,
      pktLine('version 2\n'),
      pktLine('fetch=shallow thin-pack ofs-delta\n'),
      pktLine('ls-refs\n'),
      pktLine(`object-format=sha1\n`),
      pktLine(`agent=${AGENT}\n`),
      FLUSH_PKT,
    ];
    return Buffer.concat(chunks);
  }
  return Buffer.concat([pktLine('# service=git-upload-pack\n'), FLUSH_PKT, refLinesV0(repo, `${UPLOAD_CAPS_V0} symref=HEAD:${headTarget(repo)}`)]);
}

function advertisementReceivePack(repo: Repo): Buffer {
  return Buffer.concat([pktLine('# service=git-receive-pack\n'), FLUSH_PKT, refLinesV0(repo, RECEIVE_CAPS)]);
}

function sendGit(res: ServerResponse, contentType: string, body: Buffer): void {
  res.writeHead(200, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

/** The ls-refs answer: one line per matching ref, HEAD first, then a flush. */
function lsRefsResponse(repo: Repo, prefixes: string[], peel: boolean, symrefs: boolean): Buffer {
  const chunks: Buffer[] = [];
  const head = headOid(repo);
  const entries: { oid: string; name: string; symrefTarget?: string; peeled?: string }[] = [];
  if (head !== ZERO_OID) {
    entries.push({ oid: head, name: 'HEAD', symrefTarget: symrefs ? headTarget(repo) : undefined });
  }
  for (const [name, oid] of sortedRefs(repo)) {
    const entry: { oid: string; name: string; symrefTarget?: string; peeled?: string } = { oid, name };
    if (peel) {
      const obj = repo.objects.get(oid);
      if (obj !== undefined && obj.type === 'tag') {
        const target = obj.data.toString('utf8').split('\n')[0].replace('object ', '').trim();
        if (/^[0-9a-f]{40}$/.test(target)) entry.peeled = target;
      }
    }
    entries.push(entry);
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  for (const entry of entries) {
    if (!keep(entry.name)) continue;
    let line = `${entry.oid} ${entry.name}`;
    if (entry.symrefTarget !== undefined) line += ` symref-target:${entry.symrefTarget}`;
    if (entry.peeled !== undefined) line += ` peeled:${entry.peeled}`;
    chunks.push(pktLine(`${line}\n`));
  }
  chunks.push(FLUSH_PKT);
  return Buffer.concat(chunks);
}

/**
 * Cache of serialized fetch responses, keyed on the repo state plus the whole
 * request. The store is append-only for objects (never removed or replaced)
 * and every ref change is visible in the fingerprint, so a key that matches
 * means the object graph is identical and the response bytes are the same.
 * This matters for the bench's 50 concurrent identical depth-1 clones: the
 * pack is generated once and the other 49 are served from the cache. Capped
 * at 128 entries (oldest evicted) so a long trial cannot grow it unboundedly.
 */
const FETCH_CACHE = new Map<string, Buffer>();
const FETCH_CACHE_MAX = 128;

function fetchCacheKey(repo: Repo, request: UploadPackRequest, v2: boolean): string {
  const refs = [...repo.refs.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([name, oid]) => `${name}=${oid}`)
    .join(',');
  return [
    repo.id,
    repo.objects.size,
    refs,
    v2 ? 'v2' : 'v0',
    request.wants.join(','),
    request.haves.join(','),
    request.shallow.join(','),
    request.depth === null ? '' : String(request.depth),
  ].join('|');
}

function fetchCacheGet(key: string): Buffer | undefined {
  return FETCH_CACHE.get(key);
}

function fetchCachePut(key: string, response: Buffer): void {
  if (FETCH_CACHE.size >= FETCH_CACHE_MAX) {
    const oldest = FETCH_CACHE.keys().next();
    if (!oldest.done) FETCH_CACHE.delete(oldest.value);
  }
  FETCH_CACHE.set(key, response);
}

interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

/**
 * Objects the client already holds: the closure of each `have`, walking commit
 * ancestry but never crossing a shallow boundary (a boundary commit is held, its
 * parents are not), plus the tree closure of every held commit.
 */
function computeHeld(repo: Repo, haves: string[], shallowBoundaries: string[]): { heldCommits: Set<string>; heldObjects: Set<string> } {
  const shallowSet = new Set(shallowBoundaries);
  const heldCommits = new Set<string>();
  const heldObjects = new Set<string>();
  const stack = [...haves];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (heldCommits.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    heldCommits.add(oid);
    heldObjects.add(oid);
    if (shallowSet.has(oid)) continue;
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  for (const oid of heldCommits) {
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    const treeStack = [parseCommit(obj.data).tree];
    while (treeStack.length > 0) {
      const t = treeStack.pop()!;
      if (heldObjects.has(t)) continue;
      const tobj = repo.objects.get(t);
      if (tobj === undefined) continue;
      heldObjects.add(t);
      if (tobj.type === 'tree') {
        for (const entry of parseTree(tobj.data)) treeStack.push(entry.oid);
      }
    }
  }
  return { heldCommits, heldObjects };
}

/**
 * The objects a fetch must send: the commits reachable from `wants` that the
 * client does not hold, limited to `depth` levels when given, plus the tree
 * closure of those commits (never the parents of the sent commits, and never
 * any object the client already holds — a shared blob must not be re-sent).
 * A `have` that is also a shallow boundary is traversed into, because the
 * client asked for the generations beyond it (deepen); a plain `have` is not.
 * `shallow` lists the new shallow boundaries (sent commits whose parent is
 * neither sent nor held, plus client boundaries that stay shallow);
 * `unshallow` lists client boundaries whose parents are now all sent or held.
 */
function planFetch(repo: Repo, wants: string[], haves: string[], shallowBoundaries: string[], depth: number | null): FetchPlan {
  const { heldCommits, heldObjects } = computeHeld(repo, haves, shallowBoundaries);
  const shallowSet = new Set(shallowBoundaries);
  const tagObjects = new Set<string>();
  const queue: { oid: string; level: number }[] = [];
  const queued = new Set<string>();
  for (const want of wants) {
    const obj = repo.objects.get(want);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      tagObjects.add(want);
      const target = parseTag(obj.data).object;
      const targetObj = repo.objects.get(target);
      if (targetObj !== undefined && targetObj.type === 'commit' && !queued.has(target)) {
        queued.add(target);
        queue.push({ oid: target, level: 0 });
      }
    } else if (obj.type === 'commit' && !queued.has(want)) {
      queued.add(want);
      queue.push({ oid: want, level: 0 });
    }
  }
  const sentCommits = new Set<string>();
  while (queue.length > 0) {
    const { oid, level } = queue.shift()!;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const isHeld = heldCommits.has(oid);
    const isBoundary = shallowSet.has(oid);
    if (!isHeld && (depth === null || level < depth)) sentCommits.add(oid);
    if (depth !== null && level + 1 >= depth) continue;
    if (isHeld && !isBoundary) continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (!queued.has(parent)) {
        queued.add(parent);
        queue.push({ oid: parent, level: level + 1 });
      }
    }
  }

  const objects = new Map<string, GitObject>();
  for (const tag of tagObjects) {
    const obj = repo.objects.get(tag);
    if (obj !== undefined && !heldObjects.has(tag)) objects.set(tag, obj);
  }
  for (const oid of sentCommits) {
    const commit = repo.objects.get(oid);
    if (commit === undefined) continue;
    if (!heldObjects.has(oid)) objects.set(oid, commit);
    const treeStack = [parseCommit(commit.data).tree];
    while (treeStack.length > 0) {
      const t = treeStack.pop()!;
      const tobj = repo.objects.get(t);
      if (tobj === undefined) continue;
      if (!heldObjects.has(t)) objects.set(t, tobj);
      if (tobj.type === 'tree') {
        for (const entry of parseTree(tobj.data)) treeStack.push(entry.oid);
      }
    }
  }
  // Sort by oid. The map is already keyed by oid, so sort the keys directly:
  // the old code recomputed objectId (a SHA-1) for both sides of every
  // comparison, an O(n log n) pile of hashes for a key that was already there.
  const sorted = [...objects.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([, obj]) => obj);

  const parentsOf = (oid: string): string[] => {
    const obj = repo.objects.get(oid);
    return obj !== undefined && obj.type === 'commit' ? parseCommit(obj.data).parents : [];
  };
  const shallow: string[] = [];
  for (const oid of sentCommits) {
    const parents = parentsOf(oid);
    const boundary = parents.length === 0
      ? depth !== null
      : parents.some((p) => !sentCommits.has(p) && !heldCommits.has(p));
    if (boundary) shallow.push(oid);
  }
  for (const b of shallowBoundaries) {
    if (sentCommits.has(b) || heldCommits.has(b)) {
      const parents = parentsOf(b);
      if (parents.length > 0 && parents.some((p) => !sentCommits.has(p) && !heldCommits.has(p)) && !shallow.includes(b)) {
        shallow.push(b);
      }
    }
  }
  const unshallow: string[] = [];
  for (const b of shallowBoundaries) {
    const parents = parentsOf(b);
    if (parents.length > 0 && parents.every((p) => sentCommits.has(p) || heldCommits.has(p))) unshallow.push(b);
  }
  return { objects: sorted, shallow: shallow.sort(), unshallow: unshallow.sort() };
}

function v2FetchResponse(plan: FetchPlan): Buffer {
  const chunks: Buffer[] = [
    pktLine('acknowledgments\n'),
    pktLine('NAK\n'),
    DELIM_PKT,
  ];
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    chunks.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) chunks.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) chunks.push(pktLine(`unshallow ${oid}\n`));
    chunks.push(DELIM_PKT);
  }
  chunks.push(pktLine('packfile\n'));
  chunks.push(...sidebandPackets(writePack(plan.objects), 1));
  chunks.push(FLUSH_PKT);
  return Buffer.concat(chunks);
}

function v0FetchResponse(plan: FetchPlan): Buffer {
  const chunks: Buffer[] = [pktLine('NAK\n')];
  for (const oid of plan.shallow) chunks.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) chunks.push(pktLine(`unshallow ${oid}\n`));
  chunks.push(...sidebandPackets(writePack(plan.objects), 1));
  chunks.push(FLUSH_PKT);
  return Buffer.concat(chunks);
}

interface UploadPackRequest {
  command: 'fetch' | 'ls-refs' | null;
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  prefixes: string[];
  peel: boolean;
  symrefs: boolean;
}

function parseUploadPackBody(body: Buffer): UploadPackRequest {
  const packets = parsePktLines(body);
  const req: UploadPackRequest = {
    command: null,
    wants: [],
    haves: [],
    shallow: [],
    depth: null,
    prefixes: [],
    peel: false,
    symrefs: false,
  };
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!seenDelim && line.startsWith('command=')) {
      req.command = line.slice('command='.length) as 'fetch' | 'ls-refs';
      continue;
    }
    if (line.startsWith('want ')) req.wants.push(line.slice(5).split(' ')[0]);
    else if (line.startsWith('have ')) req.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) req.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) req.depth = Number(line.slice(7).trim());
    else if (line.startsWith('ref-prefix ')) req.prefixes.push(line.slice('ref-prefix '.length));
    else if (line === 'peel') req.peel = true;
    else if (line === 'symrefs') req.symrefs = true;
    else if (line === 'done') break;
  }
  return req;
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/**
 * Parse a receive-pack body: pkt-line commands up to the first flush, then the raw
 * pack bytes that follow. The pack is NOT pkt-line framed, so it must never be fed
 * to the pkt-line parser.
 */
function parsePushBody(body: Buffer): { commands: PushCommand[]; pack: Buffer | null } {
  const commands: PushCommand[] = [];
  let offset = 0;
  while (offset + 4 <= body.length) {
    const size = Number.parseInt(body.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(size) || size < 0 || size > 65520) throw new Error('malformed pkt-line length');
    if (size === 0) {
      offset += 4;
      break;
    }
    if (size < 4) {
      offset += 4;
      continue;
    }
    if (offset + size > body.length) throw new Error('truncated pkt-line payload');
    const line = body.subarray(offset + 4, offset + size).toString('utf8');
    const nul = line.indexOf('\0');
    const text = (nul >= 0 ? line.slice(0, nul) : line).replace(/\n$/, '');
    const parts = text.split(' ');
    if (parts.length >= 3) commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    offset += size;
  }
  const pack = offset < body.length ? body.subarray(offset) : null;
  return { commands, pack };
}

function pushReportResponse(results: { ref: string; ok: boolean; reason: string }[], unpackOk: boolean, unpackDetail: string): Buffer {
  const lines: Buffer[] = [pktLine(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`)];
  for (const result of results) {
    lines.push(result.ok ? pktLine(`ok ${result.ref}\n`) : pktLine(`ng ${result.ref} ${result.reason}\n`));
  }
  lines.push(FLUSH_PKT);
  const report = Buffer.concat(lines);
  return Buffer.concat([...sidebandPackets(report, 1), FLUSH_PKT]);
}

/** Route the request; returns true when it was a /.git request. */
export async function handleGit(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = pathOf(req);
  const match = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
  if (match === null) return false;
  const method = req.method ?? 'GET';
  const owner = match[1];
  const repoName = match[2];
  const suffix = match[3] ?? '';

  if (!hasValidAuth(req)) {
    sendError(res, 401, 'Requires authentication');
    return true;
  }
  if (owner !== VIEWER.login) {
    sendError(res, 404, 'Not Found');
    return true;
  }
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) {
    sendError(res, 404, 'Not Found');
    return true;
  }

  try {
    if (method === 'GET' && suffix.startsWith('/info/refs')) {
      const query = queryOf(req);
      const service = query.get('service') ?? '';
      if (service === 'git-upload-pack') {
        const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
        sendGit(res, 'application/x-git-upload-pack-advertisement', advertisementUploadPack(repo, v2));
        return true;
      }
      if (service === 'git-receive-pack') {
        sendGit(res, 'application/x-git-receive-pack-advertisement', advertisementReceivePack(repo));
        return true;
      }
      sendError(res, 400, 'Missing service parameter');
      return true;
    }

    if (method === 'POST' && suffix === '/git-upload-pack') {
      const raw = await readBody(req);
      let request: UploadPackRequest;
      try {
        request = parseUploadPackBody(raw);
      } catch {
        sendError(res, 400, 'Malformed pkt-line request');
        return true;
      }
      const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      if (v2 && request.command === 'ls-refs') {
        sendGit(res, 'application/x-git-upload-pack-result', lsRefsResponse(repo, request.prefixes, request.peel, request.symrefs));
        return true;
      }
      const cacheKey = fetchCacheKey(repo, request, v2);
      const cached = fetchCacheGet(cacheKey);
      if (cached !== undefined) {
        sendGit(res, 'application/x-git-upload-pack-result', cached);
        return true;
      }
      const plan = planFetch(repo, request.wants, request.haves, request.shallow, request.depth);
      const response = v2 ? v2FetchResponse(plan) : v0FetchResponse(plan);
      fetchCachePut(cacheKey, response);
      sendGit(res, 'application/x-git-upload-pack-result', response);
      return true;
    }

    if (method === 'POST' && suffix === '/git-receive-pack') {
      const raw = await readBody(req);
      let parsed: { commands: PushCommand[]; pack: Buffer | null };
      try {
        parsed = parsePushBody(raw);
      } catch {
        sendGit(res, 'application/x-git-receive-pack-result', pushReportResponse([], false, 'malformed request'));
        return true;
      }
      const { commands, pack } = parsed;
      let unpackOk = true;
      let unpackDetail = 'ok';
      if (pack !== null && pack.length > 0) {
        try {
          const read = readPack(pack);
          for (const [oid, obj] of read.objects) {
            if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
          }
        } catch (err) {
          unpackOk = false;
          unpackDetail = err instanceof Error ? err.message : 'unpacker error';
        }
      }
      const results: { ref: string; ok: boolean; reason: string }[] = [];
      if (unpackOk) {
        for (const command of commands) {
          const current = repo.refs.get(command.ref);
          if (command.newOid === ZERO_OID) {
            // Delete.
            if (current === undefined) {
              results.push({ ref: command.ref, ok: false, reason: 'no such ref' });
            } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
              results.push({ ref: command.ref, ok: false, reason: 'stale info' });
            } else {
              repo.refs.delete(command.ref);
              results.push({ ref: command.ref, ok: true, reason: '' });
            }
            continue;
          }
          if (command.oldOid === ZERO_OID) {
            // Create.
            if (current !== undefined) {
              results.push({ ref: command.ref, ok: false, reason: 'already exists' });
              continue;
            }
          } else {
            if (current === undefined) {
              results.push({ ref: command.ref, ok: false, reason: 'no such ref' });
              continue;
            }
            if (command.oldOid !== current) {
              results.push({ ref: command.ref, ok: false, reason: 'stale info' });
              continue;
            }
            if (!store.isAncestor(repo, command.oldOid, command.newOid)) {
              results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
              continue;
            }
          }
          if (!repo.objects.has(command.newOid)) {
            results.push({ ref: command.ref, ok: false, reason: 'missing object' });
            continue;
          }
          repo.refs.set(command.ref, command.newOid);
          results.push({ ref: command.ref, ok: true, reason: '' });
        }
        repo.updatedAt = trialNowIso();
        repo.pushedAt = repo.updatedAt;
      } else {
        for (const command of commands) results.push({ ref: command.ref, ok: false, reason: 'unpacker error' });
      }
      sendGit(res, 'application/x-git-receive-pack-result', pushReportResponse(results, unpackOk, unpackDetail));
      return true;
    }

    sendError(res, 404, 'Not Found');
    return true;
  } catch (err) {
    sendError(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
    return true;
  }
}
