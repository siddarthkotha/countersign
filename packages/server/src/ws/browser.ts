// packages/server/src/ws/browser.ts
// The browser protocol: `/ws/call/:id` (only ids `createHttpServer`'s /api/session/start
// actually minted -- an unrecognized id gets a clean 4404 close, never a live session) and
// `/ws/replay/:file` (a corpus file streamed as the same ServerEvent shape, no AAI, no
// audio, no caps session). Reuses the http.ts server for the WebSocket upgrade and the
// CapsState it returned, per the plan ("the server is the only authority" -- this file owns
// no state of its own beyond per-connection throttling).
//
// Task R1 (browser reconnect -- "voice link lost, security state preserved"): the call
// itself (the AssemblyAI session, the engine, the evidence) lives on the server and does NOT
// end just because a browser WebSocket drops. `activeCalls` (module-local to one
// `attachWebSocketServer` call) tracks one `CallEntry` per live-or-in-grace session id,
// independent of any one browser socket. On close, the entry keeps its `CallSession` running,
// swaps its delivery target to a small buffer (audio only, last ~3s), and starts a grace
// timer (`browser_grace_ms`, default 20 000). A new socket for the same id within the grace
// window reattaches to the SAME session -- `link:'restored'` first, then the latest
// ScreenState, then any buffered audio, then live events -- and cancels the timer. A second
// concurrent attach while one is already live is refused (4409): this is a reconnect
// mechanism, not multi-tenancy for one call. Grace expiry ends the session (`browser_gone`)
// and frees the caps slot, same as an explicit close always did before this task.
//
// CRITICAL 1 (final review): caps used to be decoupled from live calls -- `/end`/`/reset`
// only touched `CapsState`, never the live `CallSession`+AAI socket; the idle reaper's
// results were discarded; and there was no per-call cap timer at all. `attachWebSocketServer`
// now returns `{ endCall }`: the ONE place that actually ends a live call (session, AAI
// socket, browser socket) and frees its caps slot together, used by http.ts's `/end`/`/reset`,
// index.ts's idle reaper, and this file's own per-call cap timer (started on first attach,
// cleared on end).
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { MERIDIAN, mockToolResult } from '@countersign/engine';
import type { BrowserEvent, CallContext, SeedConfig, ServerEvent } from '@countersign/engine';
import { endSession, personaFor, touch, type CapsState } from '../caps.js';
import { createBundle, endBundle, recordServerEvent, summarizeBundle, populateBilledSeconds, type DiagnosticsState } from '../diagnostics.js';
import type { AaiSocket } from '../aai/types.js';
import type { ServerConfig } from '../config.js';
import { CallSession } from '../call/session.js';
import { isAllowedOrigin } from '../origin.js';
import { callContextForPersona } from '../personas.js';
import { defaultCorpusDir, loadCorpusFile, runReplay } from '../replay.js';
import { makeThrottle, THROTTLE_WINDOW_MS } from './throttle.js';

/** Matches config.ts's own `COUNTERSIGN_BROWSER_GRACE_MS` default -- kept as a local literal
 *  rather than importing ServerConfig here so `BrowserWsDeps.browser_grace_ms` stays a plain
 *  optional (deps-only) knob, same shape as `seed`/`corpusDir`/`buildCallContext` above it.
 *  index.ts is free to thread `cfg.browser_grace_ms` through later; until it does, every
 *  caller (including production) gets the documented default. */
const DEFAULT_BROWSER_GRACE_MS = 20000;

/** Matches config.ts's `COUNTERSIGN_SESSION_CAP_SECONDS` default (300s), same reasoning as
 *  `DEFAULT_BROWSER_GRACE_MS` above -- a plain local fallback so tests/dev callers that don't
 *  thread `session_cap_seconds` through still get a sane cap instead of an unbounded call. */
const DEFAULT_SESSION_CAP_SECONDS = 300;

/** How much of the AAI's spoken reply to keep buffered (newest-first eviction) while a
 *  session is between browser sockets, so a reattach doesn't open on dead air. */
const AUDIO_BUFFER_MS = 3000;

