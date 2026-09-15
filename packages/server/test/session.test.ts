import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { MERIDIAN, mockToolResult } from '@countersign/engine';
import type { AgentAction, CallContext, ServerEvent, ToolLogEntry } from '@countersign/engine';
import { CallSession } from '../src/call/session.js';
import { FakeAaiSocket } from '../src/aai/fake.js';
import { ENGINE_CLOSE_SENTENCES } from '../src/call/closeMatch.js';
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
 *  happens to ONE tool.call from that point on.
 *
 *  Review fix (2026-09-15, Critical -- recordGoalCompletionAction bookkeeping): the corpus's
 *  own recorded a1 line asks a REAL question (contains "?", satisfies sess-b-1's counsel
 *  challenge) but a2/a4 ("Pulling the Hartwell file now…" / "I can't accept authority as
 *  verification. One last check.") never ask anything, and a3 is interrupted (never logged
 *  either way) -- so under the corrected bookkeeping (recordGoalCompletionAction now only
 *  logs `challenge_issued` for a reply that actually asked), only ONE of Scenario B's own
 *  THREE required challenges (seed.thresholds.max_challenges, MERIDIAN) is ever satisfied by
 *  replaying these exact eight historical lines alone -- row 4 (rules.ts) never releases,
 *  and the call never reaches EVIDENCE/FREEZE at all through this literal replay (PROVEN:
 *  before this fix, `challenge_issued` was logged unconditionally, so a2's silently-unasked
 *  "issue" was exactly the bug the question-reask fix exists to catch and correct).
 *
 *  Two more real-ask turns (`x1`/`x2` below, appended AFTER a4 -- not interleaved with it)
 *  complete the outstanding two challenges: each speaks the engine's OWN current
 *  `goal.challenge.speak` verbatim, exactly what the question-reask fix's own spaced retry
 *  would eventually extract from a real model given the "say exactly this" one-shot
 *  instructions (call/session.ts's `armQuestionReaskTimer`) -- this is what a FULLY-FIXED
 *  live agent actually says today, given the SAME caller input, that the historical
 *  (pre-fix) transcript never captured. Appending them AFTER a4 rather than interleaving
 *  matters: evidence computation (consistency_flag from c3's contradiction, pressure_marker
 *  from c4's threat) is state-independent and already computed from the full conversation
 *  the moment those lines are logged -- row 4 just outranks row 8 (FREEZE) until it
 *  releases -- so completing the challenge requirement only AFTER every caller line has
 *  landed means FREEZE fires with the exact same comprehensive reason set
 *  `scenarioB.expected.reasons` already documents, PROVEN by running this drive end to end. */
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

  // The two additional real asks completing sess-b-2/sess-b-3 -- see the doc comment above.
  // Each reads the engine's OWN current challenge sentence, so this stays correct even if
  // the seed's own knowledge facts or their order ever changes.
  if (session.last?.goal.code === 'ASK_CHALLENGE' && session.last.goal.challenge) {
    clock.now = 50100;
    const sentence1 = session.last.goal.challenge.speak!;
    aai.emit({ type: 'reply.started', reply_id: 'x1' });
    aai.emit({ type: 'transcript.agent', item_id: 'x1', text: sentence1, reply_id: 'x1', interrupted: false });
    aai.emit({ type: 'reply.done', reply_id: 'x1', status: 'completed' });
  }
  if (session.last?.goal.code === 'ASK_CHALLENGE' && session.last.goal.challenge) {
    clock.now = 50200;
    const sentence2 = session.last.goal.challenge.speak!;
    aai.emit({ type: 'reply.started', reply_id: 'x2' });
    aai.emit({ type: 'transcript.agent', item_id: 'x2', text: sentence2, reply_id: 'x2', interrupted: false });
    aai.emit({ type: 'reply.done', reply_id: 'x2', status: 'completed' });
  }

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
    //
    // Review fix (2026-09-15, Critical -- recordGoalCompletionAction bookkeeping): the
    // helper's own doc comment explains why two more real-ask turns (x1/x2) now follow a4 --
    // the historical eight-line corpus alone never completes Scenario B's own three-challenge
    // requirement under the corrected (LAW-4-respecting) bookkeeping. `driveScenarioBThroughA4`
    // still reaches the SAME state/verdict/reasons the corpus documents; it just needs two
    // more turns a fully-fixed live agent would actually speak (and the historical, pre-fix
    // transcript never captured) to get there honestly.
    driveScenarioBThroughA4(session, aai, clock);

    expect(session.last?.state).toBe('SEALED');
    expect(session.last?.verdict).toBe('FREEZE');

    // No tool.result was ever queued for AAI -- there was never an AAI call_id to answer,
    // since these three were server-initiated, not model-initiated.
    expect(aai.sent.some((m) => (m as { type?: string }).type === 'tool.result')).toBe(false);

    // ---- logs reproduce the corpus shapes (modulo generated ids) ----
    // Conversation is an objective input -- what was actually said -- so a live feed of the
    // exact same lines reproduces it exactly, as a PREFIX: the corpus's own eight lines,
    // verbatim, followed by the two additional real-ask turns (x1/x2) the helper's own doc
    // comment explains. The tool results are what the SAME deterministic mock backend
    // returns for the SAME (identity, request_version) the corpus used, this time computed
    // by the server itself rather than hand-authored.
    expect(session.logs.conversation.slice(0, scenarioB.conversation.length)).toEqual(scenarioB.conversation);
    expect(session.logs.conversation).toHaveLength(scenarioB.conversation.length + 2);

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
    // session's own live goal-following independently chose further challenges (the SAME
    // deterministic `selectChallenge`, but now over a longer live conversation than the
    // corpus's own single recorded action reflects -- see the drive helper's own doc comment:
    // two more real-ask turns, x1/x2, complete the three challenges Scenario B's own
    // thresholds require, and by then enough live caller turns have passed that
    // `selectChallenge` picks a LIVE_COMMITMENT before falling back to SEED_FACT, not always
    // the same kind the corpus's one-shot fixture happened to record). Which exact challenges
    // get asked isn't the load-bearing fact here (all are equally valid consequences of the
    // SAME deterministic selection given the SAME session_id/seed and CALLER-controlled
    // conversation); that the live path reaches the SAME verdict and the SAME full reason set
    // as the corpus is -- checked below.
    const challenges = session.logs.actions.filter((a) => a.kind === 'challenge_issued');
    expect(challenges.length).toBeGreaterThanOrEqual(3);

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
  afterEach(() => {
    vi.useRealTimers();
  });

  // Round 4, requirement 9 (founder correction, 2026-09-14): these two tests used to assert
  // that `end('idle_timeout')` closed the socket IMMEDIATELY once row 15 turned the verdict
  // terminal -- that was itself the PROVEN bug (founder observation, live: "single-wrong-
  // answer and hangup-after-request ended idle_timeout with verdict ESCALATE and no
  // goodbye"). Fixed: `end('idle_timeout')` now defers (see `end()`'s own doc comment) and
  // lets the normal CLOSE machinery render and speak the goodbye for whatever verdict row 15
  // just computed, THEN ends -- still with reason `idle_timeout` (not `agent_closed`), via
  // `idleEndReason`. Both tests now use fake timers and drive the goodbye reply through.
  it("idle-timeout end() with a request stated escalates: incident/alert/seal run for real, an export_computed diagnostic lands, the engine's own verdict (session.last) reads ESCALATE (not PENDING), a goodbye is requested and spoken, and the call ends idle_timeout only after the grace period", async () => {
    vi.useFakeTimers();
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
    expect(session.last?.goal.code).toBe('CLOSE');

    const toolNames = session.logs.tools.map((t) => t.name);
    expect(toolNames).toContain('open_incident');
    expect(toolNames).toContain('alert_principal');
    expect(toolNames).toContain('seal_evidence_record');
    expect(session.logs.actions.some((a) => a.kind === 'call_ended')).toBe(true);
    // Exactly ONE call_ended action -- the idle-defer path and the eventual real end() must
    // not each log their own (see `logCallEnded`'s own doc comment).
    expect(session.logs.actions.filter((a) => a.kind === 'call_ended')).toHaveLength(1);

    expect(diagEvents.some((e) => e.kind === 'export_computed')).toBe(true);

    // NOT ended yet -- a goodbye is owed and has just been requested (reply.create), not
    // hung up on silently.
    expect(sent.some((e) => e.type === 'ended')).toBe(false);
    expect(aai.sent.some((m) => (m as { type?: string }).type === 'reply.create')).toBe(true);

    clock.now = 30100;
    aai.emit({ type: 'reply.started', reply_id: 'r1' });
    aai.emit({ type: 'transcript.agent', item_id: 'a1', text: session.last!.goal.hint, reply_id: 'r1', interrupted: false });
    clock.now = 30200;
    aai.emit({ type: 'reply.done', reply_id: 'r1', status: 'completed' });

    expect(sent.some((e) => e.type === 'ended')).toBe(false); // grace period still running
    vi.advanceTimersByTime(1500);
    // 'ended' remains the LAST websocket event, and reads idle_timeout (not agent_closed) --
    // the idle reaper, not the caller or a matched close line, is what closed this call out.
    expect(sent.at(-1)).toEqual({ type: 'ended', reason: 'idle_timeout' });
  });

  it('idle-timeout end() with NO request ever stated forces nothing: verdict stays NO_ACTION, no terminal tools run, the plain "Thank you for calling. Goodbye." line is requested and spoken, and the call ends idle_timeout', async () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const call: CallContext = { session_id: 'sess-abandon-2', origin_kind: 'unverified_voip', origin_geo: 'unknown' };
    const session = newSession(clock, call, aai, sent);

    session.start(); // INTAKE -- nothing said yet
    clock.now = 30000;
    session.end('idle_timeout');
    await session.whenIdle();

    // The ENGINE's own goal stays EXPLAIN_OUT_OF_SCOPE -- fsm.ts's deriveState always sends
    // a NO_ACTION verdict to OUT_OF_SCOPE, never SEALED (see closeSentence()'s own doc
    // comment in fsm.ts). The goodbye is a server-side override (`closeSentenceOverride`,
    // requirement 9) layered on top for the idle-timeout path specifically -- it does not
    // change, and must not be confused with, the engine's own state/goal.
    expect(session.last?.verdict).toBe('NO_ACTION');
    expect(session.last?.goal.code).toBe('EXPLAIN_OUT_OF_SCOPE');
    expect(session.logs.tools).toHaveLength(0);
    expect(sent.some((e) => e.type === 'ended')).toBe(false); // goodbye owed, not hung up on

    // The reply.create the server sent carries the literal NO_ACTION close sentence as a
    // one-shot instruction (never the engine's own EXPLAIN_OUT_OF_SCOPE hint).
    const sentReplyCreate = aai.sent.find((m) => (m as { type?: string }).type === 'reply.create') as
      | { type: string; instructions?: string }
      | undefined;
    expect(sentReplyCreate?.instructions).toContain('Thank you for calling. Goodbye.');

    clock.now = 30100;
    aai.emit({ type: 'reply.started', reply_id: 'r1' });
    aai.emit({ type: 'transcript.agent', item_id: 'a1', text: 'Thank you for calling. Goodbye.', reply_id: 'r1', interrupted: false });
    clock.now = 30200;
    aai.emit({ type: 'reply.done', reply_id: 'r1', status: 'completed' });

    vi.advanceTimersByTime(1500);
    expect(sent.at(-1)).toEqual({ type: 'ended', reason: 'idle_timeout' });
  });

  // ---------------------------------------------------------------------------------------
  // Review fix (2026-09-15, Critical -- FAIL on round 4): the reviewer drove this exact
  // sequence: caller silent past idle -> NO_ACTION override armed (`closeSentenceOverride`,
  // requirement 9) -> caller RESUMES with a real fraudulent request before the stale
  // goodbye is ever confirmed. `currentCloseSentence()` used to check `closeSentenceOverride`
  // FIRST, so even once the engine went on to render its own real CLOSE goal (ESCALATE, from
  // a genuine live request), the server kept speaking and matching against the stale "Thank
  // you for calling. Goodbye." line -- `transcriptMatchesCloseSentence` compared the ESCALATE
  // reply against the wrong sentence, never matched, and the call burned the full 45s budget
  // before ending `close_timeout` despite the correct line having actually been spoken.
  // Fixed: `currentCloseSentence()` now prefers the ENGINE's own CLOSE hint whenever one
  // exists, falling back to the override only when the engine has not (yet) rendered CLOSE;
  // `applyEvaluate` also clears both `closeSentenceOverride` and `idleEndReason` the moment
  // the engine renders a genuinely fresh CLOSE while an override was pending -- that fresh
  // rendering is a completely new, live-driven close, not a continuation of the earlier idle
  // event, so it ends `agent_closed` (or `close_timeout`) like any other organic CLOSE, never
  // `idle_timeout`.
  it('a stale idle-NO_ACTION override yields to the engine\'s own CLOSE once the caller resumes with a real request -- the ESCALATE sentence is spoken and matched, and the call ends agent_closed within budget (review Critical, 2026-09-15)', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const call: CallContext = { session_id: 'sess-idle-override-stale', origin_kind: 'unverified_voip', origin_geo: 'unknown' };
    const session = newSession(clock, call, aai, sent);
    const internals = session as unknown as { closeSentenceOverride: string | null; idleEndReason: string | null };

    session.start(); // GREET, nothing said yet
    clock.now = 30000;
    session.end('idle_timeout');

    expect(session.last?.verdict).toBe('NO_ACTION');
    expect(sent.some((e) => e.type === 'ended')).toBe(false);
    expect(internals.closeSentenceOverride).toBe('Thank you for calling. Goodbye.');
    expect(internals.idleEndReason).toBe('idle_timeout');

    // The caller resumes, mid-goodbye, with a real fraudulent request. `call_ended` is
    // already on record (row 15), so the request landing forces the tentative verdict
    // straight to ESCALATE (never back to PENDING) the instant it's claimed -- the engine
    // renders a genuinely fresh CLOSE goal here, live, not a continuation of the idle event.
    clock.now = 31000;
    aai.emit({
      type: 'transcript.user',
      item_id: 'c1',
      text: 'This is Robert Miller, I need $1.8 million wired to the escrow account.',
    });

    expect(session.last?.verdict).toBe('ESCALATE');
    expect(session.last?.goal.code).toBe('CLOSE');
    expect(session.last?.goal.hint).toMatch(/callback on the registered number/i);
    // The stale override (and the idle attribution it carried) is cleared -- this is a fresh,
    // engine-driven close now, not the earlier idle-triggered one.
    expect(internals.closeSentenceOverride).toBeNull();
    expect(internals.idleEndReason).toBeNull();

    // The reply that follows must be checked against the ESCALATE sentence (this.last.goal
    // .hint), never the stale NO_ACTION line -- proven by it actually ending the call.
    clock.now = 31100;
    aai.emit({ type: 'reply.started', reply_id: 'r1' });
    aai.emit({ type: 'transcript.agent', item_id: 'a1', text: session.last!.goal.hint, reply_id: 'r1', interrupted: false });
    clock.now = 31200;
    aai.emit({ type: 'reply.done', reply_id: 'r1', status: 'completed' });

    expect(sent.some((e) => e.type === 'ended')).toBe(false); // grace period still running
    // Well within the 45s budget (round 4) -- and long before it would matter, since a real
    // match already arrived.
    vi.advanceTimersByTime(1500);
    expect(sent.at(-1)).toEqual({ type: 'ended', reason: 'agent_closed' });
  });

  // ---------------------------------------------------------------------------------------
  // Review fix (2026-09-15, Minor -- FAIL on round 4): `logCallEnded` used to write the ONE
  // `call_ended` action it will ever log, then ignore every later call regardless of reason
  // -- if the idle-deferred goodbye above was still pending when a DIFFERENT real reason
  // (e.g. the per-call cap firing) ended the call for real, the logged evidence permanently
  // read the stale `detail: 'idle_timeout'` even though the call actually ended
  // `cap_reached`. Fixed: a later call with a DIFFERENT reason updates the already-logged
  // action's `detail` in place (still exactly one `call_ended` action -- LAW 4 unaffected,
  // this is bookkeeping/evidence-of-fact, never a verdict) rather than being silently
  // dropped.
  it('a later end() reason overwrites the logged call_ended detail when it differs from the reason the idle-deferred goodbye was logged under (review Minor, 2026-09-15)', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const call: CallContext = { session_id: 'sess-idle-then-cap', origin_kind: 'unverified_voip', origin_geo: 'unknown' };
    const session = newSession(clock, call, aai, sent);

    session.start(); // GREET, nothing said yet
    clock.now = 30000;
    session.end('idle_timeout'); // defers: NO_ACTION goodbye armed, call_ended logged as 'idle_timeout'

    const callEndedBefore = session.logs.actions.filter((a) => a.kind === 'call_ended');
    expect(callEndedBefore).toHaveLength(1);
    expect(callEndedBefore[0]!.detail).toBe('idle_timeout');
    expect(sent.some((e) => e.type === 'ended')).toBe(false);

    // A different, real reason ends the call for good before the goodbye is ever confirmed
    // (e.g. the per-call session cap firing while the idle goodbye was still outstanding).
    clock.now = 30100;
    session.end('cap_reached');

    const callEndedAfter = session.logs.actions.filter((a) => a.kind === 'call_ended');
    // Still exactly ONE call_ended action -- updated in place, never a second entry.
    expect(callEndedAfter).toHaveLength(1);
    expect(callEndedAfter[0]!.detail).toBe('cap_reached');
    expect(sent.at(-1)).toEqual({ type: 'ended', reason: 'cap_reached' });
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

  // reply.create fix, round 3 (2026-09-13): rewritten from "an INTERRUPTED reply.done for
  // CLOSE always schedules the hang-up" -- that was true under the OLD (reply-label) design,
  // which armed on any reply recorded as phrased under CLOSE regardless of what it actually
  // said. The new (transcript-confirmed) design only arms an interrupted reply's hang-up when
  // the close sentence was actually heard in its own accumulated transcript before the
  // barge-in (rule 3) -- a reply cut off before saying anything close-shaped is "not spoken"
  // and gets retried instead (covered by the "close_retry" describe block below), never
  // trusted just because it happened while the goal was CLOSE.
  it('an INTERRUPTED reply.done for CLOSE whose partial transcript already said the close line still schedules the hang-up', () => {
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
    // The caller barges in right as the close line finishes (interrupted status), but the
    // transcript already carries the whole sentence -- rule 3: matched-on-partial still arms.
    aai.emit({ type: 'transcript.agent', item_id: 'a5', text: session.last!.goal.hint, reply_id: 'a5', interrupted: true });
    clock.now = 7700;
    aai.emit({ type: 'reply.done', reply_id: 'a5', status: 'interrupted' });

    vi.advanceTimersByTime(1500);
    expect(sent.at(-1)).toEqual({ type: 'ended', reason: 'agent_closed' });
  });

  // Round 4 (2026-09-14): the retry no longer goes out synchronously off the reply.done --
  // it waits CLOSE_RETRY_MIN_GAP_MS (400ms) first (a real timer, advanced explicitly below).
  it('an INTERRUPTED reply.done for CLOSE that was cut off before saying anything close-shaped is treated as NOT spoken and retried (after the spacing gap), not hung up on', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const call: CallContext = { session_id: 'sess-close-interrupt-nomatch', origin_kind: 'registered_device', origin_geo: 'Austin, TX' };
    const session = newSession(clock, call, aai, sent);
    session.start();
    driveToSealedStage(session, aai, clock);

    clock.now = 7500;
    aai.emit({ type: 'reply.started', reply_id: 'a5' });
    aai.emit({ type: 'transcript.agent', item_id: 'a5', text: 'Your requ', reply_id: 'a5', interrupted: true });
    clock.now = 7700;
    aai.emit({ type: 'reply.done', reply_id: 'a5', status: 'interrupted' });

    // Not sent yet -- waits the spacing gap.
    expect(aai.sent.at(-1)).not.toMatchObject({ instructions: expect.stringContaining('Say exactly this') });
    vi.advanceTimersByTime(400);
    // Not matched -- a retry reply.create goes out instead of arming the hang-up.
    expect(aai.sent.at(-1)).toEqual({ type: 'reply.create', instructions: expect.stringContaining('Say exactly this') });
    vi.advanceTimersByTime(1500);
    expect(sent.some((e) => e.type === 'ended')).toBe(false);
  });

  // Round 4 (2026-09-14, time-budget fix): the hard cap moved from CLOSE_TIMEOUT_MS (15s,
  // paired with a 3-attempt cap) to CLOSE_TOTAL_MS (45s, no attempt cap at all -- retries are
  // spaced by CLOSE_RETRY_MIN_GAP_MS instead of counted). Nothing ever responds here, so the
  // server's own reply.create keeps getting superseded by the 1500ms "lost" timeout and
  // re-sent every ~1900ms (1500 lost + 400 gap) until the 45s absolute budget ends the call --
  // same observable shape as before (close_timeout, no reply.done ever arrives), just at 45s.
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

    vi.advanceTimersByTime(44_999);
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

  // Round 4 (2026-09-14): threshold moved from CLOSE_TIMEOUT_MS (15s) to CLOSE_TOTAL_MS (45s)
  // -- the a4 reply.done here sends the first real CLOSE reply.create (reply_done_goal_diverged),
  // and since nothing ever answers it, the new 1500ms "lost" timeout plus the 400ms retry gap
  // keep re-sending it every ~1900ms (no attempt cap) until the 45s absolute budget fires.
  it('if no genuinely new reply ever starts after the stale reply.done, the 45s hard cap still fires close_timeout', () => {
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

    // ...but no new reply ever starts. The 45s hard cap (armed the instant CLOSE was first
    // rendered, at the tool.call tick above) is the backstop that still ends the call.
    vi.advanceTimersByTime(44_999);
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

    it('(c) the ANNOUNCE_FROZEN -> CLOSE cascade (both settling in one server tick) sends reply.create for CLOSE, and only the reply whose OWN transcript actually says the close line ends the call (Critical 3 / Important 5, 2026-09-13 review; retry behavior updated round 4, 2026-09-14: time-budgeted, not attempt-capped)', () => {
      vi.useFakeTimers();
      const clock = { now: 0 };
      const aai = new FakeAaiSocket();
      const sent: ServerEvent[] = [];
      const session = newSession(clock, CALL_B, aai, sent);
      session.start();
      // Reaches FREEZE/SEALED from server-driven lookups/terminal actions partway through
      // this replay (before `driveScenarioBThroughA4` even reaches its own last two scripted
      // turns, a3/a4 -- recorded from the ORIGINAL, pre-fix corpus). Round 4 design (this
      // task, 2026-09-14): a mismatch no longer sends its retry synchronously -- it arms a
      // CLOSE_RETRY_MIN_GAP_MS (400ms) timer instead, and a second mismatch arriving before
      // that timer fires (a3 then a4, both here, with no `vi.advanceTimersByTime` between
      // them -- this whole drive is synchronous) coalesces into the SAME pending timer rather
      // than stacking a second one. Since 'tools-1' (the reply that actually lands the close
      // line) starts and completes before that single pending retry ever fires, the retry is
      // superseded and cancelled the moment the match is found -- so this drive costs exactly
      // ONE reply.create for the whole call (the original tick_end send), not three: the old
      // "cap reached at 3" framing no longer applies (there is no cap), and coalescing +
      // supersession are what actually decide the count here, not exhaustion.
      //
      // Question-reask fix (2026-09-14, spaced round): a2's own scripted line ("Pulling the
      // Hartwell file now…") never actually asks the SECOND SEED_FACT challenge the engine
      // has already advanced to by the time a2 completes -- `maybeReaskQuestion` DOES arm a
      // reask timer for it (call/session.ts), but that timer needs a real
      // CLOSE_RETRY_MIN_GAP_MS (400ms) of (fake) elapsed time to fire, and nothing in this
      // synchronous drive ever calls `vi.advanceTimersByTime` before c3 pushes the call all
      // the way to FREEZE/SEALED/CLOSE -- so the armed-but-never-fired reask timer contributes
      // zero reply.create here (see `armQuestionReaskTimer`'s own doc comment: a stale-goal
      // check at fire time would have cancelled it anyway, since CLOSE is nowhere near a
      // QUESTION_GOAL). The count below is therefore unaffected by the reask fix entirely.
      driveScenarioBThroughA4(session, aai, clock);
      expect(session.last?.state).toBe('SEALED');
      expect(session.last?.goal.code).toBe('CLOSE');
      expect(aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create')).toHaveLength(1);
      expect(sent.some((e) => e.type === 'ended')).toBe(false); // not ended before 'tools-1' completes

      // Drive 'tools-1' (already speaking, started inside the helper) to completion, this
      // time with a transcript that actually says the close line -- the match arms the
      // hang-up and cancels the still-pending (never fired) a3/a4 retry.
      clock.now = 51000;
      aai.emit({ type: 'transcript.agent', item_id: 'a-tools-1', text: session.last!.goal.hint, reply_id: 'tools-1', interrupted: false });
      clock.now = 51500;
      aai.emit({ type: 'reply.done', reply_id: 'tools-1', status: 'completed' });
      expect(sent.some((e) => e.type === 'ended')).toBe(false); // grace period still running

      // Advancing past the retry gap (400ms) proves the coalesced a3/a4 retry was actually
      // cancelled, not merely not-yet-due: it does not fire a spurious extra send here. It
      // also elapses the (never-refreshed) reask timer armed above -- its own fire-time check
      // finds the goal no longer matches (CLOSE, not the ASK_CHALLENGE rendering it was armed
      // for) and cancels silently, contributing nothing here either.
      vi.advanceTimersByTime(1500);
      expect(sent.at(-1)).toEqual({ type: 'ended', reason: 'agent_closed' });
      expect(aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create')).toHaveLength(1);
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
      // Round 4 (2026-09-14): this test uses REAL timers (no `vi.useFakeTimers()`), and a
      // mismatch's retry now waits behind a CLOSE_RETRY_MIN_GAP_MS (400ms) timer instead of
      // sending synchronously -- see test (c) above for the full mechanism. The question-reask
      // fix's own spaced timer (call/session.ts's `armQuestionReaskTimer`, same 400ms gap) is
      // armed mid-drive for the same reason test (c) above documents (a2's scripted line never
      // asks the engine's second SEED_FACT challenge), but neither timer gets a real 400ms of
      // elapsed wall-clock time within this synchronous drive, so neither ever actually fires.
      // Only the ORIGINAL tick_end send for CLOSE has gone out by the time
      // `driveScenarioBThroughA4` returns. This test's own subject (GREET is a real exclusion,
      // not a false pass from nothing having happened yet) only needs "more than zero", which
      // this still proves regardless of the exact count.
      expect(aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create').length).toBeGreaterThan(0);
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

// reply.create fix, round 3 (2026-09-13, PROVEN live failure on deploy 26 -- see
// scripts/rehearse/reports/2026-09-13T22-23-50-miller-patient.diagnostics.json, and
// closeMatch.ts's own doc comment for the full incident write-up): CLOSE rendered at
// t=47567; the server sent reply.create at 47569 (reason tick_end); reply.started arrived
// at 47573, only 4 ms later -- AssemblyAI's OWN turn-driven reply, composed under the
// PREVIOUS prompt (its transcript was "Please provide the"), not the close line. The OLD
// design (`replyGoalAtStart`/`pendingRequestedGoal`) labelled it CLOSE anyway (a
// reply.create was outstanding) and would have armed the hang-up on it regardless of what
// it actually said -- the closing sentence was never spoken on the real call. Each test
// below is written to fail by construction against that OLD design (a bare
// `this.replyGoalAtStart.get(replyId) === 'CLOSE'` check), and to pass only once the
// hang-up decision is confirmed against the reply's own transcript. Direct state
// construction (same technique the Critical-1 test above uses) isolates the exact
// mechanism without depending on how any particular scenario corpus happens to reach
// FREEZE/CLOSE.
describe('CallSession — reply.create fix, round 3: CLOSE is transcript-confirmed, never reply-labelled (2026-09-13, PROVEN live failure)', () => {
  /** Drives Scenario B's own c1..c3 (real corpus text, real engine) far enough that the
   *  server-driven lookups/terminal actions (triggered synchronously inside c3's own tick --
   *  see test (c) in the describe block above, which proves this exact shape) reach
   *  FREEZE/SEALED/CLOSE with nothing speaking -- `maybeSendReplyCreateForTick` sends the
   *  FIRST real reply.create (reason tick_end) as part of this same drive, so every test
   *  below starts from a state the real engine actually computed, not a mutated stand-in
   *  (direct mutation of `session.last` gets clobbered the moment any later real AAI event
   *  ticks the engine again -- transcript.agent/reply.done both do).
   *
   *  Question-reask fix (2026-09-14): a2's own corpus line is "Pulling the Hartwell file
   *  now…" (scenarioB.conversation[3]) -- no question mark, and the engine has already
   *  advanced to a SECOND SEED_FACT challenge (escrow_institution) by the time a2 completes,
   *  which that line never actually asks. Unlike `driveScenarioBThroughA4` above (whose exact
   *  corpus text is load-bearing for the very first test's `toEqual(scenarioB.conversation)`
   *  check), nothing downstream of THIS helper depends on a2's literal wording -- only on
   *  reaching FREEZE/SEALED/CLOSE with a known, small reply.create count. A trailing question
   *  mark keeps `maybeReaskQuestion` (call/session.ts) from firing here at all (this helper's
   *  whole point is CLOSE mechanics, not the reask fix -- that has its own dedicated describe
   *  block further down), so every count below is unchanged from before that fix existed. */
  function driveToFreezeCloseWithFirstSend(session: CallSession, aai: FakeAaiSocket, clock: { now: number }): void {
    clock.now = 1000;
    aai.emit({ type: 'transcript.user', item_id: 'c1', text: scenarioB.conversation[0]!.text });
    clock.now = 1500;
    aai.emit({ type: 'reply.started', reply_id: 'a1' });
    aai.emit({ type: 'transcript.agent', item_id: 'a1', text: scenarioB.conversation[1]!.text, reply_id: 'a1', interrupted: false });
    clock.now = 2000;
    aai.emit({ type: 'reply.done', reply_id: 'a1', status: 'completed' });

    clock.now = 2500;
    aai.emit({ type: 'transcript.user', item_id: 'c2', text: scenarioB.conversation[2]!.text });
    clock.now = 3000;
    aai.emit({ type: 'reply.started', reply_id: 'a2' });
    aai.emit({ type: 'transcript.agent', item_id: 'a2', text: `${scenarioB.conversation[3]!.text} Which institution holds it?`, reply_id: 'a2', interrupted: false });
    clock.now = 3500;
    aai.emit({ type: 'reply.done', reply_id: 'a2', status: 'completed' });

    clock.now = 4000;
    aai.emit({ type: 'transcript.user', item_id: 'c3', text: scenarioB.conversation[4]!.text });
    // c3's own tick reaches FREEZE/SEALED/CLOSE entirely from server-driven lookups -- nothing
    // is speaking (a2 already completed), so THIS is where the first reply.create for CLOSE
    // (reason tick_end) goes out for real.
  }

  // Round 4 (2026-09-14, time-budget fix): the retry no longer fires synchronously off
  // reply.done -- it waits CLOSE_RETRY_MIN_GAP_MS (400ms) first (a real setTimeout, advanced
  // explicitly below). Everything else about the reproduction is unchanged.
  it('(a) reproduces the PROVEN live sequence: a reply carrying AssemblyAI\'s own unrelated text does NOT end the call -- it costs one close_retry (sent after the 400ms spacing gap), and only the reply that actually says the close line ends it', () => {
    vi.useFakeTimers();
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
    driveToFreezeCloseWithFirstSend(session, aai, clock);
    expect(session.last?.state).toBe('SEALED');
    expect(session.last?.goal.code).toBe('CLOSE');
    expect(aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create')).toHaveLength(1);

    // reply.started arrives implausibly fast, and its transcript is AssemblyAI's OWN
    // turn-driven text, not the close line -- the PROVEN sequence's own "Please provide the".
    clock.now = 4004;
    aai.emit({ type: 'reply.started', reply_id: 'aai-turn-1' });
    aai.emit({ type: 'transcript.agent', item_id: 'x1', text: 'Please provide the', reply_id: 'aai-turn-1', interrupted: false });

    // The caller speaks, then this bogus reply reports interrupted -- the PROVEN sequence's
    // own input.speech.started/reply.done timing (49563/49565, ~2s after reply.started).
    clock.now = 6000;
    aai.emit({ type: 'input.speech.started' });
    clock.now = 6002;
    aai.emit({ type: 'reply.done', reply_id: 'aai-turn-1', status: 'interrupted' });

    // NOT ended: the close line was never heard.
    expect(sent.some((e) => e.type === 'ended')).toBe(false);
    // The retry does not go out immediately -- it waits the spacing gap.
    expect(aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create')).toHaveLength(1);
    vi.advanceTimersByTime(399);
    expect(aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create')).toHaveLength(1);
    vi.advanceTimersByTime(1);
    // A second reply.create went out, reason close_retry, this being CLOSE's 2nd attempt.
    const closeRetryDiags = diagEvents.filter((e) => e.kind === 'reply_create_sent' && (e.detail as { reason: string }).reason === 'close_retry');
    expect(closeRetryDiags).toHaveLength(1);
    expect(closeRetryDiags[0]!.detail).toMatchObject({ goal_code: 'CLOSE', reason: 'close_retry', attempt: 2 });
    expect(aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create')).toHaveLength(2);
    const retryMsg = aai.sent.at(-1) as { type: string; instructions?: string };
    expect(retryMsg.type).toBe('reply.create');
    expect(retryMsg.instructions).toContain(ENGINE_CLOSE_SENTENCES.FREEZE);

    // A fresh reply starts, and THIS one's transcript is the real FREEZE close sentence.
    clock.now = 6100;
    aai.emit({ type: 'reply.started', reply_id: 'aai-turn-2' });
    aai.emit({ type: 'transcript.agent', item_id: 'x2', text: ENGINE_CLOSE_SENTENCES.FREEZE, reply_id: 'aai-turn-2', interrupted: false });
    clock.now = 6200;
    aai.emit({ type: 'reply.done', reply_id: 'aai-turn-2', status: 'completed' });

    expect(sent.some((e) => e.type === 'ended')).toBe(false); // grace period still running
    vi.advanceTimersByTime(1500); // CLOSE_GRACE_MS
    expect(sent.at(-1)).toEqual({ type: 'ended', reason: 'agent_closed' });
    // Still exactly two reply.create for the whole call: the initial one and the one retry.
    expect(aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create')).toHaveLength(2);
  });

  it('(b) happy path: the reply prompted by the first reply.create already says the close line -- ends agent_closed with exactly one reply.create, no retry', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const session = newSession(clock, CALL_B, aai, sent);
    session.start();
    driveToFreezeCloseWithFirstSend(session, aai, clock);
    expect(session.last?.goal.code).toBe('CLOSE');
    expect(aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create')).toHaveLength(1);

    clock.now = 4100;
    aai.emit({ type: 'reply.started', reply_id: 'r1' });
    aai.emit({ type: 'transcript.agent', item_id: 'x1', text: ENGINE_CLOSE_SENTENCES.FREEZE, reply_id: 'r1', interrupted: false });
    clock.now = 4200;
    aai.emit({ type: 'reply.done', reply_id: 'r1', status: 'completed' });

    expect(sent.some((e) => e.type === 'ended')).toBe(false); // grace period still running
    vi.advanceTimersByTime(1500);
    expect(sent.at(-1)).toEqual({ type: 'ended', reason: 'agent_closed' });
    expect(aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create')).toHaveLength(1);
  });

  // Round 4 (2026-09-14, time-budget fix): CLOSE_REPLY_ATTEMPTS (a fixed cap of 3) is gone --
  // retries are now spaced by CLOSE_RETRY_MIN_GAP_MS (400ms) and keep going, uncapped, until
  // either a match is heard or the CLOSE_TOTAL_MS (45s) absolute budget ends the call. This
  // test's old premise ("no fourth ever sent") is exactly backwards under the new design: a
  // fourth (and more) DOES go out once each retry is given its 400ms gap to actually fire.
  it('three non-matching replies do not exhaust anything -- a fourth (and more) reply.create is sent, spaced >=400ms, until the 45s absolute budget ends the call close_timeout', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const session = newSession(clock, CALL_B, aai, sent);
    session.start();
    driveToFreezeCloseWithFirstSend(session, aai, clock); // attempt 1 (tick_end), hard cap armed for real
    const replyCreates = () => aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create');
    expect(replyCreates()).toHaveLength(1);

    clock.now = 4100;
    aai.emit({ type: 'reply.started', reply_id: 'r1' });
    aai.emit({ type: 'transcript.agent', item_id: 'x1', text: 'Please provide the', reply_id: 'r1', interrupted: false });
    clock.now = 4200;
    aai.emit({ type: 'reply.done', reply_id: 'r1', status: 'completed' });
    // Not sent yet -- waits the spacing gap.
    expect(replyCreates()).toHaveLength(1);
    vi.advanceTimersByTime(400);
    expect(replyCreates()).toHaveLength(2); // attempt 2 (close_retry)

    clock.now = 4300;
    aai.emit({ type: 'reply.started', reply_id: 'r2' });
    aai.emit({ type: 'transcript.agent', item_id: 'x2', text: 'One moment please', reply_id: 'r2', interrupted: false });
    clock.now = 4400;
    aai.emit({ type: 'reply.done', reply_id: 'r2', status: 'completed' });
    vi.advanceTimersByTime(400);
    expect(replyCreates()).toHaveLength(3); // attempt 3 (close_retry) -- still no cap

    clock.now = 4500;
    aai.emit({ type: 'reply.started', reply_id: 'r3' });
    aai.emit({ type: 'transcript.agent', item_id: 'x3', text: 'Still not the close line', reply_id: 'r3', interrupted: false });
    clock.now = 4600;
    aai.emit({ type: 'reply.done', reply_id: 'r3', status: 'completed' });
    vi.advanceTimersByTime(400);
    // A FOURTH reply.create goes out -- proof there is no attempt cap anymore.
    expect(replyCreates()).toHaveLength(4);
    expect(sent.some((e) => e.type === 'ended')).toBe(false);

    // Nothing ever answers the outstanding (4th) request again -- the "lost" reply.create
    // timeout (1500ms) and the retry gap (400ms) keep re-sending it roughly every 1900ms,
    // but only the 45s absolute budget (armed the instant CLOSE was first reached) ends the
    // call. 400+400+400 = 1200ms already elapsed above; the remaining 43,800ms closes the gap
    // to exactly CLOSE_TOTAL_MS.
    vi.advanceTimersByTime(43_799);
    expect(sent.some((e) => e.type === 'ended')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(sent.at(-1)).toEqual({ type: 'ended', reason: 'close_timeout' });
  });

  // ---------------------------------------------------------------------------------------
  // Round 4 (2026-09-14, PROVEN live failure -- scripts/rehearse/reports/2026-09-14T13-47-07-
  // miller-patient.diagnostics.json, events 46889-61898): CLOSE rendered at 46893, reply.create
  // #1 sent at 46893; reply.started 46897 was AssemblyAI's OWN turn reply under the PREVIOUS
  // prompt (a 59-char transcript), reply.done completed 48023; close_retry #2 sent 48023 (no
  // gap under round 3's design), reply.started 48027, reply.done completed 48091 with NO
  // transcript at all (an empty reply, 64ms); close_retry #3 sent 48091 (again no gap);
  // reply.started 48094, transcript "This transfer is frozen" then interrupted by caller
  // speech at 51860; CLOSE_REPLY_ATTEMPTS (3) was exhausted, so no further retry was ever
  // sent; AssemblyAI's next turn reply started 56656 and the 15s hard cap (CLOSE_TIMEOUT_MS)
  // ended the call at 61898 before the sentence finished. Net: the mechanism was right but
  // the goodbye was never completed, because a fixed attempt count ran out before AssemblyAI
  // ever produced a reply that actually said it.
  //
  // The fix replaces the attempt-count budget with a TIME budget: CLOSE_TOTAL_MS (45s,
  // absolute, from CLOSE render) is the only thing that can end the call without a match; in
  // between, `attempt` in the diagnostics is an uncapped running counter, and retries are
  // spaced by CLOSE_RETRY_MIN_GAP_MS (400ms, never while a reply is in flight) instead of
  // being counted against a cap. A reply.create that never gets its own reply.started within
  // 1500ms is treated as lost and superseded by a fresh one.
  describe('reply.create fix, round 4: CLOSE retry is time-budgeted, not attempt-capped (2026-09-14, PROVEN live failure)', () => {
    it('(a) keeps retrying past the OLD 15s/3-attempt cap -- spaced >=400ms, never while a reply is in flight, an empty reply does not stop retries (and does not count as an attempt), the call is not ended at the old 15s mark, and only the reply that actually says the close line ends it', () => {
      vi.useFakeTimers();
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
      driveToFreezeCloseWithFirstSend(session, aai, clock);
      expect(session.last?.goal.code).toBe('CLOSE');
      const replyCreates = () => aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create');
      const closeRetryDiags = () => diagEvents.filter((e) => e.kind === 'reply_create_sent' && (e.detail as { reason: string }).reason === 'close_retry');
      expect(replyCreates()).toHaveLength(1); // attempt 1, tick_end

      // AssemblyAI's own turn-driven reply, under the previous prompt -- mismatched, non-empty.
      aai.emit({ type: 'reply.started', reply_id: 'r1' });
      aai.emit({ type: 'transcript.agent', item_id: 'x1', text: 'Please provide the', reply_id: 'r1', interrupted: false });
      aai.emit({ type: 'reply.done', reply_id: 'r1', status: 'completed' });
      // Never sends immediately -- must wait the spacing gap.
      expect(replyCreates()).toHaveLength(1);
      vi.advanceTimersByTime(399);
      expect(replyCreates()).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(replyCreates()).toHaveLength(2); // attempt 2
      expect(closeRetryDiags().at(-1)!.detail).toMatchObject({ attempt: 2 });

      // An empty reply (no transcript.agent at all) -- must not stop retries, and must not
      // itself count as an attempt for diagnostics.
      aai.emit({ type: 'reply.started', reply_id: 'r2' });
      aai.emit({ type: 'reply.done', reply_id: 'r2', status: 'completed' });
      vi.advanceTimersByTime(400);
      expect(replyCreates()).toHaveLength(3);
      expect(closeRetryDiags().at(-1)!.detail).toMatchObject({ attempt: 2 }); // reused, not bumped

      // A partial, interrupted reply that starts toward the close line but is cut off before
      // its content clause -- not matched (closeMatch requires the content clause AND
      // "goodbye"), so it is retried -- and this one DOES count (non-empty).
      aai.emit({ type: 'reply.started', reply_id: 'r3' });
      aai.emit({ type: 'transcript.agent', item_id: 'x3', text: 'This transfer is frozen', reply_id: 'r3', interrupted: true });
      aai.emit({ type: 'input.speech.started' });
      aai.emit({ type: 'reply.done', reply_id: 'r3', status: 'interrupted' });
      vi.advanceTimersByTime(400);
      expect(replyCreates()).toHaveLength(4); // a 4th send -- the old design would have refused this
      expect(closeRetryDiags().at(-1)!.detail).toMatchObject({ attempt: 3 });

      // Nothing else responds for a while -- well past the OLD 15s/3-attempt cap. The call
      // must still be open: only the 45s absolute budget (round 4) can end it without a match.
      vi.advanceTimersByTime(14_000);
      expect(sent.some((e) => e.type === 'ended')).toBe(false);

      // The reply that finally says the full close sentence completes here -- comfortably
      // inside the 45s budget.
      aai.emit({ type: 'reply.started', reply_id: 'r4' });
      aai.emit({ type: 'transcript.agent', item_id: 'x4', text: ENGINE_CLOSE_SENTENCES.FREEZE, reply_id: 'r4', interrupted: false });
      aai.emit({ type: 'reply.done', reply_id: 'r4', status: 'completed' });

      expect(sent.some((e) => e.type === 'ended')).toBe(false); // grace period still running
      vi.advanceTimersByTime(1500);
      expect(sent.at(-1)).toEqual({ type: 'ended', reason: 'agent_closed' });
    });

    it('(b) no matching reply ever arrives -- the call ends close_timeout at the 45s absolute budget, and the number of reply.create sent is bounded by the retry spacing', () => {
      vi.useFakeTimers();
      const clock = { now: 0 };
      const aai = new FakeAaiSocket();
      const sent: ServerEvent[] = [];
      const session = newSession(clock, CALL_B, aai, sent);
      session.start();
      driveToFreezeCloseWithFirstSend(session, aai, clock);
      expect(session.last?.goal.code).toBe('CLOSE');

      vi.advanceTimersByTime(44_999);
      expect(sent.some((e) => e.type === 'ended')).toBe(false);
      vi.advanceTimersByTime(1);
      expect(sent.at(-1)).toEqual({ type: 'ended', reason: 'close_timeout' });

      // Bounded sanity check: even with nothing ever answering, the retry spacing (>=400ms
      // between sends, via the reply-lost timeout + retry gap) means far fewer than one send
      // per 400ms could ever have gone out across the 45s budget.
      const replyCreateCount = aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create').length;
      expect(replyCreateCount).toBeGreaterThan(0);
      expect(replyCreateCount).toBeLessThan(45_000 / 400);
    });

    it('(c) a lost reply.create (no reply.started within 1500ms) is superseded by a fresh one', () => {
      vi.useFakeTimers();
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
      driveToFreezeCloseWithFirstSend(session, aai, clock);
      const internals = session as unknown as { replyCreateAwaitingStart: boolean };
      expect(internals.replyCreateAwaitingStart).toBe(true); // the first (tick_end) send is outstanding

      vi.advanceTimersByTime(1499);
      expect(internals.replyCreateAwaitingStart).toBe(true); // not lost yet
      expect(diagEvents.some((e) => e.kind === 'reply_create_lost')).toBe(false);

      vi.advanceTimersByTime(1); // 1500ms since the send with no reply.started -- lost
      expect(internals.replyCreateAwaitingStart).toBe(false);
      expect(diagEvents.some((e) => e.kind === 'reply_create_lost')).toBe(true);

      // A fresh reply.create supersedes it, after the retry gap.
      const replyCreates = () => aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create');
      expect(replyCreates()).toHaveLength(1);
      vi.advanceTimersByTime(400);
      expect(replyCreates()).toHaveLength(2);

      // The reply.started that eventually arrives (for the superseding request) is accepted
      // normally, and a matching close line still ends the call.
      aai.emit({ type: 'reply.started', reply_id: 'late' });
      aai.emit({ type: 'transcript.agent', item_id: 'x', text: ENGINE_CLOSE_SENTENCES.FREEZE, reply_id: 'late', interrupted: false });
      aai.emit({ type: 'reply.done', reply_id: 'late', status: 'completed' });
      vi.advanceTimersByTime(1500);
      expect(sent.at(-1)).toEqual({ type: 'ended', reason: 'agent_closed' });
    });

    // ---------------------------------------------------------------------------------------
    // Requirement 7 (founder correction, 2026-09-14, three further PROVEN live bundles --
    // scripts/rehearse/reports/2026-09-14T13-45-58-dana-patient, T13-58-08-structuring-two-
    // wires, T13-49-05-identity-switch .diagnostics.json): in all three, the close_retry reply
    // actually SPOKE the full close sentence (Dana: reply.done and 127-char transcript.agent
    // matching the whole STAGE sentence) but NO reply.done ever arrived for it before the
    // (then-15s) hard cap ended the call close_timeout, 2.3-5s after the transcript itself
    // completed. The old design only ever armed the hang-up from reply.done -- a dropped/
    // missing reply.done for an otherwise-successful close meant the goodbye was heard but the
    // call still ended on the wrong path (close_timeout, not agent_closed) or not at all before
    // the cap. Fix: arm the hang-up the INSTANT the accumulated transcript.agent text for the
    // in-flight reply matches the close sentence -- wait for that reply's own reply.done OR
    // CLOSE_DONE_WAIT_MS (4s), whichever comes first, then the unchanged CLOSE_GRACE_MS, then
    // end agent_closed. reply.done remains a valid (and typically faster) path; whichever
    // fires first wins, and the call is never ended twice.
    it('(d) transcript-armed close: a reply.done that never arrives for an otherwise-matching reply does not block the hang-up -- it fires after CLOSE_DONE_WAIT_MS + CLOSE_GRACE_MS from the transcript match', () => {
      vi.useFakeTimers();
      const clock = { now: 0 };
      const aai = new FakeAaiSocket();
      const sent: ServerEvent[] = [];
      const session = newSession(clock, CALL_B, aai, sent);
      session.start();
      driveToFreezeCloseWithFirstSend(session, aai, clock);
      expect(session.last?.goal.code).toBe('CLOSE');

      aai.emit({ type: 'reply.started', reply_id: 'r1' });
      // The transcript arrives (matches the full close sentence) but reply.done for 'r1' is
      // deliberately never emitted -- reproducing the PROVEN bundles above.
      aai.emit({ type: 'transcript.agent', item_id: 'x1', text: ENGINE_CLOSE_SENTENCES.FREEZE, reply_id: 'r1', interrupted: false });

      // Not ended yet -- still inside the CLOSE_DONE_WAIT_MS window.
      expect(sent.some((e) => e.type === 'ended')).toBe(false);
      vi.advanceTimersByTime(3999);
      expect(sent.some((e) => e.type === 'ended')).toBe(false);
      // CLOSE_DONE_WAIT_MS (4000ms) elapses with no reply.done -- the grace timer starts now.
      vi.advanceTimersByTime(1);
      expect(sent.some((e) => e.type === 'ended')).toBe(false);
      vi.advanceTimersByTime(1499);
      expect(sent.some((e) => e.type === 'ended')).toBe(false);
      vi.advanceTimersByTime(1);
      expect(sent.at(-1)).toEqual({ type: 'ended', reason: 'agent_closed' });

      // A very late reply.done for the same reply must not end the call a second time or
      // throw.
      aai.emit({ type: 'reply.done', reply_id: 'r1', status: 'completed' });
      expect(sent.filter((e) => e.type === 'ended')).toHaveLength(1);
    });

    it('(e) transcript-armed close: reply.done arriving before CLOSE_DONE_WAIT_MS elapses wins the race -- the grace period starts at reply.done, not 4s later', () => {
      vi.useFakeTimers();
      const clock = { now: 0 };
      const aai = new FakeAaiSocket();
      const sent: ServerEvent[] = [];
      const session = newSession(clock, CALL_B, aai, sent);
      session.start();
      driveToFreezeCloseWithFirstSend(session, aai, clock);
      expect(session.last?.goal.code).toBe('CLOSE');

      aai.emit({ type: 'reply.started', reply_id: 'r1' });
      aai.emit({ type: 'transcript.agent', item_id: 'x1', text: ENGINE_CLOSE_SENTENCES.FREEZE, reply_id: 'r1', interrupted: false });
      vi.advanceTimersByTime(500); // well inside the 4s CLOSE_DONE_WAIT_MS window
      aai.emit({ type: 'reply.done', reply_id: 'r1', status: 'completed' });

      // Grace period starts NOW (from reply.done), not 4s after the transcript match.
      expect(sent.some((e) => e.type === 'ended')).toBe(false);
      vi.advanceTimersByTime(1499);
      expect(sent.some((e) => e.type === 'ended')).toBe(false);
      vi.advanceTimersByTime(1);
      expect(sent.at(-1)).toEqual({ type: 'ended', reason: 'agent_closed' });
      // Ended well before the 4s CLOSE_DONE_WAIT_MS + grace would have elapsed (500+1+1500 <<
      // 4000+1500), proving reply.done -- not the timeout -- decided the timing.
      expect(sent.filter((e) => e.type === 'ended')).toHaveLength(1);
    });
  });
});

// Round 5 (2026-09-14, PROVEN live: scripts/rehearse/reports/2026-09-13T22-57-34-miller-
// patient.md + its .diagnostics.json): after the agent finished speaking the full close
// sentence at 46135ms, a NEW reply started ("(interrupted) Checking the transaction history.
// Please hold.") and was cut off mid-word by the scheduled hang-up -- a judge hears the
// goodbye, then the start of a holding line. Once the goodbye is transcript-confirmed, no
// further reply.create may go out, and any reply.started arriving after confirmation must
// have its audio suppressed rather than relayed to the browser -- the goodbye reply's own
// remaining frames are the one exception.
describe('CallSession — post-goodbye reply suppression (round 5, 2026-09-14, PROVEN live: 2026-09-13T22-57-34-miller-patient)', () => {
  /** Same shape as the round-3 describe block's own helper above -- drives Scenario B's
   *  c1..c3 far enough that server-driven lookups/terminal actions reach FREEZE/SEALED/CLOSE
   *  with nothing speaking, so `maybeSendReplyCreateForTick` sends the first real
   *  `reply.create` (reason tick_end) as part of the same drive.
   *
   *  Question-reask + recordGoalCompletionAction fixes (2026-09-14/15): same reasoning as
   *  the round-3 describe block's own identical helper above -- a2's real corpus line never
   *  asks anything, and nothing downstream of THIS helper depends on its literal wording, so
   *  a trailing question mark keeps both fixes from ever firing here (this helper's whole
   *  point is post-goodbye suppression mechanics, not the reask/bookkeeping fixes, which each
   *  have their own dedicated describe blocks elsewhere). */
  function driveToFreezeCloseWithFirstSend(session: CallSession, aai: FakeAaiSocket, clock: { now: number }): void {
    clock.now = 1000;
    aai.emit({ type: 'transcript.user', item_id: 'c1', text: scenarioB.conversation[0]!.text });
    clock.now = 1500;
    aai.emit({ type: 'reply.started', reply_id: 'a1' });
    aai.emit({ type: 'transcript.agent', item_id: 'a1', text: scenarioB.conversation[1]!.text, reply_id: 'a1', interrupted: false });
    clock.now = 2000;
    aai.emit({ type: 'reply.done', reply_id: 'a1', status: 'completed' });

    clock.now = 2500;
    aai.emit({ type: 'transcript.user', item_id: 'c2', text: scenarioB.conversation[2]!.text });
    clock.now = 3000;
    aai.emit({ type: 'reply.started', reply_id: 'a2' });
    aai.emit({ type: 'transcript.agent', item_id: 'a2', text: `${scenarioB.conversation[3]!.text} Which institution holds it?`, reply_id: 'a2', interrupted: false });
    clock.now = 3500;
    aai.emit({ type: 'reply.done', reply_id: 'a2', status: 'completed' });

    clock.now = 4000;
    aai.emit({ type: 'transcript.user', item_id: 'c3', text: scenarioB.conversation[4]!.text });
  }

  it('(a) a NEW reply.started after the goodbye is transcript-confirmed has its audio frames dropped, logs post_goodbye_reply_suppressed once, and the call still ends agent_closed on the unchanged schedule', () => {
    vi.useFakeTimers();
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
    driveToFreezeCloseWithFirstSend(session, aai, clock);
    expect(session.last?.goal.code).toBe('CLOSE');

    // The goodbye is spoken and transcript-confirmed mid-stream (maybeArmCloseOnTranscript).
    aai.emit({ type: 'reply.started', reply_id: 'r1' });
    aai.emit({ type: 'transcript.agent', item_id: 'x1', text: ENGINE_CLOSE_SENTENCES.FREEZE, reply_id: 'r1', interrupted: false });
    aai.emit({ type: 'reply.done', reply_id: 'r1', status: 'completed' });

    const audioFramesSent = () => sent.filter((e) => e.type === 'audio').length;
    const framesBefore = audioFramesSent();

    // A NEW reply starts AFTER confirmation -- AssemblyAI's own turn-driven follow-up (the
    // PROVEN "(interrupted) Checking the transaction history. Please hold." line) -- and
    // streams audio frames.
    aai.emit({ type: 'reply.started', reply_id: 'r2' });
    aai.emit({ type: 'reply.audio', data: 'AAAA' });
    aai.emit({ type: 'reply.audio', data: 'BBBB' });

    // Not one frame of the post-goodbye reply reaches the browser.
    expect(audioFramesSent()).toBe(framesBefore);
    expect(sent.some((e) => e.type === 'audio' && (e.data === 'AAAA' || e.data === 'BBBB'))).toBe(false);

    // Exactly one suppression diagnostic, logged at reply.started (not once per frame).
    const suppressed = diagEvents.filter((e) => e.kind === 'post_goodbye_reply_suppressed');
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0]!.detail).toEqual({ reply_id: 'r2' });

    // The hang-up still fires on schedule (CLOSE_GRACE_MS after the confirmed reply's own
    // reply.done, unaffected by whatever AssemblyAI does afterward).
    expect(sent.some((e) => e.type === 'ended')).toBe(false);
    vi.advanceTimersByTime(1500);
    expect(sent.at(-1)).toEqual({ type: 'ended', reason: 'agent_closed' });
  });

  it('(b) the goodbye reply\'s OWN remaining audio frames, arriving after its transcript already matched, are still forwarded', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const session = newSession(clock, CALL_B, aai, sent);
    session.start();
    driveToFreezeCloseWithFirstSend(session, aai, clock);
    expect(session.last?.goal.code).toBe('CLOSE');

    aai.emit({ type: 'reply.started', reply_id: 'r1' });
    // A frame BEFORE the transcript match -- ordinary forwarding, sanity baseline.
    aai.emit({ type: 'reply.audio', data: 'pre-match' });
    expect(sent.some((e) => e.type === 'audio' && e.data === 'pre-match')).toBe(true);

    // The transcript now matches the full close sentence -- confirms the goodbye mid-stream.
    aai.emit({ type: 'transcript.agent', item_id: 'x1', text: ENGINE_CLOSE_SENTENCES.FREEZE, reply_id: 'r1', interrupted: false });

    // MORE frames for the SAME reply id, arriving after confirmation -- these are the tail of
    // the goodbye itself finishing its own flush to the wire, not a new unrelated reply, and
    // must still reach the browser.
    aai.emit({ type: 'reply.audio', data: 'post-match-same-reply' });
    expect(sent.some((e) => e.type === 'audio' && e.data === 'post-match-same-reply')).toBe(true);

    aai.emit({ type: 'reply.done', reply_id: 'r1', status: 'completed' });
    vi.advanceTimersByTime(1500);
    expect(sent.at(-1)).toEqual({ type: 'ended', reason: 'agent_closed' });
  });

  it('(c) no reply.create is ever sent again once the goodbye is confirmed, even when something would otherwise force-speak a re-rendered goal', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const session = newSession(clock, CALL_B, aai, sent);
    session.start();
    driveToFreezeCloseWithFirstSend(session, aai, clock);
    expect(session.last?.goal.code).toBe('CLOSE');

    aai.emit({ type: 'reply.started', reply_id: 'r1' });
    aai.emit({ type: 'transcript.agent', item_id: 'x1', text: ENGINE_CLOSE_SENTENCES.FREEZE, reply_id: 'r1', interrupted: false });
    aai.emit({ type: 'reply.done', reply_id: 'r1', status: 'completed' });

    const replyCreateCountBefore = aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create').length;
    expect(replyCreateCountBefore).toBeGreaterThan(0); // the original tick_end send, at minimum

    // Directly exercise the single choke point every caller funnels through (force-speak,
    // close_retry, the lost-reply-create recovery) -- "even if the goal re-renders" means
    // even a caller that still believes something must be spoken must not get through.
    const internals = session as unknown as {
      sendReplyCreate: (goalCode: string, reason: string, instructions?: string) => void;
      goodbyeConfirmed: boolean;
    };
    expect(internals.goodbyeConfirmed).toBe(true);
    internals.sendReplyCreate('CLOSE', 'close_retry');
    internals.sendReplyCreate('ANNOUNCE_FROZEN', 'tick_end');

    expect(aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create')).toHaveLength(replyCreateCountBefore);

    // Advancing well past the close grace period sends nothing new and ends the call normally.
    vi.advanceTimersByTime(10_000);
    expect(aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create')).toHaveLength(replyCreateCountBefore);
    expect(sent.at(-1)).toEqual({ type: 'ended', reason: 'agent_closed' });
  });

  // Review fix (2026-09-14, Important, round 5 re-review): a suppressed reply's transcript
  // was still being pushed to `logs.conversation` as a spoken agent utterance, even though
  // its audio was dropped and the caller never heard it -- the evidence record must not say
  // something was said that was not heard. PROVEN shape: scripts/rehearse/reports/2026-09-13
  // T22-57-34-miller-patient.md's own stray reply, "(interrupted) Checking the transaction
  // history. Please hold."
  it('(d) a post-goodbye reply\'s transcript is NOT logged to conversation, is NOT fed to the engine, and logs post_goodbye_transcript_dropped {reply_id, length} once instead -- the call still ends agent_closed on the unchanged schedule', () => {
    vi.useFakeTimers();
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
    driveToFreezeCloseWithFirstSend(session, aai, clock);
    expect(session.last?.goal.code).toBe('CLOSE');

    aai.emit({ type: 'reply.started', reply_id: 'r1' });
    aai.emit({ type: 'transcript.agent', item_id: 'x1', text: ENGINE_CLOSE_SENTENCES.FREEZE, reply_id: 'r1', interrupted: false });
    aai.emit({ type: 'reply.done', reply_id: 'r1', status: 'completed' });

    const conversationLengthBefore = session.logs.conversation.length;
    const strayText = '(interrupted) Checking the transaction history. Please hold.';

    // The exact PROVEN stray-reply shape: a new reply, its own transcript, then cut off.
    aai.emit({ type: 'reply.started', reply_id: 'r2' });
    aai.emit({ type: 'transcript.agent', item_id: 'x2', text: strayText, reply_id: 'r2', interrupted: true });
    aai.emit({ type: 'reply.done', reply_id: 'r2', status: 'interrupted' });

    // Not logged as a spoken agent utterance -- the caller never heard it.
    expect(session.logs.conversation).toHaveLength(conversationLengthBefore);
    expect(session.logs.conversation.some((u) => u.text === strayText)).toBe(false);

    // No ordinary `transcript` diag for this dropped text (would otherwise record its length
    // as agent speech) -- exactly one drop diagnostic instead, naming the reply id and length,
    // never the text (LAW 4).
    const dropped = diagEvents.filter((e) => e.kind === 'post_goodbye_transcript_dropped');
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.detail).toEqual({ reply_id: 'r2', length: strayText.length });

    // The hang-up still fires on the unchanged schedule.
    expect(sent.some((e) => e.type === 'ended')).toBe(false);
    vi.advanceTimersByTime(1500);
    expect(sent.at(-1)).toEqual({ type: 'ended', reason: 'agent_closed' });
  });

  it('(e) negative: the confirmed goodbye reply\'s OWN transcript IS logged to conversation normally', () => {
    vi.useFakeTimers();
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
    driveToFreezeCloseWithFirstSend(session, aai, clock);
    expect(session.last?.goal.code).toBe('CLOSE');

    const conversationLengthBefore = session.logs.conversation.length;

    aai.emit({ type: 'reply.started', reply_id: 'r1' });
    aai.emit({ type: 'transcript.agent', item_id: 'x1', text: ENGINE_CLOSE_SENTENCES.FREEZE, reply_id: 'r1', interrupted: false });

    expect(session.logs.conversation).toHaveLength(conversationLengthBefore + 1);
    expect(session.logs.conversation.some((u) => u.id === 'x1' && u.text === ENGINE_CLOSE_SENTENCES.FREEZE)).toBe(true);
    expect(diagEvents.some((e) => e.kind === 'post_goodbye_transcript_dropped')).toBe(false);

    aai.emit({ type: 'reply.done', reply_id: 'r1', status: 'completed' });
    vi.advanceTimersByTime(1500);
    expect(sent.at(-1)).toEqual({ type: 'ended', reason: 'agent_closed' });
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
// Review fix (2026-09-15, Critical): `recordGoalCompletionAction` now takes the completed
// reply's own id too (`replyId`), so it can look up that reply's accumulated transcript
// (`replyTranscripts`) and check -- via questionMatch.ts's `transcriptAsksQuestion`, the SAME
// matcher `maybeReaskQuestion` uses -- whether the reply actually asked the goal's own
// question before logging anything at all. Both tests below now also seed
// `replyTranscripts` for the reply id they pass, matching what the real `transcript.agent`
// handler would already have populated by the time a real `reply.done` fires.
describe('CallSession — ELICIT_MISSING_CRITICAL goal completion logs an elicit_issued action (Important 2, 2026-09-13)', () => {
  function sessionInternals(session: CallSession) {
    return session as unknown as {
      recordGoalCompletionAction: (replyId: string, status: string) => void;
      replyTranscripts: Map<string, string>;
    };
  }

  it('logs kind elicit_issued naming the field once the agent\'s reply for the goal completes, but only when that reply actually asked it', () => {
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

    const internals = sessionInternals(session);

    // A reply that never actually asked the question logs nothing (review fix) -- LAW 4
    // spirit: the record must not claim a question was put to the caller that never was.
    internals.replyTranscripts.set('r0', 'One moment, checking that.');
    clock.now = 500;
    internals.recordGoalCompletionAction('r0', 'completed');
    expect(session.logs.actions.some((a) => a.kind === 'elicit_issued')).toBe(false);

    // A reply that DOES ask it (here, verbatim -- the goal's own hint) logs the action.
    internals.replyTranscripts.set('r1', 'Which account ending should this go to? Please give me the last four digits.');
    clock.now = 1000;
    internals.recordGoalCompletionAction('r1', 'completed');

    const elicit = session.logs.actions.find((a) => a.kind === 'elicit_issued');
    expect(elicit).toBeDefined();
    expect(elicit?.field).toBe('account_last4');
    expect(elicit?.t_ms).toBe(1000);
    // No claim exists yet to log a value for -- unlike readback_issued, elicit_issued never
    // carries one.
    expect(elicit?.value).toBeUndefined();
  });

  it('logs nothing when the reply is interrupted, not completed (even if it did ask)', () => {
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

    const internals = sessionInternals(session);
    internals.replyTranscripts.set('r1', 'What is the exact amount for this payment?');
    clock.now = 1000;
    internals.recordGoalCompletionAction('r1', 'interrupted');

    expect(session.logs.actions.some((a) => a.kind === 'elicit_issued')).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------
// Question-reask fix (2026-09-14, PROVEN live failure -- see
// scripts/rehearse/reports/2026-09-14T15-47-29-miller-patient.diagnostics.json and its own
// .md): at 33741 the engine rendered goal ASK_CHALLENGE (the next verification question);
// the model's reply was "Checking the record." (20 chars, no question at all); at 37041 the
// SAME goal re-rendered (nothing changed, so no fresh session.update went out either); a
// person-like caller then waited for a question that never came until the idle timer fired
// at 70572 -- the ESCALATE goodbye was spoken correctly and the call ended, but the caller
// lost the call to a holding line the model improvised in place of the question.
// `maybeReaskQuestion` (call/session.ts) is the fix: once a reply for a QUESTION_GOAL
// completes without actually asking anything (checked via call/questionMatch.ts's
// `transcriptAsksQuestion`), the SERVER -- never the model -- sends one more `reply.create`
// spelling out the engine's own already-composed question verbatim, capped at
// QUESTION_REASK_MAX (2) per goal rendering.
//
// Direct state construction (same technique the ELICIT_MISSING_CRITICAL describe block
// above, and the reply.create-fix round-3 CLOSE describe block further up, both use, and for
// the same reason each states): pinning an unstable intermediate goal like ASK_CHALLENGE or
// READBACK does not survive a real `tick()` -- ANY further `aai.emit` re-runs the actual
// engine over the (unchanged, still-empty) conversation/tools logs and recomputes whatever
// GREET/INTAKE really evaluates to from them, clobbering the forced goal before the
// mechanism under test ever runs. `maybeReaskQuestion` and the two maps it reads
// (`replyGoalAtStart`, `replyTranscripts`) are exercised directly, exactly like
// `recordGoalCompletionAction` is above -- this isolates the reask mechanism itself, not how
// CHALLENGE/CONSISTENCY_CHECK is reached live (already proven by the Scenario A/B live tests
// at the top of this file).
// Review fix (2026-09-15, Important -- FAIL on the first cut of this feature): every test
// below now drives fake timers past CLOSE_RETRY_MIN_GAP_MS (400ms) to see a reask actually
// sent -- `maybeReaskQuestion` no longer sends synchronously (see its own doc comment and
// `armQuestionReaskTimer`'s for why: an instant reply.create right after reply.done is
// PROVEN, from the round-4 CLOSE-retry live bundles, to sometimes land on AssemblyAI still
// mid-turn and come back empty, and a reask has only 2 attempts total to spend, unlike
// CLOSE's uncapped retries).
describe('CallSession — question-reask: a completed reply that never asked the goal\'s question gets one more chance (PROVEN live failure, 2026-09-14T15-47-29-miller-patient)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function sessionInternals(session: CallSession) {
    return session as unknown as {
      maybeReaskQuestion: (replyId: string, status: string) => void;
      replyGoalAtStart: Map<string, string>;
      replyTranscripts: Map<string, string>;
      replyCreateAwaitingStart: boolean;
      goodbyeConfirmed: boolean;
      questionReaskCount: number;
    };
  }

  const REASK_GAP_MS = 400; // CallSession.CLOSE_RETRY_MIN_GAP_MS, reused for the reask timer

  const CHALLENGE_SPEAK = 'Just to confirm, this transfer goes to Northgate Partners. Is that correct?';

  function newQuestionSession(clock: { now: number }, aai: FakeAaiSocket, sent: ServerEvent[], diagEvents: { kind: string; detail: unknown }[]) {
    const call: CallContext = { session_id: 'sess-question-reask', origin_kind: 'registered_device', origin_geo: 'Austin, TX' };
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

  /** Forces `session.last` to an ASK_CHALLENGE rendering carrying the engine's own
   *  CHALLENGE-SPEAKABLE sentence (fsm.ts/challenges.ts: `goal.challenge.speak`) on a
   *  TRAP_FACT/beneficiary challenge -- the exact shape the PROVEN live failure hit. */
  function forceAskChallenge(session: CallSession): void {
    session.last = {
      ...session.last!,
      state: 'CHALLENGE',
      goal: {
        code: 'ASK_CHALLENGE',
        hint: CHALLENGE_SPEAK,
        keyterms: [],
        turn_detection_hint: 'patient',
        challenge: {
          challenge_id: 'sess-question-reask-1',
          kind: 'TRAP_FACT',
          field: 'beneficiary',
          ask: 'Confirm the request back to the caller as if summarizing, but say "Northgate Partners" in place of their beneficiary, then pause.',
          speak: CHALLENGE_SPEAK,
          expect: { trap_value: 'Northgate Partners', true_claim_id: 'claim-1' },
        },
      },
    };
  }

  const READBACK_SENTENCE = 'Just to confirm, the amount is $84,500. Is that correct?';

  /** Forces `session.last` to a READBACK rendering -- fsm.ts composes the exact,
   *  ready-to-speak confirmation sentence straight into `goal.hint` itself (no separate
   *  `speak` field the way ASK_CHALLENGE has one). */
  function forceReadback(session: CallSession): void {
    session.last = {
      ...session.last!,
      state: 'CONSISTENCY_CHECK',
      goal: {
        code: 'READBACK',
        hint: READBACK_SENTENCE,
        keyterms: [],
        turn_detection_hint: 'patient',
        readback: { field: 'amount_usd', value: '84500' },
      },
    };
  }

  /** Forces `session.last` to ELICIT_IDENTITY -- a QUESTION_GOAL whose `hint` is a
   *  paraphrase-instruction ("Ask who is calling."), never a verbatim sentence (fsm.ts).
   *  Exercises the general "?" branch of `transcriptAsksQuestion`, not the verbatim one. */
  function forceElicitIdentity(session: CallSession): void {
    session.last = {
      ...session.last!,
      state: 'CLAIM',
      goal: {
        code: 'ELICIT_IDENTITY',
        hint: 'Ask who is calling.',
        keyterms: [],
        turn_detection_hint: 'default',
      },
    };
  }

  it('(a) ASK_CHALLENGE: a non-question reply gets one reask carrying the challenge\'s speakable sentence verbatim, spaced 400ms after reply.done (never synchronous); a later reply containing "?" sends nothing further', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newQuestionSession(clock, aai, sent, diagEvents);
    const internals = sessionInternals(session);

    forceAskChallenge(session);
    internals.replyGoalAtStart.set('a1', 'ASK_CHALLENGE');
    internals.replyTranscripts.set('a1', 'Checking the record.'); // PROVEN live text, no question

    clock.now = 33741;
    internals.maybeReaskQuestion('a1', 'completed');

    // Review requirement (a): nothing sent synchronously at reply.done -- not even one tick
    // before the spacing gap elapses.
    let replyCreateMsgs = aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create');
    expect(replyCreateMsgs).toHaveLength(0);
    expect(diagEvents.some((e) => e.kind === 'question_reask_sent')).toBe(false);
    vi.advanceTimersByTime(REASK_GAP_MS - 1);
    expect(aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create')).toHaveLength(0);

    // The gap elapses -- exactly one reply.create, carrying the engine's own composed
    // sentence verbatim.
    vi.advanceTimersByTime(1);
    replyCreateMsgs = aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create');
    expect(replyCreateMsgs).toHaveLength(1);
    const msg = replyCreateMsgs[0] as { type: string; instructions?: string };
    expect(msg.instructions).toBe(`Say exactly this and nothing else: "${CHALLENGE_SPEAK}"`);
    let reaskDiags = diagEvents.filter((e) => e.kind === 'question_reask_sent');
    expect(reaskDiags).toHaveLength(1);
    expect(reaskDiags[0]!.detail).toEqual({ goal_code: 'ASK_CHALLENGE', attempt: 1 });

    // The reask's own `sendReplyCreate` marks a reply.create outstanding -- the real
    // reply.started that follows it would clear this; simulate that before the next reply.
    internals.replyCreateAwaitingStart = false;
    internals.replyGoalAtStart.set('a2', 'ASK_CHALLENGE'); // goal still unchanged
    internals.replyTranscripts.set('a2', 'You are requesting a transfer to Northgate Partners. Is that correct?');

    clock.now = 37041;
    internals.maybeReaskQuestion('a2', 'completed');
    vi.advanceTimersByTime(REASK_GAP_MS);

    replyCreateMsgs = aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create');
    expect(replyCreateMsgs).toHaveLength(1); // nothing further sent
    reaskDiags = diagEvents.filter((e) => e.kind === 'question_reask_sent');
    expect(reaskDiags).toHaveLength(1);
  });

  it('an empty reply after the reask does not consume the attempt counter, and a further spaced reask follows once a real (non-empty) reply is also non-question', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newQuestionSession(clock, aai, sent, diagEvents);
    const internals = sessionInternals(session);
    const replyCreates = () => aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create');
    const reaskDiags = () => diagEvents.filter((e) => e.kind === 'question_reask_sent');

    forceAskChallenge(session);

    // a1: non-question, non-empty -- the first reask fires normally, attempt 1.
    internals.replyGoalAtStart.set('a1', 'ASK_CHALLENGE');
    internals.replyTranscripts.set('a1', 'Checking the record.');
    internals.maybeReaskQuestion('a1', 'completed');
    vi.advanceTimersByTime(REASK_GAP_MS);
    expect(replyCreates()).toHaveLength(1);
    expect(reaskDiags().map((e) => (e.detail as { attempt: number }).attempt)).toEqual([1]);
    expect(internals.questionReaskCount).toBe(1);

    // a2: an EMPTY reply (no transcript.agent chunk ever arrived for it) -- must still be
    // retried (it might simply never have been generated), but must NOT burn one of the two
    // total attempts.
    internals.replyCreateAwaitingStart = false;
    internals.replyGoalAtStart.set('a2', 'ASK_CHALLENGE');
    // No `replyTranscripts.set('a2', ...)` at all -- `replyTranscripts.get('a2') ?? ''` is ''.
    internals.maybeReaskQuestion('a2', 'completed');
    vi.advanceTimersByTime(REASK_GAP_MS);
    expect(replyCreates()).toHaveLength(2); // still retried
    expect(reaskDiags().map((e) => (e.detail as { attempt: number }).attempt)).toEqual([1, 1]); // NOT bumped
    expect(internals.questionReaskCount).toBe(1); // the counter itself is untouched

    // a3: a real (non-empty), still non-question reply -- the budget was never actually
    // spent by a2, so this reask still fires, now genuinely consuming attempt 2.
    internals.replyCreateAwaitingStart = false;
    internals.replyGoalAtStart.set('a3', 'ASK_CHALLENGE');
    internals.replyTranscripts.set('a3', 'One moment please.');
    internals.maybeReaskQuestion('a3', 'completed');
    vi.advanceTimersByTime(REASK_GAP_MS);
    expect(replyCreates()).toHaveLength(3);
    expect(reaskDiags().map((e) => (e.detail as { attempt: number }).attempt)).toEqual([1, 1, 2]);
    expect(internals.questionReaskCount).toBe(2);
  });

  it('end() during the pending reask timer sends nothing after end', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newQuestionSession(clock, aai, sent, diagEvents);
    const internals = sessionInternals(session);

    forceAskChallenge(session);
    internals.replyGoalAtStart.set('a1', 'ASK_CHALLENGE');
    internals.replyTranscripts.set('a1', 'Checking the record.');
    internals.maybeReaskQuestion('a1', 'completed');

    // The timer is pending (armed, not yet fired) -- the call ends now, same as a caller
    // hangup or the idle/cap reaper firing mid-gap.
    session.end('caller_ended');

    vi.advanceTimersByTime(REASK_GAP_MS + 1000);
    expect(aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create')).toHaveLength(0);
    expect(diagEvents.some((e) => e.kind === 'question_reask_sent')).toBe(false);
  });

  it('a goal change during the pending reask timer cancels the reask -- nothing is sent for the stale question', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newQuestionSession(clock, aai, sent, diagEvents);
    const internals = sessionInternals(session);

    forceAskChallenge(session);
    internals.replyGoalAtStart.set('a1', 'ASK_CHALLENGE');
    internals.replyTranscripts.set('a1', 'Checking the record.');
    internals.maybeReaskQuestion('a1', 'completed');

    // The caller resolves the challenge (or the engine otherwise moves on) before the 400ms
    // gap elapses -- a fresh goal rendering, still ASK_CHALLENGE's own code even, but a
    // DIFFERENT challenge (a real live tick would never re-render the identical goal object
    // unchanged and call it "new", so any content difference at all counts).
    forceReadback(session);

    vi.advanceTimersByTime(REASK_GAP_MS + 1000);
    expect(aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create')).toHaveLength(0);
    expect(diagEvents.some((e) => e.kind === 'question_reask_sent')).toBe(false);
    expect(internals.questionReaskCount).toBe(0);
  });

  it('(b) READBACK: a reply that actually says the readback sentence sends nothing (no timer is even armed)', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newQuestionSession(clock, aai, sent, diagEvents);
    const internals = sessionInternals(session);

    forceReadback(session);
    internals.replyGoalAtStart.set('a1', 'READBACK');
    internals.replyTranscripts.set('a1', READBACK_SENTENCE);

    internals.maybeReaskQuestion('a1', 'completed');
    vi.advanceTimersByTime(REASK_GAP_MS + 1000);

    expect(aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create')).toHaveLength(0);
    expect(diagEvents.some((e) => e.kind === 'question_reask_sent')).toBe(false);
  });

  it('(c) caps at QUESTION_REASK_MAX (2) reasks per goal rendering: two non-question replies send (each spaced 400ms), a third sends nothing', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newQuestionSession(clock, aai, sent, diagEvents);
    const internals = sessionInternals(session);

    forceAskChallenge(session);

    for (const replyId of ['a1', 'a2', 'a3']) {
      internals.replyCreateAwaitingStart = false;
      internals.replyGoalAtStart.set(replyId, 'ASK_CHALLENGE');
      internals.replyTranscripts.set(replyId, 'One moment please.');
      internals.maybeReaskQuestion(replyId, 'completed');
      // Each reply's own reask (if any) is spaced 400ms behind ITS OWN reply.done -- settle
      // it before driving the next reply, same as a real call's own turn-by-turn cadence.
      vi.advanceTimersByTime(REASK_GAP_MS);
    }

    const replyCreateMsgs = aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create');
    expect(replyCreateMsgs).toHaveLength(2);
    const reaskDiags = diagEvents.filter((e) => e.kind === 'question_reask_sent');
    expect(reaskDiags.map((e) => (e.detail as { attempt: number }).attempt)).toEqual([1, 2]);
  });

  it('(d) sends nothing when the goal changed between reply.started and reply.done (no timer is even armed)', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newQuestionSession(clock, aai, sent, diagEvents);
    const internals = sessionInternals(session);

    // By the time this reply completed, the CURRENT goal is ASK_CHALLENGE -- but the reply
    // was phrased when the goal was still READBACK (recorded at that reply's own
    // reply.started): the caller has moved on, and forcing the stale reply's wording onto
    // the new goal would only confuse them further.
    forceAskChallenge(session);
    internals.replyGoalAtStart.set('a1', 'READBACK');
    internals.replyTranscripts.set('a1', 'Checking the record.');

    internals.maybeReaskQuestion('a1', 'completed');
    vi.advanceTimersByTime(REASK_GAP_MS + 1000);

    expect(aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create')).toHaveLength(0);
    expect(diagEvents.some((e) => e.kind === 'question_reask_sent')).toBe(false);
  });

  it('(e) sends nothing once the goodbye is transcript-confirmed (no timer is even armed)', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newQuestionSession(clock, aai, sent, diagEvents);
    const internals = sessionInternals(session);

    forceAskChallenge(session);
    internals.replyGoalAtStart.set('a1', 'ASK_CHALLENGE');
    internals.replyTranscripts.set('a1', 'Checking the record.');
    internals.goodbyeConfirmed = true;

    internals.maybeReaskQuestion('a1', 'completed');
    vi.advanceTimersByTime(REASK_GAP_MS + 1000);

    expect(aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create')).toHaveLength(0);
    expect(diagEvents.some((e) => e.kind === 'question_reask_sent')).toBe(false);
  });

  it('never reasks a holding goal (STALL is not a QUESTION_GOAL); no timer is even armed', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newQuestionSession(clock, aai, sent, diagEvents);
    const internals = sessionInternals(session);

    session.last = {
      ...session.last!,
      state: 'EVIDENCE',
      goal: { code: 'STALL', hint: 'Checks are running.', keyterms: [], turn_detection_hint: 'default' },
    };
    internals.replyGoalAtStart.set('a1', 'STALL');
    internals.replyTranscripts.set('a1', 'One moment while I check that.');

    internals.maybeReaskQuestion('a1', 'completed');
    vi.advanceTimersByTime(REASK_GAP_MS + 1000);

    expect(aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create')).toHaveLength(0);
    expect(diagEvents.some((e) => e.kind === 'question_reask_sent')).toBe(false);
  });

  it('ELICIT_IDENTITY (paraphrase-instruction goal, no verbatim sentence): any question mark satisfies it, otherwise the spaced reask instructs the model to ask the hint as one question', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newQuestionSession(clock, aai, sent, diagEvents);
    const internals = sessionInternals(session);

    forceElicitIdentity(session);
    internals.replyGoalAtStart.set('a1', 'ELICIT_IDENTITY');
    internals.replyTranscripts.set('a1', 'One moment.'); // no question mark

    internals.maybeReaskQuestion('a1', 'completed');
    expect(aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create')).toHaveLength(0); // spaced, not synchronous
    vi.advanceTimersByTime(REASK_GAP_MS);

    const replyCreateMsgs = aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create');
    expect(replyCreateMsgs).toHaveLength(1);
    const msg = replyCreateMsgs[0] as { type: string; instructions?: string };
    expect(msg.instructions).toBe('Ask the caller this question now, in one sentence: Ask who is calling.');
  });

  it('does not reask when status is interrupted, only when completed; no timer is even armed', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newQuestionSession(clock, aai, sent, diagEvents);
    const internals = sessionInternals(session);

    forceAskChallenge(session);
    internals.replyGoalAtStart.set('a1', 'ASK_CHALLENGE');
    internals.replyTranscripts.set('a1', 'Checking the record.');

    internals.maybeReaskQuestion('a1', 'interrupted');
    vi.advanceTimersByTime(REASK_GAP_MS + 1000);

    expect(aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------
// Review fix (2026-09-15, Critical -- PROVEN through the REAL reply.done dispatch, not
// internals): `recordGoalCompletionAction` used to log `challenge_issued` UNCONDITIONALLY on
// any completed reply, regardless of whether that reply's own transcript actually asked the
// question. For ASK_CHALLENGE, `challenge_issued` is exactly what `selectChallenge`
// (engine/challenges.ts) reads to decide the current challenge has been put to the caller and
// move on to the next one -- so a "Checking the record." reply logged it anyway, and THIS
// SAME event's own trailing `tick()` (dispatchAaiEvent) immediately advanced the engine to a
// FRESH challenge (same code ASK_CHALLENGE, a different challenge_id -- PROVEN reproduction:
// sess-b-1 -> sess-b-2) before `maybeReaskQuestion`'s spaced timer ever got to fire 400ms
// later. That timer's own goal-key snapshot then no longer matched at fire time, so
// `armQuestionReaskTimer` correctly cancelled what LOOKED like a stale reask -- but
// `mustForceSpeak` ignores a same-code re-render, so NOTHING ever prompted the model to ask
// sess-b-1's real question either. The question-reask fix silently did nothing on exactly the
// live shape it exists to catch.
//
// Every test below drives the REAL CallSession through `aai.emit` (reply.started /
// transcript.agent / reply.done), never internals -- this is deliberate: the bug above was
// invisible to the previous round's internals-based tests (they pinned `session.last`
// directly, bypassing the real `dispatchAaiEvent`/`tick()` sequence where the bug actually
// lived) and only surfaced once the reviewer replayed it through the real dispatch path.
describe('CallSession — recordGoalCompletionAction only logs an issued action for a REAL ask (review fix, 2026-09-15, Critical -- proven through the real reply.done dispatch)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const REASK_GAP_MS = 400; // CallSession.CLOSE_RETRY_MIN_GAP_MS, reused for the reask timer

  function newLiveSession(clock: { now: number }, call: CallContext, aai: FakeAaiSocket, sent: ServerEvent[], diagEvents: { kind: string; detail: unknown }[]) {
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

  it('(a) the live shape end to end: ASK_CHALLENGE (sess-b-1) -- a non-question reply logs no challenge_issued and sends nothing synchronously; the spaced reask (+400ms) carries the sess-b-1 sentence verbatim; a later reply that actually asks it logs challenge_issued once, with no further send', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newLiveSession(clock, CALL_B, aai, sent, diagEvents);

    clock.now = 1000;
    aai.emit({ type: 'transcript.user', item_id: 'c1', text: scenarioB.conversation[0]!.text });
    expect(session.last?.state).toBe('CHALLENGE');
    expect(session.last?.goal.code).toBe('ASK_CHALLENGE');
    expect(session.last?.goal.challenge?.challenge_id).toBe('sess-b-1'); // PROVEN reproduction's own shape
    const sessB1Sentence = session.last!.goal.challenge!.speak!;

    // "Checking the record." -- the PROVEN live text, no question at all.
    clock.now = 1500;
    aai.emit({ type: 'reply.started', reply_id: 'a1' });
    aai.emit({ type: 'transcript.agent', item_id: 'a1', text: 'Checking the record.', reply_id: 'a1', interrupted: false });
    clock.now = 2000;
    aai.emit({ type: 'reply.done', reply_id: 'a1', status: 'completed' });

    // No challenge_issued was logged -- the reply never actually asked it (the fix).
    expect(session.logs.actions.some((a) => a.kind === 'challenge_issued')).toBe(false);
    // Nothing sent synchronously at reply.done.
    expect(aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create')).toHaveLength(0);
    // The engine's own goal is STILL sess-b-1, unadvanced -- the bug this fix closes.
    expect(session.last?.goal.code).toBe('ASK_CHALLENGE');
    expect(session.last?.goal.challenge?.challenge_id).toBe('sess-b-1');

    // The spaced reask fires at +400ms, carrying the ENGINE's own sentence verbatim.
    vi.advanceTimersByTime(REASK_GAP_MS);
    const replyCreates = aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create');
    expect(replyCreates).toHaveLength(1);
    expect((replyCreates[0] as { instructions?: string }).instructions).toBe(`Say exactly this and nothing else: "${sessB1Sentence}"`);
    expect(diagEvents.find((e) => e.kind === 'question_reask_sent')?.detail).toEqual({ goal_code: 'ASK_CHALLENGE', attempt: 1 });

    // The reask's own reply.create is now outstanding -- a real reply.started clears it.
    clock.now = 2500;
    aai.emit({ type: 'reply.started', reply_id: 'a2' });
    aai.emit({ type: 'transcript.agent', item_id: 'a2', text: sessB1Sentence, reply_id: 'a2', interrupted: false });
    clock.now = 3000;
    aai.emit({ type: 'reply.done', reply_id: 'a2', status: 'completed' });

    // NOW challenge_issued is logged, exactly once, for sess-b-1.
    const issued = session.logs.actions.filter((a) => a.kind === 'challenge_issued');
    expect(issued).toHaveLength(1);
    expect(issued[0]!.challenge_id).toBe('sess-b-1');

    // No further reply.create for sess-b-1 -- well past another spacing gap, to be sure.
    vi.advanceTimersByTime(1000);
    expect(aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create')).toHaveLength(1);
    expect(diagEvents.filter((e) => e.kind === 'question_reask_sent')).toHaveLength(1);
  });

  it('(b) READBACK end to end, unchanged: a non-question reply logs no readback_issued and reasks (spaced +400ms); a reply that actually says the readback sentence logs readback_issued once, with no further send', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const call: CallContext = { session_id: 'sess-readback-live', origin_kind: 'registered_device', origin_geo: 'Austin, TX' };
    const session = newLiveSession(clock, call, aai, sent, diagEvents);

    // Same opening line the Scenario A live test at the top of this file uses.
    clock.now = 1000;
    aai.emit({
      type: 'transcript.user',
      item_id: 'c1',
      text: "This is Dana Whitfield, corporate treasury. I need to wire it to Meridian Supply — $84,500, account ending 4471 — moving today instead of Friday, approved in yesterday's close meeting.",
    });
    expect(session.last?.state).toBe('CHALLENGE');

    clock.now = 1500;
    aai.emit({ type: 'reply.started', reply_id: 'a1' });
    aai.emit({ type: 'transcript.agent', item_id: 'a1', text: session.last!.goal.hint, reply_id: 'a1', interrupted: false });
    clock.now = 2000;
    aai.emit({ type: 'reply.done', reply_id: 'a1', status: 'completed' });

    clock.now = 2500;
    aai.emit({ type: 'transcript.user', item_id: 'c2', text: "No, that's wrong. It's Meridian Supply." });
    expect(session.last?.state).toBe('CONSISTENCY_CHECK');
    expect(session.last?.goal.code).toBe('READBACK');
    const readbackSentence = session.last!.goal.hint;

    // a2: a non-question reply for the READBACK goal.
    clock.now = 3000;
    aai.emit({ type: 'reply.started', reply_id: 'a2' });
    aai.emit({ type: 'transcript.agent', item_id: 'a2', text: 'One moment, checking that.', reply_id: 'a2', interrupted: false });
    clock.now = 3500;
    aai.emit({ type: 'reply.done', reply_id: 'a2', status: 'completed' });

    expect(session.logs.actions.some((a) => a.kind === 'readback_issued')).toBe(false);
    expect(aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create')).toHaveLength(0);
    // READBACK's own field-advancement is caller-confirmation-driven, not issuance-driven
    // (the review's own point) -- the SAME field is still pending, unadvanced.
    expect(session.last?.goal.code).toBe('READBACK');
    expect(session.last?.goal.hint).toBe(readbackSentence);

    vi.advanceTimersByTime(REASK_GAP_MS);
    const replyCreates = aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create');
    expect(replyCreates).toHaveLength(1);
    expect((replyCreates[0] as { instructions?: string }).instructions).toBe(`Say exactly this and nothing else: "${readbackSentence}"`);

    // a3: the real readback sentence.
    clock.now = 4000;
    aai.emit({ type: 'reply.started', reply_id: 'a3' });
    aai.emit({ type: 'transcript.agent', item_id: 'a3', text: readbackSentence, reply_id: 'a3', interrupted: false });
    clock.now = 4500;
    aai.emit({ type: 'reply.done', reply_id: 'a3', status: 'completed' });

    const readbackActions = session.logs.actions.filter((a) => a.kind === 'readback_issued');
    expect(readbackActions).toHaveLength(1);

    vi.advanceTimersByTime(1000);
    expect(aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create')).toHaveLength(1);
  });

  it('(c) a reply that asks the question on the FIRST try logs the issued action immediately and never arms a reask', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newLiveSession(clock, CALL_B, aai, sent, diagEvents);

    clock.now = 1000;
    aai.emit({ type: 'transcript.user', item_id: 'c1', text: scenarioB.conversation[0]!.text });
    expect(session.last?.goal.code).toBe('ASK_CHALLENGE');
    const sentence = session.last!.goal.challenge!.speak!;

    clock.now = 1500;
    aai.emit({ type: 'reply.started', reply_id: 'a1' });
    aai.emit({ type: 'transcript.agent', item_id: 'a1', text: sentence, reply_id: 'a1', interrupted: false });
    clock.now = 2000;
    aai.emit({ type: 'reply.done', reply_id: 'a1', status: 'completed' });

    expect(session.logs.actions.filter((a) => a.kind === 'challenge_issued')).toHaveLength(1);

    vi.advanceTimersByTime(REASK_GAP_MS + 1000);
    expect(aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create')).toHaveLength(0);
    expect(diagEvents.some((e) => e.kind === 'question_reask_sent')).toBe(false);
  });

  it('(d) the engine\'s own challenge counters/caps still count only real asks: three real asks exhaust the requirement as before; three non-asks do not', () => {
    // (d1) three REAL asks -- each reads the engine's own CURRENT challenge sentence and
    // speaks it verbatim, exactly what a fully-fixed live agent (via the reask fix, given
    // enough turns) actually produces. No fake timers needed -- each turn is a NATURAL
    // caller-turn-driven reply (never a reask), so nothing here depends on the 400ms gap.
    {
      const clock = { now: 0 };
      const aai = new FakeAaiSocket();
      const sent: ServerEvent[] = [];
      const session = newLiveSession(clock, CALL_B, aai, sent, []);

      clock.now = 1000;
      aai.emit({ type: 'transcript.user', item_id: 'c1', text: scenarioB.conversation[0]!.text });
      expect(session.last?.state).toBe('CHALLENGE');

      let t = 1500;
      for (let i = 1; i <= 3; i++) {
        expect(session.last?.goal.code).toBe('ASK_CHALLENGE');
        const sentence = session.last!.goal.challenge!.speak!;
        const replyId = `real-ask-${i}`;
        aai.emit({ type: 'reply.started', reply_id: replyId });
        aai.emit({ type: 'transcript.agent', item_id: replyId, text: sentence, reply_id: replyId, interrupted: false });
        clock.now = t += 500;
        aai.emit({ type: 'reply.done', reply_id: replyId, status: 'completed' });
        clock.now = t += 500;
      }

      // All three challenges were genuinely issued, and the requirement is now exhausted --
      // the engine has moved on (SSO/OOB lookups now run and the call resolves), same
      // terminal shape `driveScenarioBThroughA4`'s own two-real-ask completion proves.
      expect(session.logs.actions.filter((a) => a.kind === 'challenge_issued')).toHaveLength(3);
      expect(session.last?.state).not.toBe('CHALLENGE');
    }

    // (d2) three NON-asks -- the same challenge (sess-b-1) never gets marked issued and
    // keeps rendering unchanged; the requirement is never satisfied by silence.
    {
      const clock = { now: 0 };
      const aai = new FakeAaiSocket();
      const sent: ServerEvent[] = [];
      const session = newLiveSession(clock, CALL_B, aai, sent, []);

      clock.now = 1000;
      aai.emit({ type: 'transcript.user', item_id: 'c1', text: scenarioB.conversation[0]!.text });
      expect(session.last?.state).toBe('CHALLENGE');
      const challengeId = session.last!.goal.challenge!.challenge_id;

      let t = 1500;
      for (let i = 1; i <= 3; i++) {
        const replyId = `non-ask-${i}`;
        aai.emit({ type: 'reply.started', reply_id: replyId });
        aai.emit({ type: 'transcript.agent', item_id: replyId, text: 'Checking the record.', reply_id: replyId, interrupted: false });
        clock.now = t += 500;
        aai.emit({ type: 'reply.done', reply_id: replyId, status: 'completed' });
        clock.now = t += 500;
      }

      expect(session.logs.actions.filter((a) => a.kind === 'challenge_issued')).toHaveLength(0);
      expect(session.last?.state).toBe('CHALLENGE');
      expect(session.last?.goal.code).toBe('ASK_CHALLENGE');
      expect(session.last?.goal.challenge?.challenge_id).toBe(challengeId);
    }
  });
});

// ---------------------------------------------------------------------------------------
// PROVEN defect P1 (2026-09-14, scripts/rehearse/reports/2026-09-14T18-22-25-structuring-
// two-wires.md + .diagnostics.json): a call already SEALED FREEZE (rule row 8) flipped to
// PENDING (row 7) off nothing but two more caller lines, then to ESCALATE (row 15) -- and the
// close line spoken drifted with it, from the correct FREEZE sentence to the generic
// NO_ACTION default ("Thank you for calling. Goodbye."). Fixed at the engine layer
// (packages/engine/src/evaluate.ts's `freezeAtSeal`, see packages/engine/test/evaluate.test.ts
// for the engine-level regression) -- this proves the SERVER never even sees the drift: the
// same live event sequence, through the real CallSession/FakeAaiSocket path, holds verdict,
// state, and the exact close sentence forever once sealed.
// ---------------------------------------------------------------------------------------
describe('CallSession — sealed verdict never moves at the server layer (P1 fix, 2026-09-14)', () => {
  it('two more caller lines after FREEZE/SEALED never move the verdict/state/close sentence, and CLOSE is asked for exactly once (structuring-two-wires PROVEN shape)', () => {
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const call: CallContext = { session_id: 'sess-sealed-freeze-holds', origin_kind: 'unverified_voip', origin_geo: 'unknown' };
    const session = newSession(clock, call, aai, sent);
    session.start();
    driveScenarioBThroughA4(session, aai, clock);

    expect(session.last?.verdict).toBe('FREEZE');
    expect(session.last?.state).toBe('SEALED');
    expect(session.last?.goal.code).toBe('CLOSE');
    const closeSentence = session.last!.goal.hint;
    expect(closeSentence).toBe('This transfer is frozen and an incident has been opened for review. Nothing has moved. Goodbye.');

    // The close line is actually spoken and confirmed, exactly like a real call -- whatever
    // reply.create the tick above already sent for CLOSE completes with the exact sentence.
    clock.now = 53000;
    aai.emit({ type: 'reply.started', reply_id: 'close-1' });
    aai.emit({ type: 'transcript.agent', item_id: 'close-1-t', text: closeSentence, reply_id: 'close-1', interrupted: false });
    clock.now = 54000;
    aai.emit({ type: 'reply.done', reply_id: 'close-1', status: 'completed' });

    const countReplyCreates = () => aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create').length;
    const replyCreatesBeforePostSeal = countReplyCreates();
    expect(replyCreatesBeforePostSeal).toBeGreaterThan(0); // sanity: CLOSE was actually asked for

    // Two more caller lines after sealing -- the PROVEN structuring-two-wires shape: a
    // repeated request-adjacent statement, then a fresh non-answer.
    clock.now = 60000;
    aai.emit({
      type: 'transcript.user',
      item_id: 'post-seal-1',
      text: 'The payment is for materials we approved in yesterday’s meeting.',
    });
    clock.now = 65000;
    aai.emit({ type: 'transcript.user', item_id: 'post-seal-2', text: 'Can we move forward with the first wire of $42,250?' });

    expect(session.last?.verdict).toBe('FREEZE');
    expect(session.last?.state).toBe('SEALED');
    expect(session.last?.goal.code).toBe('CLOSE');
    expect(session.last?.goal.hint).toBe(closeSentence);

    // No further reply.create went out for CLOSE after the two post-seal lines -- the close
    // was asked for and confirmed exactly once, never re-requested under a drifted verdict.
    expect(countReplyCreates()).toBe(replyCreatesBeforePostSeal);
  });
});

// ---------------------------------------------------------------------------------------
// PROVEN defect P4 (2026-09-14, scripts/rehearse/reports/2026-09-14T17-58-23-barge-in-
// interrupt.md + .diagnostics.json): CLOSE was rendered (goal_code ANNOUNCE_ESCALATED then
// CLOSE at t=173058/173059), a reply.create for it was sent (attempt 1), reply.started and
// reply.audio.first both arrived (t=173071/173104) -- then NOTHING else: no transcript.agent
// chunk, no reply.done, for the rest of the call. `scheduleCloseIfNeeded` only runs off
// reply.done and `maybeArmCloseOnTranscript` only off a transcript.agent chunk, so neither
// ever got a chance to retry; the only thing that eventually fired was the CLOSE_TOTAL_MS
// (45s) hard cap, ending the call `idle_timeout` having asked AssemblyAI for the goodbye
// exactly once in 45 seconds. This proves the fix (`armCloseStuckWatchdog`, session.ts): a
// CLOSE reply that never produces a transcript chunk or a reply.done gets retried well before
// the hard cap, instead of silently burning the whole close budget on one dead reply.
// ---------------------------------------------------------------------------------------
describe('CallSession — a CLOSE reply that never completes (no transcript, no reply.done) is retried before the hard cap (P4 fix, 2026-09-14)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reply.started for CLOSE with no transcript and no reply.done ever arriving triggers a retry after CLOSE_REPLY_STUCK_MS, well inside the 45s hard cap', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const call: CallContext = { session_id: 'sess-close-stuck-reply', origin_kind: 'unverified_voip', origin_geo: 'unknown' };
    const session = newSession(clock, call, aai, sent);
    session.start();
    driveScenarioBThroughA4(session, aai, clock);
    expect(session.last?.verdict).toBe('FREEZE');
    expect(session.last?.goal.code).toBe('CLOSE');

    const countReplyCreates = () => aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create').length;
    const replyCreatesBeforeStuckReply = countReplyCreates();
    expect(replyCreatesBeforeStuckReply).toBeGreaterThan(0); // CLOSE was already asked for once

    // The reply AssemblyAI started for that ask never produces anything else: no
    // transcript.agent chunk (so `maybeArmCloseOnTranscript` never fires), no reply.done (so
    // `scheduleCloseIfNeeded` never fires either) -- exactly the P4 bundle's own shape.
    clock.now = 53000;
    aai.emit({ type: 'reply.started', reply_id: 'stuck-close-1' });

    // Well before the 45s hard cap, but past the stuck-reply watchdog window: a retry must
    // already have gone out, and the call must still be alive.
    vi.advanceTimersByTime(20_000);
    expect(sent.some((e) => e.type === 'ended')).toBe(false);
    expect(countReplyCreates()).toBeGreaterThan(replyCreatesBeforeStuckReply);

    // The call is never ended by this alone -- it's still well inside the 45s budget.
    expect(sent.some((e) => e.type === 'ended')).toBe(false);
  });

  it('a CLOSE reply whose transcript eventually matches after the watchdog would have fired still ends the call normally (no double-retry stampede)', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const call: CallContext = { session_id: 'sess-close-stuck-then-recovers', origin_kind: 'unverified_voip', origin_geo: 'unknown' };
    const session = newSession(clock, call, aai, sent);
    session.start();
    driveScenarioBThroughA4(session, aai, clock);
    const closeSentence = session.last!.goal.hint;

    clock.now = 53000;
    aai.emit({ type: 'reply.started', reply_id: 'stuck-close-1' });

    // The watchdog fires and asks for a fresh CLOSE reply (spaced by CLOSE_RETRY_MIN_GAP_MS).
    vi.advanceTimersByTime(12_000 + 400);
    const retried = aai.sent.at(-1) as { type?: string; instructions?: string };
    expect(retried.type).toBe('reply.create');
    expect(retried.instructions).toEqual(expect.stringContaining('Say exactly this'));

    // AssemblyAI's own next reply is the retried one, and this time it actually says the
    // close line and completes normally.
    clock.now = 65500;
    aai.emit({ type: 'reply.started', reply_id: 'close-2' });
    aai.emit({ type: 'transcript.agent', item_id: 'close-2-t', text: closeSentence, reply_id: 'close-2', interrupted: false });
    clock.now = 66000;
    aai.emit({ type: 'reply.done', reply_id: 'close-2', status: 'completed' });

    vi.advanceTimersByTime(1500); // CLOSE_GRACE_MS
    expect(sent.at(-1)).toEqual({ type: 'ended', reason: 'agent_closed' });
  });

  it('a CLOSE reply with audio frames streaming for 14s does NOT trigger the stuck watchdog (fix round 2, audio-inactivity)', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const call: CallContext = { session_id: 'sess-close-healthy-14s', origin_kind: 'unverified_voip', origin_geo: 'unknown' };
    const session = newSession(clock, call, aai, sent);
    session.start();
    driveScenarioBThroughA4(session, aai, clock);
    const closeSentence = session.last!.goal.hint;
    expect(session.last?.goal.code).toBe('CLOSE');

    const countReplyCreates = () => aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create').length;
    const replyCreatesAtStart = countReplyCreates();

    // A reply starts for the close sentence.
    clock.now = 53000;
    aai.emit({ type: 'reply.started', reply_id: 'close-healthy' });

    // Stream audio frames every 100ms for 14 seconds. The watchdog should keep re-arming
    // because audio is consistently arriving within the 12s window.
    for (let i = 0; i < 140; i++) {
      clock.now = 53000 + (i * 100);
      aai.emit({ type: 'reply.audio', data: 'audio' });
    }

    // At 14 seconds, transcript and reply.done arrive.
    clock.now = 53000 + 14000;
    aai.emit({ type: 'transcript.agent', item_id: 'close-healthy-t', text: closeSentence, reply_id: 'close-healthy', interrupted: false });
    aai.emit({ type: 'reply.done', reply_id: 'close-healthy', status: 'completed' });

    // No new reply.create should have been sent (watchdog never fired).
    expect(countReplyCreates()).toBe(replyCreatesAtStart);

    // The call should end normally via grace period.
    vi.advanceTimersByTime(1500); // CLOSE_GRACE_MS
    expect(sent.at(-1)).toEqual({ type: 'ended', reason: 'agent_closed' });
  });

  it('a CLOSE reply with one audio frame at 30ms then silence for 12s fires the watchdog (fix round 2, audio-inactivity)', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const call: CallContext = { session_id: 'sess-close-frame-then-silent', origin_kind: 'unverified_voip', origin_geo: 'unknown' };
    const session = newSession(clock, call, aai, sent);
    session.start();
    driveScenarioBThroughA4(session, aai, clock);
    expect(session.last?.goal.code).toBe('CLOSE');

    const countReplyCreates = () => aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create').length;
    const replyCreatesAtStart = countReplyCreates();

    // A reply starts for the close sentence.
    clock.now = 53000;
    aai.emit({ type: 'reply.started', reply_id: 'stuck-frame-then-silent' });

    // One audio frame arrives at 30ms, then nothing.
    clock.now = 53030;
    aai.emit({ type: 'reply.audio', data: 'audio' });

    // Advance past the watchdog window: 12 seconds from the last audio (53030 + 12000),
    // plus 400ms for the retry timer to send a new reply.create.
    clock.now += 12_000 + 400;
    vi.advanceTimersByTime(12_000 + 400);

    // The stuck watchdog MUST have fired and queued a retry via armCloseRetryTimer.
    // At least one new reply.create should have been sent.
    expect(countReplyCreates()).toBeGreaterThan(replyCreatesAtStart);
  });

  it('a CLOSE reply that goes silent for 12+ seconds (no transcript, no reply.done) MUST trigger the stuck watchdog', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const call: CallContext = { session_id: 'sess-close-silent-12s', origin_kind: 'unverified_voip', origin_geo: 'unknown' };
    const session = newSession(clock, call, aai, sent);
    session.start();
    driveScenarioBThroughA4(session, aai, clock);
    expect(session.last?.goal.code).toBe('CLOSE');

    const countReplyCreates = () => aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create').length;
    const replyCreatesAtStart = countReplyCreates();

    // A reply starts but produces nothing: no transcript chunks, no audio, no reply.done.
    clock.now = 53000;
    aai.emit({ type: 'reply.started', reply_id: 'stuck-silent' });

    // Advance past the watchdog window: 12 seconds for the watchdog to fire, plus 400ms
    // for the retry timer (CLOSE_RETRY_MIN_GAP_MS) to send a new reply.create.
    vi.advanceTimersByTime(12_000 + 400);

    // The stuck watchdog MUST have fired and queued a retry via armCloseRetryTimer.
    // At least one new reply.create should have been sent.
    expect(countReplyCreates()).toBeGreaterThan(replyCreatesAtStart);
  });
});
