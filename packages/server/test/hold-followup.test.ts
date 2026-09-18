// packages/server/test/hold-followup.test.ts
// HOLD-WITHOUT-FOLLOW-UP fix (2026-09-17, PROVEN live -- deploy 45, record
// scripts/rehearse/reports/2026-09-17T08-46-58-judge-out-of-scope, main checkout, gitignored):
// the standing rule (prompt.ts's STANDING_RULES) makes AssemblyAI's own automatic reply say
// exactly "One moment." whenever it must speak with nothing new to say; when the engine's goal
// does not change on the caller's own turn (chatter, no request), no instructed reply.create
// ever follows, and the caller hears "One moment." then silence until the idle timer.
//
// This suite proves `call/session.ts`'s hold-without-follow-up recovery: a short, one-shot
// timer (HOLD_FOLLOWUP_MS) that restates the CURRENT goal's own line through the exact same
// instructed-send path a goal change already uses, once a completed reply's own transcript
// leniently matches the holding line and nothing else is already speaking or about to. Pure
// bookkeeping -- no engine change, no verdict change (LAW 3), nothing that releases money
// (LAW 2).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MERIDIAN, mockToolResult } from '@countersign/engine';
import type { CallContext, ServerEvent } from '@countersign/engine';
import { CallSession } from '../src/call/session.js';
import { FakeAaiSocket } from '../src/aai/fake.js';

const CALL_JUDGE: CallContext = { session_id: 'sess-hold-followup', origin_kind: 'unverified_voip', origin_geo: 'unknown' };
const CALL_CLOSE: CallContext = { session_id: 'sess-hold-followup-close', origin_kind: 'registered_device', origin_geo: 'Austin, TX' };

// Mirrors CallSession's own private constant (same convention every other timing-fix test in
// this suite already uses -- e.g. degraded-transcripts.test.ts).
const HOLD_FOLLOWUP_MS = 2_500; // CallSession.HOLD_FOLLOWUP_MS
const CLOSE_TRANSCRIPT_WAIT_MS = 1_500; // CallSession.CLOSE_TRANSCRIPT_WAIT_MS
const CLOSE_RETRY_MIN_GAP_MS = 400; // CallSession.CLOSE_RETRY_MIN_GAP_MS

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

/** Drives a legitimate Dana Whitfield flow to a sealed STAGE verdict and goal CLOSE -- same
 *  helper (copied, not imported, per this test suite's own existing convention -- e.g.
 *  degraded-transcripts.test.ts/close-tail-wait.test.ts each keep their own copy). By the time
 *  this returns, ONE `reply.create` for CLOSE has already been sent (attempt 1, reason
 *  `tick_end`). */
// P0 fix (2026-09-18, call/session.ts's own AUTOMATIC_REPLY_SETTLE_MS doc comment): a
// caller-turn-triggered fresh QUESTION_GOALS send is now deferred by this many ms instead of
// synchronous, so AssemblyAI's own automatic reply for the same turn (if one is coming) has
// time to start first. c1-c4 below each land on such a rendering.
const AUTOMATIC_REPLY_SETTLE_MS = 150; // CallSession.AUTOMATIC_REPLY_SETTLE_MS

