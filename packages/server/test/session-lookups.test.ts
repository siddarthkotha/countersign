// packages/server/test/session-lookups.test.ts
// Bug fix (2026-09-03, founder-observed live tonight): a live call reached identity +
// amount claimed, sat in EVIDENCE forever ("One moment while that check completes" on
// repeat) and never got a verdict, because nothing ever ran get_request_history /
// check_sso_context / verify_out_of_band unless the MODEL itself emitted a tool.call --
// and the STALL prompt for EVIDENCE never asks it to. The corpus files all hand-author the
// three tool calls, so no existing test ever exercised "the model never calls the tools",
// which is exactly what happened live.
//
// LAW 3: the engine is the only verdict owner. The fix makes the deterministic core (via
// CallSession, not the LLM) run these lookups itself -- mirrors the existing
// runTerminalActionsIfNeeded pattern, never runs a terminal/ACTION tool, never raises the
// ceiling above STAGE.
import { describe, it, expect } from 'vitest';
import { MERIDIAN, mockToolResult } from '@countersign/engine';
import type { CallContext, ServerEvent, ToolLogEntry, Utterance } from '@countersign/engine';
import { CallSession } from '../src/call/session.js';
import { FakeAaiSocket } from '../src/aai/fake.js';
import scenarioB from '../../engine/corpus/scenario-b-miller-fraud.json' with { type: 'json' };

const CALL_B = scenarioB.call as CallContext;

const LOOKUP_NAMES = ['get_request_history', 'check_sso_context', 'verify_out_of_band'] as const;

function newSession(clockRef: { now: number }, call: CallContext, aai: FakeAaiSocket, sent: ServerEvent[]) {
  return new CallSession({
    session_id: call.session_id,
    seed: MERIDIAN,
    call,
    aai,
    now: () => clockRef.now,
    onServerEvent: (e) => sent.push(e),
    mock: mockToolResult,
  });
}

/** Drives a corpus conversation array as live AAI transcript/reply events -- and, critically
 *  for this bug, NEVER emits a `tool.call` event, exactly like a caller talking to a model
 *  that never decides to call one. Caller lines become `transcript.user`; agent lines are
 *  wrapped in reply.started/transcript.agent/reply.done the same way the existing Scenario B
 *  live-replay test (session.test.ts) does it by hand -- generalized here to any conversation
 *  array so it can drive more than one scenario. */
function driveConversationLive(
  session: CallSession,
  aai: FakeAaiSocket,
  clock: { now: number },
  conversation: readonly (Utterance & { interrupted?: boolean })[],
): void {
  let replyCounter = 0;
  for (const line of conversation) {
    clock.now = line.t_ms;
    if (line.speaker === 'caller') {
      aai.emit({ type: 'transcript.user', item_id: line.id, text: line.text });
    } else {
      replyCounter += 1;
      const reply_id = `live-reply-${replyCounter}`;
      const interrupted = Boolean(line.interrupted);
      aai.emit({ type: 'reply.started', reply_id });
      aai.emit({ type: 'transcript.agent', item_id: line.id, text: line.text, reply_id, interrupted });
      aai.emit({ type: 'reply.done', reply_id, status: interrupted ? 'interrupted' : 'completed' });
    }
  }
}

function toolNames(tools: ToolLogEntry[]): string[] {
  return tools.map((t) => t.name);
}

function versionOf(entry: ToolLogEntry): number {
  return Number((entry.result as Record<string, unknown> | undefined)?.request_version);
}

describe('CallSession -- server-initiated lookup runner (deadlock bug fix)', () => {
  it('reaches a terminal verdict from live transcript events alone, with the model never emitting a single tool.call', async () => {
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const session = newSession(clock, CALL_B, aai, sent);

    session.start(); // INTAKE

    // Drives c1..a4 of Scenario B (Robert Miller claims identity + $1.8M, contradicts to
    // $2.1M mid-call bumping request_version to 2, pressure, barge-in) purely via
    // transcript.user/transcript.agent/reply.done -- no tool.call event is ever emitted by
    // this test, reproducing exactly what the founder saw live: the model never calls the
    // three lookups on its own.
    driveConversationLive(session, aai, clock, scenarioB.conversation as (Utterance & { interrupted?: boolean })[]);

    // BUG: on the old code, nothing ever ran the lookups (handleToolCall is the only place
    // that invokes the mock backend, and it's only reachable from an actual tool.call AAI
    // event) -- the call sits in EVIDENCE with an empty tools log and a PENDING verdict
    // forever, exactly the deadlock the founder watched happen live.
    //
    // FIX: the server itself runs get_request_history/check_sso_context/verify_out_of_band
    // the moment the state is EVIDENCE/CONSISTENCY_CHECK and they're missing/stale, so the
    // engine already has everything it needs by the time this function returns.
    const lookupEntries = session.logs.tools.filter((t) => (LOOKUP_NAMES as readonly string[]).includes(t.name));
    expect(toolNames(lookupEntries).sort()).toEqual([...LOOKUP_NAMES].sort());
    for (const entry of lookupEntries) {
      expect(versionOf(entry)).toBe(2); // I3: current request_version after the amount contradiction
      expect(entry.result?.error).toBeUndefined();
    }

    // The goal is no longer STALL/EVIDENCE -- the deadlock is broken and a verdict was
    // reached (Scenario B is an overdetermined fraud attempt: FREEZE, matching the corpus's
    // own recorded expectation for the identical evidence).
    expect(session.last?.state).not.toBe('EVIDENCE');
    expect(session.last?.verdict).toBe('FREEZE');
    expect(session.last?.reasons).toEqual(scenarioB.expected.reasons);

    // LAW 2: the ceiling never exceeds what the engine itself decided -- FREEZE here, never
    // an actual release; terminal actions ran (freeze/incident/alert/seal), which is the
    // existing, unchanged runTerminalActionsIfNeeded path.
    await session.whenIdle();
    expect(session.last?.state).toBe('SEALED');
  });
});

