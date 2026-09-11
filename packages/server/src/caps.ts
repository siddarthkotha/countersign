import type { ServerConfig } from './config.js';
import { DEFAULT_PERSONA, type DemoPersona } from './personas.js';
import type { LiveCallsStatus } from './live_calls.js';

export interface CapsState {
  // Bug fix (2026-09-04): the demo persona rides alongside the session id in this SAME
  // entry -- no separate channel -- so `/ws/call/:id`'s attach can look up which simulated
  // telemetry a session was minted with (see `personaFor` below and ws/browser.ts's
  // `defaultCallContext`).
  active: Map<string, { started_at: number; last_activity_at: number; persona: DemoPersona }>;
  daily: { day: string; count: number };
  mints: number[];
  killed: boolean;
  /** Sticky, process-lifetime latch set by a real AssemblyAI mint/connect failure (see
   *  `markLiveCallsUnavailable` below, called from index.ts's `PendingAaiSocket` catch
   *  handler). `credits_exhausted` always wins over a later `mint_error` -- a transient
   *  network blip after the real cause is already known shouldn't downgrade the reported
   *  reason. Never auto-clears (same "operator/founder resets by restarting" model as
   *  `killed`) -- there is no live signal that credits came back. */
  live_override: 'credits_exhausted' | 'mint_error' | null;
}

export function newCapsState(): CapsState {
  return { active: new Map(), daily: { day: '', count: 0 }, mints: [], killed: false, live_override: null };
}

export type CapDecisionReason =
  | 'kill_switch'
  | 'session_in_use'
  | 'daily_cap'
  | 'mint_rate'
  | 'no_api_key'
  | 'credits_exhausted'
  | 'mint_error';

export type CapDecision = { ok: true } | { ok: false; reason: CapDecisionReason };

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function dailyCountAt(state: CapsState, now: number): number {
  return state.daily.day === utcDay(now) ? state.daily.count : 0;
}

function mintsInLastMinute(state: CapsState, now: number): number {
  const windowStart = now - 60_000;
  return state.mints.filter((t) => t > windowStart).length;
}

export function canStartSession(state: CapsState, cfg: ServerConfig, now: number): CapDecision {
  if (cfg.kill_switch || state.killed) return { ok: false, reason: 'kill_switch' };
  // Checked right after kill_switch, before the pre-existing checks below -- a credits-
  // exhausted account can't serve ANY session regardless of concurrency/daily/rate state,
  // same category of gate as kill_switch. This is additive: none of the four checks below
  // (no_api_key, session_in_use, daily_cap, mint_rate) change position or behaviour.
  if (cfg.live_disabled === 'credits' || state.live_override === 'credits_exhausted') {
    return { ok: false, reason: 'credits_exhausted' };
  }
  if (!cfg.assemblyai_api_key) return { ok: false, reason: 'no_api_key' };
  if (state.active.size >= cfg.max_concurrent) return { ok: false, reason: 'session_in_use' };
  if (dailyCountAt(state, now) >= cfg.daily_session_cap) return { ok: false, reason: 'daily_cap' };
  if (mintsInLastMinute(state, now) >= cfg.mint_rate_per_minute) return { ok: false, reason: 'mint_rate' };
  if (state.live_override === 'mint_error') return { ok: false, reason: 'mint_error' };
  return { ok: true };
}

/** Latches a real AssemblyAI failure into `state.live_override` -- called from index.ts's
 *  `PendingAaiSocket` catch handler with whatever `classifyMintFailure` +
 *  `isCreditsExhaustedError` (live_calls.ts) decided. `credits_exhausted` is sticky against
 *  a later `mint_error` (see `CapsState.live_override` doc comment). */
export function markLiveCallsUnavailable(state: CapsState, reason: 'credits_exhausted' | 'mint_error'): void {
  if (state.live_override === 'credits_exhausted') return;
  state.live_override = reason;
}

/** The one place /health and /api/session/start both read to build their `live_calls`
 *  field -- derives `kill_switch`/`daily_cap` from the EXACT SAME `cfg`/`state` fields
 *  `canStartSession` already reads (no second source of truth, no behaviour change to
 *  either existing cap), and additionally reports `credits_exhausted`/`mint_error` from
 *  the founder override / the sticky latch above. Deliberately does NOT report
 *  `session_in_use`/`mint_rate`/`no_api_key` -- those are transient, per-request
 *  conditions already covered by the existing `{ replay_only, reason }` shape, not a
 *  standing "live calls are down" fact worth a landing-page banner. */
export function computeLiveCallsStatus(state: CapsState, cfg: ServerConfig, now: number): LiveCallsStatus {
  if (cfg.live_disabled === 'credits' || state.live_override === 'credits_exhausted') {
    return { available: false, reason: 'credits_exhausted' };
  }
  if (cfg.kill_switch || state.killed) {
    return { available: false, reason: 'kill_switch' };
  }
  if (dailyCountAt(state, now) >= cfg.daily_session_cap) {
    return { available: false, reason: 'daily_cap' };
  }
  if (state.live_override === 'mint_error') {
    return { available: false, reason: 'mint_error' };
  }
  return { available: true, reason: null };
}

export function startSession(state: CapsState, now: number, id: string, persona: DemoPersona = DEFAULT_PERSONA): void {
  state.active.set(id, { started_at: now, last_activity_at: now, persona });
  const day = utcDay(now);
  if (state.daily.day === day) {
    state.daily.count += 1;
  } else {
    state.daily = { day, count: 1 };
  }
  const windowStart = now - 60_000;
  state.mints = state.mints.filter((t) => t > windowStart);
  state.mints.push(now);
}

/** The persona a session was minted with -- `DEFAULT_PERSONA` (the safe fallback) for a
 *  session id `active` has no record of, same as an unknown/malformed persona at mint time. */
export function personaFor(state: CapsState, session_id: string): DemoPersona {
  return state.active.get(session_id)?.persona ?? DEFAULT_PERSONA;
}

export function touch(state: CapsState, session_id: string, now: number): void {
  const entry = state.active.get(session_id);
  if (entry) entry.last_activity_at = now;
}

export function endSession(state: CapsState, session_id: string): void {
  state.active.delete(session_id);
}

export function reapIdle(state: CapsState, cfg: ServerConfig, now: number): string[] {
  const ended: string[] = [];
  for (const [id, entry] of state.active) {
    if (now - entry.last_activity_at > cfg.idle_timeout_ms) {
      ended.push(id);
    }
  }
  for (const id of ended) state.active.delete(id);
  return ended;
}
