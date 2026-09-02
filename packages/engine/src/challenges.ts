// packages/engine/src/challenges.ts
// Engine-issued challenges: the LLM MAY ASK, IT MAY NEVER GRADE. `selectChallenge` picks
// the next question and phrases a goal for the LLM (`ask`); the goal string never contains
// the expected answer. `gradeChallenges` is the only thing that decides PASS/FAIL/etc,
// deterministically, from plain transcript matching. No claim about voice authenticity
// anywhere in this file — behavioral verification only.
//
// Coordination note (Task 9, 2026-09-01): Task 8 (story ledger) owns `src/normalize.ts`
// and `src/ledger.ts` and was running in parallel. Both had landed by the time this file
// was finished (`normalizeText`/`normalizeValue` in normalize.ts, `currentClaim` in
// ledger.ts), so this file imports the shared implementations directly rather than
// defining private copies.

import type {
  AgentAction,
  Claim,
  ClaimField,
  ChallengeResult,
  ChallengeSpec,
  Quote,
  SeedConfig,
  Utterance,
} from './types';
import { hasLexiconHit, normalizeText } from './normalize';
import { currentClaim } from './ledger';
import { extractAmounts } from './extract/amounts';
import { extractAccountLast4, extractCuedNames, extractDeadline } from './extract/claims';
import { fnv1a } from './hash';

export { fnv1a } from './hash';

// ---------- selectChallenge ----------

const LIVE_COMMITMENT_FIELDS: ClaimField[] = [
  'amount_usd',
  'beneficiary',
  'approver',
  'counsel',
  'escrow_institution',
  'deadline',
];

type TrapField = 'beneficiary' | 'counsel' | 'escrow_institution' | 'approver';
const TRAP_FIELD_ORDER: TrapField[] = ['beneficiary', 'counsel', 'escrow_institution', 'approver'];

const TRAP_DECOYS: Record<TrapField, string> = {
  counsel: 'Whitmore & Bass',
  escrow_institution: 'Harbor Fidelity Trust',
  beneficiary: 'Meridian Supply',
  approver: 'Marcus Obi',
};

/** Count of caller utterances strictly after `t_ms`. Absent conversation ⇒ every claim is
 *  treated as old enough (Infinity). */
function callerTurnsAfter(conversation: Utterance[] | undefined, t_ms: number): number {
  if (!conversation) return Number.POSITIVE_INFINITY;
  return conversation.filter((u) => u.speaker === 'caller' && u.t_ms > t_ms).length;
}

function selectLiveCommitment(
  claims: Claim[],
  issued: ChallengeSpec[],
  conversation: Utterance[] | undefined,
  challengeId: string,
): ChallengeSpec | null {
  let best: { field: ClaimField; claim: Claim } | null = null;
  for (const field of LIVE_COMMITMENT_FIELDS) {
    const claim = currentClaim(claims, field);
    if (!claim) continue;
    if (claim.kind !== 'STATED' && claim.kind !== 'CONFIRMED') continue;
    if (issued.some((s) => s.field === field)) continue;
    if (callerTurnsAfter(conversation, claim.t_ms) < 2) continue;
    if (!best || claim.t_ms < best.claim.t_ms) best = { field, claim };
  }
  if (!best) return null;
  return {
    challenge_id: challengeId,
    kind: 'LIVE_COMMITMENT',
    field: best.field,
    ask: `Ask the caller to restate the ${best.field} they gave earlier. Do not say the value yourself.`,
    expect: { commitment_claim_id: best.claim.id },
  };
}

function knowledgeTruthForField(field: TrapField, seed: SeedConfig): string | null {
  if (field === 'counsel') return seed.knowledge.find((k) => k.id === 'counsel_of_record')?.truth ?? null;
  if (field === 'escrow_institution') return seed.knowledge.find((k) => k.id === 'escrow_institution')?.truth ?? null;
  return null;
}

