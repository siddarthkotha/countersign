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
import type { CallContext, ServerEvent, ChallengeSpec } from '@countersign/engine';
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

// Content-match extension (2026-09-18 continued, P1 follow-up): the exact-sentence fix above
// only catches an ambient reply that speaks the rendering's EXACT composed words. Two further
// live records prove a PARAPHRASE still gets logged twice by the caller's ear:
//   scripts/rehearse/reports/2026-09-18T14-44-58-barge-in-interrupt.diagnostics.json
//     graded repeated_question 4x (30.761/54.261/73.501/93.551) -- three are the SAME exact-
//     sentence shape (a)/(b) above already close; the FIRST (30.761) is a TRAP_FACT paraphrase:
//     ambient "One moment. You are requesting a wire for eighty four thousand five hundred
//     dollars to Northgate Partners?" (25031, logged via transcriptAsksQuestion's bare-"?"
//     branch) vs our own "Just to confirm, this transfer goes to Northgate Partners. Is that
//     correct?" (30443/30761) -- same trap value, different wording.
//   scripts/rehearse/reports/2026-09-18T14-48-35-prompt-injection-midcall.diagnostics.json
//     graded repeated_question 3x (80.601/99.121/126.702) -- the first two are the SAME exact-
//     sentence shape (READBACK amount/account); the THIRD (126.702) is a LIVE_COMMITMENT
//     paraphrase: ambient "Could you please restate the deadline you provided earlier?"
//     (123150) vs our own "Can you restate the deadline you gave me earlier?" (126392) -- no
//     caller-stated value in either sentence, but both name the SAME field's spoken label,
//     "deadline".
//
// Fix (questionMatch.ts): `loadBearingValueFor`/`transcriptContainsLoadBearingValue`/
// `replyCoversCurrentRendering` -- see each function's own doc comment. Combined effect on the
// double-ask cap (QUESTION_ASKED_MAX = 2, question-double-ask-cap.test.ts's own describe
// block, unrelated mechanism, unchanged): `replyCoversCurrentRendering`'s two branches
// (exact-sentence, or "?" + load-bearing value) are each PROVABLY a strict subset of
// `transcriptAsksQuestion`'s own true condition (recordGoalCompletionAction's own `asked`
// check, which runs on every completed reply BEFORE this catch-up path, whether the reply is
// ours or ambient) -- transcriptAsksQuestion's very first branch is the same bare-"?" check my
// content-match path already requires, and its sentence branch is the identical substring
// check the exact-sentence path uses. So whenever this fix suppresses the catch-up send, the
// reply that triggered the suppression was ALREADY logged as one issuance by
// recordGoalCompletionAction -- a rendering can therefore never end with ZERO logged
// issuances because of this fix; every test below asserts at least one.
describe('CallSession -- double-ask catch-up fix, content-match extension (P1, 2026-09-18 continued): a PARAPHRASED ambient reply that still names the load-bearing value is also covered', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('(d) ASK_CHALLENGE TRAP_FACT paraphrase: PROVEN live text from 2026-09-18T14-44-58-barge-in-interrupt (25031/30761, the Dana Whitfield scenario -- same greeting/opening line as that record) -- an ambient reply differently worded but still stating the trap value gets no catch-up send, and exactly one challenge_issued', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newSession(clock, CALL_DANA, aai, sent, diagEvents);

    // Verbatim caller line from the record's own transcript.user event at 17682.
    clock.now = 1000;
    aai.emit({
      type: 'transcript.user',
      item_id: 'c1',
      text: "This is Dana Whitfield, corporate treasury. I need to wire it to Meridian Supply — $84,500, account ending 4471 — moving today instead of Friday, approved in yesterday's close meeting.",
    });
    expect(session.last?.goal.code).toBe('ASK_CHALLENGE');
    expect(session.last?.goal.challenge?.kind).toBe('TRAP_FACT');
    expect(session.last?.goal.challenge?.expect).toMatchObject({ trap_value: 'Northgate Partners' });

    const challengeIssuedActions = () => session.logs.actions.filter((a) => a.kind === 'challenge_issued');

    // PROVEN live text, verbatim from the record's own transcript.agent event at 24779/25031 --
    // a paraphrase of the trap, not the engine's own composed sentence, but it states the same
    // trap value and ends with "?".
    clock.now = 1004;
    aai.emit({ type: 'reply.started', reply_id: 'auto-1' });
    aai.emit({
      type: 'transcript.agent',
      item_id: 'x-auto-1',
      reply_id: 'auto-1',
      text: 'One moment. You are requesting a wire for eighty four thousand five hundred dollars to Northgate Partners?',
      interrupted: false,
    });
    vi.advanceTimersByTime(AUTOMATIC_REPLY_SETTLE_MS);
    expect(replyCreatesOf(aai)).toHaveLength(0); // still busy -- deferred, not lost

    clock.now = 1300;
    aai.emit({ type: 'reply.done', reply_id: 'auto-1', status: 'completed' });

    // THE FIX: no catch-up send, even though the wording differs from the engine's own trap
    // sentence -- and the rendering is NOT left with zero issuances: the ambient reply's own
    // "?" already logged one (recordGoalCompletionAction, unrelated to and unchanged by this
    // fix, runs before this catch-up path on every completed reply).
    expect(replyCreatesOf(aai)).toHaveLength(0);
    expect(challengeIssuedActions().length).toBeGreaterThanOrEqual(1);
    expect(challengeIssuedActions()).toHaveLength(1); // exactly one -- not the PROVEN live two
  });

  it('(e) ASK_CHALLENGE LIVE_COMMITMENT paraphrase ("deadline"): PROVEN live text from 2026-09-18T14-48-35-prompt-injection-midcall (123150/126392/126702) -- an ambient reply differently worded but still naming the challenge\'s own spoken field label gets no catch-up send, and exactly one challenge_issued', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newSession(clock, CALL_B, aai, sent, diagEvents);

    // LIVE_COMMITMENT never embeds the caller's own earlier-stated value in its own `speak`
    // sentence (it's asking the caller to restate it) -- only the field's spoken label
    // ("deadline") is shared between the two wordings. Built by hand and invoked directly
    // (same pattern question-double-ask-cap.test.ts's own (d) tests use -- `session.last =
    // ...` survives only until the next real event runs the engine's own `tick()`/`evaluate()`
    // and recomputes it fresh, so this drives `recordGoalCompletionAction`/
    // `maybeSendReplyCreateAfterReplyDone` directly rather than through `aai.emit`, exactly as
    // those tests do) rather than through the engine, since reaching a live
    // LIVE_COMMITMENT-on-deadline rendering naturally needs a much longer corpus drive than
    // this fix is about.
    const OUR_SENTENCE = 'Can you restate the deadline you gave me earlier?';
    const challenge: ChallengeSpec = {
      challenge_id: 'sess-catchup-deadline-challenge-1',
      kind: 'LIVE_COMMITMENT',
      field: 'deadline',
      ask: 'Ask the caller to restate the deadline they gave earlier. Do not say the value yourself.',
      speak: OUR_SENTENCE,
      expect: { commitment_claim_id: 'claim-deadline-1' },
    };
    session.last = {
      ...session.last!,
      state: 'CHALLENGE',
      goal: { code: 'ASK_CHALLENGE', hint: OUR_SENTENCE, keyterms: [], turn_detection_hint: 'patient', challenge },
    };

    const internals = session as unknown as {
      owedQuestionGoalKey: string | null;
      replyTranscripts: Map<string, string>;
      recordGoalCompletionAction: (replyId: string, status: string) => void;
      maybeSendReplyCreateAfterReplyDone: (replyId: string) => void;
    };
    // Simulates a caller-turn-triggered fresh rendering whose own instructed send is deferred
    // (busy guard) -- the exact state `maybeSendReplyCreateForTick` leaves behind before an
    // ambient reply's own `reply.done` reaches the catch-up path under test.
    internals.owedQuestionGoalKey = JSON.stringify(session.last.goal);
    // PROVEN live text, verbatim from the record's own transcript.agent event at 123150.
    internals.replyTranscripts.set('auto-1', 'Could you please restate the deadline you provided earlier?');

    const challengeIssuedActions = () =>
      session.logs.actions.filter((a) => a.kind === 'challenge_issued' && (a as { challenge_id?: string }).challenge_id === challenge.challenge_id);

    // recordGoalCompletionAction first (matches the real `reply.done` handler's own order,
    // requirement 3): the ambient reply's own bare "?" logs one issuance, exactly as it does
    // live. Then the catch-up path under test.
    internals.recordGoalCompletionAction('auto-1', 'completed');
    internals.maybeSendReplyCreateAfterReplyDone('auto-1');

    // THE FIX: no catch-up send -- the ambient's own paraphrase names the same subject
    // ("deadline") and ends with "?" -- and the rendering keeps its one logged issuance (from
    // the ambient reply itself), never zero.
    expect(replyCreatesOf(aai)).toHaveLength(0);
    expect(challengeIssuedActions().length).toBeGreaterThanOrEqual(1);
    expect(challengeIssuedActions()).toHaveLength(1);
  });

  it('(f) unaffected: a goal with NO load-bearing value at all (ELICIT_IDENTITY) still gets our own instructed ask sent once, even when the ambient reply asks an unrelated "?" question', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newSession(clock, CALL_B, aai, sent, diagEvents);

    expect(session.last?.goal.code).toBe('GREET');
    // `session.last = ...` (like (e) above) survives only until the next real event re-runs
    // the engine's own `tick()`/`evaluate()` -- driven directly for the same reason.
    session.last = { ...session.last!, state: 'CLAIM', goal: { code: 'ELICIT_IDENTITY', hint: 'Ask who is calling.', keyterms: [], turn_detection_hint: 'default' } };

    const internals = session as unknown as {
      owedQuestionGoalKey: string | null;
      replyTranscripts: Map<string, string>;
      recordGoalCompletionAction: (replyId: string, status: string) => void;
      maybeSendReplyCreateAfterReplyDone: (replyId: string) => void;
    };
    internals.owedQuestionGoalKey = JSON.stringify(session.last.goal);
    internals.replyTranscripts.set('auto-1', 'One moment. Is this line secure?');

    internals.recordGoalCompletionAction('auto-1', 'completed');
    internals.maybeSendReplyCreateAfterReplyDone('auto-1');

    // ELICIT_IDENTITY has no verbatim sentence AND no load-bearing value
    // (`loadBearingValueFor` returns null) -- the exact-sentence path and the content-match
    // path both fall through, so the catch-up send still goes out, unchanged from before
    // either fix.
    const replyCreates = replyCreatesOf(aai);
    expect(replyCreates).toHaveLength(1);
    expect(replyCreates[0]!.instructions).toContain('who is calling');
  });

  it('(g) unaffected (degraded transcripts): a reply with no transcript at all still gets our own instructed ask sent once', () => {
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

    // The ambient reply starts and completes with NO transcript.agent event at all (audio
    // landed, nothing transcribed) -- the degraded-transcripts shape.
    clock.now = 1004;
    aai.emit({ type: 'reply.started', reply_id: 'auto-1' });
    vi.advanceTimersByTime(AUTOMATIC_REPLY_SETTLE_MS);
    expect(replyCreatesOf(aai)).toHaveLength(0); // still busy -- deferred, not lost

    clock.now = 1300;
    aai.emit({ type: 'reply.done', reply_id: 'auto-1', status: 'completed' });

    // Neither check ever matches an empty transcript -- the catch-up send still goes out,
    // unchanged from before either fix.
    const replyCreates = replyCreatesOf(aai);
    expect(replyCreates).toHaveLength(1);
    expect(replyCreates[0]!.instructions).toBe(`Say exactly this and nothing else: "${sentence1}"`);
  });

  it('(h) unaffected: a reply that MENTIONS the load-bearing value but asks nothing (no "?") still gets our own instructed ask sent once', () => {
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
    expect(session.last?.goal.code).toBe('ASK_CHALLENGE');
    expect(session.last?.goal.challenge?.expect).toMatchObject({ trap_value: 'Northgate Partners' });
    const sentence1 = session.last!.goal.challenge!.speak!;

    const challengeIssuedActions = () => session.logs.actions.filter((a) => a.kind === 'challenge_issued');

    // The ambient reply names the trap value but never asks anything -- no "?", no imperative
    // opener.
    clock.now = 1004;
    aai.emit({ type: 'reply.started', reply_id: 'auto-1' });
    aai.emit({
      type: 'transcript.agent',
      item_id: 'x-auto-1',
      reply_id: 'auto-1',
      text: 'One moment. This concerns Northgate Partners.',
      interrupted: false,
    });
    vi.advanceTimersByTime(AUTOMATIC_REPLY_SETTLE_MS);
    expect(replyCreatesOf(aai)).toHaveLength(0); // still busy -- deferred, not lost

    clock.now = 1300;
    aai.emit({ type: 'reply.done', reply_id: 'auto-1', status: 'completed' });

    // Not counted as asked at all (no "?" -- recordGoalCompletionAction's own `asked` stays
    // false, unrelated to and unchanged by this fix) -- and the content-match path requires a
    // "?" too, so the catch-up send still goes out, carrying our own real sentence, exactly
    // once.
    const replyCreates = replyCreatesOf(aai);
    expect(replyCreates).toHaveLength(1);
    expect(replyCreates[0]!.instructions).toBe(`Say exactly this and nothing else: "${sentence1}"`);
    expect(challengeIssuedActions()).toHaveLength(0); // not yet -- the instructed reply hasn't completed yet
  });
});

