// packages/engine/test/rules.test.ts
// THE RULE TABLE: one `it` per row (1-13), plus the four invariants, plus the mutation
// hooks that prove every rule is load-bearing. Evidence arrays are hand-built with `ev()`
// so this file exercises `decide` in isolation, without going through the ledger/tool
// machinery `evaluate` composes (that's evaluate.test.ts's job).
import { describe, expect, it } from 'vitest';
import { decide, RULES_DOC } from '../src/rules';
import type { DecideResult, RuleContext, RuleMutant } from '../src/rules';
import { phrasingGoal, requiredActions } from '../src/fsm';
import { MERIDIAN } from '../src/seed/meridian';
import type { Evidence, EvidenceKind, EvidenceStatus } from '../src/types';

const SEED = MERIDIAN; // high_value_usd: 50_000

function ev(id: string, kind: EvidenceKind, status: EvidenceStatus, extra?: Partial<Evidence>): Evidence {
  return {
    id,
    kind,
    t_ms: 0,
    label: id,
    status,
    detail: id,
    facts: {},
    quotes: [],
    source: 'transcript',
    provenance: 'CALLER_SAID',
    request_version: 1,
    ...extra,
  };
}

function ctx(overrides?: Partial<RuleContext>): RuleContext {
  return {
    request_version: 1,
    challenges_issued: 0,
    max_challenges: 3,
    new_beneficiary: false,
    evaluation_incomplete: false,
    critical_confirmed: true,
    identity_switch_stale: false,
    challenge_awaiting_answer: false,
    call_ended: false,
    readback_reask_exhausted_field: null,
    ...overrides,
  };
}

const IDENTITY = ev('ev-identity', 'identity_claim', 'INFO');
const REQUEST = ev('ev-request', 'request_params', 'INFO');

/** A fully-clean, "everything checks out" evidence set: identity + request known, all
 *  three live checks PASS, no contradictions, no failed challenges. The context card's
 *  facts.amendment_only marks an exact match against a scheduled payment -- a real,
 *  independently-tested fact recorded on the evidence (see evidence.test.ts), but ruling A
 *  (2026-09-09) means it no longer feeds `need`: with ctx() (need = 1, floored the same
 *  whether or not this exact-match fact is present) this only reaches row 11 and STAGEs
 *  once at least one graded knowledge/relational PASS card is added -- the baseline every
 *  other row-test perturbs one thing away from. */
function stageEvidence(overrides?: Partial<Record<'sso' | 'oob' | 'context', EvidenceStatus>>): Evidence[] {
  return [
    IDENTITY,
    REQUEST,
    ev('ev-sso', 'sso_context_result', overrides?.sso ?? 'PASS'),
    ev('ev-oob', 'oob_verification_result', overrides?.oob ?? 'PASS'),
    ev('ev-context', 'context_check_result', overrides?.context ?? 'PASS', { facts: { amendment_only: true } }),
    ev('ev-pressure', 'pressure_marker', 'INFO'),
  ];
}

const STAGE_CTX = ctx();
const STAGE_CTX_WITH_CALL_ENDED = ctx({ call_ended: true });

