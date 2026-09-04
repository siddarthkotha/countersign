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
// claimed and the counsel-of-record challenge is answered correctly, at request_version 1.
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
const A1_CHALLENGE = {
  id: 'a1',
  speaker: 'agent' as const,
  text: 'Which law firm is our counsel of record on the Hartwell deal?',
  t_ms: 1500,
};
const C2_ANSWER = { id: 'c2', speaker: 'caller' as const, text: 'Calder and Finch.', t_ms: 2000 };
const C3_AMOUNT_CHANGE = { id: 'c3', speaker: 'caller' as const, text: 'Make it $91,000 instead.', t_ms: 3000 };

describe('CallSession -- I3 (stale evidence is never treated as current) via the lookup runner', () => {
  it('re-runs all three lookups after an amount change bumps request_version, with no tool.call ever emitted', () => {
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const session = newSession(clock, CALL_DANA, aai, sent);
    session.start();

    // Identity + request claimed, then the counsel-of-record challenge is issued and
    // answered CORRECTLY -- this is what clears row 4 (challenge required) and lands the
    // call on row 5 (CONSISTENCY_CHECK: critical fields not yet read back/confirmed), still
    // at request_version 1.
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
