// scripts/spike/live-run/proxy.mjs
// Diagnostic-only reverse proxy for the FIRST LIVE RUN of one-brain endpoint mode
// (docs/plans/2026-09-22-one-brain-live-path.md, Lane G). NOT product code -- lives entirely
// under scripts/spike/, imported by nothing else, deleted at the end of the spike session.
//
// Why this exists: packages/server/src/brain/endpoint.ts has zero request/response logging
// today, so there is no way to see what AssemblyAI actually POSTs to
// POST /api/brain/chat/completions (the exact `messages[]` it sends, especially the last
// `role: user` message's text) or what our endpoint streamed back, from the real server's own
// log. This proxy sits between the cloudflared tunnel and the real server
// (http://localhost:8787), logs every request/response for the brain route in full (method,
// path, headers minus Authorization, raw body, timing, and every SSE line written back), and
// passes every other path through unchanged, byte for byte, so the rest of the stack (health
// checks, the rehearsal harness's own direct WS connection to :8787) is unaffected. The harness
// itself talks to :8787 directly, never through this proxy -- only AssemblyAI's own outbound
// HTTP call (COUNTERSIGN_PUBLIC_URL -> tunnel -> this proxy -> :8787) passes through it.
import http from 'node:http';
import { appendFileSync } from 'node:fs';

const TARGET_PORT = 8787;
const LISTEN_PORT = 8790;
const LOG_FILE = new URL('./proxy-brain.log', import.meta.url).pathname;

function log(obj) {
  const line = JSON.stringify({ t: new Date().toISOString(), ...obj });
  appendFileSync(LOG_FILE, line + '\n');
}

const server = http.createServer((req, res) => {
  const start = Date.now();
  const isBrainRoute = req.url === '/api/brain/chat/completions';
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const reqBody = Buffer.concat(chunks).toString('utf8');
    if (isBrainRoute) {
      log({ dir: 'request', method: req.method, url: req.url, body: reqBody });
    }

    const upstreamReq = http.request(
      {
        host: 'localhost',
        port: TARGET_PORT,
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 500, upstreamRes.headers);
        const respChunks = [];
        upstreamRes.on('data', (c) => {
          respChunks.push(c);
          res.write(c);
          if (isBrainRoute) {
            log({ dir: 'response_chunk', ms_since_request: Date.now() - start, chunk: c.toString('utf8') });
          }
        });
        upstreamRes.on('end', () => {
          res.end();
          if (isBrainRoute) {
            log({
              dir: 'response_end',
              ms_total: Date.now() - start,
              status: upstreamRes.statusCode,
              full_body: Buffer.concat(respChunks).toString('utf8'),
            });
          }
        });
      }
    );
    upstreamReq.on('error', (err) => {
      if (isBrainRoute) log({ dir: 'upstream_error', error: String(err) });
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    upstreamReq.end(reqBody);
  });
});

server.listen(LISTEN_PORT, () => {
  console.log(`brain diagnostic proxy listening on :${LISTEN_PORT} -> forwarding to :${TARGET_PORT}, logging ${LOG_FILE}`);
});
