import { describe, it, expect } from 'vitest';
import {
  newCapsState,
  canStartSession,
  startSession,
  touch,
  endSession,
  reapIdle,
} from '../src/caps.js';
import type { ServerConfig } from '../src/config.js';

function cfg(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    port: 8787,
    assemblyai_api_key: 'test-key',
    session_cap_seconds: 300,
    max_concurrent: 2,
    idle_timeout_ms: 30000,
    daily_session_cap: 40,
    mint_rate_per_minute: 6,
    kill_switch: false,
    allowed_origins: ['http://localhost:5173'],
    ...overrides,
  };
}

describe('caps', () => {
  it('kill switch blocks new sessions', () => {
    const state = newCapsState();
    const decision = canStartSession(state, cfg({ kill_switch: true }), 1000);
    expect(decision).toEqual({ ok: false, reason: 'kill_switch' });
  });

  it('no api key blocks new sessions', () => {
    const state = newCapsState();
    const decision = canStartSession(state, cfg({ assemblyai_api_key: null }), 1000);
    expect(decision).toEqual({ ok: false, reason: 'no_api_key' });
  });

  it('two active sessions triggers session_in_use', () => {
    const state = newCapsState();
    const c = cfg();
    startSession(state, 1000, 'a');
    startSession(state, 1000, 'b');
    const decision = canStartSession(state, c, 1000);
    expect(decision).toEqual({ ok: false, reason: 'session_in_use' });
  });

  it('40 sessions today triggers daily_cap; a new UTC day resets it', () => {
    const state = newCapsState();
    const c = cfg({ max_concurrent: 1000, mint_rate_per_minute: 1000 });
    const dayStart = Date.UTC(2026, 8, 2, 0, 0, 0);
    for (let i = 0; i < 40; i++) {
      startSession(state, dayStart + i, `s${i}`);
      endSession(state, `s${i}`);
    }
    const decision = canStartSession(state, c, dayStart + 100);
    expect(decision).toEqual({ ok: false, reason: 'daily_cap' });

    const nextDay = Date.UTC(2026, 8, 3, 0, 0, 0);
    const decision2 = canStartSession(state, c, nextDay);
    expect(decision2).toEqual({ ok: true });
  });

  it('6 mints within 60s triggers mint_rate; clears 61s later', () => {
    const state = newCapsState();
    const c = cfg({ max_concurrent: 1000, daily_session_cap: 1000 });
    const base = 1_000_000;
    for (let i = 0; i < 6; i++) {
      startSession(state, base + i, `s${i}`);
      endSession(state, `s${i}`);
    }
    const decision = canStartSession(state, c, base + 6000);
    expect(decision).toEqual({ ok: false, reason: 'mint_rate' });

    const decision2 = canStartSession(state, c, base + 5 + 61_000);
    expect(decision2).toEqual({ ok: true });
  });

  it('reapIdle ends a session idle past the timeout and leaves a recently touched one', () => {
    const state = newCapsState();
    const c = cfg();
    startSession(state, 0, 'idle');
    startSession(state, 0, 'fresh');
    touch(state, 'fresh', 29001);
    const ended = reapIdle(state, c, 30001);
    expect(ended).toEqual(['idle']);
    expect(state.active.has('idle')).toBe(false);
    expect(state.active.has('fresh')).toBe(true);
  });

  it('startSession prunes mint timestamps older than 60s so state.mints stays bounded', () => {
    const state = newCapsState();
    startSession(state, 0, 'old-1');
    endSession(state, 'old-1');
    startSession(state, 100, 'old-2');
    endSession(state, 'old-2');
    // both mints above are now more than 60s in the past relative to this call
    startSession(state, 61_000, 'fresh');
    expect(state.mints).toEqual([61_000]);
  });

  it('endSession frees a concurrency slot', () => {
    const state = newCapsState();
    const c = cfg({ max_concurrent: 1 });
    startSession(state, 1000, 'a');
    expect(canStartSession(state, c, 1000)).toEqual({ ok: false, reason: 'session_in_use' });
    endSession(state, 'a');
    expect(canStartSession(state, c, 1000)).toEqual({ ok: true });
  });
});
