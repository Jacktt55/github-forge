// gitobj.ts — git objects, pkt-line framing, and packfile read/write, all stdlib.
//
// Objects: SHA-1 over "<type> <size>\0" + bytes (node:crypto), zlib for pack payloads
// (node:zlib). Packs are written with plain (undelted) objects only — the suite's
// pack-deltas check accepts that ("when the server sends them") — and read with full
// OFS_DELTA / REF_DELTA resolution, since a real git client may push delta packs.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export function objectId(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** git's tree sort: directory names compare with a trailing '/'. */
export function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) throw new Error('malformed tree object');
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

// ---------------------------------------------------------------- commits / tags

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function buildCommit(info: CommitInfo): Buffer {
  const lines: string[] = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author}`);
  lines.push(`committer ${info.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export interface TagInfo {
  object: string;
  type: ObjectType;
  tag: string;
  tagger: string;
  message: string;
}

export function buildTag(info: TagInfo): Buffer {
  return Buffer.from(
    `object ${info.object}\ntype ${info.type}\ntag ${info.tag}\ntagger ${info.tagger}\n\n${info.message}`,
    'utf8',
  );
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type: ObjectType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as ObjectType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------- pkt-line

/** One pkt-line frame: 4 hex digits of (payload length + 4), then the payload. */
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const head = Buffer.from((body.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const FLUSH_PKT = Buffer.from('0000', 'ascii');
export const DELIM_PKT = Buffer.from('0001', 'ascii');
export const RESPONSE_END_PKT = Buffer.from('0002', 'ascii');

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface Pkt {
  kind: PktKind;
  payload: Buffer;
}

/**
 * Parse a pkt-line stream. Throws on a malformed length prefix — the caller turns that
 * into a 400, never a crash (repo-survives-errors posts garbage at the upload-pack).
 */
export function parsePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line header');
    const raw = buf.subarray(offset, offset + 4).toString('ascii');
    const size = Number.parseInt(raw, 16);
    if (Number.isNaN(size) || size < 0 || size > 65520) throw new Error(`malformed pkt-line length ${JSON.stringify(raw)}`);
    if (size === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (size === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (size === 2) {
      out.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (offset + size > buf.length) throw new Error('truncated pkt-line payload');
    out.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + size) });
    offset += size;
  }
  return out;
}

/** Split one sideband payload's band byte from its data. */
export function sidebandPackets(data: Buffer, band = 1): Buffer[] {
  const out: Buffer[] = [];
  const maxData = 65520 - 4 - 1;
  for (let offset = 0; offset < data.length; offset += maxData) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + maxData));
    out.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  if (data.length === 0) out.push(pktLine(Buffer.from([band])));
  return out;
}

// ---------------------------------------------------------------- packfiles

const PACK_TYPES: Record<number, ObjectType | 'ofs-delta' | 'ref-delta'> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
  6: 'ofs-delta',
  7: 'ref-delta',
};

function readPackObjectHeader(buf: Buffer, offset: number): { type: number; size: number; next: number } {
  const first = buf[offset];
  const type = (first >> 4) & 0x07;
  let size = first & 0x0f;
  let shift = 4;
  let i = offset + 1;
  let cont = first & 0x80;
  while (cont) {
    const b = buf[i];
    size |= (b & 0x7f) << shift;
    shift += 7;
    cont = b & 0x80;
    i += 1;
  }
  return { type, size, next: i };
}

/**
 * Inflate the zlib stream starting at `offset` and return the data plus the exact number
 * of input bytes the stream consumed. inflateSync tolerates trailing bytes, so a binary
 * search finds the minimal complete slice.
 */
