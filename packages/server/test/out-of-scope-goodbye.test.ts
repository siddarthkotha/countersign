// packages/server/test/out-of-scope-goodbye.test.ts
// OUT-OF-SCOPE-GOODBYE lane (2026-09-22, PROVEN live: founder call df3f9781, 2026-09-22
// 9:27 AM CDT, deployed_commit f14fbcba77a11d5cc2d12896ac3c156305aae956): "I'm not the CEO,
// I'm testing this for a hackathon" -> engine verdict NO_ACTION / state OUT_OF_SCOPE / goal
// EXPLAIN_OUT_OF_SCOPE at 11294ms; the agent explained at 19887ms; the caller confirmed
// "That's right, I'm just testing. I don't have any real request." at 26694ms; the agent
// never said goodbye -- only "One moment." then a repeated hold_followup restatement of the
// SAME explanation -- until the caller gave up and hung up at 61s. The harness's own
// same-morning run (scripts/rehearse/reports/2026-09-22T09-17-41-judge-out-of-scope
// .diagnostics.json) shows the identical shape, caller_ended at 33s.
//
// The fix (call/session.ts's `maybeBeginOutOfScopeGoodbye`, called from `tick()`'s tail):
// reuses the EXISTING idle-timeout NO_ACTION goodbye override (`closeSentenceOverride`/
// `armClose`), triggered earlier, from the caller's own next turn AFTER the demo explanation
// has actually been spoken once in full (`outOfScopeExplained`, set at a COMPLETED reply.done
// labelled EXPLAIN_OUT_OF_SCOPE), rather than waiting on 31s of idle silence. A caller who
// instead makes a real request keeps the existing hold_followup/explain behaviour entirely
// untouched -- the goal code itself moves to EXPLAIN_OPEN_REQUEST the moment they do, which
// this lane's own goal-code check excludes.
//
// TRIPLE-GOODBYE regression + fix (2026-09-22, PROVEN live on deploy 5172a5e -- see
// scripts/rehearse/reports/2026-09-22T13-45-12-judge-out-of-scope.diagnostics.json and
// 2026-09-22T13-44-35-judge-out-of-scope.diagnostics.json): the first cut of this lane sent
// its own `out_of_scope_close` reply.create SYNCHRONOUSLY, the instant the goodbye was owed --
// the SAME instant AssemblyAI's own automatic reply for that turn started composing under the
// (also-new) post-explanation standing instruction (`pushOutOfScopeGoodbyeInstruction`). Both
// replies queued; the automatic one spoke the goodbye correctly at 26922ms; our own queued
// send then ALSO played; and a (now-removed) CLOSE-CATCHUP-ON-OVERRIDE fast-resend in
// `scheduleCloseIfNeeded` misfired on top of that, believing (wrongly -- it was checking the
// WRONG reply's own transcript) the goodbye had still not been heard -- three goodbyes total,
// an 8.4s hang-up. Root cause: nothing ever gave the automatic reply a head start, so queueing
// "behind" it always lost the race in practice (reply.create is near-instant to send;
// AssemblyAI's automatic reply takes real inference time to start). Fix: `maybeBeginOutOfScopeGoodbye`
// now only ARMS the override and a short (`OUT_OF_SCOPE_CLOSE_GRACE_MS` = 700ms) deferred-send
// timer; the timer re-reads state at fire time and sends only if nothing has started speaking
// by then. The CLOSE-CATCHUP-ON-OVERRIDE fast-resend is removed outright -- the existing
// transcript-wait (`armCloseTranscriptWait`, 1500ms) + spaced-retry (`armCloseRetryTimer`,
// 400ms) chain remains the sole backstop for an automatic reply that says something else.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MERIDIAN, mockToolResult } from '@countersign/engine';
import type { CallContext, ServerEvent } from '@countersign/engine';
import { CallSession } from '../src/call/session.js';
import { FakeAaiSocket } from '../src/aai/fake.js';

