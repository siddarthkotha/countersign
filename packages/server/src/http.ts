import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { ServerConfig } from './config.js';
import { newCapsState, canStartSession, startSession, type CapsState } from './caps.js';
import { defaultCorpusDir, listCorpusFiles } from './replay.js';
import type { StaticServer } from './static.js';
import { isAllowedOrigin } from './origin.js';
import { addClientEvents, getBundle, MAX_CLIENT_BODY_BYTES, type DiagnosticsState } from './diagnostics.js';

export interface HttpDeps {
  fetchImpl: typeof fetch;
  now: () => number;
  randomId: () => string;
  /** CRITICAL 1 (final review): `/end`/`/reset` used to only touch `CapsState`
   *  (`endSession`), never the live call itself -- a session could be "reset" while its
   *  AssemblyAI socket and browser connection kept right on running. This is
   *  `attachWebSocketServer`'s own `endCall` (packages/server/src/ws/browser.ts), which ends
   *  the live `CallSession` + AAI socket + browser socket and frees the caps slot together.
   *  Returns `false` for an id that was never active -- routed to 404, same shape as before. */
  endCall: (session_id: string, reason: string) => boolean;
  /** Task D1: serves the built web SPA (packages/web/dist) as the LAST fallback, after every
   *  API route has failed to match. Optional -- omitted in tests that only exercise the API
   *  surface, and `available: false` (no build present) makes `handle` always decline, so
   *  omitting it changes nothing about existing behaviour. */
  staticServer?: StaticServer;
  /** Flight recorder (founder's ask, 2026-09-02): the SAME in-memory DiagnosticsState
   *  ws/browser.ts writes into (shared the way `state`/CapsState already is between the two
   *  files) -- this is what GET/POST .../diagnostics below actually read and write. */
  diagnostics: DiagnosticsState;
}

// Origin fix round 1 (task-origin-review.md): `selfOrigin`/`isAllowedOrigin` used to live
// here as this file's own private helpers, applied only to the HTTP CORS path below. They now
// live in origin.ts, the ONE module shared with ws/browser.ts's upgrade handler -- see that
// file for the full reasoning (proxy-trust gate, last-vs-first forwarded header, case/port
// normalization).
function applyCors(req: IncomingMessage, res: ServerResponse, cfg: ServerConfig): void {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && isAllowedOrigin(req, cfg)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

/** Reads a request body up to `maxBytes`. Once the stream would exceed it, stops buffering
 *  further chunks (bounding memory to roughly `maxBytes`) but keeps DRAINING the stream to
 *  its actual end rather than destroying it -- destroying `req` mid-body tears down the
 *  underlying socket this response would otherwise be written back on (`req`/`res` share one
 *  connection in `node:http`), which turns an intended 413 into a raw connection reset on
 *  the client. Resolves `{ ok: false }` once the real end of the oversize body is reached. */
function readBodyLimited(req: IncomingMessage, maxBytes: number): Promise<{ ok: true; body: string } | { ok: false }> {
  return new Promise((resolve) => {
    let size = 0;
    let oversize = false;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        oversize = true;
        return; // keep draining -- just stop retaining bytes past the limit
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(oversize ? { ok: false } : { ok: true, body: Buffer.concat(chunks).toString('utf-8') }));
    req.on('error', () => resolve({ ok: false }));
  });
}

