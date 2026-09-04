import type { ServerConfig } from './config.js';
import { DEFAULT_PERSONA, type DemoPersona } from './personas.js';

export interface CapsState {
  // Bug fix (2026-09-04): the demo persona rides alongside the session id in this SAME
  // entry -- no separate channel -- so `/ws/call/:id`'s attach can look up which simulated
  // telemetry a session was minted with (see `personaFor` below and ws/browser.ts's
  // `defaultCallContext`).
  active: Map<string, { started_at: number; last_activity_at: number; persona: DemoPersona }>;
  daily: { day: string; count: number };
  mints: number[];
  killed: boolean;
}

export function newCapsState(): CapsState {
  return { active: new Map(), daily: { day: '', count: 0 }, mints: [], killed: false };
}

export type CapDecision =
  | { ok: true }
  | { ok: false; reason: 'kill_switch' | 'session_in_use' | 'daily_cap' | 'mint_rate' | 'no_api_key' };

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
  if (!cfg.assemblyai_api_key) return { ok: false, reason: 'no_api_key' };
  if (state.active.size >= cfg.max_concurrent) return { ok: false, reason: 'session_in_use' };
  if (dailyCountAt(state, now) >= cfg.daily_session_cap) return { ok: false, reason: 'daily_cap' };
  if (mintsInLastMinute(state, now) >= cfg.mint_rate_per_minute) return { ok: false, reason: 'mint_rate' };
  return { ok: true };
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
