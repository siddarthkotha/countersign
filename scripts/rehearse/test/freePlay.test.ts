// PROVEN gap (2026-09-14, scripts/rehearse/reports/2026-09-14T17-18-03-dana-patient.md): a
// free-play run where the caller model went silent and the live agent spoke the FULL STAGE
// goodbye still ended with "Call ended reason: caller_ended" and "Close line: n/a (caller
// ended)" -- `runFreePlayOne` used to send its own `{type:'end'}` unconditionally right after
// the verdict/settle wait, regardless of whether the server had said (or was about to say)
// anything at all, exactly the race against the server's own CLOSE hang-up and its goodbye
// that turnController.ts's `waitForServerHangup`/run.ts's `waitForVerdictAndHangup` were built
// to fix for the scripted/LLM paths (see run.test.ts, which this file mirrors). `freePlay.ts`'s
// `waitForFreePlayVerdictAndHangup` is the extracted, unit-testable fix: it waits for the
// server's own `ended` event before snapshotting the transcript, the same way the scripted/LLM
// paths already do, and free play NEVER takes the scripted `callerHungUp` immediate-hangup
// shortcut (free play has no `ScenarioTurn.hang_up` concept -- that field only exists on the
// scripted turn list a free-play run never uses).
//
// This file drives a FAKE CallClient (no network, no real WebSocket, no LLM calls) through
// exactly the timing the PROVEN gap describes: the caller model has already gone silent (its
// last spoken line is already in the transcript, as `runFreePlayTurns` would have left it), then
// an agent transcript line (the goodbye) and an `ended` event arrive DURING the wait this
// function performs, and asserts both the returned transcript and the close-line grade (via
// expectations.ts's real `checkCloseLineExpectation`, never a copy) see the goodbye.
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { waitForFreePlayVerdictAndHangup } from '../freePlay.js';
import { CLOSE_SENTENCE_BY_VERDICT } from '../turnController.js';
import { checkCloseLineExpectation } from '../expectations.js';
import type { CallClient } from '../wsClient.js';
import type { Scenario } from '../types.js';
import type { ScreenState, Verdict } from '@countersign/engine';

function baseState(verdict: ScreenState['verdict']): ScreenState {
  return {
    session_id: 'fake',
    t_ms: 0,
    state: 'SEALED',
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
      // Non-null so `waitForCountersignSettle` (called inside `waitForFreePlayVerdictAndHangup`)
      // resolves immediately instead of waiting out its own 8s window -- not the thing under
      // test here.
      export_hash: 'fake-hash',
      countersign: { server_verdict: verdict, recomputed: true },
    },
    simulated: true,
    link: 'live',
  };
}

/** Same fake `CallClient` shape as run.test.ts's own `makeFakeClient` -- `latestState()`/
 *  `stateHistory` update live (mirroring wsClient.ts's real listener, never torn down mid-call)
 *  and `waitForEnded` follows the exact "one-shot timer + overwritten callback" contract the
 *  real implementation does, so this proves the fix against the real timing contract, not a
 *  simplified stand-in. Duplicated rather than imported from run.test.ts: that file is owned by
 *  a different concurrent lane today (per this lane's own brief) and test helpers are cheap to
 *  duplicate compared to adding a cross-lane dependency between two test files editing the same
 *  day. */
function makeFakeClient(): CallClient & {
  emitCallerLine(text: string): void;
  emitAgentLine(text: string): void;
  emitEnded(reason: string): void;
} {
  const startedAt = performance.now();
  let state: ScreenState | null = null;
  let ended: string | null = null;
  let endedCb: ((reason: string) => void) | null = null;
  let transcript: ScreenState['transcript'] = [];
  const stateHistory: { t_ms: number; state: ScreenState }[] = [];

  function record(v: Verdict) {
    state = { ...baseState(v), transcript };
    stateHistory.push({ t_ms: performance.now() - startedAt, state });
  }

  return {
    startedAt,
    send() {},
    close() {},
    stateHistory,
    audioTimestamps: [],
    linkEvents: [],
    agentAudioSnapshot: () => ({ pcm: Buffer.alloc(0), frames: [], truncated: false, total_bytes_received: 0 }),
    latestState: () => state,
    onEnded(cb) {
      endedCb = cb;
      if (ended !== null) cb(ended);
    },
    endedReason: () => ended,
    async waitForEnded(timeoutMs: number) {
      if (ended !== null) return ended;
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), timeoutMs);
        endedCb = (reason) => {
          clearTimeout(timer);
          resolve(reason);
        };
      });
    },
    emitCallerLine(text: string) {
      transcript = [...transcript, { id: `t${transcript.length}`, speaker: 'caller', text, t_ms: performance.now() - startedAt }];
      record((state?.verdict ?? 'PENDING') as Verdict);
    },
    emitAgentLine(text: string) {
      transcript = [...transcript, { id: `t${transcript.length}`, speaker: 'agent', text, t_ms: performance.now() - startedAt }];
      record((state?.verdict ?? 'PENDING') as Verdict);
    },
    emitEnded(reason: string) {
      ended = reason;
      endedCb?.(reason);
    },
  };
}

