// packages/server/src/aai/session.ts
// The real AssemblyAI Voice Agent adapter: mints a token, opens
// wss://agents.assemblyai.com/v1/ws, sends the initial session.update, waits for
// session.ready, then maps every server event onto the same `AaiSocket` interface
// `call/session.ts` already knows from `FakeAaiSocket` (S2) -- CallSession never knows
// which one it is holding. Also owns resume-on-drop, BOUNDED: an unexpected close re-mints
// a token, opens a new socket, and sends session.resume -- up to MAX_RESUME_ATTEMPTS times
// total for the life of the call (not reset between drops), each attempt backed off and
// each still constrained to AssemblyAI's 30s resumable window measured from that drop.
// Exhausting attempts, missing the window, or having no session_id to resume against all
// give up rather than retry forever, surfaced to the call layer as `link` AaiEvents
// (lost/restored, each carrying which attempt) so the screen can show "voice link lost,
// security state preserved" (nothing here re-derives a verdict; that stays the engine's
// job, replayed from the logs call/session.ts already owns).
//
// VERIFY-AT-BUILD facts this file codes to (docs/aai-verify-2026-09-02.md, quoted there):
//  Q1 tools/system_prompt/keyterms/turn_detection are mutable mid-call; voice, output
//     encoding and greeting are NOT (immutable_field if resent) -- config.ts sets those
//     three only in the FIRST session.update, never again.
//  Q3 input.audio carries base64 in `audio`; chunk size doesn't matter (~50ms preferred) --
//     send() forwards whatever call/session.ts already framed, verbatim.
//  Q4 session.resume is `{type:'session.resume', session_id}` on a NEW socket with a NEW
//     token, within 30s of the drop.
//  Q5 llm selection (when configured) is `llm: [{base_url, model, api_key}]` -- built in
//     config.ts, not here.
import { mintToken } from '../token.js';
import type { AaiEvent, AaiSocket } from './types.js';
import { buildInitialSessionUpdate, resolveVoice, type AaiSessionConfig } from './config.js';

const WS_URL = 'wss://agents.assemblyai.com/v1/ws';
const RESUME_WINDOW_MS = 30_000;
const READY_TIMEOUT_MS = 15_000;
const OPEN_TIMEOUT_MS = 8_000;
const MAX_RESUME_ATTEMPTS = 3;
const RESUME_BACKOFF_MS = [500, 1_500, 3_000];

/** The slice of `ws`'s WebSocket (and the browser WebSocket API's EventEmitter-style `.on`)
 *  this adapter needs -- kept minimal and dependency-shaped so tests can supply a scripted
 *  fake with no real socket, no real network (LAW: tests never call the live API). */
export interface WsLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'open' | 'message' | 'close' | 'error', listener: (...args: unknown[]) => void): void;
}

export interface AaiConnectDeps {
  fetchImpl: typeof fetch;
  WebSocketImpl: new (url: string) => WsLike;
  now: () => number;
  /** Defaults to a real setTimeout-based delay. Tests inject a fast/no-op version so the
   *  bounded resume backoff (500ms/1500ms/3000ms) doesn't slow the suite down. */
  sleep?: (ms: number) => Promise<void>;
  /** Defaults to OPEN_TIMEOUT_MS. Tests shrink this to exercise a never-opening socket
   *  without a slow real wait. */
  openTimeoutMs?: number;
  /** Flight recorder bug fix (2026-09-03, founder-observed live): a real call's server-side
   *  diagnostics bundle can never answer "when did AssemblyAI become ready" -- `connectAai`
   *  consumes the `session.ready` message itself while resolving (below), before the
   *  `RealAaiSocket` (and therefore `call/session.ts`'s own event dispatch) exists, so no
   *  `session.ready` AaiEvent is ever emitted for the real adapter. Called at most once, the
   *  moment `session.ready` actually arrives, with the elapsed ms since this `connectAai`
   *  call started (mint + open + handshake) -- index.ts wires this straight into the
   *  diagnostics bundle. Optional so every existing test/caller that doesn't pass it sees no
   *  behavior change. */
  onReady?: (ms_since_connect_start: number) => void;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as unknown as { unref?: () => void }).unref?.();
  });
}

