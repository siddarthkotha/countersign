// packages/web/src/diagnostics/flightRecorder.ts
// Task W9 (flight recorder, browser half). The founder's own words for the ask: "something
// that can talk back and tell you where it went wrong, why and how, from the moment I start
// the script until it is complete." packages/server/src/diagnostics.ts (a parallel lane,
// read-only from here) already owns the SERVER half -- one in-memory DiagnosticBundle per
// call session, with a `client_events` array this module's payload feeds directly. This file
// is the CLIENT half: a small ring buffer any part of the browser app can push a plain
// {kind, detail} event onto, plus the plumbing (`buildDiagnosticsPayload`) that turns the
// buffer into the exact JSON shape the server's `addClientEvents` (diagnostics.ts) expects --
// `{ events: [{ t_ms, kind, detail? }, ...] }`, at most 500 entries, body <= 64 KB.
//
// This is diagnostics, not evidence (LAW 4) and not a verdict (LAW 3): nothing recorded here
// is ever read by the engine, quoted into an Evidence record, or shown as proof of anything.
// It exists purely so a founder debugging a rough call (live or rehearsal) can see what the
// BROWSER saw, in order, without asking a stranger to read out their own console.
//
// A single module-level buffer, not React state: mic check results happen on Landing.tsx,
// before any Call.tsx even mounts (before a session's `Start Call` is ever clicked) -- and
// `window`-level 'error'/'unhandledrejection' listeners need to exist from the moment this
// module is first imported, not from the moment a particular screen is on screen. A plain ES
// module is a singleton across the whole app for exactly this reason.
import type { ScreenState } from '@countersign/engine';

/** One entry as sent to the server -- matches `DiagnosticEvent` in
 *  packages/server/src/diagnostics.ts exactly (this module has no import from that package;
 *  duplicating the three-field shape here keeps the browser build free of any server
 *  dependency, same reasoning documented throughout src/ws/worker.ts for its own standalone
 *  types). */
export interface FlightEvent {
  t_ms: number;
  kind: string;
  detail?: unknown;
}

/** Mirrors the server's own `MAX_CLIENT_EVENTS_PER_REQUEST`/`MAX_CLIENT_BODY_BYTES`
 *  (packages/server/src/diagnostics.ts) -- kept as plain local constants rather than an
 *  import so this package never depends on the server package at runtime (only web's test
 *  files import across packages, same pattern as Call.test.tsx importing
 *  `deriveScreenState`). If the server's caps ever change, these two constants are the only
 *  place the browser half needs to follow. */
export const MAX_EVENTS = 500;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const ERROR_DETAIL_MAX_CHARS = 300;

interface RawEntry {
  /** `performance.now()` at record time -- NOT yet relative to anything. Turned into the
   *  wire's `t_ms` (relative to the most recent Start Call click) only at serialization time,
   *  in `toRelative` below, so a single entry recorded before Start Call was ever clicked
   *  still gets a sensible number once the reference point exists. */
  at: number;
  kind: string;
  detail?: unknown;
}

// Ring buffer: oldest entry evicted first once MAX_EVENTS is exceeded (a real flight
// recorder's whole point -- it loops, it does not stop recording). Deliberately NOT reset
// between calls within the same page load (e.g. across a "Start over"): the most recent
// activity from a call that just ended is still useful context for diagnosing why the NEXT
// one behaved a certain way, and the ring's own eviction is what keeps memory bounded over a
// long browser session, not a per-call wipe.
let buffer: RawEntry[] = [];

// The reference point every reported `t_ms` is relative to: the most recent Start Call
// click's own `performance.now()`. `markStartClick` (called from Call.tsx's `handleStart`)
// is the only writer. Before it has ever been called once, `t_ms` falls back to raw
// `performance.now()` -- i.e. time since page load (`performance.now()`'s own epoch) -- a
// real, meaningful number (not a fabricated 0), just not yet "since Start Call" because no
// click has happened yet.
let startClickAt: number | null = null;

/** Called once, from Call.tsx's `handleStart`, at the exact moment "Start Call" is clicked.
 *  Every event's `t_ms` (see `toRelative`) is reported relative to THIS instant, matching the
 *  literal ask ("t_ms since Start Call click"). Events already in the buffer at the moment
 *  this runs (the mic check on Landing, most likely) are NOT rewritten -- they keep their own
 *  raw timestamp and simply end up with a NEGATIVE `t_ms` once this reference exists, which is
 *  correct and informative (it shows how long before Start Call the mic check actually ran),
 *  not a bug to hide. */
