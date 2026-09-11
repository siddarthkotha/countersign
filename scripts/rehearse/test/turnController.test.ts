// Exercises the pure/pollable pieces of turnController.ts against a FAKE CallClient (no
// network, no real WebSocket) -- computeTurnGaps' post-hoc math, and waitForVerdict's
// polling loop against a client whose `latestState()` changes over time.
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { computeTurnGaps, waitForGreeting, waitForVerdict } from '../turnController.js';
import type { CallClient } from '../wsClient.js';
import type { ScreenState } from '@countersign/engine';

function fakeState(verdict: ScreenState['verdict']): ScreenState {
  return {
    session_id: 'fake',
    t_ms: 0,
    state: 'ACTION',
    verdict,
    reasons: [],
    request: { claimed_identity: null, amount_usd: null, beneficiary: null, request_version: 1 },
    gates: { context: 'PENDING', device: 'PENDING', consistency: 'PENDING' },
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
      countersign: { server_verdict: verdict, recomputed: false },
    },
    simulated: true,
    link: 'live',
  };
}

function makeFakeClient(): CallClient & { setState(v: ScreenState['verdict']): void } {
  const startedAt = performance.now();
  let state: ScreenState | null = null;
  return {
    startedAt,
    send() {},
    close() {},
    stateHistory: [],
    audioTimestamps: [10, 50, 90],
    linkEvents: [],
    latestState() {
      return state;
    },
    onEnded() {},
    async waitForEnded() {
      return null;
    },
    setState(v) {
      state = fakeState(v);
    },
  };
}

describe('computeTurnGaps', () => {
  it('finds the first audio timestamp after each non-barge-in turn and computes the gap', () => {
    const client = makeFakeClient();
    (client.audioTimestamps as number[]).push(120, 500);
    const gaps = computeTurnGaps(client, [
      { turn_id: 'c1', caller_end_ms: 100, barge_in: false },
      { turn_id: 'c2', caller_end_ms: 400, barge_in: false },
    ]);
    expect(gaps[0]).toMatchObject({ turn_id: 'c1', first_reply_audio_ms: 120, gap_ms: 20 });
    expect(gaps[1]).toMatchObject({ turn_id: 'c2', first_reply_audio_ms: 500, gap_ms: 100 });
  });

  it('marks a barge-in turn with a note instead of a gap number', () => {
    const client = makeFakeClient();
    const gaps = computeTurnGaps(client, [{ turn_id: 'c4', caller_end_ms: 50, barge_in: true }]);
    expect(gaps[0]!.gap_ms).toBeNull();
    expect(gaps[0]!.note).toMatch(/barge-in/);
  });

  it('notes when no reply audio was ever observed after a turn', () => {
    const client = makeFakeClient();
    (client.audioTimestamps as number[]).length = 0;
    const gaps = computeTurnGaps(client, [{ turn_id: 'c1', caller_end_ms: 100, barge_in: false }]);
    expect(gaps[0]!.first_reply_audio_ms).toBeNull();
    expect(gaps[0]!.note).toMatch(/no reply audio/);
  });
});

describe('waitForVerdict', () => {
  it('resolves as soon as the verdict leaves PENDING', async () => {
    const client = makeFakeClient();
    client.setState('PENDING');
    setTimeout(() => client.setState('STAGE'), 80);
    const result = await waitForVerdict(client, 5000);
    expect(result.reached).toBe(true);
    expect(result.verdict).toBe('STAGE');
  });

  it('times out and reports not-reached if the verdict never leaves PENDING', async () => {
    const client = makeFakeClient();
    client.setState('PENDING');
    const result = await waitForVerdict(client, 150);
    expect(result.reached).toBe(false);
    expect(result.verdict).toBe('PENDING');
  });

  it('reports not-reached (verdict null) if no state was ever received', async () => {
    const client = makeFakeClient();
    const result = await waitForVerdict(client, 100);
    expect(result.reached).toBe(false);
    expect(result.verdict).toBeNull();
  });
});

// Founder ruling 2026-09-11: the agent now speaks FIRST on every call (AssemblyAI's
// connect-time `greeting` field) -- these prove the harness's opening-turn wait actually
// waits for that greeting to finish, AND that a missing/misconfigured greeting can never
// deadlock a run (bounded fallback to the original grace-window behavior).
describe('waitForGreeting', () => {
  it('resolves once greeting audio starts and the reply settles, with no warnings', async () => {
    const client = makeFakeClient();
    client.audioTimestamps.length = 0; // no audio yet -- greeting hasn't started
    const warnings: string[] = [];

    const result = waitForGreeting(client, warnings, 5000);
    await sleep(20);
    client.audioTimestamps.push(performance.now() - client.startedAt); // greeting audio starts
    await result;

    expect(warnings).toEqual([]);
  });

  it('falls back to the grace-window check and still returns (never deadlocks) when no greeting audio arrives before the timeout', async () => {
    const client = makeFakeClient();
    client.audioTimestamps.length = 0; // greeting never arrives
    const warnings: string[] = [];

    // A short timeoutMs stands in for the real 8s GREETING_TIMEOUT_MS so this test doesn't
    // have to wait 8 real seconds -- the fallback path (the grace-window check) is the same
    // code either way.
    await waitForGreeting(client, warnings, 50);

    expect(warnings.some((w) => w.includes('no greeting audio observed within 50ms'))).toBe(true);
  }, 10_000);
});
