// packages/engine/src/compose.ts
// Evidence-composition helpers used by evaluate.ts. Split out so evaluate.ts stays a short
// orchestration script. LAW 4: facts (raw) stay separate from status/detail (interpretation)
// on every card built here; every quote is a verbatim substring of the utterance it cites.
import { buildLedger, currentClaim, isConfirmed } from './ledger.js';
import { gradeChallenges, selectChallenge, seedFieldForEntry } from './challenges.js';
import { normalizeValue } from './normalize.js';
import { money } from './util.js';
import type { RuleContext } from './rules.js';
import type {
  AgentAction,
  Claim,
  ClaimField,
  ChallengeResult,
  ChallengeSpec,
  Evidence,
  EvidenceStatus,
  KnowledgeFact,
  SeedConfig,
  ToolLogEntry,
  Utterance,
} from './types.js';

export const CRITICAL_FIELDS: ClaimField[] = ['amount_usd', 'account_last4', 'beneficiary'];

// ---------- issued-challenge reconstruction (composition step 3) ----------

/** Sentinel: a real `selectChallenge` spec's `ask` is never the empty string (every
 *  LIVE_COMMITMENT/TRAP_FACT/RELATIONAL ask is a template literal with content, and every
 *  seed.knowledge SEED_FACT entry has a non-empty `ask`). `reconstructIssued` uses `ask: ''`
 *  to mark a log-drift placeholder so `buildKnowledgeEvidence` can detect it without a
 *  second return value or parameter -- keeps both functions' signatures unchanged for
 *  downstream callers (evaluate.ts, and anything Task 6's corpus/replay tooling calls
 *  directly). */
function isDrift(spec: ChallengeSpec): boolean {
  return spec.ask === '';
}

/** Placeholder spec for log drift (`ask: ''`, the drift sentinel -- never graded normally,
 *  since its deliberately empty expect.accept_tokens would otherwise vacuously PASS) so the
 *  drift itself is visible as a FLAG card rather than disappearing. */
function driftSpec(challenge_id: string | undefined, fallbackId: string): ChallengeSpec {
  return {
    challenge_id: challenge_id ?? `drift-${fallbackId}`,
    kind: 'SEED_FACT',
    field: 'purpose',
    ask: '',
    expect: { accept_tokens: [] },
  };
}

/** Founder-morning item 4: is `spec` (an action's recorded `AgentAction.spec`) a LEGAL
 *  choice at the point it was issued -- i.e. one `selectChallenge` could actually have
 *  produced, given what had happened in the call by `action.t_ms`? Checked structurally
 *  rather than by re-running selection (the whole point is to trust the recorded spec
 *  instead of the hash-order recomputation), so a legal spec can carry a DIFFERENT
 *  challenge than recomputation would have picked (e.g. the server asked counsel_of_record
 *  while hash order would have picked a different seed fact) and still be used verbatim. */
/** Order-insensitive array equality -- a recorded spec's `accept_tokens` must be the SAME
 *  SET the seed entry carries, not merely present, so a doctored/edited token list can't
 *  pass as a legal reconstruction of a real `selectSeedFact` choice. */
function sameTokenSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((t, i) => t === sortedB[i]);
}

/** Fix round 1 (review of 2a08920 + 7d16440), finding 1: the original checks only proved
 *  the referenced id EXISTED, not that the spec was actually CONSISTENT with what that id
 *  points to. A spec could name a real `fact_id`/claim id and still carry a field, tokens,
 *  or trap value that `selectSeedFact`/`selectLiveCommitment`/`selectTrapFact` never would
 *  have produced -- e.g. a SEED_FACT spec whose `field` doesn't match `seedFieldForEntry`
 *  for its own `fact_id`, or a TRAP_FACT spec whose `trap_value` happens to equal the true
 *  claim's own value (which would make it not a trap at all). Every kind now checks full
 *  structural consistency against what the id it names actually is, plus (for TRAP_FACT and
 *  RELATIONAL) the same once-per-call rule `selectChallenge` itself enforces. */