function statusForDecisionReason(reason: 'kill_switch' | 'session_in_use' | 'daily_cap' | 'mint_rate' | 'no_api_key'): number {
  return reason === 'kill_switch' || reason === 'no_api_key' ? 503 : 429;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createHttpServer(cfg: ServerConfig, deps: HttpDeps): { server: Server; state: CapsState } {
  const state = newCapsState();

  const server = createServer((req, res) => {
    void handleRequest(req, res);
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    applyCors(req, res, cfg);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', 'http://internal');
    const path = url.pathname;
    const now = deps.now();

    if (req.method === 'GET' && path === '/health') {
      sendJson(res, 200, {
        ok: true,
        active: state.active.size,
        killed: cfg.kill_switch || state.killed,
        has_key: cfg.assemblyai_api_key !== null,
      });
      return;
    }

    // W2 (replay screen): the corpus file names, without extension, so the browser's file
    // picker never has to hard-code the list. `listCorpusFiles`/`defaultCorpusDir` already
    // exist in replay.ts (S2) -- this route just exposes them over HTTP; the whitelist
    // behaviour (no path can escape the corpus directory) lives entirely in replay.ts and is
    // unchanged by this route.
    if (req.method === 'GET' && path === '/api/replay') {
      const files = Array.from(listCorpusFiles(defaultCorpusDir())).sort();
      sendJson(res, 200, { files });
      return;
    }

    if (req.method === 'POST' && path === '/api/session/start') {
      const decision = canStartSession(state, cfg, now);
      if (!decision.ok) {
        sendJson(res, statusForDecisionReason(decision.reason), { replay_only: true, reason: decision.reason });
        return;
      }
      const id = deps.randomId();
      startSession(state, now, id);
      sendJson(res, 200, { session_id: id, ws_path: `/ws/call/${id}`, cap_seconds: cfg.session_cap_seconds });
      return;
    }

    const sessionMatch = /^\/api\/session\/([^/]+)\/(reset|end)$/.exec(path);
    if (req.method === 'POST' && sessionMatch) {
      const id = sessionMatch[1] as string;
      const action = sessionMatch[2] as 'reset' | 'end';
      if (!UUID_RE.test(id)) {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }
      // CRITICAL 1 (final review): both routes now end the live call (session + AAI socket +
      // browser socket), not just the caps reservation -- `/end` is the caller hanging up;
      // `/reset` is the operator/demo "get me a fresh slot" button, distinct only in the
      // reason recorded.
      const reason = action === 'end' ? 'caller_ended' : 'reset';
      const ended = deps.endCall(id, reason);
      if (!ended) {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }
      res.writeHead(204);
      res.end();
      return;
    }

    // Flight recorder (founder's ask, 2026-09-02): the diagnostics bundle for one call
    // session. The id is a UUID minted the same way `/api/session/start` mints one (unguess-
    // able) -- same 404-for-bad-shape check as `/reset`/`/end` above, no separate auth in v1
    // (documented: the data is synthetic by law, and unguessable-UUID is the only gate).
    const diagMatch = /^\/api\/session\/([^/]+)\/diagnostics$/.exec(path);
    if (diagMatch && (req.method === 'GET' || req.method === 'POST')) {
      const id = diagMatch[1] as string;
      if (!UUID_RE.test(id)) {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }

      if (req.method === 'GET') {
        const bundle = getBundle(deps.diagnostics, id);
        if (!bundle) {
          sendJson(res, 404, { error: 'not_found' });
          return;
        }
        sendJson(res, 200, bundle);
        return;
      }

      // POST: the browser's own client_events (its audio/worker-side leg of the same call --
      // the server can't see that leg directly). Body-size cap (413) is enforced by
      // `readBodyLimited` BEFORE any JSON parsing; shape/count validation (400) is
      // `addClientEvents`'s job (diagnostics.ts) -- same division as everywhere else in this
      // file (transport-level checks here, payload validation in the owning module).
      const bodyResult = await readBodyLimited(req, MAX_CLIENT_BODY_BYTES);
      if (!bodyResult.ok) {
        sendJson(res, 413, { error: 'payload_too_large' });
        return;
      }
      const result = addClientEvents(deps.diagnostics, id, bodyResult.body);
      if (!result.ok) {
        sendJson(res, result.reason === 'not_found' ? 404 : 400, { error: result.reason });
        return;
      }
      sendJson(res, 200, { ok: true, accepted: result.accepted });
      return;
    }

    // Task D1: static SPA fallback -- only reached once every API/WS route above has
    // declined this request. `staticServer.handle` itself refuses /api and /ws paths, so an
    // unmatched API route still gets the JSON 404 below, never an HTML page. HEAD is allowed
    // through alongside GET (D1 fix round 1 #1) -- static.ts already supports HEAD
    // (headers only, no body), but this gate used to only let GET through, so a HEAD request
    // silently fell through to the generic JSON 404 instead of ever reaching static.ts.
    if ((req.method === 'GET' || req.method === 'HEAD') && deps.staticServer?.handle(req, res)) {
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  }

  return { server, state };
}
