// packages/engine/src/rules.ts
// THE RULE TABLE (v2) -- the deny/allow logic that turns evidence into a verdict. First
// match wins. This file is the deterministic core: no LLM call, no randomness, no clock
// read. Same (evidence, seed, ctx, mutant) in -> same result out, always.
//
// LAW 2: STAGE is the positive ceiling. There is no RELEASE verdict, tool, or action
// anywhere in this file or its output. LAW 3: this is the only place a verdict is decided.
// See amendment-v2-brief.md section D (the 13-row table + 4 invariants) -- this file is
// that table, implemented, and RULES_DOC below is that table, published verbatim.
import type { AssuranceChecklist, Evidence, EvidenceKind, SeedConfig, Verdict, VerdictReason } from './types.js';

export interface RuleContext {
  request_version: number;
  challenges_issued: number;
  max_challenges: number;
  new_beneficiary: boolean;
  amendment_only: boolean;
  evaluation_incomplete: boolean;
  critical_confirmed: boolean;
  identity_switch_stale: boolean;
}

/** Deliberate rule-breaks used only by test/mutants.test.ts to prove each rule is
 *  load-bearing (README section "Break the rules and watch the tests fail"). Never used
 *  outside tests -- `evaluate` never passes a mutant. */
export type RuleMutant = {
  ignore_contradictions?: true;
  or_instead_of_and_in_7a?: true;
  skip_readback_gate?: true;
  ignore_exposure?: true;
};

export interface DecideResult {
  verdict: Verdict;
  reasons: VerdictReason[];
  failure_tally: number;
  assurance: AssuranceChecklist;
  invariants_ok: boolean;
  rule_hit: number; // which table row (1-13) produced the tentative verdict; 0 = invariant override
}

function find(evidence: Evidence[], kind: EvidenceKind): Evidence | undefined {
  let found: Evidence | undefined;
  for (const e of evidence) if (e.kind === kind) found = e; // last of this kind wins (post-override)
  return found;
}

function findAll(evidence: Evidence[], kind: EvidenceKind): Evidence[] {
  return evidence.filter((e) => e.kind === kind);
}

const CRITICAL_TALLY_CAP = 2;

/** Tally: independent FAILED checks toward the freeze/escalate thresholds. AMBIGUOUS/REFUSED
 *  challenges (surfaced as FLAG knowledge cards whose facts.result isn't PASS/FAIL) count
 *  0.5; pressure, injection and identity-switch cards count 0 (behavior, not proof; identity
 *  switch resets state instead of accruing tally). */
function computeTally(
  evidence: Evidence[],
  mutant: RuleMutant | undefined,
): { tally: number; ssoFail: boolean; oobFail: boolean; contextFail: boolean; hasContradiction: boolean; contradictionCount: number } {
  const ssoEv = find(evidence, 'sso_context_result');
  const oobEv = find(evidence, 'oob_verification_result');
  const contextEv = find(evidence, 'context_check_result');
  const ssoFail = ssoEv?.status === 'FAIL';
  const oobFail = oobEv?.status === 'FAIL';
  const contextFail = contextEv?.status === 'FAIL';

  const consistencyFails = findAll(evidence, 'consistency_flag').filter((e) => e.status === 'FAIL');
  const hasContradiction = !mutant?.ignore_contradictions && consistencyFails.length > 0;
  const contradictionTally = mutant?.ignore_contradictions ? 0 : Math.min(consistencyFails.length, CRITICAL_TALLY_CAP);

  const knowledgeCards = findAll(evidence, 'knowledge_check_result');
  const knowledgeFailTally = knowledgeCards.filter((e) => e.status === 'FAIL').length;
  // AMBIGUOUS, REFUSED, UNANSWERED (a non-response to a challenge) and a log-drift card
  // (facts.kind === 'DRIFT') all surface as FLAG and all count 0.5: evasion, silence, and
  // an unreconstructable log entry are each "not a pass" without being fatal on their own.
  const knowledgeAmbiguousTally = knowledgeCards.filter((e) => e.status === 'FLAG').length * 0.5;

  let tally = 0;
  if (ssoFail) tally += 1;
  if (oobFail) tally += 1;
  if (contextFail) tally += 1;
  tally += contradictionTally;
  tally += knowledgeFailTally;
  tally += knowledgeAmbiguousTally;

  return { tally, ssoFail, oobFail, contextFail, hasContradiction, contradictionCount: consistencyFails.length };
}