describe('decide -- rule table (first match wins)', () => {
  it('row 1: out-of-scope marker, no request -> NO_ACTION, rule_hit 1', () => {
    const r = decide([ev('ev-scope', 'out_of_scope_marker', 'FLAG')], SEED, ctx());
    expect(r.verdict).toBe('NO_ACTION');
    expect(r.reasons).toEqual(['OUT_OF_SCOPE']);
    expect(r.rule_hit).toBe(1);
  });

  it('row 2: out-of-scope marker AND a request exists -> NO_ACTION, rule_hit 2', () => {
    const r = decide([ev('ev-scope', 'out_of_scope_marker', 'FLAG'), REQUEST], SEED, ctx());
    expect(r.verdict).toBe('NO_ACTION');
    expect(r.reasons).toEqual(['OUT_OF_SCOPE']);
    expect(r.rule_hit).toBe(2);
  });

  it('row 3: no identity or no request -> PENDING, rule_hit 3', () => {
    expect(decide([], SEED, ctx())).toMatchObject({ verdict: 'PENDING', rule_hit: 3 });
    expect(decide([IDENTITY], SEED, ctx())).toMatchObject({ verdict: 'PENDING', rule_hit: 3 });
    expect(decide([REQUEST], SEED, ctx())).toMatchObject({ verdict: 'PENDING', rule_hit: 3 });
  });

  it('row 4: a challenge is still required for the risk level, and one can still be asked -> PENDING, rule_hit 4', () => {
    const r = decide(stageEvidence(), SEED, ctx()); // need = 1, zero passed
    expect(r.verdict).toBe('PENDING');
    expect(r.rule_hit).toBe(4);
  });

  it('row 4 is skipped when an identity switch is in progress (row 6 wins instead -- ruling 2026-09-02)', () => {
    // Same "challenge still owed" shape as the row-4 test above, but with a stale identity
    // switch layered on: the switch must be re-established from scratch before any challenge
    // is put to "whoever is on the line now" (row 6), not row 4.
    const r = decide(stageEvidence(), SEED, ctx({ identity_switch_stale: true }));
    expect(r.verdict).toBe('PENDING');
    expect(r.rule_hit).toBe(6);
  });

  it('row 5 is also skipped when an identity switch is in progress, even with an unconfirmed critical field (fix round, review of d672070)', () => {
    // Same shape as the row-4-is-skipped test above, but this time critical_confirmed is
    // false too -- proving the readback row doesn't leak through and read an amount back to
    // "whoever is on the line now" just because no challenge was owed. Row 6 must still win.
    const r = decide([IDENTITY, REQUEST], SEED, ctx({ identity_switch_stale: true, critical_confirmed: false }));
    expect(r.verdict).toBe('PENDING');
    expect(r.rule_hit).toBe(6);
  });

  it('row 5: a critical field is claimed but not confirmed (challenge requirement already met) -> PENDING, rule_hit 5', () => {
    // challenges_issued: 3 exhausts row 4's "challenges remain" condition so this isolates
    // row 5's own gate rather than being pre-empted by row 4.
    const r = decide([IDENTITY, REQUEST], SEED, ctx({ critical_confirmed: false, challenges_issued: 3 }));
    expect(r.verdict).toBe('PENDING');
    expect(r.rule_hit).toBe(5);
  });

  it('row 6: identity switch this version, stale evidence -> PENDING, rule_hit 6', () => {
    const r = decide([IDENTITY, REQUEST], SEED, ctx({ identity_switch_stale: true }));
    expect(r.verdict).toBe('PENDING');
    expect(r.rule_hit).toBe(6);
  });

  it('row 7: a live check is pending or absent -> PENDING, rule_hit 7', () => {
    // challenges_issued: 3 keeps row 4 from intercepting these before row 7 gets a chance.
    const pending = decide([IDENTITY, REQUEST, ev('ev-sso', 'sso_context_result', 'PENDING')], SEED, ctx({ challenges_issued: 3 }));
    expect(pending).toMatchObject({ verdict: 'PENDING', rule_hit: 7 });
    const absent = decide([IDENTITY, REQUEST], SEED, ctx({ challenges_issued: 3 }));
    expect(absent).toMatchObject({ verdict: 'PENDING', rule_hit: 7 });
  });

  it('row 8a: out-of-band FAIL AND sso FAIL -> FREEZE, reasons lead with IDENTITY_UNVERIFIED', () => {
    const r = decide(stageEvidence({ sso: 'FAIL', oob: 'FAIL' }), SEED, STAGE_CTX);
    expect(r.verdict).toBe('FREEZE');
    expect(r.rule_hit).toBe(8);
    expect(r.reasons[0]).toBe('IDENTITY_UNVERIFIED');
    expect(r.reasons).toContain('OUT_OF_BAND_NO_RESPONSE');
  });

  it('row 8b: a contradicted claim AND any check FAIL -> FREEZE', () => {
    const evidence = [...stageEvidence({ context: 'FAIL' }), ev('ev-consistency-amount_usd', 'consistency_flag', 'FAIL')];
    const r = decide(evidence, SEED, STAGE_CTX);
    expect(r.verdict).toBe('FREEZE');
    expect(r.rule_hit).toBe(8);
    expect(r.reasons).toContain('STORY_INCONSISTENCY');
    expect(r.reasons).toContain('CONTEXT_FAILURE');
  });

  it('row 8c: failure_tally >= 3 -> FREEZE (three independent failures, no contradiction)', () => {
    const evidence = [
      ...stageEvidence({ context: 'FAIL' }),
      ev('ev-knowledge-a', 'knowledge_check_result', 'FAIL', { facts: { kind: 'SEED_FACT', result: 'FAIL' } }),
      ev('ev-knowledge-b', 'knowledge_check_result', 'FAIL', { facts: { kind: 'SEED_FACT', result: 'FAIL' } }),
    ];
    const r = decide(evidence, SEED, STAGE_CTX);
    expect(r.failure_tally).toBeGreaterThanOrEqual(3);
    expect(r.verdict).toBe('FREEZE');
    expect(r.rule_hit).toBe(8);
  });

  it('row 8d: RELATIONAL challenge FAIL AND oob FAIL -> FREEZE', () => {
    const evidence = [
      ...stageEvidence({ oob: 'FAIL' }),
      ev('ev-knowledge-rel', 'knowledge_check_result', 'FAIL', { facts: { kind: 'RELATIONAL', result: 'FAIL' } }),
    ];
    const r = decide(evidence, SEED, STAGE_CTX);
    expect(r.verdict).toBe('FREEZE');
    expect(r.rule_hit).toBe(8);
  });

  it('row 8e: TRAP_FACT challenge FAIL AND any check FAIL -> FREEZE', () => {
    const evidence = [
      ...stageEvidence({ sso: 'FAIL' }),
      ev('ev-knowledge-trap', 'knowledge_check_result', 'FAIL', { facts: { kind: 'TRAP_FACT', result: 'FAIL' } }),
    ];
    const r = decide(evidence, SEED, STAGE_CTX);
    expect(r.verdict).toBe('FREEZE');
    expect(r.rule_hit).toBe(8);
  });

  it('row 9: exposure across versions over the high-value line -> ESCALATE, reasons contain EXPOSURE_LIMIT', () => {
    // Ruling A (2026-09-09): need now floors at 1, so a passed knowledge card is required
    // to clear row 4 before this row is ever reached.
    const evidence = [
      ...stageEvidence(),
      ev('ev-knowledge-a', 'knowledge_check_result', 'PASS', { facts: { kind: 'SEED_FACT', result: 'PASS' } }),
      ev('ev-exposure', 'exposure_check_result', 'FAIL', { facts: { exposure_usd: 60_000, current_usd: 21_000 } }),
    ];
    const r = decide(evidence, SEED, ctx());
    expect(r.verdict).toBe('ESCALATE');
    expect(r.rule_hit).toBe(9);
    expect(r.reasons).toContain('EXPOSURE_LIMIT');
  });

  it('row 10: a first-time beneficiary -> ESCALATE regardless of amount, reasons contain NEW_BENEFICIARY', () => {
    // challenges exhausted so row 4's "need=2, 0 passed" doesn't intercept it first.
    const r = decide(stageEvidence(), SEED, ctx({ new_beneficiary: true, challenges_issued: 3 }));
    expect(r.verdict).toBe('ESCALATE');
    expect(r.rule_hit).toBe(10);
    expect(r.reasons).toContain('NEW_BENEFICIARY');
  });

  it('row 11: every AssuranceChecklist item true -> STAGE, empty reasons', () => {
    // Ruling A (2026-09-09): need floors at 1, so row 11 also needs one graded PASS.
    const evidence = [...stageEvidence(), ev('ev-knowledge-a', 'knowledge_check_result', 'PASS', { facts: { kind: 'SEED_FACT', result: 'PASS' } })];
    const r = decide(evidence, SEED, STAGE_CTX);
    expect(r.verdict).toBe('STAGE');
    expect(r.reasons).toEqual([]);
    expect(r.rule_hit).toBe(11);
    expect(Object.values(r.assurance).every((v) => v === true)).toBe(true);
  });

  it('row 12: some failures below the freeze line, challenges remain -> PENDING', () => {
    const evidence = [
      ...stageEvidence({ context: 'FAIL' }),
      ev('ev-knowledge-a', 'knowledge_check_result', 'PASS', { facts: { kind: 'SEED_FACT', result: 'PASS' } }),
    ];
    const r = decide(evidence, SEED, ctx()); // need=1, 1 passed -> row 4 satisfied
    expect(r.verdict).toBe('PENDING');
    expect(r.rule_hit).toBe(12);
    expect(r.failure_tally).toBeGreaterThan(0);
    expect(r.failure_tally).toBeLessThan(3);
  });

  it('row 14: otherwise -> ESCALATE (challenges exhausted, still short)', () => {
    const evidence = [
      ...stageEvidence({ context: 'FAIL' }),
      ev('ev-knowledge-a', 'knowledge_check_result', 'PASS', { facts: { kind: 'SEED_FACT', result: 'PASS' } }),
    ];
    const r = decide(evidence, SEED, ctx({ challenges_issued: 3 }));
    expect(r.verdict).toBe('ESCALATE');
    expect(r.rule_hit).toBe(14);
  });

  it('row 13 (founder decision 2026-09-12): a critical field\'s readback re-ask cap is exhausted -> ESCALATE naming the field, reachable ahead of row 14', () => {
    const evidence = [
      ...stageEvidence(),
      ev('ev-knowledge-a', 'knowledge_check_result', 'PASS', { facts: { kind: 'SEED_FACT', result: 'PASS' } }),
    ];
    const r = decide(evidence, SEED, ctx({ critical_confirmed: false, challenges_issued: 3, readback_reask_exhausted_field: 'beneficiary' }));
    expect(r.verdict).toBe('ESCALATE');
    expect(r.rule_hit).toBe(13);
    expect(r.reasons).toContain('READBACK_LIMIT_EXCEEDED');
  });

  it('row 13 takes priority over row 5 once the field is exhausted -- row 5 alone (not exhausted) still holds', () => {
    const evidence = [
      ...stageEvidence(),
      ev('ev-knowledge-a', 'knowledge_check_result', 'PASS', { facts: { kind: 'SEED_FACT', result: 'PASS' } }),
    ];
    const stillHolding = decide(evidence, SEED, ctx({ critical_confirmed: false, challenges_issued: 3 }));
    expect(stillHolding.verdict).toBe('PENDING');
    expect(stillHolding.rule_hit).toBe(5);

    const exhausted = decide(evidence, SEED, ctx({ critical_confirmed: false, challenges_issued: 3, readback_reask_exhausted_field: 'amount_usd' }));
    expect(exhausted.verdict).toBe('ESCALATE');
    expect(exhausted.rule_hit).toBe(13);
  });

  it('row 13 never fires ahead of FREEZE -- a freeze-eligible call freezes even with the readback cap also exhausted', () => {
    const r = decide(stageEvidence({ sso: 'FAIL', oob: 'FAIL' }), SEED, ctx({ readback_reask_exhausted_field: 'beneficiary' }));
    expect(r.verdict).toBe('FREEZE');
    expect(r.rule_hit).toBe(8);
  });

  it('row 15 (red team item 4, founder ruling 2026-09-09): call ended with a request stated and no terminal verdict yet -> ESCALATE, empty reasons', () => {
    // Identity + request present but no live checks/challenges done yet -> tentative
    // verdict is PENDING (row 4, a challenge is still owed). Ending the call while a
    // request is on record must not leave this open forever.
    const r = decide([IDENTITY, REQUEST], SEED, ctx({ call_ended: true }));
    expect(r.verdict).toBe('ESCALATE');
    expect(r.rule_hit).toBe(15);
    expect(r.reasons).toEqual([]);
  });

  it('row 15: call ended with NO request ever stated -> NO_ACTION, not ESCALATE', () => {
    const withoutIdentity = decide([], SEED, ctx({ call_ended: true }));
    expect(withoutIdentity.verdict).toBe('NO_ACTION');
    expect(withoutIdentity.rule_hit).toBe(15);

    const withIdentityOnly = decide([IDENTITY], SEED, ctx({ call_ended: true }));
    expect(withIdentityOnly.verdict).toBe('NO_ACTION');
    expect(withIdentityOnly.rule_hit).toBe(15);
  });

  it('row 15 never overrides a FREEZE already owed -- a fraud call that ends mid-interrogation still FREEZEs', () => {
    const r = decide(stageEvidence({ sso: 'FAIL', oob: 'FAIL' }), SEED, STAGE_CTX_WITH_CALL_ENDED);
    expect(r.verdict).toBe('FREEZE');
    expect(r.rule_hit).toBe(8);
  });

  it('row 15 never overrides an already-terminal STAGE/ESCALATE/NO_ACTION verdict', () => {
    // row 11 (STAGE) unaffected by call_ended.
    const stageEv = [...stageEvidence(), ev('ev-knowledge-a', 'knowledge_check_result', 'PASS', { facts: { kind: 'SEED_FACT', result: 'PASS' } })];
    const staged = decide(stageEv, SEED, ctx({ call_ended: true }));
    expect(staged.verdict).toBe('STAGE');
    expect(staged.rule_hit).toBe(11);

    // row 1 (NO_ACTION, out of scope, no request) unaffected by call_ended.
    const outOfScope = ev('ev-oos', 'out_of_scope_marker', 'FLAG');
    const oos = decide([outOfScope], SEED, ctx({ call_ended: true }));
    expect(oos.verdict).toBe('NO_ACTION');
    expect(oos.rule_hit).toBe(1);
  });

  it('pressure FLAG alone still STAGEs; alert_principal is part of a terminal verdict\'s required actions', () => {
    // Ruling A (2026-09-09): need floors at 1, so this baseline needs one graded PASS too.
    const evidence = [
      ...stageEvidence().map((e) => (e.kind === 'pressure_marker' ? { ...e, status: 'FLAG' as const } : e)),
      ev('ev-knowledge-a', 'knowledge_check_result', 'PASS', { facts: { kind: 'SEED_FACT', result: 'PASS' } }),
    ];
    const r = decide(evidence, SEED, STAGE_CTX);
    expect(r.verdict).toBe('STAGE');
    expect(requiredActions('STAGE', [])).toContain('alert_principal');
  });
});