function isLegalSpec(spec: ChallengeSpec, issued: ChallengeSpec[], claimsAsOf: Claim[], seed: SeedConfig, session_id: string): boolean {
  if (spec.challenge_id !== `${session_id}-${issued.length + 1}`) return false;
  if (spec.kind === 'SEED_FACT') {
    if (!spec.fact_id) return false;
    const entry = seed.knowledge.find((k) => k.id === spec.fact_id);
    if (!entry) return false;
    if (!('accept_tokens' in spec.expect) || !sameTokenSet(spec.expect.accept_tokens, entry.accept_tokens)) return false;
    if (spec.field !== seedFieldForEntry(entry.id)) return false;
    return !issued.some((s) => s.kind === 'SEED_FACT' && s.fact_id === spec.fact_id);
  }
  if (spec.kind === 'LIVE_COMMITMENT') {
    const expect = spec.expect;
    if (!('commitment_claim_id' in expect)) return false;
    const claim = claimsAsOf.find((c) => c.id === expect.commitment_claim_id);
    return claim !== undefined && claim.field === spec.field;
  }
  if (spec.kind === 'TRAP_FACT') {
    const expect = spec.expect;
    if (!('true_claim_id' in expect)) return false;
    const claim = claimsAsOf.find((c) => c.id === expect.true_claim_id);
    if (!claim || claim.field !== spec.field) return false;
    if (issued.some((s) => s.kind === 'TRAP_FACT')) return false; // once per call, mirrors selectChallenge
    return normalizeValue(spec.field, expect.trap_value) !== claim.value;
  }
  // RELATIONAL: expect is accept_tokens-shaped (no claim id of its own) -- the field it
  // depends on (escrow_institution, or beneficiary as the fallback) must have been claimed
  // by this point, the same precondition `selectRelational` itself requires; and at most
  // one RELATIONAL per call, mirroring `selectChallenge`'s once-per-call rule.
  if (issued.some((s) => s.kind === 'RELATIONAL')) return false;
  return claimsAsOf.some((c) => c.field === 'escrow_institution' || c.field === 'beneficiary');
}

/** Rebuilds the sequence of `ChallengeSpec`s that were actually issued, from the
 *  `challenge_issued` actions and the ledger. When an action carries a `spec` (the server's
 *  own record of what it asked) that is a LEGAL choice at that point (see `isLegalSpec`),
 *  it is used verbatim -- this is what lets the knowledge card name the exact question
 *  asked instead of whatever a hash-order recomputation would have picked. When an action
 *  carries no `spec` (or an illegal one), falls back to the prior behavior: re-runs
 *  `selectChallenge` as of each action's t_ms (claims with t_ms <= action.t_ms only). If
 *  neither the recorded spec nor the rebuilt spec's challenge_id matches the action's (log
 *  drift -- e.g. a replayed/edited corpus file, or a server/engine version mismatch), a
 *  placeholder spec is kept instead of dropping the action: there is no reliable spec to
 *  grade the caller's answer against, so it is treated as UNANSWERED (amendment §D step 3)
 *  by `buildKnowledgeEvidence`, never silently vanished from the evidence record. */
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

    if (action.spec) {
      if (isLegalSpec(action.spec, issued, claimsAsOf, seed, session_id)) {
        issued.push(action.spec);
      } else {
        issued.push(driftSpec(action.challenge_id, action.id));
      }
      continue;
    }

    const rebuilt = selectChallenge(claimsAsOf, issued, {}, seed, session_id, conversationAsOf);
    if (rebuilt && rebuilt.challenge_id === action.challenge_id) {
      issued.push(rebuilt);
      continue;
    }
    issued.push(driftSpec(action.challenge_id, action.id));
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

// ---------- judge-legible knowledge-card detail (review finding, final wave) ----------

