// Exercises the pure/pollable pieces of turnController.ts against a FAKE CallClient (no
// network, no real WebSocket) -- computeTurnGaps' post-hoc math, and waitForVerdict's
// polling loop against a client whose `latestState()` changes over time.
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import {
  computeTurnGaps,
  ENGINE_CLOSE_SENTENCES,
  isClosingLine,
  isHoldingLine,
  maybeDropAai,
  scriptedCallerShouldStop,
  waitForBargeIn,
  waitForGreeting,
  waitForOpeningTurn,
  waitForPatientTurn,
  waitForVerdict,
} from '../turnController.js';
import type { CallClient } from '../wsClient.js';
import type { ScenarioTurn } from '../types.js';
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
});