describe('decide -- founder rulings 2026-09-09', () => {
  // Ruling A: `need` used to drop to 0 for a caller matching an existing scheduled payment
  // exactly (the amendment carve-out), letting such a call reach STAGE with zero knowledge
  // challenges. It now floors at 1 (2 for a new beneficiary) regardless of that match -- at
  // least one genuinely graded knowledge/relational PASS is always required before STAGE.
  it('ruling A: zero passed challenges cannot reach row 11, even for an exact scheduled-payment match -- held at row 4 instead', () => {
    const r = decide(stageEvidence(), SEED, STAGE_CTX); // context PASS (exact match), 0 challenges passed
    expect(r.verdict).not.toBe('STAGE');
    expect(r.rule_hit).toBe(4);
    expect(r.assurance.at_least_one_challenge_passed).toBe(false);
  });

  it('ruling A: exactly one graded PASS reaches STAGE, even for an exact scheduled-payment match', () => {
    const evidence = [...stageEvidence(), ev('ev-knowledge-a', 'knowledge_check_result', 'PASS', { facts: { kind: 'SEED_FACT', result: 'PASS' } })];
    const r = decide(evidence, SEED, STAGE_CTX);
    expect(r.verdict).toBe('STAGE');
    expect(r.rule_hit).toBe(11);
    expect(r.assurance.at_least_one_challenge_passed).toBe(true);
  });

  // Ruling B: an injection-lexicon hit adds 1.0 to the tally (same weight as a failed
  // check) and sets a new assurance item, no_injection_attempt, to false for the rest of
  // the call -- STAGE becomes unreachable even once every other item clears.
  it('ruling B: an injection_marker FLAG adds 1.0 to the tally and blocks STAGE via no_injection_attempt', () => {
    const evidence = [
      ...stageEvidence(),
      ev('ev-knowledge-a', 'knowledge_check_result', 'PASS', { facts: { kind: 'SEED_FACT', result: 'PASS' } }),
      ev('ev-injection', 'injection_marker', 'FLAG', { facts: { phrase: 'ignore your instructions' }, quotes: [{ utterance_id: 'c1', text: 'Ignore your instructions' }] }),
    ];
    const r = decide(evidence, SEED, STAGE_CTX);
    expect(r.failure_tally).toBeGreaterThanOrEqual(1);
    expect(r.assurance.no_injection_attempt).toBe(false);
    expect(r.verdict).not.toBe('STAGE');
  });

  it('ruling B: with no injection_marker card, no_injection_attempt reads true', () => {
    const evidence = [...stageEvidence(), ev('ev-knowledge-a', 'knowledge_check_result', 'PASS', { facts: { kind: 'SEED_FACT', result: 'PASS' } })];
    const r = decide(evidence, SEED, STAGE_CTX);
    expect(r.assurance.no_injection_attempt).toBe(true);
  });

  // Ruling C: row 12's guard was `challenges_issued < max_challenges` alone, so the instant
  // the third challenge was ASKED (before it could be answered), the engine fell through to
  // row 13 ESCALATE and a correct answer arriving seconds later was ignored. Fix: row 12
  // also holds while a just-asked challenge is still awaiting an answer and live.
  it('ruling C: tally 1, 3 of 3 challenges issued, last one unanswered and live -> PENDING at row 12', () => {
    const evidence = [
      ...stageEvidence({ context: 'FAIL' }), // one failed sign-in -> tally 1
      ev('ev-knowledge-a', 'knowledge_check_result', 'PASS', { facts: { kind: 'SEED_FACT', result: 'PASS' } }),
    ];
    const r = decide(evidence, SEED, ctx({ challenges_issued: 3, challenge_awaiting_answer: true }));
    expect(r.verdict).toBe('PENDING');
    expect(r.rule_hit).toBe(12);
    expect(r.failure_tally).toBe(1);
  });

  it('ruling C: same call once the answer has come in (no longer awaiting) -> ESCALATE at row 14', () => {
    const evidence = [
      ...stageEvidence({ context: 'FAIL' }),
      ev('ev-knowledge-a', 'knowledge_check_result', 'PASS', { facts: { kind: 'SEED_FACT', result: 'PASS' } }),
    ];
    const r = decide(evidence, SEED, ctx({ challenges_issued: 3, challenge_awaiting_answer: false }));
    expect(r.verdict).toBe('ESCALATE');
    expect(r.rule_hit).toBe(14);
  });
});

