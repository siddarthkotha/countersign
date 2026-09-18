// packages/server/test/degraded-transcripts.test.ts
// DEGRADED-TRANSCRIPTS mode (2026-09-16, PROVEN four times live -- scripts/rehearse/reports/
// 2026-09-16T17-50-00-miller-patient, ...19-31-28-dana-patient, ...20-51-12-barge-in-interrupt,
// ...21-02-41-single-wrong-answer, all in the main checkout, gitignored): after one automatic
// reply with real audio but no agent transcript, AssemblyAI can stop delivering agent
// transcripts for the REST OF THE CALL, while replies keep starting with audio and caller
// transcripts keep arriving fine. Consequences PROVEN live: the server re-asked blind
// (question_not_asked, attempt 0) and spoke over the caller; after a verdict, the CLOSE reply
// started with audio but no transcript, so `transcriptMatchesCloseSentence` never confirmed it,
// CLOSE was re-sent (duplicate goodbyes in audio), and the idle timer or the lost-streak
// breaker ended the call 30-45s later.
//
// This suite proves `call/session.ts`'s DEGRADED-TRANSCRIPTS mode: pure bookkeeping, no engine
// change, no verdict change (LAW 3), nothing that releases money (LAW 2) -- see the
// `degradedTranscriptsMode` class-field doc comment in session.ts for the full mechanism.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MERIDIAN, mockToolResult } from '@countersign/engine';
import type { CallContext, ServerEvent } from '@countersign/engine';
import { CallSession } from '../src/call/session.js';
import { FakeAaiSocket } from '../src/aai/fake.js';
import scenarioB from '../../engine/corpus/scenario-b-miller-fraud.json' with { type: 'json' };

const CALL_B = scenarioB.call as CallContext;
const CALL_CLOSE: CallContext = { session_id: 'sess-degraded-close', origin_kind: 'registered_device', origin_geo: 'Austin, TX' };

// Mirrors CallSession's own private constants (same convention every other timing-fix test in
// this suite already uses -- e.g. question-reask-late-transcript.test.ts).
const DEGRADED_STRIKE_WAIT_MS = 1_500; // CallSession.DEGRADED_STRIKE_WAIT_MS
const DEGRADED_INFLIGHT_STRIKE_MS = 12_000; // CallSession.DEGRADED_INFLIGHT_STRIKE_MS
const DEGRADED_MODE_STRIKE_THRESHOLD = 2; // CallSession.DEGRADED_MODE_STRIKE_THRESHOLD
const CLOSE_TRANSCRIPT_WAIT_MS = 1_500; // CallSession.CLOSE_TRANSCRIPT_WAIT_MS
const CLOSE_RETRY_MIN_GAP_MS = 400; // CallSession.CLOSE_RETRY_MIN_GAP_MS
const CLOSE_GRACE_MS = 1_500; // CallSession.CLOSE_GRACE_MS

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

/** A completed reply with real audio and NO transcript at all -- the exact PROVEN shape of
 *  every live occurrence this mode exists to catch. */
function emitAudioNoTranscriptReply(aai: FakeAaiSocket, clock: { now: number }, replyId: string, startAt: number, doneAt: number): void {
  clock.now = startAt;
  aai.emit({ type: 'reply.started', reply_id: replyId });
  aai.emit({ type: 'reply.audio', data: Buffer.alloc(100).toString('base64') });
  clock.now = doneAt;
  aai.emit({ type: 'reply.done', reply_id: replyId, status: 'completed' });
}

/** Drives a legitimate Dana Whitfield flow to a sealed STAGE verdict and goal CLOSE -- same
 *  helper (copied, not imported, per this test suite's own existing convention -- e.g.
 *  close-tail-wait.test.ts/close-transcript-wait.test.ts each keep their own copy) used
 *  elsewhere to reach CLOSE without needing scenario B's lookup/tool.call machinery. By the
 *  time this returns, ONE `reply.create` for CLOSE has already been sent (attempt 1, reason
 *  `tick_end`). */
// P0 fix (2026-09-18, call/session.ts's own AUTOMATIC_REPLY_SETTLE_MS doc comment): a
// caller-turn-triggered fresh QUESTION_GOALS send is now deferred by this many ms instead of
// synchronous, so AssemblyAI's own automatic reply for the same turn (if one is coming) has
// time to start first.
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