function orderedFreezeReasons(
  ssoFail: boolean,
  oobFail: boolean,
  contextFail: boolean,
  hasContradiction: boolean,
  knowledgeFailOrRelevant: boolean,
  pressureFlag: boolean,
  exposureFail: boolean,
  newBeneficiary: boolean,
): VerdictReason[] {
  const reasons: VerdictReason[] = [];
  if (ssoFail) reasons.push('IDENTITY_UNVERIFIED');
  if (oobFail) reasons.push('OUT_OF_BAND_NO_RESPONSE');
  if (contextFail) reasons.push('CONTEXT_FAILURE');
  if (hasContradiction) reasons.push('STORY_INCONSISTENCY');
  if (knowledgeFailOrRelevant) reasons.push('KNOWLEDGE_CHECK_FAILED');
  if (pressureFlag) reasons.push('URGENCY_ESCALATION');
  if (exposureFail) reasons.push('EXPOSURE_LIMIT');
  if (newBeneficiary) reasons.push('NEW_BENEFICIARY');
  return reasons;
}

function assuranceAllTrue(a: AssuranceChecklist): boolean {
  return Object.values(a).every((v) => v === true);
}

/** THE RULE TABLE. Pure: no I/O, no Date.now(), no Math.random(). `evidence` is the fully
 *  composed, override-applied card set (see compose.ts); `ctx` carries the small set of
 *  cross-cutting facts a single evidence card can't express on its own (request version,
 *  challenge counters, new-beneficiary/amendment flags, exposure total, incomplete-tool
 *  flag, critical-field confirmation, identity-switch staleness). `mutant` is test-only. */