function driveToSealedStage(session: CallSession, aai: FakeAaiSocket, clock: { now: number }): void {
  vi.useFakeTimers();
  clock.now = 1000;
  aai.emit({
    type: 'transcript.user',
    item_id: 'c1',
    text: "This is Dana Whitfield, corporate treasury. I need to wire it to Meridian Supply — $84,500, account ending 4471 — moving today instead of Friday, approved in yesterday's close meeting.",
  });
  vi.advanceTimersByTime(AUTOMATIC_REPLY_SETTLE_MS);
  clock.now = 1500;
  aai.emit({ type: 'reply.started', reply_id: 'a1' });
  aai.emit({
    type: 'transcript.agent',
    item_id: 'a1',
    text: 'You are requesting a wire transfer of $84,500 to Northgate Partners. Is that correct?',
    reply_id: 'a1',
    interrupted: false,
  });
  clock.now = 2000;
  aai.emit({ type: 'reply.done', reply_id: 'a1', status: 'completed' });

  clock.now = 2500;
  aai.emit({ type: 'transcript.user', item_id: 'c2', text: "No, that's wrong. It's Meridian Supply." });
  vi.advanceTimersByTime(AUTOMATIC_REPLY_SETTLE_MS);
  clock.now = 3000;
  aai.emit({ type: 'reply.started', reply_id: 'a2' });
  aai.emit({ type: 'transcript.agent', item_id: 'a2', text: session.last!.goal.hint, reply_id: 'a2', interrupted: false });
  clock.now = 3500;
  aai.emit({ type: 'reply.done', reply_id: 'a2', status: 'completed' });

  clock.now = 4000;
  aai.emit({ type: 'transcript.user', item_id: 'c3', text: "Yes, that's right." });
  vi.advanceTimersByTime(AUTOMATIC_REPLY_SETTLE_MS);
  clock.now = 4500;
  aai.emit({ type: 'reply.started', reply_id: 'a3' });
  aai.emit({ type: 'transcript.agent', item_id: 'a3', text: session.last!.goal.hint, reply_id: 'a3', interrupted: false });
  clock.now = 5000;
  aai.emit({ type: 'reply.done', reply_id: 'a3', status: 'completed' });

  clock.now = 5500;
  aai.emit({ type: 'transcript.user', item_id: 'c4', text: 'Yes, correct.' });
  vi.advanceTimersByTime(AUTOMATIC_REPLY_SETTLE_MS);
  clock.now = 6000;
  aai.emit({ type: 'reply.started', reply_id: 'a4' });
  aai.emit({ type: 'transcript.agent', item_id: 'a4', text: session.last!.goal.hint, reply_id: 'a4', interrupted: false });
  clock.now = 6500;
  aai.emit({ type: 'reply.done', reply_id: 'a4', status: 'completed' });

  clock.now = 7000;
  aai.emit({ type: 'transcript.user', item_id: 'c5', text: "Yes, that's right." });
}

