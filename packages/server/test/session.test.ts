import { describe, it, expect, vi } from 'vitest';
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

/** Replays Scenario B's c1..a4 (identity claimed as 'robert-miller', request_version bumped
 *  to 2 by c3's amount contradiction) so `check_sso_context`/`get_request_history`/
 *  `verify_out_of_band` are on the allowlist (EVIDENCE state) afterward -- the shared setup
 *  behind the main replay test and the two fix-round-1 tests that only care about what
 *  happens to ONE tool.call from that point on. */
function driveScenarioBThroughA4(session: CallSession, aai: FakeAaiSocket, clock: { now: number }): void {
  clock.now = 1000;
  aai.emit({ type: 'transcript.user', item_id: 'c1', text: scenarioB.conversation[0]!.text });

  clock.now = 4000;
  aai.emit({ type: 'reply.started', reply_id: 'a1' });
  aai.emit({ type: 'transcript.agent', item_id: 'a1', text: scenarioB.conversation[1]!.text, reply_id: 'a1', interrupted: false });
  aai.emit({ type: 'reply.done', reply_id: 'a1', status: 'completed' });

  clock.now = 8000;
  aai.emit({ type: 'transcript.user', item_id: 'c2', text: scenarioB.conversation[2]!.text });

  clock.now = 12000;
  aai.emit({ type: 'reply.started', reply_id: 'a2' });
  aai.emit({ type: 'transcript.agent', item_id: 'a2', text: scenarioB.conversation[3]!.text, reply_id: 'a2', interrupted: false });
  aai.emit({ type: 'reply.done', reply_id: 'a2', status: 'completed' });

  clock.now = 40000;
  aai.emit({ type: 'transcript.user', item_id: 'c3', text: scenarioB.conversation[4]!.text });

  clock.now = 44000;
  aai.emit({ type: 'reply.started', reply_id: 'a3' });
  aai.emit({ type: 'transcript.agent', item_id: 'a3', text: scenarioB.conversation[5]!.text, reply_id: 'a3', interrupted: true });
  aai.emit({ type: 'reply.done', reply_id: 'a3', status: 'interrupted' });

  clock.now = 48000;
  aai.emit({ type: 'transcript.user', item_id: 'c4', text: scenarioB.conversation[6]!.text });

  clock.now = 50000;
  aai.emit({ type: 'reply.started', reply_id: 'a4' });
  aai.emit({ type: 'transcript.agent', item_id: 'a4', text: scenarioB.conversation[7]!.text, reply_id: 'a4', interrupted: false });
  aai.emit({ type: 'reply.done', reply_id: 'a4', status: 'completed' });

  clock.now = 50500;
  aai.emit({ type: 'reply.started', reply_id: 'tools-1' });
}

