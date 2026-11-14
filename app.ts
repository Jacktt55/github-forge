// app.ts — the forge's HTTP server.
//
// One server, four surfaces, dispatched in order:
//   GET  /healthz        the env's boot probe (no auth)
//   POST /mcp            Model Context Protocol (JSON-RPC 2.0 streamable HTTP)
//   POST /api/graphql    GitHub GraphQL v4
//   /api/v3/...          GitHub REST v3
//   /{owner}/{repo}.git  git smart HTTP (upload-pack v2/v0, receive-pack v0)
//   anything else        JSON 404 {message: "Not Found"}
//
// main.ts is the entry <-> env lifecycle and stays as it is; this file is the server.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGit } from './src/git-http.ts';
import { handleGraphql } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { handleRest } from './src/rest.ts';
import { pathOf, sendError, sendJson } from './src/http.ts';

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const path = pathOf(req);
        const method = req.method ?? 'GET';

        // The env's boot check calls this twice: 200 {"ok":true}. No auth.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        if (path === '/mcp' && (await handleMcp(req, res))) return;
        if (path === '/api/graphql' && (await handleGraphql(req, res))) return;
        if (path.startsWith('/api/v3') && (await handleRest(req, res))) return;
        if (await handleGit(req, res)) return;

        // Everything else, every method: GitHub's 404 body.
        sendError(res, 404, 'Not Found');
      } catch (err) {
        if (!res.headersSent) sendError(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
        else res.destroy();
      }
    })();
  });
  // Disable Nagle's algorithm on every accepted socket: the bench is thousands
  // of small request/response pairs (2,000 sequential GETs, 200 pushes), and a
  // delayed-ACK / Nagle interaction adds a fixed latency to each round-trip.
  // This is transport tuning only; it cannot change any response bytes.
  // Disable Nagle's algorithm on every accepted socket: the bench is thousands
  // of small request/response pairs (2,000 sequential GETs, 200 pushes), and a
  // delayed-ACK / Nagle interaction adds a fixed latency to each round-trip.
  // This is transport tuning only; it cannot change any response bytes.
  server.on('connection', (sock) => sock.setNoDelay(true));
  return server;
}