// ---------------------------------------------------------------------------------------
// A small, hand-built scenario (Dana Whitfield, seeded in MERIDIAN) used for the two tests
// below. It's built (and verified against the real engine, see the session's own
// diagnostics while developing this file) to land in a NON-terminal state -- CONSISTENCY_CHECK,
// rule_hit 5, "a critical field is claimed but not yet confirmed" -- after the identity is
// claimed and her own dana_payment_purpose knowledge challenge is answered correctly (2026-
// 09-09 founder ruling: Hartwell facts are scoped to robert-miller only, so the real engine
// never asks Dana about counsel of record -- it asks about her own Meridian Supply
// payment instead), at request_version 1.
// CONSISTENCY_CHECK offers the same three lookup tools EVIDENCE does (fsm.ts's own
// `allowedTools`), so the auto-runner fires there too, and -- unlike every corpus scenario
// on file, which all resolve to a terminal verdict (and permanently SEAL) the instant their
// evidence completes -- this one stays open long enough to bump `request_version` a second
// time (the caller changes the amount) while STILL not terminal, which is exactly the
// window I3 (stale evidence from a superseded version is never treated as current) needs to
// be observed happening twice, live, with the model never once calling a tool itself.
//
// The call originates from a "registered device" in Chicago while Dana's own seeded SSO
// session is active in Austin, TX -- deliberately mismatched so `check_sso_context` FAILs
// while `get_request_history` (matches the seeded $84,500/Meridian Supply/4471 payment) and
// `verify_out_of_band` (Dana's seed OOB response is "confirmed") both PASS. One failure
// alone is not enough to freeze outright, which is what keeps this scenario open instead of
// sealing immediately like every hand-authored corpus file does.
const CALL_DANA: CallContext = { session_id: 'sess-dana-live', origin_kind: 'registered_device', origin_geo: 'Chicago, IL' };

const C1 = {
  id: 'c1',
  speaker: 'caller' as const,
  text: 'This is Dana Whitfield, corporate treasury. I need to wire $84,500 to Meridian Supply, account ending 4471.',
  t_ms: 1000,
};
// Founder ruling 2026-09-09 (docs/PARKED-CHALLENGE-SCOPING.md, Option A): every Hartwell
// knowledge fact (counsel of record included) is now scoped to robert-miller and
// selectSeedFact refuses to hand one to any other caller, failing safe. So the real engine
// no longer asks Dana Whitfield about Hartwell's counsel of record at all -- it asks one of
// her OWN seeded facts instead (verified live via CallSession: for this exact session id
// and conversation prefix, selectChallenge deterministically picks `dana_payment_purpose`).
// The agent's line and the caller's answer below were updated to match that real,
// in-scope question; the old hardcoded pair encoded the very false-positive bug this
// scoping fix exists to close (an unrelated caller being quizzed on someone else's deal).
const A1_CHALLENGE = {
  id: 'a1',
  speaker: 'agent' as const,
  text: 'What is this payment to Meridian Supply for?',
  t_ms: 1500,
};
const C2_ANSWER = { id: 'c2', speaker: 'caller' as const, text: "It's a quarterly parts restock.", t_ms: 2000 };
const C3_AMOUNT_CHANGE = { id: 'c3', speaker: 'caller' as const, text: 'Make it $91,000 instead.', t_ms: 3000 };