describe('CallSession -- DEGRADED-TRANSCRIPTS mode: detection and recovery (i)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('two consecutive audio-only, no-transcript completed replies flip the mode on; a later real transcript flips it back off', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    newSession(clock, CALL_B, aai, sent, diagEvents);

    // Strike 1: audio, no transcript, completed.
    emitAudioNoTranscriptReply(aai, clock, 's1', 1000, 1300);
    vi.advanceTimersByTime(DEGRADED_STRIKE_WAIT_MS);
    expect(diagEvents.filter((e) => e.kind === 'transcripts_degraded')).toHaveLength(0);

    // Strike 2: same shape -- crosses DEGRADED_MODE_STRIKE_THRESHOLD.
    emitAudioNoTranscriptReply(aai, clock, 's2', 2000, 2300);
    vi.advanceTimersByTime(DEGRADED_STRIKE_WAIT_MS);
    const degraded = diagEvents.filter((e) => e.kind === 'transcripts_degraded');
    expect(degraded).toHaveLength(1);
    expect(degraded[0]!.detail).toMatchObject({ reply_ids: ['s1', 's2'] });

    // A reply with a REAL (non-empty) agent transcript -- the mode's recovery signal.
    clock.now = 3000;
    aai.emit({ type: 'reply.started', reply_id: 's3' });
    aai.emit({ type: 'transcript.agent', item_id: 's3-t', text: 'One moment please.', reply_id: 's3', interrupted: false });
    clock.now = 3300;
    aai.emit({ type: 'reply.done', reply_id: 's3', status: 'completed' });

    const recovered = diagEvents.filter((e) => e.kind === 'transcripts_recovered');
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.detail).toEqual({ reply_id: 's3' });

    // Exactly one degrade/recover pair -- no duplicate logging.
    expect(diagEvents.filter((e) => e.kind === 'transcripts_degraded')).toHaveLength(1);
  });

  it('a reply audible past DEGRADED_INFLIGHT_STRIKE_MS with no transcript counts a strike WHILE STILL RUNNING, and two such in-flight strikes turn the mode on before either reply ever reaches reply.done (occurrence 4, single-wrong-answer)', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    newSession(clock, CALL_B, aai, sent, diagEvents);

    // Reply 'long1' starts speaking and never stops (no reply.done in this test at all).
    // CRITICAL 1 fix (2026-09-17): the in-flight check now measures audio INACTIVITY off
    // `opts.now()` (mirroring `checkCloseReplyStuck`), so `clock.now` must advance in lockstep
    // with the fake timer for its computation to mean anything -- same convention
    // session.test.ts's own CLOSE audio-inactivity tests already use (e.g. "(NEW TEST 1)").
    clock.now = 1000;
    aai.emit({ type: 'reply.started', reply_id: 'long1' });
    aai.emit({ type: 'reply.audio', data: Buffer.alloc(100).toString('base64') });

    // Still well short of the in-flight threshold: no strike yet.
    clock.now += DEGRADED_INFLIGHT_STRIKE_MS - 1;
    vi.advanceTimersByTime(DEGRADED_INFLIGHT_STRIKE_MS - 1);
    expect(diagEvents.filter((e) => e.kind === 'degraded_strike')).toHaveLength(0);

    // Crosses it: 'long1' strikes IN FLIGHT, with no reply.done ever having fired for it -- no
    // further audio arrived after the single frame above, so the inactivity re-arm exhausts
    // and strikes exactly as the old flat timer did for this single-frame shape.
    clock.now += 1;
    vi.advanceTimersByTime(1);
    const strikes = diagEvents.filter((e) => e.kind === 'degraded_strike');
    expect(strikes).toHaveLength(1);
    expect(strikes[0]!.detail).toMatchObject({ reply_id: 'long1', in_flight: true, strike_count: 1 });
    expect(diagEvents.filter((e) => e.kind === 'transcripts_degraded')).toHaveLength(0); // only 1 strike so far

    // A second reply, 'long2', supersedes 'long1' (a new reply.started) and ALSO runs long
    // enough to strike in flight -- 'long1' itself still never got a reply.done anywhere in
    // this test.
    clock.now = 1000 + DEGRADED_INFLIGHT_STRIKE_MS;
    aai.emit({ type: 'reply.started', reply_id: 'long2' });
    aai.emit({ type: 'reply.audio', data: Buffer.alloc(100).toString('base64') });
    clock.now += DEGRADED_INFLIGHT_STRIKE_MS;
    vi.advanceTimersByTime(DEGRADED_INFLIGHT_STRIKE_MS);

    const degraded = diagEvents.filter((e) => e.kind === 'transcripts_degraded');
    expect(degraded).toHaveLength(1);
    expect(degraded[0]!.detail).toMatchObject({ reply_ids: ['long1', 'long2'] });
  });

  it('a reply streaming audio frames every 500ms for 14s whose transcript arrives at 14.5s does NOT strike (mirrors session.test.ts\'s own CLOSE "14s does NOT trigger the stuck watchdog" audio-inactivity case, but for the in-flight strike check -- CRITICAL 1 fix)', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    newSession(clock, CALL_B, aai, sent, diagEvents);

    clock.now = 1000;
    aai.emit({ type: 'reply.started', reply_id: 'long-healthy' });

    // A frame every 500ms for 14 seconds -- comfortably past DEGRADED_INFLIGHT_STRIKE_MS (12s)
    // of TOTAL runtime, but never silent for anywhere near that long at any single point.
    // clock.now advances in lockstep with the fake timer so the audio-inactivity re-arm
    // actually gets exercised (unlike a bare `clock.now` jump, which never lets a pending
    // setTimeout fire at all).
    for (let i = 0; i < 28; i++) {
      aai.emit({ type: 'reply.audio', data: Buffer.alloc(100).toString('base64') });
      clock.now += 500;
      vi.advanceTimersByTime(500);
    }
    expect(diagEvents.filter((e) => e.kind === 'degraded_strike')).toHaveLength(0);

    // Transcript and reply.done arrive 500ms after the last frame (14.5s total) -- a real,
    // healthy long reply, never struck for running long.
    aai.emit({
      type: 'transcript.agent',
      item_id: 'long-healthy-t',
      text: 'Thank you for your patience -- still checking that.',
      reply_id: 'long-healthy',
      interrupted: false,
    });
    aai.emit({ type: 'reply.done', reply_id: 'long-healthy', status: 'completed' });
    vi.advanceTimersByTime(DEGRADED_STRIKE_WAIT_MS);

    expect(diagEvents.filter((e) => e.kind === 'degraded_strike')).toHaveLength(0);
    expect(diagEvents.filter((e) => e.kind === 'transcripts_degraded')).toHaveLength(0);
  });

  it('a reply whose audio frames STOP entirely (occurrence-4\'s literal dead-reply shape) still strikes once no audio has arrived for DEGRADED_INFLIGHT_STRIKE_MS, without waiting for the full 34s the live incident ran', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    newSession(clock, CALL_B, aai, sent, diagEvents);

    clock.now = 1000;
    aai.emit({ type: 'reply.started', reply_id: 'dead1' });
    // A few frames arrive, THEN STOP completely -- no reply.done, no transcript, ever.
    for (let i = 0; i < 4; i++) {
      aai.emit({ type: 'reply.audio', data: Buffer.alloc(100).toString('base64') });
      clock.now += 500;
      vi.advanceTimersByTime(500);
    }
    // No strike yet -- audio only stopped 2000ms ago, well under the 12s inactivity window.
    expect(diagEvents.filter((e) => e.kind === 'degraded_strike')).toHaveLength(0);

    // Audio never resumes. The strike fires DEGRADED_INFLIGHT_STRIKE_MS after the LAST frame
    // (not 34s, and not a flat 12s from the FIRST frame either).
    clock.now += DEGRADED_INFLIGHT_STRIKE_MS;
    vi.advanceTimersByTime(DEGRADED_INFLIGHT_STRIKE_MS);
    const strikes = diagEvents.filter((e) => e.kind === 'degraded_strike' && (e.detail as { reply_id: string }).reply_id === 'dead1');
    expect(strikes).toHaveLength(1);
    expect(strikes[0]!.detail).toMatchObject({ reply_id: 'dead1', in_flight: true });
  });

  it('an in-flight strike and a later reply.done-triggered strike for the SAME reply are never double-counted', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    newSession(clock, CALL_B, aai, sent, diagEvents);

    // 'long1' strikes in flight at t=12000ms (no transcript, no reply.done yet)... clock.now
    // advances in lockstep with the fake timer -- see the sibling in-flight test above for why
    // this now matters (CRITICAL 1 fix: the check measures audio inactivity off `opts.now()`).
    clock.now = 1000;
    aai.emit({ type: 'reply.started', reply_id: 'long1' });
    aai.emit({ type: 'reply.audio', data: Buffer.alloc(100).toString('base64') });
    clock.now += DEGRADED_INFLIGHT_STRIKE_MS;
    vi.advanceTimersByTime(DEGRADED_INFLIGHT_STRIKE_MS);
    expect(diagEvents.filter((e) => e.kind === 'degraded_strike')).toHaveLength(1);

    // ...and THEN finally reaches its own reply.done, still with no transcript. The
    // reply.done-triggered check (armed here) must NOT count a second strike for 'long1'.
    clock.now = 1000 + DEGRADED_INFLIGHT_STRIKE_MS + 5000;
    aai.emit({ type: 'reply.done', reply_id: 'long1', status: 'completed' });
    vi.advanceTimersByTime(DEGRADED_STRIKE_WAIT_MS);

    const strikesForLong1 = diagEvents.filter((e) => e.kind === 'degraded_strike' && (e.detail as { reply_id: string }).reply_id === 'long1');
    expect(strikesForLong1).toHaveLength(1); // exactly one strike for this reply, however it was caught
    expect(diagEvents.filter((e) => e.kind === 'transcripts_degraded')).toHaveLength(0); // only 1 DISTINCT reply has struck
  });

  it('records follows_instructed_reply_done_ms on the degraded_strike diag when the struck reply starts immediately after one of OUR instructed replies own reply.done (occurrence-4 follow-on)', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newSession(clock, CALL_B, aai, sent, diagEvents);

    // c1 triggers a proactive, INSTRUCTED reply.create for the fresh ASK_CHALLENGE rendering
    // (Design E) -- 'q1' below is the reply that answers it.
    clock.now = 1000;
    aai.emit({ type: 'transcript.user', item_id: 'c1', text: scenarioB.conversation[0]!.text });
    vi.advanceTimersByTime(AUTOMATIC_REPLY_SETTLE_MS);
    const sentence = session.last!.goal.challenge!.speak!;

    // 'q1' is OUR instructed reply, and it actually asks the question -- a clean, healthy
    // completion (no strike): this is the "instructed reply's own reply.done" the next reply
    // is measured against.
    clock.now = 1500;
    aai.emit({ type: 'reply.started', reply_id: 'q1' });
    aai.emit({ type: 'transcript.agent', item_id: 'q1-t', text: sentence, reply_id: 'q1', interrupted: false });
    clock.now = 1800;
    aai.emit({ type: 'reply.done', reply_id: 'q1', status: 'completed' });

    // An automatic reply starts 10ms later, with audio and no transcript -- the exact PROVEN
    // occurrence-4 shape.
    clock.now = 1810;
    aai.emit({ type: 'reply.started', reply_id: 'auto1' });
    aai.emit({ type: 'reply.audio', data: Buffer.alloc(100).toString('base64') });
    clock.now = 2110;
    aai.emit({ type: 'reply.done', reply_id: 'auto1', status: 'completed' });

    vi.advanceTimersByTime(DEGRADED_STRIKE_WAIT_MS);
    const strike = diagEvents.find((e) => e.kind === 'degraded_strike' && (e.detail as { reply_id: string }).reply_id === 'auto1');
    expect(strike).toBeDefined();
    expect(strike!.detail).toMatchObject({ reply_id: 'auto1', in_flight: false, follows_instructed_reply_done_ms: 10 });
  });
});

