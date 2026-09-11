import { describe, it, expect } from 'vitest';
import {
  newCapsState,
  canStartSession,
  startSession,
  touch,
  endSession,
  reapIdle,
  personaFor,
  markLiveCallsUnavailable,
  computeLiveCallsStatus,
  recordMintSuccess,
  resetLiveCallsOverride,
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
    trust_proxy: false,
    browser_grace_ms: 20000,
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

  // Bug fix (2026-09-04): the demo persona rides alongside the session id in the SAME
  // `active` map entry `/api/session/start` already creates -- no separate channel.
  describe('demo persona', () => {
    it('startSession stores the given persona; personaFor reads it back', () => {
      const state = newCapsState();
      startSession(state, 1000, 'a', 'legitimate');
      expect(personaFor(state, 'a')).toBe('legitimate');
    });

    it('startSession defaults to the attacker persona when none is given', () => {
      const state = newCapsState();
      startSession(state, 1000, 'a');
      expect(personaFor(state, 'a')).toBe('attacker');
    });

    it('personaFor falls back to the attacker persona for a session id it never recorded', () => {
      const state = newCapsState();
      expect(personaFor(state, 'never-started')).toBe('attacker');
    });
  });

  // Reviewer finding (2026-09-11): "credits-exhausted replay mode" is a submission
  // requirement (CLAUDE.md abuse caps) with nothing implementing it under that name.
  describe('live calls availability', () => {
    it('is available by default', () => {
      const state = newCapsState();
      expect(computeLiveCallsStatus(state, cfg(), 1000)).toEqual({ available: true, reason: null });
    });

    it('COUNTERSIGN_LIVE_DISABLED=credits (cfg.live_disabled) forces credits_exhausted', () => {
      const state = newCapsState();
      expect(computeLiveCallsStatus(state, cfg({ live_disabled: 'credits' }), 1000)).toEqual({
        available: false,
        reason: 'credits_exhausted',
      });
      // and it blocks canStartSession the same way, before the no_api_key/session_in_use/
      // daily_cap/mint_rate checks below it
      expect(canStartSession(state, cfg({ live_disabled: 'credits' }), 1000)).toEqual({
        ok: false,
        reason: 'credits_exhausted',
      });
    });

    it('a real mint/connect failure classified as credits-exhausted latches IMMEDIATELY via markLiveCallsUnavailable', () => {
      const state = newCapsState();
      markLiveCallsUnavailable(state, 'credits_exhausted', 1000);
      expect(computeLiveCallsStatus(state, cfg(), 1000)).toEqual({ available: false, reason: 'credits_exhausted' });
      expect(canStartSession(state, cfg(), 1000)).toEqual({ ok: false, reason: 'credits_exhausted' });
    });

    // Review fix (2026-09-11, CRITICAL finding): a single generic mint failure (a
    // transient 429 during a Render cold start, a network blip, anything not an
    // unambiguous credit/quota signal) must NEVER permanently kill live calls for every
    // later judge. mint_error only latches after MINT_FAILURE_LATCH_THRESHOLD (3)
    // classified failures within the MINT_FAILURE_WINDOW_MS (10 minute) cool-down, and a
    // successful connect (recordMintSuccess) resets the streak to zero.
    describe('mint_error requires a streak, not a single failure', () => {
      it('does not latch on the first or second failure within the window', () => {
        const state = newCapsState();
        markLiveCallsUnavailable(state, 'mint_error', 0);
        expect(computeLiveCallsStatus(state, cfg(), 0)).toEqual({ available: true, reason: null });
        markLiveCallsUnavailable(state, 'mint_error', 1000);
        expect(computeLiveCallsStatus(state, cfg(), 1000)).toEqual({ available: true, reason: null });
      });

      it('latches on the 3rd consecutive classified failure within 10 minutes', () => {
        const state = newCapsState();
        markLiveCallsUnavailable(state, 'mint_error', 0);
        markLiveCallsUnavailable(state, 'mint_error', 1000);
        markLiveCallsUnavailable(state, 'mint_error', 2000);
        expect(computeLiveCallsStatus(state, cfg(), 2000)).toEqual({ available: false, reason: 'mint_error' });
        expect(canStartSession(state, cfg(), 2000)).toEqual({ ok: false, reason: 'mint_error' });
      });

      it('recordMintSuccess resets the streak so 2 failures + a success + 2 more failures never latches', () => {
        const state = newCapsState();
        markLiveCallsUnavailable(state, 'mint_error', 0);
        markLiveCallsUnavailable(state, 'mint_error', 1000);
        recordMintSuccess(state);
        markLiveCallsUnavailable(state, 'mint_error', 2000);
        markLiveCallsUnavailable(state, 'mint_error', 3000);
        expect(computeLiveCallsStatus(state, cfg(), 3000)).toEqual({ available: true, reason: null });
      });

      it('a failure outside the 10-minute window does not count toward the streak', () => {
        const state = newCapsState();
        const TEN_MIN_MS = 10 * 60 * 1000;
        markLiveCallsUnavailable(state, 'mint_error', 0);
        markLiveCallsUnavailable(state, 'mint_error', 1000);
        // this 3rd failure arrives outside the window measured from the first two --
        // pruning drops them, so only this one failure remains, not a latching streak of 3
        markLiveCallsUnavailable(state, 'mint_error', TEN_MIN_MS + 2000);
        expect(computeLiveCallsStatus(state, cfg(), TEN_MIN_MS + 2000)).toEqual({ available: true, reason: null });
      });
    });

    it('credits_exhausted sticks even if a later failure is only a generic mint_error', () => {
      const state = newCapsState();
      markLiveCallsUnavailable(state, 'credits_exhausted', 1000);
      markLiveCallsUnavailable(state, 'mint_error', 2000);
      markLiveCallsUnavailable(state, 'mint_error', 3000);
      markLiveCallsUnavailable(state, 'mint_error', 4000);
      expect(computeLiveCallsStatus(state, cfg(), 4000)).toEqual({ available: false, reason: 'credits_exhausted' });
    });

    // Review fix (2026-09-11, part c): the founder needs a way to manually clear a latched
    // live_override -- there was no runtime admin path at all (state.killed is only ever
    // read, never set by any route; COUNTERSIGN_KILL_SWITCH is a redeploy-only env var).
    // resetLiveCallsOverride is what POST /api/admin/live-calls/reset (http.ts) calls.
    it('resetLiveCallsOverride clears a latched reason and the failure streak', () => {
      const state = newCapsState();
      markLiveCallsUnavailable(state, 'credits_exhausted', 1000);
      resetLiveCallsOverride(state);
      expect(computeLiveCallsStatus(state, cfg(), 1000)).toEqual({ available: true, reason: null });

      // and the streak is really cleared, not just the reported reason -- 2 more failures
      // right after a reset still should not re-latch
      markLiveCallsUnavailable(state, 'mint_error', 2000);
      markLiveCallsUnavailable(state, 'mint_error', 3000);
      expect(computeLiveCallsStatus(state, cfg(), 3000)).toEqual({ available: true, reason: null });
    });

    it('kill switch and daily cap route through the same field, unchanged behaviour', () => {
      const state = newCapsState();
      expect(computeLiveCallsStatus(state, cfg({ kill_switch: true }), 1000)).toEqual({
        available: false,
        reason: 'kill_switch',
      });

      const state2 = newCapsState();
      const c = cfg({ max_concurrent: 1000, mint_rate_per_minute: 1000 });
      const dayStart = Date.UTC(2026, 8, 2, 0, 0, 0);
      for (let i = 0; i < 40; i++) {
        startSession(state2, dayStart + i, `s${i}`);
        endSession(state2, `s${i}`);
      }
      expect(computeLiveCallsStatus(state2, c, dayStart + 100)).toEqual({ available: false, reason: 'daily_cap' });
    });

    it('does not report session_in_use, mint_rate or no_api_key -- those stay transient/per-request', () => {
      const state = newCapsState();
      startSession(state, 1000, 'a');
      const c = cfg({ max_concurrent: 1, assemblyai_api_key: null });
      expect(computeLiveCallsStatus(state, c, 1000)).toEqual({ available: true, reason: null });
    });
  });
});