export function decide(evidence: Evidence[], seed: SeedConfig, ctx: RuleContext, mutant?: RuleMutant): DecideResult {
  const identityEv = find(evidence, 'identity_claim');
  const requestEv = find(evidence, 'request_params');
  const outOfScopeEv = find(evidence, 'out_of_scope_marker');
  const ssoEv = find(evidence, 'sso_context_result');
  const oobEv = find(evidence, 'oob_verification_result');
  const contextEv = find(evidence, 'context_check_result');
  const exposureEv = find(evidence, 'exposure_check_result');
  const pressureFlag = find(evidence, 'pressure_marker')?.status === 'FLAG';

  const { tally, ssoFail, oobFail, contextFail, hasContradiction } = computeTally(evidence, mutant);

  const knowledgeCards = findAll(evidence, 'knowledge_check_result');
  const relationalFail = knowledgeCards.some((e) => e.status === 'FAIL' && e.facts.kind === 'RELATIONAL');
  const trapFail = knowledgeCards.some((e) => e.status === 'FAIL' && e.facts.kind === 'TRAP_FACT');
  const anyKnowledgeFail = knowledgeCards.some((e) => e.status === 'FAIL');
  const anyCheckFail = ssoFail || oobFail || contextFail;

  // ---- assurance (needed for row 11's gate and the I2 invariant) ----
  const need = ctx.new_beneficiary ? 2 : ctx.amendment_only && contextEv?.status === 'PASS' ? 0 : 1;
  const passedChallenges = knowledgeCards.filter((e) => e.status === 'PASS').length;
  const challengesRemaining = ctx.challenges_issued < ctx.max_challenges;
  // The exposure_check_result card (built by compose.ts's buildExposureEvidence) already
  // encodes the FULL anti-structuring condition -- cumulative distinct amounts over the
  // high-value line WHILE the current single request reads under it -- so decide() reads
  // its status rather than re-deriving the comparison from a raw cumulative-exposure number
  // (a bare "cumulative > threshold" check would wrongly flag any single large, honest
  // request; RuleContext carried such a field once and nothing ever read it -- removed).
  const exposureFail = !mutant?.ignore_exposure && exposureEv?.status === 'FAIL';

  const assurance: AssuranceChecklist = {
    identity_claimed: identityEv !== undefined,
    sso_pass_current: ssoEv?.status === 'PASS',
    oob_confirmed_current: oobEv?.status === 'PASS',
    context_pass_current: contextEv?.status === 'PASS',
    no_contradictions: !hasContradiction,
    critical_fields_confirmed: mutant?.skip_readback_gate ? true : ctx.critical_confirmed,
    exposure_within_limit: !exposureFail,
    challenge_requirement_met: passedChallenges >= need,
    no_identity_switch: !ctx.identity_switch_stale,
    not_new_beneficiary: !ctx.new_beneficiary,
  };

  // §B (amendment-v2-brief.md): "FREEZE rules may use unconfirmed values (fail-safe
  // direction)." A caller who keeps contradicting themselves under otherwise-failing
  // checks must not be able to stall the engine in row 4's readback loop forever just by
  // never confirming anything -- freeze is the SAFE direction and is allowed to fire on
  // raw, unconfirmed evidence. Row 4 (below) is therefore conditioned on NOT already being
  // freeze-eligible; rows 9/10 (ESCALATE) have no such carve-out in the brief and stay
  // strictly behind row 4, since only FREEZE gets the explicit fail-safe permission.
  const freezeEligible =
    (mutant?.or_instead_of_and_in_7a ? oobFail || ssoFail : oobFail && ssoFail) ||
    (hasContradiction && anyCheckFail) ||
    tally >= 3 ||
    (relationalFail && oobFail) ||
    (trapFail && anyCheckFail);

  let verdict: Verdict;
  let reasons: VerdictReason[] = [];
  let rule_hit: number;

  // Named once, used by rows 4 and 5: freeze is allowed to fire on raw, unconfirmed evidence
  // (the fail-safe note above), so both the challenge row and the readback row must yield to
  // it rather than stalling a caller who's already freeze-eligible in a loop.
  const freezeGate = !freezeEligible;

  // Row 1 / 2: out of scope.
  if (outOfScopeEv && outOfScopeEv.status === 'FLAG') {
    verdict = 'NO_ACTION';
    reasons = ['OUT_OF_SCOPE'];
    rule_hit = requestEv ? 2 : 1;
  }
  // Row 3: no identity or no request.
  else if (!identityEv || !requestEv) {
    verdict = 'PENDING';
    rule_hit = 3;
  }
  // Row 4 (ruling 2026-09-02): a challenge is still required for the risk level and one can
  // still be asked -> ask it before reading back an unconfirmed critical field, so the
  // agent's first question on a risky call is the interrogation, not a readback. Guarded by
  // freezeGate (freeze keeps strict priority over both this row and row 5 -- see the
  // fail-safe note above) and by !ctx.identity_switch_stale: a mid-call identity switch must
  // be re-established from scratch (row 6) before any challenge is put to "whoever is on the
  // line now" -- asking a knowledge question here would trust the abandoned claim's context,
  // exactly what row 6 exists to prevent.
  else if (freezeGate && !ctx.identity_switch_stale && passedChallenges < need && challengesRemaining) {
    verdict = 'PENDING';
    rule_hit = 4;
  }
  // Row 5: a critical field is claimed but not yet confirmed (unless freeze is already
  // warranted on the raw evidence -- see the fail-safe note above). Reached once any
  // required challenge for this risk level has already been asked (row 4), or none is
  // required (need 0). Also guarded by !ctx.identity_switch_stale -- fix round (review of
  // d672070), same reasoning as row 4: reading an amount back to "whoever is on the line
  // now" would trust the abandoned claim's context just as much as challenging them would,
  // so row 6 (re-establish identity from scratch) must win here too, not just at row 4.
  else if (freezeGate && !ctx.identity_switch_stale && !mutant?.skip_readback_gate && !ctx.critical_confirmed) {
    verdict = 'PENDING';
    rule_hit = 5;
  }
  // Row 6: identity switched this version, evidence now stale.
  else if (ctx.identity_switch_stale) {
    verdict = 'PENDING';
    rule_hit = 6;
  }
  // Row 7: any live check still pending/absent/stale.
  else if (!ssoEv || ssoEv.status === 'PENDING' || !oobEv || oobEv.status === 'PENDING' || !contextEv || contextEv.status === 'PENDING') {
    verdict = 'PENDING';
    rule_hit = 7;
  }
  // Row 8: freeze conditions.
  else if (freezeEligible) {
    verdict = 'FREEZE';
    reasons = orderedFreezeReasons(ssoFail, oobFail, contextFail, hasContradiction, anyKnowledgeFail, pressureFlag, exposureFail, ctx.new_beneficiary);
    rule_hit = 8;
  }
  // Row 9: structuring -- exposure across versions over the high-value line.
  else if (exposureFail) {
    verdict = 'ESCALATE';
    reasons = orderedFreezeReasons(ssoFail, oobFail, contextFail, hasContradiction, anyKnowledgeFail, pressureFlag, exposureFail, ctx.new_beneficiary);
    rule_hit = 9;
  }
  // Row 10: a first-time beneficiary, regardless of amount.
  else if (ctx.new_beneficiary) {
    verdict = 'ESCALATE';
    reasons = orderedFreezeReasons(ssoFail, oobFail, contextFail, hasContradiction, anyKnowledgeFail, pressureFlag, exposureFail, ctx.new_beneficiary);
    rule_hit = 10;
  }
  // Row 11: everything affirmative -> stage.
  else if (assuranceAllTrue(assurance)) {
    verdict = 'STAGE';
    reasons = [];
    rule_hit = 11;
  }
  // Row 12: some failures, but under the freeze line, and challenges remain.
  else if (tally > 0 && tally < 3 && challengesRemaining) {
    verdict = 'PENDING';
    rule_hit = 12;
  }
  // Row 13: otherwise, human callback.
  else {
    verdict = 'ESCALATE';
    reasons = orderedFreezeReasons(ssoFail, oobFail, contextFail, hasContradiction, anyKnowledgeFail, pressureFlag, exposureFail, ctx.new_beneficiary);
    rule_hit = 13;
  }

  // ---- invariants (checked last, override everything) ----
  let invariants_ok = true;

  // I1: VOICE_CAN_NEVER_RELEASE -- defensive; structurally guaranteed by the type system
  // (Verdict/ToolName have no RELEASE member), kept here as a runtime backstop.
  const RELEASE = 'RELEASE';
  if ((verdict as string) === RELEASE) {
    invariants_ok = false;
    verdict = 'NO_ACTION';
    reasons = [];
  }

  // I4: an incomplete evaluation may never STAGE, and may never sit in PENDING forever --
  // it escalates to a human (or, with nothing at stake, NO_ACTION).
  if (ctx.evaluation_incomplete && (verdict === 'STAGE' || verdict === 'PENDING')) {
    verdict = requestEv ? 'ESCALATE' : 'NO_ACTION';
    reasons = [];
  }

  // I2: STAGE only if every assurance item is true. Row 11 already gates on this, so this
  // is a redundant safety net -- it should never actually fire.
  if (verdict === 'STAGE' && !assuranceAllTrue(assurance)) {
    invariants_ok = false;
    verdict = 'NO_ACTION';
    reasons = [];
  }

  return { verdict, reasons, failure_tally: tally, assurance, invariants_ok, rule_hit };
}