describe('CallSession -- I3 (stale evidence is never treated as current) via the lookup runner', () => {
  it('re-runs all three lookups after an amount change bumps request_version, with no tool.call ever emitted', () => {
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const session = newSession(clock, CALL_DANA, aai, sent);
    session.start();

    // Identity + request claimed, then Dana's own dana_payment_purpose challenge is issued
    // and answered CORRECTLY (founder ruling 2026-09-09: Hartwell facts are scoped to
    // robert-miller only, so this is the real, in-scope question the engine now asks her)
    // -- this is what clears row 4 (challenge required) and lands the call on row 5
    // (CONSISTENCY_CHECK: critical fields not yet read back/confirmed), still at
    // request_version 1.
    driveConversationLive(session, aai, clock, [C1, A1_CHALLENGE, C2_ANSWER]);
    expect(session.last?.state).toBe('CONSISTENCY_CHECK');
    expect(session.last?.request_version).toBe(1);

    // The auto-runner already fired here (before this fix, it never would have): all three
    // lookups ran for v1 with no tool.call ever emitted.
    const v1Entries = session.logs.tools.filter((t) => (LOOKUP_NAMES as readonly string[]).includes(t.name));
    expect(toolNames(v1Entries).sort()).toEqual([...LOOKUP_NAMES].sort());
    for (const name of LOOKUP_NAMES) {
      expect(v1Entries.filter((t) => t.name === name && versionOf(t) === 1)).toHaveLength(1);
    }

    // Now the caller changes the amount with no correction language -- a fresh, unrepaired
    // contradiction on a critical field -- bumping request_version to 2.
    driveConversationLive(session, aai, clock, [C3_AMOUNT_CHANGE]);
    expect(session.last?.request_version).toBe(2);

    // I3: the v1 results are now stale (their echoed request_version no longer matches) --
    // the auto-runner re-ran every one of the three lookups for v2, again with no tool.call
    // ever emitted. The v1 entries are untouched (evidence is never edited, only
    // superseded).
    for (const name of LOOKUP_NAMES) {
      const versionsSeen = session.logs.tools.filter((t) => t.name === name).map(versionOf);
      expect(versionsSeen).toContain(1);
      expect(versionsSeen).toContain(2);
    }
  });

  it('does not re-run a lookup the model already called for the current request_version (no double-run)', () => {
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const session = newSession(clock, CALL_DANA, aai, sent);
    session.start();

    driveConversationLive(session, aai, clock, [C1, A1_CHALLENGE, C2_ANSWER]);
    expect(session.last?.state).toBe('CONSISTENCY_CHECK');
    expect(session.last?.request_version).toBe(1);

    // Simulate the model having ALREADY called check_sso_context for the version the amount
    // change is about to create, the instant it becomes current -- in a live deployment the
    // model and the server's own auto-runner are racing over a real network round trip; in
    // this synchronous test harness the auto-runner always wins that race and settles the
    // tick before a live tool.call event could ever land, which would make this branch
    // unreachable via the event pipeline alone. Seeding the log entry directly (using the
    // REAL mock backend, so it's indistinguishable from what the auto-runner itself would
    // have produced) exercises exactly the guard this test is for: "a fresh result already
    // logged for this tool at the current version -> don't run it again."
    const modelCallArgs = { identity_id: 'dana-whitfield', request_version: 2 };
    session.logs.tools.push({
      id: 'model-call-1',
      name: 'check_sso_context',
      t_ms: clock.now,
      args: modelCallArgs,
      result: mockToolResult('check_sso_context', modelCallArgs, MERIDIAN, { evidence_count: 0, incident_index: 0 }),
    });

    driveConversationLive(session, aai, clock, [C3_AMOUNT_CHANGE]);
    expect(session.last?.request_version).toBe(2);

    const ssoEntriesV2 = session.logs.tools.filter((t) => t.name === 'check_sso_context' && versionOf(t) === 2);
    expect(ssoEntriesV2).toHaveLength(1);
    expect(ssoEntriesV2[0]!.id).toBe('model-call-1'); // the server never ran its own copy alongside it

    // The other two lookups had nothing for v2 yet, so the auto-runner filled those in as
    // usual.
    for (const name of ['get_request_history', 'verify_out_of_band'] as const) {
      const entries = session.logs.tools.filter((t) => t.name === name && versionOf(t) === 2);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.id).not.toBe('model-call-1');
    }
  });
});

