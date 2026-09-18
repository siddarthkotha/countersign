// packages/server/test/question-double-ask-cap.test.ts
// P0 founder-observed live defect, two shapes -- see
// scripts/rehearse/reports/founder-2026-09-18/ (32cbb410, 95b9ad42, 391e2a37 contrast):
//
// Shape 1: an instructed READBACK/ASK_CHALLENGE reply asks the question, correctly, and
// `recordGoalCompletionAction` correctly logs it. AssemblyAI's own automatic reply then lands
// with no caller turn in between, saying nothing but the bare standing holding line ("One
// moment.", exactly) -- the ordering of AssemblyAI's automatic reply against our instructed
// one is nondeterministic (contrast 391e2a37, where the holding line lands BEFORE the
// instructed ask and nothing goes wrong). `maybeReaskQuestion`/`maybeArmHoldFollowup` used to
// read only THAT bare reply's own transcript and, finding no question in it, re-ask (and
// re-log) a question the caller had already heard once. PROVEN live: the caller heard every
// readback/challenge twice (32cbb410 57.8/59.4/60.1/65.5s and 72.1/77.4s; 95b9ad42
// 36.9/45.8s and 52.2/60.8s).
//
// Shape 2: the standing system_prompt for an unresolved rendering never goes away until the
// engine itself moves the goal on, so AssemblyAI's own ambient automatic replies can
// independently restate the SAME real question (not just a bare hold) multiple times, with no
// caller turn and no `reply.create` from us at all. PROVEN live: 95b9ad42 78.4/83.5/97.6/
// 110.4s, one LIVE_COMMITMENT challenge logged FOUR times through the caller's own "I did not
// mention anyone." twice.
//
// Fix (session.ts): `questionAskedGoalKey`/`questionAskedCount` (see that field's own doc
// comment) track how many times a rendering has actually been logged as asked.
//  - `maybeReaskQuestion` and `maybeArmHoldFollowup` both refuse to fire for a bare holding-line
//    reply once the current rendering already has `questionAskedCount >= 1` (shape 1).
//  - `recordGoalCompletionAction` refuses to log more than QUESTION_ASKED_MAX (2) occurrences
//    of the same rendering, however it was spoken (shape 2).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MERIDIAN, mockToolResult } from '@countersign/engine';
import type { CallContext, ServerEvent, ChallengeSpec } from '@countersign/engine';
import { CallSession } from '../src/call/session.js';
import { FakeAaiSocket } from '../src/aai/fake.js';
import scenarioB from '../../engine/corpus/scenario-b-miller-fraud.json' with { type: 'json' };

const CALL_DANA: CallContext = { session_id: 'sess-double-ask-readback', origin_kind: 'registered_device', origin_geo: 'Austin, TX' };
const CALL_B: CallContext = scenarioB.call as CallContext;
const CALL_CHALLENGE_CAP: CallContext = { session_id: 'sess-double-ask-cap', origin_kind: 'registered_device', origin_geo: 'Austin, TX' };

function newSession(
  clock: { now: number },
  call: CallContext,
  aai: FakeAaiSocket,
  sent: ServerEvent[],
  diagEvents: { kind: string; detail: unknown }[]
): CallSession {
  const session = new CallSession({
    session_id: call.session_id,
    seed: MERIDIAN,
    call,
    aai,
    now: () => clock.now,
    onServerEvent: (e) => sent.push(e),
    mock: mockToolResult,
    onDiagnostic: (kind, detail) => diagEvents.push({ kind, detail }),
  });
  session.start();
  return session;
}

const replyCreatesOf = (aai: FakeAaiSocket) => aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create');

// P0 fix (2026-09-18, call/session.ts's own AUTOMATIC_REPLY_SETTLE_MS doc comment): a
// caller-turn-triggered fresh QUESTION_GOALS send is now deferred by this many ms instead of
// synchronous, so AssemblyAI's own automatic reply for the same turn (if one is coming) has
// time to start first.
const AUTOMATIC_REPLY_SETTLE_MS = 150; // CallSession.AUTOMATIC_REPLY_SETTLE_MS

