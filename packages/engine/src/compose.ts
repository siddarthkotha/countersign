// packages/engine/src/compose.ts
// Evidence-composition helpers used by evaluate.ts. Split out so evaluate.ts stays a short
// orchestration script. LAW 4: facts (raw) stay separate from status/detail (interpretation)
// on every card built here; every quote is a verbatim substring of the utterance it cites.
import { buildLedger, currentClaim, isConfirmed } from './ledger';
import { gradeChallenges, selectChallenge } from './challenges';
import type { RuleContext } from './rules';
import type {
  AgentAction,
  Claim,
  ClaimField,
  ChallengeResult,
  ChallengeSpec,
  Evidence,
  EvidenceStatus,
  SeedConfig,
  ToolLogEntry,
  Utterance,
} from './types';

export const CRITICAL_FIELDS: ClaimField[] = ['amount_usd', 'account_last4', 'beneficiary'];

function money(n: number): string {
  return `$${n.toLocaleString('en-US')}`;
}

function displayValue(field: ClaimField, value: string | number): string {
  return field === 'amount_usd' ? money(Number(value)) : String(value);
}

// ---------- issued-challenge reconstruction (composition step 3) ----------

/** Rebuilds the sequence of `ChallengeSpec`s that were actually issued, purely from the
 *  `challenge_issued` actions and the ledger -- never trusting a stored spec, since none is
 *  stored (the server only logs the action). Deterministic: re-runs `selectChallenge` as of
 *  each action's t_ms (claims with t_ms <= action.t_ms only). If the rebuilt spec's
 *  challenge_id doesn't match the action's (log drift -- e.g. a replayed/edited corpus
 *  file), that action is dropped: there is no reliable spec to grade against, so it cannot
 *  contribute a knowledge_check_result card. */
export function reconstructIssued(
  claims: Claim[],
  actions: AgentAction[],
  seed: SeedConfig,
  session_id: string,
  conversation: Utterance[],
): ChallengeSpec[] {
  const issuedActions = actions.filter((a) => a.kind === 'challenge_issued').sort((a, b) => a.t_ms - b.t_ms);
  const issued: ChallengeSpec[] = [];
  for (const action of issuedActions) {
    const claimsAsOf = claims.filter((c) => c.t_ms <= action.t_ms);
    const conversationAsOf = conversation.filter((u) => u.t_ms <= action.t_ms);
    const rebuilt = selectChallenge(claimsAsOf, issued, {}, seed, session_id, conversationAsOf);
    if (rebuilt && rebuilt.challenge_id === action.challenge_id) {
      issued.push(rebuilt);
    }
    // else: log drift. Skip -- no reliable spec to grade this action against.
  }
  return issued;
}

// ---------- knowledge_check_result cards ----------

function labelForChallenge(spec: ChallengeSpec): string {
  if (spec.kind === 'TRAP_FACT') return 'Consistency probe (deliberate misstatement)';
  if (spec.kind === 'LIVE_COMMITMENT') return 'Consistency probe (restated claim)';
  if (spec.kind === 'RELATIONAL') return 'Relational check';
  return 'Knowledge check';
}

function statusForResult(result: ChallengeResult): EvidenceStatus {
  if (result === 'PASS') return 'PASS';
  if (result === 'FAIL') return 'FAIL';
  return 'FLAG'; // AMBIGUOUS, REFUSED, UNANSWERED
}