/** Strips a leading "Ask " (any case) off a seed KnowledgeFact's `ask` phrasing goal, e.g.
 *  "Ask which law firm is our counsel of record on the Hartwell deal." becomes "which law
 *  firm is our counsel of record on the Hartwell deal." -- used to describe what was asked
 *  without echoing the LLM-facing imperative verb. */
function stripAskPrefix(ask: string): string {
  return ask.replace(/^ask\s+/i, '').trim();
}

function trimQuote(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

/** Resolves the specific seed.knowledge entry a SEED_FACT spec was drawn from: prefers the
 *  spec's own `fact_id` (set by `selectSeedFact`); falls back to matching `accept_tokens`
 *  back against every seed.knowledge entry (for specs reconstructed before `fact_id`
 *  existed, or any other path that only carries `expect`). */
function resolveSeedFact(spec: ChallengeSpec, seed: SeedConfig): KnowledgeFact | undefined {
  if (spec.fact_id) {
    const byId = seed.knowledge.find((k) => k.id === spec.fact_id);
    if (byId) return byId;
  }
  if ('accept_tokens' in spec.expect) {
    const tokens = spec.expect.accept_tokens;
    return seed.knowledge.find((k) => k.accept_tokens.length === tokens.length && k.accept_tokens.every((t, i) => t === tokens[i]));
  }
  return undefined;
}

const AMBIGUOUS_ANSWER_LABEL: Record<ChallengeResult, string> = {
  PASS: 'PASS',
  FAIL: 'FAIL',
  AMBIGUOUS: 'no usable answer',
  REFUSED: 'refused',
  UNANSWERED: 'unanswered',
};

function seedFactDetail(spec: ChallengeSpec, result: ChallengeResult, quoteText: string | undefined, seed: SeedConfig): string {
  const entry = resolveSeedFact(spec, seed);
  // The seed KnowledgeFact's own `ask` (stripped of its leading "Ask ") is the most specific
  // source; a bare `spec.ask` covers the case where the entry itself couldn't be resolved;
  // `entry.topic` is the last-resort fallback if even that is empty (e.g. a hand-built spec).
  const rawAsk = entry?.ask || spec.ask;
  const askedText = rawAsk.length > 0 ? stripAskPrefix(rawAsk) : (entry?.topic ?? spec.field.replace('_', ' '));
  const answered = quoteText ? `caller answered "${trimQuote(quoteText)}"` : 'caller gave no answer';
  return `Asked: ${askedText}; ${answered}: ${AMBIGUOUS_ANSWER_LABEL[result]}.`;
}

function outcomeWord(result: ChallengeResult, matchWord: string, mismatchWord: string): string {
  if (result === 'PASS') return matchWord;
  if (result === 'FAIL') return mismatchWord;
  if (result === 'REFUSED') return 'was refused';
  if (result === 'UNANSWERED') return 'was never given';
  return 'was ambiguous';
}

function liveCommitmentDetail(spec: ChallengeSpec, result: ChallengeResult): string {
  const fieldLabel = spec.field.replace('_', ' ');
  return `Asked the caller to restate their ${fieldLabel}; answer ${outcomeWord(result, 'matched', 'did not match')}.`;
}

function trapFactDetail(spec: ChallengeSpec, result: ChallengeResult): string {
  const fieldLabel = spec.field.replace('_', ' ');
  const outcome = result === 'PASS' ? 'corrected it' : result === 'FAIL' ? 'accepted the wrong value' : 'gave no clear answer';
  return `Consistency probe (deliberate misstatement of ${fieldLabel}): caller ${outcome}.`;
}

function relationalDetail(spec: ChallengeSpec, result: ChallengeResult): string {
  const fieldLabel = spec.field.replace('_', ' ');
  return `Relational check (${fieldLabel}): answer ${outcomeWord(result, 'matched', 'did not match')}.`;
}

function knowledgeCardDetail(spec: ChallengeSpec, result: ChallengeResult, quoteText: string | undefined, seed: SeedConfig): string {
  if (spec.kind === 'SEED_FACT') return seedFactDetail(spec, result, quoteText, seed);
  if (spec.kind === 'LIVE_COMMITMENT') return liveCommitmentDetail(spec, result);
  if (spec.kind === 'TRAP_FACT') return trapFactDetail(spec, result);
  return relationalDetail(spec, result);
}

export function buildKnowledgeEvidence(
  issued: ChallengeSpec[],
  results: Record<string, { result: ChallengeResult; quote?: { utterance_id: string; text: string }; eligible_utterance_ids: string[] }>,
  actions: AgentAction[],
  request_version: number,
  seed: SeedConfig,
): Evidence[] {
  const out: Evidence[] = [];
  for (const spec of issued) {
    const drifted = isDrift(spec);
    // A drifted placeholder is never graded by the real grader (its expect.accept_tokens is
    // deliberately empty, which would otherwise vacuously PASS) -- it is forced UNANSWERED.
    const graded = drifted ? { result: 'UNANSWERED' as ChallengeResult, eligible_utterance_ids: [] as string[] } : results[spec.challenge_id];
    if (!graded) continue;
    const issuedAction = actions.find((a) => a.kind === 'challenge_issued' && a.challenge_id === spec.challenge_id);
    const seedFactEntry = spec.kind === 'SEED_FACT' && !drifted ? resolveSeedFact(spec, seed) : undefined;
    out.push({
      id: `ev-knowledge-${spec.challenge_id}`,
      kind: 'knowledge_check_result',
      t_ms: issuedAction?.t_ms ?? 0,
      label: drifted ? 'Knowledge check (log drift)' : labelForChallenge(spec),
      status: statusForResult(graded.result),
      detail: drifted
        ? 'The issued challenge could not be reconstructed from the ledger (log drift); treated as unanswered.'
        : knowledgeCardDetail(spec, graded.result, graded.quote?.text, seed),
      facts: {
        kind: drifted ? 'DRIFT' : spec.kind,
        result: graded.result,
        field: seedFactEntry ? seedFactEntry.id : spec.field,
      },
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
        ? `Caller said "${superseded.quote.text}", then said "${claim.quote.text}", with no correction offered.`
        : `Caller contradicted an earlier ${claim.field.replace('_', ' ')} claim with no correction offered: "${claim.quote.text}".`,
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
  const threshold = seed.thresholds.high_value_usd;
  const over = exposure_usd > threshold && current_usd < threshold;
  const currentAloneOverThreshold = current_usd >= threshold;
  const last = amountClaims[amountClaims.length - 1]!;
  // PASS covers two distinct shapes, and conflating them into one "within the threshold"
  // sentence was misleading (review finding, final wave): when the CURRENT request is
  // itself at/above the high-value threshold, second approval is required regardless of
  // the anti-structuring check -- the card must say so, not imply everything's fine.
  const detail = over
    ? `Distinct amounts stated this call total ${money(exposure_usd)}, above the ${money(threshold)} threshold, while the current request alone reads under it.`
    : currentAloneOverThreshold
      ? `Current request ${money(current_usd)} is itself above the ${money(threshold)} high-value threshold; second approval required regardless.`
      : `Distinct amounts stated total ${money(exposure_usd)}, within the ${money(threshold)} threshold.`;
  return {
    id: 'ev-exposure',
    kind: 'exposure_check_result',
    t_ms: last.t_ms,
    label: 'Cumulative exposure',
    status: over ? 'FAIL' : 'PASS',
    detail,
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
    evaluation_incomplete: computeEvaluationIncomplete(tools, conversation, actions, seed),
    critical_confirmed: computeCriticalConfirmed(claims),
    identity_switch_stale: identitySwitchEv?.status === 'FLAG',
  };
}

export { buildLedger };