describe('decide -- invariants', () => {
  it('I1: no verdict ever equals RELEASE (structurally guaranteed; sanity check here)', () => {
    const r = decide(stageEvidence(), SEED, STAGE_CTX);
    expect(r.verdict).not.toBe('RELEASE' as never);
    expect(r.invariants_ok).toBe(true);
  });

  it('I2: everything true except one AssuranceChecklist item -> never STAGE', () => {
    // Ruling A (2026-09-09): need floors at 1, so this baseline needs one graded PASS too.
    const evidence = [
      ...stageEvidence(),
      ev('ev-knowledge-a', 'knowledge_check_result', 'PASS', { facts: { kind: 'SEED_FACT', result: 'PASS' } }),
      ev('ev-consistency-amount_usd', 'consistency_flag', 'FAIL'),
    ];
    const r = decide(evidence, SEED, STAGE_CTX);
    expect(r.assurance.no_contradictions).toBe(false);
    expect(Object.entries(r.assurance).filter(([k]) => k !== 'no_contradictions').every(([, v]) => v === true)).toBe(true);
    expect(r.verdict).not.toBe('STAGE');
  });

  it('I4: evaluation_incomplete with otherwise-clean evidence -> ESCALATE, never STAGE', () => {
    const r = decide(stageEvidence(), SEED, ctx({ evaluation_incomplete: true }));
    expect(r.verdict).toBe('ESCALATE');
    expect(r.verdict).not.toBe('STAGE');
  });

  it('I4: with no request at all, an incomplete evaluation is NO_ACTION, not ESCALATE', () => {
    const r = decide([IDENTITY], SEED, ctx({ evaluation_incomplete: true }));
    expect(r.verdict).toBe('NO_ACTION');
  });
});