describe('CallSession -- DEGRADED-TRANSCRIPTS mode: question re-ask suppressed, goal-completion assumed (ii)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('while degraded, an instructed question reply with audio and no transcript is recorded as asked (assumed_asked) and no re-ask is ever sent for it', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newSession(clock, CALL_B, aai, sent, diagEvents);

    // Degrade the mode FIRST, on two ambient replies that have nothing to do with any
    // question yet (before the caller has said anything at all).
    emitAudioNoTranscriptReply(aai, clock, 's1', 1000, 1300);
    vi.advanceTimersByTime(DEGRADED_STRIKE_WAIT_MS);
    emitAudioNoTranscriptReply(aai, clock, 's2', 2000, 2300);
    vi.advanceTimersByTime(DEGRADED_STRIKE_WAIT_MS);
    expect(diagEvents.filter((e) => e.kind === 'transcripts_degraded')).toHaveLength(1);

    const replyCreates = () => aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create');
    const baseline = replyCreates().length;

    // NOW the caller speaks -- the engine renders a fresh ASK_CHALLENGE, and the proactive
    // Design-E send is NOT gated by degraded mode (only the RE-ASK path is), so it still goes
    // out, instructed, exactly as it would if the mode were off.
    clock.now = 3000;
    aai.emit({ type: 'transcript.user', item_id: 'c1', text: scenarioB.conversation[0]!.text });
    vi.advanceTimersByTime(AUTOMATIC_REPLY_SETTLE_MS);
    expect(session.last?.state).toBe('CHALLENGE');
    expect(session.last?.goal.code).toBe('ASK_CHALLENGE');
    const challengeId = session.last?.goal.challenge?.challenge_id;
    expect(replyCreates().length).toBe(baseline + 1); // the proactive instructed send

    // The reply that answers it has real audio but AssemblyAI never transcribes it -- the
    // exact live shape (question_not_asked, attempt 0) this mode exists to stop re-asking.
    clock.now = 3500;
    aai.emit({ type: 'reply.started', reply_id: 'q1' });
    aai.emit({ type: 'reply.audio', data: Buffer.alloc(100).toString('base64') });
    clock.now = 3800;
    aai.emit({ type: 'reply.done', reply_id: 'q1', status: 'completed' });

    // Goal-completion recording: treated as asked (assumed, from audio), not left unlogged.
    const assumed = diagEvents.filter((e) => e.kind === 'assumed_asked');
    expect(assumed).toHaveLength(1);
    expect(assumed[0]!.detail).toEqual({ reply_id: 'q1', goal_code: 'ASK_CHALLENGE' });
    expect(session.logs.actions.some((a) => a.kind === 'challenge_issued' && (a as { challenge_id?: string }).challenge_id === challengeId)).toBe(
      true
    );

    // No re-ask is EVER sent for this rendering, however long we wait.
    vi.advanceTimersByTime(10_000);
    expect(diagEvents.filter((e) => e.kind === 'question_reask_sent')).toHaveLength(0);
    expect(replyCreates().length).toBe(baseline + 1); // unchanged -- the proactive send is still the only one
  });

  it('NOT degraded: an instructed question reply with audio and no transcript is still re-asked exactly as before this fix', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newSession(clock, CALL_B, aai, sent, diagEvents);

    const replyCreates = () => aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create');

    clock.now = 1000;
    aai.emit({ type: 'transcript.user', item_id: 'c1', text: scenarioB.conversation[0]!.text });
    vi.advanceTimersByTime(AUTOMATIC_REPLY_SETTLE_MS);
    const baseline = replyCreates().length;

    clock.now = 1500;
    aai.emit({ type: 'reply.started', reply_id: 'q1' });
    aai.emit({ type: 'reply.audio', data: Buffer.alloc(100).toString('base64') });
    clock.now = 1800;
    aai.emit({ type: 'reply.done', reply_id: 'q1', status: 'completed' });

    // Mode is NOT degraded (only one such reply has ever happened) -- the pre-existing
    // wait-then-reask path fires normally.
    expect(diagEvents.filter((e) => e.kind === 'transcripts_degraded')).toHaveLength(0);
    expect(session.logs.actions.some((a) => a.kind === 'challenge_issued')).toBe(false);

    vi.advanceTimersByTime(1_500 + 400); // QUESTION_TRANSCRIPT_WAIT_MS + the reask's own spacing
    expect(replyCreates().length).toBe(baseline + 1);
    expect(diagEvents.filter((e) => e.kind === 'question_reask_sent')).toHaveLength(1);
    expect(diagEvents.filter((e) => e.kind === 'assumed_asked')).toHaveLength(0);
  });
});

