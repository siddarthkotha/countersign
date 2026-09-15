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
  KnowledgeFact,
  Quote,
  SeedConfig,
  Utterance,
} from './types.js';
import { hasLexiconHit, normalizeSpokenDigits, normalizeText } from './normalize.js';
import { currentClaim } from './ledger.js';
import { extractAmounts } from './extract/amounts.js';
import { extractAccountLast4, extractCuedNames, extractDeadline } from './extract/claims.js';
import { fnv1a } from './hash.js';
import { escapeRegExp } from './util.js';

export { fnv1a } from './hash.js';

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
    ask: `Ask the caller to restate the ${spokenField(best.field)} they gave earlier. Do not say the value yourself.`,
    // CHALLENGE-SPEAKABLE (2026-09-11): the exact, ready-to-speak version of `ask` above --
    // same spoken-label rule (never the raw field id), same "never say the value" behavior
    // (the value simply never appears in the template).
    speak: `Can you restate the ${spokenField(best.field)} you gave me earlier?`,
    expect: { commitment_claim_id: best.claim.id },
  };
}

/** Fix (reviewer finding, live test, 2026-09-09): this used to look the truth up by FIELD
 *  alone, ignoring who is on the line. `selectSeedFact` already gates its picks through
 *  `factInScope` and the claimed identity; this must go through the exact same gate, or a
 *  caller with no claim to a scoped fact (e.g. Dana Whitfield, on the Hartwell facts scoped
 *  to Robert Miller) can be handed a TRAP_FACT challenge whose "caller was wrong: the trap
 *  offers the truth" branch speaks that fact's real value ALOUD to the wrong person. Out of
 *  scope (or no identity claimed yet) -> null, same as "no truth known here", so the caller
 *  falls straight into the existing decoy-only branch below -- fail-safe, never a deadlock. */
function knowledgeTruthForField(field: TrapField, seed: SeedConfig, claimed_identity_id: string | null): string | null {
  const entry =
    field === 'counsel'
      ? seed.knowledge.find((k) => k.id === 'counsel_of_record')
      : field === 'escrow_institution'
        ? seed.knowledge.find((k) => k.id === 'escrow_institution')
        : undefined;
  if (!entry || !factInScope(entry, claimed_identity_id)) return null;
  return entry.truth;
}

/** CHALLENGE-SPEAKABLE (2026-09-11): natural, per-field confirmation sentence for a
 *  TRAP_FACT's `speak` -- deliberately narrower than `ask`'s "confirm the whole request as
 *  if summarizing" direction (which needs the rest of the live request context, not just
 *  this one field, to actually phrase): states back only the one field under test with the
 *  wrong value and asks for confirmation, the same "Just to confirm... Is that correct?"
 *  shape `fsm.ts`'s `readbackSentence` already uses for READBACK. Judgment call flagged in
 *  this task's report: this is a real behavior narrowing (a single stated fact instead of a
 *  full request summary), traded for a deterministic, testable sentence -- grading is
 *  unaffected either way (gradeChallenges only inspects the caller's reply, never the
 *  question's own wording). */
function trapSentence(field: TrapField, trapValue: string): string {
  switch (field) {
    case 'beneficiary':
      return `Just to confirm, this transfer goes to ${trapValue}. Is that correct?`;
    case 'counsel':
      return `Just to confirm, our counsel of record is ${trapValue}. Is that correct?`;
    case 'escrow_institution':
      return `Just to confirm, the escrow institution is ${trapValue}. Is that correct?`;
    case 'approver':
      return `Just to confirm, this was approved by ${trapValue}. Is that correct?`;
  }
}

