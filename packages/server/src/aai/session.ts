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
import {
  buildInitialSessionUpdate,
  buildAgentBindUpdate,
  buildPostBindSessionUpdate,
  resolveVoice,
  type AaiSessionConfig,
  type TurnDetectionMode,
} from './config.js';

const WS_URL = 'wss://agents.assemblyai.com/v1/ws';
const RESUME_WINDOW_MS = 30_000;
const READY_TIMEOUT_MS = 15_000;
const OPEN_TIMEOUT_MS = 8_000;
const MAX_RESUME_ATTEMPTS = 3;
const RESUME_BACKOFF_MS = [500, 1_500, 3_000];
/** Defect 2 fix (timing-analysis.md §E, PROVEN: `billed_seconds` null on 11/11 live
 *  bundles): how long `RealAaiSocket.close()` waits for AssemblyAI's own Termination
 *  event (`session.ended`, carrying `session_duration_seconds`/`audio_duration_seconds`
 *  per https://www.assemblyai.com/docs/voice-agents/voice-agent-api/events-reference,
 *  quoted in `mapServerEvent` below) before tearing down the underlying socket itself.
 *  Close used to send `session.end` and call `ws.close()` in the same tick, so that
 *  event -- even if AssemblyAI does send one back -- could never arrive in time to be
 *  read. This does NOT change when the CALL itself finishes for the browser/caps side:
 *  `call/session.ts`'s `end()` still calls `aai.close()` and immediately emits `ended` to
 *  the browser on the same schedule as before -- this wait runs in the background on the
 *  AAI leg only. */
const CLOSE_TERMINATION_TIMEOUT_MS = 2_000;

/** The slice of `ws`'s WebSocket (and the browser WebSocket API's EventEmitter-style `.on`)
 *  this adapter needs -- kept minimal and dependency-shaped so tests can supply a scripted
 *  fake with no real socket, no real network (LAW: tests never call the live API). */
