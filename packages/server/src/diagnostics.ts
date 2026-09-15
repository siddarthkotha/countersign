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
const MAX_BUNDLES = 50;

/** A client POST's own caps (BRIEF abuse-cap discipline, same spirit as caps.ts): one
 *  request can add at most this many events, and the raw JSON body can be at most this many
 *  bytes -- both enforced in http.ts (the raw byte cap) and this module (the shape/count
 *  cap) before a payload is ever trusted. */
export const MAX_CLIENT_EVENTS_PER_REQUEST = 500;
export const MAX_CLIENT_BODY_BYTES = 64 * 1024;

/** Fix round 1 (review finding, IMPORTANT): the per-REQUEST caps above bound one POST, but
 *  said nothing about many small, individually-valid POSTs adding up over a session's life --
 *  a client holding one valid id could otherwise grow one bundle to ~2000 events x ~64 KB
 *  each, unbounded by anything except the (much larger) per-bundle event-count cap. These are
 *  SESSION-WIDE, cumulative across every POST this session ever makes: once either is hit,
 *  the next POST is rejected outright (413) rather than silently truncated. */
export const MAX_CLIENT_EVENTS_PER_SESSION = 500;
export const MAX_CLIENT_BYTES_PER_SESSION = 64 * 1024;
/** Fix round 1: per-EVENT caps, so one adversarial event can't itself dominate the session
 *  budget above -- `kind` is a short label, `detail` is meant for small structured facts
 *  (a permission code, a device string), never a payload dump. */
export const MAX_CLIENT_EVENT_KIND_LENGTH = 64;
export const MAX_CLIENT_EVENT_DETAIL_BYTES = 1024;
/** Fix round 1: a per-session sliding-window rate limit on the POST route itself (distinct
 *  from the byte/count budgets above -- this bounds REQUEST FREQUENCY, not payload size), same
 *  spirit as `caps.ts`'s `mint_rate_per_minute` gate on `/api/session/start`. */
export const MAX_CLIENT_POSTS_PER_MINUTE = 10;
const CLIENT_POST_RATE_WINDOW_MS = 60_000;

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
  /** Fix round 1: running total of `client_events` payload bytes ever accepted for this
   *  session (cumulative across every POST, never decremented) -- what
   *  `MAX_CLIENT_BYTES_PER_SESSION` is actually checked against. Not part of the public GET
   *  response shape's documented contract, but harmless to expose (no secret, just a byte
   *  count) so it isn't worth a separate internal-only type. */
  client_bytes: number;
  /** Fix round 1: epoch-ms timestamps of accepted (rate-limit-passing) POSTs to THIS
   *  session's `.../diagnostics`, pruned to the last `CLIENT_POST_RATE_WINDOW_MS` on every
   *  check -- the sliding window `checkClientPostRate` enforces
   *  `MAX_CLIENT_POSTS_PER_MINUTE` against. */
  client_post_times: number[];
  /** Billing duration in seconds from AssemblyAI's session.ended Termination event
   *  (session_duration_seconds field). Populated when the AAI Termination event arrives.
   *  Used to compute actual billed cost: billed_seconds * ($4.50 / 3600). */
  billed_seconds?: number;
}

export interface DiagnosticsState {
  bundles: Map<string, DiagnosticBundle>;
  /** Insertion order, oldest first -- the ring's eviction queue. A bundle already ended
   *  stays exactly as readable as a live one (GET works after end); the ring only bounds
   *  total memory (last 50 sessions, ended or not), never readability of one still tracked. */
  order: string[];
  /** Fix (2026-09-09, PROVEN live-call regression): events recorded before a bundle exists
   *  for a session -- specifically, http.ts's /api/session/start handler records
   *  'session_minted' the moment a session is minted, but `createBundle` doesn't run until
   *  the FIRST `/ws/call/:id` attach (ws/browser.ts), which can be seconds later or never
   *  (a minted session that's never attached). Buffered here, keyed by session_id, and
   *  drained into the bundle's own server_events (t_ms rebased to the bundle's started_at,
   *  so a pre-attach event correctly shows a negative t_ms) the moment `createBundle` runs.
   *  Bounded the same way `order`/`bundles` are (oldest evicted first) so a flood of mints
   *  that never attach can't grow this unboundedly. */
  pending: Map<string, { at: number; kind: string; detail: unknown }[]>;
}