function fixtureScenario(verdict: Verdict, maxWallMs = 500): Scenario {
  return {
    name: 'free-play-test-fixture',
    title: 'freePlay.ts test fixture',
    description: '',
    source: 'inline test fixture, not a real scenario file',
    turns: [],
    expected: { verdict, max_wall_ms: maxWallMs },
  };
}

describe('waitForFreePlayVerdictAndHangup (PROVEN gap, 2026-09-14: free play must wait for the server\'s own hang-up, same as the scripted/LLM paths)', () => {
  it('captures the agent goodbye transcript line and the ended event that arrive DURING the hang-up wait after the free-play caller went silent, and the close-line grader sees it as spoken', async () => {
    const client = makeFakeClient();
    // The free-play caller has already gone silent per its persona instruction (this function's
    // own contract: it is only ever called once `runFreePlayTurns` is done, whether that ended
    // because the caller said `silent: true`, ran out of turns, or the agent's own close line
    // stopped it mid-loop) -- represented here by the caller's last line already in the
    // transcript and the verdict already reached, exactly as the real STAGE close reply's
    // trigger conditions would look at that point.
    client.emitCallerLine('This is Dana Whitfield, corporate treasury. I need to wire $84,500 to Meridian Supply.');
    (client.latestState() as ScreenState).verdict = 'STAGE';

    const resultPromise = waitForFreePlayVerdictAndHangup(client, fixtureScenario('STAGE'), /* endedTimeoutMs */ 500);

    // Simulate the server's own CLOSE reply landing WHILE the harness is inside
    // waitForServerHangup's wait window (60s by construction -- CLOSE_WAIT_MS -- so this
    // resolves via the ended event, not the timeout).
    await sleep(20);
    client.emitAgentLine(CLOSE_SENTENCE_BY_VERDICT.STAGE);
    await sleep(10);
    client.emitEnded('agent_closed');

    const result = await resultPromise;

    expect(result.endedReason).toBe('agent_closed');
    expect(result.hangupFailReason).toBeUndefined();
    // The core assertion: the goodbye line the fake client emitted DURING the wait is present in
    // the returned transcript -- the exact thing the dana-patient report's regression dropped.
    const agentLines = result.transcript.filter((l) => l.speaker === 'agent').map((l) => l.text);
    expect(agentLines).toContain(CLOSE_SENTENCE_BY_VERDICT.STAGE);

    // The close-line grade (the real, unmocked expectations.ts function) must now see the
    // goodbye as spoken, matching the call's actual verdict -- this is what the stored report's
    // "Close line: n/a (caller ended)" got wrong before the fix.
    const closeLineCheck = checkCloseLineExpectation(result.endedReason, result.actualVerdict, result.transcript);
    expect(closeLineCheck.status).toBe('spoken');
    expect(closeLineCheck.failure).toBeNull();
  });

  it('still grades "not spoken" when the server hangs up without ever producing a close sentence (no false positive from the fix)', async () => {
    const client = makeFakeClient();
    client.emitCallerLine('I need to wire this today.');
    (client.latestState() as ScreenState).verdict = 'FREEZE';

    const resultPromise = waitForFreePlayVerdictAndHangup(client, fixtureScenario('FREEZE'), 500);
    await sleep(10);
    // The server ends the call, but never says anything -- e.g. a dropped reply.
    client.emitEnded('close_timeout');

    const result = await resultPromise;

    expect(result.hangupFailReason).toBeUndefined();
    const closeLineCheck = checkCloseLineExpectation(result.endedReason, result.actualVerdict, result.transcript);
    expect(closeLineCheck.status).toBe('not_spoken');
    expect(closeLineCheck.failure).toContain('never contains');
  });
});