export interface BrowserWsDeps {
  caps: CapsState;
  now: () => number;
  /** CRITICAL (task-origin-review.md): the CORS allowlist + proxy-trust bit, shared with
   *  http.ts's `applyCors` via origin.ts's `isAllowedOrigin`/`selfOrigin`. Browsers don't
   *  apply the Same-Origin Policy to WebSocket upgrades (no preflight), so this is the ONLY
   *  gate on which pages can open `/ws/call/:id` or `/ws/replay/:file` at all -- see the
   *  `server.on('upgrade', ...)` handler below. Only the two fields `isAllowedOrigin` actually
   *  reads, not the full `ServerConfig`, to match this interface's existing narrow-deps style
   *  (`seed`/`corpusDir`/`buildCallContext` above). */
  cfg: Pick<ServerConfig, 'allowed_origins' | 'trust_proxy'>;
  /** Creates the AAI connection for one call session. index.ts supplies a `FakeAaiSocket`
   *  factory under `COUNTERSIGN_FAKE_AAI=1`; the real adapter (S3) plugs in here too. */
  createAai: (session_id: string) => AaiSocket;
  /** Flight recorder (founder's ask, 2026-09-02): shared with http.ts (its GET/POST
   *  .../diagnostics routes) so both sides read/write the SAME in-memory bundles, the same
   *  way `caps` (CapsState) is shared today. A fresh bundle is created here, on the first
   *  `/ws/call/:id` attach for a session (never on a reattach) -- diagnostics.ts's own
   *  `createBundle` doc explains the ring-eviction/readability contract. */
  diagnostics: DiagnosticsState;
  seed?: SeedConfig;
  corpusDir?: string;
  /** How to build the (currently fixed, simulated) telephony context for a call. Scenario
   *  selection (Dana vs. "Robert Miller") is a later task's concern -- S2 just needs
   *  somewhere honest to put a default rather than inventing one inline. */
  buildCallContext?: (session_id: string) => CallContext;
  /** Task R1: milliseconds a call session survives a dropped browser socket before it's
   *  actually ended. Defaults to `DEFAULT_BROWSER_GRACE_MS`; tests override it to keep grace
   *  windows short instead of waiting out the real 20s default. */
  browser_grace_ms?: number;
  /** CRITICAL 1 (final review): the per-session minute cap (BRIEF abuse cap), in seconds --
   *  the same number `/api/session/start` already hands the browser for its own countdown
   *  display (`cap_seconds`). A one-shot timer started the moment a call's `CallEntry` is
   *  first created ends it with reason `cap_reached` if it's still running once this many
   *  seconds have passed, regardless of reconnects in between. Defaults to
   *  `DEFAULT_SESSION_CAP_SECONDS`; tests override it to keep the cap short. */
  session_cap_seconds?: number;
}

/** One call session's life, independent of any single browser socket. Lives in
 *  `activeCalls` from the moment a fresh `/ws/call/:id` attach creates the `CallSession`
 *  until the session actually ends (grace expiry, or the session ending itself). */
interface CallEntry {
  session: CallSession;
  /** The currently attached browser socket, or null while in the grace window between
   *  sockets. Checked on `ws.on('close')` so a stale close from a socket a reattach already
   *  replaced can never tear down the NEW socket's attachment. */
  ws: WebSocket | null;
  graceTimer: ReturnType<typeof setTimeout> | null;
  /** CRITICAL 1 (final review): one-shot, started once when the entry is first created (not
   *  reset by a reattach -- the cap bounds total call time, not any one socket's uptime),
   *  cleared the moment the call actually ends. */
  capTimer: ReturnType<typeof setTimeout> | null;
  /** Where ServerEvents actually go right now: a throttled sender to `ws` while attached, or
   *  a small buffer while detached. Swapped in place (never rebuilding CallSession's
   *  `onServerEvent`, which closes over this entry once, for the entry's whole life). */
  deliver: (e: ServerEvent) => void;
  /** The most recent `state` ServerEvent, kept even while attached -- what a reattach
   *  replays immediately, before any live event. */
  lastState: Extract<ServerEvent, { type: 'state' }> | null;
  /** Reply audio buffered while detached, oldest first, capped to `AUDIO_BUFFER_MS`. */
  audioBuffer: { data: string; t: number }[];
}

/** Bug fix (2026-09-04): this used to hardcode `unverified_voip`/`unknown` for every live
 *  call, which made the SSO check fail always (evidenceFromTools.ssoEvidence), which made
 *  STAGE structurally unreachable no matter how a caller behaved. The persona a session was
 *  minted with (`/api/session/start`, stored via caps.ts's `startSession`) now drives the
 *  simulated telemetry instead -- `personaFor` falls back to the safe `attacker` persona for
 *  a session id caps never recorded one for, same as an unknown/malformed persona at mint
 *  time. */