function inflateAt(buf: Buffer, offset: number): { data: Buffer; consumed: number } {
  const rest = buf.subarray(offset);
  let lo = 1;
  let hi = rest.length;
  let data: Buffer | null = null;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      data = inflateSync(rest.subarray(0, mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  if (data === null) data = inflateSync(rest.subarray(0, lo));
  return { data, consumed: lo };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readDeltaVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const b = delta[pos++];
      value |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return value;
  };
  const baseSize = readDeltaVarint();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const resultSize = readDeltaVarint();
  const out: Buffer[] = [];
  let written = 0;
  while (pos < delta.length) {
    const op = delta[pos++];
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset = delta[pos++];
      if (op & 0x02) offset |= delta[pos++] << 8;
      if (op & 0x04) offset |= delta[pos++] << 16;
      if (op & 0x08) offset |= delta[pos++] << 24;
      if (op & 0x10) size = delta[pos++];
      if (op & 0x20) size |= delta[pos++] << 8;
      if (op & 0x40) size |= delta[pos++] << 16;
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      written += size;
    } else if (op !== 0) {
      out.push(delta.subarray(pos, pos + op));
      pos += op;
      written += op;
    } else {
      throw new Error('invalid delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== resultSize || written !== resultSize) throw new Error('delta result size mismatch');
  return result;
}

export interface ParsedPack {
  version: number;
  declaredCount: number;
  objects: Map<string, GitObject>;
}

/** Parse a packfile (version 2/3), resolving OFS_DELTA and REF_DELTA entries. */
export function readPack(buf: Buffer): ParsedPack {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = buf.readUInt32BE(4);
  const declaredCount = buf.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const offsetToOid = new Map<number, string>();
  const pending: { offset: number; type: number; data: Buffer; baseOffset?: number; baseOid?: string }[] = [];
  let offset = 12;
  for (let i = 0; i < declaredCount; i += 1) {
    const entryOffset = offset;
    const header = readPackObjectHeader(buf, offset);
    offset = header.next;
    const typeName = PACK_TYPES[header.type];
    if (typeName === undefined) throw new Error(`unknown pack object type ${header.type}`);
    if (typeName === 'ofs-delta') {
      // Negative offset: first byte's 7 bits, then ((offset + 1) << 7) | next 7 bits per byte.
      let baseOffset = buf[offset] & 0x7f;
      let b = buf[offset];
      offset += 1;
      while (b & 0x80) {
        b = buf[offset];
        baseOffset = ((baseOffset + 1) << 7) | (b & 0x7f);
        offset += 1;
      }
      const inflated = inflateAt(buf, offset);
      offset += inflated.consumed;
      pending.push({ offset: entryOffset, type: header.type, data: inflated.data, baseOffset: entryOffset - baseOffset });
      continue;
    }
    if (typeName === 'ref-delta') {
      const baseOid = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const inflated = inflateAt(buf, offset);
      offset += inflated.consumed;
      pending.push({ offset: entryOffset, type: header.type, data: inflated.data, baseOid });
      continue;
    }
    const inflated = inflateAt(buf, offset);
    offset += inflated.consumed;
    if (inflated.data.length !== header.size) throw new Error('pack object size mismatch');
    const oid = objectId(typeName as ObjectType, inflated.data);
    objects.set(oid, { type: typeName as ObjectType, data: inflated.data });
    offsetToOid.set(entryOffset, oid);
  }
  // Resolve deltas in pack order (a delta's base always precedes it in the pack).
  for (const entry of pending) {
    let base: GitObject | undefined;
    if (entry.baseOffset !== undefined) {
      const baseOid = offsetToOid.get(entry.baseOffset);
      base = baseOid === undefined ? undefined : objects.get(baseOid);
    } else if (entry.baseOid !== undefined) {
      base = objects.get(entry.baseOid);
    }
    if (base === undefined) throw new Error('delta base not found in pack');
    const data = applyDelta(base.data, entry.data);
    const oid = objectId(base.type, data);
    objects.set(oid, { type: base.type, data });
    offsetToOid.set(entry.offset, oid);
  }
  const trailer = buf.subarray(buf.length - 20).toString('hex');
  const expected = sha1Hex(buf.subarray(0, buf.length - 20));
  if (trailer !== expected) throw new Error('pack trailer checksum mismatch');
  return { version, declaredCount, objects };
}

/** Write a version-2 pack of plain objects (no deltas), with the SHA-1 trailer. */
export function writePack(entries: readonly GitObject[]): Buffer {
  const typeCode: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  const chunks: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);
  chunks.push(header);
  for (const entry of entries) {
    const size = entry.data.length;
    const type = typeCode[entry.type];
    const first: number[] = [];
    let remaining = size;
    first.push((type << 4) | (remaining & 0x0f));
    remaining >>= 4;
    while (remaining > 0) {
      first[first.length - 1] |= 0x80;
      first.push(remaining & 0x7f);
      remaining >>= 7;
    }
    chunks.push(Buffer.from(first));
    chunks.push(deflateSync(entry.data));
  }
  const body = Buffer.concat(chunks);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Verify a pack's trailer checksum (pack-integrity). */
export function verifyPackChecksum(buf: Buffer): boolean {
  if (buf.length < 20) return false;
  return buf.subarray(buf.length - 20).toString('hex') === sha1Hex(buf.subarray(0, buf.length - 20));
}
