// packages/engine/src/evaluate.ts
// The orchestrator. `evaluate` is a pure function of (conversation, tools, actions, call,
// seed) [+ optional test-only overrides]: it rebuilds the story ledger, composes every
// evidence card from scratch, derives the rule context, decides a verdict, derives state,
// and phrases a goal -- recomputed from nothing but the input every single call. LAW 3: the
// engine is the only verdict owner; nothing here reads a clock or random source.
import { buildLedger, currentClaim } from './ledger.js';
import { gradeChallenges, selectChallenge } from './challenges.js';
import { evidenceFromTranscript } from './evidence/fromTranscript.js';
import { evidenceFromTools } from './evidence/fromTools.js';
import { decide } from './rules.js';
import type { RuleMutant } from './rules.js';
import { allowedTools, deriveState, phrasingGoal, requiredActions } from './fsm.js';
import {
  applyOverrides,
  buildConsistencyEvidence,
  buildExposureEvidence,
  buildKnowledgeEvidence,
  buildReadbackEvidence,
  deriveRuleContext,
  reconstructIssued,
  resolveIdentitySwitch,
} from './compose.js';
import type { ChallengeResult, EngineInput, EngineOutput, Evidence, EvidenceStatus } from './types.js';

/** `overrides` and `mutant` are TEST-ONLY (used by test/evaluate.test.ts's counterfactual
 *  checks and test/mutants.test.ts respectively). `evaluate(input)` alone stays the only
 *  signature the server/browser ever calls -- a real invocation never supplies either. */
export function evaluate(input: EngineInput, overrides?: Record<string, EvidenceStatus>, mutant?: RuleMutant): EngineOutput {
  const { conversation, tools, actions, call, seed } = input;

  // 1. Story ledger.
  const { claims, request_version } = buildLedger(conversation, actions, seed);
  const claimedIdentity = currentClaim(claims, 'identity');
  const claimed_identity_id = claimedIdentity ? String(claimedIdentity.value) : null;
  const amountClaim = currentClaim(claims, 'amount_usd');
  const amount_usd = amountClaim ? Number(amountClaim.value) : null;
  const beneficiaryClaim = currentClaim(claims, 'beneficiary');
  const beneficiary = beneficiaryClaim ? String(beneficiaryClaim.value) : null;

  // 2. Transcript evidence, re-stamped with the ledger's request_version (the ledger owns
  // versioning; evidenceFromTranscript always tags its own cards version 1). Founder decision
  // 2026-09-11 10:15 PM (option B): resolveIdentitySwitch then demotes ev-identity-switch off
  // FLAG once, after the switch, the caller has re-stated the new identity AND the request is
  // unchanged or re-confirmed -- see compose.ts for the exact conditions and why this never
  // erases the switch's own contradiction weight (ev-consistency-identity, built below at
  // step 5, is untouched either way).
  const transcriptEv: Evidence[] = resolveIdentitySwitch(
    evidenceFromTranscript(conversation, seed).map((e) => ({ ...e, request_version })),
    conversation,
    claims,
    seed,
  );

  // 3. Challenges: reconstruct what was issued, grade it, build knowledge_check_result cards.
  const issued = reconstructIssued(claims, actions, seed, call.session_id, conversation);
  const results = gradeChallenges(conversation, actions, issued, seed, claims);
  const knowledgeEv = buildKnowledgeEvidence(issued, results, actions, request_version, seed);

  // 4. Tool evidence.
  const toolEv = evidenceFromTools(tools, call, seed, {
    claimed_id: claimed_identity_id,
    amount_usd,
    beneficiary,
    request_version,
  });

  // 5. Ledger-derived evidence.
  const consistencyEv = buildConsistencyEvidence(claims, request_version);
  const readbackEv = buildReadbackEvidence(claims, request_version);
  const exposureEv = buildExposureEvidence(claims, seed, request_version);

  // 6. Merge (transcript, ledger-derived, knowledge, tools) and apply test-only overrides.
  const merged = applyOverrides(
    [...transcriptEv, ...consistencyEv, ...readbackEv, ...(exposureEv ? [exposureEv] : []), ...knowledgeEv, ...toolEv],
    overrides,
  );

  // 7. Rule context.
  const ctx = deriveRuleContext(claims, request_version, merged, tools, conversation, actions, issued.length, seed);

  // 8. Decide, derive state, pick the next challenge (for the CHALLENGE goal), phrase the goal.
  const decideResult = decide(merged, seed, ctx, mutant);
  const state = deriveState(decideResult, merged, tools);

  const resultsForSelect: Record<string, ChallengeResult> = {};
  for (const [id, r] of Object.entries(results)) resultsForSelect[id] = r.result;
  const nextChallenge = selectChallenge(claims, issued, resultsForSelect, seed, call.session_id, conversation);

  const goal = phrasingGoal({
    state,
    decideResult,
    evidence: merged,
    ledger: claims,
    seed,
    tools,
    actions,
    nextChallenge,
  });

  // 9. Assemble output. Every EngineOutput field is filled -- no undefined placeholders.
  return {
    state,
    verdict: decideResult.verdict,
    reasons: decideResult.reasons,
    failure_tally: decideResult.failure_tally,
    evidence: merged,
    allowed_tools: allowedTools(state, decideResult.verdict),
    required_actions: requiredActions(decideResult.verdict, tools),
    goal,
    claimed_identity_id,
    ledger: claims,
    request_version,
    challenges: { issued, results: resultsForSelect },
    assurance: decideResult.assurance,
    invariants_ok: decideResult.invariants_ok,
    rule_hit: decideResult.rule_hit,
  };
}