function defaultCallContext(session_id: string, caps: CapsState): CallContext {
  return callContextForPersona(session_id, personaFor(caps, session_id));
}

function safeSend(ws: WebSocket, msg: object): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

/** Coalesces `state` ServerEvents to at most one send per THROTTLE_WINDOW_MS (the exact
 *  leading-edge/trailing-flush/latest-wins timing lives in and is unit-tested by
 *  `./throttle.ts` with fake timers -- this wrapper just decides WHICH events go through the
 *  throttle): a burst of rapid state changes results in one send carrying the latest state,
 *  not one send per change. Every other ServerEvent type (audio, flush, ended) is
 *  timing-sensitive and always sent immediately. */
function makeThrottledSender(ws: WebSocket): (e: ServerEvent) => void {
  const sendState = makeThrottle<ServerEvent>((e) => safeSend(ws, e), THROTTLE_WINDOW_MS);

  return (e: ServerEvent) => {
    if (e.type !== 'state') {
      safeSend(ws, e);
      return;
    }
    sendState(e);
  };
}

/** While detached (grace window), only `audio` is worth keeping -- `state` is captured
 *  separately (in `entry.lastState`, updated centrally so it's current whether attached or
 *  not) and `flush`/`link`/`ended` are transient signals nobody is around to receive; the
 *  buffer's whole job is "don't open a reattach on dead air." */
function makeGraceBuffer(entry: CallEntry, now: () => number): (e: ServerEvent) => void {
  return (e: ServerEvent) => {
    if (e.type !== 'audio') return;
    const t = now();
    entry.audioBuffer.push({ data: e.data, t });
    const cutoff = t - AUDIO_BUFFER_MS;
    while (entry.audioBuffer.length > 0 && entry.audioBuffer[0]!.t < cutoff) {
      entry.audioBuffer.shift();
    }
  };
}

/** The CallSession's fixed `onServerEvent` for the entry's whole life: tracks `lastState`
 *  regardless of attachment, runs the (attached-or-detached-agnostic) cleanup a real `ended`
 *  event always needs, then hands the event to whichever `deliver` is current. */
function makeEntrySink(
  session_id: string,
  deps: BrowserWsDeps,
  activeCalls: Map<string, CallEntry>,
  entry: CallEntry,
): (e: ServerEvent) => void {
  return (e: ServerEvent) => {
    if (e.type === 'state') entry.lastState = e;
    if (e.type === 'ended') {
      if (entry.graceTimer) {
        clearTimeout(entry.graceTimer);
        entry.graceTimer = null;
      }
      // CRITICAL 1 (final review): the cap timer is one-shot for the entry's whole life --
      // a real end reached any other way (caller_ended, idle_timeout, an AAI error, the cap
      // itself firing) must still cancel it, or a stale cap timer could later call `endCall`
      // on an id `activeCalls` no longer has an entry for (harmless -- `endCall` treats that
      // as "already gone" -- but pointless).
      if (entry.capTimer) {
        clearTimeout(entry.capTimer);
        entry.capTimer = null;
      }
      activeCalls.delete(session_id);
      endSession(deps.caps, session_id);
      // Flight recorder: close out this call's DiagnosticBundle and print the ONE NDJSON
      // summary line Render's log stream carries per session end (founder's ask: "data that
      // keeps reporting back"). `endBundle` returns null only if this session_id was never
      // tracked (or the ring already evicted it) -- both harmless no-ops here.
      const bundle = endBundle(deps.diagnostics, session_id, deps.now(), e.reason);
      if (bundle) {
        // Extract billed_seconds from the aai_session_terminated event if present
        populateBilledSeconds(bundle);
        // eslint-disable-next-line no-console -- this line IS the feature: Render's log tail.
        console.log(JSON.stringify({ countersign_diag: summarizeBundle(bundle) }));
      }
    }
    // `entry.deliver` is what actually pushes `e` down the wire (a live send, or the grace
    // buffer while detached) -- do that FIRST, so a real `ended` message still reaches an
    // attached browser before its socket closes. Round 4, requirement 9 (moved here from
    // `endCall`, 2026-09-14): closing the browser socket the instant a call truly ends,
    // regardless of what ended it (idle reaper, cap timer, caller hangup, an AAI error) --
    // `entry.ws` is null whenever nothing is currently attached (already detached into the
    // grace buffer, e.g. `startGrace`'s own `browser_gone` path), so this is a no-op then.
    entry.deliver(e);
    if (e.type === 'ended' && entry.ws) {
      try {
        entry.ws.close();
      } catch {
        // already gone -- nothing to close
      }
    }
  };
}

