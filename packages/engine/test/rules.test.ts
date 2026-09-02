// packages/engine/test/rules.test.ts
// THE RULE TABLE: one `it` per row (1-13), plus the four invariants, plus the mutation
// hooks that prove every rule is load-bearing. Evidence arrays are hand-built with `ev()`
// so this file exercises `decide` in isolation, without going through the ledger/tool
// machinery `evaluate` composes (that's evaluate.test.ts's job).
import { describe, expect, it } from 'vitest';
import { decide, RULES_DOC } from '../src/rules';
import type { RuleContext, RuleMutant } from '../src/rules';
import { requiredActions } from '../src/fsm';
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
    amendment_only: false,
    exposure_usd: 0,
    evaluation_incomplete: false,
    critical_confirmed: true,
    identity_switch_stale: false,
    ...overrides,
  };
}

const IDENTITY = ev('ev-identity', 'identity_claim', 'INFO');
const REQUEST = ev('ev-request', 'request_params', 'INFO');

/** A fully-clean, "everything checks out" evidence set: identity + request known, all
 *  three live checks PASS, no contradictions, no failed challenges. With
 *  ctx({ amendment_only: true }) (need = 0, since context reads PASS) this reaches row 11
 *  and STAGEs -- the baseline every other row-test perturbs one thing away from. */
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

const STAGE_CTX = ctx({ amendment_only: true });

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

  it('row 4: a critical field is claimed but not confirmed -> PENDING, rule_hit 4', () => {
    const r = decide([IDENTITY, REQUEST], SEED, ctx({ critical_confirmed: false }));
    expect(r.verdict).toBe('PENDING');
    expect(r.rule_hit).toBe(4);
  });

  it('row 5: identity switch this version, stale evidence -> PENDING, rule_hit 5', () => {
    const r = decide([IDENTITY, REQUEST], SEED, ctx({ identity_switch_stale: true }));
    expect(r.verdict).toBe('PENDING');
    expect(r.rule_hit).toBe(5);
  });

  it('row 6: a live check is pending or absent -> PENDING, rule_hit 6', () => {
    const pending = decide([IDENTITY, REQUEST, ev('ev-sso', 'sso_context_result', 'PENDING')], SEED, ctx());
    expect(pending).toMatchObject({ verdict: 'PENDING', rule_hit: 6 });
    const absent = decide([IDENTITY, REQUEST], SEED, ctx());
    expect(absent).toMatchObject({ verdict: 'PENDING', rule_hit: 6 });
  });

  it('row 7a: out-of-band FAIL AND sso FAIL -> FREEZE, reasons lead with IDENTITY_UNVERIFIED', () => {
    const r = decide(stageEvidence({ sso: 'FAIL', oob: 'FAIL' }), SEED, STAGE_CTX);
    expect(r.verdict).toBe('FREEZE');
    expect(r.rule_hit).toBe(7);
    expect(r.reasons[0]).toBe('IDENTITY_UNVERIFIED');
    expect(r.reasons).toContain('OUT_OF_BAND_NO_RESPONSE');
  });

  it('row 7b: a contradicted claim AND any check FAIL -> FREEZE', () => {
    const evidence = [...stageEvidence({ context: 'FAIL' }), ev('ev-consistency-amount_usd', 'consistency_flag', 'FAIL')];
    const r = decide(evidence, SEED, STAGE_CTX);
    expect(r.verdict).toBe('FREEZE');
    expect(r.rule_hit).toBe(7);
    expect(r.reasons).toContain('STORY_INCONSISTENCY');
    expect(r.reasons).toContain('CONTEXT_FAILURE');
  });

  it('row 7c: failure_tally >= 3 -> FREEZE (three independent failures, no contradiction)', () => {
    const evidence = [
      ...stageEvidence({ context: 'FAIL' }),
      ev('ev-knowledge-a', 'knowledge_check_result', 'FAIL', { facts: { kind: 'SEED_FACT', result: 'FAIL' } }),
      ev('ev-knowledge-b', 'knowledge_check_result', 'FAIL', { facts: { kind: 'SEED_FACT', result: 'FAIL' } }),
    ];
    const r = decide(evidence, SEED, STAGE_CTX);
    expect(r.failure_tally).toBeGreaterThanOrEqual(3);
    expect(r.verdict).toBe('FREEZE');
    expect(r.rule_hit).toBe(7);
  });

  it('row 7d: RELATIONAL challenge FAIL AND oob FAIL -> FREEZE', () => {
    const evidence = [
      ...stageEvidence({ oob: 'FAIL' }),
      ev('ev-knowledge-rel', 'knowledge_check_result', 'FAIL', { facts: { kind: 'RELATIONAL', result: 'FAIL' } }),
    ];
    const r = decide(evidence, SEED, STAGE_CTX);
    expect(r.verdict).toBe('FREEZE');
    expect(r.rule_hit).toBe(7);
  });

  it('row 7e: TRAP_FACT challenge FAIL AND any check FAIL -> FREEZE', () => {
    const evidence = [
      ...stageEvidence({ sso: 'FAIL' }),
      ev('ev-knowledge-trap', 'knowledge_check_result', 'FAIL', { facts: { kind: 'TRAP_FACT', result: 'FAIL' } }),
    ];
    const r = decide(evidence, SEED, STAGE_CTX);
    expect(r.verdict).toBe('FREEZE');
    expect(r.rule_hit).toBe(7);
  });

  it('row 8: not enough passed challenges yet, and challenges remain -> PENDING, rule_hit 8', () => {
    const r = decide(stageEvidence(), SEED, ctx({ amendment_only: false })); // need = 1, zero passed
    expect(r.verdict).toBe('PENDING');
    expect(r.rule_hit).toBe(8);
  });

  it('row 9: exposure across versions over the high-value line -> ESCALATE, reasons contain EXPOSURE_LIMIT', () => {
    const evidence = [...stageEvidence(), ev('ev-exposure', 'exposure_check_result', 'FAIL', { facts: { exposure_usd: 60_000, current_usd: 21_000 } })];
    const r = decide(evidence, SEED, ctx({ amendment_only: true, exposure_usd: 60_000 }));
    expect(r.verdict).toBe('ESCALATE');
    expect(r.rule_hit).toBe(9);
    expect(r.reasons).toContain('EXPOSURE_LIMIT');
  });

  it('row 10: a first-time beneficiary -> ESCALATE regardless of amount, reasons contain NEW_BENEFICIARY', () => {
    // challenges exhausted so row 8's "need=2, 0 passed" doesn't intercept it first.
    const r = decide(stageEvidence(), SEED, ctx({ amendment_only: true, new_beneficiary: true, challenges_issued: 3 }));
    expect(r.verdict).toBe('ESCALATE');
    expect(r.rule_hit).toBe(10);
    expect(r.reasons).toContain('NEW_BENEFICIARY');
  });

  it('row 11: every AssuranceChecklist item true -> STAGE, empty reasons', () => {
    const r = decide(stageEvidence(), SEED, STAGE_CTX);
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
    const r = decide(evidence, SEED, ctx({ amendment_only: false })); // need=1, 1 passed -> row 8 satisfied
    expect(r.verdict).toBe('PENDING');
    expect(r.rule_hit).toBe(12);
    expect(r.failure_tally).toBeGreaterThan(0);
    expect(r.failure_tally).toBeLessThan(3);
  });

  it('row 13: otherwise -> ESCALATE (challenges exhausted, still short)', () => {
    const evidence = [
      ...stageEvidence({ context: 'FAIL' }),
      ev('ev-knowledge-a', 'knowledge_check_result', 'PASS', { facts: { kind: 'SEED_FACT', result: 'PASS' } }),
    ];
    const r = decide(evidence, SEED, ctx({ amendment_only: false, challenges_issued: 3 }));
    expect(r.verdict).toBe('ESCALATE');
    expect(r.rule_hit).toBe(13);
  });

  it('pressure FLAG alone still STAGEs; alert_principal is part of a terminal verdict\'s required actions', () => {
    const evidence = stageEvidence().map((e) => (e.kind === 'pressure_marker' ? { ...e, status: 'FLAG' as const } : e));
    const r = decide(evidence, SEED, STAGE_CTX);
    expect(r.verdict).toBe('STAGE');
    expect(requiredActions('STAGE', [])).toContain('alert_principal');
  });
});

