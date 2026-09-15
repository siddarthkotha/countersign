// packages/server/test/question-fragment-brake.test.ts
// Design E follow-up, BRAKE (2026-09-15, measured live on deploy 39 against deploy 36 -- see
// scratchpad/fragment-analysis.md sections A/C/D(3), and session.ts's own doc comment on
// `shouldBrakeFreshQuestion`): a mid-sentence pause can split one caller line into two
// AssemblyAI `transcript.user` turns 2.1-2.3s apart (PROVEN). If the engine has silently
// advanced the current goal to a DIFFERENT question between the two fragments (fsm.ts's own
// `selectChallenge` advances the instant a challenge is confirmed ASKED, independent of
// grading), the server used to proactively ask that new question off the second fragment
// alone -- three questions asked in 17s on one live bundle. `session.ts`'s
// `shouldBrakeFreshQuestion` holds that send back when the previous instructed question is
// still unanswered and the fragments landed close together, deferring to the existing
// catch-up mechanism (`maybeSendReplyCreateAfterReplyDone`) instead of losing the question.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MERIDIAN, mockToolResult } from '@countersign/engine';
import type { CallContext, ServerEvent } from '@countersign/engine';
import { CallSession } from '../src/call/session.js';
import { FakeAaiSocket } from '../src/aai/fake.js';
import scenarioB from '../../engine/corpus/scenario-b-miller-fraud.json' with { type: 'json' };

const CALL_B = scenarioB.call as CallContext;

function newSession(
  clockRef: { now: number },
  call: CallContext,
  aai: FakeAaiSocket,
  sent: ServerEvent[],
  diagEvents: { kind: string; detail: unknown }[] = []
): CallSession {
  return new CallSession({
    session_id: call.session_id,
    seed: MERIDIAN,
    call,
    aai,
    now: () => clockRef.now,
    onServerEvent: (e) => sent.push(e),
    mock: mockToolResult,
    onDiagnostic: (kind, detail) => diagEvents.push({ kind, detail }),
  });
}

function replyCreatesOf(aai: FakeAaiSocket): { type?: string; instructions?: string }[] {
  return aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create') as {
    type?: string;
    instructions?: string;
  }[];
}

/** Drives the FIRST ASK_CHALLENGE (sess-b-1, Scenario B's own counsel/escrow question) to
 *  "asked and confirmed", then advances the engine's own goal to sess-b-2 (a DIFFERENT, fresh
 *  QUESTION_GOALS rendering) via ONE caller fragment that does not answer it -- exactly the
 *  live shape fragment-analysis.md section A/C actually documents (a token-graded challenge,
 *  e.g. sess-b-1's own SEED_FACT counsel/escrow question, is graded the INSTANT any caller
 *  reply lands, matching accept_tokens or not -- challenges.ts's `gradeChallenges` never
 *  defers a token-based grade the way it now defers a content-shaped TRAP_FACT/LIVE_COMMITMENT
 *  grade -- see `challengeReplyWindowStatus`'s own doc comment, 2026-09-15/16 Dana regression
 *  fix). By the time this returns, `lastAskedQuestionKey` is sess-b-1's own key,
 *  `previousCallerTranscriptAtMs` is this fragment's own t_ms, and the current goal is already
 *  sess-b-2 -- exactly the precondition the fragment brake needs to be meaningfully exercised,
 *  reached here the same way a real second fragment 2.1-2.3s later than a REAL caller turn
 *  would (never a phantom event with no caller reply at all, which the Dana-regression fix now
 *  correctly holds open for the caller's full `challenge_answer_window_ms`). */
const FIRST_CHALLENGE_CONFIRMED_AT_MS = 1600;

function askAndConfirmFirstChallenge(session: CallSession, aai: FakeAaiSocket, clock: { now: number }): void {
  clock.now = 1000;
  aai.emit({ type: 'transcript.user', item_id: 'c1', text: scenarioB.conversation[0]!.text });
  expect(session.last?.goal.code).toBe('ASK_CHALLENGE');
  expect(session.last?.goal.challenge?.challenge_id).toBe('sess-b-1');

  clock.now = 1200;
  aai.emit({ type: 'reply.started', reply_id: 'a1' });
  aai.emit({
    type: 'transcript.agent',
    item_id: 'x-a1',
    text: scenarioB.conversation[1]!.text, // ends with "?" -- confirmed asked
    reply_id: 'a1',
    interrupted: false,
  });
  clock.now = 1400;
  aai.emit({ type: 'reply.done', reply_id: 'a1', status: 'completed' });

  expect(session.logs.actions.some((a) => a.kind === 'challenge_issued')).toBe(true);
  expect(session.last?.goal.code).toBe('ASK_CHALLENGE');
  expect(session.last?.goal.challenge?.challenge_id).toBe('sess-b-1'); // still genuinely awaiting

  // A real caller reply that does not answer sess-b-1 (no "calder"/"finch") -- sess-b-1 is
  // SEED_FACT (accept_tokens-graded), so this grades FAIL immediately, on this same tick,
  // independent of how much time has elapsed since it was issued.
  clock.now = FIRST_CHALLENGE_CONFIRMED_AT_MS;
  aai.emit({ type: 'transcript.user', item_id: 'fragment0', text: 'And make it two point one million.' });

  expect(session.last?.goal.code).toBe('ASK_CHALLENGE');
  expect(session.last?.goal.challenge?.challenge_id).toBe('sess-b-2'); // now genuinely advanced
}

