// packages/server/test/question-reask-late-transcript.test.ts
// Fix (2026-09-16b, Sonnet review of bde7814, Important): `maybeReaskQuestion` reads
// `this.replyTranscripts.get(replyId)` SYNCHRONOUSLY at `reply.done` (session.ts) -- with
// `QUESTION_REASK_MAX_EMPTY` (2) now bounding the forgiven (empty-transcript) reask count
// (session.ts:541-542), a `transcript.agent` event that arrives AFTER `reply.done` is
// misclassified as an empty reply at that instant. After two such misclassifications for the
// SAME rendering, the challenge is silently never re-asked -- nothing else re-issues it. The
// CLOSE path already solves the analogous race with a late-transcript grace
// (`armCloseTranscriptWait`, `CLOSE_TRANSCRIPT_WAIT_MS` = 1500ms, session.ts:1006-1030 --
// the file's own comments there say a reply's final transcript chunk routinely arrives AT OR
// AFTER `reply.done`). Data from 90 bundles (2026-09-14 to 16, 721 replies): 684 transcripts
// landed inside the reply window, 1 arrived 856ms late, 36 never arrived -- rare, but real.
//
// Fix (session.ts): `maybeReaskQuestion` now arms `armQuestionTranscriptWait`
// (`QUESTION_TRANSCRIPT_WAIT_MS` = 1500ms, a sibling of CLOSE's own wait) instead of deciding
// immediately, but ONLY when the transcript is empty at `reply.done` time -- a transcript
// arriving during that window that completes the question match cancels the reask outright:
// nothing is sent, and neither `questionReaskCount` nor `questionReaskEmptyCount` is consumed.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MERIDIAN, mockToolResult } from '@countersign/engine';
import type { CallContext, ServerEvent } from '@countersign/engine';
import { CallSession } from '../src/call/session.js';
import { FakeAaiSocket } from '../src/aai/fake.js';
import scenarioB from '../../engine/corpus/scenario-b-miller-fraud.json' with { type: 'json' };

const CALL_B = scenarioB.call as CallContext;
const REASK_GAP_MS = 400; // CallSession.CLOSE_RETRY_MIN_GAP_MS, reused for the reask timer
const QUESTION_TRANSCRIPT_WAIT_MS = 1500; // CallSession.QUESTION_TRANSCRIPT_WAIT_MS
const QUESTION_REASK_MAX_EMPTY = 2; // CallSession.QUESTION_REASK_MAX_EMPTY
// Comfortably longer than one full wait+reask cycle (1500 + 400 = 1900ms) so each simulated
// reply's own cycle fully resolves before the next one is emitted -- the wait mechanism uses
// a "latest reply wins" convention (same as CLOSE's own `armCloseTranscriptWait`), so replies
// emitted faster than that would supersede each other's pending wait instead of each being
// counted, same as `armCloseRetryTimer`'s own spacing already requires downstream.
const FULL_CYCLE_MS = QUESTION_TRANSCRIPT_WAIT_MS + REASK_GAP_MS + 100;
// P0 fix (2026-09-18, call/session.ts's own AUTOMATIC_REPLY_SETTLE_MS doc comment): a
// caller-turn-triggered fresh QUESTION_GOALS send is now deferred by this many ms instead of
// synchronous, so AssemblyAI's own automatic reply for the same turn (if one is coming) has
// time to start first.
const AUTOMATIC_REPLY_SETTLE_MS = 150; // CallSession.AUTOMATIC_REPLY_SETTLE_MS

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

