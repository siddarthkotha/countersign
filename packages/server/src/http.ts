import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { ServerConfig } from './config.js';
import { newCapsState, canStartSession, startSession, type CapsState } from './caps.js';
import { defaultCorpusDir, listCorpusFiles, loadCorpusFile } from './replay.js';
import type { StaticServer } from './static.js';
import { isAllowedOrigin } from './origin.js';
import { addClientEvents, checkClientPostRate, getBundle, MAX_CLIENT_BODY_BYTES, type DiagnosticsState } from './diagnostics.js';

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
  /** Fix round 1 (MINOR): overrides `readBodyLimited`'s default 10s timeout on the POST
   *  .../diagnostics route. Defaults to `CLIENT_BODY_READ_TIMEOUT_MS` when omitted (every
   *  real caller, including index.ts); tests override it to a short value to exercise the
   *  timeout path without a slow real wait. */
  diagnostics_post_timeout_ms?: number;
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

/** Fix round 1 (MINOR, review finding): how long `readBodyLimited` waits for a body to
 *  finish arriving before giving up -- previously unbounded (implicitly relying on Node's
 *  own `server.headersTimeout`/`requestTimeout` defaults, ~60s/300s, undocumented here). A
 *  slow-trickling body below the byte cap could otherwise hold the request (and its
 *  `handleRequest` coroutine) open indefinitely. */
const CLIENT_BODY_READ_TIMEOUT_MS = 10_000;

/** Reads a request body up to `maxBytes`, giving up after `timeoutMs` (default
 *  `CLIENT_BODY_READ_TIMEOUT_MS`; overridable so tests can use a short one). Once the stream
 *  would exceed `maxBytes`, stops buffering further chunks (bounding memory to roughly
 *  `maxBytes`) but keeps DRAINING the stream to its actual end rather than destroying it --
 *  destroying `req` mid-body tears down the underlying socket this response would otherwise
 *  be written back on (`req`/`res` share one connection in `node:http`), which turns an
 *  intended 413 into a raw connection reset on the client (fix round 0's own finding, same
 *  reasoning extends to the timeout path -- see the caller's handling of `reason:'timeout'`,
 *  which writes the 408 before ever touching the socket). On timeout, this function itself
 *  does NOT touch `req`/the socket at all -- it only resolves; the caller (which holds
 *  `res`) is responsible for responding first, then closing. */
function readBodyLimited(
  req: IncomingMessage,
  maxBytes: number,
  timeoutMs: number = CLIENT_BODY_READ_TIMEOUT_MS,
): Promise<{ ok: true; body: string } | { ok: false; reason: 'too_large' | 'timeout' }> {
  return new Promise((resolve) => {
    let size = 0;
    let oversize = false;
    let settled = false;
    const chunks: Buffer[] = [];

    const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), timeoutMs);
    (timer as unknown as { unref?: () => void }).unref?.();

    function finish(result: { ok: true; body: string } | { ok: false; reason: 'too_large' | 'timeout' }): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    }

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        oversize = true;
        return; // keep draining -- just stop retaining bytes past the limit
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(oversize ? { ok: false, reason: 'too_large' } : { ok: true, body: Buffer.concat(chunks).toString('utf-8') }));
    req.on('error', () => finish({ ok: false, reason: 'too_large' }));
  });
}

