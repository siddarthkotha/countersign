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
// reuses the EXISTING idle-timeout NO_ACTION goodbye mechanism
// (`sendNoActionCloseGoodbye`/`closeSentenceOverride`/`armClose`, factored out of
// `beginIdleNoActionGoodbye` -- see that method's own doc comment), triggered earlier, from
// the caller's own next turn AFTER the demo explanation has actually been spoken once in
// full (`outOfScopeExplained`, set at a COMPLETED reply.done labelled EXPLAIN_OUT_OF_SCOPE),
// rather than waiting on 31s of idle silence. Tagged with its own diagnostics reason string,
// `out_of_scope_close` (distinct from idle's own `idle_no_action_close`), so the flight
// recorder can tell the two triggers apart. A caller who instead makes a real request keeps
// the existing hold_followup/explain behaviour entirely untouched -- the goal code itself
// moves to EXPLAIN_OPEN_REQUEST the moment they do, which this lane's own goal-code check
// excludes.
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

// The founder's own opening line and the agent's own explanation text -- both verbatim from
// df3f9781's diagnostics.
const OUT_OF_SCOPE_LINE = "I'm not the CEO. I'm testing this for a hackathon.";
const EXPLANATION_TEXT = 'This is a demo checkpoint for a synthetic company. You may act as Dana or the CEO. Nothing will move.';

describe('OUT-OF-SCOPE-GOODBYE lane: a caller who stays out of scope past the explanation gets the goodbye instead of a silent hold', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("the founder's exact live sequence (PROVEN, df3f9781): the caller's line AFTER the completed explanation triggers exactly one out_of_scope_close reply.create, and the call ends agent_closed once it's spoken", () => {
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

    expect(goodbyeSendsOf(aai)).toHaveLength(1);
    const closeSends = outOfScopeCloseDiags(diagEvents);
    expect(closeSends).toHaveLength(1);
    expect((closeSends[0]!.detail as { goal_code?: string }).goal_code).toBe('CLOSE');

    // The engine's OWN goal/state/verdict are untouched by the override -- same invariant
    // the idle-timeout path already relies on (see `closeSentenceOverride`'s own doc
    // comment in session.ts).
    expect(session.last?.verdict).toBe('NO_ACTION');
    expect(session.last?.state).toBe('OUT_OF_SCOPE');
    expect(session.last?.goal.code).toBe('EXPLAIN_OUT_OF_SCOPE');

    // The goodbye is spoken and transcript-confirmed -- the existing hang-up machinery ends
    // the call `agent_closed` (never `idle_timeout`: nothing here ever went through
    // `end('idle_timeout')`). Same audio-byte/grace-period shape session.test.ts's own
    // "idle-timeout end() with NO request ever stated" test already proves for the sibling
    // idle-triggered path.
    clock.now = 26800;
    aai.emit({ type: 'reply.started', reply_id: 'r1' });
    aai.emit({ type: 'reply.audio', data: Buffer.alloc(192_000).toString('base64') });
    aai.emit({ type: 'transcript.agent', item_id: 'a2', text: 'Thank you for calling. Goodbye.', reply_id: 'r1', interrupted: false });
    clock.now = 31_900;
    aai.emit({ type: 'reply.done', reply_id: 'r1', status: 'completed' });

    expect(sent.some((e) => e.type === 'ended')).toBe(false); // grace period still running
    vi.advanceTimersByTime(1500);
    expect(sent.at(-1)).toEqual({ type: 'ended', reason: 'agent_closed' });
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

  it('a caller line that arrives BEFORE the explanation has completed does not send the goodbye yet -- once the explanation completes and the caller speaks again, exactly one send follows', () => {
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
    // nothing sent.
    clock.now = 5000;
    aai.emit({ type: 'transcript.agent', item_id: 'a1', text: EXPLANATION_TEXT, reply_id: 'a1', interrupted: false });
    clock.now = 5300;
    aai.emit({ type: 'reply.done', reply_id: 'a1', status: 'completed' });
    expect(goodbyeSendsOf(aai)).toHaveLength(0);

    // The caller speaks again -- NOW it fires, exactly once.
    clock.now = 6000;
    aai.emit({ type: 'transcript.user', item_id: 'c3', text: "No, I don't have any real request. I'm just testing for the hackathon." });
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
    expect(goodbyeSendsOf(aai)).toHaveLength(1);

    // The caller keeps talking, without the goodbye ever having been confirmed yet.
    clock.now = 4000;
    aai.emit({ type: 'transcript.user', item_id: 'c3', text: "Hello? Are you still there? I don't have a real request." });
    clock.now = 5000;
    aai.emit({ type: 'transcript.user', item_id: 'c4', text: 'Just testing, nothing to verify.' });

    expect(goodbyeSendsOf(aai)).toHaveLength(1); // never a second send
    expect(outOfScopeCloseDiags(diagEvents)).toHaveLength(1);
  });
});