function openSocket(WebSocketImpl: new (url: string) => WsLike, token: string, timeoutMs: number): Promise<WsLike> {
  const ws = new WebSocketImpl(`${WS_URL}?token=${token}`);
  return new Promise<WsLike>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('openSocket: timed out waiting for open')), timeoutMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    ws.on('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

function parseMessage(data: unknown): Record<string, unknown> | null {
  try {
    const text = typeof data === 'string' ? data : String(data);
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Maps one already-parsed server message to an AaiEvent, or null for anything this adapter
 *  does not model (session.updated, the transcript.*.delta streaming events, and any future
 *  event type AssemblyAI adds) -- unknown types are ignored, never thrown on. */
function mapServerEvent(msg: Record<string, unknown>): AaiEvent | null {
  switch (msg.type) {
    case 'session.ready':
      return { type: 'session.ready', session_id: String(msg.session_id) };
    case 'transcript.user':
      return { type: 'transcript.user', item_id: String(msg.item_id), text: String(msg.text) };
    case 'transcript.agent':
      return {
        type: 'transcript.agent',
        item_id: String(msg.item_id),
        text: String(msg.text),
        reply_id: String(msg.reply_id),
        interrupted: Boolean(msg.interrupted),
      };
    case 'reply.started':
      return { type: 'reply.started', reply_id: String(msg.reply_id) };
    case 'reply.audio':
      return { type: 'reply.audio', data: String(msg.data) };
    case 'reply.done':
      return { type: 'reply.done', reply_id: String(msg.reply_id), status: String(msg.status) };
    case 'input.speech.started':
      return { type: 'input.speech.started' };
    case 'input.speech.stopped':
      return { type: 'input.speech.stopped' };
    case 'tool.call':
      return {
        type: 'tool.call',
        call_id: String(msg.call_id),
        name: String(msg.name),
        arguments: (msg.arguments as Record<string, unknown>) ?? {},
      };
    case 'session.error':
      return { type: 'session.error', code: String(msg.code), message: String(msg.message) };
    case 'session.ended':
      return { type: 'session.ended' };
    default:
      return null;
  }
}

class RealAaiSocket implements AaiSocket {
  private handlers: ((evt: AaiEvent) => void)[] = [];
  private ws: WsLike;
  private sessionId: string | null;
  private closed = false;
  /** Set true only by our own close() -- distinguishes "we hung up" from "the transport
   *  dropped", so ending a call normally never triggers a resume attempt. */
  private expectClose = false;
  /** Total resume attempts made over the LIFE of this call (not reset between drops) --
   *  the bound that stops a flaky connection from retrying forever. */
  private resumeAttempts = 0;
  /** Server messages whose type this adapter does not model -- never used for control
   *  flow, kept only so a caller (e.g. the live smoke script) can report it if useful. */
  unknownEventCount = 0;

  constructor(
    ws: WsLike,
    sessionId: string,
    private readonly cfg: AaiSessionConfig,
    private readonly deps: AaiConnectDeps
  ) {
    this.ws = ws;
    this.sessionId = sessionId;
    this.wire(ws);
  }

  private wire(ws: WsLike): void {
    ws.on('message', (data) => {
      const msg = parseMessage(data);
      if (!msg) return;
      if (msg.type === 'session.ready' && typeof msg.session_id === 'string') {
        this.sessionId = msg.session_id;
      }
      const evt = mapServerEvent(msg);
      if (!evt) {
        this.unknownEventCount += 1;
        return;
      }
      this.emit(evt);
    });
    ws.on('close', () => {
      if (this.closed || this.expectClose) return;
      void this.handleUnexpectedClose();
    });
    ws.on('error', () => {
      // A transport error surfaces as a close on real sockets; resume is driven from
      // there, not duplicated here.
    });
  }

  private emit(evt: AaiEvent): void {
    for (const h of this.handlers) h(evt);
  }

  /** Bounded resume: up to MAX_RESUME_ATTEMPTS total for the call's life (not per drop --
   *  a flapping connection cannot retry forever), each attempt backed off, each still
   *  constrained to AssemblyAI's 30s resumable window measured from THIS drop. Gives up
   *  (emits `session.ended`) once attempts are exhausted, the window has passed, or there
   *  is no session_id to resume against -- never loops indefinitely. */
  private async handleUnexpectedClose(): Promise<void> {
    const droppedAt = this.deps.now();
    const sleep = this.deps.sleep ?? defaultSleep;
    const openTimeoutMs = this.deps.openTimeoutMs ?? OPEN_TIMEOUT_MS;

    while (this.resumeAttempts < MAX_RESUME_ATTEMPTS) {
      this.resumeAttempts += 1;
      const attempt = this.resumeAttempts;
      this.emit({ type: 'link', state: 'lost', attempt });
      if (this.closed) return;

      const sessionId = this.sessionId;
      if (!sessionId) break; // never got a session_id from this connection -- nothing to resume against
      if (this.deps.now() - droppedAt > RESUME_WINDOW_MS) break; // past the resumable window already

      await sleep(RESUME_BACKOFF_MS[attempt - 1] ?? RESUME_BACKOFF_MS[RESUME_BACKOFF_MS.length - 1]!);
      if (this.closed) return;
      if (this.deps.now() - droppedAt > RESUME_WINDOW_MS) break; // window passed during backoff

      try {
        const { token } = await mintToken(this.cfg, this.deps.fetchImpl);
        if (this.closed) return;
        if (this.deps.now() - droppedAt > RESUME_WINDOW_MS) break; // window passed during mint

        const ws = await openSocket(this.deps.WebSocketImpl, token, openTimeoutMs);
        if (this.closed) {
          ws.close();
          return;
        }
        ws.send(JSON.stringify({ type: 'session.resume', session_id: sessionId }));
        this.ws = ws;
        this.wire(ws);
        this.emit({ type: 'link', state: 'restored', attempt });
        return; // success -- stop retrying
      } catch {
        // this attempt failed -- the loop continues, still bounded by resumeAttempts/MAX
      }
    }

    // Attempts exhausted, the window passed, or nothing to resume against: give up rather
    // than retry forever. The last `link:'lost'` event already emitted (or the absence of
    // one, on a 4th+ drop past the cap) plus this session.ended are the record of what
    // happened; nothing here re-derives a verdict -- that stays call/session.ts + the engine.
    if (!this.closed) {
      this.closed = true;
      // Round 3 (S3 re-review): `reason: 'link_lost'` distinguishes a give-up here from a
      // real AssemblyAI-originated session.ended (mapServerEvent never sets a reason) --
      // call/session.ts maps this into its own `end(reason)` so the browser's `ended`
      // event carries `link_lost` instead of the generic `aai_ended`.
      this.emit({ type: 'session.ended', reason: 'link_lost' });
    }
  }

  send(msg: object): void {
    if (this.closed) return;
    this.ws.send(JSON.stringify(msg));
  }

  on(handler: (evt: AaiEvent) => void): void {
    this.handlers.push(handler);
  }

  /** Round 3 (S3 re-review): visibility into unmodeled server messages (see the `default`
   *  branch of `mapServerEvent`) -- never used for control flow, so exposing it costs
   *  nothing and lets the live smoke script (or any future ops surface) report it. */
  stats(): { unknown_events: number } {
    return { unknown_events: this.unknownEventCount };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.expectClose = true;
    try {
      this.ws.send(JSON.stringify({ type: 'session.end' }));
    } catch {
      // socket already gone -- nothing to tell it
    }
    try {
      this.ws.close();
    } catch {
      // already closed
    }
  }
}

/** Mints a token, connects, sends the initial session.update, and resolves once
 *  session.ready arrives (or rejects on session.error / a connect failure / timeout). The
 *  returned AaiSocket owns resume-on-drop for the rest of the call's life. */
export async function connectAai(cfg: AaiSessionConfig, deps: AaiConnectDeps): Promise<AaiSocket> {
  const connectStartedAt = deps.now();
  const { token } = await mintToken(cfg, deps.fetchImpl);
  const voice = resolveVoice(cfg.voice);
  const effectiveCfg: AaiSessionConfig = voice === cfg.voice ? cfg : { ...cfg, voice };
  const ws = await openSocket(deps.WebSocketImpl, token, deps.openTimeoutMs ?? OPEN_TIMEOUT_MS);

  ws.send(JSON.stringify(buildInitialSessionUpdate(effectiveCfg)));

  return new Promise<AaiSocket>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('connectAai: timed out waiting for session.ready'));
    }, READY_TIMEOUT_MS);
    (timeout as unknown as { unref?: () => void }).unref?.();

    let settled = false;
    ws.on('message', function onFirstMessage(data) {
      if (settled) return;
      const msg = parseMessage(data);
      if (!msg) return;
      if (msg.type === 'session.ready' && typeof msg.session_id === 'string') {
        settled = true;
        clearTimeout(timeout);
        deps.onReady?.(deps.now() - connectStartedAt);
        resolve(new RealAaiSocket(ws, msg.session_id, effectiveCfg, deps));
      } else if (msg.type === 'session.error') {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`aai session.error before ready: ${String(msg.code)} ${String(msg.message)}`));
      }
    });
  });
}
