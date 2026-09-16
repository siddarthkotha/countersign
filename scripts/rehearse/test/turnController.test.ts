// Exercises the pure/pollable pieces of turnController.ts against a FAKE CallClient (no
// network, no real WebSocket) -- computeTurnGaps' post-hoc math, and waitForVerdict's
// polling loop against a client whose `latestState()` changes over time.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  closeLineSpokenForVerdict,
  CLOSE_SENTENCE_BY_VERDICT,
  DISTINGUISHING_CLAUSE_BY_VERDICT,
  CLOSE_WAIT_MS,
  computeTurnGaps,
  ENGINE_CLOSE_SENTENCES,
  isClosingLine,
  isClosingLineStart,
  isHoldingLine,
  maybeDropAai,
  MIN_SPOKEN_MS,
  runTurns,
  scriptedCallerShouldStop,
  waitForBargeIn,
  waitForGreeting,
  waitForOpeningTurn,
  waitForPatientTurn,
  waitForServerHangup,
  waitForVerdict,
} from '../turnController.js';
import type { CallClient } from '../wsClient.js';
import type { Scenario, ScenarioTurn } from '../types.js';
import type { ScreenState } from '@countersign/engine';

const execFileAsync = promisify(execFile);

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

function makeFakeClient(): CallClient & { setState(v: ScreenState['verdict']): void; setAgentLine(text: string): void } {
  const startedAt = performance.now();
  let state: ScreenState | null = null;
  let ended: string | null = null;
  let transcript: ScreenState['transcript'] = [];
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
      return ended;
    },
    endedReason() {
      return ended;
    },
    setState(v) {
      state = fakeState(v);
      state.transcript = transcript;
    },
    // Added for waitForPatientTurn's tests (PROVEN gap, 2026-09-13): appends one agent
    // transcript line, so `lastAgentTranscriptText` (turnController.ts) has something to
    // judge as holding/closing/ordinary -- additive to the existing fake, every other
    // describe block above never calls this and keeps seeing transcript: [].
    setAgentLine(text: string) {
      transcript = [...transcript, { id: `t${transcript.length}`, speaker: 'agent', text, t_ms: performance.now() - startedAt }];
      state = { ...(state ?? fakeState('PENDING')), transcript };
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

  it("uses a barge-in turn's own carried note (waitForBargeIn's timing explanation) instead of the generic text, when one is given", () => {
    const client = makeFakeClient();
    const gaps = computeTurnGaps(client, [
      { turn_id: 'c2', caller_end_ms: 5000, barge_in: true, note: 'barge-in: spoke 150ms after agent audio started' },
    ]);
    expect(gaps[0]!.gap_ms).toBeNull();
    expect(gaps[0]!.note).toBe('barge-in: spoke 150ms after agent audio started');
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

// Bug fix (2026-09-11, PROVEN from scripts/rehearse/reports/2026-09-11T16-35-23-
// scenario-a-dana-legitimate.md): the server now hangs up on its own once it reaches SEALED
// (packages/server/src/call/session.ts's CLOSE grace period/hard cap). A scripted or LLM
// caller with more turns still queued must notice the call already ended and stop speaking
// into a dead session -- `runTurns`/`runLlmTurns` call this once per loop iteration.
describe('scriptedCallerShouldStop', () => {
  it('does not stop while the call has not ended', () => {
    expect(scriptedCallerShouldStop(null)).toEqual({ stop: false, warning: null });
  });

  it('"agent_closed" is the normal, expected end -- stops with no warning', () => {
    expect(scriptedCallerShouldStop('agent_closed')).toEqual({ stop: true, warning: null });
  });

  it('any other end reason mid-script still stops the caller, but with a warning naming the reason', () => {
    for (const reason of ['idle_timeout', 'cap_reached', 'caller_ended', 'close_timeout']) {
      const result = scriptedCallerShouldStop(reason);
      expect(result.stop).toBe(true);
      expect(result.warning).toContain(reason);
    }
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

// Judge-sim finding 2026-09-11 ("zero AssemblyAI socket drops occurred -- session.resume
// never exercised"): `maybeDropAai` is the pure decision function `runTurns` calls once per
// turn -- no real client, no real HTTP, so this is fully unit-testable (same shape as
// `scriptedCallerShouldStop` above).
describe('maybeDropAai', () => {
  function turn(overrides: Partial<ScenarioTurn> = {}): ScenarioTurn {
    return { id: 'c2', text: 'hello', ...overrides };
  }

  it('does nothing for a turn with no drop_aai_before', async () => {
    const result = await maybeDropAai(turn(), async () => ({ ok: true, status: 204 }));
    expect(result).toEqual({ attempted: false, ok: true, warning: null });
  });

  it('warns and does not throw when drop_aai_before is set but no dropAai hook was wired', async () => {
    const result = await maybeDropAai(turn({ drop_aai_before: true }), undefined);
    expect(result.attempted).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.warning).toContain('no dropAai hook was wired');
  });

  it('calls the wired dropAai hook and reports success', async () => {
    let calls = 0;
    const result = await maybeDropAai(turn({ drop_aai_before: true }), async () => {
      calls += 1;
      return { ok: true, status: 204 };
    });
    expect(calls).toBe(1);
    expect(result).toEqual({ attempted: true, ok: true, warning: null });
  });

  it('warns with the HTTP status when the wired dropAai hook reports failure (e.g. debug hooks disabled)', async () => {
    const result = await maybeDropAai(turn({ drop_aai_before: true }), async () => ({ ok: false, status: 404 }));
    expect(result.attempted).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.warning).toContain('HTTP 404');
    expect(result.warning).toContain('COUNTERSIGN_DEBUG_HOOKS');
  });
});

// Bug fix (2026-09-11, PROVEN from scripts/rehearse/reports/2026-09-11T23-28-26-
// barge-in-interrupt.md): three earlier runs the same night (21:52, 22:07, 22:23) DID land
// their barge-in inside the agent's reply; the 23:28 run on the same "fixed" build did not --
// `min_interrupted_agent_lines` FAILED even though the verdict reached STAGE. The old code
// slept `barge_in_after_ms` starting from whenever the harness happened to notice a reply had
// started, not from that reply's own first-audio timestamp, so anything that delayed the
// harness noticing (e.g. its OWN synthesis latency for the line about to be spoken, which ran
// AFTER this sleep) silently added onto the intended offset. These prove `waitForBargeIn`
// anchors to the reply's own audio-start timestamp instead.
describe('waitForBargeIn', () => {
  function bargeInTurn(overrides: Partial<ScenarioTurn> = {}): ScenarioTurn {
    return { id: 'c2', text: 'Yes, go ahead.', barge_in_after_ms: 150, ...overrides };
  }

  it("fires barge_in_after_ms after the anchor reply's OWN first audio frame, not from whenever the wait happened to start", async () => {
    const client = makeFakeClient();
    client.audioTimestamps.length = 0; // no reply yet when the wait begins
    const warnings: string[] = [];
    const turn = bargeInTurn({ barge_in_after_ms: 150 });

    const resultPromise = waitForBargeIn(client, turn, warnings, 5000);
    // Simulate real processing delay (network + AAI + a slow harness) BEFORE the targeted
    // reply's audio actually starts -- under the old bug this delay would have landed on top
    // of barge_in_after_ms; anchored timing must not care how long this took.
    await sleep(70);
    client.audioTimestamps.push(performance.now() - client.startedAt);
    const anchorWallClockMs = performance.now();

    const timing = await resultPromise;
    const elapsedSinceAnchor = performance.now() - anchorWallClockMs;

    expect(timing.anchor_ms).not.toBeNull();
    // ~150ms after the anchor (generous slack for scheduler jitter) -- decisively NOT
    // ~220ms (150 + the 70ms pre-anchor delay), which is what the old "sleep from wait-start"
    // bug would have produced.
    expect(elapsedSinceAnchor).toBeGreaterThanOrEqual(150 - 30);
    expect(elapsedSinceAnchor).toBeLessThan(150 + 70);
    expect(warnings).toEqual([]);
    expect(timing.note(timing.anchor_ms! + 150)).toBe('barge-in: spoke 150ms after agent audio started');
  });

  it('falls back to the pre-fix "speak barge_in_after_ms from now" behaviour, with a warning, when no reply audio arrives before the anchor timeout', async () => {
    const client = makeFakeClient();
    client.audioTimestamps.length = 0; // no reply ever arrives
    const warnings: string[] = [];
    const turn = bargeInTurn({ barge_in_after_ms: 50 });

    const startedAt = performance.now();
    // A short timeoutMs stands in for the real BARGE_IN_ANCHOR_TIMEOUT_MS (8s) so this test
    // doesn't have to wait 8 real seconds -- the fallback path is the same code either way
    // (same pattern as waitForGreeting's own timeout test above).
    const timing = await waitForBargeIn(client, turn, warnings, 60);
    const elapsed = performance.now() - startedAt;

    expect(timing.anchor_ms).toBeNull();
    // Waited out the anchor timeout (60ms) AND the fallback's own barge_in_after_ms (50ms).
    expect(elapsed).toBeGreaterThanOrEqual(60 + 50 - 20);
    expect(warnings.some((w) => w.includes('no reply audio started within 60ms'))).toBe(true);
    expect(timing.note(999)).toContain('unanchored fallback');
  }, 10_000);

  it('has no effect on a turn without barge_in_after_ms -- it is never called for one (defensive: throws if it is)', async () => {
    const client = makeFakeClient();
    const warnings: string[] = [];
    const plainTurn: ScenarioTurn = { id: 'c1', text: 'This is Dana Whitfield.' };

    await expect(waitForBargeIn(client, plainTurn, warnings)).rejects.toThrow(/no barge_in_after_ms/);
    expect(warnings).toEqual([]);
  });
});

// Finding 2026-09-11 (PROVEN from tonight's bundles; scratchpad bargein-no-interrupt.md):
// every anchored barge-in scenario so far targeted a LATER, LLM-phrased readback turn that
// lasts only ~4s, and AssemblyAI confirms the caller's own speech onset 2.4-3.7s after the
// caller's audio starts -- so the interruption usually lands after that reply has already
// finished (reply.done already fired, no `interrupted` line). The fixed greeting lasts
// 5.3-5.8s in every run -- a much bigger, more reliable barge-in target. `waitForOpeningTurn`
// is the turn-0 dispatcher this scenario-a-lookalike relies on: an opening turn that carries
// `barge_in_after_ms` now takes PRECEDENCE over the ordinary greeting-wait, anchoring to the
// greeting's own `reply.audio.first` via the SAME `waitForBargeIn` path any other barge-in
// turn uses (commit ffb8141) -- never a separate implementation. An opening turn with no
// `barge_in_after_ms` is completely unchanged: it still waits for the greeting to finish.
describe('waitForOpeningTurn', () => {
  it('a turn-0 barge_in_after_ms barges into the greeting itself, anchored to its own first audio frame -- not waiting for it to finish', async () => {
    const client = makeFakeClient();
    client.audioTimestamps.length = 0; // nothing has been said yet -- the greeting hasn't started
    const warnings: string[] = [];
    const turn: ScenarioTurn = { id: 'c1', text: "This is Dana Whitfield.", barge_in_after_ms: 1200 };

    const resultPromise = waitForOpeningTurn(client, turn, warnings, 5000);
    await sleep(20);
    client.audioTimestamps.push(performance.now() - client.startedAt); // the greeting's own first audio frame
    const anchorWallClockMs = performance.now();

    const timing = await resultPromise;
    const elapsedSinceAnchor = performance.now() - anchorWallClockMs;

    expect(timing).not.toBeNull();
    expect(timing!.anchor_ms).not.toBeNull();
    expect(elapsedSinceAnchor).toBeGreaterThanOrEqual(1200 - 100);
    expect(warnings).toEqual([]);
  });

  it('a turn-0 with no barge_in_after_ms still waits for the greeting to finish (waitForGreeting behavior), unchanged', async () => {
    const client = makeFakeClient();
    client.audioTimestamps.length = 0; // greeting hasn't started
    const warnings: string[] = [];
    const turn: ScenarioTurn = { id: 'c1', text: 'This is Dana Whitfield, corporate treasury.' };

    const resultPromise = waitForOpeningTurn(client, turn, warnings, 5000);
    await sleep(20);
    client.audioTimestamps.push(performance.now() - client.startedAt); // greeting audio starts

    const timing = await resultPromise;

    expect(timing).toBeNull();
    expect(warnings).toEqual([]);
  });

  it('falls back to the grace-window check (never deadlocks) when a non-barge-in opening turn sees no greeting audio before the timeout', async () => {
    const client = makeFakeClient();
    client.audioTimestamps.length = 0; // greeting never arrives
    const warnings: string[] = [];
    const turn: ScenarioTurn = { id: 'c1', text: 'This is Dana Whitfield.' };

    const timing = await waitForOpeningTurn(client, turn, warnings, 50);

    expect(timing).toBeNull();
    expect(warnings.some((w) => w.includes('no greeting audio observed within 50ms'))).toBe(true);
  }, 10_000);

  it('falls back to the unanchored barge-in behaviour (with a warning) when a barge-in opening turn sees no reply audio before the anchor timeout', async () => {
    const client = makeFakeClient();
    client.audioTimestamps.length = 0; // greeting never arrives
    const warnings: string[] = [];
    const turn: ScenarioTurn = { id: 'c1', text: 'This is Dana Whitfield.', barge_in_after_ms: 50 };

    const timing = await waitForOpeningTurn(client, turn, warnings, 60);

    expect(timing).not.toBeNull();
    expect(timing!.anchor_ms).toBeNull();
    expect(warnings.some((w) => w.includes('no reply audio started within 60ms'))).toBe(true);
  }, 10_000);
});

// PROVEN gap (2026-09-13): the rehearsal harness's scripted caller always spoke its next
// line after a fixed pause, so a live agent that said a holding line ("One moment while I
// verify...") and then went silent forever (a real hung-call server bug) still got a fresh
// caller turn and the run passed -- forty green runs masked the bug. These two describe
// blocks prove the two small matchers `waitForPatientTurn` judges replies with.
describe('isHoldingLine', () => {
  it('matches each documented holding phrase, case-insensitively', () => {
    const phrases = [
      'One moment please.',
      'ONE MOMENT PLEASE.',
      'Please hold.',
      'Hold on a second.',
      'Bear with me.',
      'I am checking that now.',
      'Verifying your identity.',
      'Let me verify that.',
      'While I verify this, please stay on the line.',
    ];
    for (const phrase of phrases) {
      expect(isHoldingLine(phrase), phrase).toBe(true);
    }
  });

  it('does not match an ordinary substantive reply', () => {
    expect(isHoldingLine('Just to confirm, the beneficiary is Meridian Supply. Is that correct?')).toBe(false);
  });

  it('does not match an engine CLOSE sentence', () => {
    for (const s of ENGINE_CLOSE_SENTENCES) {
      expect(isHoldingLine(s), s).toBe(false);
    }
  });

  it('does not match a holding phrase that contains a question (defect 1, 2026-09-14)', () => {
    // A reply that starts with a holding prefix but contains a question is NOT a holding line --
    // the agent is waiting for something specific, not just stalling for time.
    const casesWithQuestions = [
      'One moment while I verify the request. Understood. What is the total amount for these two wires?',
      'Let me verify that. How much are we talking about?',
      'Checking now -- can you confirm the account number?',
      'Please hold. Which beneficiary are we wiring to?',
      'Bear with me. Who is the recipient of this transfer?',
    ];
    for (const reply of casesWithQuestions) {
      expect(isHoldingLine(reply), reply).toBe(false);
    }
  });
});

describe('isClosingLine', () => {
  it("matches every one of the engine's four CLOSE sentences verbatim (copied from fsm.ts's closeSentence)", () => {
    for (const s of ENGINE_CLOSE_SENTENCES) {
      expect(isClosingLine(s), s).toBe(true);
    }
  });

  it('matches when a close sentence is a substring of a longer transcript line', () => {
    expect(isClosingLine(`Okay. ${ENGINE_CLOSE_SENTENCES[0]}`)).toBe(true);
  });

  it('does not match a holding line', () => {
    expect(isClosingLine('One moment while I verify that.')).toBe(false);
  });

  it('does not match an ordinary mid-call substantive reply', () => {
    expect(isClosingLine('Just to confirm, the beneficiary is Meridian Supply. Is that correct?')).toBe(false);
  });
});

// PROVEN gap (2026-09-14, see scripts/rehearse/reports/2026-09-14T13-47-07-miller-patient.md
// and its .diagnostics.json): the deployed CLOSE-goal reply pipeline retried three times in a
// row (goal_code CLOSE, reasons tick_end / close_retry / close_retry); the caller correctly
// waited out the FIRST attempt, but the SECOND attempt (reply.started 48027, reply.done 48091
// -- 64ms, no transcript.agent line at all) fell through as an ordinary reply, and the THIRD
// attempt -- the one that actually said "This transfer is frozen" -- got talked over by the
// caller's next scripted line before the sentence finished. `isClosingLineStart` is the
// matcher `waitForPatientTurn` now uses to notice "the agent has begun a close sentence" from
// a PARTIAL (possibly interrupted, never-finished) transcript line, so the caller can stop
// before the sentence is even complete -- `isClosingLine` above still requires the FULL
// sentence and is unchanged.
describe('isClosingLineStart', () => {
  it('matches a partial transcript that is the opening of one of the four close sentences', () => {
    expect(isClosingLineStart('This transfer is frozen')).toBe(true);
    expect(isClosingLineStart('Your request is staged for')).toBe(true);
  });

  it('matches a full close sentence too (a partial-of-itself)', () => {
    for (const s of ENGINE_CLOSE_SENTENCES) {
      expect(isClosingLineStart(s), s).toBe(true);
    }
  });

  it('does not match a short, ambiguous prefix shared by more than one close sentence (e.g. "This")', () => {
    expect(isClosingLineStart('This')).toBe(false);
    expect(isClosingLineStart('This is')).toBe(false);
  });

  it('does not match an ordinary substantive reply or a holding line', () => {
    expect(isClosingLineStart('Just to confirm, the beneficiary is Meridian Supply.')).toBe(false);
    expect(isClosingLineStart('One moment while I verify that.')).toBe(false);
  });

  it('does not match a reply that merely happens to contain close wording later, not at the start', () => {
    expect(isClosingLineStart('Okay, so, This transfer is frozen')).toBe(false);
  });
});

describe('closeLineSpokenForVerdict', () => {
  it('matches when a single agent line is exactly the verdict\'s close sentence', () => {
    expect(closeLineSpokenForVerdict('FREEZE', [CLOSE_SENTENCE_BY_VERDICT.FREEZE])).toBe(true);
    expect(closeLineSpokenForVerdict('STAGE', [CLOSE_SENTENCE_BY_VERDICT.STAGE])).toBe(true);
    expect(closeLineSpokenForVerdict('ESCALATE', [CLOSE_SENTENCE_BY_VERDICT.ESCALATE])).toBe(true);
    expect(closeLineSpokenForVerdict('NO_ACTION', [CLOSE_SENTENCE_BY_VERDICT.NO_ACTION])).toBe(true);
  });

  it('tolerates case, punctuation and whitespace drift', () => {
    const messy = '  this TRANSFER is frozen and an incident is open the payment is not released goodbye!! ';
    expect(closeLineSpokenForVerdict('FREEZE', [messy])).toBe(true);
  });

  it('concatenates every agent line, so a sentence split across two transcript records still matches', () => {
    expect(
      closeLineSpokenForVerdict('FREEZE', ['This transfer is frozen and an incident is open.', 'The payment is not released. Goodbye.']),
    ).toBe(true);
  });

  it('accepts the lenient fallback: the verdict\'s own distinguishing (first) clause verbatim, plus a REWORDED second clause, plus "goodbye"', () => {
    // Founder ruling 2026-09-16: STAGE and FREEZE now share their final clause ("The payment
    // is not released"), so that shared clause can no longer be what proves which verdict was
    // spoken -- only FREEZE's own first clause can. A live model rewording the shared clause
    // must still match as long as the distinguishing clause and "goodbye" are both present.
    expect(
      closeLineSpokenForVerdict('FREEZE', [
        'This transfer is frozen and an incident is open. Nothing further will move on this account. Goodbye.',
      ]),
    ).toBe(true);
  });

  it('does NOT match on "goodbye" alone, with no matching distinguishing clause', () => {
    expect(closeLineSpokenForVerdict('FREEZE', ['Alright, goodbye.'])).toBe(false);
  });

  it('does NOT match on the distinguishing clause alone, with no "goodbye" (e.g. cut off before it)', () => {
    expect(closeLineSpokenForVerdict('FREEZE', ['This transfer is frozen and nothing has moved.'])).toBe(false);
  });

  it('does NOT match a DIFFERENT verdict\'s close sentence', () => {
    expect(closeLineSpokenForVerdict('FREEZE', [CLOSE_SENTENCE_BY_VERDICT.STAGE])).toBe(false);
    expect(closeLineSpokenForVerdict('STAGE', [CLOSE_SENTENCE_BY_VERDICT.FREEZE])).toBe(false);
  });

  it('does NOT cross-match via the lenient fallback either: the shared "payment is not released" clause plus "goodbye" never satisfies STAGE for a FREEZE transcript', () => {
    expect(
      closeLineSpokenForVerdict('STAGE', [
        'This transfer is frozen and an incident is open. The payment is not released. Goodbye.',
      ]),
    ).toBe(false);
  });

  it('does NOT match an interrupted, incomplete reply (the miller-patient regression shape)', () => {
    expect(closeLineSpokenForVerdict('FREEZE', ['Please provide the'])).toBe(false);
  });

  it('returns false for no agent lines at all', () => {
    expect(closeLineSpokenForVerdict('FREEZE', [])).toBe(false);
  });
});

describe('DISTINGUISHING_CLAUSE_BY_VERDICT', () => {
  it('gives every verdict a clause that is unique across all four verdicts', () => {
    const values = Object.values(DISTINGUISHING_CLAUSE_BY_VERDICT);
    expect(new Set(values).size).toBe(values.length);
  });

  it('is present, non-empty, for every verdict in CLOSE_SENTENCE_BY_VERDICT', () => {
    for (const verdict of Object.keys(CLOSE_SENTENCE_BY_VERDICT) as Array<keyof typeof CLOSE_SENTENCE_BY_VERDICT>) {
      expect(DISTINGUISHING_CLAUSE_BY_VERDICT[verdict].length).toBeGreaterThan(0);
    }
  });
});

describe('waitForPatientTurn', () => {
  it("resolves 'speak' once a normal (non-holding, non-closing) reply settles", async () => {
    const client = makeFakeClient();
    client.audioTimestamps.length = 0;
    const warnings: string[] = [];

    const resultPromise = waitForPatientTurn(client, 5000, warnings);
    await sleep(20);
    client.audioTimestamps.push(performance.now() - client.startedAt);
    client.setAgentLine('Just to confirm, the beneficiary is Meridian Supply. Is that correct?');

    const result = await resultPromise;

    expect(result.outcome).toBe('speak');
    expect(warnings).toEqual([]);
  }, 10_000);

  it("resolves 'stop' when the settled reply is one of the engine's CLOSE sentences -- the caller stops talking", async () => {
    const client = makeFakeClient();
    client.audioTimestamps.length = 0;
    const warnings: string[] = [];

    const resultPromise = waitForPatientTurn(client, 5000, warnings);
    await sleep(20);
    client.audioTimestamps.push(performance.now() - client.startedAt);
    client.setAgentLine(ENGINE_CLOSE_SENTENCES[0]!);

    const result = await resultPromise;

    expect(result.outcome).toBe('stop');
  }, 10_000);

  it("resolves 'fail' (agent_silent_after_hold, the bug this feature exists to catch) when a holding line is followed by silence past agentSilenceFailMs", async () => {
    const client = makeFakeClient();
    client.audioTimestamps.length = 0;
    const warnings: string[] = [];

    // Short agentSilenceFailMs (100ms) so this test doesn't wait the real 12s default --
    // same pattern as every other short-timeoutMs test in this file.
    const resultPromise = waitForPatientTurn(client, 100, warnings);
    await sleep(20);
    client.audioTimestamps.push(performance.now() - client.startedAt);
    client.setAgentLine('One moment while I verify that.');

    const result = await resultPromise;

    expect(result.outcome).toBe('fail');
  }, 10_000);

  it('loops past a holding line and resolves speak once a real reply follows and settles (a holding line is never assumed to be the final answer)', async () => {
    const client = makeFakeClient();
    client.audioTimestamps.length = 0;
    const warnings: string[] = [];

    const resultPromise = waitForPatientTurn(client, 5000, warnings);
    await sleep(20);
    client.audioTimestamps.push(performance.now() - client.startedAt);
    client.setAgentLine('One moment while I verify that.');

    // A further, real reply arrives well after the holding line's own ~700ms settle window,
    // but comfortably inside the 5000ms agentSilenceFailMs given to this wait.
    setTimeout(() => {
      client.audioTimestamps.push(performance.now() - client.startedAt);
      client.setAgentLine('Yes, verified. The beneficiary is Meridian Supply.');
    }, 900);

    const result = await resultPromise;

    expect(result.outcome).toBe('speak');
    expect(warnings).toEqual([]);
  }, 10_000);

  it('resolves speak with a warning (the ordinary tolerant fallback) when no reply ever starts at all -- never a fail, since no holding line preceded the silence', async () => {
    const client = makeFakeClient();
    client.audioTimestamps.length = 0;
    const warnings: string[] = [];

    const result = await waitForPatientTurn(client, 60, warnings);

    expect(result.outcome).toBe('speak');
    expect(warnings.some((w) => w.includes('no agent reply started within 60ms'))).toBe(true);
  }, 10_000);

  // PROVEN gap (2026-09-14, scripts/rehearse/reports/2026-09-14T13-47-07-miller-patient
  // .diagnostics.json): a CLOSE-retry reply landed with reply.started === reply.done (64ms)
  // and produced NO transcript.agent line at all. The old code judged the turn by whatever
  // agent text happened to already be sitting in the transcript (here, a stale line from the
  // PREVIOUS reply) and fell through to 'speak' -- a person does not answer a reply that said
  // nothing. These four tests prove the fix: such a reply is now ignored outright (the caller
  // keeps waiting, still bounded by agentSilenceFailMs), and a genuinely spoken reply -- via
  // either a transcript line or at least MIN_SPOKEN_MS of audio -- is still accepted.
  it("ignores a reply with NO transcript line and effectively no audio (reply.audio.first === reply.done) -- never falls through to stale earlier text", async () => {
    const client = makeFakeClient();
    client.audioTimestamps.length = 0;
    const warnings: string[] = [];

    const resultPromise = waitForPatientTurn(client, 5000, warnings);
    await sleep(20);
    // The empty CLOSE-retry reply: exactly one audio frame, no transcript line appended.
    client.audioTimestamps.push(performance.now() - client.startedAt);

    // A further, real reply follows well within agentSilenceFailMs -- proves the caller kept
    // waiting instead of resolving off the empty reply (or any stale text already present).
    setTimeout(() => {
      client.audioTimestamps.push(performance.now() - client.startedAt);
      client.setAgentLine('Just to confirm, the beneficiary is Meridian Supply. Is that correct?');
    }, 900);

    const result = await resultPromise;

    expect(result.outcome).toBe('speak');
    expect(warnings).toEqual([]);
  }, 10_000);

  it('ignores a short reply too -- audio present but under MIN_SPOKEN_MS, and no transcript line', async () => {
    const client = makeFakeClient();
    client.audioTimestamps.length = 0;
    const warnings: string[] = [];

    const resultPromise = waitForPatientTurn(client, 5000, warnings);
    await sleep(20);
    const anchorAt = performance.now() - client.startedAt;
    client.audioTimestamps.push(anchorAt);
    client.audioTimestamps.push(anchorAt + (MIN_SPOKEN_MS - 400)); // under MIN_SPOKEN_MS, no transcript

    setTimeout(() => {
      client.audioTimestamps.push(performance.now() - client.startedAt);
      client.setAgentLine('Just to confirm, the beneficiary is Meridian Supply. Is that correct?');
    }, 900);

    const result = await resultPromise;

    expect(result.outcome).toBe('speak');
    expect(warnings).toEqual([]);
  }, 10_000);

  it('accepts a reply as spoken once it has at least MIN_SPOKEN_MS of audio, even before any transcript line has arrived', async () => {
    const client = makeFakeClient();
    client.audioTimestamps.length = 0;
    const warnings: string[] = [];

    const resultPromise = waitForPatientTurn(client, 5000, warnings);
    await sleep(20);
    const anchorAt = performance.now() - client.startedAt;
    client.audioTimestamps.push(anchorAt);
    client.audioTimestamps.push(anchorAt + MIN_SPOKEN_MS + 50); // at/over MIN_SPOKEN_MS, no transcript

    const result = await resultPromise;

    expect(result.outcome).toBe('speak');
    expect(warnings).toEqual([]);
  }, 10_000);

  it('accepts a normal, fully-transcribed substantive reply as spoken (unaffected by the empty-reply fix)', async () => {
    const client = makeFakeClient();
    client.audioTimestamps.length = 0;
    const warnings: string[] = [];

    const resultPromise = waitForPatientTurn(client, 5000, warnings);
    await sleep(20);
    client.audioTimestamps.push(performance.now() - client.startedAt);
    client.setAgentLine('Please restate the dollar amount you just requested.');

    const result = await resultPromise;

    expect(result.outcome).toBe('speak');
    expect(warnings).toEqual([]);
  }, 10_000);

  // PROVEN gap (2026-09-14, same report): the run's THIRD close-retry reply actually began
  // "This transfer is frozen" but got interrupted mid-sentence by the caller's next scripted
  // line before the sentence -- and the goodbye -- ever finished. `waitForPatientTurn` must
  // stop the caller the moment a close sentence BEGINS, without waiting for it to fully
  // settle (the exact case `isClosingLine`, which requires the whole sentence, cannot catch).
  it('stops the instant the agent begins a close sentence, even from a partial/interrupted transcript line -- never waits for the full settle window or lets the caller speak over it', async () => {
    const client = makeFakeClient();
    client.audioTimestamps.length = 0;
    const warnings: string[] = [];

    const startedAt = performance.now();
    const resultPromise = waitForPatientTurn(client, 5000, warnings);
    await sleep(20);
    client.audioTimestamps.push(performance.now() - client.startedAt);
    // Only the opening clause has been transcribed so far -- not the full FREEZE close
    // sentence -- exactly the "(interrupted) This transfer is frozen" shape from the report.
    client.setAgentLine('This transfer is frozen');

    const result = await resultPromise;
    const elapsed = performance.now() - startedAt;

    expect(result.outcome).toBe('stop');
    expect(warnings).toEqual([]);
    // Decisively faster than SILENCE_MS (700ms): proves this resolved on the partial-close
    // match, not by falling through to the ordinary settle-then-judge path.
    expect(elapsed).toBeLessThan(400);
  }, 10_000);
});

// PROVEN gap (2026-09-14, today's reports for miller-patient/structuring-two-wires/
// single-wrong-answer/hangup-after-request/judge-out-of-scope/prompt-injection-midcall,
// each: "Call ended reason: caller_ended" with "Close line: n/a (caller ended)" and no
// goodbye in the agent transcript, graded PASS on verdict alone): run.ts used to send its
// own `end` unconditionally right after the verdict/settle wait. `waitForServerHangup` is
// the fix -- it waits for the SERVER's own `ended` event and only ends the call itself, as a
// last resort, if that wait expires.
describe('waitForServerHangup', () => {
  it('calls sendEnd and reports self_ended: true once the wait window expires with no server-initiated ended event', async () => {
    const client: CallClient = {
      startedAt: performance.now(),
      send() {},
      close() {},
      stateHistory: [],
      audioTimestamps: [],
      linkEvents: [],
      latestState: () => null,
      onEnded() {},
      endedReason: () => null,
      async waitForEnded(timeoutMs: number) {
        // Simulates "the server never ends the call": every wait window (the long
        // server-wait AND the short fallback wait after the harness sends `end` itself)
        // times out with no reason observed.
        await sleep(Math.min(timeoutMs, 30));
        return null;
      },
    };
    let sendEndCalls = 0;

    const result = await waitForServerHangup(client, 40, () => {
      sendEndCalls++;
    }, 40);

    expect(sendEndCalls).toBe(1);
    expect(result.self_ended).toBe(true);
    expect(result.ended_reason).toBeNull();
  });

  it("resolves with the server's own ended reason (e.g. agent_closed) and never calls sendEnd when it arrives before the wait window expires", async () => {
    const client: CallClient = {
      startedAt: performance.now(),
      send() {},
      close() {},
      stateHistory: [],
      audioTimestamps: [],
      linkEvents: [],
      latestState: () => null,
      onEnded() {},
      endedReason: () => null,
      async waitForEnded() {
        await sleep(10);
        return 'agent_closed';
      },
    };
    let sendEndCalls = 0;

    const result = await waitForServerHangup(client, 5000, () => {
      sendEndCalls++;
    }, 1000);

    expect(sendEndCalls).toBe(0);
    expect(result.self_ended).toBe(false);
    expect(result.ended_reason).toBe('agent_closed');
  });

  it('CLOSE_WAIT_MS gives margin over the server\'s own CLOSE hard cap (packages/server/src/call/session.ts CLOSE_TOTAL_MS = 45s)', () => {
    expect(CLOSE_WAIT_MS).toBeGreaterThan(45_000);
  });
});

// PROVEN gap (2026-09-14, same reports as above): `runTurns` used to always run through
// every scripted turn (or stop only on a patient-mode close/fail), leaving run.ts to decide
// unconditionally when to hang up. `ScenarioTurn.hang_up` (types.ts) is the one legitimate
// opt-in for a script whose caller deliberately walks away without waiting for a goodbye
// (e.g. judge-out-of-scope) -- these prove `runTurns` itself stops the instant such a turn
// has been spoken and reports it via `caller_hung_up`, and that every other run correctly
// reports `caller_hung_up: false` so run.ts knows to wait for the server's own hang-up
// instead. Uses REAL `say`/`ffmpeg` synthesis (no network -- same convention as
// audio.test.ts) since `runTurns` calls `speakLine`/`streamPcm` directly; skips itself on a
// machine without those tools on PATH.
describe('runTurns: hang_up', () => {
  let toolsAvailable = true;

  beforeAll(async () => {
    try {
      await execFileAsync('say', ['-v', '?']);
      await execFileAsync('ffmpeg', ['-version']);
    } catch {
      toolsAvailable = false;
    }
  });

  function scenarioWithTurns(turns: ScenarioTurn[]): Scenario {
    return {
      name: 'hang-up-test-fixture',
      title: 'hang-up test fixture',
      description: '',
      source: 'inline test fixture, not a real scenario file',
      turns,
      expected: { verdict: 'NO_ACTION', max_wall_ms: 60000 },
    };
  }

  it('stops the instant a turn carrying hang_up: true has been spoken, never speaking any turn after it, and reports caller_hung_up: true', async () => {
    if (!toolsAvailable) {
      console.warn('turnController.test: `say`/`ffmpeg` not found on PATH -- skipping (macOS-only harness).');
      return;
    }
    const client = makeFakeClient();
    client.audioTimestamps.length = 0;
    // One reply audio frame shortly after start so turn 0's greeting-wait settles quickly
    // instead of waiting out the real 8s GREETING_TIMEOUT_MS.
    setTimeout(() => client.audioTimestamps.push(performance.now() - client.startedAt), 20);

    const s = scenarioWithTurns([
      { id: 'c1', text: 'Hi.' },
      { id: 'c2', text: 'Bye.', hang_up: true },
      { id: 'c3', text: 'This line must never be spoken.' },
    ]);

    const outcome = await runTurns(client, s, undefined);

    expect(outcome.caller_hung_up).toBe(true);
    expect(outcome.resolvedLines.map((l) => l.turn_id)).toEqual(['c1', 'c2']);
    expect(outcome.callerEndTimes.map((t) => t.turn_id)).toEqual(['c1', 'c2']);
  }, 30_000);

  it('reports caller_hung_up: false once every scripted turn is spoken and none of them carried hang_up', async () => {
    if (!toolsAvailable) {
      console.warn('turnController.test: `say`/`ffmpeg` not found on PATH -- skipping (macOS-only harness).');
      return;
    }
    const client = makeFakeClient();
    client.audioTimestamps.length = 0;
    setTimeout(() => client.audioTimestamps.push(performance.now() - client.startedAt), 20);

    const s = scenarioWithTurns([{ id: 'c1', text: 'Hi.' }]);

    const outcome = await runTurns(client, s, undefined);

    expect(outcome.caller_hung_up).toBe(false);
    expect(outcome.resolvedLines.map((l) => l.turn_id)).toEqual(['c1']);
  }, 30_000);
});
