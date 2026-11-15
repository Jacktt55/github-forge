// http.ts — small shared helpers for the entry's HTTP server.
//
// Every REST reply is application/json with a non-empty X-GitHub-Request-Id; errors
// carry a JSON body {message}. Request ids are a deterministic counter (no wall clock,
// no randomness), so two runs on the same instance answer identically.

import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;

/** The next deterministic request id. */
export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(16).padStart(8, '0')}`;
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

/**
 * Send a pre-serialized JSON body (already ending in '\n') with its byte
 * length already computed. The x-github-request-id is still fresh per
 * request, so only the body bytes are reused. Use only for responses whose
 * bytes are fully determined by a versioned cache key.
 */
export function sendCachedJson(
  res: ServerResponse,
  status: number,
  text: string,
  byteLength: number,
  headers: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': byteLength,
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

/** The parsed URL of a request, cached per request object: app.ts, the REST router, and the git router each ask for the path and/or the query, and parsing the same URL three times per request is pure overhead. A request object lives only for its own handling, so the WeakMap never retains anything. */
const requestUrlCache = new WeakMap<IncomingMessage, URL>();

function requestUrl(req: IncomingMessage): URL {
  const cached = requestUrlCache.get(req);
  if (cached !== undefined) return cached;
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    url = new URL('/', 'http://entry');
  }
  requestUrlCache.set(req, url);
  return url;
}

/** The path of a request URL, or '/' when it does not parse (never a throw). */
export function pathOf(req: IncomingMessage): string {
  return requestUrl(req).pathname;
}

/** Parsed query parameters of a request URL. */
export function queryOf(req: IncomingMessage): URLSearchParams {
  return requestUrl(req).searchParams;
}

/** Read the whole request body (up to 64 MiB); resolves to the raw bytes. */
export function readBody(req: IncomingMessage, limit = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Parse a JSON request body. Returns {ok:true, value} on success (an empty body parses
 * as null), or {ok:false} when the body is not valid JSON — the caller answers 400.
 */
export function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The bearer token this entry expects, from MAKEFUN_SHOP_TOKEN. Read once and cached: process.env access is a C++-backed getter, so reading it on every request is pure overhead. The token is fixed for the process's life. */
let cachedToken: string | undefined;
export function expectedToken(): string {
  if (cachedToken === undefined) cachedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  return cachedToken;
}

/** True when the request carries exactly the trial's bearer token. */
export function hasValidAuth(req: IncomingMessage): boolean {
  const token = expectedToken();
  if (token === '') return false;
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${token}`;
}

/** Decode a path segment the client percent-encoded (apiPath encodes each segment). Fast path: most segments carry no '%', so skip decodeURIComponent (and its try/catch) entirely. */
export function decodeSegment(segment: string): string {
  if (!segment.includes('%')) return segment;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