export interface WsLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'open' | 'message' | 'close' | 'error', listener: (...args: unknown[]) => void): void;
  /** Debug-hook support only (`RealAaiSocket.debugForceDrop`, below): an abrupt, no-
   *  closing-handshake teardown -- what the real `ws` package's `WebSocket#terminate()`
   *  does, and what actually produces an unsolicited close on the wire (code 1006,
   *  "abnormal closure") the way a real dropped connection does, as opposed to `close()`'s
   *  polite handshake. Optional: test fakes that never exercise the debug hook need not
   *  implement it. */
  terminate?(): void;
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
  /** TURN-DETECTION-ENV-SWITCH (2026-09-19, build lane): controls whether the initial
   *  session.update includes a turn_detection key. See aai/config.ts's TurnDetectionMode
   *  and buildInitialSessionUpdate docs. Defaults to 'omit' if not provided. */
  turn_detection_mode?: TurnDetectionMode;
  /** Flight recorder bug fix (2026-09-03, founder-observed live): a real call's server-side
   *  diagnostics bundle can never answer "when did AssemblyAI become ready" -- `connectAai`
   *  consumes the `session.ready` message itself while resolving (below), before the
   *  `RealAaiSocket` (and therefore `call/session.ts`'s own event dispatch) exists, so no
   *  `session.ready` AaiEvent is ever emitted for the real adapter. Called at most once, the
   *  moment `session.ready` actually arrives, with the elapsed ms since this `connectAai`
   *  call started (mint + open + handshake) -- index.ts wires this straight into the
   *  diagnostics bundle. Optional so every existing test/caller that doesn't pass it sees no
   *  behavior change.
   *  Founder ruling 2026-09-11: also carries `greeting_configured` (whether `cfg.greeting`
   *  was set on THIS connect's initial session.update) so the flight recorder's raw bundle
   *  can prove, after the fact, whether a live call actually asked AssemblyAI to speak
   *  first -- see `aai_ready`'s detail in index.ts.
   *  TURN-DETECTION-RESTORE-EXPLICIT-CONFIG (2026-09-19): also carries `turn_detection_sent`
   *  -- the exact `input.turn_detection` object this connect's initial session.update
   *  actually put on the wire (read back off the built message itself, never recomputed) --
   *  so a bundle proves what was sent without guessing from the code that built it. See
   *  aai/config.ts's `buildInitialSessionUpdate` doc comment for what belongs in it. In
   *  TURN-DETECTION-ENV-SWITCH (2026-09-19), this is `null` in omit mode when no override
   *  was set (no turn_detection key was sent). */
  onReady?: (
    ms_since_connect_start: number,
    greeting_configured: boolean,
    turn_detection_sent: Record<string, unknown> | null
  ) => void;
  /** Defect 2 fix: tests shrink `CLOSE_TERMINATION_TIMEOUT_MS` (2000ms in production) so a
   *  test proving the timeout path doesn't have to actually wait 2 real seconds -- same
   *  role as `openTimeoutMs` above for the connect-side open wait. */
  closeTerminationTimeoutMs?: number;
  /** Defect 2 fix: called once, only when `close()`'s wait for AssemblyAI's own
   *  `session.ended` Termination event runs out without one arriving -- the seam a caller
   *  (index.ts, same pattern as `onReady` above) wires into the flight recorder as an
   *  `aai_terminate_timeout` diagnostic, so a bundle can show the billing message never
   *  came back in time rather than silently having no `billed_seconds` with no explanation.
   *  Never called when `session.ended` DOES arrive within the window (that AaiEvent, with
   *  its duration fields if present, is emitted to `on()` handlers normally instead --
   *  `call/session.ts`'s existing `case 'session.ended'` already turns a numeric
   *  `session_duration_seconds` into the `aai_session_terminated` diag that feeds
   *  `populateBilledSeconds`). Optional so every existing test/caller that doesn't pass it
   *  sees no behavior change. */
  onCloseTimeout?: () => void;
  /** Defect 2 fix (2026-09-15): called every time a raw `session.ended` (or any
   *  termination-shaped) message arrives from AssemblyAI -- before it is mapped to an
   *  AaiEvent. The callback receives the parsed message's top-level keys and any numeric
   *  fields, so a caller (index.ts, same pattern as `onReady` above) can record an
   *  `aai_session_ended_raw` diagnostic proving exactly what AssemblyAI sent for billing
   *  (or proving it sent nothing), without exposing transcript text or audio data. Called
   *  for every session.ended, whether it carries billing fields or not, and whether a
   *  close() is currently waiting on it or not. Optional so every existing test/caller
   *  that doesn't pass it sees no behavior change. */
  onSessionEnded?: (msg: Record<string, unknown>) => void;
  /** aai-observability lane (2026-09-16, dead-transcript investigation finding 1
   *  continued): same pattern as `onSessionEnded` just above -- called from `wire()`'s null
   *  branch (below) every time a server message arrives that `mapServerEvent` does not
   *  model, other than `transcript.agent.delta` (see `AaiSocket.onAgentTranscriptDelta`'s
   *  own doc comment in `types.ts` for why that one type is excluded here and given its own
   *  channel instead). This deps-level hook is the seam a test drives directly against the
   *  real adapter (`aai-session.test.ts`), independent of `CallSession` -- production
   *  (`index.ts`) does not need to wire it at all to get live behavior, because the actual
   *  channel `CallSession` subscribes through is `RealAaiSocket.onUnhandledMessage` (the
   *  `AaiSocket` interface method, called from this same `wire()` branch below);
   *  `PendingAaiSocket` relays THAT method the same way it already relays `on()`. Optional
   *  so every existing test/caller that doesn't pass it sees no behavior change. */
  onUnhandledMessage?: (type: string, detail: string) => void;
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

/** Set of message types that are known but not modeled (aai-observability lane, 2026-09-16,
 *  dead-transcript investigation finding 2: session.updated and transcript.user.delta are
 *  routine and do not indicate unmodeled server messages this adapter should surface).
 *  `session.updated` is the acknowledgement of our session.update (6-12 per call).
 *  `transcript.user.delta` is the user-side streaming text delta (~20-40 per call). Both
 *  must not increment the unknown_events counter or fire the unhandled-message hook, but
 *  each must appear once per type in the end-of-session summary with `ignored: true` flag. */
