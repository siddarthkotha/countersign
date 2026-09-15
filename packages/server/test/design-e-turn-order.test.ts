// packages/server/test/design-e-turn-order.test.ts
// Design E (2026-09-15, turn-order design change -- docs/TEST-PLAN.md "The turn order design
// change (E)"): PROVEN live failure (scripts/rehearse/reports/2026-09-15T08-06-07-corrected-
// critical-field.diagnostics.json): the engine rendered STAGE and the server sent its CLOSE
// reply.create at 84.49-84.50s, but AssemblyAI's own AUTOMATIC reply for the caller's
// just-finished turn -- undocumented/unstoppable per docs/ASSEMBLYAI_INTEGRATION.md's
// "VERIFY-AT-BUILD: reply.create schema" section -- spoke first, twice: a stale readback at
// 87.6s, then an invented question ("Please state the current date and time.") at 91.6s. The
// real goodbye was not heard until 98.9s, 14.4s after the verdict.
//
// docs/TEST-PLAN.md's "What the AssemblyAI docs settle" (fetched live, PANEL-2026-09-14-
// TEST-PLAN.md citation): session.update applies "on the next turn" (too late for the
// automatic reply already generating for THIS turn); reply.create is the only "speak now"
// event; no client event can force an exact sentence at an exact moment -- "the agent always
// generates responses based on its system prompt and conversation context." There is
// therefore no documented way to stop or pre-empt the automatic reply itself.
//
// Design E's two-part fix:
//  1. prompt.ts's STANDING_RULES gained a standing sentence that constrains whatever the
//     automatic reply says (it is present under EVERY goal's system_prompt, so it is in force
//     even for the stale prompt an automatic reply may still be composing under) to a short,
//     harmless holding beat -- never a question, readback, verdict word, or invented request.
//  2. session.ts's `maybeSendReplyCreateForTick`/`maybeSendReplyCreateAfterReplyDone` now send
//     exactly one instructed `reply.create` (the engine's own goal sentence, one-shot via
//     `instructions`, verified against `mustForceSpeak`/`instructedSentenceFor`) for
//     QUESTION_GOALS renderings triggered by a genuine caller turn -- the SAME mechanism CLOSE
//     already had (round 3/4/5, closeMatch.ts) -- rather than hoping the automatic reply picks
//     up the fresh system_prompt in time. `maybeReaskQuestion`/`questionMatch.ts`'s existing
//     transcript verification is reused unchanged to catch a reply (automatic or instructed)
//     that swapped a holding line for the real question.
//
// This file exercises the NEW proactive-send mechanism directly; the existing reactive-reask
// mechanism (questionMatch.ts's own transcript check, `armQuestionReaskTimer`) is unchanged
// and already covered by session.test.ts's own "question-reask" describe block -- this file
// does not re-prove it, only how it composes with the new proactive send.
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