export const RULES_DOC = `COUNTERSIGN RULES v2 -- the deterministic core (first match wins; the LLM never decides)

Invariants (checked last, override everything):
I1. VOICE_CAN_NEVER_RELEASE -- there is no release tool, no release action, no release verdict anywhere in this engine; the positive ceiling is STAGE.
I2. STAGE only when every AssuranceChecklist item reads true (affirmative assurance, never "zero failures").
I3. A material change (a request-version bump) invalidates all tool evidence gathered under an earlier version; stale evidence is never treated as a pass.
I4. Any tool result carrying an error, or still missing past the timeout, makes the evaluation incomplete: the outcome becomes ESCALATE (or NO_ACTION when there is no open request), never STAGE.

Rule table (evidence-first, first match wins):
1. An out-of-scope marker with no open request -> NO_ACTION; explain this is a demo checkpoint, nothing moves.
2. An out-of-scope marker with an open request -> NO_ACTION; the request stays open and unstaged, for a human to route.
3. No identity claim, or no request -> hold; ask for whichever is missing.
4. A required challenge is asked before the amount is read back: not enough passed challenges yet for the risk level, challenges remain to ask, and there is no in-progress identity switch to resolve first -> hold; ask the next challenge.
5. A readback is still required before anything can be staged: any critical field (amount, account, beneficiary) that has been claimed but not yet confirmed -> hold; read it back and ask the caller to confirm. Reached once any challenge required by row 4 has already been asked (or none is required for this risk level).
6. An identity switch this version, with now-stale evidence -> hold; re-establish who is calling from scratch (this always takes priority over asking a fresh challenge or a readback, since both would otherwise address someone whose claimed identity has already been abandoned).
7. Any identity, out-of-band, or context check still pending, absent, or stale -> hold; keep the floor with one short neutral line.
8. Freeze the transfer rail when any of:
   8a. the out-of-band check and the identity/SSO check both failed;
   8b. a contradicted claim exists alongside any failed check;
   8c. three or more independent checks have failed;
   8d. the account-relation challenge failed alongside a failed out-of-band check;
   8e. the deliberate-misstatement challenge failed alongside any failed check.
   Reasons are always ordered: identity, out-of-band, context, story consistency, knowledge check, urgency pressure, exposure limit, new beneficiary. Freeze keeps strict priority over rows 4 and 5: it can fire on raw, unconfirmed evidence rather than waiting on a challenge or a readback that may never come.
9. Distinct amounts stated across the call add up past the high-value threshold while the current amount alone reads under it -> escalate for a human callback (this guards against splitting one large request into smaller-looking pieces).
10. A first-time beneficiary not on record -> escalate for a human callback, regardless of amount.
11. Every AssuranceChecklist item reads true -> STAGE for second approval. A pressure flag never blocks this step, but it keeps the details off the call and adds the principal alert to the required actions.
12. Some checks have failed, fewer than three, and challenges remain -> hold; ask another challenge.
13. Otherwise -> escalate for a human callback; nothing moves by voice alone.

Tally (independent failed checks; used by rows 8c and 12): SSO/identity fail 1, out-of-band fail 1, context fail 1, each contradicted claim 1 (capped at 2), each failed challenge 1, each ambiguous/refused challenge 0.5 (evasion is not free, but not fatal either). Pressure, an injection-lexicon hit, and an identity switch each count 0 toward the tally -- they are behavior, never proof, and an identity switch resets the evaluation instead of accruing against it.
`;
