import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { ServerConfig } from './config.js';
import { newCapsState, canStartSession, startSession, type CapsState } from './caps.js';
import { defaultCorpusDir, listCorpusFiles } from './replay.js';

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
}

function applyCors(req: IncomingMessage, res: ServerResponse, cfg: ServerConfig): void {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && cfg.allowed_origins.includes(origin)) {
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

function statusForDecisionReason(reason: 'kill_switch' | 'session_in_use' | 'daily_cap' | 'mint_rate' | 'no_api_key'): number {
  return reason === 'kill_switch' || reason === 'no_api_key' ? 503 : 429;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createHttpServer(cfg: ServerConfig, deps: HttpDeps): { server: Server; state: CapsState } {
  const state = newCapsState();

  const server = createServer((req, res) => {
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

    sendJson(res, 404, { error: 'not found' });
  });

  return { server, state };
}
