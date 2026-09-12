// scripts/rehearse/wsClient.ts
// A raw (no browser, no Web Worker) client for the REAL server protocol -- mint a session,
// open /ws/call/:id with the Origin header the server's upgrade gate requires, send/receive
// the exact BrowserEvent/ServerEvent shapes the browser does.
//
// Protocol facts, each PROVEN with file:line:
//  - POST /api/session/start -> { session_id, ws_path, cap_seconds } on success, or
//    { replay_only: true, reason } on a capped/killed server.
//    PROVEN: packages/server/src/http.ts:156-166.
//  - ws_path is always "/ws/call/<id>" (http.ts:164); the socket must attach there.
//  - BrowserEvent union: {type:'audio',data}|{type:'start'}|{type:'end'}|{type:'ping'}.
//    PROVEN: packages/engine/src/types.ts:388-392.
//  - ServerEvent union: {type:'state',state}|{type:'audio',data}|{type:'flush'}|
//    {type:'ended',reason}|{type:'link',state,leg}. PROVEN: types.ts:395-411.
//  - The WebSocket upgrade is gated on the Origin header: allowed only if it matches an
//    entry in COUNTERSIGN_ALLOWED_ORIGINS OR the request's own self-origin (Host header +
//    scheme). A missing/disallowed Origin gets a raw HTTP 403 before any path is even
//    matched. PROVEN: packages/server/src/ws/browser.ts:455-471 (the upgrade handler) and
//    packages/server/src/origin.ts:70-97 (`selfOrigin`/`isAllowedOrigin`). Connecting
//    straight to the server's own address (not through the Vite dev proxy) with
//    Origin == that same address always satisfies the self-origin branch, which is why this
//    client always sets Origin to exactly the --url value passed on the command line.
//  - GET /api/session/<id>/diagnostics -> the flight-recorder DiagnosticBundle for that
//    session. PROVEN: http.ts:195-211, packages/server/src/diagnostics.ts:51-70.
import { WebSocket } from 'ws';
import type { BrowserEvent, ScreenState, ServerEvent } from '@countersign/engine';
import type { RehearseDiagnosticBundle } from './types.js';

export interface StateSample {
  t_ms: number;
  state: ScreenState;
}

export interface LinkSample {
  t_ms: number;
  state: string;
  leg: string;
}

export interface CallClient {
  /** performance.now() at the moment the WebSocket handshake completed -- every other
   *  `t_ms` this client records is relative to this instant. */
  readonly startedAt: number;
  send(e: BrowserEvent): void;
  close(): void;
  readonly stateHistory: StateSample[];
  /** performance.now()-relative ms of every received `audio` ServerEvent -- audio is never
   *  throttled server-side (PROVEN: packages/server/src/ws/browser.ts:136-146, only `state`
   *  events go through the throttle), so this is the most timing-faithful signal available
   *  for "is the agent currently speaking". */
  readonly audioTimestamps: number[];
  readonly linkEvents: LinkSample[];
  latestState(): ScreenState | null;
  onEnded(cb: (reason: string) => void): void;
  waitForEnded(timeoutMs: number): Promise<string | null>;
  /** Bug fix (2026-09-11): the server can now end a call on its own once it reaches SEALED
   *  (packages/server/src/call/session.ts's CLOSE grace period/hard cap, reason
   *  "agent_closed" or "close_timeout") -- a scripted caller with more turns still queued
   *  must notice this and stop speaking into a dead session rather than run every remaining
   *  turn into a closed socket. Synchronous (unlike `waitForEnded`/`onEnded`, both async) so
   *  a turn loop can check it once per iteration with no await. Returns the same reason
   *  `onEnded`/`waitForEnded` already deliver -- one more accessor onto the same fact,
   *  never a second source of truth. */
  endedReason(): string | null;
}