const FORCE_SPEAK_SETTLE_MS = 150; // CallSession.AUTOMATIC_REPLY_SETTLE_MS, same convention session.test.ts/design-e-turn-order.test.ts already use

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
    forceSpeakSettleMs: FORCE_SPEAK_SETTLE_MS,
    onDiagnostic: (kind, detail) => diagEvents.push({ kind, detail }),
  });
}

function replyCreatesOf(aai: FakeAaiSocket): { type?: string; instructions?: string }[] {
  return aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create') as {
    type?: string;
    instructions?: string;
  }[];
}

function goodbyeSendsOf(aai: FakeAaiSocket): { type?: string; instructions?: string }[] {
  return replyCreatesOf(aai).filter((m) => m.instructions?.includes('Thank you for calling. Goodbye.'));
}

function outOfScopeCloseDiags(diagEvents: { kind: string; detail: unknown }[]): { kind: string; detail: unknown }[] {
  return diagEvents.filter((e) => e.kind === 'reply_create_sent' && (e.detail as { reason?: string }).reason === 'out_of_scope_close');
}

// The CLOSE-CATCHUP-ON-OVERRIDE fast-resend (`close_catchup`) is removed outright (see the
// file header). Kept as an assertion helper purely as a regression guard -- every test below
// that could plausibly have triggered the old mechanism asserts this stays at zero.
function closeCatchupDiags(diagEvents: { kind: string; detail: unknown }[]): { kind: string; detail: unknown }[] {
  return diagEvents.filter((e) => e.kind === 'reply_create_sent' && (e.detail as { reason?: string }).reason === 'close_catchup');
}

// The pre-existing, unchanged spaced-retry chain (`armCloseTranscriptWait` ->
// `armCloseRetryTimer`) -- the backstop this lane now relies on when an automatic reply says
// something other than the goodbye.
function closeRetryDiags(diagEvents: { kind: string; detail: unknown }[]): { kind: string; detail: unknown }[] {
  return diagEvents.filter((e) => e.kind === 'reply_create_sent' && (e.detail as { reason?: string }).reason === 'close_retry');
}

function sessionUpdatesOf(aai: FakeAaiSocket): { type?: string; session?: { system_prompt?: string } }[] {
  return aai.sent.filter((m) => (m as { type?: string }).type === 'session.update') as {
    type?: string;
    session?: { system_prompt?: string };
  }[];
}

const POST_EXPLANATION_INSTRUCTION_MARKER = 'The demo has been explained.';

// The founder's own opening line and the agent's own explanation text -- both verbatim from
// df3f9781's diagnostics.
const OUT_OF_SCOPE_LINE = "I'm not the CEO. I'm testing this for a hackathon.";
const EXPLANATION_TEXT = 'This is a demo checkpoint for a synthetic company. You may act as Dana or the CEO. Nothing will move.';

// 192,000 bytes of "reply.audio" == 4s at CallSession.OUTPUT_AUDIO_BYTES_PER_SECOND (48,000) --
// the same fixture every other close-confirmation test in this file (and session.test.ts) uses
// to clear `closeReplyHasEnoughAudio`'s floor for the 32-char goodbye sentence.
const GOODBYE_AUDIO = Buffer.alloc(192_000).toString('base64');