export function markStartClick(): void {
  startClickAt = performance.now();
}

/** Push one event onto the ring buffer. Never throws -- a diagnostics recording call must
 *  never be able to break the call it is trying to help debug. `detail` should never contain
 *  transcript TEXT (the server already has it, verbatim, in its own evidence/conversation log
 *  -- see LAW 4); callers that log a transcript line pass `{ role, length }`, never `.text`. */
export function recordEvent(kind: string, detail?: unknown): void {
  try {
    buffer.push({ at: performance.now(), kind, detail });
    if (buffer.length > MAX_EVENTS) buffer.shift();
  } catch {
    // Recording a diagnostic must never throw into caller code.
  }
}

function toRelative(entry: RawEntry): FlightEvent {
  const ref = startClickAt ?? 0;
  const out: FlightEvent = { t_ms: Math.round(entry.at - ref), kind: entry.kind };
  if (entry.detail !== undefined) out.detail = entry.detail;
  return out;
}

function byteLength(s: string): number {
  return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(s).length : s.length;
}

/** Serializes the current buffer to the exact `{ events: [...] }` shape
 *  `addClientEvents` (packages/server/src/diagnostics.ts) validates and stores. If the
 *  resulting JSON exceeds `MAX_PAYLOAD_BYTES`, the OLDEST events are dropped first (never the
 *  newest) until it fits -- the most recent activity is the most useful signal for how a call
 *  actually ended, so that is what survives a trim. */
export function buildDiagnosticsPayload(): string {
  let events = buffer.map(toRelative);
  let body = JSON.stringify({ events });
  while (byteLength(body) > MAX_PAYLOAD_BYTES && events.length > 1) {
    events = events.slice(1);
    body = JSON.stringify({ events });
  }
  return body;
}

/** Read-only snapshot for tests -- production code never needs this (it only ever needs
 *  `buildDiagnosticsPayload`'s serialized form). */
export function getFlightEvents(): FlightEvent[] {
  return buffer.map(toRelative);
}

/** Clears the buffer and the Start Call reference. Test-only in practice (each test file
 *  wants a clean buffer in `beforeEach`) -- production code never calls this: see the ring
 *  buffer comment above for why a real call end deliberately does not reset it. */
export function resetFlightRecorder(): void {
  buffer = [];
  startClickAt = null;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

/** `role`/`length` only -- the two fields the flight recorder ask calls out by name for a
 *  transcript line arrival. Never pass `line.text` here (LAW 4: the server already has the
 *  verbatim text; this is a debugging aid, not a second copy of evidence). */
export function recordTranscriptLine(role: string, length: number): void {
  recordEvent('transcript_line', { role, length });
}

/** Small helper so Call.tsx's `onState` handler reads as one line per state field it cares
 *  about, matching the ask's own phrasing ("each state event's status word"). */
export function recordStateEvent(status: ScreenState['agent_status']): void {
  recordEvent('state', { status });
}

let listenersRegistered = false;

/** Registers the window `'error'`/`'unhandledrejection'` listeners exactly once (guarded by
 *  `listenersRegistered`, so importing this module more than once within a test file -- or a
 *  hot reload in dev -- never double-registers and never double-counts an error). Runs once,
 *  as a side effect of importing this module (see the call at the bottom of this file) --
 *  these two events can fire at any point in the page's life, including before Start Call is
 *  ever clicked, so they cannot wait for a component to mount. */
export function registerGlobalErrorListeners(): void {
  if (listenersRegistered || typeof window === 'undefined') return;
  listenersRegistered = true;

  window.addEventListener('error', (event: ErrorEvent) => {
    const message = event.message || 'window error';
    const stack = event.error instanceof Error ? (event.error.stack ?? '') : '';
    recordEvent('window_error', { text: truncate(stack ? `${message} | ${stack}` : message, ERROR_DETAIL_MAX_CHARS) });
  });

  window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    const reason = event.reason as unknown;
    const message = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? (reason.stack ?? '') : '';
    recordEvent('unhandledrejection', { text: truncate(stack ? `${message} | ${stack}` : message, ERROR_DETAIL_MAX_CHARS) });
  });
}

registerGlobalErrorListeners();