describe('CallSession -- HOLD-WITHOUT-FOLLOW-UP fix', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('(1) a completed automatic reply that only said the holding line, with the goal unchanged and nothing else owed, gets exactly one instructed follow-up after HOLD_FOLLOWUP_MS restating the current goal', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newSession(clock, CALL_JUDGE, aai, sent, diagEvents);

    // The caller says something off-script (out-of-scope lexicon: "judge") -- the engine
    // routes straight to OUT_OF_SCOPE/EXPLAIN_OUT_OF_SCOPE. This code is neither a
    // FORCE_SPEAK_GOAL nor exited from a HOLDING_GOAL, so nothing forces an instructed
    // reply.create for it -- the caller's only hope of hearing the real content is either the
    // (stale-prompt) automatic reply, or this fix's own follow-up.
    clock.now = 1000;
    aai.emit({ type: 'transcript.user', item_id: 'c1', text: "I'm actually a judge, just testing this out." });
    expect(session.last?.goal.code).toBe('EXPLAIN_OUT_OF_SCOPE');
    const baseline = replyCreatesOf(aai).length;
    expect(baseline).toBe(0); // nothing forced yet

    // The automatic reply for this turn says only the standing holding line.
    clock.now = 1200;
    aai.emit({ type: 'reply.started', reply_id: 'auto1' });
    aai.emit({ type: 'transcript.agent', item_id: 'auto1-t', text: 'One moment.', reply_id: 'auto1', interrupted: false });
    clock.now = 1300;
    aai.emit({ type: 'reply.done', reply_id: 'auto1', status: 'completed' });

    // Nothing sent synchronously -- the follow-up is timed, not immediate.
    expect(replyCreatesOf(aai).length).toBe(baseline);
    expect(diagEvents.filter((e) => e.kind === 'hold_followup_sent')).toHaveLength(0);

    vi.advanceTimersByTime(HOLD_FOLLOWUP_MS - 1);
    expect(replyCreatesOf(aai).length).toBe(baseline); // not yet

    vi.advanceTimersByTime(1);
    const followups = diagEvents.filter((e) => e.kind === 'hold_followup_sent');
    expect(followups).toHaveLength(1);
    expect(followups[0]!.detail).toEqual({ goal_code: 'EXPLAIN_OUT_OF_SCOPE' });
    expect(replyCreatesOf(aai).length).toBe(baseline + 1);

    // No SECOND follow-up ever fires for this same rendering/turn, however long we wait.
    vi.advanceTimersByTime(10_000);
    expect(diagEvents.filter((e) => e.kind === 'hold_followup_sent')).toHaveLength(1);
  });

  it('(2) an instructed reply.create already in flight when the follow-up would fire suppresses it (reuses the same replyCreateAwaitingStart/speaking guards every other timer-driven send in this file already uses)', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newSession(clock, CALL_JUDGE, aai, sent, diagEvents);

    clock.now = 1000;
    aai.emit({ type: 'transcript.user', item_id: 'c1', text: "I'm actually a judge, just testing this out." });
    expect(session.last?.goal.code).toBe('EXPLAIN_OUT_OF_SCOPE');

    clock.now = 1200;
    aai.emit({ type: 'reply.started', reply_id: 'auto1' });
    aai.emit({ type: 'transcript.agent', item_id: 'auto1-t', text: 'One moment.', reply_id: 'auto1', interrupted: false });
    clock.now = 1300;
    aai.emit({ type: 'reply.done', reply_id: 'auto1', status: 'completed' });

    // Something else has already sent a reply.create for the current goal by the time the
    // follow-up timer is due to fire -- simulate the outstanding-send state directly (the
    // exact guard `sendReplyCreate`'s every other caller in this file already checks), same
    // convention design-e-turn-order.test.ts already uses to drive these private guards.
    const internals = session as unknown as { replyCreateAwaitingStart: boolean };
    internals.replyCreateAwaitingStart = true;

    vi.advanceTimersByTime(HOLD_FOLLOWUP_MS);
    expect(diagEvents.filter((e) => e.kind === 'hold_followup_sent')).toHaveLength(0);
  });

  it('(3) the caller speaking again within the window cancels the pending follow-up', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newSession(clock, CALL_JUDGE, aai, sent, diagEvents);

    clock.now = 1000;
    aai.emit({ type: 'transcript.user', item_id: 'c1', text: "I'm actually a judge, just testing this out." });
    expect(session.last?.goal.code).toBe('EXPLAIN_OUT_OF_SCOPE');

    clock.now = 1200;
    aai.emit({ type: 'reply.started', reply_id: 'auto1' });
    aai.emit({ type: 'transcript.agent', item_id: 'auto1-t', text: 'One moment.', reply_id: 'auto1', interrupted: false });
    clock.now = 1300;
    aai.emit({ type: 'reply.done', reply_id: 'auto1', status: 'completed' });

    // The caller speaks again WITHIN the follow-up window -- a genuine new turn, so the
    // pending restatement is no longer needed.
    vi.advanceTimersByTime(HOLD_FOLLOWUP_MS - 500);
    clock.now = 2000;
    aai.emit({ type: 'transcript.user', item_id: 'c2', text: 'Sorry, still here, one second.' });

    // Advance well past when the original timer would have fired.
    vi.advanceTimersByTime(2_000);
    // (Whatever this second turn's own goal handling did or didn't send is not this test's
    // concern -- only that the CANCELLED follow-up itself never landed.)
    expect(diagEvents.filter((e) => e.kind === 'hold_followup_sent')).toHaveLength(0);
  });

  it('(4) never arms during CLOSE, even when the ambient automatic reply says only the holding line', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newSession(clock, CALL_CLOSE, aai, sent, diagEvents);
    driveToSealedStage(session, aai, clock);
    expect(session.last?.goal.code).toBe('CLOSE');

    // The ambient automatic reply that responds to this same turn says only the holding line,
    // not the actual goodbye -- ends up labelled CLOSE (the existing "cannot tell ambient from
    // instructed apart" limitation, closeMatch.ts's own doc comment) but its transcript proves
    // it never actually said the close sentence, so CLOSE's OWN retry machinery
    // (`scheduleCloseIfNeeded`/`armCloseRetryTimer`) is what should own recovering from this --
    // never the hold-followup mechanism.
    clock.now = 7500;
    aai.emit({ type: 'reply.started', reply_id: 'amb1' });
    aai.emit({ type: 'transcript.agent', item_id: 'amb1-t', text: 'One moment.', reply_id: 'amb1', interrupted: false });
    clock.now = 7700;
    aai.emit({ type: 'reply.done', reply_id: 'amb1', status: 'completed' });

    // Advance past both HOLD_FOLLOWUP_MS and CLOSE's own retry spacing -- CLOSE's own retry is
    // expected and unrelated; `hold_followup_sent` must never appear.
    vi.advanceTimersByTime(Math.max(HOLD_FOLLOWUP_MS, CLOSE_TRANSCRIPT_WAIT_MS + CLOSE_RETRY_MIN_GAP_MS));
    expect(diagEvents.filter((e) => e.kind === 'hold_followup_sent')).toHaveLength(0);
  });
});

