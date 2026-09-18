// packages/server/test/question-double-ask-catchup.test.ts
// P1 founder-observed live defect, still live on deploy 51 after four other founder-defect
// fixes that same day -- see scripts/rehearse/reports/2026-09-18T14-50-21-dana-patient
// .diagnostics.json (server_events, t_ms). Every readback in that call was spoken twice, the
// exact cycle three times over (amount, account, beneficiary):
//  - 60.2s caller says "Yes, that's correct."; 60.2s an AssemblyAI AMBIENT reply starts (no
//    reply.create of ours preceded it; our own send is correctly deferred 150ms by e99e17f's
//    AUTOMATIC_REPLY_SETTLE_MS).
//  - That ambient reply runs ~10s and speaks OUR OWN goal sentence, because the standing
//    system_prompt for the new goal is already in force: at 70.4s its transcript is "One
//    moment. Just to confirm, the account ends in 4 4 7 1. Is that correct?" -- the engine's
//    exact readbackSentence with a holding prefix. Its own reply.done correctly logs
//    readback_issued once (recordGoalCompletionAction reads `this.last.goal` for an
//    unlabelled reply).
//  - 70.6s, same instant, the server ALSO sends its own instructed reply.create (reason
//    reply_done_goal_diverged, `maybeSendReplyCreateAfterReplyDone`'s `owedQuestion` catch-up
//    branch) carrying the identical sentence, and at 76.2s the agent says it a SECOND time,
//    logging a second readback_issued.
//
// Root cause: the catch-up path's `owedQuestion` branch sent unconditionally, never checking
// whether the reply that just completed had already asked the current rendering's exact
// question -- unlike `maybeReaskQuestion`, which already has exactly this guard, but only for
// a reply LABELLED with the current goal (an ambient reply never is).
//
// Fix (session.ts, questionMatch.ts): the `owedQuestion` branch now checks
// `transcriptAsksExactSentence` (questionMatch.ts, new) against the completed reply's own
// transcript and the CURRENT goal's `verbatimQuestionSentence` -- and skips the send if it
// already matches. Deliberately NOT `transcriptAsksQuestion` (the bare-"?" heuristic
// `maybeReaskQuestion` uses) -- see (c) below for why that would regress the PROVEN F3 shape
// (design-e-turn-order.test.ts) where the ambient reply asks a completely different, unrelated
// question.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MERIDIAN, mockToolResult } from '@countersign/engine';
import type { CallContext, ServerEvent } from '@countersign/engine';
import { CallSession } from '../src/call/session.js';
import { FakeAaiSocket } from '../src/aai/fake.js';
import scenarioB from '../../engine/corpus/scenario-b-miller-fraud.json' with { type: 'json' };

const CALL_DANA: CallContext = { session_id: 'sess-catchup-readback', origin_kind: 'registered_device', origin_geo: 'Austin, TX' };
const CALL_B: CallContext = scenarioB.call as CallContext;

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

const replyCreatesOf = (aai: FakeAaiSocket) =>
  aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create') as { type?: string; instructions?: string }[];

// e99e17f's own AUTOMATIC_REPLY_SETTLE_MS: a caller-turn-triggered fresh QUESTION_GOALS send is
// deferred by this many ms so AssemblyAI's own automatic reply for the same turn, if one is
// coming, has time to start (and flip `speaking`) first.
const AUTOMATIC_REPLY_SETTLE_MS = 150; // CallSession.AUTOMATIC_REPLY_SETTLE_MS