export function newDiagnosticsState(): DiagnosticsState {
  return { bundles: new Map(), order: [], pending: new Map() };
}

/** How many sessions' worth of pre-bundle events `pending` holds at once -- same ring
 *  eviction spirit as `MAX_BUNDLES`, oldest session evicted first. */
const MAX_PENDING_SESSIONS = 50;
/** How many events one session can buffer before its bundle exists -- generous headroom
 *  over the one event (`session_minted`) the current callers actually record pre-attach. */
const MAX_PENDING_EVENTS_PER_SESSION = 20;

/** Records a server_event for a session that may not have a bundle yet. If a bundle already
 *  exists, this is exactly `recordServerEvent`. If not, the event is buffered in `pending`
 *  and replayed (t_ms rebased to the new bundle's `started_at`) the next time `createBundle`
 *  runs for this `session_id` -- see that function's own draining logic below. Silently caps
 *  at `MAX_PENDING_EVENTS_PER_SESSION`/`MAX_PENDING_SESSIONS`, same "never throw" contract as
 *  `recordServerEvent`. */
export function recordPendingServerEvent(state: DiagnosticsState, session_id: string, now: number, kind: string, detail: unknown): void {
  if (state.bundles.has(session_id)) {
    recordServerEvent(state, session_id, now, kind, detail);
    return;
  }
  let list = state.pending.get(session_id);
  if (!list) {
    if (state.pending.size >= MAX_PENDING_SESSIONS) {
      const oldestKey = state.pending.keys().next().value;
      if (oldestKey !== undefined) state.pending.delete(oldestKey);
    }
    list = [];
    state.pending.set(session_id, list);
  }
  if (list.length >= MAX_PENDING_EVENTS_PER_SESSION) return;
  list.push({ at: now, kind, detail });
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
    client_bytes: 0,
    client_post_times: [],
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
  // Drain any events recorded before this bundle existed (e.g. http.ts's 'session_minted'
  // at mint time, before the WS attach that runs this function) -- rebased onto the new
  // bundle's own clock, in the order they were recorded, ahead of anything this attach
  // itself is about to record.
  const pending = state.pending.get(session_id);
  if (pending) {
    for (const p of pending) {
      if (bundle.server_events.length >= MAX_SERVER_EVENTS_PER_BUNDLE) break;
      bundle.server_events.push({ t_ms: p.at - bundle.started_at, kind: p.kind, detail: p.detail });
    }
    state.pending.delete(session_id);
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

export type ClientPostRateResult = 'ok' | 'not_found' | 'rate_limited';

/** Fix round 1: the per-session sliding-window POST rate limit -- call ONCE per POST,
 *  before the body is even read (http.ts does this), so an attempted flood is rejected
 *  before it costs any body-parsing work, not just before it's accepted into the bundle.
 *  Pruning-then-checking-then-recording in one pass means only ACCEPTED posts occupy a slot
 *  in the window -- a client that's currently rate-limited doesn't dig itself deeper by
 *  retrying; the window just needs its oldest accepted post to age out. */
export function checkClientPostRate(state: DiagnosticsState, session_id: string, now: number): ClientPostRateResult {
  const bundle = state.bundles.get(session_id);
  if (!bundle) return 'not_found';
  const windowStart = now - CLIENT_POST_RATE_WINDOW_MS;
  bundle.client_post_times = bundle.client_post_times.filter((t) => t > windowStart);
  if (bundle.client_post_times.length >= MAX_CLIENT_POSTS_PER_MINUTE) return 'rate_limited';
  bundle.client_post_times.push(now);
  return 'ok';
}

export type AddClientEventsResult =
  | { ok: true; accepted: number }
  | { ok: false; reason: 'not_found' | 'invalid' | 'session_full' };

/** The serialized-byte size of one event as it would count against the session's cumulative
 *  budget -- `detail`'s own JSON size (the field actually capped per-event) plus a small
 *  fixed allowance for `kind`/`t_ms`/object overhead, so the tracked total stays a reasonable
 *  proxy for what's actually retained in memory without having to re-serialize the whole
 *  `client_events` array on every check. */
function eventByteCost(kind: string, detailBytes: number): number {
  return detailBytes + kind.length + 24;
}

/** Validates and appends the client's own POSTed events. Raw body-size (413) is enforced by
 *  the caller (http.ts, which knows the byte length before this ever runs) -- this function
 *  validates SHAPE (`{ events: [{t_ms: number, kind: string (<= 64 chars), detail?: unknown
 *  (<= 1 KB serialized)}, ...] }`, at most `MAX_CLIENT_EVENTS_PER_REQUEST` entries in ONE
 *  request) and the SESSION-WIDE cumulative budget (`MAX_CLIENT_EVENTS_PER_SESSION` events,
 *  `MAX_CLIENT_BYTES_PER_SESSION` bytes, across every POST this session has ever made). Any
 *  shape violation rejects the whole request as `'invalid'` (no partial ingest -- a client
 *  reporting its own diagnostics can retry cleanly, and a malformed batch never silently
 *  drops just the bad half); a request that's individually well-formed but would push the
 *  session over either cumulative budget is rejected whole as `'session_full'` -- never
 *  partially truncated into the bundle the way an earlier version of this function did. */
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

  const validated: { event: DiagnosticEvent; bytes: number }[] = [];
  for (const raw of events) {
    if (typeof raw !== 'object' || raw === null) return { ok: false, reason: 'invalid' };
    const { t_ms, kind, detail } = raw as Record<string, unknown>;
    if (typeof t_ms !== 'number' || !Number.isFinite(t_ms)) return { ok: false, reason: 'invalid' };
    if (typeof kind !== 'string' || kind.length === 0 || kind.length > MAX_CLIENT_EVENT_KIND_LENGTH) {
      return { ok: false, reason: 'invalid' };
    }
    const detailValue = detail === undefined ? null : detail;
    let detailBytes: number;
    try {
      detailBytes = detailValue === null ? 0 : Buffer.byteLength(JSON.stringify(detailValue), 'utf-8');
    } catch {
      // Circular or otherwise unserializable `detail` -- reject rather than crash.
      return { ok: false, reason: 'invalid' };
    }
    if (detailBytes > MAX_CLIENT_EVENT_DETAIL_BYTES) return { ok: false, reason: 'invalid' };
    validated.push({ event: { t_ms, kind, detail: detailValue }, bytes: eventByteCost(kind, detailBytes) });
  }

  const addedCount = validated.length;
  const addedBytes = validated.reduce((sum, v) => sum + v.bytes, 0);
  if (bundle.client_events.length + addedCount > MAX_CLIENT_EVENTS_PER_SESSION) return { ok: false, reason: 'session_full' };
  if (bundle.client_bytes + addedBytes > MAX_CLIENT_BYTES_PER_SESSION) return { ok: false, reason: 'session_full' };

  for (const v of validated) bundle.client_events.push(v.event);
  bundle.client_bytes += addedBytes;
  return { ok: true, accepted: addedCount };
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

/** Extract billed_seconds from the aai_session_terminated diagnostic event (if present)
 *  and set it on the bundle. Called after endBundle to populate the billing duration
 *  from AssemblyAI's session.ended Termination event. Relies on the aai_session_terminated
 *  event being recorded in server_events before this function is called. */
export function populateBilledSeconds(bundle: DiagnosticBundle): void {
  if (bundle.billed_seconds !== undefined) return; // already set
  for (const e of bundle.server_events) {
    if (
      e.kind === 'aai_session_terminated' &&
      typeof e.detail === 'object' &&
      e.detail !== null &&
      'session_duration_seconds' in e.detail
    ) {
      const duration = (e.detail as { session_duration_seconds: unknown }).session_duration_seconds;
      if (typeof duration === 'number') {
        bundle.billed_seconds = duration;
      }
      return;
    }
  }
}