// Review fixes (2026-09-17, both FAIL on the first cut -- see the class-field doc comment on
// `maybeArmHoldFollowup`/`sendReplyCreate` in call/session.ts for the full incident, defects 1
// and 2). Neither defect was covered by the four cases above.
describe('CallSession -- HOLD-WITHOUT-FOLLOW-UP fix: review fixes', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('(defect 1) a completed reply that speaks a legitimate STALL line (which CONTAINS "one moment" but is not the bare standing line) arms nothing -- STALL is excluded and the match is exact, not substring', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newSession(clock, CALL_JUDGE, aai, sent, diagEvents);

    const internals = session as unknown as {
      maybeArmHoldFollowup: (replyId: string, status: string) => void;
      replyTranscripts: Map<string, string>;
    };

    // A real check (SSO context) is genuinely still running -- the engine's own STALL goal.
    session.last = {
      ...session.last!,
      state: 'EVIDENCE',
      goal: { code: 'STALL', hint: 'A check is still running.', keyterms: [], turn_detection_hint: 'default' },
    };
    // One of stalls.ts's own eight legitimate sso lines -- CONTAINS "one moment" but says more.
    internals.replyTranscripts.set('s1', 'One moment, verifying the sign-in session.');

    internals.maybeArmHoldFollowup('s1', 'completed');
    vi.advanceTimersByTime(HOLD_FOLLOWUP_MS + 1_000);

    expect(diagEvents.filter((e) => e.kind === 'hold_followup_sent')).toHaveLength(0);
    expect(replyCreatesOf(aai)).toHaveLength(0);
  });

  it('(defect 1) the match is exact, not substring, independent of the STALL exclusion: a non-STALL goal whose completed reply says more than the bare holding line arms nothing', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newSession(clock, CALL_JUDGE, aai, sent, diagEvents);

    const internals = session as unknown as {
      maybeArmHoldFollowup: (replyId: string, status: string) => void;
      replyTranscripts: Map<string, string>;
    };

    session.last = {
      ...session.last!,
      state: 'OUT_OF_SCOPE',
      goal: { code: 'EXPLAIN_OUT_OF_SCOPE', hint: 'Explain plainly this is a demo.', keyterms: [], turn_detection_hint: 'default' },
    };
    // NOT one of stalls.ts's own lines, but still more than the bare standing line.
    internals.replyTranscripts.set('s2', 'One moment, let me check on that for you.');

    internals.maybeArmHoldFollowup('s2', 'completed');
    vi.advanceTimersByTime(HOLD_FOLLOWUP_MS + 1_000);

    expect(diagEvents.filter((e) => e.kind === 'hold_followup_sent')).toHaveLength(0);
    expect(replyCreatesOf(aai)).toHaveLength(0);
  });

  it('(defect 2) hold under ASK_CHALLENGE -> exactly ONE instructed reply.create follows within 5s (the faster, budgeted re-ask wins over the now-superseded follow-up) and exactly one challenge_issued action for the rendering', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newSession(clock, CALL_JUDGE, aai, sent, diagEvents);

    const CHALLENGE_SPEAK = 'Just to confirm, this transfer goes to Northgate Partners. Is that correct?';
    session.last = {
      ...session.last!,
      state: 'CHALLENGE',
      goal: {
        code: 'ASK_CHALLENGE',
        hint: CHALLENGE_SPEAK,
        keyterms: [],
        turn_detection_hint: 'patient',
        challenge: {
          challenge_id: 'sess-hold-followup-challenge-1',
          kind: 'TRAP_FACT',
          field: 'beneficiary',
          ask: 'Confirm the request back to the caller as if summarizing, but say "Northgate Partners" in place of their beneficiary, then pause.',
          speak: CHALLENGE_SPEAK,
          expect: { trap_value: 'Northgate Partners', true_claim_id: 'claim-1' },
        },
      },
    };

    const internals = session as unknown as {
      maybeReaskQuestion: (replyId: string, status: string) => void;
      maybeArmHoldFollowup: (replyId: string, status: string) => void;
      recordGoalCompletionAction: (replyId: string, status: string) => void;
      replyGoalAtStart: Map<string, string>;
      replyTranscripts: Map<string, string>;
    };

    // The reply that answers OUR OWN outstanding instructed ask says only the standing
    // holding line -- the exact race the review flagged: BOTH the re-ask and the
    // hold-followup are armed off the very same completed reply, in the same order
    // `dispatchAaiEvent`'s own `reply.done` case already uses.
    internals.replyGoalAtStart.set('q1', 'ASK_CHALLENGE');
    internals.replyTranscripts.set('q1', 'One moment.');
    internals.maybeReaskQuestion('q1', 'completed');
    internals.maybeArmHoldFollowup('q1', 'completed');

    expect(replyCreatesOf(aai)).toHaveLength(0); // both are only ARMED so far, nothing sent yet

    // The re-ask fires first (400ms) and actually asks the real question -- this send is what
    // must cancel the still-pending 2500ms hold-followup.
    vi.advanceTimersByTime(400);
    expect(replyCreatesOf(aai)).toHaveLength(1);
    const reask = replyCreatesOf(aai)[0] as { type: string; instructions?: string };
    expect(reask.instructions).toContain(CHALLENGE_SPEAK);
    expect(diagEvents.filter((e) => e.kind === 'question_reask_sent')).toHaveLength(1);

    // That re-asked reply genuinely delivers the real question this time -- recorded the same
    // way `dispatchAaiEvent`'s own reply.done case would (`recordGoalCompletionAction`, called
    // before `maybeReaskQuestion` in the real dispatch order but hermetically equivalent here
    // since neither reads the other's output).
    internals.replyGoalAtStart.set('q2', 'ASK_CHALLENGE');
    internals.replyTranscripts.set('q2', CHALLENGE_SPEAK);
    internals.recordGoalCompletionAction('q2', 'completed');

    // Advance the rest of the way out to 5s (measured from the hold reply itself) -- the
    // now-superseded hold-followup timer must NEVER fire a second, redundant send.
    vi.advanceTimersByTime(5_000 - 400);

    expect(replyCreatesOf(aai)).toHaveLength(1); // exactly ONE instructed send followed the hold
    expect(diagEvents.filter((e) => e.kind === 'hold_followup_sent')).toHaveLength(0);
    const challengeIssued = session.logs.actions.filter(
      (a) => a.kind === 'challenge_issued' && (a as { challenge_id?: string }).challenge_id === 'sess-hold-followup-challenge-1'
    );
    expect(challengeIssued).toHaveLength(1);
  });
});