export function buildKnowledgeEvidence(
  issued: ChallengeSpec[],
  results: Record<string, { result: ChallengeResult; quote?: { utterance_id: string; text: string }; eligible_utterance_ids: string[] }>,
  actions: AgentAction[],
  request_version: number,
): Evidence[] {
  const out: Evidence[] = [];
  for (const spec of issued) {
    const graded = results[spec.challenge_id];
    if (!graded) continue;
    const issuedAction = actions.find((a) => a.kind === 'challenge_issued' && a.challenge_id === spec.challenge_id);
    out.push({
      id: `ev-knowledge-${spec.challenge_id}`,
      kind: 'knowledge_check_result',
      t_ms: issuedAction?.t_ms ?? 0,
      label: labelForChallenge(spec),
      status: statusForResult(graded.result),
      detail: `${spec.kind} check on ${spec.field}: ${graded.result.toLowerCase()}.`,
      facts: { kind: spec.kind, result: graded.result, field: spec.field },
      quotes: graded.quote ? [graded.quote] : [],
      source: 'transcript',
      provenance: 'POLICY_DERIVED',
      request_version,
    });
  }
  return out;
}

// ---------- ledger-derived evidence (composition step 5) ----------

export function buildConsistencyEvidence(claims: Claim[], request_version: number): Evidence[] {
  const out: Evidence[] = [];
  const contradicted = claims.filter((c) => c.kind === 'CONTRADICTED');
  const seenPerField = new Map<ClaimField, number>();
  for (const claim of contradicted) {
    const n = (seenPerField.get(claim.field) ?? 0) + 1;
    seenPerField.set(claim.field, n);
    const superseded = claim.supersedes ? claims.find((c) => c.id === claim.supersedes) : undefined;
    const id = n > 1 ? `ev-consistency-${claim.field}-${n}` : `ev-consistency-${claim.field}`;
    out.push({
      id,
      kind: 'consistency_flag',
      t_ms: claim.t_ms,
      label: `Consistency: ${claim.field.replace('_', ' ')}`,
      status: 'FAIL',
      detail: superseded
        ? `Caller said ${displayValue(claim.field, superseded.value)}, then said ${displayValue(claim.field, claim.value)}, with no correction offered.`
        : `Caller contradicted an earlier ${claim.field.replace('_', ' ')} claim with no correction offered.`,
      facts: { field: claim.field, first: superseded ? superseded.value : null, later: claim.value },
      quotes: superseded ? [superseded.quote, claim.quote] : [claim.quote],
      source: 'transcript',
      provenance: 'CALLER_SAID',
      request_version,
    });
  }
  return out;
}

export function buildReadbackEvidence(claims: Claim[], request_version: number): Evidence[] {
  const out: Evidence[] = [];
  for (const field of CRITICAL_FIELDS) {
    const claim = currentClaim(claims, field);
    const confirmed = isConfirmed(claims, field);
    out.push({
      id: `ev-readback-${field}`,
      kind: 'readback_result',
      t_ms: claim?.t_ms ?? 0,
      label: `Readback: ${field.replace('_', ' ')}`,
      status: confirmed ? 'PASS' : 'PENDING',
      detail: confirmed
        ? `${field.replace('_', ' ')} confirmed by the caller.`
        : claim
          ? `${field.replace('_', ' ')} claimed but not yet confirmed by the caller.`
          : `${field.replace('_', ' ')} has not been claimed yet.`,
      facts: { field, confirmed, value: claim ? claim.value : null },
      quotes: claim ? [claim.quote] : [],
      source: 'transcript',
      provenance: confirmed ? 'CALLER_SAID' : 'UNRESOLVED',
      request_version,
    });
  }
  return out;
}

/** Sum of every DISTINCT amount ever stated (any version) -- the anti-structuring check.
 *  Only emitted as a card when >=2 distinct amounts exist across the call. */