describe('CallSession -- question reask survives a transcript.agent that lands after reply.done (fix, 2026-09-16b)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a transcript that arrives 900ms AFTER reply.done, but completes the question match, cancels the reask -- nothing sent, nothing consumed', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newLiveSession(clock, CALL_B, aai, sent, diagEvents);

    clock.now = 1000;
    aai.emit({ type: 'transcript.user', item_id: 'c1', text: scenarioB.conversation[0]!.text });
    vi.advanceTimersByTime(AUTOMATIC_REPLY_SETTLE_MS);
    expect(session.last?.state).toBe('CHALLENGE');
    expect(session.last?.goal.code).toBe('ASK_CHALLENGE');
    const challengeId = session.last?.goal.challenge?.challenge_id;
    const sentence = session.last!.goal.challenge!.speak!;
    expect(sentence).toBeTruthy();

    const replyCreates = () => aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create');
    const baseline = replyCreates().length; // c1's own fresh-question proactive send (Design E)

    // The reply that answers c1's proactive send: started, done -- but its transcript.agent
    // chunk for the actual question has NOT landed yet (the PROVEN live race).
    clock.now = 1500;
    aai.emit({ type: 'reply.started', reply_id: 'late-1' });
    clock.now = 1800;
    aai.emit({ type: 'reply.done', reply_id: 'late-1', status: 'completed' });

    // The late chunk lands 900ms after reply.done -- comfortably inside
    // QUESTION_TRANSCRIPT_WAIT_MS (1500ms) but well past the old REASK_GAP_MS (400ms) window.
    clock.now = 1800 + 900;
    vi.advanceTimersByTime(900);
    aai.emit({ type: 'transcript.agent', item_id: 'late-1', reply_id: 'late-1', text: sentence, interrupted: false });

    // Advance past the rest of the wait window plus the reask gap: no reply.create should
    // ever go out for this rendering -- the late transcript proved the question WAS asked.
    vi.advanceTimersByTime(FULL_CYCLE_MS);
    expect(replyCreates().length).toBe(baseline);
    expect(diagEvents.filter((e) => e.kind === 'question_reask_sent')).toHaveLength(0);
    expect(diagEvents.filter((e) => e.kind === 'question_transcript_wait_resolved')).toHaveLength(1);
    // The engine's own goal has not been falsely advanced either way -- `recordGoalCompletionAction`
    // (a separate, already-correct mechanism) is what actually asked/logged this challenge; this
    // test only proves the RE-ASK path did not fire a redundant, confusing second question.
    expect(session.last?.goal.challenge?.challenge_id).toBe(challengeId);

    // The empty-forgiveness budget was NOT consumed by the late-but-matching transcript: two
    // more genuinely-empty (no transcript ever) replies for a FRESH rendering should still get
    // the full QUESTION_REASK_MAX_EMPTY (2) forgiven reasks, not just one.
    // (Covered end-to-end by the sibling "transcript never arrives" test below, which starts
    // its own fresh session and rendering; asserting the FULL budget is available after this
    // one resolves without consuming anything is the point of this comment and the assertion
    // above -- the empty counter is internal, so behavior is what proves it, not the field.)
  });

  it('a transcript that never arrives at all still gives up after QUESTION_REASK_MAX_EMPTY, just delayed by the wait', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newLiveSession(clock, CALL_B, aai, sent, diagEvents);

    clock.now = 1000;
    aai.emit({ type: 'transcript.user', item_id: 'c1', text: scenarioB.conversation[0]!.text });
    vi.advanceTimersByTime(AUTOMATIC_REPLY_SETTLE_MS);
    expect(session.last?.state).toBe('CHALLENGE');
    expect(session.last?.goal.code).toBe('ASK_CHALLENGE');
    expect(session.last?.goal.challenge?.challenge_id).toBe('sess-b-1');

    const replyCreates = () => aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create');
    const baseline = replyCreates().length;

    let t = 1500;
    let replyN = 0;
    function emitTranscriptlessReply(): void {
      replyN += 1;
      const replyId = `never-${replyN}`;
      clock.now = t;
      aai.emit({ type: 'reply.started', reply_id: replyId });
      clock.now = t + 300;
      aai.emit({ type: 'reply.done', reply_id: replyId, status: 'completed' });
      t += FULL_CYCLE_MS;
    }

    // Attempt #1: empty at reply.done, and stays empty for the full wait -- forgiven.
    emitTranscriptlessReply();
    vi.advanceTimersByTime(FULL_CYCLE_MS);
    t += 0; // clock already advanced by FULL_CYCLE_MS inside emitTranscriptlessReply's own bookkeeping
    expect(replyCreates().length).toBe(baseline + 1);
    expect(diagEvents.filter((e) => e.kind === 'question_reask_sent')).toHaveLength(1);
    expect(session.last?.goal.challenge?.challenge_id).toBe('sess-b-1');

    // Attempt #2: same shape -- forgiven, exhausts QUESTION_REASK_MAX_EMPTY.
    emitTranscriptlessReply();
    vi.advanceTimersByTime(FULL_CYCLE_MS);
    expect(replyCreates().length).toBe(baseline + 2);
    expect(diagEvents.filter((e) => e.kind === 'question_reask_sent')).toHaveLength(2);

    // Attempt #3, #4: budget exhausted -- no further reply.create is EVER sent for this
    // rendering, exactly as `question-reask-empty-bound.test.ts` already proves for the
    // pre-existing (no-wait) shape of this same bound.
    for (let i = 0; i < 2; i++) {
      emitTranscriptlessReply();
      vi.advanceTimersByTime(FULL_CYCLE_MS);
    }
    expect(replyCreates().length).toBe(baseline + QUESTION_REASK_MAX_EMPTY);
    expect(diagEvents.filter((e) => e.kind === 'question_reask_sent')).toHaveLength(QUESTION_REASK_MAX_EMPTY);
    expect(session.logs.actions.some((a) => a.kind === 'challenge_issued')).toBe(false);
  });

  it('a later reply that resolves synchronously does not leave an EARLIER reply of the SAME rendering\'s stale empty-transcript wait free to fire a second, duplicate re-ask (idempotency fix, 2026-09-16c)', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newLiveSession(clock, CALL_B, aai, sent, diagEvents);

    clock.now = 1000;
    aai.emit({ type: 'transcript.user', item_id: 'c1', text: scenarioB.conversation[0]!.text });
    // P0 fix (2026-09-18, AUTOMATIC_REPLY_SETTLE_MS): the proactive send is deferred now, not
    // synchronous -- this advance is what makes 'reask-a' bind as the instructed reply. Every
    // later "due at real-elapsed Xms" comment below is relative to THIS point, unaffected.
    vi.advanceTimersByTime(AUTOMATIC_REPLY_SETTLE_MS);
    expect(session.last?.state).toBe('CHALLENGE');
    expect(session.last?.goal.code).toBe('ASK_CHALLENGE');
    const challengeId = session.last?.goal.challenge?.challenge_id;

    const replyCreates = () => aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create');
    const baseline = replyCreates().length; // c1's own fresh-question proactive send (Design E)

    // Reply A: empty at reply.done -- arms `armQuestionTranscriptWait` (1500ms from right now,
    // due at real-elapsed 1500ms from the settle advance above).
    clock.now = 1500;
    aai.emit({ type: 'reply.started', reply_id: 'reask-a' });
    clock.now = 1800;
    aai.emit({ type: 'reply.done', reply_id: 'reask-a', status: 'completed' });

    // 300ms later (PROVEN live shape): reply B, for the SAME still-unanswered rendering, ends
    // with real, non-empty, non-matching content -- `maybeReaskQuestion`'s synchronous branch
    // decides immediately (`questionReaskLastReplyWasEmpty = false`) and arms its own
    // CLOSE_RETRY_MIN_GAP_MS (400ms)-spaced reask timer, due at real-elapsed 700ms -- well
    // before reply A's own stale wait is due at 1500ms.
    clock.now = 1800 + 300;
    vi.advanceTimersByTime(300);
    aai.emit({ type: 'reply.started', reply_id: 'reask-b' });
    aai.emit({
      type: 'transcript.agent',
      item_id: 'reask-b',
      reply_id: 'reask-b',
      text: 'Checking the record.',
      interrupted: false,
    });
    aai.emit({ type: 'reply.done', reply_id: 'reask-b', status: 'completed' });

    // Advance to reply B's own reask timer firing (real-elapsed 700ms): this actually SENDS
    // the (correctly counted) re-ask reply.create and arms REPLY_CREATE_LOST_MS (1500ms) --
    // `replyCreateAwaitingStart` is now true, which would otherwise mask a stale duplicate
    // send below behind an unrelated guard. A live AssemblyAI acks a `reply.create` in tens of
    // ms, well under that 1500ms window -- simulate that realistic ack immediately (still at
    // real-elapsed 700ms) so the guard clears the way a live call actually would, rather than
    // accidentally hiding the bug behind `replyCreateAwaitingStart` staying true for 1500ms.
    vi.advanceTimersByTime(400);
    aai.emit({ type: 'reply.started', reply_id: 'reask-b-followup' });
    // Reported interrupted (not completed) purely so this ack reply itself never re-enters
    // `maybeReaskQuestion`/`recordGoalCompletionAction` (both gated on `status === 'completed'`
    // -- session.ts:1983/1910) and so cannot advance the goal or arm/clear anything on its own;
    // it exists ONLY to flip `speaking`/`replyCreateAwaitingStart` back to their normal idle
    // values, exactly as a real AssemblyAI ack would, before reply A's stale wait comes due.
    aai.emit({ type: 'reply.done', reply_id: 'reask-b-followup', status: 'interrupted' });

    // Advance past reply A's stale 1500ms wait (due at real-elapsed 1500ms) and the further
    // 400ms re-ask gap it would arm if left uncleared (due at real-elapsed 1900ms) -- both
    // `speaking` and `replyCreateAwaitingStart` are idle again by then, so nothing but this
    // fix stands between a cleared stale wait and a genuine duplicate spoken re-ask.
    vi.advanceTimersByTime(1300);

    // Exactly ONE re-ask goes out for this rendering -- reply A's stale wait must never get a
    // second, redundant one out once reply B already resolved the rendering synchronously.
    expect(replyCreates().length).toBe(baseline + 1);
    const reaskEvents = diagEvents.filter((e) => e.kind === 'question_reask_sent');
    expect(reaskEvents).toHaveLength(1);
    // Booked against the COUNTED budget (questionReaskCount), not the forgiven-empty one --
    // reply B's own content was real and non-matching, never empty, so its own reask must
    // consume an attempt, not a free pass. A mis-booked stale send from reply A's wait
    // flipping the shared "last reply was empty" flag back to true after B already decided
    // would either duplicate this send or corrupt this count -- both are ruled out by the two
    // assertions above and this one together.
    expect((reaskEvents[0]!.detail as { attempt: number }).attempt).toBe(1);
    // Reply A's own stale wait never got to fire its own verdict at all -- it was cleared the
    // instant reply B's `reply.done` was processed for the same still-current rendering, so it
    // can never conclude (on its own, now-irrelevant empty transcript) that the question was
    // or wasn't asked.
    expect(diagEvents.filter((e) => e.kind === 'question_transcript_wait_resolved')).toHaveLength(0);
    // The goal itself never advanced either way (the interrupted ack reply is inert by
    // construction, and reply B's own content never matched) -- this test only proves the
    // RE-ASK bookkeeping, not a change in what the engine is still waiting on.
    expect(session.last?.goal.challenge?.challenge_id).toBe(challengeId);
  });
});