function selectTrapFact(claims: Claim[], seed: SeedConfig, challengeId: string): ChallengeSpec | null {
  const claimedIdentity = currentClaim(claims, 'identity');
  const claimed_identity_id = claimedIdentity ? String(claimedIdentity.value) : null;
  for (const field of TRAP_FIELD_ORDER) {
    const claim = currentClaim(claims, field);
    if (!claim) continue;
    const claimStr = String(claim.value);
    const truth = knowledgeTruthForField(field, seed, claimed_identity_id);
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
      speak: trapSentence(field, trapValue),
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
/** Correction (2026-09-04, caught on a live call): challenge directions interpolated the raw
 *  ClaimField id, so the agent said "restate the amount_usd" out loud. Spoken labels only. */
function spokenField(field: string): string {
  if (field === 'amount_usd') return 'amount in dollars';
  if (field === 'account_last4') return 'last four digits of the account';
  return field.replace(/_/g, ' ');
}

export function seedFieldForEntry(id: string): ClaimField {
  if (id === 'counsel_of_record') return 'counsel';
  if (id === 'escrow_institution') return 'escrow_institution';
  if (id === 'dana_internal_approver') return 'approver';
  return 'purpose';
}

/** Fix (judge review, 2026-09-03): `fact` is fair game for `claimed_identity_id` iff it
 *  carries no scope at all (unset/empty `identity_ids` ⇒ askable of anyone, backwards
 *  compatible), or the caller's currently claimed identity appears in that list. A caller
 *  with no claimed identity yet (`null`) can never satisfy a scope -- fail-safe: a SCOPED
 *  fact requires a KNOWN matching identity, never an absence of one. This is what stops a
 *  caller from ever being interrogated about a deal that is somebody else's business (e.g.
 *  the six Hartwell-acquisition facts, scoped to Robert Miller, must never reach Dana
 *  Whitfield on an unrelated Meridian Supply payment). */
function factInScope(fact: KnowledgeFact, claimed_identity_id: string | null): boolean {
  if (!fact.identity_ids || fact.identity_ids.length === 0) return true;
  return claimed_identity_id !== null && fact.identity_ids.includes(claimed_identity_id);
}

/** Founder ruling (2026-09-09, "spent facts"): once a challenge kind has spoken a real
 *  seeded fact's TRUE value aloud in this call, that fact is spent for the rest of the
 *  call -- no challenge kind may ask it again, because the caller could simply repeat what
 *  the agent itself just said rather than demonstrate they already knew it. The only place
 *  a true value is currently spoken by the agent (rather than asked-for) is
 *  `selectTrapFact`'s "caller was wrong: the trap offers the truth" branch below -- LIVE_
 *  COMMITMENT is explicitly told never to say the value, and SEED_FACT/RELATIONAL only ever
 *  ask, never state, the fact. Returns the set of already-spoken truths, normalized. */
function spokenTruths(issued: ChallengeSpec[], seed: SeedConfig): Set<string> {
  const spoken = new Set<string>();
  for (const s of issued) {
    if (s.kind === 'TRAP_FACT' && 'trap_value' in s.expect) {
      const norm = normalizeText(s.expect.trap_value);
      if (seed.knowledge.some((k) => normalizeText(k.truth) === norm)) spoken.add(norm);
    }
  }
  return spoken;
}

/** CHALLENGE-SPEAKABLE (2026-09-11): seed.knowledge `ask` strings are authored as
 *  imperatives for the model to phrase itself, e.g. "Ask which law firm is our counsel of
 *  record on the Hartwell deal." -- this is a mechanical, content-free reshaping into a
 *  direct question ("Which law firm is our counsel of record on the Hartwell deal?"):
 *  strip a leading "Ask " (case-insensitive) and any trailing punctuation, capitalize the
 *  first letter, append "?". Never adds or removes a fact; every entry in
 *  seed/meridian.ts's `knowledge` array already reads as a natural question once the
 *  leading "Ask " is gone (the same words `stripAskPrefix` in compose.ts strips for the
 *  judge-legible evidence label, though that call site keeps the lower-case, non-question
 *  form since it's describing what was asked, not phrasing a question). */
function askToQuestion(ask: string): string {
  const body = ask.replace(/^ask\s+/i, '').replace(/[.?!]+$/, '').trim();
  if (body.length === 0) return ask;
  return `${body.charAt(0).toUpperCase()}${body.slice(1)}?`;
}

function selectSeedFact(
  claims: Claim[],
  issued: ChallengeSpec[],
  seed: SeedConfig,
  session_id: string,
  challengeId: string,
): ChallengeSpec | null {
  const claimedIdentity = currentClaim(claims, 'identity');
  const claimed_identity_id = claimedIdentity ? String(claimedIdentity.value) : null;
  const spoken = spokenTruths(issued, seed);
  const unused = seed.knowledge.filter(
    (k) =>
      !issued.some((s) => 'accept_tokens' in s.expect && arraysEqual(s.expect.accept_tokens, k.accept_tokens)) &&
      factInScope(k, claimed_identity_id) &&
      !spoken.has(normalizeText(k.truth)),
  );
  // Fail-safe (judge review, 2026-09-03): when every remaining fact is out of scope (or
  // already spent) for this caller, return no seed-fact challenge at all rather than
  // falling back to an unscoped one -- there isn't one to fall back to, by construction, but
  // the point stands: null here is the correct, safe answer, not a bug to work around.
  // `selectChallenge` already treats a null SEED_FACT pick as "nothing more to ask" (it's
  // the last kind checked), and fsm.ts's phrasingGoal already has a generic ASK_CHALLENGE
  // fallback for a null nextChallenge -- so this never deadlocks the CHALLENGE state.
  if (unused.length === 0) return null;
  // Controller ruling 2026-09-01 11:25 AM CDT: prioritized facts (e.g. the ratified demo
  // script's counsel-of-record/escrow-institution opener) ask first, in ascending priority
  // order; unset ⇒ Infinity, i.e. after every prioritized entry. Entries with the same
  // priority (including all-unset) keep the existing per-session fnv1a entropy.
  const sorted = [...unused].sort((a, b) => {
    const pa = a.priority ?? Number.POSITIVE_INFINITY;
    const pb = b.priority ?? Number.POSITIVE_INFINITY;
    if (pa !== pb) return pa - pb;
    return fnv1a(`${session_id}:${a.id}`) - fnv1a(`${session_id}:${b.id}`);
  });
  const entry = sorted[0]!;
  return {
    challenge_id: challengeId,
    kind: 'SEED_FACT',
    field: seedFieldForEntry(entry.id),
    ask: entry.ask,
    speak: askToQuestion(entry.ask),
    expect: { accept_tokens: entry.accept_tokens },
    fact_id: entry.id,
  };
}

function selectRelational(claims: Claim[], issued: ChallengeSpec[], seed: SeedConfig, challengeId: string): ChallengeSpec | null {
  const escrow = currentClaim(claims, 'escrow_institution');
  const beneficiary = currentClaim(claims, 'beneficiary');
  let humanField: string | null = null;
  let acceptTokens: string[] | null = null;
  if (escrow) {
    humanField = 'escrow institution';
    // Fix (RT-9b-escrow-grading, trap-scope lane finding 2026-09-09): grade against the
    // escrow_account_last4 fact scoped to whoever is actually claiming an identity on this
    // call, never unconditionally Robert Miller's -- same factInScope gate selectSeedFact/
    // knowledgeTruthForField already use. The old code looked the fact up by id alone, so a
    // caller with no claim to the Hartwell escrow account (e.g. Dana Whitfield, naming an
    // unrelated institution) would be graded against Robert Miller's own digits. If no
    // escrow-account fact is in scope for this caller, there is nothing correct to ask --
    // fail-safe null (same shape as selectSeedFact's out-of-scope null), never someone
    // else's account.
    const claimedIdentity = currentClaim(claims, 'identity');
    const claimed_identity_id = claimedIdentity ? String(claimedIdentity.value) : null;
    const entry = seed.knowledge.find((k) => k.id === 'escrow_account_last4' && factInScope(k, claimed_identity_id));
    if (!entry) return null;
    acceptTokens = entry.accept_tokens;
  } else if (beneficiary) {
    humanField = 'beneficiary';
    // Founder ruling (2026-09-09, sibling bug): grade against the NAMED beneficiary's OWN
    // seeded account, never the Hartwell escrow account by default -- the old code asked
    // "the account attached to the beneficiary they named" but always graded against
    // seed.knowledge's escrow_account_last4 regardless of who that beneficiary was, so an
    // honest caller naming her own real vendor would be failed against someone else's
    // account digits. If the named beneficiary has no seeded payment on file, there is
    // nothing correct to ask -- return no relational challenge at all (same fail-safe shape
    // as selectSeedFact's out-of-scope null) rather than grading against the wrong account.
    const named = normalizeText(String(beneficiary.value));
    const payment = seed.payments.find(
      (p) => normalizeText(p.vendor) === named || p.vendor_aliases.some((alias) => normalizeText(alias) === named),
    );
    if (!payment) return null;
    acceptTokens = [payment.account_last4];
  }
  if (!humanField || acceptTokens === null) return null;
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
    speak: `Can you give me the last four digits of the account attached to the ${humanField} you named?`,
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
 *  accepted for interface symmetry with the grading side; nothing here changes selection
 *  based on past results (a FAILED/AMBIGUOUS/UNANSWERED challenge is still "issued" and thus
 *  excluded from re-selection via `issued`) -- this function answers "what is the next
 *  question, structurally, given what's already been asked", the same question every
 *  existing caller of it (the ~30 unit tests in test/challenges.test.ts and
 *  test/seed-budget.test.ts that pass hand-built `issued` arrays with `results: {}`, plus
 *  `reconstructIssued` in compose.ts) has always asked it.
 *
 *  FIX (2026-09-15, fragment-shaped challenges) -- NOT handled here: an earlier version of
 *  this fix tried to make `selectChallenge` itself refuse to advance while the
 *  most-recently-issued challenge was still AWAITING a caller reply, keyed off
 *  `results[last.challenge_id]` being absent. That broke ~30 pre-existing tests across this
 *  file and test/seed-budget.test.ts, every one of which calls this function directly with a
 *  hand-built `issued` history and `results: {}` to test pure selection ORDER -- `results`
 *  being empty there was never meant to mean "nothing has been answered yet"; it meant "this
 *  test doesn't care." Since real grading can't be told apart from "test doesn't care" from
 *  inside this function, the awaiting-recovery logic instead lives in `fsm.ts`'s
 *  `phrasingGoal` (the CHALLENGE branch there re-asks the last-issued spec verbatim, in
 *  place of whatever this function returns, whenever that challenge has no
 *  knowledge_check_result evidence card yet -- see that function's doc comment for why that
 *  signal is safe and where it comes from). This function's own contract and behavior are
 *  therefore UNCHANGED from before this fix. */
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

  const seedFact = selectSeedFact(claims, issued, seed, session_id, challengeId);
  if (seedFact) return seedFact;

  return null;
}

// ---------- gradeChallenges ----------

const REFUSAL_RE = /(not going to|won't|will not|can't tell|cannot tell|don't know|do not know|refuse)/;

const NAME_FIELDS: ClaimField[] = ['beneficiary', 'approver', 'counsel', 'escrow_institution'];
function isNameField(field: ClaimField): field is 'beneficiary' | 'approver' | 'counsel' | 'escrow_institution' {
  return (NAME_FIELDS as ClaimField[]).includes(field);
}

/** A small stoplist of common English words (titles, articles, connectors) that must never
 *  count as a name signal on their own, even if a seed person-name word happens to collide
 *  with one (e.g. an alias like "Mr. Miller" splits to "mr"/"miller" -- "mr" would otherwise
 *  be a two-letter word already excluded by the length-3 floor below, but the stoplist is
 *  kept as an explicit, seed-independent second guard per the review finding). */
const NAME_TOKEN_STOPWORDS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'co', 'inc', 'llc', 'ltd', 'and', 'the', 'of', 'for', 'to', 'in', 'on', 'at', 'a', 'an',
]);

/** True when every alphabetic "word" in `truth` is capitalized and `truth` contains no
 *  digit -- the cheap, seed-independent heuristic that separates a genuine seeded
 *  organisation/place/person name ("Calder & Finch", "First Meridian Trust", "Lena Voss",
 *  "Zurich", "Ridgeline Logistics") from a non-name knowledge fact value that happens to
 *  live in the same `truth` field ("8830", "August 19", "INV-7734", "CC-2210", "PO-6612",
 *  "Quarterly parts restock" -- the last is sentence-case, not title-case, so it fails this
 *  check same as the digit-bearing ones). Ampersands and other non-alphabetic tokens are
 *  ignored rather than failing the check. */
function isNameLikeTruth(truth: string): boolean {
  if (/\d/.test(truth)) return false;
  const words = truth.split(/\s+/).filter((w) => /[A-Za-z]/.test(w));
  if (words.length === 0) return false;
  return words.every((w) => /^[A-Z]/.test(w));
}

interface SeedNameTokens {
  /** Single-word tokens from PERSON names only (seed identities' full names and aliases,
   *  split into individual words) -- length >= 3 and not in `NAME_TOKEN_STOPWORDS`. A bare
   *  single common word never counts, and an organisation/place word is never split into
   *  individual tokens here (see `phrases` below) -- that was the bug (finding, Sonnet
   *  review of 6a81b98): "first"/"trust"/"supply"/"co"/"parts"/"mr"/"ms"/"cc"/"po" and bare
   *  numbers are no longer produced by this function at all. */
  words: Set<string>;
  /** Whole-phrase names, normalized, matched as a bounded phrase (never split into their
   *  individual common words) -- person full names/aliases, and the named organisations and
   *  places from `seed.knowledge` truths that pass `isNameLikeTruth`, plus payment
   *  vendors/vendor aliases. Sorted longest-first (matching order doesn't matter for a
   *  simple "does this phrase occur" check, but keeps output deterministic for tests). */
  phrases: string[];
}

/** Seed-known person/organisation/place names, normalized, split the way the review
 *  demands: person names contribute both individual words (first/last/alias) AND their
 *  whole phrase; organisations and places contribute ONLY their whole phrase, never their
 *  individual common words. Used by `hasNameSignal` (below) to recognize a genuine but
 *  cue-less answer like "it was Marcus" or "the one in Zurich": a single capitalized word
 *  that IS a real seeded name has no cue verb ("approved by", "counsel is") to anchor an
 *  `extractCuedNames` hit, and (being one word) never matches the bare-two-capitalized-word
 *  span either, so it was previously missed entirely (finding 1, Sonnet review,
 *  2026-09-15/16). Deliberately never built from TRAP_DECOYS: a decoy is a FALSE value --
 *  the caller repeating it is already caught by the trap-value substring check earlier in
 *  `isAnswerShapedFor`'s TRAP_FACT branch, and treating a decoy as a positive "this looks
 *  like an answer" signal here would blur "answered" with "accepted the wrong value".
 *  Rebuilt per call (the seed is small; not worth caching across calls for a pure function).
 *
 *  CRITICAL FIX (Sonnet review of 6a81b98, 2026-09-16): the previous version built this set
 *  from every seed.knowledge entry's `accept_tokens` (already-split single words) and split
 *  every payment vendor/alias into words too, so common words that happen to appear inside
 *  a multi-word seeded name/decoy phrase -- "first", "trust", "supply", "co", "parts",
 *  "mr", "ms", "cc", "po", and bare digit-only tokens -- were individually treated as name
 *  signals. That made filler like "Trust me, this is legitimate." or "We supply parts to
 *  them regularly." answer-shaped for a TRAP_FACT challenge, grading an honest caller's
 *  unrelated small talk AMBIGUOUS (0.5) and closing the awaiting window early. Fixed by
 *  never reading `accept_tokens` here at all: organisations/places now come from
 *  `knowledge.truth` (filtered through `isNameLikeTruth`) and payment vendor fields,
 *  matched only as whole phrases. */
function seedNameTokens(seed: SeedConfig): SeedNameTokens {
  const words = new Set<string>();
  const phraseSet = new Set<string>();

  const addPersonName = (s: string) => {
    const norm = normalizeText(s);
    if (norm.length === 0) return;
    phraseSet.add(norm);
    for (const w of norm.split(' ')) {
      if (w.length >= 3 && !NAME_TOKEN_STOPWORDS.has(w)) words.add(w);
    }
  };
  const addEntityPhrase = (s: string) => {
    const norm = normalizeText(s);
    if (norm.length > 0) phraseSet.add(norm);
  };

  for (const identity of seed.identities) {
    addPersonName(identity.name);
    for (const alias of identity.aliases) addPersonName(alias);
  }
  for (const fact of seed.knowledge) {
    if (isNameLikeTruth(fact.truth)) addEntityPhrase(fact.truth);
  }
  for (const payment of seed.payments) {
    addEntityPhrase(payment.vendor);
    for (const alias of payment.vendor_aliases) addEntityPhrase(alias);
  }

  return { words, phrases: [...phraseSet].sort((a, b) => b.length - a.length) };
}

/** True when `normText` (already `normalizeText`-normalized) contains any of `phrases` as a
 *  bounded whole phrase -- same word-boundary shape as `stripLexicon`/`hasLexiconHit`, so a
 *  multi-word org name only counts when it appears intact, never via one of its individual
 *  words. */
function hasNamePhrase(normText: string, phrases: string[]): boolean {
  for (const phrase of phrases) {
    const pattern = new RegExp(`\\b${escapeRegExp(phrase).replace(/\s+/g, '\\s+')}\\b`);
    if (pattern.test(normText)) return true;
  }
  return false;
}

/** True when `rawText` contains a plausible name-answer signal for `field`: a cued name
 *  extraction for this exact field, a bare two-capitalized-word span (a raw-text check,
 *  never normalized -- capitalization is the only cheap signal a name span has once it's
 *  outside a recognized cue pattern like "counsel is X"), or (finding 1, Sonnet review,
 *  2026-09-15/16) a seed-known name signal from `seedNameTokens` -- either a whole seeded
 *  organisation/place/person phrase occurring intact, or a single word from a seeded
 *  PERSON name (first/last/alias) -- catching a genuine cue-less answer like "it was
 *  Marcus" or "the one in Zurich" that neither earlier check recognizes, while never
 *  treating a bare common word that merely happens to appear inside a longer seeded org
 *  name (e.g. "trust", "supply") as a signal by itself (CRITICAL fix, Sonnet review of
 *  6a81b98). This is a SIGNAL check only (does this look like an attempt to answer at all),
 *  never a correctness check -- `gradeLiveCommitment`/`gradeTrapFact` still decide
 *  PASS/FAIL/AMBIGUOUS from the actual content once grading proceeds; a signal-shaped but
 *  incomplete answer (e.g. a first name where the full name was committed) can still grade
 *  AMBIGUOUS, same as today -- the fix only stops it from being silently left AWAITING
 *  forever (never graded at all) when no further caller utterance ever arrives. Shared by
 *  the TRAP_FACT and LIVE_COMMITMENT name-field branches of `isAnswerShapedFor` below. */
function hasNameSignal(field: ClaimField, rawText: string, seed: SeedConfig): boolean {
  if (/\b[A-Z][A-Za-z.']*\s+[A-Z][A-Za-z.']*\b/.test(rawText)) return true;
  if (extractCuedNames(rawText).some((h) => h.field === field)) return true;
  const known = seedNameTokens(seed);
  const normText = normalizeText(rawText);
  if (hasNamePhrase(normText, known.phrases)) return true;
  return normText
    .split(' ')
    .filter(Boolean)
    .some((w) => known.words.has(w));
}

/** True when `rawText` contains a plausible answer signal for a non-name `field` --
 *  the same shape of content `gradeLiveCommitment` itself would extract, checked generically
 *  (not required to MATCH the committed value: a wrong restatement must still reach grading
 *  so it can FAIL, not stay stuck awaiting). */
function hasFieldSignal(field: ClaimField, rawText: string): boolean {
  if (field === 'account_last4') {
    // 2+ consecutive digits, or 2+ spelled-out digit words (a lone spelled digit reads as
    // filler more often than an answer attempt -- "oh" alone, "zero" alone).
    const digitPattern = /\d{2,}|(?:zero|one|two|three|four|five|six|seven|eight|nine|oh)\b/gi;
    const matches = rawText.match(digitPattern);
    if (matches && matches.length >= 2) return true;
    if (extractAccountLast4(rawText) !== null) return true;
    // FIX (finding 1, Sonnet review, 2026-09-15/16): the checks above only catch a bare
    // digit run or 2+ SEPARATE single-digit words -- a compound/doubled digit-word reading
    // of an account/phone-style number ("eighty-eight thirty", "double eight three oh")
    // resolves to 2+ digits under `normalizeSpokenDigits` even though neither prior check
    // fires on it (a tens word like "eighty" or "thirty" isn't in the single-digit-word
    // list, and "double eight" isn't 2 separate digit words at all).
    //
    // Known, accepted gap (2026-09-16, name-tokens lane): `rawText` here can already be a
    // multi-utterance joined string (this is a SIGNAL check only, called from
    // `isAnswerShapedFor` on the pre-joined `rawText` `gradeChallenges` builds) -- unlike the
    // accept_tokens grading branch in `gradeChallenges`, this call site does not have access
    // to the individual eligible utterances to normalize each one separately, so a digit run
    // could in principle form across an utterance boundary here. Left as-is: `account_last4`
    // is never a real `LIVE_COMMITMENT_FIELDS`/`TRAP_FIELD_ORDER` field (see the exhaustiveness
    // comment above `isAnswerShapedFor`), so this branch is unreachable from any real
    // `selectChallenge`-produced spec today, and even if it fired wrongly it would only ever
    // widen "does this look like an answer" -- the actual PASS/FAIL grading for account_last4
    // goes through `extractAccountLast4`/accept_tokens matching, which this function never
    // performs.
    return /\d{2,}/.test(normalizeSpokenDigits(rawText));
  }
  if (field === 'amount_usd') {
    if (extractAmounts(rawText).length > 0) return true;
    return /\b\d+\b/.test(rawText);
  }
  if (field === 'deadline') {
    if (extractDeadline(rawText)) return true;
    if (/\b\d+\b/.test(rawText)) return true;
    return /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|tonight|eod|end\s+of\s+day)\b/i.test(rawText);
  }
  return false;
}

