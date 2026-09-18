// packages/server/test/challenge-issued-reask-binding.test.ts
// Fix (2026-09-18, P0 founder-observed live defect -- see
// scripts/rehearse/reports/founder-2026-09-18/da346951-c57a-4e53-8cbe-11fa6d039427.diagnostics.json):
// at 30.45s the agent correctly spoke challenge sess-b-1's own trap sentence and
// `recordGoalCompletionAction` (session.ts) correctly logged `challenge_issued` for sess-b-1.
// An AssemblyAI automatic reply then restated the whole request with no question (no "?", no
// verbatim match) -- `maybeReaskQuestion` correctly re-asked sess-b-1's SAME sentence. But by
// the time that re-ask reply's own `reply.done` fired, `seed.thresholds.challenge_answer_window_ms`
// (15s, engine/seed/meridian.ts) had already elapsed since sess-b-1's ORIGINAL issuance --
// itself a real, engine-side grading timeout, not this fix's concern -- so the engine's own
// `evaluate()` had ALREADY advanced `this.last.goal.challenge` to sess-b-2 by the time this
// SAME event's own trailing `tick()` (an EARLIER `transcript.agent` chunk for the very same
// reply, which fires its own trailing tick before `reply.done` ever runs) settled. `recordGoalCompletionAction`
// read `this.last.goal` FRESH at `reply.done` time -- so it logged `challenge_issued` for
// sess-b-2, attributing the re-ask reply (which actually spoke sess-b-1's sentence, verbatim)
// to the WRONG challenge. From that point every `challenge_issued` action in the call lagged
// the actually-spoken question by one, and the caller's real answers graded against questions
// they were never asked.
//
// Fix (session.ts): `sendReplyCreate` now snapshots `this.last?.goal` (the FULL PhrasingGoal,
// not just the GoalCode `pendingRequestedGoal` already tracked) into `pendingRequestedFullGoal`
// at the instant it sends -- the same instant every call site composed `instructions` from that
// exact goal. The `reply.started` handler binds that snapshot to the new reply's own id in
// `replyInstructedGoal`, mirroring the existing `replyGoalAtStart`/`instructedReplyIds`
// convention exactly. `recordGoalCompletionAction` now reads `this.replyInstructedGoal.get(replyId)
// ?? this.last.goal` instead of `this.last.goal` unconditionally -- an INSTRUCTED reply (ours)
// is graded and logged against the goal it was actually SENT to speak, never whatever the
// engine has since advanced to; a non-instructed (ambient/automatic) reply, which was never
// bound to any of our own snapshots, keeps the prior fallback behavior unchanged.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MERIDIAN, mockToolResult } from '@countersign/engine';
import type { CallContext, ServerEvent } from '@countersign/engine';
import { CallSession } from '../src/call/session.js';
import { FakeAaiSocket } from '../src/aai/fake.js';
import scenarioB from '../../engine/corpus/scenario-b-miller-fraud.json' with { type: 'json' };

const CALL_B = scenarioB.call as CallContext;
const CHALLENGE_ANSWER_WINDOW_MS = 15_000; // seed/meridian.ts, ruling 2026-09-09 (item 21)

