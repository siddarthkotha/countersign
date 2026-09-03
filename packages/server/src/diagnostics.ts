// packages/server/src/diagnostics.ts
// The flight recorder (founder's ask, 2026-09-02): "something that can talk back and tell
// you where it went wrong, why and how, from the moment I start the script until it is
// complete." One in-memory DiagnosticBundle per call session (no DB, by law) -- an
// append-only timeline of server_events (what call/session.ts, ws/browser.ts, and the AAI
// adapter actually did/saw) plus client_events (what the browser reports about its own leg,
// posted separately since the server can't see the browser's own audio pipeline). Kept
// alongside CapsState/DiagnosticsState-style pure functions over a plain state object --
// same shape as caps.ts -- rather than a class, to match this file's neighbours.
//
// This is diagnostics, not evidence: nothing here is Evidence (LAW 4), nothing here is a
// verdict (LAW 3), and none of it is quoted into the engine's record. It exists purely so a
// founder debugging a live call can see WHERE and WHY something went wrong without re-reading
// server logs by hand.

const MAX_SERVER_EVENTS_PER_BUNDLE = 2000;
const MAX_CLIENT_EVENTS_PER_BUNDLE = 2000;
const MAX_BUNDLES = 50;

/** A client POST's own caps (BRIEF abuse-cap discipline, same spirit as caps.ts): one
 *  request can add at most this many events, and the raw JSON body can be at most this many
 *  bytes -- both enforced in http.ts before this module ever sees the payload. */
export const MAX_CLIENT_EVENTS_PER_REQUEST = 500;
export const MAX_CLIENT_BODY_BYTES = 64 * 1024;

export interface DiagnosticEvent {
  t_ms: number;
  kind: string;
  detail: unknown;
}

export interface DiagnosticBundle {
  session_id: string;
  started_at: number; // epoch ms
  ended_at: number | null;
  end_reason: string | null;
  deployed_commit: string | null;
  server_events: DiagnosticEvent[];
  client_events: DiagnosticEvent[];
}

export interface DiagnosticsState {
  bundles: Map<string, DiagnosticBundle>;
  /** Insertion order, oldest first -- the ring's eviction queue. A bundle already ended
   *  stays exactly as readable as a live one (GET works after end); the ring only bounds
   *  total memory (last 50 sessions, ended or not), never readability of one still tracked. */
  order: string[];
}

export function newDiagnosticsState(): DiagnosticsState {
  return { bundles: new Map(), order: [] };
}

/** Starts a fresh bundle for `session_id`, evicting the oldest tracked bundle if this push
 *  would exceed the ring's cap. `deployed_commit` is read once here from
 *  `RENDER_GIT_COMMIT` (Render sets it automatically on every deploy; unset -- local dev --
 *  leaves it null rather than guessing). */
export function createBundle(state: DiagnosticsState, session_id: string, now: number): DiagnosticBundle {
  const bundle: DiagnosticBundle = {
    session_id,
    started_at: now,
    ended_at: null,
    end_reason: null,
    deployed_commit: process.env.RENDER_GIT_COMMIT ?? null,
    server_events: [],
    client_events: [],
  };
  // A restart of the same session id (should not happen -- ids are UUIDs -- but a bundle
  // already at that key is replaced outright, never merged silently) never double-counts
  // toward the ring.
  if (!state.bundles.has(session_id)) state.order.push(session_id);
  state.bundles.set(session_id, bundle);
  while (state.order.length > MAX_BUNDLES) {
    const evictId = state.order.shift();
    if (evictId !== undefined) state.bundles.delete(evictId);
  }
  return bundle;
}

/** Appends one server_event, timestamped relative to the bundle's own start (matching
 *  ServerEvent/Evidence's own `t_ms` convention elsewhere in this codebase). Silently a
 *  no-op once the bundle is full (MAX_SERVER_EVENTS_PER_BUNDLE) or the session_id has no
 *  bundle at all (never happens for a session created through the normal attach path, but a
 *  caller that races a diagnostic write against session teardown must never throw). */