/** Detach: the browser socket is gone but the call keeps running. Swaps delivery to the
 *  grace buffer and starts the timer that, with no reattach, actually ends the call. */
function startGrace(session_id: string, deps: BrowserWsDeps, activeCalls: Map<string, CallEntry>, entry: CallEntry): void {
  entry.ws = null;
  entry.deliver = makeGraceBuffer(entry, deps.now);
  // IMPORTANT 2 (final review): the browser<->server leg's own "lost" -- recorded on the
  // CallSession as evidence (a `link_changed` action), distinct from the AAI leg's own
  // (handleAaiEvent's own `link` case, tagged 'aai'). Nothing is sent down the wire here --
  // the socket that would carry it just closed; the browser learns about its OWN drop from
  // its own reconnect logic (src/ws/worker.ts), not a server push.
  entry.session.noteBrowserLinkChange('lost');
  const graceMs = deps.browser_grace_ms ?? DEFAULT_BROWSER_GRACE_MS;
  // Fix round 1 (minor): `entry.session.end(...)` alone is enough -- it emits `ended`, which
  // `makeEntrySink` above already routes into `activeCalls.delete` + `endSession` for us.
  // Doing both here too was dead-redundant, not a second safety net (this timer only ever
  // fires once, and `CallSession.end` is itself idempotent).
  entry.graceTimer = setTimeout(() => {
    entry.session.end('browser_gone');
  }, graceMs);
}

/** Wires message/close handling for whichever socket -- fresh or reattached -- is currently
 *  `entry.ws`. `entry.ws !== ws` in the close handler guards against a stale close firing
 *  for a socket a reattach already replaced. */
function wireSocketHandlers(ws: WebSocket, session_id: string, deps: BrowserWsDeps, activeCalls: Map<string, CallEntry>, entry: CallEntry): void {
  ws.on('message', (data) => {
    // Defect 1 fix (timing-analysis.md §C, PROVEN live case 7 / bundle 859b6d60: 90.5s of
    // dead air never tripped the 30s idle timer): this used to `touch()` on EVERY raw
    // browser->server message, including the continuous stream of `{type:'audio', ...}`
    // frames the mic sends the whole call (open-mic capture, not gated by speech
    // detection) -- so `idle_timeout_ms` measured "is the browser socket sending
    // anything," which for a live call is always true, never actual conversational
    // silence. Idle activity is now touched ONLY from `call/session.ts`'s own
    // `onActivity` hook, on the three events that actually mean someone said something:
    // the caller starting to speak (`input.speech.started`), a caller's final transcript
    // (`transcript.user`), and the agent finishing a reply (`reply.done` -- so the 30s of
    // caller silence the reaper measures starts counting after the agent stops talking,
    // not mid-question). Raw audio frames, pings, and state messages never touch it.
    let msg: BrowserEvent;
    try {
      msg = JSON.parse(data.toString()) as BrowserEvent;
    } catch {
      return;
    }
    entry.session.handleBrowser(msg);
  });

  ws.on('close', () => {
    if (entry.ws !== ws) return;
    if (entry.session.hasEnded()) {
      // The call already finished (caller_ended, an AAI error, ...) -- that `ended` event
      // already ran makeEntrySink's cleanup (activeCalls.delete + endSession) when it fired,
      // so this close is just the browser catching up to it, not a drop worth a grace window
      // or a second cleanup.
      return;
    }
    startGrace(session_id, deps, activeCalls, entry);
  });
}

/** A new socket for a session id already in `activeCalls`, still in its grace window
 *  (`entry.ws === null` -- the caller in `handleCallSocket` already refused the case where
 *  something is still attached, with 4409). Cancels the grace timer, re-attaches live
 *  delivery, and replays what the reattaching browser missed: `link:'restored'`, the latest
 *  ScreenState, then any buffered audio -- all before any new live event can arrive. */