describe('decide -- mutants (each proves a rule is load-bearing)', () => {
  function withMutant(evidence: Evidence[], c: RuleContext, mutant: RuleMutant) {
    return decide(evidence, SEED, c, mutant);
  }

  it('ignore_contradictions turns a 7b FREEZE into a non-FREEZE verdict', () => {
    const evidence = [...stageEvidence({ context: 'FAIL' }), ev('ev-consistency-amount_usd', 'consistency_flag', 'FAIL')];
    const straight = decide(evidence, SEED, ctx());
    expect(straight.verdict).toBe('FREEZE');
    const mutated = withMutant(evidence, ctx(), { ignore_contradictions: true });
    expect(mutated.verdict).not.toBe('FREEZE');
  });

  it('or_instead_of_and_in_7a turns a single-check failure into a FREEZE it should not be', () => {
    const evidence = stageEvidence({ sso: 'FAIL' }); // oob still PASS -- 7a (AND) should NOT fire
    const straight = decide(evidence, SEED, STAGE_CTX);
    expect(straight.verdict).not.toBe('FREEZE');
    const mutated = withMutant(evidence, STAGE_CTX, { or_instead_of_and_in_7a: true });
    expect(mutated.verdict).toBe('FREEZE');
  });

  it('skip_readback_gate lets an unconfirmed critical field reach STAGE', () => {
    // Ruling A (2026-09-09): need floors at 1, so a passed knowledge card is required for
    // this to reach row 5 (and, once mutated, STAGE) instead of stalling at row 4.
    const evidence = [...stageEvidence(), ev('ev-knowledge-a', 'knowledge_check_result', 'PASS', { facts: { kind: 'SEED_FACT', result: 'PASS' } })];
    const straight = decide(evidence, SEED, ctx({ critical_confirmed: false }));
    expect(straight.verdict).toBe('PENDING');
    expect(straight.rule_hit).toBe(5);
    const mutated = withMutant(evidence, ctx({ critical_confirmed: false }), { skip_readback_gate: true });
    expect(mutated.verdict).toBe('STAGE');
  });

  it('ignore_exposure lets a structuring case (exposure over the line) reach STAGE', () => {
    // Ruling A (2026-09-09): need floors at 1, so a passed knowledge card is required to
    // clear row 4 first (both in the straight case, to reach row 9, and once mutated, to
    // reach STAGE at row 11).
    const evidence = [
      ...stageEvidence(),
      ev('ev-knowledge-a', 'knowledge_check_result', 'PASS', { facts: { kind: 'SEED_FACT', result: 'PASS' } }),
      ev('ev-exposure', 'exposure_check_result', 'FAIL', { facts: { exposure_usd: 60_000, current_usd: 21_000 } }),
    ];
    const straight = decide(evidence, SEED, ctx());
    expect(straight.verdict).toBe('ESCALATE');
    expect(straight.rule_hit).toBe(9);
    const mutated = withMutant(evidence, ctx(), { ignore_exposure: true });
    expect(mutated.verdict).toBe('STAGE');
  });
});