/** FIX (2026-09-15, fragment-shaped challenges): is `rawText` shaped like an attempt to
 *  ANSWER `spec`'s challenge, as opposed to a fragment/filler/off-topic reply carrying no
 *  signal at all? A caller line AssemblyAI's endpointing splits into two `transcript.user`
 *  turns (PROVEN live, bundle
 *  scripts/rehearse/reports/2026-09-15T08-56-33-miller-silent-after-amount.diagnostics.json:
 *  "And make it $2.1 million." / "final figure moved this morning.") must not burn the
 *  pending challenge on the first, content-free fragment -- `gradeChallenges` leaves the
 *  challenge AWAITING (result UNANSWERED, no FLAG, no tally -- see that function) rather
 *  than grading it AMBIGUOUS the instant ANY caller utterance lands in the eligible window.
 *
 *  Reuses the SAME content signals the real graders (`gradeTrapFact`/`gradeLiveCommitment`
 *  below) key off -- the true claim's value, the trap value, a negate-lexicon hit near the
 *  trap value, a pure negation, a whole-word affirm hit, or (for LIVE_COMMITMENT) the
 *  already-committed value -- rather than a second, independent guess at what an answer
 *  "looks like"; this is what correctly recognizes a real (if untidy) answer like "I know
 *  it's Whitmore & Bass" as answer-shaped even though it doesn't fit a bare capitalized-name
 *  pattern. A bare confirmation/refusal-adjacent filler ("sure", "yeah", "hmm", "alright,
 *  that's fine" -- none of which carry any of the above signals) is NOT answer-shaped and
 *  leaves the challenge awaiting. `SEED_FACT`/`RELATIONAL` (`accept_tokens`-graded) never
 *  reach this function -- `gradeChallenges` checks `isTokenBased` first and bypasses this
 *  gate for them entirely (token matching already tolerates an unrelated reply by just
 *  failing to match every token). */