export function buildExposureEvidence(claims: Claim[], seed: SeedConfig, request_version: number): Evidence | null {
  const amountClaims = claims.filter((c) => c.field === 'amount_usd');
  const distinct = [...new Set(amountClaims.map((c) => Number(c.value)))];
  if (distinct.length < 2) return null;
  const exposure_usd = distinct.reduce((a, b) => a + b, 0);
  const current = currentClaim(claims, 'amount_usd');
  const current_usd = current ? Number(current.value) : 0;
  const over = exposure_usd > seed.thresholds.high_value_usd && current_usd < seed.thresholds.high_value_usd;
  const last = amountClaims[amountClaims.length - 1]!;
  return {
    id: 'ev-exposure',
    kind: 'exposure_check_result',
    t_ms: last.t_ms,
    label: 'Cumulative exposure',
    status: over ? 'FAIL' : 'PASS',
    detail: over
      ? `Distinct amounts stated this call total ${money(exposure_usd)}, above the ${money(seed.thresholds.high_value_usd)} threshold, while the current request alone reads under it.`
      : `Distinct amounts stated this call total ${money(exposure_usd)}, within the ${money(seed.thresholds.high_value_usd)} threshold.`,
    facts: { exposure_usd, current_usd },
    quotes: amountClaims.map((c) => c.quote),
    source: 'transcript',
    provenance: 'POLICY_DERIVED',
    request_version,
  };
}

// ---------- overrides ----------

export function applyOverrides(evidence: Evidence[], overrides: Record<string, EvidenceStatus> | undefined): Evidence[] {
  if (!overrides) return evidence;
  return evidence.map((e) => (Object.prototype.hasOwnProperty.call(overrides, e.id) ? { ...e, status: overrides[e.id]! } : e));
}

// ---------- RuleContext derivation ----------

function normalizeCompare(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function computeNewBeneficiary(claims: Claim[], contextEv: Evidence | undefined): boolean {
  const beneficiary = currentClaim(claims, 'beneficiary');
  if (!beneficiary || !contextEv || contextEv.status === 'PENDING') return false;
  const known = String(contextEv.facts.known_vendors ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (known.length === 0) return true;
  return !known.some((v) => normalizeCompare(v, String(beneficiary.value)));
}

export function computeEvaluationIncomplete(
  tools: ToolLogEntry[],
  conversation: Utterance[],
  actions: AgentAction[],
  seed: SeedConfig,
): boolean {
  const allT = [
    ...conversation.map((u) => u.t_ms),
    ...tools.map((t) => t.t_ms),
    ...actions.map((a) => a.t_ms),
  ];
  const lastEventT = allT.length > 0 ? Math.max(...allT) : 0;
  return tools.some((t) => {
    if (t.result && t.result.error !== undefined && t.result.error !== null) return true;
    if (!t.result && lastEventT - t.t_ms > seed.thresholds.tool_timeout_ms) return true;
    return false;
  });
}

export function computeCriticalConfirmed(claims: Claim[]): boolean {
  return CRITICAL_FIELDS.every((f) => isConfirmed(claims, f));
}

export function computeExposureUsd(claims: Claim[]): number {
  const amountClaims = claims.filter((c) => c.field === 'amount_usd');
  const distinct = [...new Set(amountClaims.map((c) => Number(c.value)))];
  return distinct.reduce((a, b) => a + b, 0);
}

export interface ComposedContext {
  claims: Claim[];
  request_version: number;
  ctx: RuleContext;
}

export function deriveRuleContext(
  claims: Claim[],
  request_version: number,
  evidenceMerged: Evidence[],
  tools: ToolLogEntry[],
  conversation: Utterance[],
  actions: AgentAction[],
  issuedCount: number,
  seed: SeedConfig,
): RuleContext {
  const contextEv = evidenceMerged.find((e) => e.kind === 'context_check_result');
  const identitySwitchEv = evidenceMerged.find((e) => e.kind === 'identity_switch');
  return {
    request_version,
    challenges_issued: issuedCount,
    max_challenges: seed.thresholds.max_challenges,
    new_beneficiary: computeNewBeneficiary(claims, contextEv),
    amendment_only: contextEv?.facts.amendment_only === true,
    exposure_usd: computeExposureUsd(claims),
    evaluation_incomplete: computeEvaluationIncomplete(tools, conversation, actions, seed),
    critical_confirmed: computeCriticalConfirmed(claims),
    identity_switch_stale: identitySwitchEv?.status === 'FLAG',
  };
}

export { buildLedger };