// Push-52 review fix (2026-09-18 continued, P0 -- BLOCKING, live-reproduced against main
// 65622b9): the label-only branch above ((e)'s own LIVE_COMMITMENT "deadline" shape) was too
// loose -- "One moment, I am checking the deadline for you?" and "Is the deadline today?" both
// mention "deadline" and end in "?" but ask the caller nothing, and the old check (label
// anywhere in the transcript + a "?" anywhere in the transcript, no same-sentence requirement,
// no cue) suppressed our real question for both. CHALLENGE is reached in the first turn or two
// of nearly every real call, so this was live-reproducible on a clean PASS call, riding the
// rendering to UNANSWERED and an idle escalation instead of asking it for real even once.
//
// Fix (questionMatch.ts): `LoadBearingKind` discriminates 'specific' (READBACK's own value, or
// an ASK_CHALLENGE TRAP_FACT's own trap value -- reviewer-confirmed specific enough,
// UNTOUCHED) from 'label' (LIVE_COMMITMENT/SEED_FACT/RELATIONAL's own spoken field-label
// subject -- a common noun, TIGHTENED). A 'label' match now requires, in the SAME
// sentence-like chunk (`questionSentencesOf`): a "?", the label, AND one of `LABEL_RESTATE_CUES`
// ("can you" / "restate" / "give me" -- the only cues actually present in LIVE_COMMITMENT's
// and RELATIONAL's own composed sentences, challenges.ts lines 110/406; SEED_FACT's own
// composed sentences, line 351, contain none of them, so a SEED_FACT rendering is never
// suppressed through this branch -- see `LABEL_RESTATE_CUES`'s own doc comment for the full
// list the review offered and why this file did not add the rest unjustified).
//
// The three probes below are the exact ones from the review: two must STOP suppressing, one
// (test (e) above, "Could you please restate the deadline you provided earlier?") must KEEP
// suppressing -- reconfirmed here as (i) alongside its two siblings so all three read as one
// table.
describe('CallSession -- push-52 review fix: the LIVE_COMMITMENT/SEED_FACT/RELATIONAL "label" branch requires a same-sentence restate/supply cue, not just the label + a "?" anywhere', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const OUR_SENTENCE = 'Can you restate the deadline you gave me earlier?';

  /** Builds the same hand-authored LIVE_COMMITMENT "deadline" challenge (e) uses above, drives
   *  an ambient reply with `ambientText` through the real `recordGoalCompletionAction` +
   *  `maybeSendReplyCreateAfterReplyDone` catch-up path (direct invocation, not `aai.emit` --
   *  see (e)'s own doc comment for why: `session.last = ...` survives only until the next real
   *  event re-runs the engine's own `tick()`/`evaluate()`), and returns what a caller of this
   *  helper needs to assert against. */
  function probeDeadlineLabel(ambientText: string): { replyCreates: { type?: string; instructions?: string }[]; challengeIssuedCount: number } {
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newSession(clock, CALL_B, aai, sent, diagEvents);

    const challenge: ChallengeSpec = {
      challenge_id: 'sess-catchup-deadline-label-probe',
      kind: 'LIVE_COMMITMENT',
      field: 'deadline',
      ask: 'Ask the caller to restate the deadline they gave earlier. Do not say the value yourself.',
      speak: OUR_SENTENCE,
      expect: { commitment_claim_id: 'claim-deadline-label-probe' },
    };
    session.last = {
      ...session.last!,
      state: 'CHALLENGE',
      goal: { code: 'ASK_CHALLENGE', hint: OUR_SENTENCE, keyterms: [], turn_detection_hint: 'patient', challenge },
    };

    const internals = session as unknown as {
      owedQuestionGoalKey: string | null;
      replyTranscripts: Map<string, string>;
      recordGoalCompletionAction: (replyId: string, status: string) => void;
      maybeSendReplyCreateAfterReplyDone: (replyId: string) => void;
    };
    internals.owedQuestionGoalKey = JSON.stringify(session.last.goal);
    internals.replyTranscripts.set('auto-1', ambientText);

    internals.recordGoalCompletionAction('auto-1', 'completed');
    internals.maybeSendReplyCreateAfterReplyDone('auto-1');

    const challengeIssuedCount = session.logs.actions.filter(
      (a) => a.kind === 'challenge_issued' && (a as { challenge_id?: string }).challenge_id === challenge.challenge_id
    ).length;
    return { replyCreates: replyCreatesOf(aai), challengeIssuedCount };
  }

  it('(i) MUST KEEP suppressing: "Could you please restate the deadline you provided earlier?" (the PROVEN live paraphrase, reconfirmed) -- one sentence, one "?", the label, and "restate"', () => {
    const { replyCreates, challengeIssuedCount } = probeDeadlineLabel('Could you please restate the deadline you provided earlier?');
    expect(replyCreates).toHaveLength(0); // no catch-up send
    expect(challengeIssuedCount).toBeGreaterThanOrEqual(1); // never zero issuances -- see file header above
    expect(challengeIssuedCount).toBe(1);
  });

  it('(j) MUST STOP suppressing: "One moment, I am checking the deadline for you?" -- mentions the label and ends in "?", but is not a restate-or-supply request at all', () => {
    const { replyCreates } = probeDeadlineLabel('One moment, I am checking the deadline for you?');
    // THE FIX: our own real question now goes out -- pre-fix, this wrongly suppressed it
    // (label "deadline" + a "?" somewhere in the transcript was enough), which would have
    // ridden this rendering to UNANSWERED and an idle escalation on a clean call.
    expect(replyCreates).toHaveLength(1);
    expect(replyCreates[0]!.instructions).toBe(`Say exactly this and nothing else: "${OUR_SENTENCE}"`);
  });

  it('(k) MUST STOP suppressing: "Is the deadline today?" -- a yes/no question ABOUT the value, never a request for the caller to COMMIT one', () => {
    // Why this must not suppress: this sentence asks the caller to confirm or deny a fact
    // ("is it today"), the same shape a READBACK confirmation asks -- it never asks the caller
    // to RESTATE or SUPPLY anything, which is the entire point of a LIVE_COMMITMENT challenge.
    // A caller who says "yes" to this has confirmed nothing the engine can grade against
    // (gradeChallenges' own LIVE_COMMITMENT path needs the caller's OWN restated value, never
    // a bare yes/no) -- suppressing our real ask here would leave the challenge unresolved
    // with no path forward except an idle timeout.
    const { replyCreates } = probeDeadlineLabel('Is the deadline today?');
    expect(replyCreates).toHaveLength(1);
    expect(replyCreates[0]!.instructions).toBe(`Say exactly this and nothing else: "${OUR_SENTENCE}"`);
  });

  it('(l) SEED_FACT is never suppressed through the label branch at all: an ambient reply that verbatim-matches a real SEED_FACT-shaped question still gets our own instructed ask sent, because none of the engine\'s SEED_FACT wording carries a restate/supply cue', () => {
    // Deliberately NOT built from a hand-authored ChallengeSpec this time -- this proves the
    // real engine-composed SEED_FACT sentence shape (askToQuestion(entry.ask), challenges.ts
    // line 351) against the real spoken-field label match this file's own (e)/(i)-(k) probes
    // exercise by hand, using the exact wording the engine would actually produce for a
    // "counsel of record" fact (seed/meridian.ts's own `ask`: "Ask which law firm is our
    // counsel of record on the Hartwell deal.").
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newSession(clock, CALL_B, aai, sent, diagEvents);

    const OUR_SEED_FACT_SENTENCE = 'Which law firm is our counsel of record on the Hartwell deal?';
    const challenge: ChallengeSpec = {
      challenge_id: 'sess-catchup-seedfact-label-probe',
      kind: 'SEED_FACT',
      field: 'counsel',
      ask: 'Ask which law firm is our counsel of record on the Hartwell deal.',
      speak: OUR_SEED_FACT_SENTENCE,
      expect: { accept_tokens: ['calder', 'finch'] },
      fact_id: 'counsel_of_record',
    };
    session.last = {
      ...session.last!,
      state: 'CHALLENGE',
      goal: { code: 'ASK_CHALLENGE', hint: OUR_SEED_FACT_SENTENCE, keyterms: [], turn_detection_hint: 'patient', challenge },
    };

    const internals = session as unknown as {
      owedQuestionGoalKey: string | null;
      replyTranscripts: Map<string, string>;
      recordGoalCompletionAction: (replyId: string, status: string) => void;
      maybeSendReplyCreateAfterReplyDone: (replyId: string) => void;
    };
    internals.owedQuestionGoalKey = JSON.stringify(session.last.goal);
    // An ambient reply that says almost the SAME words, one small paraphrase ("firm" ->
    // "practice") -- close enough that a human would call this the same question asked twice,
    // and it names the spoken field label ("counsel") with a "?" in the same sentence -- but
    // "which law practice represents us as counsel of record" carries none of
    // `LABEL_RESTATE_CUES`, so it is NOT suppressed: our own instructed ask still goes out.
    internals.replyTranscripts.set('auto-1', 'One moment. Which law practice represents us as counsel of record?');

    internals.recordGoalCompletionAction('auto-1', 'completed');
    internals.maybeSendReplyCreateAfterReplyDone('auto-1');

    const replyCreates = replyCreatesOf(aai);
    expect(replyCreates).toHaveLength(1);
    expect(replyCreates[0]!.instructions).toBe(`Say exactly this and nothing else: "${OUR_SEED_FACT_SENTENCE}"`);
  });
});