// Bug fix (2026-09-03, founder-observed live run tonight, see
// scripts/rehearse/reports/2026-09-03T23-04-42-scenario-a-dana-legitimate.md): the voice
// model is now offered NO tool schema, ever -- `allowedTools` (fsm.ts) returns [] for every
// EngineState, including EVIDENCE/CONSISTENCY_CHECK, which used to offer the three lookups.
// A model that (defensively -- it was never told these tools exist, but a live LLM cannot be
// fully trusted to never emit a stray tool.call) still emits one must be rejected exactly
// like any other out-of-state call, AND the server's own auto-runner must still resolve the
// evidence -- `runLookupsIfNeeded` never depended on `allowed_tools` in the first place, only
// on `state`, so this closing of the offer must not reopen the deadlock this file's other
// tests already fixed.
describe('CallSession -- the model is offered no tools, ever (allowedTools always []); a stray tool.call is still rejected and the lookup still resolves', () => {
  it('rejects a model-issued check_sso_context in CONSISTENCY_CHECK as not_allowed_in_state, logged ignored, while the server-run lookup already resolved the evidence', () => {
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const session = newSession(clock, CALL_DANA, aai, sent);
    session.start();

    driveConversationLive(session, aai, clock, [C1, A1_CHALLENGE, C2_ANSWER]);
    expect(session.last?.state).toBe('CONSISTENCY_CHECK');
    expect(session.last?.request_version).toBe(1);

    // The engine now offers nothing -- confirms the fix, not just the rejection path below.
    expect(session.last?.allowed_tools).toEqual([]);

    // The server's own auto-runner already resolved all three lookups for v1 with no
    // tool.call ever emitted -- same evidence a model-issued call would have produced.
    const preExistingLookupEntries = session.logs.tools.filter((t) => (LOOKUP_NAMES as readonly string[]).includes(t.name));
    expect(toolNames(preExistingLookupEntries).sort()).toEqual([...LOOKUP_NAMES].sort());
    for (const entry of preExistingLookupEntries) {
      expect(entry.result?.error).toBeUndefined();
    }

    // A stray model tool.call for one of the (never-offered) lookups arrives anyway.
    clock.now = 2500;
    aai.emit({
      type: 'tool.call',
      call_id: 'stray-model-call-1',
      name: 'check_sso_context',
      arguments: { identity_id: 'dana-whitfield' },
    });

    const rejected = session.logs.tools.find((t) => t.id === 'stray-model-call-1');
    expect(rejected).toBeDefined();
    expect(rejected!.result?.error).toBe('not_allowed_in_state');
    expect((rejected!.args as { ignored?: boolean }).ignored).toBe(true);

    // The rejection was queued as an error tool.result for AAI -- not silently dropped.
    // (It is only actually FLUSHED to the socket on the next real reply.done, an unrelated
    // mechanic already covered by session.test.ts's own flush tests -- driving a synthetic
    // reply.done here would itself complete whatever goal CONSISTENCY_CHECK's real READBACK
    // prompt was mid-turn on, advancing the call to a terminal verdict for reasons that have
    // nothing to do with this test's own subject, so this checks the queue directly instead.)
    const pending = (session as unknown as { pendingToolResults: { call_id: string; result: Record<string, unknown>; is_error: boolean }[] })
      .pendingToolResults;
    const queued = pending.find((p) => p.call_id === 'stray-model-call-1');
    expect(queued).toBeDefined();
    expect(queued!.is_error).toBe(true);
    expect(queued!.result.error).toBe('not_allowed_in_state');

    // The rejected call did NOT clobber or duplicate the evidence the server's own lookup
    // already resolved -- still exactly one real (non-ignored) entry per lookup tool, still
    // error-free (evidence/fromTools.ts's `latest()` explicitly skips `args.ignored === true`
    // entries, so the rejected call can never shadow the real result).
    const realLookupEntries = session.logs.tools.filter(
      (t) => (LOOKUP_NAMES as readonly string[]).includes(t.name) && !(t.args as { ignored?: boolean }).ignored,
    );
    expect(toolNames(realLookupEntries).sort()).toEqual([...LOOKUP_NAMES].sort());
    for (const entry of realLookupEntries) {
      expect(entry.result?.error).toBeUndefined();
    }

    // PROVEN (verified by running this exact scenario): a rejected tool.call's own logged
    // entry still carries `result.error` (`not_allowed_in_state`), and `compose.ts`'s
    // `computeEvaluationIncomplete` counts ANY tool entry with a set `result.error` -- it does
    // not look at `args.ignored` -- so I4 (rules.ts: an incomplete evaluation with an open
    // request forces ESCALATE, never STAGE) fires here exactly as it already does for a
    // rejected call in every other state (see session.test.ts/diagnostics.test.ts's own "the
    // auto-runner already resolved everything" notes, which force `session.last` for the same
    // reason). This is pre-existing engine behavior, unrelated to and unchanged by this fix --
    // this test's own subject (the rejection itself, and that the real evidence survives it
    // unshadowed) is fully proven above, before this final tick. Since `tools: []` means the
    // model has no schema to call in the first place, a live stray tool.call reaching this
    // path at all is now a purely defensive, expected-never scenario.
    expect(session.last?.verdict).toBe('ESCALATE');
    expect(session.last?.state).toBe('SEALED');
  });
});