export function recordServerEvent(state: DiagnosticsState, session_id: string, now: number, kind: string, detail: unknown): void {
  const bundle = state.bundles.get(session_id);
  if (!bundle) return;
  if (bundle.server_events.length >= MAX_SERVER_EVENTS_PER_BUNDLE) return;
  bundle.server_events.push({ t_ms: now - bundle.started_at, kind, detail });
}

/** Marks a bundle ended (`ended_at`/`end_reason`) -- the bundle itself is left in the ring
 *  exactly where it was, still readable via GET. Returns the bundle (for the NDJSON summary
 *  line the caller prints), or null if this session_id was never tracked (or already evicted
 *  by the ring). */
export function endBundle(state: DiagnosticsState, session_id: string, now: number, reason: string): DiagnosticBundle | null {
  const bundle = state.bundles.get(session_id);
  if (!bundle) return null;
  bundle.ended_at = now;
  bundle.end_reason = reason;
  return bundle;
}

export function getBundle(state: DiagnosticsState, session_id: string): DiagnosticBundle | null {
  return state.bundles.get(session_id) ?? null;
}

export type AddClientEventsResult =
  | { ok: true; accepted: number }
  | { ok: false; reason: 'not_found' | 'invalid' };

/** Validates and appends the client's own POSTed events. Body-size (413) is enforced by the
 *  caller (http.ts, which knows the raw byte length before this ever runs) -- this function
 *  only validates SHAPE: `{ events: [{t_ms: number, kind: string, detail?: unknown}, ...] }`,
 *  at most `MAX_CLIENT_EVENTS_PER_REQUEST` entries, each with a finite numeric `t_ms` and a
 *  non-empty string `kind`. Any violation rejects the WHOLE request (no partial ingest) --
 *  a client reporting its own diagnostics can retry cleanly, and a malformed batch never
 *  silently drops just the bad half. */
export function addClientEvents(state: DiagnosticsState, session_id: string, rawBody: string): AddClientEventsResult {
  const bundle = state.bundles.get(session_id);
  if (!bundle) return { ok: false, reason: 'not_found' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (typeof parsed !== 'object' || parsed === null || !('events' in parsed)) return { ok: false, reason: 'invalid' };
  const events = (parsed as { events: unknown }).events;
  if (!Array.isArray(events) || events.length === 0 || events.length > MAX_CLIENT_EVENTS_PER_REQUEST) {
    return { ok: false, reason: 'invalid' };
  }

  const validated: DiagnosticEvent[] = [];
  for (const raw of events) {
    if (typeof raw !== 'object' || raw === null) return { ok: false, reason: 'invalid' };
    const { t_ms, kind, detail } = raw as Record<string, unknown>;
    if (typeof t_ms !== 'number' || !Number.isFinite(t_ms)) return { ok: false, reason: 'invalid' };
    if (typeof kind !== 'string' || kind.length === 0) return { ok: false, reason: 'invalid' };
    validated.push({ t_ms, kind, detail: detail === undefined ? null : detail });
  }

  let accepted = 0;
  for (const v of validated) {
    if (bundle.client_events.length >= MAX_CLIENT_EVENTS_PER_BUNDLE) break;
    bundle.client_events.push(v);
    accepted += 1;
  }
  return { ok: true, accepted };
}

/** The NDJSON `countersign_diag` summary line (index.ts's docs / Render's log stream carry
 *  one per session end): compact enough to scan in a log tail, not a substitute for the full
 *  GET .../diagnostics bundle. `verdict` is read off the LAST `evaluate` server_event, if
 *  any -- the engine's own last-known verdict for this call, never re-derived here. */
export function summarizeBundle(bundle: DiagnosticBundle): {
  id: string;
  end_reason: string | null;
  counts: Record<string, number>;
  verdict: string | null;
  errors: number;
} {
  const counts: Record<string, number> = {};
  let verdict: string | null = null;
  for (const e of bundle.server_events) {
    counts[e.kind] = (counts[e.kind] ?? 0) + 1;
    if (e.kind === 'evaluate' && typeof e.detail === 'object' && e.detail !== null && 'verdict' in e.detail) {
      verdict = String((e.detail as { verdict: unknown }).verdict);
    }
  }
  return {
    id: bundle.session_id,
    end_reason: bundle.end_reason,
    counts,
    verdict,
    errors: counts.error ?? 0,
  };
}