describe('decide -- invariants', () => {
  it('I1: no verdict ever equals RELEASE (structurally guaranteed; sanity check here)', () => {
    const r = decide(stageEvidence(), SEED, STAGE_CTX);
    expect(r.verdict).not.toBe('RELEASE' as never);
    expect(r.invariants_ok).toBe(true);
  });

  it('I2: everything true except one AssuranceChecklist item -> never STAGE', () => {
    const evidence = [...stageEvidence(), ev('ev-consistency-amount_usd', 'consistency_flag', 'FAIL')];
    const r = decide(evidence, SEED, STAGE_CTX);
    expect(r.assurance.no_contradictions).toBe(false);
    expect(Object.entries(r.assurance).filter(([k]) => k !== 'no_contradictions').every(([, v]) => v === true)).toBe(true);
    expect(r.verdict).not.toBe('STAGE');
  });

  it('I4: evaluation_incomplete with otherwise-clean evidence -> ESCALATE, never STAGE', () => {
    const r = decide(stageEvidence(), SEED, ctx({ amendment_only: true, evaluation_incomplete: true }));
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
    const straight = decide(evidence, SEED, ctx({ amendment_only: false }));
    expect(straight.verdict).toBe('FREEZE');
    const mutated = withMutant(evidence, ctx({ amendment_only: false }), { ignore_contradictions: true });
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
    const evidence = stageEvidence();
    const straight = decide(evidence, SEED, ctx({ amendment_only: true, critical_confirmed: false }));
    expect(straight.verdict).toBe('PENDING');
    expect(straight.rule_hit).toBe(4);
    const mutated = withMutant(evidence, ctx({ amendment_only: true, critical_confirmed: false }), { skip_readback_gate: true });
    expect(mutated.verdict).toBe('STAGE');
  });

  it('ignore_exposure lets a structuring case (exposure over the line) reach STAGE', () => {
    const evidence = [...stageEvidence(), ev('ev-exposure', 'exposure_check_result', 'FAIL', { facts: { exposure_usd: 60_000, current_usd: 21_000 } })];
    const straight = decide(evidence, SEED, ctx({ amendment_only: true, exposure_usd: 60_000 }));
    expect(straight.verdict).toBe('ESCALATE');
    expect(straight.rule_hit).toBe(9);
    const mutated = withMutant(evidence, ctx({ amendment_only: true, exposure_usd: 60_000 }), { ignore_exposure: true });
    expect(mutated.verdict).toBe('STAGE');
  });
});

describe('RULES_DOC', () => {
  it('publishes all 13 rows and the VOICE_CAN_NEVER_RELEASE invariant', () => {
    expect(RULES_DOC).toContain('13.');
    expect(RULES_DOC).toContain('VOICE_CAN_NEVER_RELEASE');
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
});