function newLiveSession(
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

describe('CallSession -- challenge_issued binds to the challenge actually SPOKEN in a re-ask, never the engine\'s current (possibly-advanced) one (fix, 2026-09-18)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a re-ask reply that speaks challenge N\'s own sentence, completing AFTER the engine has already timed out challenge N and advanced to N+1, still logs challenge_issued for N, not N+1', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newLiveSession(clock, CALL_B, aai, sent, diagEvents);

    clock.now = 1000;
    aai.emit({ type: 'transcript.user', item_id: 'c1', text: scenarioB.conversation[0]!.text });
    expect(session.last?.state).toBe('CHALLENGE');
    expect(session.last?.goal.code).toBe('ASK_CHALLENGE');
    const challengeId1 = session.last!.goal.challenge!.challenge_id;
    expect(challengeId1).toBe('sess-b-1');
    const sentence1 = session.last!.goal.challenge!.speak!;
    expect(sentence1).toBeTruthy();

    // The reply that FIRST asks challenge 1, correctly -- this leg is already correct today
    // and must stay correct after the fix (baseline, unchanged).
    clock.now = 1800;
    aai.emit({ type: 'reply.started', reply_id: 'ask-1' });
    aai.emit({ type: 'transcript.agent', item_id: 'ask-1', reply_id: 'ask-1', text: sentence1, interrupted: false });
    aai.emit({ type: 'reply.done', reply_id: 'ask-1', status: 'completed' });

    const challengeIssuedActions = () => session.logs.actions.filter((a) => a.kind === 'challenge_issued');
    expect(challengeIssuedActions()).toHaveLength(1);
    expect(challengeIssuedActions()[0]).toMatchObject({ challenge_id: 'sess-b-1' });
    // Still the SAME challenge immediately after -- nothing has been graded yet (PROVEN: the
    // engine only advances once a knowledge_check_result card exists for it, fsm.ts's own
    // `awaitingChallenge`).
    expect(session.last?.goal.challenge?.challenge_id).toBe('sess-b-1');

    // An ambient AssemblyAI automatic reply that restates the request instead of asking anything
    // -- no "?", no verbatim match to sentence1 -- exactly the live 41.7s shape. Not one of our
    // own instructed sends (no `reply.create` preceded it), so it must never log anything.
    clock.now = 2200;
    aai.emit({ type: 'reply.started', reply_id: 'auto-1' });
    aai.emit({
      type: 'transcript.agent',
      item_id: 'auto-1',
      reply_id: 'auto-1',
      text: 'One moment. You are requesting the funds be wired as described.',
      interrupted: false,
    });
    aai.emit({ type: 'reply.done', reply_id: 'auto-1', status: 'completed' });
    expect(challengeIssuedActions()).toHaveLength(1); // unaffected

    // `maybeReaskQuestion` decides sess-b-1 was not asked by `auto-1` and arms a spaced re-ask
    // (CLOSE_RETRY_MIN_GAP_MS = 400ms, reused for the reask timer).
    vi.advanceTimersByTime(400);
    const reaskSends = diagEvents.filter((e) => e.kind === 'question_reask_sent');
    expect(reaskSends).toHaveLength(1);

    // The re-ask's own `reply.create` has now gone out, instructed with sentence1 -- this is the
    // SEND-TIME instant the fix snapshots. Start the reply that answers it.
    clock.now = 2700;
    aai.emit({ type: 'reply.started', reply_id: 'reask-1' });

    // Real elapsed time now pushes past CHALLENGE_ANSWER_WINDOW_MS (15s) measured from
    // challenge 1's ORIGINAL issuance (t_ms ~1800, `ask-1`'s own `reply.done`) -- purely a
    // function of the recorded timestamps (engine/challenges.ts's `challengeReplyWindowStatus`),
    // never a live clock read. This transcript.agent chunk's own trailing `tick()` is what
    // re-evaluates the engine and (correctly, per the engine's own existing timeout design)
    // grades challenge 1 UNANSWERED and advances to challenge 2 -- BEFORE `reask-1`'s own
    // `reply.done` has even fired yet, reproducing the exact live race.
    clock.now = 1800 + CHALLENGE_ANSWER_WINDOW_MS + 400;
    aai.emit({ type: 'transcript.agent', item_id: 'reask-1', reply_id: 'reask-1', text: sentence1, interrupted: false });

    // PROVEN reproduction of the race: the engine has already moved on to a DIFFERENT challenge
    // by now, strictly BEFORE `reask-1`'s own `reply.done` is ever processed.
    const challengeId2 = session.last?.goal.challenge?.challenge_id;
    expect(challengeId2).toBeTruthy();
    expect(challengeId2).not.toBe(challengeId1);

    // The re-ask reply now completes. It spoke challenge 1's own sentence, verbatim -- the
    // logged action must say so, not attribute it to challenge 2 (which was never spoken).
    aai.emit({ type: 'reply.done', reply_id: 'reask-1', status: 'completed' });

    const afterReaskActions = challengeIssuedActions();
    expect(afterReaskActions).toHaveLength(2);
    expect(afterReaskActions[1]).toMatchObject({ challenge_id: 'sess-b-1', spec: expect.objectContaining({ challenge_id: 'sess-b-1' }) });
    expect(afterReaskActions[1]?.challenge_id).not.toBe(challengeId2);

    // Part 2 of the task: does this server-side binding fix, by itself, also fix WHAT the
    // caller's single answer grades against? PROVEN NO, by direct experiment below -- reported
    // to the founder as a found-but-NOT-fixed, engine-lane gap (LANE-FILES for this task:
    // packages/server/** only; grading is entirely engine-side, `gradeChallenges` in
    // engine/challenges.ts, a different lane -- see the class-field doc comment on
    // `pendingRequestedFullGoal`). This fix guarantees the ACTION LOG is accurate (LAW 4: it
    // never again claims a question was put to the caller that was never actually spoken) --
    // it does NOT guarantee grading purity, because `eligibleUtterances`'s forward bound
    // (`nextAgentActionT`) only closes when a LATER, genuinely-DIFFERENT challenge_id is
    // actually logged; a re-ask that (correctly, post-fix) logs the SAME challenge_id again
    // leaves challenge 1's own window open-ended, so a caller utterance arriving much later can
    // still land inside it and RE-GRADE an already-timed-out UNANSWERED card.
    const knowledgeCardsBeforeAnswer = (session.last?.evidence ?? []).filter((e) => e.kind === 'knowledge_check_result');
    expect(knowledgeCardsBeforeAnswer.map((e) => e.id)).toContain('ev-knowledge-sess-b-1');
    const challenge1CardBeforeAnswer = knowledgeCardsBeforeAnswer.find((e) => e.id === 'ev-knowledge-sess-b-1');
    // Challenge 1 has already timed out (UNANSWERED) BEFORE the caller ever says a word here --
    // purely because real elapsed time (per the recorded timestamps) already exceeded
    // CHALLENGE_ANSWER_WINDOW_MS the instant the re-ask's own transcript landed.
    expect(challenge1CardBeforeAnswer?.facts?.result).toBe('UNANSWERED');

    // The caller's one real reply, arriving well after challenge 1 was already timed out.
    clock.now = clock.now + 2500;
    aai.emit({ type: 'transcript.user', item_id: 'caller-answer', text: 'Yes.' });

    // KNOWN GAP (found, NOT fixed -- out of this server-only lane's scope, flagged for the
    // engine lane): challenge 1's card is RE-GRADED from its earlier UNANSWERED verdict by this
    // later, unrelated caller utterance, because no genuinely-different challenge was ever
    // actually asked (and therefore actually LOGGED) after it to close its own eligible window.
    // This is exactly the shape of the founder's live observation -- one caller utterance
    // affecting more than one challenge's grading -- and it survives this fix intact. A real
    // fix belongs in `engine/challenges.ts`'s own `eligibleUtterances`/`challengeReplyWindowStatus`
    // (e.g. a window, once CLOSED by timeout, should stay closed, never reopen for a later
    // utterance) -- deliberately NOT attempted here per this task's LANE-FILES boundary.
    const knowledgeCardsAfterAnswer = (session.last?.evidence ?? []).filter((e) => e.kind === 'knowledge_check_result');
    const challenge1CardAfterAnswer = knowledgeCardsAfterAnswer.find((e) => e.id === 'ev-knowledge-sess-b-1');
    expect(challenge1CardAfterAnswer?.facts?.result).not.toBe('UNANSWERED');
    expect(challenge1CardAfterAnswer?.quotes.some((q) => q.utterance_id === 'caller-answer')).toBe(true);
  });
});