const KNOWN_IGNORED_TYPES = new Set<string>(['session.updated', 'transcript.user.delta']);

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
    case 'session.ended': {
      // AssemblyAI Termination event (session.ended type) carries billing duration.
      // VERIFY-AT-BUILD PROVEN: https://www.assemblyai.com/docs/voice-agents/voice-agent-api/events-reference
      // Fields: session_duration_seconds (number), audio_duration_seconds (number), timestamp (number)
      const result: { type: 'session.ended'; session_duration_seconds?: number; audio_duration_seconds?: number } = {
        type: 'session.ended',
      };
      if (typeof msg.session_duration_seconds === 'number') {
        result.session_duration_seconds = msg.session_duration_seconds;
      }
      if (typeof msg.audio_duration_seconds === 'number') {
        result.audio_duration_seconds = msg.audio_duration_seconds;
      }
      return result;
    }
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
  /** aai-observability lane (2026-09-16, finding 2): count of known-but-ignored message
   *  types per type name (session.updated, transcript.user.delta). These do NOT increment
   *  `unknownEventCount` or fire the unhandled-message hook, but must appear in the
   *  end-of-session summary with `ignored: true` flag. */
  private readonly ignoredEventCounts = new Map<string, number>();
  /** aai-observability lane (2026-09-16): subscribers for `AaiSocket.onUnhandledMessage`
   *  (every unmodelled message except `transcript.agent.delta`) and
   *  `AaiSocket.onAgentTranscriptDelta` (that one type, separately) -- see both methods'
   *  own doc comments in `types.ts`. Populated by `onUnhandledMessage`/
   *  `onAgentTranscriptDelta` below, read by `wire()`'s null branch. */
  private unhandledHandlers: ((type: string, detail: string) => void)[] = [];
  private agentDeltaHandlers: ((reply_id: string, delta: string) => void)[] = [];
  /** Defect 2 fix: set by `close()` while it's waiting for AssemblyAI's own
   *  `session.ended` to arrive, cleared (and called) either by that message showing up
   *  (`wire()`'s message handler, below) or by the timeout in `close()` itself -- whichever
   *  happens first. `null` whenever no close is in flight, so a `session.ended` that
   *  arrives for any OTHER reason (AssemblyAI ending the call on its own, before we ever
   *  called close()) does not spuriously resolve anything. */
  private pendingTerminationResolve: (() => void) | null = null;

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
        const rawType = typeof msg.type === 'string' ? msg.type : 'unknown';
        // aai-observability lane (2026-09-16): surface WHAT was dropped, not just that
        // something was -- `transcript.agent.delta` (PROVEN fields, docs/aai-docs-check-
        // 2026-09-01.md line 85: reply_id, item_id, delta, start_ms, end_ms) gets its own
        // dedicated, aggregated channel (see `onAgentTranscriptDelta`'s own doc comment for
        // why) and does not increment the unknown counter.
        if (rawType === 'transcript.agent.delta') {
          const replyId = typeof msg.reply_id === 'string' ? msg.reply_id : 'unknown';
          const delta = typeof msg.delta === 'string' ? msg.delta : '';
          for (const h of this.agentDeltaHandlers) h(replyId, delta);
          return;
        }
        // aai-observability lane (2026-09-16, finding 2): session.updated and
        // transcript.user.delta are known-ignored types that must not increment the
        // unknown counter or fire the unhandled-message hook, but must appear in the
        // end-of-session summary with ignored: true.
        if (KNOWN_IGNORED_TYPES.has(rawType)) {
          const count = (this.ignoredEventCounts.get(rawType) ?? 0) + 1;
          this.ignoredEventCounts.set(rawType, count);
          return;
        }
        this.unknownEventCount += 1;
        let detail: string;
        try {
          detail = JSON.stringify(msg).slice(0, 200);
        } catch {
          detail = '<unserializable>';
        }
        this.deps.onUnhandledMessage?.(rawType, detail);
        for (const h of this.unhandledHandlers) h(rawType, detail);
        return;
      }
      this.emit(evt);
      // Defect 2 fix: record the raw session.ended message (top-level keys and numeric
      // fields only, no transcript/audio) for diagnostic proof of what AssemblyAI sent.
      if (msg.type === 'session.ended') {
        this.deps.onSessionEnded?.(msg);
      }
      // Defect 2 fix: a `session.ended` arriving while `close()` is waiting on one is
      // exactly what it's waiting for -- resolve early (still emitted to handlers above
      // like any other event first, so `call/session.ts`'s own `aai_session_terminated`
      // diag still gets whatever billing fields this message carried).
      if (evt.type === 'session.ended' && this.pendingTerminationResolve) {
        this.pendingTerminationResolve();
      }
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

  /** Rehearsal-harness debug hook (aai/types.ts's `debugForceDrop` doc comment has the full
   *  reasoning): terminates the underlying socket WITHOUT setting `expectClose`, so
   *  `wire()`'s own `ws.on('close', ...)` handler treats it exactly like a real unsolicited
   *  drop and runs `handleUnexpectedClose()` -- the same bounded resume-on-drop path a real
   *  network blip takes. Never reachable except through the env-guarded debug route
   *  (`COUNTERSIGN_DEBUG_HOOKS=1`, http.ts). Returns false if there's nothing live to drop
   *  (already closed, or this `WsLike` has no `terminate()` -- every real production socket
   *  does; only a minimal test fake might not). */
  debugForceDrop(): boolean {
    if (this.closed || !this.ws.terminate) return false;
    this.ws.terminate();
    return true;
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

  /** aai-observability lane (2026-09-16, finding 2): visibility into known-ignored message
   *  types (session.updated, transcript.user.delta) so CallSession can include them in the
   *  end-of-session summary with ignored: true flag. */
  ignoredEventStats(): Map<string, number> {
    return this.ignoredEventCounts;
  }

  /** aai-observability lane (2026-09-16): see `AaiSocket.onUnhandledMessage`'s doc comment
   *  in `types.ts` -- registers a handler invoked from `wire()`'s null branch for every
   *  unmodelled message except `transcript.agent.delta`. */
  onUnhandledMessage(handler: (type: string, detail: string) => void): void {
    this.unhandledHandlers.push(handler);
  }

  /** aai-observability lane (2026-09-16): see `AaiSocket.onAgentTranscriptDelta`'s doc
   *  comment in `types.ts` -- registers a handler invoked from `wire()`'s null branch for
   *  every `transcript.agent.delta` chunk. */
  onAgentTranscriptDelta(handler: (reply_id: string, delta: string) => void): void {
    this.agentDeltaHandlers.push(handler);
  }

  /** Defect 2 fix (timing-analysis.md §E): used to send `session.end` and call
   *  `ws.close()` in the same synchronous tick, so AssemblyAI's own Termination event
   *  (`session.ended`, carrying the billing durations) could never arrive in time to be
   *  read -- PROVEN null `billed_seconds` on 11/11 live bundles. Now: send `session.end`,
   *  then wait up to `CLOSE_TERMINATION_TIMEOUT_MS` for `session.ended` to come back
   *  (resolving early via `pendingTerminationResolve`, wired in `wire()`'s message handler
   *  above), THEN close the socket -- on timeout, close anyway and report
   *  `deps.onCloseTimeout` rather than hang. Stays synchronous/non-blocking from the
   *  caller's own point of view (no `Promise` returned, same signature as before): the
   *  `AaiSocket` interface's `close(): void` is unchanged, and `call/session.ts`'s `end()`
   *  keeps ending the call -- emitting `ended` to the browser, closing that socket --
   *  immediately, on exactly its existing schedule; only the underlying AAI transport
   *  socket itself stays open a little longer in the background. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.expectClose = true;
    try {
      this.ws.send(JSON.stringify({ type: 'session.end' }));
    } catch {
      // socket already gone -- nothing to tell it, and nothing to wait for either.
      this.finishClose();
      return;
    }
    this.awaitTerminationThenClose();
  }

  private awaitTerminationThenClose(): void {
    const timeoutMs = this.deps.closeTerminationTimeoutMs ?? CLOSE_TERMINATION_TIMEOUT_MS;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      this.pendingTerminationResolve = null;
      this.deps.onCloseTimeout?.();
      this.finishClose();
    }, timeoutMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.pendingTerminationResolve = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      this.pendingTerminationResolve = null;
      this.finishClose();
    };
  }

  private finishClose(): void {
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

  const turn_detection_mode = deps.turn_detection_mode ?? 'omit';
  const initialUpdate = buildInitialSessionUpdate(effectiveCfg, turn_detection_mode);
  ws.send(JSON.stringify(initialUpdate));
  // TURN-DETECTION-RESTORE-EXPLICIT-CONFIG (2026-09-19) + TURN-DETECTION-ENV-SWITCH (2026-09-19):
  // read the turn_detection object back off the message actually sent, rather than recomputing
  // the same defaulting logic here a second time -- one source of truth for what's on the wire.
  // In omit mode with no override, this is null (the key was not sent).
  const turnDetectionSent =
    ((initialUpdate.session.input as Record<string, unknown> | undefined)?.turn_detection as
      | Record<string, unknown>
      | undefined) ?? null;

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
        deps.onReady?.(deps.now() - connectStartedAt, Boolean(effectiveCfg.greeting), turnDetectionSent);
        resolve(new RealAaiSocket(ws, msg.session_id, effectiveCfg, deps));
      } else if (msg.type === 'session.error') {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`aai session.error before ready: ${String(msg.code)} ${String(msg.message)}`));
      }
    });
  });
}

// ONE-BRAIN LIVE PATH (2026-09-22, docs/plans/2026-09-22-one-brain-live-path.md §1/§4, Lane
// D). Additive: `connectAai` above is completely untouched by this addition -- every line of
// it, and every helper it calls (`openSocket`, `parseMessage`, `mintToken`), is byte-for-byte
// the same as before this lane started. `connectAaiEndpoint` is a SEPARATE entry point,
// reached only from `index.ts`'s `createAai` when `COUNTERSIGN_BRAIN=endpoint` and the
// boot-time stored-agent bootstrap (aai/agent.ts's `ensureBrainAgent`) has already resolved
// an agent id for this process.

export interface AaiEndpointBindOpts {
  /** The ONE stored agent id for this whole process (aai/agent.ts's `ensureBrainAgent`,
   *  called once at boot in index.ts -- never per call). */
  agentId: string;
  /** This call's own per-call correlation token (brain/registry.ts's
   *  `generateCallToken()`), generated and registered by `ws/browser.ts` BEFORE this connect
   *  starts, embedded in the post-bind `system_prompt` below so `/api/brain/chat/completions`
   *  can route every request for this call back to its own `CallSession` (plan §1). */
  callToken: string;
  /** Proper-nouns-only keyterms for this call -- `index.ts` passes `aai/config.ts`'s
   *  `BRAIN_KEYTERMS` in production; a test may supply its own fixed list. */
  keyterms: string[];
}

