import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
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

// ---------------------------------------------------------------------------------------
// Founder decision 2026-09-11 10:15 PM, option B. PROVES the server needed NO code change
// for this fix: `runLookupsIfNeeded` (call/session.ts) already reads `output.claimed_
// identity_id` fresh off the engine's own output on every tick, and the ledger already sets
// that to the NEW identity the instant it's claimed (ledger.ts's `currentClaim` returns the
// latest 'identity' claim regardless of kind -- true even before this fix). The only thing
// that ever stopped lookups re-firing for the new identity was rules.ts's row 6 never
// letting `deriveState` reach EVIDENCE/CONSISTENCY_CHECK again once a switch happened;
// `runLookupsIfNeeded` only fires in those two states. This test drives the real
// identity-switch call (c1 verbatim from corpus/identity-switch.json / evaluate.test.ts's
// own Scenario A text; the switch line verbatim from scripts/rehearse/scenarios/
// identity-switch.json's c5; the resolving line verbatim from tonight's live rehearsal,
// scripts/rehearse/reports/2026-09-11T21-56-33-identity-switch.md's c6) through the REAL
// CallSession and proves: (1) the server automatically issues fresh check_sso_context/
// get_request_history/verify_out_of_band calls for 'robert-miller' with NO tool.call AAI
// event from the model anywhere in this test, and (2) the call reaches FREEZE -- not the
// idle-timeout ESCALATE the live rehearsal hit before this fix.
// ---------------------------------------------------------------------------------------
describe('CallSession — identity switch resolves live; server re-runs lookups for the new identity; reaches FREEZE (founder decision 2026-09-11 10:15 PM, option B)', () => {
  it('re-runs all three lookups for robert-miller with no model tool.call, and FREEZEs', () => {
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const call: CallContext = { session_id: 'sess-switch-live', origin_kind: 'registered_device', origin_geo: 'Austin, TX' };
    const session = newSession(clock, call, aai, sent);

    session.start(); // INTAKE

    // c1: Dana's opening claim + full request -- same line evaluate.test.ts's Scenario A uses.
    clock.now = 1000;
    aai.emit({
      type: 'transcript.user',
      item_id: 'c1',
      text: "This is Dana Whitfield, corporate treasury. I need to wire it to Meridian Supply — $84,500, account ending 4471 — moving today instead of Friday, approved in yesterday's close meeting.",
    });

    // Row 4: one challenge required before any readback -- the engine's usual opening
    // TRAP_FACT on the beneficiary (same as the Scenario A live test above).
    expect(session.last?.state).toBe('CHALLENGE');
    clock.now = 1500;
    aai.emit({ type: 'reply.started', reply_id: 'a1' });
    aai.emit({ type: 'transcript.agent', item_id: 'a1', text: session.last!.goal.hint, reply_id: 'a1', interrupted: false });
    clock.now = 2000;
    aai.emit({ type: 'reply.done', reply_id: 'a1', status: 'completed' });
    expect(session.logs.actions.some((a) => a.kind === 'challenge_issued')).toBe(true);

    // c2: the caller catches the trap and states the true beneficiary -- challenge PASSES.
    clock.now = 2500;
    aai.emit({ type: 'transcript.user', item_id: 'c2', text: "No, that's wrong. It's Meridian Supply." });

    // Challenge satisfied -> CONSISTENCY_CHECK/READBACK (no critical field confirmed yet).
    // `runLookupsIfNeeded` also gets its first chance here and resolves Dana's own SSO/
    // history/out-of-band -- proving the mechanism this fix relies on already worked for the
    // FIRST identity; the switch below is what used to break it for a SECOND one.
    expect(session.last?.state).toBe('CONSISTENCY_CHECK');
    expect(session.logs.tools.some((t) => t.args.identity_id === 'dana-whitfield')).toBe(true);

    // The switch (verbatim, scripts/rehearse/scenarios/identity-switch.json c5) -- no agent
    // readback turn in between, matching how the caller actually barged in live tonight.
    clock.now = 8000;
    aai.emit({
      type: 'transcript.user',
      item_id: 'c-switch',
      text: "Actually -- hold on -- this is Robert Miller speaking, I'll take it from here.",
    });
    expect(session.last?.state).toBe('CLAIM');
    expect(session.last?.goal.code).toBe('RE_ELICIT_AFTER_SWITCH');
    expect(session.last?.assurance.no_identity_switch).toBe(false);
    expect(session.last?.request_version).toBe(2);

    // The resolving turn (verbatim, tonight's live rehearsal report, c6): Miller re-states
    // who he is and repeats the SAME request, unchanged. THE FIX under test: before it, this
    // call was pinned at CLAIM/row 6 forever (see the investigation this task was handed).
    clock.now = 12000;
    aai.emit({
      type: 'transcript.user',
      item_id: 'c-reclaim',
      text: "This is Robert Miller. I'm taking this over myself. Release the $84,500 to Meridian Supply now.",
    });

    // Resolved: no longer trapped at CLAIM/row 6 -- and the server has ALREADY re-run all
    // three lookups for 'robert-miller' in this same tick, with no tool.call AAI event from
    // the model anywhere in this test (the model never once calls a tool here, same as
    // Scenario B's own regression above).
    expect(session.last?.state).not.toBe('CLAIM');
    expect(session.last?.assurance.no_identity_switch).toBe(true);
    for (const name of ['check_sso_context', 'get_request_history', 'verify_out_of_band'] as const) {
      const entry = session.logs.tools.find((t) => t.name === name && t.args.identity_id === 'robert-miller');
      expect(entry, `${name} was never re-run for robert-miller`).toBeDefined();
      expect(entry!.args.request_version).toBe(2);
    }

    // Robert Miller's own seed record fails both SSO (Frankfurt vs this call's Austin, TX)
    // and out-of-band (hardcoded no_response) -- rule 8a freezes. This is the FREEZE the live
    // rehearsal (idle_timeout -> ESCALATE, the wrong verdict) could never reach before this
    // fix, because row 6 had no exit.
    expect(session.last?.verdict).toBe('FREEZE');
    expect(session.last?.state).toBe('SEALED');
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

  it('emits a session_config_updated diag event once per goal change, with correct detail fields', () => {
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const call: CallContext = { session_id: 'sess-diag-goal-change', origin_kind: 'unverified_voip', origin_geo: 'unknown' };
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
    const diagesAfterStart = diagEvents.filter((e) => e.kind === 'session_config_updated');
    expect(diagesAfterStart).toHaveLength(1);
    const initialDiag = diagesAfterStart[0]!.detail as {
      goal_code: string;
      keyterms_count: number;
      tools_count: number;
      has_turn_detection: boolean;
    };
    expect(initialDiag.goal_code).toBe('GREET');
    expect(initialDiag.keyterms_count).toBeGreaterThanOrEqual(0);
    expect(typeof initialDiag.tools_count).toBe('number');
    expect(typeof initialDiag.has_turn_detection).toBe('boolean');

    // input.speech.stopped changes nothing about the goal, so no new diag event.
    clock.now = 50;
    aai.emit({ type: 'input.speech.stopped' });
    const diagsAfterNoChange = diagEvents.filter((e) => e.kind === 'session_config_updated');
    expect(diagsAfterNoChange).toHaveLength(1);

    // Now drive through Scenario B to trigger a goal change.
    driveScenarioBThroughA4(session, aai, clock);
    const diagsAfterScenarioB = diagEvents.filter((e) => e.kind === 'session_config_updated');
    expect(diagsAfterScenarioB.length).toBeGreaterThan(1);

    // Every diag event should have all required fields with correct types.
    diagsAfterScenarioB.forEach((diag) => {
      const detail = diag.detail as {
        goal_code: string;
        keyterms_count: number;
        tools_count: number;
        has_turn_detection: boolean;
      };
      expect(typeof detail.goal_code).toBe('string');
      expect(typeof detail.keyterms_count).toBe('number');
      expect(typeof detail.tools_count).toBe('number');
      expect(typeof detail.has_turn_detection).toBe('boolean');
      expect(detail.keyterms_count).toBeGreaterThanOrEqual(0);
      expect(detail.tools_count).toBeGreaterThanOrEqual(0);
    });
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

// ---------------------------------------------------------------------------------------
// Red team item 4 (founder ruling, 2026-09-09): a call that ends by idle timeout, session
// cap, hangup, or a dropped socket while a request has been stated and the verdict is
// still PENDING must not leave no incident, no freeze, no export. Fixed in the ENGINE
// (rules.ts row 15, LAW 3), not the server: end() records a `call_ended` action into the
// logs and re-runs the real engine through the existing terminal-action path -- it never
// stamps a verdict itself. See packages/engine/corpus/abandoned-open-request.json for the
// engine-level proof; these tests prove the server wiring reaches it.
describe('CallSession — end() reaches the engine\'s call-ended row (RT-4)', () => {
  it("idle-timeout end() with a request stated escalates: incident/alert/seal run for real, an export_computed diagnostic lands, and the engine's own verdict (session.last) reads ESCALATE, not PENDING", async () => {
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const call: CallContext = { session_id: 'sess-abandon-1', origin_kind: 'unverified_voip', origin_geo: 'unknown' };
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
    clock.now = 1000;
    aai.emit({ type: 'transcript.user', item_id: 'c1', text: 'This is Robert Miller, I need $1.8 million wired to the escrow account.' });

    // Before ending: a request is on record, no live checks/challenges have run yet, and
    // the engine itself still reads PENDING -- the exact shape row 15 exists for.
    expect(session.last?.verdict).toBe('PENDING');
    expect(session.last?.evidence.some((e) => e.kind === 'request_params')).toBe(true);

    clock.now = 30000;
    session.end('idle_timeout');
    await session.whenIdle();

    // LAW 3: the engine, not the server, decided this -- `session.last` is the real
    // `evaluate()` output computed over the logs (which now include the call_ended action).
    expect(session.last?.verdict).toBe('ESCALATE');

    const toolNames = session.logs.tools.map((t) => t.name);
    expect(toolNames).toContain('open_incident');
    expect(toolNames).toContain('alert_principal');
    expect(toolNames).toContain('seal_evidence_record');
    expect(session.logs.actions.some((a) => a.kind === 'call_ended')).toBe(true);

    expect(diagEvents.some((e) => e.kind === 'export_computed')).toBe(true);

    // 'ended' remains the LAST websocket event, even though ending this call forced a full
    // terminal-action pass first.
    expect(sent.at(-1)).toEqual({ type: 'ended', reason: 'idle_timeout' });
  });

  it('idle-timeout end() with NO request ever stated forces nothing: verdict stays NO_ACTION, no terminal tools run, matching corpus/hangup-mid-check.json\'s no-request shape', async () => {
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const call: CallContext = { session_id: 'sess-abandon-2', origin_kind: 'unverified_voip', origin_geo: 'unknown' };
    const session = newSession(clock, call, aai, sent);

    session.start(); // INTAKE -- nothing said yet
    clock.now = 30000;
    session.end('idle_timeout');
    await session.whenIdle();

    expect(session.last?.verdict).toBe('NO_ACTION');
    expect(session.logs.tools).toHaveLength(0);
    expect(sent.at(-1)).toEqual({ type: 'ended', reason: 'idle_timeout' });
  });

  it('the idle reaper and the per-call cap timer both end a call through CallSession.end() alone (ws/browser.ts), so they inherit this fix with no separate wiring', async () => {
    // White-box check, deliberately: ws/browser.ts's `endCall` (used by both the idle
    // reaper and the cap timer, per its own founder-ruling comment) calls
    // `entry.session.end(reason)` and nothing else -- there is exactly one place a call
    // ever closes, and this test is the one place that fact is pinned down so a future
    // refactor introducing a second ending path would need to touch this assertion too.
    const source = readFileSync(new URL('../src/ws/browser.ts', import.meta.url), 'utf8');
    const endCallCalls = source.match(/entry\.session\.end\(/g) ?? [];
    expect(endCallCalls.length).toBeGreaterThanOrEqual(2); // caller hangup + endCall (reaper/cap)
  });
});

// ---------------------------------------------------------------------------------------
// Bug fix (2026-09-11, PROVEN from scripts/rehearse/reports/2026-09-11T16-35-23-
// scenario-a-dana-legitimate.md): after the engine reached STAGE and SEALED, the server
// never hung up on its own -- the model improvised three off-goal turns for 47 seconds
// before ever saying something close-shaped, and the call sat open until the caller/idle
// timer/cap ended it. `CallSession` now ends itself: a short grace period after the CLOSE
// reply's `reply.done` (so the close line's own audio has time to reach the wire), and a
// 15-second hard cap in case `reply.done` for CLOSE never arrives at all. Both funnel
// through the existing `end()` path.
describe('CallSession — CLOSE hangup (2026-09-11 fix): the server ends the call itself after SEALED', () => {
  /** Replays Scenario A's c1..c5 (the same live-driven path session.test.ts's own Scenario A
   *  describe block above proves reaches STAGE/SEALED) far enough that `session.last.state`
   *  is 'SEALED' and `session.last.goal.code` is 'CLOSE' -- the exact shape this fix reacts
   *  to. Kept local to this describe block (not shared with the Scenario A test above, which
   *  asserts on its own ledger/challenge detail) since here only the terminal shape matters. */
  function driveToSealedStage(session: CallSession, aai: FakeAaiSocket, clock: { now: number }): void {
    clock.now = 1000;
    aai.emit({
      type: 'transcript.user',
      item_id: 'c1',
      text: "This is Dana Whitfield, corporate treasury. I need to wire it to Meridian Supply — $84,500, account ending 4471 — moving today instead of Friday, approved in yesterday's close meeting.",
    });
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
    clock.now = 3000;
    aai.emit({ type: 'reply.started', reply_id: 'a2' });
    aai.emit({ type: 'transcript.agent', item_id: 'a2', text: session.last!.goal.hint, reply_id: 'a2', interrupted: false });
    clock.now = 3500;
    aai.emit({ type: 'reply.done', reply_id: 'a2', status: 'completed' });

    clock.now = 4000;
    aai.emit({ type: 'transcript.user', item_id: 'c3', text: "Yes, that's right." });
    clock.now = 4500;
    aai.emit({ type: 'reply.started', reply_id: 'a3' });
    aai.emit({ type: 'transcript.agent', item_id: 'a3', text: session.last!.goal.hint, reply_id: 'a3', interrupted: false });
    clock.now = 5000;
    aai.emit({ type: 'reply.done', reply_id: 'a3', status: 'completed' });

    clock.now = 5500;
    aai.emit({ type: 'transcript.user', item_id: 'c4', text: 'Yes, correct.' });
    clock.now = 6000;
    aai.emit({ type: 'reply.started', reply_id: 'a4' });
    aai.emit({ type: 'transcript.agent', item_id: 'a4', text: session.last!.goal.hint, reply_id: 'a4', interrupted: false });
    clock.now = 6500;
    aai.emit({ type: 'reply.done', reply_id: 'a4', status: 'completed' });

    clock.now = 7000;
    aai.emit({ type: 'transcript.user', item_id: 'c5', text: "Yes, that's right." });
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reaches SEALED/CLOSE (sanity check the drive helper reproduces the PROVEN bug shape)', () => {
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const call: CallContext = { session_id: 'sess-close-sanity', origin_kind: 'registered_device', origin_geo: 'Austin, TX' };
    const session = newSession(clock, call, aai, sent);
    session.start();
    driveToSealedStage(session, aai, clock);

    expect(session.last?.verdict).toBe('STAGE');
    expect(session.last?.state).toBe('SEALED');
    expect(session.last?.goal.code).toBe('CLOSE');
    expect(session.last?.goal.hint).toMatch(/staged for a second, independent approval/i);
  });

  it('ends the call reason "agent_closed" a short grace period after the CLOSE reply completes', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const call: CallContext = { session_id: 'sess-close-grace', origin_kind: 'registered_device', origin_geo: 'Austin, TX' };
    const session = newSession(clock, call, aai, sent);
    session.start();
    driveToSealedStage(session, aai, clock);
    expect(session.last?.goal.code).toBe('CLOSE');

    // Not yet ended: the CLOSE reply hasn't completed yet.
    expect(sent.some((e) => e.type === 'ended')).toBe(false);

    clock.now = 7500;
    aai.emit({ type: 'reply.started', reply_id: 'a5' });
    aai.emit({ type: 'transcript.agent', item_id: 'a5', text: session.last!.goal.hint, reply_id: 'a5', interrupted: false });
    clock.now = 8000;
    aai.emit({ type: 'reply.done', reply_id: 'a5', status: 'completed' });

    // Still not ended immediately -- the grace period lets the close line's audio flush.
    expect(sent.some((e) => e.type === 'ended')).toBe(false);

    vi.advanceTimersByTime(1499);
    expect(sent.some((e) => e.type === 'ended')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(sent.at(-1)).toEqual({ type: 'ended', reason: 'agent_closed' });

    // The 15s hard cap was cancelled by the grace timer -- advancing well past it must not
    // produce a second 'ended' (end() is idempotent either way, but this proves the hard
    // cap was actually cleared, not just masked by that idempotency).
    const endedCountBefore = sent.filter((e) => e.type === 'ended').length;
    vi.advanceTimersByTime(20_000);
    expect(sent.filter((e) => e.type === 'ended').length).toBe(endedCountBefore);
  });

  it('an INTERRUPTED reply.done for CLOSE still schedules the hang-up -- nothing more is owed once SEALED', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const call: CallContext = { session_id: 'sess-close-interrupt', origin_kind: 'registered_device', origin_geo: 'Austin, TX' };
    const session = newSession(clock, call, aai, sent);
    session.start();
    driveToSealedStage(session, aai, clock);

    clock.now = 7500;
    aai.emit({ type: 'reply.started', reply_id: 'a5' });
    aai.emit({ type: 'transcript.agent', item_id: 'a5', text: 'Your requ', reply_id: 'a5', interrupted: true });
    clock.now = 7700;
    aai.emit({ type: 'reply.done', reply_id: 'a5', status: 'interrupted' });

    vi.advanceTimersByTime(1500);
    expect(sent.at(-1)).toEqual({ type: 'ended', reason: 'agent_closed' });
  });

  it('the hard cap ends the call with reason "close_timeout" if no reply.done for CLOSE ever arrives', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const call: CallContext = { session_id: 'sess-close-hardcap', origin_kind: 'registered_device', origin_geo: 'Austin, TX' };
    const session = newSession(clock, call, aai, sent);
    session.start();
    driveToSealedStage(session, aai, clock);
    expect(session.last?.goal.code).toBe('CLOSE');

    vi.advanceTimersByTime(14_999);
    expect(sent.some((e) => e.type === 'ended')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(sent.at(-1)).toEqual({ type: 'ended', reason: 'close_timeout' });
  });

  // ---------------------------------------------------------------------------------------
  // Fix round 2 (review finding, Important, 2026-09-11): `scheduleCloseIfNeeded` used to key
  // ONLY on `this.last.goal.code === 'CLOSE'`, never on which reply the `reply.done` was
  // actually for. `handleToolCall` (like every AAI event) ticks the engine at the end of
  // `dispatchAaiEvent` -- so a tool.call arriving WHILE an earlier reply is still speaking
  // can tick the engine straight to SEALED/CLOSE mid-reply. When that earlier, unrelated
  // reply's OWN `reply.done` then lands, the old code mistook it for the close line
  // finishing and armed the 1.5s hang-up -- while the close line itself had not been said
  // yet (and might never be, if the grace timer won the race). `closeStaleReplyId` (session
  // .ts) now snapshots whichever reply was in flight the instant CLOSE was rendered, and
  // `scheduleCloseIfNeeded` ignores a `reply.done` for that exact stale id.
  //
  // Drives the race precisely: c1..c4 as `driveToSealedStage` does, then reply.started('a4')
  // for the beneficiary READBACK (goal at that point, still unconfirmed), then a stray
  // mid-reply tool.call while 'a4' is still speaking. The model is never offered any tool in
  // any state (fsm.ts's `allowedTools` is always []), so this is always rejected --
  // `not_allowed_in_state` -- but `handleToolCall` still logs it with a `result.error` set,
  // and `computeEvaluationIncomplete` (compose.ts) treats ANY tool log entry carrying
  // `result.error` as making the evaluation incomplete, regardless of the request. Invariant
  // I4 (rules.ts) then downgrades the tentative PENDING verdict straight to ESCALATE (a
  // request is on record) -- reaching SEALED/CLOSE on exactly this tick, entirely from the
  // tool.call's own `tick()`, precisely the mechanism the review flagged, with 'a4' STILL
  // the unfinished in-flight reply. 'a4' then reports reply.done: this must NOT arm the
  // hang-up. Only once a genuinely NEW reply ('a5') starts and completes does it arm.
  function driveThroughC4AndStartA4(session: CallSession, aai: FakeAaiSocket, clock: { now: number }): void {
    clock.now = 1000;
    aai.emit({
      type: 'transcript.user',
      item_id: 'c1',
      text: "This is Dana Whitfield, corporate treasury. I need to wire it to Meridian Supply — $84,500, account ending 4471 — moving today instead of Friday, approved in yesterday's close meeting.",
    });
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
    clock.now = 3000;
    aai.emit({ type: 'reply.started', reply_id: 'a2' });
    aai.emit({ type: 'transcript.agent', item_id: 'a2', text: session.last!.goal.hint, reply_id: 'a2', interrupted: false });
    clock.now = 3500;
    aai.emit({ type: 'reply.done', reply_id: 'a2', status: 'completed' });

    clock.now = 4000;
    aai.emit({ type: 'transcript.user', item_id: 'c3', text: "Yes, that's right." });
    clock.now = 4500;
    aai.emit({ type: 'reply.started', reply_id: 'a3' });
    aai.emit({ type: 'transcript.agent', item_id: 'a3', text: session.last!.goal.hint, reply_id: 'a3', interrupted: false });
    clock.now = 5000;
    aai.emit({ type: 'reply.done', reply_id: 'a3', status: 'completed' });

    clock.now = 5500;
    aai.emit({ type: 'transcript.user', item_id: 'c4', text: 'Yes, correct.' });
    clock.now = 6000;
    aai.emit({ type: 'reply.started', reply_id: 'a4' });
    aai.emit({ type: 'transcript.agent', item_id: 'a4', text: session.last!.goal.hint, reply_id: 'a4', interrupted: false });
    // Deliberately NO reply.done for 'a4' here -- the reply is still "speaking" when the
    // race below fires.
  }

  it('a mid-reply tick to SEALED/CLOSE does not arm the hang-up on the STALE reply already in flight -- only a reply that started after CLOSE does', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const call: CallContext = { session_id: 'sess-close-race', origin_kind: 'registered_device', origin_geo: 'Austin, TX' };
    const session = newSession(clock, call, aai, sent);
    session.start();
    driveThroughC4AndStartA4(session, aai, clock);
    expect(session.last?.state).toBe('CONSISTENCY_CHECK');
    expect(session.last?.goal.code).toBe('READBACK'); // still speaking 'a4', beneficiary not yet confirmed
    expect(session.last?.verdict).toBe('PENDING');

    // A stray, mid-reply tool.call while 'a4' is STILL speaking (no reply.done for it yet).
    // Rejected (`not_allowed_in_state`, since `allowedTools` is always []), but its own
    // `tick()` -- exactly like a real `handleToolCall` -- reaches SEALED/CLOSE this same
    // tick (see this block's own doc comment for exactly why: computeEvaluationIncomplete
    // treats the rejected call's own logged `result.error` as an incomplete evaluation, and
    // I4 downgrades PENDING-with-a-request straight to ESCALATE).
    clock.now = 6200;
    aai.emit({ type: 'tool.call', call_id: 'stray-1', name: 'check_sso_context', arguments: {} });
    expect(session.last?.verdict).toBe('ESCALATE');
    expect(session.last?.state).toBe('SEALED');
    expect(session.last?.goal.code).toBe('CLOSE');
    expect(sent.some((e) => e.type === 'ended')).toBe(false);

    // 'a4' (the STALE reply, in flight before CLOSE was ever rendered) now reports done.
    // This must NOT arm the grace hang-up.
    clock.now = 6500;
    aai.emit({ type: 'reply.done', reply_id: 'a4', status: 'completed' });
    vi.advanceTimersByTime(1500); // the grace period, if it had (wrongly) armed on 'a4'
    expect(sent.some((e) => e.type === 'ended')).toBe(false); // proves the stale id was rejected, not just delayed

    // A genuinely NEW reply ('a5') -- the actual close line -- starts and completes.
    clock.now = 7000;
    aai.emit({ type: 'reply.started', reply_id: 'a5' });
    aai.emit({ type: 'transcript.agent', item_id: 'a5', text: session.last!.goal.hint, reply_id: 'a5', interrupted: false });
    clock.now = 7500;
    aai.emit({ type: 'reply.done', reply_id: 'a5', status: 'completed' });
    expect(sent.some((e) => e.type === 'ended')).toBe(false); // not yet -- grace period still running

    vi.advanceTimersByTime(1500);
    expect(sent.at(-1)).toEqual({ type: 'ended', reason: 'agent_closed' });
  });

  it('if no genuinely new reply ever starts after the stale reply.done, the 15s hard cap still fires close_timeout', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const call: CallContext = { session_id: 'sess-close-race-hardcap', origin_kind: 'registered_device', origin_geo: 'Austin, TX' };
    const session = newSession(clock, call, aai, sent);
    session.start();
    driveThroughC4AndStartA4(session, aai, clock);

    clock.now = 6200;
    aai.emit({ type: 'tool.call', call_id: 'stray-1', name: 'check_sso_context', arguments: {} });
    expect(session.last?.goal.code).toBe('CLOSE');

    // The stale 'a4' reply.done arrives and is correctly ignored for hang-up purposes...
    clock.now = 6500;
    aai.emit({ type: 'reply.done', reply_id: 'a4', status: 'completed' });

    // ...but no new reply ever starts. The 15s hard cap (armed the instant CLOSE was first
    // rendered, at the tool.call tick above) is the backstop that still ends the call.
    vi.advanceTimersByTime(14_999);
    expect(sent.some((e) => e.type === 'ended')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(sent.at(-1)).toEqual({ type: 'ended', reason: 'close_timeout' });
  });

  // Row 15 (rules.ts) only ever converts a PENDING verdict on call_ended -- an
  // already-terminal STAGE/FREEZE/ESCALATE verdict is untouched (proven at the engine level
  // in packages/engine/test/rules.test.ts's "row 15 never overrides an already-terminal
  // STAGE/ESCALATE/NO_ACTION verdict"). This proves the SERVER-side consequence of that: now
  // that reaching SEALED can itself trigger `end()` (the grace/hard-cap timers above), a
  // call that ends AFTER a terminal verdict is already on record must not re-evaluate to
  // ESCALATE -- `end()` logs one more `call_ended` action and re-runs the real engine, and
  // the verdict it recomputes must still read STAGE.
  it('end() called after SEALED does not re-evaluate the verdict to ESCALATE (row 15 ignores call_ended once terminal)', async () => {
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const call: CallContext = { session_id: 'sess-close-row14', origin_kind: 'registered_device', origin_geo: 'Austin, TX' };
    const session = newSession(clock, call, aai, sent);
    session.start();
    driveToSealedStage(session, aai, clock);
    expect(session.last?.verdict).toBe('STAGE');
    expect(session.last?.state).toBe('SEALED');

    clock.now = 9000;
    session.end('caller_ended'); // e.g. the caller hangs up before the grace timer fires
    await session.whenIdle();

    expect(session.last?.verdict).toBe('STAGE');
    expect(session.last?.reasons).toEqual([]);
    expect(sent.at(-1)).toEqual({ type: 'ended', reason: 'caller_ended' });
  });

  // ---------------------------------------------------------------------------------------
  // reply.create fix (2026-09-13, founder screen recording, session 84ddf47a, Miller fraud
  // scenario): a session.update that only changes system_prompt never makes the agent
  // speak on its own -- the CLOSE line was never spoken, WIRE FROZEN appeared, and the call
  // ended agent_closed with the caller having heard nothing after the holding line. See
  // docs/ASSEMBLYAI_INTEGRATION.md's "VERIFY-AT-BUILD: reply.create schema" section for the
  // quoted AssemblyAI schema this implements against.
  describe('reply.create: the server explicitly asks the agent to speak a goal it must not wait on the caller for', () => {
    it('(a) reply.create is deferred while the stale in-flight reply (phrased under the old goal) is still speaking, sent right after its reply.done, does not end the call on that reply.done, and the call ends only once the reply that follows completes', () => {
      vi.useFakeTimers();
      const clock = { now: 0 };
      const aai = new FakeAaiSocket();
      const sent: ServerEvent[] = [];
      const call: CallContext = { session_id: 'sess-replycreate-race', origin_kind: 'registered_device', origin_geo: 'Austin, TX' };
      const session = newSession(clock, call, aai, sent);
      session.start();
      driveThroughC4AndStartA4(session, aai, clock);
      expect(session.last?.goal.code).toBe('READBACK'); // 'a4' is still speaking, phrased under this goal

      // The stray tool.call ticks the engine straight to SEALED/CLOSE while 'a4' is still
      // in flight (same mechanism the CLOSE-race tests above exercise).
      clock.now = 6200;
      aai.emit({ type: 'tool.call', call_id: 'stray-1', name: 'check_sso_context', arguments: {} });
      expect(session.last?.goal.code).toBe('CLOSE');
      expect(aai.sent.some((m) => (m as { type?: string }).type === 'reply.create')).toBe(false);

      // 'a4' completes: reply.create goes out NOW (its recorded goal, READBACK, differs from
      // the current goal, CLOSE) -- and this reply.done must NOT end the call.
      clock.now = 6500;
      aai.emit({ type: 'reply.done', reply_id: 'a4', status: 'completed' });
      expect(aai.sent.at(-1)).toEqual({ type: 'reply.create' });
      vi.advanceTimersByTime(1500);
      expect(sent.some((e) => e.type === 'ended')).toBe(false);

      // The reply that follows (the actual close line, prompted by our reply.create) is a
      // fresh reply phrased under CLOSE -- completing it is what finally ends the call.
      clock.now = 8100;
      aai.emit({ type: 'reply.started', reply_id: 'a5' });
      aai.emit({ type: 'transcript.agent', item_id: 'a5', text: session.last!.goal.hint, reply_id: 'a5', interrupted: false });
      clock.now = 8600;
      aai.emit({ type: 'reply.done', reply_id: 'a5', status: 'completed' });
      expect(sent.some((e) => e.type === 'ended')).toBe(false); // grace period still running

      vi.advanceTimersByTime(1500);
      expect(sent.at(-1)).toEqual({ type: 'ended', reason: 'agent_closed' });

      // Exactly one reply.create for this whole CLOSE rendering (c).
      expect(aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create')).toHaveLength(1);
    });

    it('(b) sends reply.create immediately, right after the session.update, when no reply is in progress', () => {
      const clock = { now: 0 };
      const aai = new FakeAaiSocket();
      const sent: ServerEvent[] = [];
      const call: CallContext = { session_id: 'sess-replycreate-idle', origin_kind: 'registered_device', origin_geo: 'Austin, TX' };
      const session = newSession(clock, call, aai, sent);
      session.start();
      driveToSealedStage(session, aai, clock);
      expect(session.last?.goal.code).toBe('CLOSE');

      // No reply is ever in progress anywhere in this drive ('a4' already completed at c4,
      // and c5's tick carries the engine all the way through ANNOUNCE_STAGED and straight on
      // to CLOSE, entirely synchronously, before any reply.started fires for either) --
      // reply.create goes out immediately, adjacent to the session.update for the tick's
      // FINAL settled goal (CLOSE -- the intermediate ANNOUNCE_STAGED is coalesced into it,
      // round 2 design).
      const types = aai.sent.map((m) => (m as { type: string }).type);
      const replyCreateIdx = types.indexOf('reply.create');
      expect(replyCreateIdx).toBeGreaterThan(0);
      expect(types[replyCreateIdx - 1]).toBe('session.update');
      // No reply.started ever preceded it -- proof it was not deferred behind an in-flight
      // reply (the only other path that sends one).
      expect(types.slice(0, replyCreateIdx).includes('reply.started')).toBe(false);
    });

    it('(c) the ANNOUNCE_FROZEN -> CLOSE cascade (both settling in one server tick) sends exactly one coalesced reply.create, and the reply that follows it is what ends the call (Critical 3 / Important 5, 2026-09-13 review)', () => {
      vi.useFakeTimers();
      const clock = { now: 0 };
      const aai = new FakeAaiSocket();
      const sent: ServerEvent[] = [];
      const session = newSession(clock, CALL_B, aai, sent);
      session.start();
      // Reaches FREEZE/SEALED entirely from server-driven lookups/terminal actions, with no
      // reply in progress anywhere in the chain (the helper's own final line starts a reply
      // -- 'tools-1' -- only AFTER the chain has already finished). FREEZE -> ANNOUNCE_FROZEN
      // -> CLOSE all settle inside ONE synchronous tick (the PROVEN live bug's own shape) --
      // round 2 design coalesces the intermediate ANNOUNCE_FROZEN into the tick's FINAL goal
      // (CLOSE) and sends exactly one reply.create for it, never one for ANNOUNCE_FROZEN
      // too (CLOSE's own verbatim sentence already carries the outcome; Friday's passing
      // judge-sim runs spoke under CLOSE, never a separate ANNOUNCE_FROZEN utterance).
      driveScenarioBThroughA4(session, aai, clock);
      expect(session.last?.state).toBe('SEALED');
      expect(session.last?.goal.code).toBe('CLOSE');
      expect(aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create')).toHaveLength(1); // (iv)
      expect(sent.some((e) => e.type === 'ended')).toBe(false); // (ii) not ended before 'tools-1' completes

      // Drive 'tools-1' (the reply our one reply.create prompted) to completion. If it were
      // mislabelled (Critical 1's exact bug: labelling from `this.last` instead of what was
      // actually requested), `scheduleCloseIfNeeded` would never arm here and the call would
      // never end -- so this also proves (i), that 'tools-1' was labelled CLOSE, indirectly
      // but conclusively.
      clock.now = 51000;
      aai.emit({ type: 'transcript.agent', item_id: 'a-tools-1', text: session.last!.goal.hint, reply_id: 'tools-1', interrupted: false });
      clock.now = 51500;
      aai.emit({ type: 'reply.done', reply_id: 'tools-1', status: 'completed' });
      expect(sent.some((e) => e.type === 'ended')).toBe(false); // grace period still running

      vi.advanceTimersByTime(1500);
      expect(sent.at(-1)).toEqual({ type: 'ended', reason: 'agent_closed' }); // (iii)
      expect(aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create')).toHaveLength(1); // (iv), re-confirmed
    });

    it("(d) GREET is a real exclusion branch, not a coincidence of nothing else happening yet: zero reply.create before the caller's first turn, one once a genuinely force-spoken goal is reached in the SAME session (Important 5, 2026-09-13 review)", () => {
      const clock = { now: 0 };
      const aai = new FakeAaiSocket();
      const sent: ServerEvent[] = [];
      const call: CallContext = { session_id: 'sess-replycreate-greet', origin_kind: 'registered_device', origin_geo: 'Austin, TX' };
      const session = newSession(clock, call, aai, sent);
      session.start(); // GREET -- `mustForceSpeak(null, 'GREET')` would otherwise be reachable
      // (fromCode null, GREET is not in FORCE_SPEAK_GOALS or HOLDING_GOALS either way) were
      // GREET's own explicit `toCode === 'GREET'` exclusion not there; this pins that a real
      // caller turn never arrives before this assertion, so a false pass from "nothing has
      // happened yet" is ruled out by the second half of this same test.
      expect(session.last?.goal.code).toBe('GREET');
      expect(aai.sent.some((m) => (m as { type?: string }).type === 'reply.create')).toBe(false);

      // Drive the SAME session all the way to a genuinely force-spoken goal (CLOSE) --
      // proving the GREET exclusion is a real branch, not merely "nothing forced happened".
      driveScenarioBThroughA4(session, aai, clock);
      expect(session.last?.goal.code).toBe('CLOSE');
      expect(aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create')).toHaveLength(1);
    });

    // Critical 1 (2026-09-13 review, FAIL on round 1 commit 48a0969): round 1 labelled a
    // reply.started with `this.last.goal.code` UNCONDITIONALLY -- reading whatever the goal
    // had already become by the time that reply started, not what was actually requested
    // when its reply.create was sent. Direct-state construction (same technique the existing
    // ELICIT_MISSING_CRITICAL test above uses) is the only way to pin the exact race: no
    // reachable live drive can force a SEPARATE, later tick to advance the goal further
    // while an earlier reply.create is still awaiting its own reply.started (the default
    // mock always settles a whole cascade inside one synchronous tick -- see test (c)).
    describe('reply.started labels a reply with the goal actually REQUESTED, never a since-advanced this.last (Critical 1, 2026-09-13 review)', () => {
      function internalsOf(session: CallSession) {
        return session as unknown as {
          maybeSendReplyCreateForTick: (goalAtTickStart: string | null) => void;
          replyGoalAtStart: Map<string, string>;
          pendingRequestedGoal: string | null;
          replyCreateAwaitingStart: boolean;
        };
      }

      it('labels the reply with pendingRequestedGoal (ANNOUNCE_FROZEN), not this.last (CLOSE), when this.last advances before that reply.started arrives', () => {
        const clock = { now: 0 };
        const aai = new FakeAaiSocket();
        const sent: ServerEvent[] = [];
        const call: CallContext = { session_id: 'sess-critical1-label', origin_kind: 'registered_device', origin_geo: 'Austin, TX' };
        const session = newSession(clock, call, aai, sent);
        session.start(); // GREET
        const internals = internalsOf(session);

        // Simulate a tick landing on ANNOUNCE_FROZEN with nothing speaking -- sends
        // reply.create immediately for it (this IS that tick's own final goal).
        session.last = { ...session.last!, goal: { code: 'ANNOUNCE_FROZEN', hint: 'x', keyterms: [], turn_detection_hint: 'default' } };
        internals.maybeSendReplyCreateForTick('STALL');
        expect(aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create')).toHaveLength(1);
        expect(internals.pendingRequestedGoal).toBe('ANNOUNCE_FROZEN');
        expect(internals.replyCreateAwaitingStart).toBe(true);

        // Before AssemblyAI's reply.started for THAT outstanding request ever arrives, a
        // SEPARATE, later event advances the engine's current goal further, to CLOSE --
        // the founder's PROVEN race (test (a) above), just isolated to the exact instant
        // that breaks round 1's labeling.
        session.last = { ...session.last!, goal: { code: 'CLOSE', hint: 'y', keyterms: [], turn_detection_hint: 'default' } };

        clock.now = 100;
        aai.emit({ type: 'reply.started', reply_id: 'r1' });
        // THE FIX: labelled from pendingRequestedGoal (what was asked for), not this.last
        // (CLOSE) which round 1 used unconditionally and would fail this assertion.
        expect(internals.replyGoalAtStart.get('r1')).toBe('ANNOUNCE_FROZEN');
        expect(internals.replyCreateAwaitingStart).toBe(false);
        expect(internals.pendingRequestedGoal).toBeNull();
      });
    });

    // Important 4 (2026-09-13 review): fsm.ts's EVIDENCE-under-pressure response returns
    // CONTAIN_NO_DISCLOSURE, not plain CONTAIN -- HOLDING_GOALS must include it too, or a
    // caller pressuring the agent out of disclosure and then being read back a critical
    // field the instant that pressure resolves would never hear the readback question.
    describe('CONTAIN_NO_DISCLOSURE is a holding goal (Important 4, 2026-09-13 review)', () => {
      it('CONTAIN_NO_DISCLOSURE -> READBACK in one server-driven tick sends one reply.create', () => {
        const clock = { now: 0 };
        const aai = new FakeAaiSocket();
        const sent: ServerEvent[] = [];
        const call: CallContext = { session_id: 'sess-contain-no-disclosure', origin_kind: 'registered_device', origin_geo: 'Austin, TX' };
        const session = newSession(clock, call, aai, sent);
        session.start();
        const internals = session as unknown as { maybeSendReplyCreateForTick: (g: string | null) => void };

        // Simulate the tick's FINAL settled goal being READBACK, having started the tick at
        // CONTAIN_NO_DISCLOSURE (the caller's pressure just resolved and a critical field is
        // now ready to be read back).
        session.last = {
          ...session.last!,
          goal: {
            code: 'READBACK',
            hint: 'y',
            keyterms: [],
            turn_detection_hint: 'patient',
            readback: { field: 'amount_usd', value: '84500' },
          },
        };
        internals.maybeSendReplyCreateForTick('CONTAIN_NO_DISCLOSURE');

        expect(aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create')).toHaveLength(1);
      });
    });

    it('records a reply_create_sent diag event and a session_config_updated action entry when it sends one', () => {
      const clock = { now: 0 };
      const aai = new FakeAaiSocket();
      const sent: ServerEvent[] = [];
      const diagEvents: { kind: string; detail: unknown }[] = [];
      const call: CallContext = { session_id: 'sess-replycreate-diag', origin_kind: 'registered_device', origin_geo: 'Austin, TX' };
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
      driveToSealedStage(session, aai, clock);
      expect(session.last?.goal.code).toBe('CLOSE');

      // Round 2 design: at most one send per TICK, for the tick's FINAL settled goal.
      // ANNOUNCE_STAGED and CLOSE both settle within the same tick here (c5's transcript
      // ticks the engine straight through ANNOUNCE_STAGED to CLOSE, synchronously, before
      // any reply.started ever fires) -- so the intermediate ANNOUNCE_STAGED rendering is
      // coalesced into CLOSE and never gets its own reply.create; reason 'tick_end' marks
      // this as the immediate (not-busy) send path, same shape test (b)/(c) exercise.
      const replyCreateDiags = diagEvents.filter((e) => e.kind === 'reply_create_sent');
      expect(replyCreateDiags).toHaveLength(1);
      const detail = replyCreateDiags[0]!.detail as { goal_code: string; reason: string };
      expect(detail.goal_code).toBe('CLOSE');
      expect(detail.reason).toBe('tick_end');

      const actionEntries = session.logs.actions.filter(
        (a) => a.kind === 'session_config_updated' && typeof a.detail === 'string' && a.detail.startsWith('reply_create:'),
      );
      expect(actionEntries.length).toBeGreaterThanOrEqual(1);
    });
  });
});

// Important 2 (review of commit 5930450, 2026-09-13): recordGoalCompletionAction only ever
// logged an action for ASK_CHALLENGE/READBACK -- an ELICIT_MISSING_CRITICAL completion was
// never logged at all, so compose.ts's computeReadbackReaskExhausted (folded to also count
// `elicit_issued`, see engine/test/missing-critical-field.test.ts) had nothing to count for
// a caller who never states a critical field. `recordGoalCompletionAction` is invoked
// directly here (private method, same narrow-precondition technique "rejects garbage tool
// arguments" above uses for `handleToolCall`) so `session.last`'s forced goal survives
// unchanged to the assertion -- going through the public `aai.emit` path instead would tick
// the real engine on the next EngineInput-touching event (transcript.agent/reply.done both
// do) and overwrite the forced goal with whatever the real (much shorter) conversation
// actually evaluates to, before this mechanic ever ran. No reachable live scenario can
// otherwise pin the exact instant this goal is active without a much longer drive, and this
// test's only subject is the logging mechanic itself, not how CONSISTENCY_CHECK is reached.
describe('CallSession — ELICIT_MISSING_CRITICAL goal completion logs an elicit_issued action (Important 2, 2026-09-13)', () => {
  function sessionInternals(session: CallSession) {
    return session as unknown as { recordGoalCompletionAction: (status: string) => void };
  }

  it('logs kind elicit_issued naming the field once the agent\'s reply for the goal completes', () => {
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const call: CallContext = { session_id: 'sess-elicit-live', origin_kind: 'registered_device', origin_geo: 'Austin, TX' };
    const session = newSession(clock, call, aai, sent);
    session.start(); // INTAKE

    session.last = {
      ...session.last!,
      state: 'CONSISTENCY_CHECK',
      goal: {
        code: 'ELICIT_MISSING_CRITICAL',
        hint: 'Which account ending should this go to? Please give me the last four digits.',
        keyterms: [],
        turn_detection_hint: 'default',
        elicit: { field: 'account_last4' },
      },
    };

    expect(session.logs.actions.some((a) => a.kind === 'elicit_issued')).toBe(false);

    clock.now = 1000;
    sessionInternals(session).recordGoalCompletionAction('completed');

    const elicit = session.logs.actions.find((a) => a.kind === 'elicit_issued');
    expect(elicit).toBeDefined();
    expect(elicit?.field).toBe('account_last4');
    expect(elicit?.t_ms).toBe(1000);
    // No claim exists yet to log a value for -- unlike readback_issued, elicit_issued never
    // carries one.
    expect(elicit?.value).toBeUndefined();
  });

  it('logs nothing when the reply is interrupted, not completed', () => {
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const call: CallContext = { session_id: 'sess-elicit-interrupted', origin_kind: 'registered_device', origin_geo: 'Austin, TX' };
    const session = newSession(clock, call, aai, sent);
    session.start();

    session.last = {
      ...session.last!,
      state: 'CONSISTENCY_CHECK',
      goal: {
        code: 'ELICIT_MISSING_CRITICAL',
        hint: 'What is the exact amount for this payment?',
        keyterms: [],
        turn_detection_hint: 'default',
        elicit: { field: 'amount_usd' },
      },
    };

    clock.now = 1000;
    sessionInternals(session).recordGoalCompletionAction('interrupted');

    expect(session.logs.actions.some((a) => a.kind === 'elicit_issued')).toBe(false);
  });
});