export interface MintResult {
  session_id: string;
  ws_path: string;
  cap_seconds: number;
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export function baseWsUrl(httpBaseUrl: string): string {
  const u = new URL(httpBaseUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return trimTrailingSlash(u.toString());
}

/** POST /api/session/start. Throws on anything other than a fresh session (a capped/killed
 *  server's `replay_only` response, a non-2xx status, or a network failure) -- the harness
 *  treats "could not even mint a session" as a protocol/connection error (exit code 2), not
 *  a scenario failure. */
export async function mintSession(baseUrl: string, demoPersona?: string): Promise<MintResult> {
  const url = `${trimTrailingSlash(baseUrl)}/api/session/start`;
  let res: Response;
  // 2026-09-04: the server maps a NAMED demo persona to the call's simulated telemetry
  // (packages/server/src/personas.ts). Without one it falls back to the attacker context, in
  // which the sign-in check fails by design and a staged outcome is unreachable. A scenario
  // that expects STAGE must therefore name the legitimate persona, exactly as a visitor picks
  // a role card. The harness never sends telemetry values, only the name; the server owns the
  // mapping.
  const init: RequestInit = demoPersona
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ persona: demoPersona }) }
    : { method: 'POST' };
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new Error(`mintSession: could not reach ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const body = (await res.json()) as MintResult | { replay_only: true; reason: string };
  if (!res.ok || 'replay_only' in body) {
    throw new Error(`mintSession: server refused a fresh session (HTTP ${res.status}): ${JSON.stringify(body)}`);
  }
  return body;
}

/** Opens /ws/call/:id with the required Origin header and wires up typed accessors over the
 *  raw ServerEvent stream. Resolves once the handshake completes; rejects on a rejected
 *  upgrade (bad origin, unknown session id, already-connected 4409, ...) or a socket error. */
export async function connectCall(baseUrl: string, wsPath: string): Promise<CallClient> {
  const origin = trimTrailingSlash(baseUrl);
  const wsUrl = `${baseWsUrl(baseUrl)}${wsPath}`;
  const ws = new WebSocket(wsUrl, { headers: { Origin: origin } });

  const stateHistory: StateSample[] = [];
  const audioTimestamps: number[] = [];
  const linkEvents: LinkSample[] = [];
  let latest: ScreenState | null = null;
  let endedCb: ((reason: string) => void) | null = null;
  let endedReason: string | null = null;

  const startedAt = await new Promise<number>((resolve, reject) => {
    ws.once('open', () => resolve(performance.now()));
    ws.once('error', (err: Error) => reject(err));
    ws.once('unexpected-response', (_req, res) => {
      reject(new Error(`ws upgrade rejected: HTTP ${res.statusCode}`));
    });
    ws.once('close', (code, reasonBuf) => {
      reject(new Error(`ws closed before open: code=${code} reason=${reasonBuf.toString()}`));
    });
  });

  ws.on('message', (data: Buffer) => {
    let evt: ServerEvent;
    try {
      evt = JSON.parse(data.toString()) as ServerEvent;
    } catch {
      return;
    }
    const t_ms = performance.now() - startedAt;
    if (evt.type === 'state') {
      latest = evt.state;
      stateHistory.push({ t_ms, state: evt.state });
    } else if (evt.type === 'audio') {
      audioTimestamps.push(t_ms);
    } else if (evt.type === 'link') {
      linkEvents.push({ t_ms, state: evt.state, leg: evt.leg });
    } else if (evt.type === 'ended') {
      endedReason = evt.reason;
      endedCb?.(evt.reason);
    }
    // 'flush' carries no state of its own worth recording separately -- it's implicit in the
    // audio-timestamp gap a barge-in produces.
  });

  return {
    startedAt,
    send(e: BrowserEvent) {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(e));
    },
    close() {
      try {
        ws.close();
      } catch {
        // already gone
      }
    },
    stateHistory,
    audioTimestamps,
    linkEvents,
    latestState() {
      return latest;
    },
    onEnded(cb) {
      endedCb = cb;
      if (endedReason !== null) cb(endedReason);
    },
    endedReason() {
      return endedReason;
    },
    async waitForEnded(timeoutMs: number): Promise<string | null> {
      if (endedReason !== null) return endedReason;
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), timeoutMs);
        endedCb = (reason) => {
          clearTimeout(timer);
          resolve(reason);
        };
      });
    },
  };
}

/** Judge-sim finding 2026-09-11 (docs/JUDGE-SIM-2026-09-11.md addendum: "zero AssemblyAI
 *  socket drops occurred -- session.resume never exercised"). POSTs to the target server's
 *  env-guarded debug hook (`/api/session/:id/debug/drop-aai`, packages/server/src/http.ts --
 *  only live when that server has COUNTERSIGN_DEBUG_HOOKS=1) to force a real AssemblyAI
 *  socket drop mid-call, so the real bounded resume-on-drop path
 *  (packages/server/src/aai/session.ts's `handleUnexpectedClose`) actually runs. Never
 *  throws: a 404 (hook not enabled on that server, or the session isn't live) is a normal,
 *  reportable outcome, not a protocol error -- turnController.ts's `maybeDropAai` decides
 *  what to do with `ok: false`. */
export async function forceDropAai(baseUrl: string, sessionId: string): Promise<{ ok: boolean; status: number }> {
  const url = `${trimTrailingSlash(baseUrl)}/api/session/${sessionId}/debug/drop-aai`;
  try {
    const res = await fetch(url, { method: 'POST' });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

/** GET /api/session/<id>/diagnostics. Returns null (not a throw) on any failure -- a missing
 *  flight recorder bundle is worth reporting, not worth failing the whole run over. */
export async function fetchDiagnostics(baseUrl: string, sessionId: string): Promise<RehearseDiagnosticBundle | null> {
  const url = `${trimTrailingSlash(baseUrl)}/api/session/${sessionId}/diagnostics`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as RehearseDiagnosticBundle;
  } catch {
    return null;
  }
}