/** Connects and binds to the ONE stored agent instead of sending today's inline
 *  `buildInitialSessionUpdate` -- PROVEN two-step handshake (gate-results.json G0/G0B): first
 *  `session.update{agent_id}` (mutually exclusive with any inline session field -- see
 *  `buildAgentBindUpdate`'s own doc comment), wait for `session.ready`, THEN a second
 *  `session.update` (`buildPostBindSessionUpdate`) carrying this call's token marker,
 *  keyterms, and `input.transcription_mode: 'max_accuracy'`. Resolves once `session.ready`
 *  arrives and the post-bind update has been sent (or rejects on `session.error` / a connect
 *  failure / timeout) -- same resolve/reject contract as `connectAai` above.
 *
 *  Resume-on-drop is shared, unmodified, with the legacy path: the returned `AaiSocket` is
 *  the SAME `RealAaiSocket` class `connectAai` constructs, and its
 *  `handleUnexpectedClose`/resume logic only ever sends a bare `{type:'session.resume',
 *  session_id}` on a fresh socket -- never re-sends either bind step, a stored-agent bind, or
 *  any inline field -- so sharing one resume implementation between both connect paths is
 *  safe by construction: AssemblyAI's own resumed session already remembers which stored
 *  agent (if any) it was bound to. */