function reattach(ws: WebSocket, session_id: string, deps: BrowserWsDeps, activeCalls: Map<string, CallEntry>, entry: CallEntry): void {
  if (entry.graceTimer) {
    clearTimeout(entry.graceTimer);
    entry.graceTimer = null;
  }
  entry.ws = ws;
  entry.deliver = makeThrottledSender(ws);
  touch(deps.caps, session_id, deps.now());
  // IMPORTANT 2 (final review): the browser<->server leg's own "restored", recorded as
  // evidence the same way `startGrace`'s "lost" is.
  entry.session.noteBrowserLinkChange('restored');

  safeSend(ws, { type: 'link', state: 'restored', leg: 'browser' });
  if (entry.lastState) safeSend(ws, entry.lastState);
  for (const frame of entry.audioBuffer) safeSend(ws, { type: 'audio', data: frame.data });
  entry.audioBuffer = [];

  wireSocketHandlers(ws, session_id, deps, activeCalls, entry);
}

function handleCallSocket(
  ws: WebSocket,
  session_id: string,
  deps: BrowserWsDeps,
  activeCalls: Map<string, CallEntry>,
  endCall: (session_id: string, reason: string) => boolean,
): void {
  const existing = activeCalls.get(session_id);
  if (existing) {
    if (existing.ws) {
      // Someone is already attached and live: this is a reconnect mechanism for ONE browser
      // at a time, not multi-tenancy for a single call.
      ws.close(4409, 'already connected');
      return;
    }
    reattach(ws, session_id, deps, activeCalls, existing);
    return;
  }

  if (!deps.caps.active.has(session_id)) {
    ws.close(4404, 'unknown session');
    return;
  }

  // Flight recorder: this is the FIRST `/ws/call/:id` attach for this session (a reattach
  // returned above, via `reattach`) -- "from the moment I start the script" starts the
  // bundle's clock right here, before the AAI connect even begins.
  createBundle(deps.diagnostics, session_id, deps.now());
  // Defect fix (2026-09-22): restart the idle clock when the browser leg first attaches,
  // so a session minted long before a judge clicks Start Call doesn't get reaped while
  // the call is still running. The idle timer is meant to measure conversational silence
  // (via onActivity in CallSession), not time since mint.
  touch(deps.caps, session_id, deps.now());
  recordServerEvent(deps.diagnostics, session_id, deps.now(), 'link', { leg: 'browser', state: 'attach' });

  const seed = deps.seed ?? MERIDIAN;
  const call = deps.buildCallContext ? deps.buildCallContext(session_id) : defaultCallContext(session_id, deps.caps);
  // Fix (2026-09-09, PROVEN live-call regression): records what this call's simulated
  // telemetry actually resolved to -- `persona` is whatever caps.ts recorded at mint time
  // (personaFor(), the same lookup defaultCallContext itself makes), `origin_kind`/
  // `origin_geo` are this call's own CallContext, whichever path built it. All three are
  // synthetic demo telemetry (BRIEF: every identity/system here is synthetic), safe to log
  // in full -- this is what lets a founder (or a rehearsal report) see, after the fact,
  // whether a live call's telemetry actually matched the persona it was minted with.
  recordServerEvent(deps.diagnostics, session_id, deps.now(), 'call_context', {
    persona: personaFor(deps.caps, session_id),
    origin_kind: call.origin_kind,
    origin_geo: call.origin_geo,
  });

  let aai: AaiSocket;
  recordServerEvent(deps.diagnostics, session_id, deps.now(), 'aai_connect_start', {});
  try {
    aai = deps.createAai(session_id);
  } catch (err) {
    recordServerEvent(deps.diagnostics, session_id, deps.now(), 'error', {
      message: err instanceof Error ? err.message : String(err),
      where: 'createAai',
    });
    endBundle(deps.diagnostics, session_id, deps.now(), 'aai_unavailable');
    ws.close(4500, 'aai unavailable');
    return;
  }

  // `entry` is referenced by `onServerEvent` below before `session` exists -- built via a
  // placeholder assigned immediately after construction, same pattern the grace/reattach
  // helpers above rely on (the entry outlives any one socket, so it can't be built from a
  // session that isn't constructed yet).
  const entry = {
    ws,
    graceTimer: null,
    capTimer: null,
    deliver: makeThrottledSender(ws),
    lastState: null,
    audioBuffer: [],
  } as unknown as CallEntry;

  const session = new CallSession({
    session_id,
    seed,
    call,
    aai,
    now: deps.now,
    onServerEvent: makeEntrySink(session_id, deps, activeCalls, entry),
    mock: mockToolResult,
    // CRITICAL 1 (final review): every AAI transcript event also counts as activity, not
    // just a browser message -- a caller who's talking but whose browser happens to be
    // between keepalive frames must never look idle.
    onActivity: () => touch(deps.caps, session_id, deps.now()),
    // Flight recorder: every server_event CallSession itself records (evaluate, tool.call,
    // terminal actions, AAI session.ready/error/ended, link changes, caught errors) lands in
    // THIS session's bundle -- created just above, before the AAI connect even started.
    onDiagnostic: (kind, detail) => recordServerEvent(deps.diagnostics, session_id, deps.now(), kind, detail),
  });
  entry.session = session;
  activeCalls.set(session_id, entry);

  // CRITICAL 1 (final review): the per-session minute cap, started once on this first
  // attach (never reset by a later reattach -- it bounds the call's total lifetime, not any
  // one socket's uptime) and cleared by `makeEntrySink` the moment the call actually ends.
  const capSeconds = deps.session_cap_seconds ?? DEFAULT_SESSION_CAP_SECONDS;
  entry.capTimer = setTimeout(() => {
    endCall(session_id, 'cap_reached');
  }, capSeconds * 1000);

  wireSocketHandlers(ws, session_id, deps, activeCalls, entry);
}

