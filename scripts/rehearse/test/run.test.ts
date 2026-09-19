// PROVEN gap (2026-09-14, scripts/rehearse/reports/2026-09-14T15-49-25-structuring-two-wires.md
// and 2026-09-14T15-47-29-miller-patient.md, read together with their .diagnostics.json
// server_events): since 630a0b1 (waitForServerHangup in turnController.ts/run.ts), run.ts's
// `runOne` snapshotted `client.latestState()`/`client.stateHistory` into the report's
// transcript/state_history BEFORE waiting for the server's own hang-up -- so an agent
// transcript line (including the goodbye) that arrives WHILE the harness is waiting for that
// hang-up was recorded by the live WebSocket listener but dropped from the report, and the
// close-line grader (`checkCloseLineExpectation`) then graded "NOT spoken" against that stale
// transcript even though the server actually said it. `waitForVerdictAndHangup` (run.ts) is the
// extracted, unit-testable fix: it snapshots the transcript AFTER the hang-up wait resolves.
// This file drives a FAKE CallClient (no network, no real WebSocket) through exactly that
// timing: the last caller turn is already in the transcript, then an agent transcript line and
// an `ended` event arrive DURING the wait, and asserts both the returned transcript and the
// close-line grade (via expectations.ts's real `checkCloseLineExpectation`, never a copy) see
// the goodbye.
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { waitForVerdictAndHangup } from '../run.js';
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
      // Non-null so `waitForCountersignSettle` (called inside `waitForVerdictAndHangup`)
      // resolves immediately instead of waiting out its own 8s window -- not the thing under
      // test here.
      export_hash: 'fake-hash',
      countersign: { server_verdict: verdict, recomputed: true },
    },
    simulated: true,
    link: 'live',
  };
}

/** A minimal fake `CallClient` whose `latestState()`/`stateHistory` update live (mirroring
 *  wsClient.ts's real `ws.on('message', ...)` listener, which is never torn down mid-call) and
 *  whose `waitForEnded` follows the exact same "one-shot timer + overwritten callback" shape as
 *  the real implementation, so this test proves the fix against the real timing contract, not a
 *  simplified stand-in. */
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
    name: 'run-test-fixture',
    title: 'run.ts test fixture',
    description: '',
    source: 'inline test fixture, not a real scenario file',
    turns: [],
    expected: { verdict, max_wall_ms: maxWallMs },
  };
}

describe('waitForVerdictAndHangup (PROVEN gap, 2026-09-14: transcript snapshot timing around waitForServerHangup)', () => {
  it('captures an agent transcript line (the goodbye) that arrives DURING the server hang-up wait, and the close-line grader sees it as spoken', async () => {
    const client = makeFakeClient();
    // The last caller turn has already been spoken before this function is even called (this
    // is run.ts's own contract: `waitForVerdictAndHangup` is only ever called once every
    // scripted/LLM turn is done) -- represented here by a caller line already in the
    // transcript, and the verdict already reached, exactly as the real ESCALATE close reply's
    // trigger conditions would look at that point.
    client.emitCallerLine('This cannot be verified, so I need to escalate.');
    (client.latestState() as ScreenState).verdict = 'ESCALATE';

    const resultPromise = waitForVerdictAndHangup(client, fixtureScenario('ESCALATE'), /* callerHungUp */ false, /* endedTimeoutMs */ 500);

    // Simulate the server's own CLOSE reply landing WHILE the harness is inside
    // waitForServerHangup's wait window (60s by construction -- CLOSE_WAIT_MS -- so this
    // resolves the wait via the ended event, not the timeout).
    await sleep(20);
    client.emitAgentLine(CLOSE_SENTENCE_BY_VERDICT.ESCALATE);
    await sleep(10);
    client.emitEnded('agent_closed');

    const result = await resultPromise;

    expect(result.endedReason).toBe('agent_closed');
    expect(result.hangupFailReason).toBeUndefined();
    // The core assertion: the goodbye line the fake client emitted DURING the wait is present
    // in the returned transcript -- the exact thing 630a0b1's regression dropped.
    const agentLines = result.transcript.filter((l) => l.speaker === 'agent').map((l) => l.text);
    expect(agentLines).toContain(CLOSE_SENTENCE_BY_VERDICT.ESCALATE);

    // The close-line grade (run.ts's real, unmocked expectations.ts function) must now see the
    // goodbye as spoken, matching the call's actual verdict -- this is what a stored report's
    // "Close line: NOT spoken" line got wrong before the fix.
    const closeLineCheck = checkCloseLineExpectation(result.endedReason, result.actualVerdict, result.transcript);
    expect(closeLineCheck.status).toBe('spoken');
    expect(closeLineCheck.failure).toBeNull();
  });

  it('still grades "not spoken" when the server hangs up without ever producing a close sentence (no false positive from the fix)', async () => {
    const client = makeFakeClient();
    client.emitCallerLine('Goodbye.');
    (client.latestState() as ScreenState).verdict = 'FREEZE';

    const resultPromise = waitForVerdictAndHangup(client, fixtureScenario('FREEZE'), false, 500);
    await sleep(10);
    // The server ends the call, but never says anything -- e.g. a dropped reply.
    client.emitEnded('close_timeout');

    const result = await resultPromise;

    const closeLineCheck = checkCloseLineExpectation(result.endedReason, result.actualVerdict, result.transcript);
    expect(closeLineCheck.status).toBe('not_spoken');
    expect(closeLineCheck.failure).toContain('never contains');
  });

  it('records agent state/transcript events from waitForCountersignSettle onward, before the caller hung itself up (the hang_up: true path)', async () => {
    const client = makeFakeClient();
    client.emitCallerLine('Thanks, bye.');
    (client.latestState() as ScreenState).verdict = 'NO_ACTION';

    const resultPromise = waitForVerdictAndHangup(client, fixtureScenario('NO_ACTION'), /* callerHungUp */ true, /* endedTimeoutMs */ 500);

    await sleep(10);
    client.emitAgentLine(CLOSE_SENTENCE_BY_VERDICT.NO_ACTION);
    await sleep(10);
    client.emitEnded('caller_ended');

    const result = await resultPromise;
    const agentLines = result.transcript.filter((l) => l.speaker === 'agent').map((l) => l.text);
    expect(agentLines).toContain(CLOSE_SENTENCE_BY_VERDICT.NO_ACTION);
  });
});