export async function connectAaiEndpoint(cfg: AaiSessionConfig, bind: AaiEndpointBindOpts, deps: AaiConnectDeps): Promise<AaiSocket> {
  const connectStartedAt = deps.now();
  const { token } = await mintToken(cfg, deps.fetchImpl);
  const ws = await openSocket(deps.WebSocketImpl, token, deps.openTimeoutMs ?? OPEN_TIMEOUT_MS);

  ws.send(JSON.stringify(buildAgentBindUpdate(bind.agentId)));

  return new Promise<AaiSocket>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('connectAaiEndpoint: timed out waiting for session.ready'));
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
        // Second step of the bind handshake (plan §4, G0B PROVEN) -- sent the instant
        // session.ready acks the bind, before this promise resolves, so no caller turn can
        // ever reach AssemblyAI's automatic reply (and therefore our own endpoint) before
        // the token marker is live in system_prompt.
        ws.send(JSON.stringify(buildPostBindSessionUpdate({ token: bind.callToken, keyterms: bind.keyterms })));
        // `greeting_configured: true` -- the greeting is set on the stored agent itself
        // (aai/agent.ts), not on this connection's own session.update, but it IS configured
        // for this call either way. `turn_detection_sent: null` -- endpoint mode's post-bind
        // update never carries a turn_detection key at all (see
        // `buildPostBindSessionUpdate`'s own doc comment).
        deps.onReady?.(deps.now() - connectStartedAt, true, null);
        resolve(new RealAaiSocket(ws, msg.session_id, cfg, deps));
      } else if (msg.type === 'session.error') {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`aai session.error before ready (endpoint bind): ${String(msg.code)} ${String(msg.message)}`));
      }
    });
  });
}