describe('BRAKE (2026-09-15): a fresh question discovered off a fragment landing close to the one before it is held back, not lost', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('two fragments 2.2s apart with a challenge id change yield one instructed question for the new challenge (deferred, not doubled)', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newSession(clock, CALL_B, aai, sent, diagEvents);
    session.start();

    askAndConfirmFirstChallenge(session, aai, clock);
    const baseline = replyCreatesOf(aai).length; // just sess-b-1's own send
    // fragment0 (inside the helper above) itself lands close to c1 and is ALSO braked --
    // only diag events from here on are this test's own subject.
    const diagBaseline = diagEvents.length;

    // The fragment: 2.2s after sess-b-1 was confirmed asked (PROVEN gap range from
    // fragment-analysis.md section A), content that does NOT look like an answer attempt (no
    // name, no confirmation word) -- exactly the shape of the live "And make it $2.1 million."
    // trigger.
    clock.now = FIRST_CHALLENGE_CONFIRMED_AT_MS + 2200;
    aai.emit({ type: 'transcript.user', item_id: 'frag1', text: 'And make it two point one million.' });

    // Braked: nothing new sent, but the brake diagnostic fired for the new challenge.
    expect(replyCreatesOf(aai)).toHaveLength(baseline);
    const brakeDiags = diagEvents.slice(diagBaseline).filter((e) => e.kind === 'question_fragment_brake_applied');
    expect(brakeDiags).toHaveLength(1);
    expect((brakeDiags[0]!.detail as { goal_code: string }).goal_code).toBe('ASK_CHALLENGE');

    // The fragment's own turn still gets an automatic reply from AssemblyAI (unstoppable, per
    // Design E) -- an EMPTY one, per this same task's other fix. Its own reply.done is "the
    // next genuine turn" the brake defers to: the owed sess-b-2 question goes out right after.
    clock.now = FIRST_CHALLENGE_CONFIRMED_AT_MS + 2250;
    aai.emit({ type: 'reply.started', reply_id: 'auto-1' });
    clock.now = FIRST_CHALLENGE_CONFIRMED_AT_MS + 2700;
    aai.emit({ type: 'reply.done', reply_id: 'auto-1', status: 'completed' }); // no transcript.agent at all

    expect(replyCreatesOf(aai)).toHaveLength(baseline + 1); // exactly one, now, for sess-b-2
    const latest = replyCreatesOf(aai).at(-1)!;
    expect(latest.instructions).toBe(`Say exactly this and nothing else: "${session.last!.goal.challenge!.speak}"`);
    expect(session.last?.goal.challenge?.challenge_id).toBe('sess-b-2');

    // Never braked twice for the same key: no further reply.create leaks out from residual
    // timers once the owed question has actually gone out.
    vi.advanceTimersByTime(2000);
    expect(replyCreatesOf(aai)).toHaveLength(baseline + 1);
  });

  it('fragments 6s apart yield two, as today (the brake never applies outside the fragmentation window)', () => {
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newSession(clock, CALL_B, aai, sent, diagEvents);
    session.start();

    askAndConfirmFirstChallenge(session, aai, clock);
    const baseline = replyCreatesOf(aai).length;
    // fragment0 (inside the helper above) itself lands close to c1 and is ALSO braked --
    // only diag events from here on are this test's own subject.
    const diagBaseline = diagEvents.length;

    // 6s after sess-b-1 was confirmed asked -- well outside QUESTION_FRAGMENT_WINDOW_MS
    // (2500ms, ESTIMATE).
    clock.now = FIRST_CHALLENGE_CONFIRMED_AT_MS + 6000;
    aai.emit({ type: 'transcript.user', item_id: 'frag1', text: 'And make it two point one million.' });

    // Sent immediately -- no brake, exactly as before this fix.
    expect(replyCreatesOf(aai)).toHaveLength(baseline + 1);
    expect(diagEvents.slice(diagBaseline).some((e) => e.kind === 'question_fragment_brake_applied')).toBe(false);
    expect(session.last?.goal.challenge?.challenge_id).toBe('sess-b-2');
    const sent0 = replyCreatesOf(aai).at(-1)!;
    expect(sent0.instructions).toBe(`Say exactly this and nothing else: "${session.last!.goal.challenge!.speak}"`);
  });

  it('a fragment that IS an answer (contains a name) proceeds as today, even within the fragmentation window', () => {
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newSession(clock, CALL_B, aai, sent, diagEvents);
    session.start();

    askAndConfirmFirstChallenge(session, aai, clock);
    const baseline = replyCreatesOf(aai).length;
    // fragment0 (inside the helper above) itself lands close to c1 and is ALSO braked --
    // only diag events from here on are this test's own subject.
    const diagBaseline = diagEvents.length;

    // Same 2.2s gap as the braked case, but this fragment names a firm -- content overrides
    // timing (the caller really is answering something, fast).
    clock.now = FIRST_CHALLENGE_CONFIRMED_AT_MS + 2200;
    aai.emit({ type: 'transcript.user', item_id: 'frag1', text: 'Baker McKenzie is our counsel of record.' });

    expect(replyCreatesOf(aai)).toHaveLength(baseline + 1); // sent immediately, not braked
    expect(diagEvents.slice(diagBaseline).some((e) => e.kind === 'question_fragment_brake_applied')).toBe(false);
  });
});