describe('Design E: the automatic reply is a holding beat only; the server\'s own instructed reply.create is the single path for goal speech', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // (a) immediate case: nothing is speaking when the caller turn's tick lands on a fresh
  // QUESTION_GOALS rendering -- exactly one reply.create goes out synchronously, carrying the
  // goal's own sentence.
  it('(a-1) immediate: a caller turn landing on a fresh question goal with nothing in flight sends exactly one instructed reply.create, synchronously', () => {
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const session = newSession(clock, CALL_B, aai, sent);
    session.start(); // GREET -- no reply.create yet (GREET is excluded)
    expect(replyCreatesOf(aai)).toHaveLength(0);

    clock.now = 1000;
    aai.emit({ type: 'transcript.user', item_id: 'c1', text: scenarioB.conversation[0]!.text });

    expect(session.last?.goal.code).toBe('ASK_CHALLENGE');
    const sentence = session.last!.goal.challenge!.speak!;

    // Exactly one reply.create, sent immediately (no reply.started ever preceded it -- proof
    // it was not deferred behind an in-flight reply), carrying the challenge's own sentence.
    const replyCreates = replyCreatesOf(aai);
    expect(replyCreates).toHaveLength(1);
    expect(replyCreates[0]!.instructions).toBe(`Say exactly this and nothing else: "${sentence}"`);

    const internals = session as unknown as { replyCreateAwaitingStart: boolean; speaking: boolean };
    expect(internals.replyCreateAwaitingStart).toBe(true); // outstanding, awaiting its own reply.started
    expect(internals.speaking).toBe(false);
  });

  // (a-2) deferred case: a reply (the automatic one, phrased under the OLD goal) is already
  // speaking when the caller turn arrives -- the instructed reply.create for the fresh
  // question is deferred until that in-flight reply's own reply.done, then sent exactly once.
  it('(a-2) deferred: a caller turn landing on a fresh question goal while a reply is in flight sends exactly one instructed reply.create, right after that reply\'s own reply.done', () => {
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const session = newSession(clock, CALL_B, aai, sent);
    session.start();

    // c1 reaches ASK_CHALLENGE and sends its own proactive reply.create immediately (a-1's
    // own shape) -- its reply.started arrives and starts a reply speaking.
    clock.now = 1000;
    aai.emit({ type: 'transcript.user', item_id: 'c1', text: scenarioB.conversation[0]!.text });
    expect(replyCreatesOf(aai)).toHaveLength(1);
    clock.now = 1200;
    aai.emit({ type: 'reply.started', reply_id: 'a1' });
    const internals = session as unknown as { speaking: boolean };
    expect(internals.speaking).toBe(true);

    // A SECOND caller turn (a self-correction/interjection) arrives WHILE 'a1' is still
    // speaking -- the engine advances to a fresh rendering (a different challenge/goal), but
    // no reply.create can go out yet (busy guard).
    clock.now = 1300;
    aai.emit({ type: 'transcript.user', item_id: 'c2', text: scenarioB.conversation[2]!.text });
    expect(replyCreatesOf(aai)).toHaveLength(1); // still just the original -- deferred, not lost

    // 'a1' completes (its own transcript is irrelevant here -- a plain holding line) -- the
    // deferred send goes out NOW, right after this reply.done, exactly once.
    clock.now = 1800;
    aai.emit({ type: 'transcript.agent', item_id: 'x-a1', text: 'One moment.', reply_id: 'a1', interrupted: false });
    aai.emit({ type: 'reply.done', reply_id: 'a1', status: 'completed' });

    expect(replyCreatesOf(aai)).toHaveLength(2);
    const latest = replyCreatesOf(aai).at(-1)!;
    expect(latest.type).toBe('reply.create');
    expect(latest.instructions).toContain('Say exactly this and nothing else');
  });

  // (b) the automatic reply's own transcript, when it is a holding line (per the new standing
  // rule), does NOT count as the question having been asked -- but the instructed reply's own
  // transcript (the real sentence) does. Reuses questionMatch.ts's existing
  // transcriptAsksQuestion/recordGoalCompletionAction machinery unchanged -- this proves how
  // it composes with the new proactive send, not the matcher itself (see questionMatch.test.ts
  // for that).
  it('(b) a holding-line automatic reply does not count as the question asked; the instructed reply that follows, carrying the real sentence, does', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newSession(clock, CALL_B, aai, sent, diagEvents);
    session.start();

    clock.now = 1000;
    aai.emit({ type: 'transcript.user', item_id: 'c1', text: scenarioB.conversation[0]!.text });
    expect(session.last?.goal.code).toBe('ASK_CHALLENGE');
    const sentence = session.last!.goal.challenge!.speak!;
    expect(replyCreatesOf(aai)).toHaveLength(1); // the proactive instructed ask, from (a-1)

    // The reply that answers first is AssemblyAI's own automatic one, saying only the new
    // standing holding-beat line -- never the real question.
    clock.now = 1200;
    aai.emit({ type: 'reply.started', reply_id: 'auto-1' });
    aai.emit({ type: 'transcript.agent', item_id: 'x-auto-1', text: 'One moment.', reply_id: 'auto-1', interrupted: false });
    clock.now = 1500;
    aai.emit({ type: 'reply.done', reply_id: 'auto-1', status: 'completed' });

    // Not counted as asked -- no challenge_issued logged, the goal is unchanged, and the
    // reask machinery (unchanged, questionMatch.ts) arms because the holding line did not
    // satisfy transcriptAsksQuestion.
    expect(session.logs.actions.some((a) => a.kind === 'challenge_issued')).toBe(false);
    expect(session.last?.goal.code).toBe('ASK_CHALLENGE');

    // The spaced reask (+400ms, CallSession.CLOSE_RETRY_MIN_GAP_MS reused for the reask
    // timer) fires, carrying the SAME instructed sentence.
    vi.advanceTimersByTime(400);
    const replyCreates = replyCreatesOf(aai);
    expect(replyCreates).toHaveLength(2);
    expect(replyCreates.at(-1)!.instructions).toBe(`Say exactly this and nothing else: "${sentence}"`);

    // This time the reply (the instructed one, or AssemblyAI's own automatic follow-up --
    // indistinguishable by labelling, see session.ts's own doc comment on why the transcript
    // is what decides it) actually carries the real sentence -- IS counted as asked.
    clock.now = 2000;
    aai.emit({ type: 'reply.started', reply_id: 'r2' });
    aai.emit({ type: 'transcript.agent', item_id: 'x-r2', text: sentence, reply_id: 'r2', interrupted: false });
    clock.now = 2300;
    aai.emit({ type: 'reply.done', reply_id: 'r2', status: 'completed' });

    const issued = session.logs.actions.filter((a) => a.kind === 'challenge_issued');
    expect(issued).toHaveLength(1);

    // No further reask -- the question is confirmed asked.
    vi.advanceTimersByTime(1000);
    expect(replyCreatesOf(aai)).toHaveLength(2);
  });

  // (c) unchanged from today (round 5, 2026-09-14): after the verdict, the goodbye
  // reply.create is sent once (per the tick that renders it), and a stray automatic reply
  // that starts AFTER the goodbye is transcript-confirmed has its audio suppressed rather
  // than relayed. Design E does not touch this mechanism at all -- this test exists to prove
  // it still holds in the presence of the new proactive QUESTION_GOALS sends earlier in the
  // SAME call (unlike session.test.ts's own round-5 describe block, which drives straight to
  // CLOSE without exercising any QUESTION_GOALS turn first).
  it('(c) after the verdict, the goodbye reply.create is sent once and a stray automatic reply after it is suppressed, unchanged', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newSession(clock, CALL_B, aai, sent, diagEvents);
    session.start();

    // Drive Scenario B's own c1..a4 exactly as session.test.ts's own `driveScenarioBThroughA4`
    // does (proven to reach FREEZE/SEALED/CLOSE) -- the NEW mechanism (a proactive instructed
    // reply.create per caller turn landing on a fresh ASK_CHALLENGE/READBACK rendering) fires
    // throughout this drive; `baseline` below is however many of those already went out by
    // the time the call reaches CLOSE.
    clock.now = 1000;
    aai.emit({ type: 'transcript.user', item_id: 'c1', text: scenarioB.conversation[0]!.text });
    clock.now = 4000;
    aai.emit({ type: 'reply.started', reply_id: 'a1' });
    aai.emit({ type: 'transcript.agent', item_id: 'x-a1', text: scenarioB.conversation[1]!.text, reply_id: 'a1', interrupted: false });
    aai.emit({ type: 'reply.done', reply_id: 'a1', status: 'completed' });

    clock.now = 8000;
    aai.emit({ type: 'transcript.user', item_id: 'c2', text: scenarioB.conversation[2]!.text });
    clock.now = 12_000;
    aai.emit({ type: 'reply.started', reply_id: 'a2' });
    aai.emit({ type: 'transcript.agent', item_id: 'x-a2', text: scenarioB.conversation[3]!.text, reply_id: 'a2', interrupted: false });
    aai.emit({ type: 'reply.done', reply_id: 'a2', status: 'completed' });

    clock.now = 40_000;
    aai.emit({ type: 'transcript.user', item_id: 'c3', text: scenarioB.conversation[4]!.text });
    clock.now = 44_000;
    aai.emit({ type: 'reply.started', reply_id: 'a3' });
    aai.emit({ type: 'transcript.agent', item_id: 'x-a3', text: scenarioB.conversation[5]!.text, reply_id: 'a3', interrupted: true });
    aai.emit({ type: 'reply.done', reply_id: 'a3', status: 'interrupted' });

    clock.now = 48_000;
    aai.emit({ type: 'transcript.user', item_id: 'c4', text: scenarioB.conversation[6]!.text });
    clock.now = 50_000;
    aai.emit({ type: 'reply.started', reply_id: 'a4' });
    aai.emit({ type: 'transcript.agent', item_id: 'x-a4', text: scenarioB.conversation[7]!.text, reply_id: 'a4', interrupted: false });
    aai.emit({ type: 'reply.done', reply_id: 'a4', status: 'completed' });

    // Two more real asks (same shape session.test.ts's own helper uses) complete Scenario B's
    // own three-challenge requirement.
    if (session.last?.goal.code === 'ASK_CHALLENGE' && session.last.goal.challenge) {
      clock.now = 50_100;
      const s1 = session.last.goal.challenge.speak!;
      aai.emit({ type: 'reply.started', reply_id: 'x1' });
      aai.emit({ type: 'transcript.agent', item_id: 'ax1', text: s1, reply_id: 'x1', interrupted: false });
      aai.emit({ type: 'reply.done', reply_id: 'x1', status: 'completed' });
    }
    if (session.last?.goal.code === 'ASK_CHALLENGE' && session.last.goal.challenge) {
      clock.now = 50_200;
      const s2 = session.last.goal.challenge.speak!;
      aai.emit({ type: 'reply.started', reply_id: 'x2' });
      aai.emit({ type: 'transcript.agent', item_id: 'ax2', text: s2, reply_id: 'x2', interrupted: false });
      aai.emit({ type: 'reply.done', reply_id: 'x2', status: 'completed' });
    }

    expect(session.last?.state).toBe('SEALED');
    expect(session.last?.goal.code).toBe('CLOSE');
    expect(session.logs.actions.some((a) => a.kind === 'challenge_issued')).toBe(true); // the NEW mechanism was exercised

    // Exactly one reply.create for CLOSE itself, on top of whatever the QUESTION_GOALS
    // renderings above already sent.
    const closeDiags = diagEvents.filter(
      (e) => e.kind === 'reply_create_sent' && (e.detail as { goal_code: string }).goal_code === 'CLOSE'
    );
    expect(closeDiags).toHaveLength(1);

    // The goodbye is confirmed: a reply whose own transcript says the close sentence.
    const closeSentence = session.last!.goal.hint;
    clock.now = 51_000;
    aai.emit({ type: 'reply.started', reply_id: 'close-1' });
    aai.emit({ type: 'transcript.agent', item_id: 'x-close-1', text: closeSentence, reply_id: 'close-1', interrupted: false });
    clock.now = 51_100;
    aai.emit({ type: 'reply.done', reply_id: 'close-1', status: 'completed' });

    // A stray automatic reply starts AFTER the goodbye is transcript-confirmed -- its audio
    // must be suppressed (unchanged round-5 mechanism), not relayed.
    clock.now = 51_150;
    aai.emit({ type: 'reply.started', reply_id: 'stray-1' });
    const suppressed = diagEvents.filter((e) => e.kind === 'post_goodbye_reply_suppressed');
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0]!.detail).toEqual({ reply_id: 'stray-1' });

    // No further reply.create for CLOSE once confirmed -- the call ends on schedule.
    vi.advanceTimersByTime(1500);
    expect(sent.at(-1)).toEqual({ type: 'ended', reason: 'agent_closed' });
    const finalCloseDiags = diagEvents.filter(
      (e) => e.kind === 'reply_create_sent' && (e.detail as { goal_code: string }).goal_code === 'CLOSE'
    );
    expect(finalCloseDiags).toHaveLength(1); // still exactly one -- the goodbye was heard first try
  });

  // (d) no reply.create is ever sent while a reply is in flight -- proactive QUESTION_GOALS
  // sends respect the exact same `this.speaking`/`replyCreateAwaitingStart` guards CLOSE's own
  // sends already do (session.ts's `maybeSendReplyCreateForTick`).
  it('(d) no reply.create is sent while a reply is in flight, even for a freshly-rendered question goal', () => {
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const session = newSession(clock, CALL_B, aai, sent);
    session.start();

    clock.now = 1000;
    aai.emit({ type: 'transcript.user', item_id: 'c1', text: scenarioB.conversation[0]!.text });
    expect(replyCreatesOf(aai)).toHaveLength(1); // the c1 proactive ask

    clock.now = 1200;
    aai.emit({ type: 'reply.started', reply_id: 'a1' });
    const internals = session as unknown as { speaking: boolean; replyCreateAwaitingStart: boolean };
    expect(internals.speaking).toBe(true);
    expect(internals.replyCreateAwaitingStart).toBe(false); // reply.started consumed it

    // A second caller turn arrives while 'a1' is still speaking -- the engine ticks and may
    // land on a fresh rendering, but the busy guard must block any send.
    clock.now = 1300;
    aai.emit({ type: 'transcript.user', item_id: 'c2', text: scenarioB.conversation[2]!.text });
    expect(replyCreatesOf(aai)).toHaveLength(1); // unchanged -- still speaking

    // Even a THIRD event (a stray tool.call, rejected but still ticking the engine) while
    // 'a1' is still speaking must not send either.
    clock.now = 1400;
    aai.emit({ type: 'tool.call', call_id: 'stray', name: 'check_sso_context', arguments: {} });
    expect(replyCreatesOf(aai)).toHaveLength(1);
    expect(internals.speaking).toBe(true);
  });
});