export function isAnswerShapedFor(spec: ChallengeSpec, rawText: string, seed: SeedConfig, claims: Claim[]): boolean {
  if (rawText.trim().length === 0) return false;
  if (REFUSAL_RE.test(rawText.toLowerCase())) return true;

  const normText = normalizeText(rawText);
  const expect = spec.expect;

  if ('trap_value' in expect) {
    const trueClaim = claims.find((c) => c.id === expect.true_claim_id);
    const trueVal = trueClaim ? normalizeText(String(trueClaim.value)) : '';
    if (trueVal.length > 0 && normText.includes(trueVal)) return true;
    const trapValueNorm = normalizeText(expect.trap_value);
    if (trapValueNorm.length > 0 && normText.includes(trapValueNorm)) return true;
    if (negateNearTrapValue(normText, trapValueNorm, seed)) return true;
    if (isPureNegation(normText, seed)) return true;
    if (hasLexiconHit(rawText, seed.affirm_lexicon)) return true;
    // Every TRAP_FACT field is a name field (TRAP_FIELD_ORDER), but fall back to the
    // generic field-signal check too in case that invariant is ever loosened.
    return isNameField(spec.field) ? hasNameSignal(spec.field, rawText, seed) : hasFieldSignal(spec.field, rawText);
  }

  if ('commitment_claim_id' in expect) {
    if (isNameField(spec.field)) {
      const claim = claims.find((c) => c.id === expect.commitment_claim_id);
      const committedNorm = claim ? normalizeText(String(claim.value)) : '';
      if (committedNorm.length > 0 && normText.includes(committedNorm)) return true;
      return hasNameSignal(spec.field, rawText, seed);
    }
    return hasFieldSignal(spec.field, rawText);
  }

  // accept_tokens (SEED_FACT/RELATIONAL): never actually reached -- gradeChallenges checks
  // isTokenBased before calling this -- kept only so the union is exhaustively handled.
  return normText.length > 0;
}

