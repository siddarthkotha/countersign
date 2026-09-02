import { describe, it, expect } from 'vitest';
import { MERIDIAN, mockToolResult } from '@countersign/engine';
import type { AgentAction, CallContext, ServerEvent, ToolLogEntry } from '@countersign/engine';
import { CallSession } from '../src/call/session.js';
import { FakeAaiSocket } from '../src/aai/fake.js';
import scenarioB from '../../engine/corpus/scenario-b-miller-fraud.json' with { type: 'json' };

const CALL_B = scenarioB.call as CallContext;

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

/** `buildEvidenceExport` hashes via `crypto.subtle.digest`, which resolves on a real
 *  Node task, not a plain microtask -- a chain of `await Promise.resolve()` isn't enough
 *  to observe it settle, so this waits on the real (unfaked, injected-clock-independent)
 *  event loop instead. */
async function waitForRealTick(ms = 20): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('CallSession — Scenario B (Robert Miller, fraudulent) replayed as live AAI events', () => {
  it('reproduces the recorded conversation/tools, reaches FREEZE, and countersigns the terminal actions', async () => {
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const session = newSession(clock, CALL_B, aai, sent);

    session.start(); // INTAKE, before anything is said

    // c1 -- caller states identity + the fraudulent request
    clock.now = 1000;
    aai.emit({ type: 'transcript.user', item_id: 'c1', text: scenarioB.conversation[0]!.text });

    // a1 -- agent's first challenge (the engine picks it; a1's own line is just what the
    // real call sounded like, not something session.ts trusts for anything)
    clock.now = 4000;
    aai.emit({ type: 'reply.started', reply_id: 'a1' });
    aai.emit({ type: 'transcript.agent', item_id: 'a1', text: scenarioB.conversation[1]!.text, reply_id: 'a1', interrupted: false });
    aai.emit({ type: 'reply.done', reply_id: 'a1', status: 'completed' });

    // c2 -- counsel answer + pressure ("Release it.")
    clock.now = 8000;
    aai.emit({ type: 'transcript.user', item_id: 'c2', text: scenarioB.conversation[2]!.text });

    clock.now = 12000;
    aai.emit({ type: 'reply.started', reply_id: 'a2' });
    aai.emit({ type: 'transcript.agent', item_id: 'a2', text: scenarioB.conversation[3]!.text, reply_id: 'a2', interrupted: false });
    aai.emit({ type: 'reply.done', reply_id: 'a2', status: 'completed' });

    // c3 -- the amount contradiction ($1.8M -> $2.1M)
    clock.now = 40000;
    aai.emit({ type: 'transcript.user', item_id: 'c3', text: scenarioB.conversation[4]!.text });

    // a3 -- the agent's probe, barged in on (recorded interrupted: true)
    clock.now = 44000;
    aai.emit({ type: 'reply.started', reply_id: 'a3' });
    aai.emit({ type: 'transcript.agent', item_id: 'a3', text: scenarioB.conversation[5]!.text, reply_id: 'a3', interrupted: true });
    aai.emit({ type: 'reply.done', reply_id: 'a3', status: 'interrupted' });

    // c4 -- "Release the wire or you're fired!"
    clock.now = 48000;
    aai.emit({ type: 'transcript.user', item_id: 'c4', text: scenarioB.conversation[6]!.text });

    clock.now = 50000;
    aai.emit({ type: 'reply.started', reply_id: 'a4' });
    aai.emit({ type: 'transcript.agent', item_id: 'a4', text: scenarioB.conversation[7]!.text, reply_id: 'a4', interrupted: false });
    aai.emit({ type: 'reply.done', reply_id: 'a4', status: 'completed' });

    // The evidence-gathering tool calls, all inside one "hold" reply cycle.
    clock.now = 50500;
    aai.emit({ type: 'reply.started', reply_id: 'tools-1' });

    clock.now = 51000;
    aai.emit({ type: 'tool.call', call_id: 't1', name: 'check_sso_context', arguments: { identity_id: 'robert-miller' } });

    // The tool timing rule: no tool.result reaches AAI until the reply.done arrives.
    expect(aai.sent.some((m) => (m as { type?: string }).type === 'tool.result')).toBe(false);

    clock.now = 51500;
    aai.emit({ type: 'tool.call', call_id: 't2', name: 'get_request_history', arguments: { identity_id: 'robert-miller' } });

    clock.now = 52000;
    aai.emit({ type: 'tool.call', call_id: 't3', name: 'verify_out_of_band', arguments: { identity_id: 'robert-miller' } });

    // By the third tool result the engine already has everything it needs for FREEZE --
    // terminal actions run immediately, before the wrapping reply even finishes.
    expect(session.last?.verdict).toBe('FREEZE');
    expect(aai.sent.some((m) => (m as { type?: string }).type === 'tool.result')).toBe(false);

    clock.now = 52500;
    aai.emit({ type: 'reply.done', reply_id: 'tools-1', status: 'completed' });

    // Now (and only now) the three queued tool.results reach AAI.
    const toolResults = aai.sent.filter((m) => (m as { type?: string }).type === 'tool.result') as {
      type: string;
      call_id: string;
      is_error: boolean;
    }[];
    expect(toolResults.map((r) => r.call_id).sort()).toEqual(['t1', 't2', 't3']);
    expect(toolResults.every((r) => r.is_error === false)).toBe(true);

    // ---- logs reproduce the corpus shapes (modulo generated ids) ----
    // Conversation and tool results are objective inputs -- what was actually said, and
    // what the deterministic mock backend returns for it -- so a live feed of the exact
    // same events reproduces them exactly.
    expect(session.logs.conversation).toEqual(scenarioB.conversation);

    const recordedThreeTools = session.logs.tools.slice(0, 3);
    expect(recordedThreeTools).toEqual(scenarioB.tools as ToolLogEntry[]);

    // The corpus file's `challenge_issued` action is fictional narration (a hand-authored
    // trace satisfying the engine's constraints for its recorded `expected` block), not a
    // recording of what THIS conversation's own live phrasingGoal would say turn by turn.
    // Replayed live, the engine's real priority order (amount_usd stays an unconfirmed
    // critical field the whole call -- the caller never once affirms a readback) keeps
    // choosing READBACK over ASK_CHALLENGE every time, so this session's own actions log is
    // readback_issued entries, not the corpus's challenge_issued one -- and that's the
    // correct, verified behaviour of the real engine, not a test bug. What must (and does)
    // still hold is LAW 3's real promise: the SAME engine, fed the SAME evidence, reaches
    // the SAME verdict regardless of which legal path the actions log took to get there.
    expect(session.logs.actions.filter((a) => a.kind === 'challenge_issued')).toHaveLength(0);
    const readbacks = session.logs.actions.filter((a) => a.kind === 'readback_issued');
    expect(readbacks.length).toBeGreaterThan(0);
    expect(readbacks.every((a) => a.field === 'amount_usd')).toBe(true);

    // ---- terminal actions ran, in the FSM's FREEZE order, all after the three recorded tools ----
    const terminalTools = session.logs.tools.slice(3);
    expect(terminalTools.map((t) => t.name)).toEqual([
      'freeze_transaction_rail',
      'open_incident',
      'alert_principal',
      'seal_evidence_record',
    ]);
    expect(terminalTools.every((t) => t.result !== undefined)).toBe(true);

    // ---- the engine's own verdict: FREEZE, on the reasons this exact live path actually
    // proves (a strict subset of the corpus's -- KNOWLEDGE_CHECK_FAILED never applies here
    // since this path never reaches a challenge; see the actions note above) ----
    expect(session.last?.verdict).toBe('FREEZE');
    expect(session.last?.reasons).toEqual(
      expect.arrayContaining(['IDENTITY_UNVERIFIED', 'OUT_OF_BAND_NO_RESPONSE', 'CONTEXT_FAILURE', 'STORY_INCONSISTENCY', 'URGENCY_ESCALATION']),
    );
    expect(session.last?.reasons).not.toContain('KNOWLEDGE_CHECK_FAILED');
    expect(session.last?.state).toBe('SEALED'); // seal_evidence_record has now run

    // ---- the countersign: re-running evaluate over the frozen logs reproduced FREEZE ----
    await waitForRealTick();
    const lastState = [...sent].reverse().find((e) => e.type === 'state');
    expect(lastState?.type).toBe('state');
    if (lastState?.type === 'state') {
      expect(lastState.state.forensic.countersign.recomputed).toBe(true);
      expect(lastState.state.forensic.countersign.server_verdict).toBe('FREEZE');
      expect(lastState.state.forensic.export_hash).not.toBeNull();
      expect(lastState.state.link).toBe('live');
      expect(lastState.state.simulated).toBe(true);
    }
  });
});