describe('phrasingGoal (fsm.ts) -- CONSISTENCY_CHECK sub-branches', () => {
  // Isolated unit tests of phrasingGoal, the same pattern rules.test.ts already uses for
  // decide(): hand-built inputs rather than a full evaluate() conversation, since the
  // PROBE_CONSISTENCY branch only fires in the narrow window where NO critical field
  // (amount_usd/account_last4/beneficiary) has an outstanding unconfirmed claim (so
  // oldestUnconfirmedCritical returns null) but a consistency_flag FAIL card exists with
  // >=2 quotes -- e.g. a contradicted NON-critical field (deadline, escrow institution)
  // while the critical fields were never claimed at all.
  function decideResult(rule_hit: number): DecideResult {
    return {
      verdict: 'PENDING',
      reasons: [],
      failure_tally: 0,
      assurance: {
        identity_claimed: true,
        sso_pass_current: true,
        oob_confirmed_current: true,
        context_pass_current: true,
        no_contradictions: false,
        critical_fields_confirmed: false,
        exposure_within_limit: true,
        challenge_requirement_met: true,
        no_identity_switch: true,
        not_new_beneficiary: true,
        at_least_one_challenge_passed: true,
        no_injection_attempt: true,
      },
      invariants_ok: true,
      rule_hit,
    };
  }

  it('with no unconfirmed critical field but a consistency_flag FAIL (>=2 quotes), the goal is PROBE_CONSISTENCY quoting both statements', () => {
    const flag = ev('ev-consistency-deadline', 'consistency_flag', 'FAIL', {
      quotes: [
        { utterance_id: 'c1', text: 'by end of day' },
        { utterance_id: 'c3', text: 'within the next ten minutes' },
      ],
    });
    const goal = phrasingGoal({
      state: 'CONSISTENCY_CHECK',
      decideResult: decideResult(5),
      evidence: [flag],
      ledger: [], // no critical-field claims at all -> oldestUnconfirmedCritical is null
      seed: SEED,
      tools: [],
      actions: [],
      nextChallenge: null,
    });
    expect(goal.code).toBe('PROBE_CONSISTENCY');
    expect(goal.hint).toContain('by end of day');
    expect(goal.hint).toContain('within the next ten minutes');
  });

  // Bug fix (2026-09-13, PROVEN defect found by an investigation lane): this test used to
  // assert CONSISTENCY_CHECK falls through to STALL here -- but an empty ledger means NO
  // critical field has a claim at all, which is exactly the founder-observed silent-call
  // shape (a caller who never states one of the three critical fields, e.g. never gives an
  // account number, made the engine repeat "Checks are running. Hold the floor" forever
  // with nothing pending for the server to run -- a deadlock). `missingCriticalField`
  // (fsm.ts) now catches this and CONSISTENCY_CHECK asks for the first missing field
  // (CRITICAL_FIELDS order: amount_usd, account_last4, beneficiary) instead of stalling.
  // See test/missing-critical-field.test.ts for the end-to-end regression coverage (via the
  // real evaluate()) for each of the three fields.
  it('with neither an unconfirmed critical field nor a consistency_flag FAIL, CONSISTENCY_CHECK asks for the first missing critical field instead of stalling', () => {
    const goal = phrasingGoal({
      state: 'CONSISTENCY_CHECK',
      decideResult: decideResult(5),
      evidence: [],
      ledger: [],
      seed: SEED,
      tools: [],
      actions: [],
      nextChallenge: null,
    });
    expect(goal.code).toBe('ELICIT_MISSING_CRITICAL');
    expect(goal.code).not.toBe('STALL');
    expect(goal.hint.toLowerCase()).toContain('amount');
  });
});