/** Caller utterances strictly after `issuedAction.t_ms` and strictly before the next
 *  agent action (challenge_issued for a DIFFERENT challenge, or any readback_issued) after
 *  it, capped at `maxReasks` (`seed.thresholds.max_challenge_reasks`).
 *
 *  FIX (2026-09-15, fragment-shaped challenges): a `challenge_issued` action sharing
 *  `issuedAction`'s OWN `challenge_id` is a re-ask of the SAME still-awaiting challenge
 *  (`recordGoalCompletionAction`, call/session.ts, logs a fresh action every time a re-ask
 *  is actually spoken, same `challenge_id` unchanged) -- it must not close this window early,
 *  or a caller's later fragments (arriving after the re-ask was spoken) would fall outside
 *  it and never get graded at all. Only a challenge_issued action for a genuinely DIFFERENT
 *  challenge, or any readback_issued action, still bounds the window.
 *
 *  FIX (finding 2, Sonnet review, 2026-09-15/16): `maxReasks` now bounds the slice instead
 *  of a hardcoded `2` -- previously the cap `gradeChallenges` compared `eligible.length`
 *  against was the seeded `max_challenge_reasks`, but the window this function collected
 *  was always capped at literal 2 regardless of what the seed said, so a seed configured
 *  with a different `max_challenge_reasks` had no actual effect on either the window size
 *  or the grading cap it feeds. */