function selectTrapFact(claims: Claim[], seed: SeedConfig, challengeId: string): ChallengeSpec | null {
  for (const field of TRAP_FIELD_ORDER) {
    const claim = currentClaim(claims, field);
    if (!claim) continue;
    const claimStr = String(claim.value);
    const truth = knowledgeTruthForField(field, seed);
    let trapValue: string;
    if (truth !== null && normalizeText(claimStr) !== normalizeText(truth)) {
      // The caller was wrong: the trap offers the truth.
      trapValue = truth;
    } else {
      let decoy = TRAP_DECOYS[field];
      if (normalizeText(decoy) === normalizeText(claimStr)) decoy = 'Northgate Partners';
      trapValue = decoy;
    }
    return {
      challenge_id: challengeId,
      kind: 'TRAP_FACT',
      field,
      ask: `Confirm the request back to the caller as if summarizing, but say "${trapValue}" in place of their ${field}, then pause.`,
      expect: { trap_value: trapValue, true_claim_id: claim.id },
    };
  }
  return null;
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// Exported for compose.ts's `isLegalSpec`: a recorded SEED_FACT spec's `field` must equal
// this same mapping for its `fact_id`, or it's not a spec `selectSeedFact` could have built.
export function seedFieldForEntry(id: string): ClaimField {
  if (id === 'counsel_of_record') return 'counsel';
  if (id === 'escrow_institution') return 'escrow_institution';
  return 'purpose';
}

function selectSeedFact(
  issued: ChallengeSpec[],
  seed: SeedConfig,
  session_id: string,
  challengeId: string,
): ChallengeSpec | null {
  const unused = seed.knowledge.filter(
    (k) => !issued.some((s) => 'accept_tokens' in s.expect && arraysEqual(s.expect.accept_tokens, k.accept_tokens)),
  );
  if (unused.length === 0) return null;
  const sorted = [...unused].sort(
    (a, b) => fnv1a(`${session_id}:${a.id}`) - fnv1a(`${session_id}:${b.id}`),
  );
  const entry = sorted[0]!;
  return {
    challenge_id: challengeId,
    kind: 'SEED_FACT',
    field: seedFieldForEntry(entry.id),
    ask: entry.ask,
    expect: { accept_tokens: entry.accept_tokens },
    fact_id: entry.id,
  };
}

function selectRelational(claims: Claim[], issued: ChallengeSpec[], seed: SeedConfig, challengeId: string): ChallengeSpec | null {
  const escrow = currentClaim(claims, 'escrow_institution');
  const beneficiary = currentClaim(claims, 'beneficiary');
  let humanField: string | null = null;
  if (escrow) humanField = 'escrow institution';
  else if (beneficiary) humanField = 'beneficiary';
  if (!humanField) return null;
  const entry = seed.knowledge.find((k) => k.id === 'escrow_account_last4');
  const acceptTokens = entry ? entry.accept_tokens : [];
  // Same fact must never be asked twice under two kinds (e.g. already surfaced as a
  // SEED_FACT challenge) — dedup the same way selectSeedFact does.
  if (issued.some((s) => 'accept_tokens' in s.expect && arraysEqual(s.expect.accept_tokens, acceptTokens))) {
    return null;
  }
  return {
    challenge_id: challengeId,
    kind: 'RELATIONAL',
    field: 'account_last4',
    ask: `Ask for the last four digits of the account attached to the ${humanField} they named.`,
    expect: { accept_tokens: acceptTokens },
  };
}

/** Deterministic: same (claims, issued, results, seed, session_id, conversation) → the
 *  same spec every time. Order of preference: LIVE_COMMITMENT, then TRAP_FACT (once per
 *  call), then RELATIONAL (once per call), then SEED_FACT. (Ruled reorder, 2026-09-01
 *  11:24 PM CDT: RELATIONAL is conversation-derived -- it asks for the account of the bank
 *  the CALLER named -- and so ranks above the seeded, non-conversational SEED_FACT
 *  question; otherwise RELATIONAL was dead code against the shipping seed, since SEED_FACT
 *  would always exhaust the challenge budget first.) Null once
 *  `seed.thresholds.max_challenges` have been issued, or nothing applies. `results` is
 *  accepted for interface symmetry with the grading side; nothing here currently changes
 *  selection based on past results (a FAILED/PASSED challenge is still "issued" and thus
 *  excluded from re-selection via `issued`). */
export function selectChallenge(
  claims: Claim[],
  issued: ChallengeSpec[],
  results: Record<string, ChallengeResult>,
  seed: SeedConfig,
  session_id: string,
  conversation?: Utterance[],
): ChallengeSpec | null {
  void results;
  if (issued.length >= seed.thresholds.max_challenges) return null;
  const challengeId = `${session_id}-${issued.length + 1}`;

  const live = selectLiveCommitment(claims, issued, conversation, challengeId);
  if (live) return live;

  if (!issued.some((s) => s.kind === 'TRAP_FACT')) {
    const trap = selectTrapFact(claims, seed, challengeId);
    if (trap) return trap;
  }

  if (!issued.some((s) => s.kind === 'RELATIONAL')) {
    const relational = selectRelational(claims, issued, seed, challengeId);
    if (relational) return relational;
  }

  const seedFact = selectSeedFact(issued, seed, session_id, challengeId);
  if (seedFact) return seedFact;

  return null;
}

// ---------- gradeChallenges ----------

const REFUSAL_RE = /(not going to|won't|will not|can't tell|cannot tell|don't know|do not know|refuse)/;

const NAME_FIELDS: ClaimField[] = ['beneficiary', 'approver', 'counsel', 'escrow_institution'];
function isNameField(field: ClaimField): field is 'beneficiary' | 'approver' | 'counsel' | 'escrow_institution' {
  return (NAME_FIELDS as ClaimField[]).includes(field);
}

/** Caller utterances strictly after `issuedAction.t_ms` and strictly before the next
 *  agent action (challenge_issued or readback_issued) after it, capped at 2. */
function eligibleUtterances(conversation: Utterance[], actions: AgentAction[], issuedAction: AgentAction): Utterance[] {
  const nextAgentActionT = actions
    .filter((a) => (a.kind === 'challenge_issued' || a.kind === 'readback_issued') && a.t_ms > issuedAction.t_ms)
    .reduce<number | undefined>((min, a) => (min === undefined || a.t_ms < min ? a.t_ms : min), undefined);
  return conversation
    .filter(
      (u) =>
        u.speaker === 'caller' &&
        u.t_ms > issuedAction.t_ms &&
        (nextAgentActionT === undefined || u.t_ms < nextAgentActionT),
    )
    .sort((a, b) => a.t_ms - b.t_ms)
    .slice(0, 2);
}

function gradeLiveCommitment(field: ClaimField, claim: Claim | undefined, rawText: string, normText: string): ChallengeResult {
  if (!claim) return 'AMBIGUOUS';
  const committedNorm = normalizeText(String(claim.value));

  if (field === 'amount_usd') {
    const committedNum = Number(claim.value);
    const hits = extractAmounts(rawText);
    if (hits.some((h) => h.value_usd === committedNum)) return 'PASS';
    if (hits.some((h) => h.value_usd !== committedNum)) return 'FAIL';
    return 'AMBIGUOUS';
  }
  if (field === 'account_last4') {
    const hit = extractAccountLast4(rawText);
    if (!hit) return 'AMBIGUOUS';
    return hit.value === String(claim.value) ? 'PASS' : 'FAIL';
  }
  if (field === 'deadline') {
    const hit = extractDeadline(rawText);
    if (!hit) return 'AMBIGUOUS';
    return normalizeText(hit.value) === committedNorm ? 'PASS' : 'FAIL';
  }
  if (isNameField(field)) {
    if (normText.includes(committedNorm)) return 'PASS';
    const cued = extractCuedNames(rawText).filter((h) => h.field === field);
    for (const hit of cued) {
      if (normalizeText(hit.value) !== committedNorm) return 'FAIL';
    }
    const capMatch = rawText.match(/\b[A-Z][A-Za-z.']*\s+[A-Z][A-Za-z.']*\b/);
    if (capMatch && normalizeText(capMatch[0]) !== committedNorm) return 'FAIL';
    return 'AMBIGUOUS';
  }
  return normText.includes(committedNorm) ? 'PASS' : 'AMBIGUOUS';
}

function escapeRegExpLocal(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Removes every whole-word/phrase occurrence of any `lexicon` entry from `normText` (both
 *  already run through `normalizeText`), longest phrases first so a multi-word match like
 *  "that's not" is consumed whole rather than leaving its words to be stripped twice.
 *  Returns the remaining text (collapsed whitespace) and whether anything was removed. */
function stripLexicon(normText: string, lexicon: string[]): { remainder: string; hit: boolean } {
  let working = normText;
  let hit = false;
  const phrases = [...new Set(lexicon.map((p) => normalizeText(p)).filter((p) => p.length > 0))].sort(
    (a, b) => b.split(' ').length - a.split(' ').length,
  );
  for (const phrase of phrases) {
    const pattern = new RegExp(`\\b${escapeRegExpLocal(phrase).replace(/\s+/g, '\\s+')}\\b`, 'g');
    if (pattern.test(working)) {
      hit = true;
      working = working.replace(pattern, ' ');
    }
  }
  return { remainder: working.replace(/\s+/g, ' ').trim(), hit };
}

const NEGATION_FILLER_TOKENS = new Set(['thats', 'its', 'wrong', 'incorrect']);

/** Rule (c): the reply is ONLY a negation. After stripping every negate-lexicon phrase,
 *  nothing meaningful is left — either nothing at all ("no"), or a single leftover token
 *  that reads as the grammatical object of the negation rather than an independent
 *  affirmation (e.g. "that's not right" strips "that's not", leaving "right" — the thing
 *  being negated, not a confirmation). Two or more leftover words (e.g. "not sure but
 *  sure, go ahead") means there is unrelated content beyond the bare negation, so this
 *  rule does not fire. */
function isPureNegation(normText: string, seed: SeedConfig): boolean {
  const { remainder, hit } = stripLexicon(normText, seed.negate_lexicon);
  if (!hit) return false;
  if (remainder.length === 0) return true;
  const remainderTokens = remainder.split(' ').filter(Boolean);
  if (remainderTokens.length > 1) return false;
  const leftover = remainderTokens[0]!;
  if (NEGATION_FILLER_TOKENS.has(leftover)) return true;
  return seed.affirm_lexicon.some((phrase) => normalizeText(phrase) === leftover);
}

/** Rule (b): a negate-lexicon phrase occurs within 4 words (before or after) of the trap
 *  value's normalized form — the caller rejected the planted value directly, without
 *  necessarily restating the true one (e.g. "no, not Calder & Finch, ask counsel"). */
function negateNearTrapValue(normText: string, trapValueNorm: string, seed: SeedConfig): boolean {
  if (trapValueNorm.length === 0) return false;
  const tokens = normText.split(' ').filter(Boolean);
  const trapTokens = trapValueNorm.split(' ').filter(Boolean);
  if (trapTokens.length === 0) return false;
  const trapStarts: number[] = [];
  for (let i = 0; i + trapTokens.length <= tokens.length; i++) {
    if (trapTokens.every((t, j) => tokens[i + j] === t)) trapStarts.push(i);
  }
  if (trapStarts.length === 0) return false;

  const negatePhrases = [...new Set(seed.negate_lexicon.map((p) => normalizeText(p)).filter((p) => p.length > 0))];
  for (const phrase of negatePhrases) {
    const pTokens = phrase.split(' ').filter(Boolean);
    for (let i = 0; i + pTokens.length <= tokens.length; i++) {
      if (!pTokens.every((t, j) => tokens[i + j] === t)) continue;
      const negStart = i;
      const negEnd = i + pTokens.length - 1;
      for (const trapStart of trapStarts) {
        const trapEnd = trapStart + trapTokens.length - 1;
        const gap = negStart > trapEnd ? negStart - trapEnd - 1 : trapStart > negEnd ? trapStart - negEnd - 1 : 0;
        if (gap <= 4) return true;
      }
    }
  }
  return false;
}

function gradeTrapFact(trueClaim: Claim | undefined, rawText: string, seed: SeedConfig, trapValue: string): ChallengeResult {
  const normText = normalizeText(rawText);
  const trueVal = trueClaim ? normalizeText(String(trueClaim.value)) : null;
  const containsTrue = trueVal !== null && trueVal.length > 0 && normText.includes(trueVal);
  const trapValueNorm = normalizeText(trapValue);

  // (a) the reply contains the TRUE claim's normalized value.
  if (containsTrue) return 'PASS';
  // (b) a negate hit occurs within 4 words of the trap value's normalized form.
  if (negateNearTrapValue(normText, trapValueNorm, seed)) return 'PASS';
  // (c) the reply is only a negation (word-boundary lexicon matching, not a naive
  // substring test — a naive test let "no" fire inside "know" and "right" fire inside
  // "alright"/"copyright"; stripLexicon/hasLexiconHit normalize both sides and match whole
  // words/phrases only).
  if (isPureNegation(normText, seed)) return 'PASS';

  if (hasLexiconHit(rawText, seed.affirm_lexicon)) return 'FAIL';
  return 'AMBIGUOUS';
}

/** For each issued spec, grades the caller's eligible reply against `expect`, purely from
 *  the transcript — never from the LLM's own account of what happened. `claims` resolves
 *  the claim ids referenced by LIVE_COMMITMENT (`commitment_claim_id`) and TRAP_FACT
 *  (`true_claim_id`) specs; it is required for correct grading and is passed alongside the
 *  four arguments named in the task brief's interface sketch. */
export function gradeChallenges(
  conversation: Utterance[],
  actions: AgentAction[],
  issued: ChallengeSpec[],
  seed: SeedConfig,
  claims: Claim[],
): Record<string, { result: ChallengeResult; quote?: Quote; eligible_utterance_ids: string[] }> {
  const out: Record<string, { result: ChallengeResult; quote?: Quote; eligible_utterance_ids: string[] }> = {};

  for (const spec of issued) {
    const issuedAction = actions.find((a) => a.kind === 'challenge_issued' && a.challenge_id === spec.challenge_id);
    if (!issuedAction) {
      out[spec.challenge_id] = { result: 'UNANSWERED', eligible_utterance_ids: [] };
      continue;
    }

    const eligible = eligibleUtterances(conversation, actions, issuedAction);
    if (eligible.length === 0) {
      out[spec.challenge_id] = { result: 'UNANSWERED', eligible_utterance_ids: [] };
      continue;
    }

    const eligibleIds = eligible.map((u) => u.id);
    const rawText = eligible.map((u) => u.text).join(' ');
    const rawLower = rawText.toLowerCase();
    const normText = normalizeText(rawText);
    const quote: Quote = { utterance_id: eligible[0]!.id, text: eligible[0]!.text };

    if (REFUSAL_RE.test(rawLower)) {
      out[spec.challenge_id] = { result: 'REFUSED', quote, eligible_utterance_ids: eligibleIds };
      continue;
    }

    let result: ChallengeResult;
    const expect = spec.expect;
    if ('accept_tokens' in expect) {
      const words = normText.split(' ');
      const allPresent = expect.accept_tokens.every((tok) => words.includes(normalizeText(tok)));
      result = allPresent ? 'PASS' : 'FAIL';
    } else if ('commitment_claim_id' in expect) {
      const commitmentClaimId = expect.commitment_claim_id;
      const claim = claims.find((c) => c.id === commitmentClaimId);
      result = gradeLiveCommitment(spec.field, claim, rawText, normText);
    } else {
      const trueClaimId = expect.true_claim_id;
      const trueClaim = claims.find((c) => c.id === trueClaimId);
      result = gradeTrapFact(trueClaim, rawText, seed, expect.trap_value);
    }

    out[spec.challenge_id] = { result, quote, eligible_utterance_ids: eligibleIds };
  }

  return out;
}