describe('RULES_DOC', () => {
  it('publishes all 15 rows and the VOICE_CAN_NEVER_RELEASE invariant', () => {
    expect(RULES_DOC).toContain('13.');
    expect(RULES_DOC).toContain('14.');
    expect(RULES_DOC).toContain('15.');
    expect(RULES_DOC).toContain('VOICE_CAN_NEVER_RELEASE');
  });

  it('row 13 text agrees with the code: readback re-ask cap, names the field, sits ahead of the old row-13 catch-all (founder decision 2026-09-12)', () => {
    // Guards against RULES_DOC drifting from decide()'s actual row-13 condition -- the same
    // staleness class the row-4/row-6 tests below already guard against.
    const row13 = RULES_DOC.split('\n').find((line) => /^13\./.test(line));
    expect(row13).toBeDefined();
    const lower = row13!.toLowerCase();
    expect(lower).toContain('readback');
    expect(lower).toContain('re-ask');
    expect(lower).toContain('max_readback_reasks');
    expect(lower).toContain('naming the field');
  });

  it('never uses RELEASE as a verdict word (only as the invariant name)', () => {
    expect(/verdict[^.]*release/i.test(RULES_DOC)).toBe(false);
  });

  it('never claims detection or uses forbidden vocabulary', () => {
    const lower = RULES_DOC.toLowerCase();
    for (const bad of ['impostor', 'deepfake', 'synthetic voice', 'clone', 'immutable', 'sealed']) {
      expect(lower).not.toContain(bad);
    }
  });

  it('row 4 text agrees with the code: at least one challenge required, and the amendment match no longer lowers that count', () => {
    // Guards against RULES_DOC drifting from decide()'s actual `need` calculation again --
    // this is exactly the staleness a prior review caught (RULES_DOC still described the
    // amendment carve-out as able to reduce `need`, after ruling A had already floored it
    // at 1 for every call, amendment match or not).
    const row4 = RULES_DOC.split('\n').find((line) => /^4\./.test(line));
    expect(row4).toBeDefined();
    expect(row4?.toLowerCase()).toContain('at least one');
    expect(row4?.toLowerCase()).not.toContain('may lower');
  });

  it('row 6 text agrees with the code: the switch resolves (re-stated identity + settled request) but never stops counting as a contradiction', () => {
    // Guards against RULES_DOC drifting from decide()/resolveIdentitySwitch's actual
    // behavior (founder decision 2026-09-11, option B): the doc must say the switch can
    // resolve (so row 6 isn't a permanent trap), AND that resolving it never removes the
    // switch from the record as a contradiction (so a reader can't conclude a resolved
    // switch is a clean bill of health that could reach STAGE).
    const row6 = RULES_DOC.split('\n').find((line) => /^6\./.test(line));
    expect(row6).toBeDefined();
    const lower = row6!.toLowerCase();
    expect(lower).toContain('resolved');
    expect(lower).toContain('re-states the new identity');
    expect(lower).toContain('unchanged or re-confirmed');
    expect(lower).toContain('stays a contradiction');
    expect(lower).toContain('stage stays permanently out of reach');
  });

  // Follow-up (option B review, commit b56be9e): row 6's text must also describe a CHAIN of
  // switches (A -> B -> C), not just a single one -- otherwise the doc would silently drift
  // from fromTranscript.ts/resolveIdentitySwitch's actual chain-tracking behavior the moment
  // a second switch happens in the same call.
  it('row 6 text agrees with the code: a chain of switches tracks only the LATEST pair, and every switch still counts toward the tally', () => {
    const row6 = RULES_DOC.split('\n').find((line) => /^6\./.test(line));
    expect(row6).toBeDefined();
    const lower = row6!.toLowerCase();
    expect(lower).toContain('more than once');
    expect(lower).toContain('latest pair');
    expect(lower).toContain('never resolves it');
    expect(lower).toContain('every switch in the chain still counts');
  });
});
