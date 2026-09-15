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

/** PROVEN defect (2026-09-14, scripts/rehearse/reports/2026-09-14T18-22-25-structuring-two-
 *  wires.md + its .diagnostics.json): a call already SEALED FREEZE at t=83982/85235 (rule
 *  row 8) flipped to PENDING at t=89976 (row 7) off nothing but two more caller lines, then
 *  to ESCALATE at t=102686 (row 15) -- `deriveState` (fsm.ts) already locks the visible
 *  STATE to SEALED forever once `seal_evidence_record` has a successful tool-log entry, but
 *  nothing locked the VERDICT: `evaluate` recomputed it fresh from the FULL conversation on
 *  every call, so post-seal caller speech kept moving `decide()`'s own rule table. LAW 2's
 *  "voice never releases the wire" corollary is that a verified/frozen/escalated case can
 *  never be REOPENED or RECLASSIFIED by whatever the caller keeps saying into an already-
 *  ended interaction.
 *
 *  `evaluate` stays a pure function of its input (no remembered flag) -- the freeze point is
 *  re-derived on every call from the logs themselves: the EARLIEST successful
 *  `seal_evidence_record` tool entry's `t_ms`. Every conversation/tool/action entry strictly
 *  AFTER that instant is dropped before any ledger/evidence/rule computation runs, so the
 *  whole pipeline computes exactly what it would have computed the instant sealing happened,
 *  every time, forever. `deriveState`'s own SEALED check (fsm.ts) is unaffected either way --
 *  it only needs the seal entry ITSELF present, and the "<=" boundary always keeps it (the
 *  four terminal-action tool entries for one verdict are always logged in the same tick, at
 *  the same t_ms -- see terminalActions.ts/session.ts's `runOwedTerminalActions` -- so none of
 *  a sealed verdict's own siblings is ever cut by this truncation).
 *
 *  No corpus fixture has any conversation/tool/action entry timestamped after its own seal
 *  (verified by scanning every file in packages/engine/corpus), so this is a no-op for every
 *  existing replay -- corpus.test.ts stays 128/128. See test/evaluate.test.ts's "sealed
 *  verdict never moves" cases for the regression coverage (the P1 shape: FREEZE sealed, then
 *  two more caller lines -> verdict/goal stay FREEZE/CLOSE). */
function freezeAtSeal(input: EngineInput): EngineInput {
  // Find the EARLIEST successful seal_evidence_record entry by scanning the tools array
  // in order, so we can get both its timestamp AND its array position.
  let sealedAtMs: number | null = null;
  let sealIndexInTools = -1;
  let conversationCount: number | null = null;
  let actionsCount: number | null = null;
  for (let i = 0; i < input.tools.length; i++) {
    const t = input.tools[i]!;
    if (t.name === 'seal_evidence_record' && t.result !== undefined && t.result.error === undefined) {
      sealedAtMs = t.t_ms;
      sealIndexInTools = i;
      // Extract conversation and actions counts from args if present (new bundles).
      if (typeof t.args === 'object' && t.args !== null) {
        const args = t.args as any;
        if (typeof args.conversation_count === 'number') conversationCount = args.conversation_count;
        if (typeof args.actions_count === 'number') actionsCount = args.actions_count;
      }
      break;
    }
  }
  if (sealedAtMs === null) return input;

  // Truncate by array position: the seal entry marks a boundary. Position-based truncation
  // applies to all three arrays:
  // - tools: keep tools[0..seal_index], so tool entries placed AFTER the seal in the array
  //   are excluded, even if they share the seal's timestamp. The seal_evidence_record is
  //   always the LAST required action before terminal actions may cease (see REQUIRED_ACTIONS
  //   in fsm.ts and terminalActions.ts), so no sibling terminal-action entry (freeze, incident,
  //   alert, seal) is ever cut.
  // - conversation/actions: if seal args carry conversation_count/actions_count (from newer
  //   server bundles), truncate by array position using those counts. This prevents the leak:
  //   a caller utterance appended after the seal at the exact same millisecond (e.g., a
  //   websocket handler firing right after the tick) would pass timestamp-based filtering
  //   but is excluded by count-based truncation.
  // - Fallback (old corpus fixtures, legacy bundles): if counts are absent, truncate
  //   conversation/actions by timestamp (t_ms <= sealedAtMs). This maintains backward
  //   compatibility with 128 corpus fixtures that never have counts in seal args.
  return {
    ...input,
    conversation: conversationCount !== null ? input.conversation.slice(0, conversationCount) : input.conversation.filter((u) => u.t_ms <= sealedAtMs),
    tools: input.tools.slice(0, sealIndexInTools + 1),
    actions: actionsCount !== null ? input.actions.slice(0, actionsCount) : input.actions.filter((a) => a.t_ms <= sealedAtMs),
  };
}

/** `overrides` and `mutant` are TEST-ONLY (used by test/evaluate.test.ts's counterfactual
 *  checks and test/mutants.test.ts respectively). `evaluate(input)` alone stays the only
 *  signature the server/browser ever calls -- a real invocation never supplies either. */
export function evaluate(rawInput: EngineInput, overrides?: Record<string, EvidenceStatus>, mutant?: RuleMutant): EngineOutput {
  const { conversation, tools, actions, call, seed } = freezeAtSeal(rawInput);

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
  const readbackEv = buildReadbackEvidence(claims, actions, seed, request_version);
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
    conversation,
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