function eligibleUtterances(
  conversation: Utterance[],
  actions: AgentAction[],
  issuedAction: AgentAction,
  maxReasks: number,
): Utterance[] {
  const nextAgentActionT = actions
    .filter(
      (a) =>
        a.t_ms > issuedAction.t_ms &&
        ((a.kind === 'challenge_issued' && a.challenge_id !== issuedAction.challenge_id) || a.kind === 'readback_issued'),
    )
    .reduce<number | undefined>((min, a) => (min === undefined || a.t_ms < min ? a.t_ms : min), undefined);
  return conversation
    .filter(
      (u) =>
        u.speaker === 'caller' &&
        u.t_ms > issuedAction.t_ms &&
        (nextAgentActionT === undefined || u.t_ms < nextAgentActionT),
    )
    .sort((a, b) => a.t_ms - b.t_ms)
    .slice(0, maxReasks);
}

/** FIX (2026-09-15/16, Dana regression -- PROVEN by direct engine reproduction, no live call
 *  needed: scratchpad probes replaying scripts/rehearse/reports/2026-09-15T14-27-39-dana-
 *  patient.diagnostics.json's own transcript through the real `evaluate()` reproduce its exact
 *  ev-knowledge cards move-for-move). `gradeChallenges`'s `eligible.length === 0` branch used
 *  to grade a challenge UNANSWERED the INSTANT it was checked, with no distinction between
 *  "the caller has had zero real turns to reply yet" (issuedAction.t_ms and the latest known
 *  event are the SAME instant) and "the caller genuinely never answered" (real time/turns
 *  passed with nothing from them). `evaluate()` recomputes fresh on every tick, and the server
 *  re-ticks synchronously off the SAME `reply.done` that just logged the `challenge_issued`
 *  action (call/session.ts) -- so the very first re-check, milliseconds later and before the
 *  caller has said a word, already produced a `knowledge_check_result` card. `fsm.ts`'s
 *  `awaitingChallenge` (and `compose.ts`'s `computeChallengeAwaitingAnswer`, which already uses
 *  this exact window for the SAME "still awaiting" question, and whose own 15s grace was
 *  therefore also silently dead code -- always finding `graded: true` a tick after issuance)
 *  both read a card's mere existence as "no longer awaiting", so the engine raced ahead and
 *  issued a genuinely NEW, DIFFERENT challenge (a fresh challenge_id) before the caller's real
 *  reply could ever land in the original challenge's eligible window. On the live bundle this
 *  cost a TRAP_FACT challenge ("Northgate Partners") its own answer: the caller's correct,
 *  on-topic rejection ("No." / "That's wrong, it's Meridian Supply.") arrived AFTER the engine
 *  had already moved on to a RELATIONAL challenge (asking for account digits) and graded the
 *  caller's real reply FAIL against the WRONG question's `accept_tokens` --
 *  `at_least_one_challenge_passed` and `challenge_requirement_met` both ended up false, and an
 *  honest, fully-confirmed call ESCALATEd instead of STAGEd.
 *
 *  Fix: give a genuinely-just-issued challenge the SAME `challenge_answer_window_ms` grace
 *  `computeChallengeAwaitingAnswer` (compose.ts) already grants for the identical "is this
 *  still awaiting" question, BEFORE conceding UNANSWERED for lack of any reply at all. Purely
 *  a function of the recorded `conversation`/`actions` timestamps already passed in (no clock
 *  read, no new parameter, no signature change) -- LAW 3/BRIEF §14 unaffected: still a pure
 *  (conversation, actions, seed) -> result computation. Once genuine time (measured by the
 *  latest conversation/action timestamp anywhere in the logs) has actually moved past the
 *  window with still nothing from the caller, OR a later, genuinely different bounding action
 *  (another challenge_issued for a DIFFERENT id, or any readback_issued) already exists, this
 *  returns 'CLOSED' -- the bounding-action check keeps this in exact agreement with
 *  `eligibleUtterances` below for a scenario where the conversation has structurally moved on
 *  well within the window, and is never circular in practice: such a later action can only be
 *  logged by the server once ITS OWN challenge was legitimately selected, which (post-fix)
 *  only happens after the prior one is no longer OPEN by this same function's own rule. A call
 *  that later replies, re-asks, or ends normally always accumulates SOME later timestamp, so
 *  this converges the same way `computeChallengeAwaitingAnswer` already does for the rules
 *  layer -- never a new deadlock. */