describe('CallSession -- DEGRADED-TRANSCRIPTS mode: CLOSE confirmed from audio (iii)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('while degraded, a CLOSE reply with audio and no transcript is confirmed from audio, is never re-sent again, and the call ends cleanly (not via the idle timer)', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newSession(clock, { ...CALL_CLOSE, session_id: 'sess-degraded-close-a' }, aai, sent, diagEvents);
    driveToSealedStage(session, aai, clock);
    expect(session.last?.goal.code).toBe('CLOSE');

    const closeReplyCreates = () => aai.sent.filter((m) => (m as { type?: string; instructions?: string }).type === 'reply.create');
    expect(closeReplyCreates().length).toBeGreaterThan(0); // attempt 1, tick_end -- already sent

    // Attempt 1's own reply: audio, no transcript at all. NOT yet degraded -- falls through to
    // the pre-existing spaced retry, exactly as today.
    clock.now = 7500;
    aai.emit({ type: 'reply.started', reply_id: 'close-a' });
    aai.emit({ type: 'reply.audio', data: Buffer.alloc(100).toString('base64') });
    clock.now = 7700;
    aai.emit({ type: 'reply.done', reply_id: 'close-a', status: 'completed' });
    vi.advanceTimersByTime(CLOSE_TRANSCRIPT_WAIT_MS);
    expect(diagEvents.filter((e) => e.kind === 'close_confirmed_by_audio')).toHaveLength(0);
    vi.advanceTimersByTime(CLOSE_RETRY_MIN_GAP_MS);
    const afterAttempt2 = closeReplyCreates().length;
    expect(afterAttempt2).toBeGreaterThanOrEqual(2); // the ordinary retry -- attempt 2

    // Attempt 2's own reply: same shape. This is the SECOND consecutive audio/no-transcript
    // completed reply -- crosses the degraded-mode threshold once its own strike resolves.
    clock.now = 9500;
    aai.emit({ type: 'reply.started', reply_id: 'close-b' });
    aai.emit({ type: 'reply.audio', data: Buffer.alloc(100).toString('base64') });
    clock.now = 9700;
    aai.emit({ type: 'reply.done', reply_id: 'close-b', status: 'completed' });
    vi.advanceTimersByTime(CLOSE_TRANSCRIPT_WAIT_MS);
    expect(diagEvents.filter((e) => e.kind === 'transcripts_degraded')).toHaveLength(1);
    // 'close-b' itself is unaffected by its OWN strike (snapshotted before it could resolve) --
    // still falls through to the ordinary retry, exactly like 'close-a' did.
    expect(diagEvents.filter((e) => e.kind === 'close_confirmed_by_audio')).toHaveLength(0);
    vi.advanceTimersByTime(CLOSE_RETRY_MIN_GAP_MS);
    const afterAttempt3 = closeReplyCreates().length;
    expect(afterAttempt3).toBeGreaterThan(afterAttempt2); // attempt 3 -- degraded mode was already on

    // Attempt 3's own reply, now WHILE already degraded: FULL-LENGTH audio (120,000 bytes ->
    // 2500ms of decoded PCM, comfortably past DEGRADED_CLOSE_CONFIRM_MIN_AUDIO_MS -- CRITICAL 2
    // fix, 2026-09-17: a real, completed goodbye, not a fragment), no transcript. reply.done's
    // own clock.now is 2500ms after reply.started (matching the audio's own real length,
    // unlike the other attempts' instant done) so `beginCloseGrace`'s audio-based tail wait
    // stays within the flat CLOSE_GRACE_MS this test's final wait already expects -- see
    // `beginCloseGrace`'s own doc comment for the formula. This is the one that gets confirmed
    // from audio instead of triggering yet another retry.
    clock.now = 11500;
    aai.emit({ type: 'reply.started', reply_id: 'close-c' });
    aai.emit({ type: 'reply.audio', data: Buffer.alloc(120_000).toString('base64') });
    clock.now = 14000;
    aai.emit({ type: 'reply.done', reply_id: 'close-c', status: 'completed' });

    expect(sent.some((e) => e.type === 'ended')).toBe(false);
    vi.advanceTimersByTime(CLOSE_TRANSCRIPT_WAIT_MS);
    const confirmed = diagEvents.filter((e) => e.kind === 'close_confirmed_by_audio');
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]!.detail).toEqual({ reply_id: 'close-c' });

    // No 4th CLOSE attempt is EVER sent -- the goodbye is treated as already spoken.
    vi.advanceTimersByTime(CLOSE_RETRY_MIN_GAP_MS);
    expect(closeReplyCreates().length).toBe(afterAttempt3);

    // The call ends cleanly, promptly (the goodbye's own short tail wait, not the 30-45s the
    // live incidents burned waiting on the idle timer or the lost-streak breaker), with the
    // NORMAL end reason.
    vi.advanceTimersByTime(CLOSE_GRACE_MS);
    expect(sent.at(-1)).toEqual({ type: 'ended', reason: 'agent_closed' });
    expect(closeReplyCreates().length).toBe(afterAttempt3); // still no 4th attempt, even after ending
  });

  it('NOT degraded: a CLOSE reply with audio and no transcript is still retried (re-sent) exactly as before this fix', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newSession(clock, { ...CALL_CLOSE, session_id: 'sess-degraded-close-control' }, aai, sent, diagEvents);
    driveToSealedStage(session, aai, clock);

    const closeReplyCreates = () => aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create');
    const baseline = closeReplyCreates().length; // attempt 1, already sent

    clock.now = 7500;
    aai.emit({ type: 'reply.started', reply_id: 'close-a' });
    aai.emit({ type: 'reply.audio', data: Buffer.alloc(100).toString('base64') });
    clock.now = 7700;
    aai.emit({ type: 'reply.done', reply_id: 'close-a', status: 'completed' });

    expect(diagEvents.filter((e) => e.kind === 'transcripts_degraded')).toHaveLength(0);
    vi.advanceTimersByTime(CLOSE_TRANSCRIPT_WAIT_MS);
    expect(diagEvents.filter((e) => e.kind === 'close_confirmed_by_audio')).toHaveLength(0);
    vi.advanceTimersByTime(CLOSE_RETRY_MIN_GAP_MS);
    // The unchanged, pre-existing retry: exactly one more reply.create, requesting the close
    // sentence again.
    expect(closeReplyCreates().length).toBe(baseline + 1);
    const retryMsg = aai.sent.at(-1) as { type: string; instructions?: string };
    expect(retryMsg.type).toBe('reply.create');
    expect(retryMsg.instructions).toContain('Say exactly this');
  });

  it('while degraded, a CLOSE reply cut to a fragment by a caller barge-in (a little audio, INTERRUPTED status) is NOT confirmed from audio, and still falls through to the ordinary retry (CRITICAL 2 fix)', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newSession(clock, { ...CALL_CLOSE, session_id: 'sess-degraded-close-interrupted' }, aai, sent, diagEvents);
    driveToSealedStage(session, aai, clock);
    expect(session.last?.goal.code).toBe('CLOSE');

    const closeReplyCreates = () => aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create');

    // Attempts 1 and 2: the same audio-only, no-transcript COMPLETED shape as the sibling test
    // above -- crosses the degraded-mode threshold once attempt 2's own strike resolves.
    clock.now = 7500;
    aai.emit({ type: 'reply.started', reply_id: 'close-a' });
    aai.emit({ type: 'reply.audio', data: Buffer.alloc(120_000).toString('base64') });
    clock.now = 7700;
    aai.emit({ type: 'reply.done', reply_id: 'close-a', status: 'completed' });
    vi.advanceTimersByTime(CLOSE_TRANSCRIPT_WAIT_MS);
    vi.advanceTimersByTime(CLOSE_RETRY_MIN_GAP_MS);

    clock.now = 9500;
    aai.emit({ type: 'reply.started', reply_id: 'close-b' });
    aai.emit({ type: 'reply.audio', data: Buffer.alloc(120_000).toString('base64') });
    clock.now = 9700;
    aai.emit({ type: 'reply.done', reply_id: 'close-b', status: 'completed' });
    vi.advanceTimersByTime(CLOSE_TRANSCRIPT_WAIT_MS);
    expect(diagEvents.filter((e) => e.kind === 'transcripts_degraded')).toHaveLength(1);
    vi.advanceTimersByTime(CLOSE_RETRY_MIN_GAP_MS);
    const afterAttempt3Sent = closeReplyCreates().length;

    // Attempt 3, now degraded: the CALLER BARGES IN partway through the close line -- a small
    // fragment of audio ("This...") and an INTERRUPTED reply.done, never completed. Must NOT
    // be confirmed from audio, however much the mode is already degraded.
    clock.now = 11500;
    aai.emit({ type: 'reply.started', reply_id: 'close-c' });
    aai.emit({ type: 'reply.audio', data: Buffer.alloc(100).toString('base64') }); // ~2ms of audio
    clock.now = 11600;
    aai.emit({ type: 'reply.done', reply_id: 'close-c', status: 'interrupted' });

    vi.advanceTimersByTime(CLOSE_TRANSCRIPT_WAIT_MS);
    expect(diagEvents.filter((e) => e.kind === 'close_confirmed_by_audio')).toHaveLength(0);
    expect(sent.some((e) => e.type === 'ended')).toBe(false);

    // Falls through to the ordinary spaced retry, exactly as an undegraded interrupted CLOSE
    // would -- the caller is asked the goodbye again, never hung up on mid-sentence.
    vi.advanceTimersByTime(CLOSE_RETRY_MIN_GAP_MS);
    expect(closeReplyCreates().length).toBeGreaterThan(afterAttempt3Sent);
  });
});