describe('CallSession -- double-ask fix (P0, 2026-09-18): a rendering already asked once is never re-asked by a bare holding-line reply', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('(a) READBACK: instructed reply reads the field back and logs it; a later ambient automatic reply saying only "One moment." triggers no re-ask and no second readback_issued', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newSession(clock, CALL_DANA, aai, sent, diagEvents);

    clock.now = 1000;
    aai.emit({
      type: 'transcript.user',
      item_id: 'c1',
      text: "This is Dana Whitfield, corporate treasury. I need to wire it to Meridian Supply — $84,500, account ending 4471 — moving today instead of Friday, approved in yesterday's close meeting.",
    });
    expect(session.last?.goal.code).toBe('ASK_CHALLENGE'); // the engine's own trap-fact challenge asked first

    // Answer the trap challenge correctly (refuse the trap value) -- this drives the engine on
    // to READBACK, the goal under test here (same conversation shape as hold-followup.test.ts's
    // own `driveToSealedStage` helper).
    vi.advanceTimersByTime(AUTOMATIC_REPLY_SETTLE_MS);
    clock.now = 1200;
    aai.emit({ type: 'reply.started', reply_id: 'trap-ask' });
    aai.emit({ type: 'transcript.agent', item_id: 'trap-ask', reply_id: 'trap-ask', text: session.last!.goal.hint, interrupted: false });
    aai.emit({ type: 'reply.done', reply_id: 'trap-ask', status: 'completed' });
    clock.now = 1400;
    aai.emit({ type: 'transcript.user', item_id: 'c2', text: "No, that's wrong. It's Meridian Supply." });

    expect(session.last?.goal.code).toBe('READBACK');
    const readbackSentence = session.last!.goal.hint;
    expect(readbackSentence).toContain('?');

    const readbackIssuedActions = () => session.logs.actions.filter((a) => a.kind === 'readback_issued');

    // The instructed reply (tick_end, auto-sent for the fresh READBACK goal) correctly speaks
    // the readback sentence.
    vi.advanceTimersByTime(AUTOMATIC_REPLY_SETTLE_MS);
    clock.now = 1500;
    aai.emit({ type: 'reply.started', reply_id: 'ask-1' });
    aai.emit({ type: 'transcript.agent', item_id: 'ask-1', reply_id: 'ask-1', text: readbackSentence, interrupted: false });
    aai.emit({ type: 'reply.done', reply_id: 'ask-1', status: 'completed' });
    expect(readbackIssuedActions()).toHaveLength(1);
    expect(session.last?.goal.code).toBe('READBACK'); // still the same rendering -- caller has not confirmed yet

    const sendsBeforeAmbient = replyCreatesOf(aai).length;

    // PROVEN live shape (32cbb410 59.4s / 95b9ad42 45.8s etc): an AssemblyAI automatic reply
    // (never one we instructed -- no reply.create preceded it) lands with no caller turn in
    // between, saying nothing but the bare standing holding line.
    clock.now = 1900;
    aai.emit({ type: 'reply.started', reply_id: 'auto-1' });
    aai.emit({ type: 'transcript.agent', item_id: 'auto-1', reply_id: 'auto-1', text: 'One moment.', interrupted: false });
    aai.emit({ type: 'reply.done', reply_id: 'auto-1', status: 'completed' });

    // Nothing sent synchronously, and nothing sent even after every timer this file arms has
    // had a chance to fire (question-reask 400ms, hold-followup 2500ms).
    vi.advanceTimersByTime(3000);
    expect(diagEvents.filter((e) => e.kind === 'question_reask_sent')).toHaveLength(0);
    expect(diagEvents.filter((e) => e.kind === 'hold_followup_sent')).toHaveLength(0);
    expect(replyCreatesOf(aai).length).toBe(sendsBeforeAmbient);
    expect(readbackIssuedActions()).toHaveLength(1); // exactly one -- the caller heard it once, not twice
  });

  it('(b) ASK_CHALLENGE: instructed reply asks the challenge and logs it; a later ambient automatic reply saying only "One moment." triggers no re-ask and no second challenge_issued', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newSession(clock, CALL_B, aai, sent, diagEvents);

    clock.now = 1000;
    aai.emit({ type: 'transcript.user', item_id: 'c1', text: scenarioB.conversation[0]!.text });
    expect(session.last?.state).toBe('CHALLENGE');
    expect(session.last?.goal.code).toBe('ASK_CHALLENGE');
    const sentence1 = session.last!.goal.challenge!.speak!;
    expect(sentence1).toBeTruthy();

    const challengeIssuedActions = () => session.logs.actions.filter((a) => a.kind === 'challenge_issued');

    vi.advanceTimersByTime(AUTOMATIC_REPLY_SETTLE_MS);
    clock.now = 1800;
    aai.emit({ type: 'reply.started', reply_id: 'ask-1' });
    aai.emit({ type: 'transcript.agent', item_id: 'ask-1', reply_id: 'ask-1', text: sentence1, interrupted: false });
    aai.emit({ type: 'reply.done', reply_id: 'ask-1', status: 'completed' });
    expect(challengeIssuedActions()).toHaveLength(1);

    const sendsBeforeAmbient = replyCreatesOf(aai).length;

    // Same PROVEN live shape as (a), this time for ASK_CHALLENGE.
    clock.now = 2200;
    aai.emit({ type: 'reply.started', reply_id: 'auto-1' });
    aai.emit({ type: 'transcript.agent', item_id: 'auto-1', reply_id: 'auto-1', text: 'One moment.', interrupted: false });
    aai.emit({ type: 'reply.done', reply_id: 'auto-1', status: 'completed' });

    vi.advanceTimersByTime(3000);
    expect(diagEvents.filter((e) => e.kind === 'question_reask_sent')).toHaveLength(0);
    expect(diagEvents.filter((e) => e.kind === 'hold_followup_sent')).toHaveLength(0);
    expect(replyCreatesOf(aai).length).toBe(sendsBeforeAmbient);
    expect(challengeIssuedActions()).toHaveLength(1);
  });

  it('(c) unaffected: the pre-existing legitimate re-ask still fires once when the INSTRUCTED reply itself never asked anything (holding line instead of the question, nothing logged yet)', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newSession(clock, CALL_B, aai, sent, diagEvents);

    clock.now = 1000;
    aai.emit({ type: 'transcript.user', item_id: 'c1', text: scenarioB.conversation[0]!.text });
    expect(session.last?.goal.code).toBe('ASK_CHALLENGE');
    const sentence1 = session.last!.goal.challenge!.speak!;

    const challengeIssuedActions = () => session.logs.actions.filter((a) => a.kind === 'challenge_issued');

    // The INSTRUCTED reply itself (tick_end) fails to ask anything -- nothing logged yet for
    // this rendering (`questionAskedCount` stays 0), so the pre-existing reask mechanism must
    // still repair it, unaffected by this fix.
    vi.advanceTimersByTime(AUTOMATIC_REPLY_SETTLE_MS);
    clock.now = 1800;
    aai.emit({ type: 'reply.started', reply_id: 'ask-1' });
    aai.emit({ type: 'transcript.agent', item_id: 'ask-1', reply_id: 'ask-1', text: 'Checking the record.', interrupted: false });
    aai.emit({ type: 'reply.done', reply_id: 'ask-1', status: 'completed' });
    expect(challengeIssuedActions()).toHaveLength(0);

    vi.advanceTimersByTime(400);
    expect(diagEvents.filter((e) => e.kind === 'question_reask_sent')).toHaveLength(1);

    clock.now = 2300;
    aai.emit({ type: 'reply.started', reply_id: 'reask-1' });
    aai.emit({ type: 'transcript.agent', item_id: 'reask-1', reply_id: 'reask-1', text: sentence1, interrupted: false });
    aai.emit({ type: 'reply.done', reply_id: 'reask-1', status: 'completed' });
    expect(challengeIssuedActions()).toHaveLength(1);
  });
});