function statusForDecisionReason(reason: 'kill_switch' | 'session_in_use' | 'daily_cap' | 'mint_rate' | 'no_api_key'): number {
  return reason === 'kill_switch' || reason === 'no_api_key' ? 503 : 429;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Judge review finding (2026-09-04), defect 2: docs/SUBMISSION-DRAFT.md tells a judge to
// click Replay first and expect "a full recorded interrogation" -- the flagship attack
// scenario -- but the dropdown used to be 18 bare filenames in alphabetical order, so the
// flagship sat 14th with no description. `scenario-b-miller-fraud` is that flagship (BRIEF
// §4 attack path); it now sorts first in `recordings` below and its label is marked
// "Recommended", instead of moving it to be the pre-selected/auto-started recording (that
// would change what the screen shows on mount before any judge click -- a visual/behaviour
// decision parked for the founder, not made here).
const FLAGSHIP_RECORDING = 'scenario-b-miller-fraud';

interface ReplayRecording {
  file: string;
  label: string;
  recommended: boolean;
}

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

    // Deploy-verification endpoint (added 2026-09-03): reports the commit the running
    // process was built from, so a redeploy can be confirmed without a WebSocket attach.
    // Server-only changes leave the Vite bundle hash unchanged, so the bundle name is a
    // false negative for "did the server redeploy" -- this is the reliable signal. Render
    // sets RENDER_GIT_COMMIT automatically on every deploy; null in local dev.
    if (req.method === 'GET' && path === '/version') {
      sendJson(res, 200, { commit: process.env.RENDER_GIT_COMMIT ?? null });
      return;
    }

    // W2 (replay screen): the corpus file names, without extension, so the browser's file
    // picker never has to hard-code the list. `listCorpusFiles`/`defaultCorpusDir` already
    // exist in replay.ts (S2) -- this route just exposes them over HTTP; the whitelist
    // behaviour (no path can escape the corpus directory) lives entirely in replay.ts and is
    // unchanged by this route.
    //
    // Judge review finding (2026-09-04), defect 2: `files` alone forced the browser to show
    // the raw corpus filename as the only option text, alphabetically sorted -- the flagship
    // scenario buried 14th, no indication of what any recording actually is. `files` is left
    // exactly as it was (same values, same order) so any existing caller keeps working;
    // `recordings` is additive -- one entry per file, `label` taken verbatim from that
    // corpus's own `title` field (never invented copy), flagship-first with `recommended:
    // true` so the screen can mark it without a second source of truth for which one it is.
    if (req.method === 'GET' && path === '/api/replay') {
      const corpusDir = defaultCorpusDir();
      const files = Array.from(listCorpusFiles(corpusDir)).sort();
      const recordings: ReplayRecording[] = files.map((file) => {
        const recommended = file === FLAGSHIP_RECORDING;
        const corpus = loadCorpusFile(corpusDir, file);
        const label = corpus ? (recommended ? `Recommended: ${corpus.title}` : corpus.title) : file;
        return { file, label, recommended };
      });
      recordings.sort((a, b) => {
        if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
        return a.file.localeCompare(b.file);
      });
      sendJson(res, 200, { files, recordings });
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
      // the server can't see that leg directly).
      // Fix round 1 (review finding, IMPORTANT): the rate limit is checked FIRST, before the
      // body is even read -- a client already over `MAX_CLIENT_POSTS_PER_MINUTE` shouldn't
      // get to spend a body-read/parse cycle before being told no. Body-size cap (413) is
      // enforced next by `readBodyLimited` BEFORE any JSON parsing; shape/per-event-size/
      // session-cumulative-budget validation (400 for shape, 413 for a full session budget)
      // is `addClientEvents`'s job (diagnostics.ts) -- same division as everywhere else in
      // this file (transport-level checks here, payload validation in the owning module).
      const rate = checkClientPostRate(deps.diagnostics, id, now);
      if (rate === 'not_found') {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }
      if (rate === 'rate_limited') {
        sendJson(res, 429, { error: 'rate_limited' });
        return;
      }

      const bodyResult = await readBodyLimited(req, MAX_CLIENT_BODY_BYTES, deps.diagnostics_post_timeout_ms);
      if (!bodyResult.ok) {
        if (bodyResult.reason === 'timeout') {
          // Fix round 1 (MINOR): "drain and close" -- the response is written and flushed
          // first (so the client actually sees the 408, matching the same lesson as the
          // oversize-body fix below: destroying the connection BEFORE the response goes out
          // turns an intended status code into a raw connection reset), and only THEN is the
          // socket half-closed via `Socket#end()` -- which itself waits for any queued write
          // (the 408 body) to flush before sending the FIN, i.e. drain-then-close, not an
          // abrupt `destroy()`. A still-open request stream past this point is never reused
          // for a next keep-alive request on the same socket.
          sendJson(res, 408, { error: 'request_timeout' });
          res.socket?.end();
          return;
        }
        sendJson(res, 413, { error: 'payload_too_large' });
        return;
      }
      const result = addClientEvents(deps.diagnostics, id, bodyResult.body);
      if (!result.ok) {
        const status = result.reason === 'not_found' ? 404 : result.reason === 'session_full' ? 413 : 400;
        sendJson(res, status, { error: result.reason });
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
