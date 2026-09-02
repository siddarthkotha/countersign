import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { ServerConfig } from './config.js';
import { newCapsState, canStartSession, startSession, endSession, type CapsState } from './caps.js';

export interface HttpDeps {
  fetchImpl: typeof fetch;
  now: () => number;
  randomId: () => string;
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
      endSession(state, id);
      res.writeHead(204);
      res.end();
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  });

  return { server, state };
}
