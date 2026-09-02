// packages/web/test/worker-throttle.test.ts
// TDD for the state-event throttle in src/ws/worker.ts. Mirrors the server's own
// `makeThrottledSender` (packages/server/src/ws/browser.ts): a burst of `state`
// ServerEvents coalesces to at most one post per 66 ms (~15 fps), and the last state in a
// burst wins. Every other ServerEvent type is posted immediately, never coalesced. Uses
// fake timers so the test asserts real elapsed-time behaviour without a real Worker/socket.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStateThrottle, STATE_THROTTLE_MS } from '../src/ws/worker';
import type { ScreenState, ServerEvent } from '@countersign/engine';

function makeState(t_ms: number): ScreenState {
  return {
    session_id: 'sess-test',
    t_ms,
    state: 'INTAKE',
    verdict: 'PENDING',
    reasons: [],
    request: { claimed_identity: null, amount_usd: null, beneficiary: null, request_version: 1 },
    gates: { context: 'PENDING', device: 'PENDING', consistency: 'PASS' },
    transcript: [],
    agent_status: 'LISTENING',
    banner: null,
    forensic: {
      evidence: [],
      ledger: [],
      challenges: { issued: [], results: {} },
      assurance: {
        identity_claimed: false,
        sso_pass_current: false,
        oob_confirmed_current: false,
        context_pass_current: false,
        no_contradictions: true,
        critical_fields_confirmed: false,
        exposure_within_limit: true,
        challenge_requirement_met: false,
        no_identity_switch: true,
        not_new_beneficiary: true,
      },
      counterfactuals: [],
      export_hash: null,
      countersign: { server_verdict: 'PENDING', recomputed: false },
    },
    simulated: true,
    link: 'live',
  };
}

describe('createStateThrottle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces a burst of 10 state messages fed over 20ms to at most one post per 66ms window, last state wins', () => {
    const posted: ServerEvent[] = [];
    const throttled = createStateThrottle((e) => posted.push(e));

    for (let i = 0; i < 10; i++) {
      throttled({ type: 'state', state: makeState(i) });
      vi.advanceTimersByTime(2); // 10 messages spread across 20ms
    }

    // The first message in a burst (no prior send) goes out immediately; the rest coalesce
    // behind the pending timer.
    expect(posted).toHaveLength(1);
    expect((posted[0] as { type: 'state'; state: ScreenState }).state.t_ms).toBe(0);

    // Let the trailing coalesce timer fire.
    vi.advanceTimersByTime(STATE_THROTTLE_MS);
    expect(posted).toHaveLength(2);
    expect((posted[1] as { type: 'state'; state: ScreenState }).state.t_ms).toBe(9); // last state wins

    // No further sends fire spontaneously.
    vi.advanceTimersByTime(500);
    expect(posted).toHaveLength(2);
  });

  it('bounds total sends to roughly one per 66ms window across a longer burst (30 messages over 150ms)', () => {
    const posted: ServerEvent[] = [];
    const throttled = createStateThrottle((e) => posted.push(e));

    for (let i = 0; i < 30; i++) {
      vi.advanceTimersByTime(5);
      throttled({ type: 'state', state: makeState(i) });
    }
    vi.advanceTimersByTime(STATE_THROTTLE_MS); // let any trailing coalesce timer fire

    // 150ms of elapsed time can hold at most ceil(150/66)+1 windows' worth of sends (the
    // +1 covers the always-immediate leading send of the burst) -- never one send per
    // burst message.
    expect(posted.length).toBeLessThanOrEqual(Math.ceil(150 / STATE_THROTTLE_MS) + 1);
    expect(posted.length).toBeGreaterThanOrEqual(1);
  });

  it('forwards audio/flush/ended events immediately, never coalesced', () => {
    const posted: ServerEvent[] = [];
    const throttled = createStateThrottle((e) => posted.push(e));

    throttled({ type: 'audio', data: 'AAAA' });
    throttled({ type: 'flush' });
    throttled({ type: 'ended', reason: 'replay_complete' });

    expect(posted).toEqual([
      { type: 'audio', data: 'AAAA' },
      { type: 'flush' },
      { type: 'ended', reason: 'replay_complete' },
    ]);
  });
});