describe('CallSession -- DEGRADED-TRANSCRIPTS mode: READBACK completion is never assumed (LAW 3 fix, iv)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('while degraded, an instructed READBACK reply with audio and no transcript does NOT log readback_issued, and the caller\'s following "Yes" does not confirm the field', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newSession(clock, CALL_B, aai, sent, diagEvents);

    // Degrade the mode on two ambient replies BEFORE the caller ever speaks (goal is still
    // GREET, not a QUESTION_GOALS code) -- same convention the (ii) suite above uses, and
    // deliberately so: an ambient empty completion sharing a QUESTION_GOALS goal's own label
    // would otherwise trigger the pre-existing (unrelated, out-of-scope) question-reask
    // machinery, which this test is not about.
    emitAudioNoTranscriptReply(aai, clock, 's0a', 100, 300);
    vi.advanceTimersByTime(DEGRADED_STRIKE_WAIT_MS);
    emitAudioNoTranscriptReply(aai, clock, 's0b', 400, 600);
    vi.advanceTimersByTime(DEGRADED_STRIKE_WAIT_MS);
    expect(diagEvents.filter((e) => e.kind === 'transcripts_degraded')).toHaveLength(1);

    // The caller states the wire request -- the engine issues a TRAP_FACT ASK_CHALLENGE and
    // proactively sends an instructed reply.create for it.
    clock.now = 1000;
    aai.emit({
      type: 'transcript.user',
      item_id: 'c1',
      text: "This is Dana Whitfield, corporate treasury. I need to wire it to Meridian Supply — $84,500, account ending 4471 — moving today instead of Friday, approved in yesterday's close meeting.",
    });
    vi.advanceTimersByTime(AUTOMATIC_REPLY_SETTLE_MS);
    expect(session.last?.goal.code).toBe('ASK_CHALLENGE');

    // 'a1' answers it: audio, no transcript -- degraded mode is ALREADY on (from s0a/s0b), so
    // `assumed_asked` applies to this CHALLENGE goal (unaffected by this fix, which only
    // restricts READBACK) and `challenge_issued` is logged, letting the engine actually grade
    // the caller's upcoming trap-fact correction and advance past CHALLENGE.
    clock.now = 1500;
    aai.emit({ type: 'reply.started', reply_id: 'a1' });
    aai.emit({ type: 'reply.audio', data: Buffer.alloc(100).toString('base64') });
    clock.now = 1800;
    aai.emit({ type: 'reply.done', reply_id: 'a1', status: 'completed' });
    vi.advanceTimersByTime(DEGRADED_STRIKE_WAIT_MS);
    expect(diagEvents.some((e) => e.kind === 'assumed_asked' && (e.detail as { reply_id: string }).reply_id === 'a1')).toBe(true);
    expect(session.logs.actions.some((a) => a.kind === 'challenge_issued')).toBe(true);

    // The caller corrects the trap fact -- the engine advances to a genuine READBACK for the
    // amount, and proactively sends an instructed reply.create for it. Mode is STILL degraded
    // throughout (nothing here ever produced a real transcript).
    clock.now = 3500;
    aai.emit({ type: 'transcript.user', item_id: 'c2', text: "No, that's wrong. It's Meridian Supply." });
    vi.advanceTimersByTime(AUTOMATIC_REPLY_SETTLE_MS);
    expect(session.last?.goal.code).toBe('READBACK');
    const field = session.last!.goal.readback!.field;
    expect(field).toBe('amount_usd');

    // 'r1' is that instructed READBACK reply: real audio, but AssemblyAI never transcribes it
    // -- the exact PROVEN degraded shape this fix protects.
    clock.now = 4000;
    aai.emit({ type: 'reply.started', reply_id: 'r1' });
    aai.emit({ type: 'reply.audio', data: Buffer.alloc(100).toString('base64') });
    clock.now = 4300;
    aai.emit({ type: 'reply.done', reply_id: 'r1', status: 'completed' });

    // No readback_issued action -- an un-heard readback must never let the caller's next "yes"
    // confirm a critical field they may never have heard.
    expect(session.logs.actions.some((a) => a.kind === 'readback_issued')).toBe(false);
    expect(diagEvents.some((e) => e.kind === 'assumed_asked' && (e.detail as { reply_id: string }).reply_id === 'r1')).toBe(false);
    const notAssumed = diagEvents.filter((e) => e.kind === 'readback_not_assumed');
    expect(notAssumed).toHaveLength(1);
    expect(notAssumed[0]!.detail).toEqual({ reply_id: 'r1', field: 'amount_usd' });

    // The caller's next turn says "Yes" -- with no readback_issued ever logged, the ledger
    // (engine/ledger.ts) has no pending readback to close out, so this cannot confirm
    // amount_usd: it stays exactly as first STATED, never CONFIRMED.
    clock.now = 4800;
    aai.emit({ type: 'transcript.user', item_id: 'c3', text: "Yes, that's right." });
    expect(session.logs.actions.some((a) => a.kind === 'readback_issued')).toBe(false);
    const amountClaim = session.last?.ledger.find((c) => c.field === 'amount_usd');
    expect(amountClaim?.kind).not.toBe('CONFIRMED');
  });
});