describe('OUT-OF-SCOPE-GOODBYE lane: a caller who stays out of scope past the explanation gets the goodbye instead of a silent hold', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('(A) the PROVEN harness shape: an automatic reply starts well within the grace window and speaks the goodbye itself -- zero reply_create_sent of our own (no out_of_scope_close, no close_catchup), and the call ends agent_closed with the goodbye spoken exactly once', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const call: CallContext = { session_id: 'sess-oos-mechanism2', origin_kind: 'unverified_voip', origin_geo: 'unknown' };
    const session = newSession(clock, call, aai, sent, diagEvents);

    session.start();
    clock.now = 1000;
    aai.emit({ type: 'transcript.user', item_id: 'c1', text: OUT_OF_SCOPE_LINE });
    clock.now = 1200;
    aai.emit({ type: 'reply.started', reply_id: 'a1' });
    aai.emit({ type: 'transcript.agent', item_id: 'a1', text: EXPLANATION_TEXT, reply_id: 'a1', interrupted: false });
    clock.now = 2300;
    aai.emit({ type: 'reply.done', reply_id: 'a1', status: 'completed' });

    clock.now = 3000;
    aai.emit({ type: 'transcript.user', item_id: 'c2', text: 'This for a hackathon.' });
    // The goodbye is now OWED, but nothing is sent synchronously -- the send is deferred so
    // the automatic reply gets a head start.
    expect(outOfScopeCloseDiags(diagEvents)).toHaveLength(0);
    expect(goodbyeSendsOf(aai)).toHaveLength(0);

    // The automatic reply for this SAME turn -- composed under the pushed post-explanation
    // instruction (mechanism 2, unchanged by this fix) -- starts almost immediately and says
    // the goodbye correctly, the first time, with no send of ours involved at all.
    clock.now = 3010;
    aai.emit({ type: 'reply.started', reply_id: 'r1' });
    aai.emit({ type: 'reply.audio', data: GOODBYE_AUDIO });
    clock.now = 3900;
    aai.emit({ type: 'transcript.agent', item_id: 'a2', text: 'Thank you for calling. Goodbye.', reply_id: 'r1', interrupted: false });
    clock.now = 8101;
    aai.emit({ type: 'reply.done', reply_id: 'r1', status: 'completed' });

    // Confirmed via THIS reply's own transcript -- no send from our lane at any point.
    expect(outOfScopeCloseDiags(diagEvents)).toHaveLength(0);
    expect(closeCatchupDiags(diagEvents)).toHaveLength(0);
    expect(goodbyeSendsOf(aai)).toHaveLength(0);

    // Even once our own grace window fully elapses, the fire-time re-check finds the goodbye
    // already confirmed and no-ops -- never a second or third goodbye.
    vi.advanceTimersByTime(700);
    expect(outOfScopeCloseDiags(diagEvents)).toHaveLength(0);
    expect(goodbyeSendsOf(aai)).toHaveLength(0);

    expect(sent.some((e) => e.type === 'ended')).toBe(false); // close-tail grace still running
    vi.advanceTimersByTime(800); // the remaining 800ms of the 1500ms close-tail grace
    expect(sent.at(-1)).toEqual({ type: 'ended', reason: 'agent_closed' });
  });

  it("(B) an automatic reply starts within the grace window but says something else (the founder's a845c867 shape) -- our own send is skipped at the 700ms grace expiry because a reply is speaking, and the existing retry chain sends exactly one close reply.create once that reply completes without the goodbye", () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const call: CallContext = { session_id: 'sess-oos-ambient-other', origin_kind: 'unverified_voip', origin_geo: 'unknown' };
    const session = newSession(clock, call, aai, sent, diagEvents);

    session.start();
    clock.now = 1000;
    aai.emit({ type: 'transcript.user', item_id: 'c1', text: OUT_OF_SCOPE_LINE });
    clock.now = 1200;
    aai.emit({ type: 'reply.started', reply_id: 'a1' });
    aai.emit({ type: 'transcript.agent', item_id: 'a1', text: EXPLANATION_TEXT, reply_id: 'a1', interrupted: false });
    clock.now = 2300;
    aai.emit({ type: 'reply.done', reply_id: 'a1', status: 'completed' });

    clock.now = 3000;
    aai.emit({ type: 'transcript.user', item_id: 'c2', text: "That's right, I'm just testing. I don't have any real request." });
    expect(outOfScopeCloseDiags(diagEvents)).toHaveLength(0); // arms the grace timer, nothing sent yet

    // The automatic reply for this SAME turn starts (this.speaking flips true) before our own
    // grace window elapses -- the founder's own a845c867 transcript, verbatim: it says
    // something else entirely, never the goodbye.
    clock.now = 3010;
    aai.emit({ type: 'reply.started', reply_id: 'r1' });

    // Our own 700ms grace window elapses while r1 is STILL speaking (no reply.done yet) -- the
    // fire-time `!this.speaking` re-check correctly skips the send.
    vi.advanceTimersByTime(700);
    expect(outOfScopeCloseDiags(diagEvents)).toHaveLength(0);
    expect(goodbyeSendsOf(aai)).toHaveLength(0);

    // r1 completes without ever saying the goodbye.
    clock.now = 3900;
    aai.emit({
      type: 'transcript.agent',
      item_id: 'a2',
      text: 'One moment. Please select a role. Choose Dana or the caller claiming to be the CEO.',
      reply_id: 'r1',
      interrupted: false,
    });
    clock.now = 4000;
    aai.emit({ type: 'reply.done', reply_id: 'r1', status: 'completed' });

    // No confirmation and no immediate resend (the CLOSE-CATCHUP-ON-OVERRIDE fast path is
    // gone) -- the existing transcript-wait + spaced-retry chain is what recovers this.
    expect(outOfScopeCloseDiags(diagEvents)).toHaveLength(0);
    expect(closeCatchupDiags(diagEvents)).toHaveLength(0);
    expect(goodbyeSendsOf(aai)).toHaveLength(0);

    // CLOSE_TRANSCRIPT_WAIT_MS (1500ms) then CLOSE_RETRY_MIN_GAP_MS (400ms) later, exactly one
    // close_retry reply.create goes out -- the unchanged existing backstop.
    vi.advanceTimersByTime(1500 + 400);
    expect(closeRetryDiags(diagEvents)).toHaveLength(1);
    expect(goodbyeSendsOf(aai)).toHaveLength(1);
    expect(outOfScopeCloseDiags(diagEvents)).toHaveLength(0); // this send was close_retry, never out_of_scope_close

    // That retry is actually heard -- the existing hang-up machinery ends the call agent_closed.
    clock.now = 4600;
    aai.emit({ type: 'reply.started', reply_id: 'r2' });
    aai.emit({ type: 'reply.audio', data: GOODBYE_AUDIO });
    aai.emit({ type: 'transcript.agent', item_id: 'a3', text: 'Thank you for calling. Goodbye.', reply_id: 'r2', interrupted: false });
    clock.now = 9_700;
    aai.emit({ type: 'reply.done', reply_id: 'r2', status: 'completed' });

    expect(sent.some((e) => e.type === 'ended')).toBe(false); // grace period still running
    vi.advanceTimersByTime(1500);
    expect(sent.at(-1)).toEqual({ type: 'ended', reason: 'agent_closed' });

    // Never more than one send total for this whole lane.
    expect(closeRetryDiags(diagEvents)).toHaveLength(1);
    expect(outOfScopeCloseDiags(diagEvents)).toHaveLength(0);
    expect(closeCatchupDiags(diagEvents)).toHaveLength(0);
  });

  it('(C) no automatic reply starts at all within the grace window -- exactly one out_of_scope_close reply.create goes out at the grace expiry, and the call ends agent_closed once it is spoken', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const call: CallContext = { session_id: 'sess-oos-no-ambient', origin_kind: 'unverified_voip', origin_geo: 'unknown' };
    const session = newSession(clock, call, aai, sent, diagEvents);

    session.start();
    clock.now = 1000;
    aai.emit({ type: 'transcript.user', item_id: 'c1', text: OUT_OF_SCOPE_LINE });
    clock.now = 1200;
    aai.emit({ type: 'reply.started', reply_id: 'a1' });
    aai.emit({ type: 'transcript.agent', item_id: 'a1', text: EXPLANATION_TEXT, reply_id: 'a1', interrupted: false });
    clock.now = 2300;
    aai.emit({ type: 'reply.done', reply_id: 'a1', status: 'completed' });

    clock.now = 3000;
    aai.emit({ type: 'transcript.user', item_id: 'c2', text: "That's right, I'm just testing. I don't have any real request." });
    expect(outOfScopeCloseDiags(diagEvents)).toHaveLength(0); // nothing yet -- deferred

    // Nothing else ever starts speaking -- once the grace window elapses, our own instructed
    // send is the only thing that can recover this call.
    vi.advanceTimersByTime(700);
    expect(outOfScopeCloseDiags(diagEvents)).toHaveLength(1);
    expect(goodbyeSendsOf(aai)).toHaveLength(1);

    clock.now = 3710;
    aai.emit({ type: 'reply.started', reply_id: 'r1' });
    aai.emit({ type: 'reply.audio', data: GOODBYE_AUDIO });
    aai.emit({ type: 'transcript.agent', item_id: 'a2', text: 'Thank you for calling. Goodbye.', reply_id: 'r1', interrupted: false });
    clock.now = 8_810;
    aai.emit({ type: 'reply.done', reply_id: 'r1', status: 'completed' });

    expect(sent.some((e) => e.type === 'ended')).toBe(false); // grace period still running
    vi.advanceTimersByTime(1500);
    expect(sent.at(-1)).toEqual({ type: 'ended', reason: 'agent_closed' });

    // Never a second send once the goodbye is actually confirmed.
    expect(outOfScopeCloseDiags(diagEvents)).toHaveLength(1);
    expect(closeCatchupDiags(diagEvents)).toHaveLength(0);
  });

  it("(D) the founder's exact live sequence (PROVEN, df3f9781): the caller's line AFTER the completed explanation still ends the call agent_closed with exactly one goodbye heard, now spoken by the automatic reply itself with zero sends of our own", () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const call: CallContext = { session_id: 'sess-oos-goodbye', origin_kind: 'unverified_voip', origin_geo: 'unknown' };
    const session = newSession(clock, call, aai, sent, diagEvents);

    session.start(); // INTAKE/GREET, nothing said yet

    clock.now = 8891;
    aai.emit({ type: 'transcript.user', item_id: 'c1', text: OUT_OF_SCOPE_LINE });
    expect(session.last?.verdict).toBe('NO_ACTION');
    expect(session.last?.state).toBe('OUT_OF_SCOPE');
    expect(session.last?.goal.code).toBe('EXPLAIN_OUT_OF_SCOPE');
    // The caller's FIRST out-of-scope line must not trigger the goodbye -- the explanation
    // has not been spoken yet (condition (c), `outOfScopeExplained`).
    expect(goodbyeSendsOf(aai)).toHaveLength(0);

    // The demo explanation, spoken by an ordinary AMBIENT reply (never instructed -- this is
    // AssemblyAI's own automatic reply picking up the fresh system_prompt, exactly as it did
    // live), completes.
    clock.now = 11298;
    aai.emit({ type: 'reply.started', reply_id: 'a1' });
    clock.now = 19887;
    aai.emit({ type: 'transcript.agent', item_id: 'a1', text: EXPLANATION_TEXT, reply_id: 'a1', interrupted: false });
    clock.now = 20139;
    aai.emit({ type: 'reply.done', reply_id: 'a1', status: 'completed' });
    expect(goodbyeSendsOf(aai)).toHaveLength(0); // still nothing -- no caller turn has followed it yet

    // The caller's line right after that -- the founder's own second live line, verbatim.
    clock.now = 26694;
    aai.emit({ type: 'transcript.user', item_id: 'c2', text: "That's right, I'm just testing. I don't have any real request." });

    // The goodbye is now owed, but our own send is deferred -- nothing has gone out yet.
    expect(goodbyeSendsOf(aai)).toHaveLength(0);
    expect(outOfScopeCloseDiags(diagEvents)).toHaveLength(0);

    // The engine's OWN goal/state/verdict are untouched by the override -- same invariant
    // the idle-timeout path already relies on (see `closeSentenceOverride`'s own doc
    // comment in session.ts).
    expect(session.last?.verdict).toBe('NO_ACTION');
    expect(session.last?.state).toBe('OUT_OF_SCOPE');
    expect(session.last?.goal.code).toBe('EXPLAIN_OUT_OF_SCOPE');

    // The automatic reply for this SAME turn starts within the grace window (106ms live) and
    // -- now correctly instructed by the post-explanation standing rule -- speaks the goodbye
    // itself. Our own deferred send never fires: nothing is ever queued behind it.
    clock.now = 26800;
    aai.emit({ type: 'reply.started', reply_id: 'r1' });
    aai.emit({ type: 'reply.audio', data: GOODBYE_AUDIO });
    aai.emit({ type: 'transcript.agent', item_id: 'a2', text: 'Thank you for calling. Goodbye.', reply_id: 'r1', interrupted: false });
    clock.now = 31_900;
    aai.emit({ type: 'reply.done', reply_id: 'r1', status: 'completed' });

    expect(outOfScopeCloseDiags(diagEvents)).toHaveLength(0);
    expect(closeCatchupDiags(diagEvents)).toHaveLength(0);
    expect(goodbyeSendsOf(aai)).toHaveLength(0); // the goodbye heard above was the automatic reply's own, never ours

    // The goodbye is spoken and transcript-confirmed -- the existing hang-up machinery ends
    // the call `agent_closed` (never `idle_timeout`: nothing here ever went through
    // `end('idle_timeout')`). The single `vi.advanceTimersByTime` below covers both our own
    // now-moot 700ms grace timer (a no-op: the goodbye is already confirmed by the time it
    // fires) and the 1500ms close-tail grace that actually ends the call.
    expect(sent.some((e) => e.type === 'ended')).toBe(false); // grace period still running
    vi.advanceTimersByTime(1500);
    expect(sent.at(-1)).toEqual({ type: 'ended', reason: 'agent_closed' });

    // Exactly one "Thank you for calling. Goodbye." was ever heard across the whole call.
    expect(sent.filter((e) => e.type === 'ended')).toHaveLength(1);
  });

  it('(E) a caller who states a name and a request after the explanation gets no goodbye -- the call continues and the goal moves to EXPLAIN_OPEN_REQUEST', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const call: CallContext = { session_id: 'sess-oos-request-after-explain', origin_kind: 'unverified_voip', origin_geo: 'unknown' };
    const session = newSession(clock, call, aai, sent, diagEvents);

    session.start();
    clock.now = 1000;
    aai.emit({ type: 'transcript.user', item_id: 'c1', text: OUT_OF_SCOPE_LINE });
    clock.now = 1200;
    aai.emit({ type: 'reply.started', reply_id: 'a1' });
    aai.emit({ type: 'transcript.agent', item_id: 'a1', text: EXPLANATION_TEXT, reply_id: 'a1', interrupted: false });
    clock.now = 2300;
    aai.emit({ type: 'reply.done', reply_id: 'a1', status: 'completed' });
    // The post-explanation instruction is now pushed (proven by test (F) below); a caller who
    // states a name and a request must still get no goodbye at all.
    expect(goodbyeSendsOf(aai)).toHaveLength(0);

    clock.now = 3000;
    aai.emit({
      type: 'transcript.user',
      item_id: 'c2',
      text: 'This is Dana Whitfield, corporate treasury. I need to wire $84,500 to Meridian Supply, account ending 4471.',
    });

    expect(session.last?.verdict).toBe('NO_ACTION');
    expect(session.last?.state).toBe('OUT_OF_SCOPE');
    expect(session.last?.goal.code).toBe('EXPLAIN_OPEN_REQUEST');
    expect(goodbyeSendsOf(aai)).toHaveLength(0);
    expect(outOfScopeCloseDiags(diagEvents)).toHaveLength(0);
    expect(closeCatchupDiags(diagEvents)).toHaveLength(0);

    // No goodbye is ever owed for this call, even once the (now-moot) grace window would have
    // elapsed had it ever been armed.
    vi.advanceTimersByTime(700);
    expect(goodbyeSendsOf(aai)).toHaveLength(0);
  });

  it('a caller whose second line IS a request keeps the existing hold_followup/explain behaviour untouched -- no out_of_scope_close send, and the goal moves to EXPLAIN_OPEN_REQUEST', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const call: CallContext = { session_id: 'sess-oos-request', origin_kind: 'unverified_voip', origin_geo: 'unknown' };
    const session = newSession(clock, call, aai, sent, diagEvents);

    session.start();
    clock.now = 1000;
    aai.emit({ type: 'transcript.user', item_id: 'c1', text: OUT_OF_SCOPE_LINE });
    expect(session.last?.goal.code).toBe('EXPLAIN_OUT_OF_SCOPE');

    clock.now = 2000;
    aai.emit({ type: 'reply.started', reply_id: 'a1' });
    aai.emit({ type: 'transcript.agent', item_id: 'a1', text: EXPLANATION_TEXT, reply_id: 'a1', interrupted: false });
    clock.now = 3000;
    aai.emit({ type: 'reply.done', reply_id: 'a1', status: 'completed' });
    expect(goodbyeSendsOf(aai)).toHaveLength(0);

    // The caller's SECOND line makes a real request -- an amount alone is enough to flip
    // request_params on (fromTranscript.ts's own "first amount only" comment), moving the
    // goal to EXPLAIN_OPEN_REQUEST, a DIFFERENT goal code from EXPLAIN_OUT_OF_SCOPE.
    clock.now = 4000;
    aai.emit({
      type: 'transcript.user',
      item_id: 'c2',
      text: 'This is Dana Whitfield, corporate treasury. I need to wire $84,500 to Meridian Supply, account ending 4471.',
    });

    expect(session.last?.verdict).toBe('NO_ACTION'); // row 2: out-of-scope WITH a request is still NO_ACTION
    expect(session.last?.state).toBe('OUT_OF_SCOPE');
    expect(session.last?.goal.code).toBe('EXPLAIN_OPEN_REQUEST');
    expect(goodbyeSendsOf(aai)).toHaveLength(0);
    expect(outOfScopeCloseDiags(diagEvents)).toHaveLength(0);
  });

  it('a caller line that arrives BEFORE the explanation has completed does not send the goodbye yet -- once the explanation completes and the caller speaks again, exactly one send follows once the grace window elapses', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const call: CallContext = { session_id: 'sess-oos-inflight', origin_kind: 'unverified_voip', origin_geo: 'unknown' };
    const session = newSession(clock, call, aai, sent, diagEvents);

    session.start();
    clock.now = 1000;
    aai.emit({ type: 'transcript.user', item_id: 'c1', text: OUT_OF_SCOPE_LINE });

    // The explanation reply has STARTED but not yet completed.
    clock.now = 1200;
    aai.emit({ type: 'reply.started', reply_id: 'a1' });

    // The caller talks again while it's still in flight -- condition (c) (`outOfScopeExplained`)
    // is not yet satisfied, so nothing new is owed from THIS lane (the ordinary
    // hold_followup/explain flow is untouched, unchanged from before this fix).
    clock.now = 2000;
    aai.emit({ type: 'transcript.user', item_id: 'c2', text: 'Seriously, this is a demo, right?' });
    expect(goodbyeSendsOf(aai)).toHaveLength(0);
    expect(outOfScopeCloseDiags(diagEvents)).toHaveLength(0);

    // The explanation NOW completes -- but no caller turn has happened since, so still
    // nothing sent, and nothing armed.
    clock.now = 5000;
    aai.emit({ type: 'transcript.agent', item_id: 'a1', text: EXPLANATION_TEXT, reply_id: 'a1', interrupted: false });
    clock.now = 5300;
    aai.emit({ type: 'reply.done', reply_id: 'a1', status: 'completed' });
    expect(goodbyeSendsOf(aai)).toHaveLength(0);

    // The caller speaks again -- NOW the override is armed, but the send is still deferred
    // (no automatic reply follows in this test) -- nothing sent until the grace window elapses.
    clock.now = 6000;
    aai.emit({ type: 'transcript.user', item_id: 'c3', text: "No, I don't have any real request. I'm just testing for the hackathon." });
    expect(goodbyeSendsOf(aai)).toHaveLength(0);
    expect(outOfScopeCloseDiags(diagEvents)).toHaveLength(0);

    vi.advanceTimersByTime(700);
    expect(goodbyeSendsOf(aai)).toHaveLength(1);
    expect(outOfScopeCloseDiags(diagEvents)).toHaveLength(1);
  });

  it('the goodbye fires only once even if the caller keeps talking afterwards', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const call: CallContext = { session_id: 'sess-oos-repeat', origin_kind: 'unverified_voip', origin_geo: 'unknown' };
    const session = newSession(clock, call, aai, sent, diagEvents);

    session.start();
    clock.now = 1000;
    aai.emit({ type: 'transcript.user', item_id: 'c1', text: OUT_OF_SCOPE_LINE });
    clock.now = 1200;
    aai.emit({ type: 'reply.started', reply_id: 'a1' });
    aai.emit({ type: 'transcript.agent', item_id: 'a1', text: EXPLANATION_TEXT, reply_id: 'a1', interrupted: false });
    clock.now = 2300;
    aai.emit({ type: 'reply.done', reply_id: 'a1', status: 'completed' });

    clock.now = 3000;
    aai.emit({ type: 'transcript.user', item_id: 'c2', text: "That's right, I'm just testing. I don't have any real request." });
    expect(goodbyeSendsOf(aai)).toHaveLength(0); // deferred -- nothing sent on this same tick

    // The grace window elapses with no automatic reply ever starting -- our own send fires.
    vi.advanceTimersByTime(700);
    expect(goodbyeSendsOf(aai)).toHaveLength(1);

    // The caller keeps talking, without the goodbye ever having been confirmed yet.
    clock.now = 4000;
    aai.emit({ type: 'transcript.user', item_id: 'c3', text: "Hello? Are you still there? I don't have a real request." });
    clock.now = 5000;
    aai.emit({ type: 'transcript.user', item_id: 'c4', text: 'Just testing, nothing to verify.' });

    expect(goodbyeSendsOf(aai)).toHaveLength(1); // never a second send
    expect(outOfScopeCloseDiags(diagEvents)).toHaveLength(1);
  });

  it('(F) the post-explanation instruction is present in the session.update sent after the explanation completes, and absent from every session.update sent before it', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const call: CallContext = { session_id: 'sess-oos-instruction', origin_kind: 'unverified_voip', origin_geo: 'unknown' };
    const session = newSession(clock, call, aai, sent, diagEvents);

    session.start();
    clock.now = 1000;
    aai.emit({ type: 'transcript.user', item_id: 'c1', text: OUT_OF_SCOPE_LINE });
    expect(session.last?.goal.code).toBe('EXPLAIN_OUT_OF_SCOPE');

    // Every session.update sent so far (including the one this very turn just triggered, for
    // the FIRST EXPLAIN_OUT_OF_SCOPE rendering) must NOT carry the post-explanation
    // instruction -- "keep the initial EXPLAIN_OUT_OF_SCOPE rendering unchanged for the first
    // reply".
    const beforeUpdates = sessionUpdatesOf(aai);
    expect(beforeUpdates.length).toBeGreaterThan(0);
    for (const update of beforeUpdates) {
      expect(update.session?.system_prompt ?? '').not.toContain(POST_EXPLANATION_INSTRUCTION_MARKER);
    }

    clock.now = 1200;
    aai.emit({ type: 'reply.started', reply_id: 'a1' });
    aai.emit({ type: 'transcript.agent', item_id: 'a1', text: EXPLANATION_TEXT, reply_id: 'a1', interrupted: false });
    clock.now = 2300;
    aai.emit({ type: 'reply.done', reply_id: 'a1', status: 'completed' });

    // The explanation reply's own reply.done pushes a FRESH session.update carrying the
    // post-explanation instruction -- EXPLAIN_OUT_OF_SCOPE -> EXPLAIN_OUT_OF_SCOPE is not a
    // goal-key change, so this could only ever come from the dedicated push, never the
    // ordinary goal-changed path.
    const afterUpdates = sessionUpdatesOf(aai);
    expect(afterUpdates.length).toBeGreaterThan(beforeUpdates.length);
    const latest = afterUpdates.at(-1);
    expect(latest?.session?.system_prompt ?? '').toContain(POST_EXPLANATION_INSTRUCTION_MARKER);
    expect(latest?.session?.system_prompt ?? '').toContain('Thank you for calling. Goodbye.');
  });
});