describe('CallSession — Scenario B (Robert Miller, fraudulent) replayed as live AAI events', () => {
  it('reproduces the recorded conversation/tools, reaches FREEZE, and countersigns the terminal actions', async () => {
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const session = newSession(clock, CALL_B, aai, sent);

    session.start(); // INTAKE, before anything is said

    // c1..a4 -- identity + the fraudulent request, the counsel/pressure exchange, the
    // amount contradiction, the barge-in, the final "one last check" -- see the helper for
    // line-by-line detail.
    //
    // Bug fix (2026-09-03, the actual subject of this fix): the model never once calls
    // get_request_history/check_sso_context/verify_out_of_band in this whole drive -- no
    // `tool.call` AAI event is emitted for them anywhere below. Before the fix, that meant
    // the call sat in EVIDENCE forever with an empty tools log (the deadlock the founder
    // watched happen live, see session-lookups.test.ts for the dedicated test). Under the
    // fix, the server's own lookup runner resolves all three the instant EVIDENCE is
    // reached, in the SAME tick the amount contradiction (c3) bumps request_version to 2 --
    // so by the time `driveScenarioBThroughA4` returns, the call has already gone all the
    // way to FREEZE and SEALED, matching the corpus's own recorded expectation.
    driveScenarioBThroughA4(session, aai, clock);

    expect(session.last?.state).toBe('SEALED');
    expect(session.last?.verdict).toBe('FREEZE');

    // No tool.result was ever queued for AAI -- there was never an AAI call_id to answer,
    // since these three were server-initiated, not model-initiated.
    expect(aai.sent.some((m) => (m as { type?: string }).type === 'tool.result')).toBe(false);

    // ---- logs reproduce the corpus shapes (modulo generated ids) ----
    // Conversation is an objective input -- what was actually said -- so a live feed of the
    // exact same lines reproduces it exactly. The tool results are what the SAME
    // deterministic mock backend returns for the SAME (identity, request_version) the corpus
    // used, this time computed by the server itself rather than hand-authored.
    expect(session.logs.conversation).toEqual(scenarioB.conversation);

    const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
    const recordedThreeTools = session.logs.tools
      .filter((t) => (['get_request_history', 'check_sso_context', 'verify_out_of_band'] as string[]).includes(t.name))
      .map(({ id: _id, t_ms: _t_ms, ...rest }) => rest)
      .sort(byName);
    const corpusThreeTools = (scenarioB.tools as ToolLogEntry[]).map(({ id: _id, t_ms: _t_ms, ...rest }) => rest).sort(byName);
    expect(recordedThreeTools).toEqual(corpusThreeTools);

    // A model tool.call arriving afterward for one of these -- e.g. a stale/late model
    // response that lost the race with the server's own auto-run -- is rejected (the call is
    // already SEALED, offering nothing) and, thanks to the evidence-layer fix alongside this
    // one, never corrupts the already-recorded evidence: the verdict below is unaffected.
    clock.now = 51000;
    aai.emit({ type: 'tool.call', call_id: 'late-model-call', name: 'check_sso_context', arguments: { identity_id: 'robert-miller' } });
    const lateResult = session.logs.tools.find((t) => t.id === 'late-model-call');
    expect(lateResult?.result).toEqual({ error: 'not_allowed_in_state' });

    // The corpus file's own `challenge_issued` action names the counsel-of-record question
    // specifically -- one legal choice among several the live engine could make; this
    // session's own live goal-following independently chose two different (also legal)
    // SEED_FACT challenges via the same deterministic selectChallenge. Which exact
    // challenges get asked isn't the load-bearing fact here (both are equally valid
    // consequences of the SAME deterministic selection given the SAME session_id/seed); that
    // the live path reaches the SAME verdict and the SAME full reason set as the corpus is.
    const challenges = session.logs.actions.filter((a) => a.kind === 'challenge_issued');
    expect(challenges.length).toBeGreaterThan(0);
    expect(challenges.every((a) => a.spec?.kind === 'SEED_FACT')).toBe(true);

    // ---- terminal actions ran, in the FSM's FREEZE order ----
    const TERMINAL_NAMES = ['freeze_transaction_rail', 'open_incident', 'alert_principal', 'seal_evidence_record'];
    const terminalTools = session.logs.tools.filter((t) => TERMINAL_NAMES.includes(t.name));
    expect(terminalTools.map((t) => t.name)).toEqual(TERMINAL_NAMES);
    expect(terminalTools.every((t) => t.result !== undefined)).toBe(true);

    // ---- the engine's own verdict, matching the corpus's recorded expectation exactly ----
    expect(session.last?.verdict).toBe(scenarioB.expected.verdict);
    expect(session.last?.reasons).toEqual(scenarioB.expected.reasons);
    expect(session.last?.state).toBe('SEALED'); // seal_evidence_record has now run

    // ---- the countersign: re-running evaluate over the frozen logs reproduced FREEZE ----
    // Finding 5 (final review): `whenIdle()` resolves once the export-hash promise actually
    // settles, deterministically -- no more real-clock `setTimeout` guess for
    // `buildEvidenceExport`'s `crypto.subtle.digest` call to have finished by.
    await session.whenIdle();
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

// ---------------------------------------------------------------------------------------
// RT-8-export-race: a fast hang-up while `buildEvidenceExport`'s async crypto.subtle.digest
// work is still pending. Before this fix, `runTerminalActionsIfNeeded`'s `.then` checked
// `this.ended` and returned BEFORE storing `exp.root_hash`/emitting state -- so a caller who
// hangs up right after the terminal tick (but before the hash finishes computing) meant the
// root hash was silently never recorded anywhere: no `exportHash` getter exists, and no
// diagnostics event carried it either. Containment itself (freeze/incident) is unaffected --
// those tool results log synchronously earlier in `runTerminalActionsIfNeeded`, well before
// `buildEvidenceExport` is even called.
describe('CallSession — export race (RT-8-export-race)', () => {
  it('records the computed root_hash on the diagnostics stream even when the caller hangs up while the export is still pending', async () => {
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = new CallSession({
      session_id: CALL_B.session_id,
      seed: MERIDIAN,
      call: CALL_B,
      aai,
      now: () => clock.now,
      onServerEvent: (e) => sent.push(e),
      mock: mockToolResult,
      onDiagnostic: (kind, detail) => diagEvents.push({ kind, detail }),
    });

    session.start();
    driveScenarioBThroughA4(session, aai, clock);
    expect(session.last?.verdict).toBe('FREEZE');

    // Fast hang-up: the export promise (kicked off synchronously inside the terminal tick
    // above) is still pending when `end()` runs -- exactly the race this test targets.
    session.end('caller_ended');

    await session.whenIdle();

    const exportComputed = diagEvents.find((e) => e.kind === 'export_computed');
    expect(exportComputed?.detail).toMatchObject({ root_hash: expect.any(String) });
  });
});

// ---------------------------------------------------------------------------------------
// Regression: 2026-09-03 later that night. THE BUG (founder-observed live call + three
// harness runs, scripts/rehearse/reports/2026-09-03T23-04-42-, T23-32-42- and T23-39-25-
// scenario-a-dana-legitimate.md): the legitimate-caller scenario never reached STAGE -- it
// looped in CONSISTENCY_CHECK until idle timeout. Two compounding engine bugs, both fixed in
// fsm.ts (see its own doc comment on `readbackSentence`): (1) the READBACK goal handed the
// model prose, not an exact sentence, so it improvised past it; (2) independently,
// `goal.readback.value` -- what this session logs verbatim as the `readback_issued`
// AgentAction's `value`, which ledger.ts later re-normalizes to test the caller's reply
// against -- was a DISPLAY string for amount_usd ("$84,500", not `Number()`-parseable) and
// the full cue-phrase quote for account_last4 ("ending 4471", never equal to the bare-digit
// claim "4471"), so those two fields could never be confirmed even by a perfectly cooperative
// caller. This test drives a FULLY COOPERATIVE call -- the caller states the request, the
// agent reads each critical field back, the caller affirms every one -- through the REAL
// `CallSession` (real `recordGoalCompletionAction`, real `runLookupsIfNeeded`, real
// `evaluate`/ledger underneath) and proves the call actually reaches STAGE. On the pre-fix
// code this test fails exactly where the live calls did: stuck in CONSISTENCY_CHECK,
// amount_usd never leaving STATED.
// ---------------------------------------------------------------------------------------
describe('CallSession — Scenario A (Dana, legitimate, fully cooperative) replayed as live AAI events', () => {
  it('passes the opening trap-fact challenge, reads back each critical field, the caller affirms each, and the call reaches STAGE/SEALED', () => {
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const call: CallContext = { session_id: 'sess-a-live', origin_kind: 'registered_device', origin_geo: 'Austin, TX' };
    const session = newSession(clock, call, aai, sent);

    session.start(); // INTAKE

    // c1: identity + the full request (amount, beneficiary, account) in one utterance, word-
    // for-word Scenario A's own line (docs/BRIEF.md §4 / corpus/scenario-a-dana-legitimate.json).
    clock.now = 1000;
    aai.emit({
      type: 'transcript.user',
      item_id: 'c1',
      text: 'This is Dana Whitfield, corporate treasury. I need to wire it to Meridian Supply — $84,500, account ending 4471 — moving today instead of Friday, approved in yesterday\'s close meeting.',
    });

    // Identity + request are both now claimed. Unlike `evaluate.test.ts`'s hand-authored
    // Scenario A (a ONE-SHOT evaluate() over the whole finished conversation, where the
    // context-check tool result already shows this as an exact match to an existing
    // scheduled payment, so no challenge is required at all), a LIVE call evaluates
    // incrementally: at this exact instant no tool has run yet, so the engine doesn't yet
    // know this is a mere amendment -- rule row 4 requires the DEFAULT one challenge before
    // any readback can begin (`runLookupsIfNeeded` itself only fires once state is ALREADY
    // EVIDENCE/CONSISTENCY_CHECK, so it can't run yet either). This is real, correct behavior
    // (BRIEF: even a legitimate caller proves a knowledge fact before critical fields get
    // read back) and exactly what the founder's own harness reports show (the same
    // TRAP_FACT-on-beneficiary challenge, naming "Northgate Partners", at the same point).
    expect(session.last?.state).toBe('CHALLENGE');
    expect(session.last?.goal.code).toBe('ASK_CHALLENGE');
    expect(session.last?.goal.challenge?.kind).toBe('TRAP_FACT');
    expect(session.last?.goal.challenge?.field).toBe('beneficiary');
    expect(session.last?.goal.challenge?.expect).toMatchObject({ trap_value: 'Northgate Partners' });

    // a1: the agent puts the trap to the caller (deliberately wrong beneficiary).
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
    expect(session.logs.actions.some((a) => a.kind === 'challenge_issued')).toBe(true);

    // c2: the caller catches the trap and states the true beneficiary -- word for word the
    // founder's own live call and harness runs (gradeTrapFact PASSes on a reply containing
    // the true claim's value, "meridian supply").
    clock.now = 2500;
    aai.emit({ type: 'transcript.user', item_id: 'c2', text: "No, that's wrong. It's Meridian Supply." });

    // The challenge PASSED (passedChallenges 1 >= need 1), so row 4 no longer blocks; no
    // critical field is confirmed yet, so row 5 fires: CONSISTENCY_CHECK, READBACK on the
    // oldest unconfirmed critical field. All three critical claims share c1's timestamp, so
    // `oldestUnconfirmedCritical`'s tie-break (CRITICAL_FIELDS order) picks amount_usd first,
    // exactly like the corpus's own r1. `runLookupsIfNeeded` also gets its first chance to
    // run in this same tick (state is now CONSISTENCY_CHECK) and resolves SSO/history/OOB.
    expect(session.last?.state).toBe('CONSISTENCY_CHECK');
    expect(session.last?.goal.code).toBe('READBACK');
    expect(session.last?.goal.readback?.field).toBe('amount_usd');
    // The fix's own regression check: the canonical value logged for the ledger, never a
    // "$"/"," display string (see fsm.ts's `readbackSentence` doc comment for why that broke
    // confirmation entirely for this field on the pre-fix code).
    expect(session.last?.goal.readback?.value).toBe('84500');
    // The engine composed a real, speakable confirmation sentence -- not the old prose.
    expect(session.last?.goal.hint).toMatch(/\$84,500.*is that correct\?/i);

    // a2: the agent reads back the amount. The exact wording spoken doesn't affect what gets
    // logged (recordGoalCompletionAction reads the GOAL's own field/value, never the
    // transcript text -- LAW 3, the LLM never writes evidence) -- using the engine's own
    // composed sentence here anyway, for realism.
    clock.now = 3000;
    aai.emit({ type: 'reply.started', reply_id: 'a2' });
    aai.emit({ type: 'transcript.agent', item_id: 'a2', text: session.last!.goal.hint, reply_id: 'a2', interrupted: false });
    clock.now = 3500;
    aai.emit({ type: 'reply.done', reply_id: 'a2', status: 'completed' });

    const readback1 = session.logs.actions.find((a) => a.kind === 'readback_issued' && a.field === 'amount_usd');
    expect(readback1?.value).toBe('84500');

    // c3: the caller affirms the amount.
    clock.now = 4000;
    aai.emit({ type: 'transcript.user', item_id: 'c3', text: "Yes, that's right." });

    // amount_usd is now CONFIRMED; account_last4 becomes the new oldest unconfirmed critical
    // field (this is the exact transition the pre-fix code could never make for this field).
    expect(session.last?.state).toBe('CONSISTENCY_CHECK');
    expect(session.last?.goal.readback?.field).toBe('account_last4');
    expect(session.last?.goal.readback?.value).toBe('4471');

    // a3 + c4: read back and affirm the account.
    clock.now = 4500;
    aai.emit({ type: 'reply.started', reply_id: 'a3' });
    aai.emit({ type: 'transcript.agent', item_id: 'a3', text: session.last!.goal.hint, reply_id: 'a3', interrupted: false });
    clock.now = 5000;
    aai.emit({ type: 'reply.done', reply_id: 'a3', status: 'completed' });
    clock.now = 5500;
    aai.emit({ type: 'transcript.user', item_id: 'c4', text: 'Yes, correct.' });

    expect(session.last?.state).toBe('CONSISTENCY_CHECK');
    expect(session.last?.goal.readback?.field).toBe('beneficiary');
    expect(session.last?.goal.readback?.value).toBe('meridian supply');

    // a4 + c5: read back and affirm the beneficiary -- the last unconfirmed critical field.
    clock.now = 6000;
    aai.emit({ type: 'reply.started', reply_id: 'a4' });
    aai.emit({ type: 'transcript.agent', item_id: 'a4', text: session.last!.goal.hint, reply_id: 'a4', interrupted: false });
    clock.now = 6500;
    aai.emit({ type: 'reply.done', reply_id: 'a4', status: 'completed' });
    clock.now = 7000;
    aai.emit({ type: 'transcript.user', item_id: 'c5', text: "Yes, that's right." });

    // All three critical fields are now CONFIRMED; SSO/history/out-of-band were already
    // resolved by `runLookupsIfNeeded` back when CONSISTENCY_CHECK was first reached (it
    // fires on every tick the state stays EVIDENCE/CONSISTENCY_CHECK) -- so this is the tick
    // that finally clears rule row 5, and with every other gate already clean, reaches STAGE.
    // `runTerminalActionsIfNeeded` then runs stage_payment_for_second_approval/
    // alert_principal/seal_evidence_record synchronously in the same tick, same as Scenario
    // B's FREEZE path reaching SEALED above.
    expect(session.last?.verdict).toBe('STAGE');
    expect(session.last?.state).toBe('SEALED');
    expect(Object.values(session.last!.assurance).every((v) => v === true)).toBe(true);

    const readbackActions = session.logs.actions.filter((a) => a.kind === 'readback_issued');
    expect(readbackActions.map((a) => ({ field: a.field, value: a.value }))).toEqual([
      { field: 'amount_usd', value: '84500' },
      { field: 'account_last4', value: '4471' },
      { field: 'beneficiary', value: 'meridian supply' },
    ]);
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

  it('replaces a spoofed identity_id with the engine\'s own claimed identity before the mock ever sees it', () => {
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const session = newSession(clock, CALL_B, aai, sent);
    session.start();
    driveScenarioBThroughA4(session, aai, clock); // claimed identity is 'robert-miller'

    // Bug fix (2026-09-03): the server's own lookup runner now resolves all three evidence
    // tools (including check_sso_context) the instant EVIDENCE is reached, in the same tick
    // -- by the time `driveScenarioBThroughA4` returns, the call has already gone all the
    // way to FREEZE/SEALED and `allowed_tools` is empty again. This test's own subject is
    // `handleToolCall`'s identity-substitution guard, an orthogonal mechanic to when the
    // lookup itself runs -- so the precondition (check_sso_context genuinely allowed) is
    // forced directly here, same technique the "rejects garbage tool arguments" test above
    // uses for the same reason.
    session.last = { ...session.last!, state: 'EVIDENCE', allowed_tools: ['check_sso_context'] };

    clock.now = 51000;
    aai.emit({
      type: 'tool.call',
      call_id: 'spoof-1',
      name: 'check_sso_context',
      // The LLM (or a compromised one) claims to be checking someone else entirely.
      arguments: { identity_id: 'someone-else-entirely' },
    });

    const entry = session.logs.tools.find((t) => t.id === 'spoof-1');
    expect(entry).toBeDefined();
    // The logged args show what was ACTUALLY sent to the mock -- the engine's claimed
    // identity, not the LLM's -- never the spoofed value.
    expect(entry?.args.identity_id).toBe('robert-miller');
    // Proof it's not just logged but actually used: Robert Miller's real (Frankfurt) SSO
    // context comes back, not an unknown_identity error for "someone-else-entirely".
    expect(entry?.result).toEqual({
      session_active: true,
      geo: 'Frankfurt, DE',
      device: 'MacBook Pro (managed)',
      request_version: 2,
    });
  });

  it('rejects garbage tool arguments before they reach the mock backend, and answers invalid_arguments', () => {
    // freeze_transaction_rail is the only one of our 8 tools with an LLM-reachable
    // non-identity argument (rail_id) -- the three identity-bearing evidence tools always
    // self-heal identity_id via the override proven above (by design: "the LLM never
    // overrides the claimed identity"), so garbage there can never produce invalid_arguments.
    // In live operation freeze_transaction_rail is only ever consumed by the server's own
    // synchronous terminal-action runner the instant a FREEZE verdict is decided (see
    // runTerminalActionsIfNeeded), so an LLM tool.call for it can never actually win that
    // race through the public event path either. `handleToolCall` is invoked directly here
    // (a legitimate, narrow exception) to prove the validate-before-mock rule itself, since
    // no reachable public scenario can exercise a rejection on real tool.call traffic.
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const mockSpy = vi.fn(mockToolResult);
    const call: CallContext = { session_id: 'sess-garbage', origin_kind: 'unverified_voip', origin_geo: 'unknown' };
    const session = new CallSession({
      session_id: call.session_id,
      seed: MERIDIAN,
      call,
      aai,
      now: () => clock.now,
      onServerEvent: (e) => sent.push(e),
      mock: mockSpy,
    });
    session.start();

    // freeze_transaction_rail is only ever on `allowed_tools` transiently, during the exact
    // synchronous instant a FREEZE verdict is decided -- and the server's own terminal-action
    // runner consumes it in that same instant, before any test code (or real LLM) could
    // observe the window and call it. Patching `last.allowed_tools` is the only way to reach
    // handleToolCall's validation step for this tool at all; everything downstream of the
    // allowlist gate is exercised exactly as the real code runs it.
    const sessionInternals = session as unknown as {
      last: { allowed_tools: string[] } | null;
      handleToolCall: (evt: unknown) => void;
    };
    sessionInternals.last = { ...sessionInternals.last, allowed_tools: ['freeze_transaction_rail'] };

    sessionInternals.handleToolCall({
      type: 'tool.call',
      call_id: 'garbage-1',
      name: 'freeze_transaction_rail',
      arguments: { rail_id: 12345 }, // wrong type: schema says string
    });

    const entry = session.logs.tools.find((t) => t.id === 'garbage-1');
    expect(entry).toBeDefined();
    expect(entry?.result).toEqual({ error: 'invalid_arguments', rejected: ['rail_id'] });
    expect(mockSpy).not.toHaveBeenCalled();

    clock.now = 10;
    aai.emit({ type: 'reply.done', reply_id: 'r', status: 'completed' });
    const toolResult = aai.sent.find((m) => (m as { type?: string }).type === 'tool.result') as
      | { call_id: string; is_error: boolean }
      | undefined;
    expect(toolResult?.call_id).toBe('garbage-1');
    expect(toolResult?.is_error).toBe(true);
  });

  it('discards queued tool.results on an interrupted reply.done but keeps the ToolLogEntry (AAI agent-instructions rule)', () => {
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const session = newSession(clock, CALL_B, aai, sent);
    session.start();
    driveScenarioBThroughA4(session, aai, clock);

    // Bug fix (2026-09-03): see the identical note in "replaces a spoofed identity_id"
    // above -- the auto-runner already resolved everything by this point, so the
    // precondition for this test's own subject (the interrupted-reply discard rule) is
    // forced directly.
    session.last = { ...session.last!, state: 'EVIDENCE', allowed_tools: ['check_sso_context'] };

    clock.now = 51000;
    aai.emit({ type: 'tool.call', call_id: 'ti1', name: 'check_sso_context', arguments: { identity_id: 'robert-miller' } });

    clock.now = 51200;
    aai.emit({ type: 'reply.done', reply_id: 'tools-1', status: 'interrupted' });

    // Discarded: no tool.result ever reaches AAI for this call_id.
    expect(aai.sent.some((m) => (m as { type?: string; call_id?: string }).type === 'tool.result')).toBe(false);

    // Kept: the evidence stands -- the ToolLogEntry and its real mock result are untouched,
    // only marked with the discard fact.
    const entry = session.logs.tools.find((t) => t.id === 'ti1');
    expect(entry).toBeDefined();
    expect(entry?.result).toEqual({
      session_active: true,
      geo: 'Frankfurt, DE',
      device: 'MacBook Pro (managed)',
      request_version: 2,
    });
    expect(entry?.args.discarded_on_interrupt).toBe(true);
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

  // Round 3 (S3 re-review): the real adapter (src/aai/session.ts) sets
  // `reason: 'link_lost'` on its own AaiEvent when its bounded resume-on-drop gives up; a
  // genuine AssemblyAI-originated session.ended never carries one. `FakeAaiSocket.emit`
  // lets a test send either shape directly, so both branches are covered without needing a
  // real resume-on-drop scenario here (that's covered end-to-end in aai-session.test.ts).
  it('maps a plain (reason-less) AAI session.ended to the existing aai_ended reason', () => {
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const call: CallContext = { session_id: 'sess-plain-end', origin_kind: 'unverified_voip', origin_geo: 'unknown' };
    const session = newSession(clock, call, aai, sent);
    session.start();

    aai.emit({ type: 'session.ended' });
    expect(sent.at(-1)).toEqual({ type: 'ended', reason: 'aai_ended' });
    expect(aai.isClosed).toBe(true);
  });

  it('maps an AAI session.ended carrying reason "link_lost" (adapter give-up) to that same reason', () => {
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const call: CallContext = { session_id: 'sess-link-lost', origin_kind: 'unverified_voip', origin_geo: 'unknown' };
    const session = newSession(clock, call, aai, sent);
    session.start();

    aai.emit({ type: 'session.ended', reason: 'link_lost' });
    expect(sent.at(-1)).toEqual({ type: 'ended', reason: 'link_lost' });
    expect(aai.isClosed).toBe(true);
  });
});

describe('CallSession — STALL line anti-repeat is call-scoped (fix round 1, finding 1)', () => {
  it('two consecutive picks for the same kind render different lines; the 9th may repeat once alternatives are exhausted', () => {
    // White-box test, deliberately: driving this through a real multi-turn STALL scenario
    // would mean contriving many distinct-but-same-kind PhrasingGoal objects through the
    // real FSM (goalKey is JSON.stringify(goal), so an UNCHANGED STALL goal on consecutive
    // evaluate() calls never even re-fires session.update -- only a goal that differs
    // somehow, e.g. because keyterms grew, would trigger a second render of the same kind).
    // What actually needs proving is narrower: that CallSession's own per-kind `used` state
    // persists and advances across calls to `pickStallLine`, which is exactly what this
    // checks directly. `renderPrompt`'s STALL branch calling whatever `ctx.stalls.pick` it's
    // given is covered separately in prompt.test.ts.
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const call: CallContext = { session_id: 'sess-stall', origin_kind: 'unverified_voip', origin_geo: 'unknown' };
    const session = newSession(clock, call, aai, sent);
    session.start();

    const pick = (kind: 'sso' | 'history' | 'oob' | 'generic'): string =>
      (session as unknown as { pickStallLine(k: typeof kind): string }).pickStallLine(kind);

    const first = pick('oob');
    const second = pick('oob');
    expect(first).not.toBe(second);

    const seen = new Set([first, second]);
    for (let i = 0; i < 6; i++) seen.add(pick('oob')); // picks 3..8
    expect(seen.size).toBe(8); // the oob library has exactly 8 lines -- all 8 got used

    const ninth = pick('oob'); // alternatives exhausted -- repeating (not throwing) is correct
    expect(seen.has(ninth)).toBe(true);

    // A different kind tracks its own independent `used` set.
    const ssoFirst = pick('sso');
    expect(seen.has(ssoFirst)).toBe(false);
  });
});