describe('CallSession -- double-ask catch-up fix (P1, 2026-09-18 continued): the catch-up path never re-asks a question an ambient reply already spoke verbatim', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('(a) READBACK: an ambient reply (no reply.create of ours) speaks the exact goal sentence with a holding prefix before our deferred send fires -- no catch-up send, exactly one readback_issued, and the call still advances once the caller answers, onto a genuinely new rendering asked once', () => {
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
    expect(session.last?.goal.code).toBe('ASK_CHALLENGE'); // the engine's own trap-fact challenge, asked first

    // Answer the trap challenge correctly (refuse the trap value) -- drives the engine on to
    // READBACK, the goal under test.
    vi.advanceTimersByTime(AUTOMATIC_REPLY_SETTLE_MS);
    clock.now = 1200;
    aai.emit({ type: 'reply.started', reply_id: 'trap-ask' });
    aai.emit({ type: 'transcript.agent', item_id: 'x-trap-ask', reply_id: 'trap-ask', text: session.last!.goal.hint, interrupted: false });
    aai.emit({ type: 'reply.done', reply_id: 'trap-ask', status: 'completed' });
    clock.now = 1400;
    aai.emit({ type: 'transcript.user', item_id: 'c2', text: "No, that's wrong. It's Meridian Supply." });

    expect(session.last?.goal.code).toBe('READBACK');
    const readbackSentence1 = session.last!.goal.hint;
    expect(readbackSentence1).toContain('?');

    const readbackIssuedActions = () => session.logs.actions.filter((a) => a.kind === 'readback_issued');
    const sendsBefore = replyCreatesOf(aai).length;

    // PROVEN live shape (2026-09-18T14-50-21-dana-patient, 60.2s): an AssemblyAI ambient reply
    // for THIS caller turn starts almost immediately (PROVEN gap 4ms live) -- well within the
    // 150ms settle window -- and speaks the goal's own exact sentence, with a holding prefix,
    // because the standing system_prompt for this rendering is already in force.
    clock.now = 1404;
    aai.emit({ type: 'reply.started', reply_id: 'auto-1' });
    aai.emit({
      type: 'transcript.agent',
      item_id: 'x-auto-1',
      reply_id: 'auto-1',
      text: `One moment. ${readbackSentence1}`,
      interrupted: false,
    });
    const internals = session as unknown as { speaking: boolean };
    expect(internals.speaking).toBe(true);

    // The settle window elapses while 'auto-1' is still speaking -- the deferred fallback must
    // not fire (busy guard, unchanged).
    vi.advanceTimersByTime(AUTOMATIC_REPLY_SETTLE_MS);
    expect(replyCreatesOf(aai).length).toBe(sendsBefore);

    clock.now = 1900;
    aai.emit({ type: 'reply.done', reply_id: 'auto-1', status: 'completed' });

    // THE FIX: the catch-up path (owedQuestion branch) must NOT send a second, redundant
    // instructed ask -- the caller already heard these exact words, from 'auto-1' itself.
    expect(replyCreatesOf(aai).length).toBe(sendsBefore);
    expect(readbackIssuedActions()).toHaveLength(1); // exactly one -- not the PROVEN live two
    expect(session.last?.goal.code).toBe('READBACK'); // still unresolved -- caller has not confirmed yet

    // The call still advances once the caller answers -- nothing about suppressing the
    // catch-up send leaves this rendering stuck waiting for an ask that will never come.
    clock.now = 2200;
    aai.emit({ type: 'transcript.user', item_id: 'c3', text: "Yes, that's right." });
    // The call advanced -- either to a different goal entirely, or (Dana's flow has three
    // readback fields -- amount, account, beneficiary, same PROVEN live cycle the incident
    // record shows) the engine's very next readback field. Either way this is NOT the same
    // rendering asked before: same code is fine, the SENTENCE must differ.
    if (session.last?.goal.code === 'READBACK') {
      expect(session.last!.goal.hint).not.toBe(readbackSentence1);
    }

    // (d) a genuinely new rendering -- the engine's next readback field -- is still asked once,
    // through the ordinary (non-ambient) tick-end fallback, unaffected by this fix.
    if (session.last?.goal.code === 'READBACK') {
      const readbackSentence2 = session.last!.goal.hint;
      expect(readbackSentence2).not.toBe(readbackSentence1);
      const sendsBeforeSecond = replyCreatesOf(aai).length;
      vi.advanceTimersByTime(AUTOMATIC_REPLY_SETTLE_MS);
      const afterFallback = replyCreatesOf(aai);
      expect(afterFallback.length).toBe(sendsBeforeSecond + 1);
      expect(afterFallback.at(-1)!.instructions).toBe(`Say exactly this and nothing else: "${readbackSentence2}"`);
      clock.now = 2700;
      aai.emit({ type: 'reply.started', reply_id: 'a-second' });
      aai.emit({ type: 'transcript.agent', item_id: 'x-a-second', reply_id: 'a-second', text: readbackSentence2, interrupted: false });
      aai.emit({ type: 'reply.done', reply_id: 'a-second', status: 'completed' });
      expect(readbackIssuedActions()).toHaveLength(2); // one per rendering -- never doubled
    }
  });

  it('(b) ASK_CHALLENGE: an ambient reply (no reply.create of ours) speaks the exact challenge sentence with a holding prefix before our deferred send fires -- no catch-up send, exactly one challenge_issued, and the call still advances once the caller answers', () => {
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
    const sendsBefore = replyCreatesOf(aai).length;

    // Same PROVEN live shape as (a): the ambient reply for this caller turn starts almost
    // immediately, well within the settle window, and speaks the challenge's own exact
    // sentence with a holding prefix.
    clock.now = 1004;
    aai.emit({ type: 'reply.started', reply_id: 'auto-1' });
    aai.emit({
      type: 'transcript.agent',
      item_id: 'x-auto-1',
      reply_id: 'auto-1',
      text: `One moment. ${sentence1}`,
      interrupted: false,
    });
    const internals = session as unknown as { speaking: boolean };
    expect(internals.speaking).toBe(true);

    vi.advanceTimersByTime(AUTOMATIC_REPLY_SETTLE_MS);
    expect(replyCreatesOf(aai).length).toBe(sendsBefore);

    clock.now = 1500;
    aai.emit({ type: 'reply.done', reply_id: 'auto-1', status: 'completed' });

    // THE FIX: no second, redundant instructed ask.
    expect(replyCreatesOf(aai).length).toBe(sendsBefore);
    expect(challengeIssuedActions()).toHaveLength(1);

    // The call still advances: the caller's next turn is processed normally, with no crash and
    // no stall -- this rendering is not left waiting for an ask that already happened.
    clock.now = 1800;
    aai.emit({ type: 'transcript.user', item_id: 'c2', text: scenarioB.conversation[2]!.text });
    expect(session.last).toBeTruthy();
    expect(sent.some((e) => (e as { type?: string }).type === 'ended')).toBe(false);
  });

  // (c) regression guard (must not weaken e99e17f's own F3 fix, design-e-turn-order.test.ts):
  // when the ambient reply speaks something that is NOT the current rendering's own question
  // (a bare holding line, or its own unrelated question), the instructed question IS still
  // sent, exactly once.
  it('(c) unaffected: an ambient reply that says only the holding line, or asks an unrelated question, still gets our own instructed ask sent exactly once', () => {
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

    // The ambient reply speaks an entirely unrelated question -- PROVEN live shape
    // (design-e-turn-order.test.ts's own F3).
    clock.now = 1050;
    aai.emit({ type: 'reply.started', reply_id: 'auto-1' });
    aai.emit({
      type: 'transcript.agent',
      item_id: 'x-auto-1',
      reply_id: 'auto-1',
      text: 'One moment. Who is calling and what is your authorization code?',
      interrupted: false,
    });
    vi.advanceTimersByTime(AUTOMATIC_REPLY_SETTLE_MS);
    expect(replyCreatesOf(aai)).toHaveLength(0); // still busy -- deferred, not lost

    clock.now = 1300;
    aai.emit({ type: 'reply.done', reply_id: 'auto-1', status: 'completed' });

    // Our own instructed ask IS sent -- exactly once -- carrying OUR sentence, never the
    // ambient one's.
    const replyCreates = replyCreatesOf(aai);
    expect(replyCreates).toHaveLength(1);
    expect(replyCreates[0]!.instructions).toBe(`Say exactly this and nothing else: "${sentence1}"`);
    expect(replyCreates[0]!.instructions).not.toContain('authorization code');

    // That ambient reply's own "?" already registered one challenge_issued
    // (transcriptAsksQuestion's pre-existing lenient bare-"?" match, in recordGoalCompletionAction
    // -- unrelated to and unchanged by this fix). Our own instructed reply now completes too --
    // still capped at QUESTION_ASKED_MAX (2) for this one rendering, never uncapped.
    clock.now = 1600;
    aai.emit({ type: 'reply.started', reply_id: 'r2' });
    aai.emit({ type: 'transcript.agent', item_id: 'x-r2', reply_id: 'r2', text: sentence1, interrupted: false });
    clock.now = 1900;
    aai.emit({ type: 'reply.done', reply_id: 'r2', status: 'completed' });
    expect(challengeIssuedActions().length).toBeLessThanOrEqual(2);
    expect(challengeIssuedActions().length).toBeGreaterThanOrEqual(1);

    // No further instructed send once nothing new is owed.
    vi.advanceTimersByTime(1000);
    expect(replyCreatesOf(aai)).toHaveLength(1);
  });
});