describe('CallSession -- double-ask fix (P0, 2026-09-18): a rendering is never logged as asked more than QUESTION_ASKED_MAX (2) times, whatever the path', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('(d) four consecutive completed replies that each genuinely ask the SAME LIVE_COMMITMENT challenge (95b9ad42 78.4/83.5/97.6/110.4s shape) log challenge_issued at most twice for that rendering', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newSession(clock, CALL_CHALLENGE_CAP, aai, sent, diagEvents);

    const CHALLENGE_SPEAK = 'Who was the approver you mentioned?';
    const challenge: ChallengeSpec = {
      challenge_id: 'sess-double-ask-cap-challenge-1',
      kind: 'LIVE_COMMITMENT',
      field: 'beneficiary',
      ask: 'Ask the caller to restate the approver they claimed earlier.',
      speak: CHALLENGE_SPEAK,
      expect: { commitment_claim_id: 'claim-1' },
    };
    session.last = {
      ...session.last!,
      state: 'CHALLENGE',
      goal: { code: 'ASK_CHALLENGE', hint: CHALLENGE_SPEAK, keyterms: [], turn_detection_hint: 'patient', challenge },
    };

    const internals = session as unknown as {
      recordGoalCompletionAction: (replyId: string, status: string) => void;
      replyGoalAtStart: Map<string, string>;
      replyTranscripts: Map<string, string>;
    };

    const challengeIssuedActions = () =>
      session.logs.actions.filter((a) => a.kind === 'challenge_issued' && (a as { challenge_id?: string }).challenge_id === challenge.challenge_id);

    // Four separate completed replies, each genuinely asking the identical rendering (real "?"
    // content, not a bare hold) -- the PROVEN live shape: the first is our own instructed ask,
    // the other three are AssemblyAI's own ambient automatic replies independently restating
    // the still-standing question because the goal never advanced (no caller answer in
    // between). None of this file's own sending mechanisms are exercised here on purpose --
    // this isolates `recordGoalCompletionAction`'s own cap.
    const replies = ['ask-1', 'auto-1', 'auto-2', 'auto-3'];
    for (const replyId of replies) {
      internals.replyGoalAtStart.set(replyId, 'ASK_CHALLENGE');
      internals.replyTranscripts.set(replyId, `One moment. ${CHALLENGE_SPEAK}`);
      internals.recordGoalCompletionAction(replyId, 'completed');
    }

    expect(challengeIssuedActions()).toHaveLength(2); // never more than QUESTION_ASKED_MAX
  });

  it('(d) the same cap applies to READBACK', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newSession(clock, CALL_CHALLENGE_CAP, aai, sent, diagEvents);

    const READBACK_SENTENCE = 'Just to confirm, the account ends in 4 4 7 1. Is that correct?';
    session.last = {
      ...session.last!,
      state: 'CLAIM',
      goal: {
        code: 'READBACK',
        hint: READBACK_SENTENCE,
        keyterms: [],
        turn_detection_hint: 'patient',
        readback: { field: 'account_last4', value: '4471' },
      },
    };

    const internals = session as unknown as {
      recordGoalCompletionAction: (replyId: string, status: string) => void;
      replyGoalAtStart: Map<string, string>;
      replyTranscripts: Map<string, string>;
    };

    const readbackIssuedActions = () => session.logs.actions.filter((a) => a.kind === 'readback_issued');

    const replies = ['ask-1', 'auto-1', 'auto-2', 'auto-3'];
    for (const replyId of replies) {
      internals.replyGoalAtStart.set(replyId, 'READBACK');
      internals.replyTranscripts.set(replyId, READBACK_SENTENCE);
      internals.recordGoalCompletionAction(replyId, 'completed');
    }

    expect(readbackIssuedActions()).toHaveLength(2);
  });
});