// Fix B (2026-09-17, PROVEN live -- deploy 45, record scripts/rehearse/reports/
// 2026-09-17T08-35-38-dana-patient, main checkout, gitignored): a real automatic reply
// streamed audio CONTINUOUSLY from 111.3s to 179.1s (68s) with no transcript at all --
// `checkDegradedInflightStrike`'s own audio-INACTIVITY design never fired because audio
// never actually stopped arriving for DEGRADED_INFLIGHT_STRIKE_MS (12s) at a stretch. This
// suite proves the second, independent, ABSOLUTE ceiling (`DEGRADED_MAX_AUDIO_ONLY_MS`, 20s,
// measured from `reply.audio.first`, never re-armed) that catches exactly this shape.

describe('CallSession -- DEGRADED-TRANSCRIPTS mode: absolute audio-only ceiling (Fix B)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('an automatic reply that streams audio CONTINUOUSLY (never idle long enough to trip the inactivity check) with no transcript strikes ONCE at the DEGRADED_MAX_AUDIO_ONLY_MS absolute ceiling, not the inactivity check', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    newSession(clock, CALL_B, aai, sent, diagEvents);

    clock.now = 1000;
    aai.emit({ type: 'reply.started', reply_id: 'long-dead' });
    // First frame -- arms BOTH the audio-inactivity check (fires at +12s of inactivity) and
    // the new absolute ceiling (fires at +20s, period, never re-armed).
    aai.emit({ type: 'reply.audio', data: Buffer.alloc(100).toString('base64') });

    // A frame every 2s -- comfortably inside the 12s inactivity window at every single point,
    // so `checkDegradedInflightStrike` never strikes; this is the exact live shape (audio
    // arriving on schedule, never actually silent) the inactivity design cannot catch by
    // construction.
    for (let i = 0; i < 8; i++) {
      clock.now += 2_000;
      vi.advanceTimersByTime(2_000);
      aai.emit({ type: 'reply.audio', data: Buffer.alloc(100).toString('base64') });
    }
    // 16s elapsed -- still short of the 20s absolute ceiling.
    expect(diagEvents.filter((e) => e.kind === 'degraded_strike')).toHaveLength(0);

    clock.now += 2_000;
    vi.advanceTimersByTime(2_000); // 18s
    expect(diagEvents.filter((e) => e.kind === 'degraded_strike')).toHaveLength(0);

    clock.now += 2_000;
    vi.advanceTimersByTime(2_000); // 20s -- the absolute ceiling fires, even though the last
    // frame arrived only 2s ago (comfortably inside the inactivity window).
    const strikes = diagEvents.filter((e) => e.kind === 'degraded_strike');
    expect(strikes).toHaveLength(1);
    expect(strikes[0]!.detail).toMatchObject({ reply_id: 'long-dead', in_flight: true, reason: 'max_audio_only' });

    // Continuing on to 25s total (matching a 25s continuous audio-only reply) -- no SECOND
    // strike for the same reply (dedup with the existing per-reply strike set).
    aai.emit({ type: 'reply.audio', data: Buffer.alloc(100).toString('base64') });
    clock.now += 5_000;
    vi.advanceTimersByTime(5_000); // 25s
    expect(diagEvents.filter((e) => e.kind === 'degraded_strike')).toHaveLength(1);
  });

  it('a reply whose transcript arrives before the DEGRADED_MAX_AUDIO_ONLY_MS ceiling (at 15s of a 25s-total reply) never strikes from the absolute ceiling', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    newSession(clock, CALL_B, aai, sent, diagEvents);

    clock.now = 1000;
    aai.emit({ type: 'reply.started', reply_id: 'long-healthy2' });
    aai.emit({ type: 'reply.audio', data: Buffer.alloc(100).toString('base64') }); // arms the 20s ceiling

    clock.now += 5_000;
    vi.advanceTimersByTime(5_000); // 5s
    aai.emit({ type: 'reply.audio', data: Buffer.alloc(100).toString('base64') });

    clock.now += 5_000;
    vi.advanceTimersByTime(5_000); // 10s
    aai.emit({ type: 'reply.audio', data: Buffer.alloc(100).toString('base64') });

    clock.now += 5_000;
    vi.advanceTimersByTime(5_000); // 15s -- a real transcript chunk arrives now, well before
    // the 20s absolute ceiling would otherwise fire.
    aai.emit({
      type: 'transcript.agent',
      item_id: 'long-healthy2-t',
      text: 'Still checking the record, thanks for your patience.',
      reply_id: 'long-healthy2',
      interrupted: false,
    });

    // Advance the remaining 10s of this 25s-total reply, well past the 20s absolute ceiling --
    // the ceiling timer was already cleared by the transcript arrival, so it never fires.
    clock.now += 10_000;
    vi.advanceTimersByTime(10_000); // 25s
    aai.emit({ type: 'reply.done', reply_id: 'long-healthy2', status: 'completed' });
    vi.advanceTimersByTime(DEGRADED_STRIKE_WAIT_MS);

    expect(diagEvents.filter((e) => e.kind === 'degraded_strike')).toHaveLength(0);
  });
});
