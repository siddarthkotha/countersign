// packages/server/test/close-retry-lost-bound.test.ts
// Fix (2026-09-16, PROVEN live failure -- deploy 41,
// scripts/rehearse/reports/2026-09-16T17-50-00-miller-patient.md +
// its .diagnostics.json): the CLOSE reply.create sent the moment the engine sealed ESCALATE
// (t=96157ms) never got a `reply.started` -- `armReplyCreateLostTimer` logged
// `reply_create_lost`, `armCloseRetryTimer` re-sent 400ms later, and EVERY one of the next 24
// attempts (spaced ~1.9s apart) was lost the exact same way, burning the entire CLOSE_TOTAL_MS
// (45s) budget before `armClose`'s own hard cap finally ended the call at t=141159ms
// (`idle_timeout`, carried over from the idle-deferred goodbye). The caller never heard the
// verdict; LAW 2 was unaffected (containment already ran at 96156-96157ms, long before any of
// this), but the wire stayed open for 45 more seconds with zero chance of a spoken goodbye once
// it was clear AssemblyAI had stopped acknowledging `reply.create` at all.
//
// Fix (session.ts): `closeLostStreak` counts CONSECUTIVE `reply_create_lost` events for a CLOSE
// goal (reset the instant any CLOSE reply actually gets a `reply.started`). At
// `MAX_CLOSE_LOST_STREAK` (3) consecutive losses, `abandonClose` ends the call immediately
// (`close_abandoned`, or the idle-deferred reason if one was pending) instead of continuing to
// retry for the rest of the 45s budget.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MERIDIAN, mockToolResult } from '@countersign/engine';
import type { CallContext, ServerEvent } from '@countersign/engine';
import { CallSession } from '../src/call/session.js';
import { FakeAaiSocket } from '../src/aai/fake.js';

function newSession(
  clockRef: { now: number },
  call: CallContext,
  aai: FakeAaiSocket,
  sent: ServerEvent[],
  diagEvents: { kind: string; detail: unknown }[]
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

/** Same legitimate Dana Whitfield flow every other CLOSE-mechanics test file in this package
 *  already duplicates (see close-transcript-wait.test.ts's own doc comment on why this is
 *  copied rather than shared) -- drives the session to SEALED/CLOSE (verdict STAGE). By the end,
 *  ONE `reply.create` for CLOSE has already been sent (attempt 1, reason `tick_end`). */
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
  // MERGED-FREEZE-GOODBYE fix (2026-09-19, call/session.ts's own `owedForceSpeakGoalKey` doc
  // comment): c5's own tick reaches SEALED/CLOSE directly off this caller turn
  // (`callerTurnTick`), so the CLOSE `reply.create` is now deferred the same
  // `AUTOMATIC_REPLY_SETTLE_MS` way a fresh question already was -- nothing else starts
  // speaking in this drive, so the fallback send fires once the window elapses.
  vi.advanceTimersByTime(AUTOMATIC_REPLY_SETTLE_MS);
}

const CALL: CallContext = { session_id: 'sess-close-lost', origin_kind: 'registered_device', origin_geo: 'Austin, TX' };
const REPLY_CREATE_LOST_MS = 1500; // CallSession.REPLY_CREATE_LOST_MS
const CLOSE_RETRY_MIN_GAP_MS = 400; // CallSession.CLOSE_RETRY_MIN_GAP_MS
const CLOSE_TOTAL_MS = 45_000; // CallSession.CLOSE_TOTAL_MS

describe('CallSession -- CLOSE retry gives up after a bounded streak of lost reply.create sends (fix, 2026-09-16)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ends the call (close_abandoned) after 3 consecutive lost CLOSE sends, well before the 45s hard cap', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newSession(clock, CALL, aai, sent, diagEvents);
    session.start();
    driveToSealedStage(session, aai, clock);

    const replyCreates = () => aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create');
    const baseline = replyCreates().length; // the original CLOSE send (attempt 1, tick_end)
    expect(baseline).toBeGreaterThan(0);

    // Never emit reply.started for anything from here on -- every CLOSE reply.create is "lost"
    // (AssemblyAI never acknowledges it), exactly the live incident's own shape.
    for (let i = 0; i < 2; i++) {
      vi.advanceTimersByTime(REPLY_CREATE_LOST_MS + CLOSE_RETRY_MIN_GAP_MS);
    }
    // Two full lost+retry cycles: attempt 1 (baseline) lost -> retry sends attempt 2; attempt 2
    // lost -> retry sends attempt 3. Streak is now 2 -- still under MAX_CLOSE_LOST_STREAK (3),
    // so the call has not ended yet.
    expect(replyCreates().length).toBe(baseline + 2);
    expect(sent.some((e) => e.type === 'ended')).toBe(false);

    // The third consecutive loss crosses the streak bound: no fourth retry is sent, and the
    // call ends immediately -- at roughly 3 * (1500 + 400) = 5700ms, nowhere near the 45s
    // CLOSE_TOTAL_MS budget the unbounded loop used to burn in full.
    vi.advanceTimersByTime(REPLY_CREATE_LOST_MS);
    expect(sent.at(-1)).toEqual({ type: 'ended', reason: 'close_abandoned' });
    expect(replyCreates().length).toBe(baseline + 2); // no fourth send

    const abandoned = diagEvents.find((e) => e.kind === 'close_abandoned');
    expect(abandoned?.detail).toEqual({ reason: 'reply_create_lost_streak', streak: 3 });

    // Never got anywhere close to the 45s hard cap this bug used to burn in full.
    const totalElapsedMs = 3 * (REPLY_CREATE_LOST_MS + CLOSE_RETRY_MIN_GAP_MS);
    expect(totalElapsedMs).toBeLessThan(CLOSE_TOTAL_MS);
  });

  it('a CLOSE reply that actually starts resets the streak -- a single lost send after that does not, by itself, end the call', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newSession(clock, CALL, aai, sent, diagEvents);
    session.start();
    driveToSealedStage(session, aai, clock);

    const replyCreates = () => aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create');
    const baseline = replyCreates().length;

    // One lost cycle (streak -> 1), then a real reply.started arrives for the retry -- this
    // should reset the streak back to 0, not merely fail to increment it further.
    vi.advanceTimersByTime(REPLY_CREATE_LOST_MS + CLOSE_RETRY_MIN_GAP_MS);
    expect(replyCreates().length).toBe(baseline + 1);
    clock.now += 10;
    aai.emit({ type: 'reply.started', reply_id: 'close-a1' });
    clock.now += 100;
    aai.emit({ type: 'reply.done', reply_id: 'close-a1', status: 'completed' });

    // Two MORE full lost cycles from here -- if the streak had NOT reset, this alone would
    // cross MAX_CLOSE_LOST_STREAK (3) and end the call. It should not.
    vi.advanceTimersByTime(REPLY_CREATE_LOST_MS + CLOSE_RETRY_MIN_GAP_MS);
    vi.advanceTimersByTime(REPLY_CREATE_LOST_MS + CLOSE_RETRY_MIN_GAP_MS);
    expect(sent.some((e) => e.type === 'ended')).toBe(false);
    expect(diagEvents.some((e) => e.kind === 'close_abandoned')).toBe(false);
  });
});
