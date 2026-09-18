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

  // P0 fix (2026-09-18): CallSession.AUTOMATIC_REPLY_SETTLE_MS -- see that field's own doc
  // comment in call/session.ts for the full PROVEN incident (three same-day live/harness
  // records of a garbled, word-interleaved first-turn reply). A caller-turn-triggered fresh
  // question no longer sends its instructed reply.create synchronously -- it is deferred by
  // this many ms so AssemblyAI's own automatic reply for the SAME turn, if one is coming, has
  // time to start (and flip `speaking`) first.
  const AUTOMATIC_REPLY_SETTLE_MS = 150; // CallSession.AUTOMATIC_REPLY_SETTLE_MS

  // (a) immediate case: nothing is speaking when the caller turn's tick lands on a fresh
  // QUESTION_GOALS rendering -- no automatic reply ever starts, so the settle timer's own
  // fallback sends exactly one reply.create once it elapses, carrying the goal's own sentence.
  it('(a-1) fallback: a caller turn landing on a fresh question goal, with nothing starting to speak, sends exactly one instructed reply.create once the settle window elapses', () => {
    vi.useFakeTimers();
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

    // Nothing sent yet -- the settle timer is armed, not fired.
    expect(replyCreatesOf(aai)).toHaveLength(0);
    const internals = session as unknown as { replyCreateAwaitingStart: boolean; speaking: boolean };
    expect(internals.replyCreateAwaitingStart).toBe(false);

    // Nothing ever starts speaking within the window -- the fallback fires and sends exactly
    // one reply.create, carrying the challenge's own sentence. Measures the added latency:
    // this is the exact, and only, delay a caller with no automatic reply on this turn incurs.
    vi.advanceTimersByTime(AUTOMATIC_REPLY_SETTLE_MS);
    const replyCreates = replyCreatesOf(aai);
    expect(replyCreates).toHaveLength(1);
    expect(replyCreates[0]!.instructions).toBe(`Say exactly this and nothing else: "${sentence}"`);
    expect(internals.replyCreateAwaitingStart).toBe(true); // outstanding, awaiting its own reply.started
    expect(internals.speaking).toBe(false);
  });

  // (a-1b) THE PROVEN LIVE DEFECT, closed: if AssemblyAI's own automatic reply for this same
  // turn starts speaking WITHIN the settle window, the instructed send is deferred to that
  // reply's own reply.done (via the existing busy-guard + owedQuestionGoalKey catch-up path)
  // instead of firing at all here -- the two can never collide/interleave into one garbled
  // reply the way the live records show (95b9ad42/32cbb410, 2026-09-18).
  it('(a-1b) PROVEN LIVE DEFECT closed: an automatic reply starting within the settle window defers the instructed send to its own reply.done, never sending both at once', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const session = newSession(clock, CALL_B, aai, sent);
    session.start();

    clock.now = 1000;
    aai.emit({ type: 'transcript.user', item_id: 'c1', text: scenarioB.conversation[0]!.text });
    expect(session.last?.goal.code).toBe('ASK_CHALLENGE');
    const sentence = session.last!.goal.challenge!.speak!;
    expect(replyCreatesOf(aai)).toHaveLength(0);

    // AssemblyAI's own automatic reply for this turn starts almost immediately (PROVEN live:
    // 0-1ms after the caller's turn ended) -- well within the settle window.
    vi.advanceTimersByTime(5);
    aai.emit({ type: 'reply.started', reply_id: 'auto-1' });
    const internals = session as unknown as { speaking: boolean; replyCreateAwaitingStart: boolean };
    expect(internals.speaking).toBe(true);

    // The settle window elapses while 'auto-1' is still speaking -- the fallback must NOT
    // fire (that would be exactly the live collision this fix closes): still zero sent.
    vi.advanceTimersByTime(AUTOMATIC_REPLY_SETTLE_MS);
    expect(replyCreatesOf(aai)).toHaveLength(0);
    expect(internals.speaking).toBe(true); // 'auto-1' still in flight -- never interrupted by our own send

    // 'auto-1' finishes (a holding line, per the standing rule) -- THE instructed reply.create
    // goes out now, exactly once, never overlapping 'auto-1'.
    aai.emit({ type: 'transcript.agent', item_id: 'x-auto-1', text: 'One moment.', reply_id: 'auto-1', interrupted: false });
    aai.emit({ type: 'reply.done', reply_id: 'auto-1', status: 'completed' });
    const replyCreates = replyCreatesOf(aai);
    expect(replyCreates).toHaveLength(1);
    expect(replyCreates[0]!.instructions).toBe(`Say exactly this and nothing else: "${sentence}"`);
  });

  // (a-2) deferred case: a reply (the automatic one, phrased under the OLD goal) is already
  // speaking when the caller turn arrives -- the instructed reply.create for the fresh
  // question is deferred until that in-flight reply's own reply.done, then sent exactly once.
  it('(a-2) deferred: a caller turn landing on a fresh question goal while a reply is in flight sends exactly one instructed reply.create, right after that reply\'s own reply.done', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const session = newSession(clock, CALL_B, aai, sent);
    session.start();

    // c1 reaches ASK_CHALLENGE; nothing starts speaking within the settle window (P0 fix,
    // 2026-09-18 -- see AUTOMATIC_REPLY_SETTLE_MS above), so the fallback send fires (a-1's
    // own shape) -- its reply.started arrives and starts a reply speaking.
    clock.now = 1000;
    aai.emit({ type: 'transcript.user', item_id: 'c1', text: scenarioB.conversation[0]!.text });
    vi.advanceTimersByTime(AUTOMATIC_REPLY_SETTLE_MS);
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
  it('(b) an automatic reply that starts within the settle window and says only the holding line is followed by exactly one instructed reply.create, right after its own reply.done, which is what gets counted as asked', () => {
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
    expect(replyCreatesOf(aai)).toHaveLength(0); // deferred -- settle window not elapsed yet

    // The reply that answers first is AssemblyAI's own automatic one, starting well within the
    // settle window (P0 fix, 2026-09-18) and saying only the new standing holding-beat line --
    // never the real question. Our own instructed send is deferred (busy guard), not lost.
    clock.now = 1200;
    aai.emit({ type: 'reply.started', reply_id: 'auto-1' });
    aai.emit({ type: 'transcript.agent', item_id: 'x-auto-1', text: 'One moment.', reply_id: 'auto-1', interrupted: false });
    expect(replyCreatesOf(aai)).toHaveLength(0);
    clock.now = 1500;
    aai.emit({ type: 'reply.done', reply_id: 'auto-1', status: 'completed' });

    // Not counted as asked (the holding line never satisfied transcriptAsksQuestion) -- but
    // the deferred instructed send goes out immediately, right after 'auto-1's own reply.done
    // (the busy-guard catch-up path, `maybeSendReplyCreateAfterReplyDone`), carrying the
    // SAME sentence the old design's proactive send always did.
    expect(session.logs.actions.some((a) => a.kind === 'challenge_issued')).toBe(false);
    expect(session.last?.goal.code).toBe('ASK_CHALLENGE');
    const replyCreates = replyCreatesOf(aai);
    expect(replyCreates).toHaveLength(1);
    expect(replyCreates[0]!.instructions).toBe(`Say exactly this and nothing else: "${sentence}"`);

    // This reply (the instructed one) actually carries the real sentence -- IS counted as
    // asked.
    clock.now = 2000;
    aai.emit({ type: 'reply.started', reply_id: 'r2' });
    aai.emit({ type: 'transcript.agent', item_id: 'x-r2', text: sentence, reply_id: 'r2', interrupted: false });
    clock.now = 2300;
    aai.emit({ type: 'reply.done', reply_id: 'r2', status: 'completed' });

    const issued = session.logs.actions.filter((a) => a.kind === 'challenge_issued');
    expect(issued).toHaveLength(1);

    // No further reask -- the question is confirmed asked.
    vi.advanceTimersByTime(1000);
    expect(replyCreatesOf(aai)).toHaveLength(1);
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
    // FIX (2026-09-15/16, Dana regression): sess-b-2 (issued via x1, just above) only stops
    // being genuinely AWAITING once `challenge_answer_window_ms` has elapsed since ITS OWN
    // issuance (challenges.ts's `challengeReplyWindowStatus`) -- fake clock, so this costs
    // nothing in real test run time.
    if (session.last?.goal.code === 'ASK_CHALLENGE' && session.last.goal.challenge) {
      clock.now = 66_200;
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
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const session = newSession(clock, CALL_B, aai, sent);
    session.start();

    clock.now = 1000;
    aai.emit({ type: 'transcript.user', item_id: 'c1', text: scenarioB.conversation[0]!.text });
    vi.advanceTimersByTime(AUTOMATIC_REPLY_SETTLE_MS); // nothing else starts speaking -- the fallback send fires
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

// P0 review fix (2026-09-18, findings F1-F3 on top of e99e17f's own P0 fix above):
// F1. `armTickEndSendTimer`'s callback used to close over `goalCode`/`instructions` captured
//     at ARM time and never re-read `this.last.goal` at FIRE time (every other deferred send
//     path in this class -- `maybeSendReplyCreateAfterReplyDone`'s `owedQuestion` check, the
//     `questionReaskTimer` callback -- re-derives the current goal and compares it against its
//     own stored key first). A non-caller-turn tick could move the goal on (to CLOSE, or
//     anywhere else) without ever clearing this timer -- `end('idle_timeout')`'s own
//     idle-defer branch can `return` (twice) before `this.ended` is set or `clearCloseTimers`
//     is ever reached, and the synchronous `forceSpeak` send path didn't clear it either.
//     "Today only the busy-guard's timing prevents a stale question from being spoken" (review
//     finding, PROVEN by code reading, no live incident needed to reproduce it deterministically
//     with a fake clock).
// F2. `AUTOMATIC_REPLY_SETTLE_MS` (150ms) stays an ESTIMATE -- ONLY covered by
//     call/session.ts's own doc comment plus the new `turn_to_reply_gap` diagnostic
//     (session.test.ts/diagnostics.test.ts cover that directly); not retested here.
// F3. The live-observed shape where the automatic reply asks its OWN unrequested question
//     (not a bare holding line) composes exactly like test (b) above.
describe('P0 review fix (2026-09-18, F1): the tick-end settle timer re-validates against the CURRENT goal at fire time, and end() clears it on every path', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('(F1-a) a stale settle timer for a question the call has since moved on from (goal now CLOSE) is never sent, even once nothing is busy and the settle window elapses', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const session = newSession(clock, CALL_B, aai, sent);
    session.start();

    // c1 lands on a fresh ASK_CHALLENGE rendering -- arms the tick-end settle timer (150ms),
    // not yet fired.
    clock.now = 1000;
    aai.emit({ type: 'transcript.user', item_id: 'c1', text: scenarioB.conversation[0]!.text });
    expect(session.last?.goal.code).toBe('ASK_CHALLENGE');
    const staleSentence = session.last!.goal.challenge!.speak!;
    expect(replyCreatesOf(aai)).toHaveLength(0);

    // Before that timer ever fires, the call ends via the idle-timeout path with a request
    // already on record (row 15) -- nothing is speaking, so the resulting CLOSE reply.create
    // goes out synchronously, in the SAME tick that discovers CLOSE.
    clock.now = 30000;
    session.end('idle_timeout');
    expect(session.last?.goal.code).toBe('CLOSE');
    const closeSentence = session.last!.goal.hint;
    const afterEnd = replyCreatesOf(aai);
    expect(afterEnd).toHaveLength(1);
    expect(afterEnd[0]!.instructions).toBe(`Say exactly this and nothing else: "${closeSentence}"`);

    // That first CLOSE reply completes, but says only a generic holding line -- NOT the close
    // sentence (a live-plausible shape: an interrupted/paraphrased/degraded first attempt) --
    // so `goodbyeConfirmed` stays false and a close_retry is armed (CLOSE_RETRY_MIN_GAP_MS =
    // 400ms, well outside this test's own 150ms settle window). Speaking/awaiting both clear
    // once this reply is done, well before either the settle window OR the retry elapses --
    // note this is NOT the same as the goodbye being heard: `sendReplyCreate`'s own unrelated
    // `goodbyeConfirmed` guard (round 5, pre-dating this fix) would otherwise mask this exact
    // race by refusing ANY further send once the close line is transcript-confirmed, so a
    // confirmed-goodbye version of this test would not actually exercise the bug.
    clock.now = 30050;
    aai.emit({ type: 'reply.started', reply_id: 'close-1' });
    aai.emit({ type: 'transcript.agent', item_id: 'x-close-1', text: 'One moment.', reply_id: 'close-1', interrupted: false });
    clock.now = 30100;
    aai.emit({ type: 'reply.done', reply_id: 'close-1', status: 'completed' });

    // The settle window from c1's OWN fresh question elapses now, inside the close-retry gap
    // -- PROVEN failure mode (review finding F1): before the fix, this fired anyway
    // (goalCode/instructions captured at arm time, never re-checked against the current goal)
    // and sent a SECOND, STALE reply.create for the already-abandoned ASK_CHALLENGE question,
    // interleaved with the still-unconfirmed CLOSE goodbye.
    vi.advanceTimersByTime(150);
    const afterWindow = replyCreatesOf(aai);
    expect(afterWindow).toHaveLength(1); // still just the CLOSE one -- nothing stale went out
    expect(afterWindow.some((m) => m.instructions === `Say exactly this and nothing else: "${staleSentence}"`)).toBe(false);
  });

  it('(F1-b) end() clears the settle timer even on the idle-defer path that can return before clearCloseTimers is ever reached', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const session = newSession(clock, CALL_B, aai, sent);
    session.start();

    // c1 lands on a fresh ASK_CHALLENGE rendering -- arms the settle timer.
    clock.now = 1000;
    aai.emit({ type: 'transcript.user', item_id: 'c1', text: scenarioB.conversation[0]!.text });
    expect(session.last?.goal.code).toBe('ASK_CHALLENGE');
    const staleSentence = session.last!.goal.challenge!.speak!;
    expect(replyCreatesOf(aai)).toHaveLength(0);

    // An ambient automatic reply for this same turn starts speaking BEFORE the settle window
    // elapses -- the busy guard is now active.
    clock.now = 1005;
    aai.emit({ type: 'reply.started', reply_id: 'auto-x' });
    const internals = session as unknown as { speaking: boolean };
    expect(internals.speaking).toBe(true);

    // The call ends via idle-timeout while 'auto-x' is still speaking -- row 15 turns the
    // verdict ESCALATE/CLOSE, but the busy guard blocks a SYNCHRONOUS CLOSE send: the
    // idle-defer branch returns (goal already CLOSE) WITHOUT ever reaching `clearCloseTimers`.
    clock.now = 30000;
    session.end('idle_timeout');
    expect(session.last?.goal.code).toBe('CLOSE');
    expect(replyCreatesOf(aai)).toHaveLength(0); // CLOSE itself is still deferred (busy)

    // 'auto-x' finishes -- the busy-guard catch-up path (`maybeSendReplyCreateAfterReplyDone`)
    // sends CLOSE now. This catch-up send is NOT the `owedQuestion` branch (the CURRENT goal,
    // CLOSE, does not match the stale ASK_CHALLENGE key `owedQuestionGoalKey` still holds) --
    // it does not clear the tick-end timer either, so only `end()`'s own top-of-method clear
    // is what can save this.
    clock.now = 30100;
    aai.emit({ type: 'transcript.agent', item_id: 'x-auto-x', text: 'One moment.', reply_id: 'auto-x', interrupted: false });
    aai.emit({ type: 'reply.done', reply_id: 'auto-x', status: 'completed' });
    const closeSentence = session.last!.goal.hint;
    const afterCatchUp = replyCreatesOf(aai);
    expect(afterCatchUp).toHaveLength(1);
    expect(afterCatchUp[0]!.instructions).toBe(`Say exactly this and nothing else: "${closeSentence}"`);

    // That CLOSE reply completes, but says only a generic holding line -- NOT the close
    // sentence (a live-plausible shape: interrupted/paraphrased/degraded) -- so
    // `goodbyeConfirmed` stays false. This matters: `sendReplyCreate`'s own UNRELATED
    // `goodbyeConfirmed` guard (round 5, pre-dating this fix) refuses ANY further send once
    // the close line is transcript-confirmed, which would otherwise mask this exact race --
    // a confirmed-goodbye version of this step would not actually exercise the bug.
    clock.now = 30200;
    aai.emit({ type: 'reply.started', reply_id: 'close-1' });
    aai.emit({ type: 'transcript.agent', item_id: 'x-close-1', text: 'One moment.', reply_id: 'close-1', interrupted: false });
    aai.emit({ type: 'reply.done', reply_id: 'close-1', status: 'completed' });

    // The settle window from c1's OWN fresh question (armed at the very start, 150ms) elapses
    // now, inside the close-retry gap (CLOSE_RETRY_MIN_GAP_MS = 400ms) -- PROVEN failure mode
    // (review finding F1):
    // before the fix, `end()`'s own idle-defer early return left this timer armed,
    // `this.ended` was still false, and nothing was speaking any more by this point -- it
    // fired and sent the stale ASK_CHALLENGE question AFTER the caller had already heard the
    // goodbye.
    vi.advanceTimersByTime(150);
    const afterWindow = replyCreatesOf(aai);
    expect(afterWindow).toHaveLength(1); // still just the one CLOSE send -- nothing stale
    expect(afterWindow.some((m) => m.instructions === `Say exactly this and nothing else: "${staleSentence}"`)).toBe(false);
  });

  it('(F1-c) the normal case is unchanged: a fresh question with nothing else ever speaking still sends exactly once, once the settle window elapses', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const session = newSession(clock, CALL_B, aai, sent);
    session.start();

    clock.now = 1000;
    aai.emit({ type: 'transcript.user', item_id: 'c1', text: scenarioB.conversation[0]!.text });
    expect(session.last?.goal.code).toBe('ASK_CHALLENGE');
    const sentence = session.last!.goal.challenge!.speak!;
    expect(replyCreatesOf(aai)).toHaveLength(0);

    vi.advanceTimersByTime(150);
    const replyCreates = replyCreatesOf(aai);
    expect(replyCreates).toHaveLength(1);
    expect(replyCreates[0]!.instructions).toBe(`Say exactly this and nothing else: "${sentence}"`);

    // Advancing further changes nothing -- the timer only ever fires once.
    vi.advanceTimersByTime(1000);
    expect(replyCreatesOf(aai)).toHaveLength(1);
  });

  // F3 (review finding): the PROVEN live shape (2026-09-18, 95b9ad42/32cbb410) -- the
  // automatic reply is not always a bare holding line; it can ask its OWN unrequested
  // question ("One moment. Who is calling and what is your authorization code?"). This must
  // compose exactly like test (b) in the describe block above: no merged send (our own
  // instructed reply.create never overlaps the ambient one -- these are always two separate,
  // sequential `reply.create`/`reply.done` cycles, never one word-interleaved reply the way
  // the live incident's own AssemblyAI-side merge was), and our instructed question sent
  // right after the ambient reply's own reply.done, carrying our OWN exact sentence, never
  // the ambient reply's wording.
  //
  // `questionMatch.ts`'s own `transcriptAsksQuestion` (unchanged by this fix, pre-existing
  // since the 2026-09-14 question-reask fix -- see that module's own doc comment) treats ANY
  // reply whose transcript contains a literal "?" as having satisfied the CURRENT goal's
  // question-asked bookkeeping, regardless of whose reply it was or what it actually asked --
  // deliberately lenient, and safe under LAW 3: `recordGoalCompletionAction`'s own comment is
  // explicit that this only ever lets the engine treat the question as issued (so its own
  // challenge-selection logic advances), never grades anything -- grading stays exclusively
  // the caller's own words, via the engine's `gradeChallenges`, completely untouched by this.
  // So the ambient reply's own "?" here DOES register one `challenge_issued` for this
  // rendering (not a bug this fix introduces or is scoped to close) -- what this test proves
  // is the part THIS fix (F1/F3) actually owns: it registers exactly once (not merged into
  // two, not lost), and our own separate, correctly-sequenced instructed send still goes out
  // right after, carrying our own exact words.
  it('(F3) an ambient automatic reply that asks its own unrequested question inside the settle window never merges with ours, and our instructed send still goes out separately, right after its reply.done', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const session = newSession(clock, CALL_B, aai, sent);
    session.start();

    clock.now = 1000;
    aai.emit({ type: 'transcript.user', item_id: 'c1', text: scenarioB.conversation[0]!.text });
    expect(session.last?.goal.code).toBe('ASK_CHALLENGE');
    const sentence = session.last!.goal.challenge!.speak!;
    expect(replyCreatesOf(aai)).toHaveLength(0); // deferred -- settle window not elapsed yet
    expect(session.logs.actions.some((a) => a.kind === 'challenge_issued')).toBe(false);

    // The reply that answers first is AssemblyAI's own automatic one -- PROVEN live shape
    // (95b9ad42/32cbb410, 2026-09-18): not a bare holding line, but its OWN
    // STANDING_RULES-violating question, never anything any goal in this codebase asks for.
    clock.now = 1050;
    aai.emit({ type: 'reply.started', reply_id: 'auto-1' });
    aai.emit({
      type: 'transcript.agent',
      item_id: 'x-auto-1',
      text: 'One moment. Who is calling and what is your authorization code?',
      reply_id: 'auto-1',
      interrupted: false,
    });
    // No send while 'auto-1' is still in flight -- no merge, no collision: our own reply.create
    // never overlaps the ambient one, unlike the live incident's single garbled, word-
    // interleaved reply.
    expect(replyCreatesOf(aai)).toHaveLength(0);

    clock.now = 1300;
    aai.emit({ type: 'reply.done', reply_id: 'auto-1', status: 'completed' });

    // Exactly one challenge_issued for this rendering -- registered once (from 'auto-1's own
    // "?", per `transcriptAsksQuestion`'s pre-existing lenient matching, unchanged here), not
    // merged into two and not lost. Our OWN instructed send goes out separately, right after
    // 'auto-1's own reply.done (the busy-guard catch-up path), carrying OUR exact challenge
    // sentence -- never the ambient reply's own wording, and never combined with it into one
    // message.
    const issued = session.logs.actions.filter((a) => a.kind === 'challenge_issued');
    expect(issued).toHaveLength(1);
    const replyCreates = replyCreatesOf(aai);
    expect(replyCreates).toHaveLength(1);
    expect(replyCreates[0]!.instructions).toBe(`Say exactly this and nothing else: "${sentence}"`);
    expect(replyCreates[0]!.instructions).not.toContain('authorization code');

    // No further instructed send -- the settle window elapsing changes nothing further.
    vi.advanceTimersByTime(1000);
    expect(replyCreatesOf(aai)).toHaveLength(1);
    expect(session.logs.actions.filter((a) => a.kind === 'challenge_issued')).toHaveLength(1);
  });
});