function handleReplaySocket(ws: WebSocket, file: string, speedParam: string | null, deps: BrowserWsDeps): void {
  const corpusDir = deps.corpusDir ?? defaultCorpusDir();
  const corpus = loadCorpusFile(corpusDir, file);
  if (!corpus) {
    ws.close(4404, 'unknown replay file');
    return;
  }

  const parsedSpeed = speedParam ? Number(speedParam) : 1;
  const speed = Number.isFinite(parsedSpeed) && parsedSpeed > 0 ? parsedSpeed : 1;

  runReplay(corpus, {
    session_id: `replay-${file}`,
    speed,
    send: (e) => safeSend(ws, e),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  })
    .then(() => safeSend(ws, { type: 'ended', reason: 'replay_complete' }))
    .catch(() => {
      // A replay that errors mid-stream still leaves the socket open with whatever state
      // it already sent; there is no live call underneath it to tear down.
    });
}

export interface BrowserWsApi {
  /** CRITICAL 1 (final review): the ONE place that ends a live call -- the `CallSession`
   *  (which closes the AAI socket, per `CallSession.end`), the attached browser socket (if
   *  any), and the caps slot, together. Used by http.ts's `/end`/`/reset`, index.ts's idle
   *  reaper, and this file's own per-call cap timer. Returns `false` (no-op) for an id with
   *  no live call AND no caps-active entry -- there's nothing to end. Falls back to freeing
   *  a bare caps slot for an id that's `canStartSession`-active but never actually attached a
   *  `/ws/call/:id` socket yet (a session minted via `/api/session/start` and reset/ended
   *  before the browser ever opened its WebSocket) -- there is no live `CallEntry` for
   *  `endCall` to act on in that case, only the caps reservation to release. */
  endCall(session_id: string, reason: string): boolean;
  /** Rehearsal-harness debug hook (judge-sim finding 2026-09-11: session.resume was never
   *  exercised on a live call). Forwards to the live `CallEntry`'s own `CallSession.
   *  debugDropAai()` -- see that method's doc comment. Returns false for an id with no live
   *  call (never attached, already ended) -- there is nothing to drop. Only ever reached
   *  through the env-guarded debug route (`COUNTERSIGN_DEBUG_HOOKS=1`, http.ts). */
  dropAai(session_id: string): boolean;
}