function challengeReplyWindowStatus(
  conversation: Utterance[],
  actions: AgentAction[],
  issuedAction: AgentAction,
  windowMs: number,
): 'OPEN' | 'CLOSED' {
  const bounded = actions.some(
    (a) =>
      a.t_ms > issuedAction.t_ms &&
      ((a.kind === 'challenge_issued' && a.challenge_id !== issuedAction.challenge_id) || a.kind === 'readback_issued'),
  );
  if (bounded) return 'CLOSED';
  let lastEventT = issuedAction.t_ms;
  for (const u of conversation) if (u.t_ms > lastEventT) lastEventT = u.t_ms;
  for (const a of actions) if (a.t_ms > lastEventT) lastEventT = a.t_ms;
  return lastEventT - issuedAction.t_ms < windowMs ? 'OPEN' : 'CLOSED';
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
    const pattern = new RegExp(`\\b${escapeRegExp(phrase).replace(/\s+/g, '\\s+')}\\b`, 'g');
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
 *  four arguments named in the task brief's interface sketch.
 *
 *  FIX (2026-09-15, fragment-shaped challenges): the returned record is NOT guaranteed to
 *  have an entry for every `challenge_id` in `issued` -- a challenge whose eligible reply so
 *  far is still non-answer-shaped and under `seed.thresholds.max_challenge_reasks` is left
 *  out entirely (still AWAITING, not yet graded). See `isAnswerShapedFor`'s doc comment for
 *  why, and `selectChallenge`'s for how the absence is read on the other end. */
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

    const eligible = eligibleUtterances(conversation, actions, issuedAction, seed.thresholds.max_challenge_reasks);
    if (eligible.length === 0) {
      // FIX (2026-09-15/16, Dana regression): give the caller the full answer window (see
      // `challengeReplyWindowStatus`'s own doc comment) before conceding nobody ever replied --
      // still AWAITING (no entry at all, same shape as the non-answer-shaped branch below)
      // while genuinely nothing has had time to arrive yet.
      if (challengeReplyWindowStatus(conversation, actions, issuedAction, seed.thresholds.challenge_answer_window_ms) === 'OPEN') {
        continue;
      }
      out[spec.challenge_id] = { result: 'UNANSWERED', eligible_utterance_ids: [] };
      continue;
    }

    const eligibleIds = eligible.map((u) => u.id);
    const rawText = eligible.map((u) => u.text).join(' ');
    const rawLower = rawText.toLowerCase();
    const normText = normalizeText(rawText);
    const quote: Quote = { utterance_id: eligible[0]!.id, text: eligible[0]!.text };

    // FIX (2026-09-15, fragment-shaped challenges): the eligible reply is graded only once
    // it is answer-shaped for this challenge's field (TRAP_FACT/LIVE_COMMITMENT only --
    // SEED_FACT/RELATIONAL's accept_tokens matching already tolerates an unrelated reply by
    // simply failing to match). AssemblyAI's endpointing can split a single scripted caller
    // line into multiple `transcript.user` turns (PROVEN live, bundle
    // scripts/rehearse/reports/2026-09-15T08-56-33-miller-silent-after-amount.diagnostics.json:
    // "And make it $2.1 million." then "final figure moved this morning." -- neither
    // fragment alone, nor joined, is answer-shaped for the pending counsel-of-record
    // challenge). Each caller utterance in the eligible window that still leaves the JOINED
    // text non-answer-shaped counts one re-ask (`eligible.length`, already capped at 2 by
    // `eligibleUtterances`, matching the seeded default `max_challenge_reasks`). Under the
    // cap: AWAITING -- this challenge_id is deliberately left OUT of `out` entirely (no
    // entry at all, not even 'UNANSWERED') so `buildKnowledgeEvidence` (compose.ts) builds
    // no card and nothing is added to the tally; `selectChallenge` reads that same absence
    // to re-ask the identical spec rather than moving to a new question (see its own doc
    // comment). At the cap: exhausted -- graded 'UNANSWERED' exactly like a challenge nobody
    // ever replied to at all (FLAG 0.5 in buildKnowledgeEvidence, same as RT-10's existing
    // call-end grading), and `selectChallenge` is then free to move on.
    const expect = spec.expect;
    const isTokenBased = 'accept_tokens' in expect;
    if (!isTokenBased && !isAnswerShapedFor(spec, rawText, seed, claims)) {
      if (eligible.length < seed.thresholds.max_challenge_reasks) {
        continue; // still awaiting: no entry written for this challenge_id
      }
      out[spec.challenge_id] = { result: 'UNANSWERED', quote, eligible_utterance_ids: eligibleIds };
      continue;
    }

    if (REFUSAL_RE.test(rawLower)) {
      out[spec.challenge_id] = { result: 'REFUSED', quote, eligible_utterance_ids: eligibleIds };
      continue;
    }

    let result: ChallengeResult;
    if ('accept_tokens' in expect) {
      const words = normText.split(' ');
      // FIX (finding 1, Sonnet review, 2026-09-15/16): a purely-numeric accept_token (an
      // account/cost-centre/invoice digit string, e.g. "4471") also matches when it appears
      // as a token in the SAME reply's digit-normalized form -- so "forty-four seventy-one"
      // or "double four seven one" pass a RELATIONAL/SEED_FACT digit challenge exactly like
      // the literal digits "4471" already do. Computed lazily (only when at least one token
      // is purely numeric) since it re-tokenizes rawText. Never applied to a non-numeric
      // token (a name/place accept_token like "marcus" must still appear as itself -- this
      // never lets prose "stand in" for a name).
      //
      // CRITICAL FIX (2026-09-16, name-tokens lane, Sonnet review of 6a81b98):
      // `normalizeSpokenDigits` must run PER ELIGIBLE UTTERANCE, never over the already-
      // joined `rawText` -- two separate caller utterances ("eighty-eight" then, in a later
      // turn, "thirty") join into the exact same string a single utterance saying "eighty-
      // eight thirty" would produce, and normalizing that joined string can't tell them
      // apart, so a digit run must never be allowed to form across an utterance boundary.
      // Mapping the function over each utterance's own text first (so each call only ever
      // sees that utterance's own characters) and joining the CONVERTED results is what
      // makes that structurally impossible, independent of normalizeSpokenDigits' own
      // punctuation-gap fix.
      const hasDigitToken = expect.accept_tokens.some((tok) => /^\d+$/.test(tok));
      const digitWords = hasDigitToken
        ? normalizeText(eligible.map((u) => normalizeSpokenDigits(u.text)).join(' ')).split(' ')
        : [];
      const allPresent = expect.accept_tokens.every(
        (tok) => words.includes(normalizeText(tok)) || (/^\d+$/.test(tok) && digitWords.includes(tok)),
      );
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