describe('CallSession — protocol rules independent of any one scenario', () => {
  it('ignores an out-of-state tool call, logs it, and still answers with an error tool.result after the next reply.done', () => {
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const call: CallContext = { session_id: 'sess-x', origin_kind: 'unverified_voip', origin_geo: 'unknown' };
    const session = newSession(clock, call, aai, sent);
    session.start(); // INTAKE: allowed_tools is []

    clock.now = 500;
    aai.emit({ type: 'tool.call', call_id: 'tc1', name: 'freeze_transaction_rail', arguments: { rail_id: 'TREASURY-WIRE' } });

    const entry = session.logs.tools.find((t) => t.id === 'tc1');
    expect(entry).toBeDefined();
    expect(entry?.result).toEqual({ error: 'not_allowed_in_state' });
    expect(entry?.args.ignored).toBe(true);
    expect(aai.sent.some((m) => (m as { type?: string }).type === 'tool.result')).toBe(false);

    clock.now = 600;
    aai.emit({ type: 'reply.done', reply_id: 'r1', status: 'completed' });

    const toolResult = aai.sent.find((m) => (m as { type?: string }).type === 'tool.result') as
      | { type: string; call_id: string; is_error: boolean }
      | undefined;
    expect(toolResult).toBeDefined();
    expect(toolResult?.call_id).toBe('tc1');
    expect(toolResult?.is_error).toBe(true);
  });

  it('flushes on input.speech.started and on an interrupted reply.done', () => {
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const call: CallContext = { session_id: 'sess-y', origin_kind: 'unverified_voip', origin_geo: 'unknown' };
    const session = newSession(clock, call, aai, sent);
    session.start();

    clock.now = 100;
    aai.emit({ type: 'input.speech.started' });
    expect(sent.filter((e) => e.type === 'flush')).toHaveLength(1);

    clock.now = 200;
    aai.emit({ type: 'reply.done', reply_id: 'r', status: 'interrupted' });
    expect(sent.filter((e) => e.type === 'flush')).toHaveLength(2);

    clock.now = 300;
    aai.emit({ type: 'reply.done', reply_id: 'r2', status: 'completed' });
    expect(sent.filter((e) => e.type === 'flush')).toHaveLength(2); // a completed reply never flushes
  });

  it('sends session.update exactly once for an unchanging goal', () => {
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const call: CallContext = { session_id: 'sess-z', origin_kind: 'unverified_voip', origin_geo: 'unknown' };
    const session = newSession(clock, call, aai, sent);

    session.start();
    const updatesAfterStart = aai.sent.filter((m) => (m as { type?: string }).type === 'session.update').length;
    expect(updatesAfterStart).toBe(1);

    // input.speech.stopped changes nothing about the logs or the goal.
    clock.now = 50;
    aai.emit({ type: 'input.speech.stopped' });
    const updatesAfter = aai.sent.filter((m) => (m as { type?: string }).type === 'session.update').length;
    expect(updatesAfter).toBe(1);
  });

  it('ends on session.error and on session.ended, closing the AAI socket', () => {
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const call: CallContext = { session_id: 'sess-w', origin_kind: 'unverified_voip', origin_geo: 'unknown' };
    const session = newSession(clock, call, aai, sent);
    session.start();

    aai.emit({ type: 'session.error', code: 'boom', message: 'nope' });
    expect(sent.at(-1)).toEqual({ type: 'ended', reason: 'aai_error:boom' });
    expect(aai.isClosed).toBe(true);
  });
});