export function attachWebSocketServer(server: Server, deps: BrowserWsDeps): BrowserWsApi {
  const wss = new WebSocketServer({ noServer: true });
  // One map per `attachWebSocketServer` call (i.e. per server), not module-global -- each
  // test spins up its own server via its own call, so their in-grace sessions never bleed
  // into each other.
  const activeCalls = new Map<string, CallEntry>();

  function endCall(session_id: string, reason: string): boolean {
    const entry = activeCalls.get(session_id);
    if (entry) {
      // Flight recorder: a distinct, easy-to-grep `cap` server_event for the two abuse-cap
      // paths (BRIEF's cap timer above, and index.ts's idle reaper) BEFORE the generic
      // `session_ended` diag CallSession.end() itself records -- "caps events (cap reached,
      // idle timeout)" per the founder's ask, not just inferable from end_reason after the
      // fact.
      if (reason === 'cap_reached' || reason === 'idle_timeout') {
        recordServerEvent(deps.diagnostics, session_id, deps.now(), 'cap', { event: reason });
      }
      // `entry.session.end(reason)` emits `ended`, which `makeEntrySink` already routes into
      // clearing both timers, `activeCalls.delete`, `endSession`, AND (round 4, requirement
      // 9 -- see that function's own doc comment) closing the browser socket -- idempotent,
      // so a call that already ended between the caller's check and this call is a harmless
      // no-op. Round 4 (2026-09-14): `CallSession.end('idle_timeout')` can now DEFER (it
      // speaks a goodbye before actually ending, see session.ts's own doc comment) rather
      // than emitting `ended` synchronously -- closing the browser ws HERE, unconditionally,
      // used to race ahead of that goodbye and cut the socket before `ended` (or the
      // goodbye's own audio/state) ever reached it. `makeEntrySink`'s `ended` branch is the
      // one place that actually knows the call is DONE talking, so the close moved there.
      entry.session.end(reason);
      return true;
    }
    // No live CallEntry (never attached a `/ws/call/:id` socket, or already fully ended) --
    // if the id is still holding a caps slot (minted by `/api/session/start` but never
    // attached), free that slot directly so `/reset`/`/end` still work before a browser ever
    // opens its WebSocket, same as before this fix.
    if (deps.caps.active.has(session_id)) {
      endSession(deps.caps, session_id);
      return true;
    }
    return false;
  }

  function dropAai(session_id: string): boolean {
    const entry = activeCalls.get(session_id);
    if (!entry) return false;
    return entry.session.debugDropAai();
  }

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    // CRITICAL (task-origin-review.md): the only origin gate for a WebSocket upgrade at
    // all -- browsers apply no Same-Origin Policy to `new WebSocket(...)`, so without this
    // any page on any origin that learns a live session id could open `/ws/call/:id`
    // directly. Checked BEFORE any path match, so a disallowed origin gets a raw HTTP 403
    // and never learns anything about which paths exist. A missing `Origin` header is
    // treated the same as a disallowed one -- `isAllowedOrigin` already returns false for it
    // (real browsers always send `Origin` on a WS upgrade; a non-browser client without one
    // is exactly the case this check exists to keep out). `socket.write` + `socket.destroy`
    // (a raw HTTP 403) rather than completing the WS handshake and closing after -- closing
    // post-handshake would send a normal WS close frame, not an HTTP 403, and would burn a
    // real upgrade on a request that was never going to be allowed to make one.
    if (!isAllowedOrigin(req, deps.cfg)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    const url = new URL(req.url ?? '/', 'http://internal');
    const callMatch = /^\/ws\/call\/([^/]+)$/.exec(url.pathname);
    const replayMatch = /^\/ws\/replay\/([^/]+)$/.exec(url.pathname);

    if (callMatch) {
      const id = decodeURIComponent(callMatch[1]!);
      wss.handleUpgrade(req, socket, head, (ws) => handleCallSocket(ws, id, deps, activeCalls, endCall));
      return;
    }
    if (replayMatch) {
      const file = decodeURIComponent(replayMatch[1]!);
      const speed = url.searchParams.get('speed');
      wss.handleUpgrade(req, socket, head, (ws) => handleReplaySocket(ws, file, speed, deps));
      return;
    }

    // Anything else -- including a path a leading ".." collapsed entirely out of the URL's
    // normalized pathname (e.g. "/ws/replay/.." -> "/ws/") -- gets a real WS handshake
    // followed by a clean 4404 close, rather than a raw socket.destroy(): a consistent,
    // testable rejection instead of one whose shape depends on how far URL normalization
    // happened to collapse a given traversal attempt.
    wss.handleUpgrade(req, socket, head, (ws) => ws.close(4404, 'not found'));
  });

  return { endCall, dropAai };
}
