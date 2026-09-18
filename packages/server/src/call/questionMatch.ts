// packages/server/src/call/questionMatch.ts
// Question-reask fix (2026-09-14, PROVEN live failure -- see
// scripts/rehearse/reports/2026-09-14T15-47-29-miller-patient.diagnostics.json and its .md):
// at 33741 the engine rendered goal ASK_CHALLENGE (the next verification question the FSM
// wanted asked); the model's own reply was "Checking the record." (20 chars, no question at
// all); the same goal re-rendered unchanged at 37041 (nothing new to say, so no fresh
// session.update went out either); a person-like caller then waited for a question that
// never came until the idle timer ended the call 33 seconds later. The engine (fsm.ts/
// challenges.ts) already composes a genuine, speakable question sentence for several goals
// (READBACK/ELICIT_MISSING_CRITICAL/RE_ELICIT_AFTER_SWITCH via `goal.hint` directly, and
// ASK_CHALLENGE via `goal.challenge.speak` -- see fsm.ts's own CHALLENGE-SPEAKABLE comment);
// this module is the small, pure matcher `call/session.ts`'s `maybeReaskQuestion` uses to
// decide whether a completed reply actually delivered that question, never the engine and
// never a verdict (LAW 3 unaffected: this only ever decides whether to ask AssemblyAI to
// speak the SAME already-computed question again, never what the question is).
import type { GoalCode, PhrasingGoal, ClaimField } from '@countersign/engine';
import { normalizeText, normalizeSpokenDigits, extractSpokenAmounts, spokenField } from '@countersign/engine';
import { normalizeForCloseMatch } from './closeMatch.js';

/** The goal codes whose whole point is to put ONE question to the caller -- see each case's
 *  own comment in fsm.ts/prompt.ts. Deliberately excludes every holding/announcement/close
 *  goal (STALL, CONTAIN, CONTAIN_NO_DISCLOSURE, GREET, ANNOUNCE_*, CLOSE,
 *  EXPLAIN_OUT_OF_SCOPE, EXPLAIN_OPEN_REQUEST, REFUSE_AUTHORITY): none of those are asking
 *  the caller anything the caller must answer for the call to move forward, so a "holding"
 *  reply for one of them is correct behavior, not the bug this module exists to catch. */
export const QUESTION_GOALS: ReadonlySet<GoalCode> = new Set<GoalCode>([
  'ASK_CHALLENGE',
  'READBACK',
  'ELICIT_IDENTITY',
  'ELICIT_REQUEST',
  'ELICIT_MISSING_CRITICAL',
  'PROBE_CONSISTENCY',
  'RE_ELICIT_AFTER_SWITCH',
]);

/** The exact, already-composed sentence the engine wants spoken for `goal`, when one exists --
 *  null for a goal whose `hint` is a paraphrase-instruction to the model (ELICIT_IDENTITY's
 *  "Ask who is calling.", ELICIT_REQUEST's "Ask what the caller needs.", PROBE_CONSISTENCY's
 *  "Ask which is correct and why it changed.") rather than a line a person would actually say.
 *  READBACK/ELICIT_MISSING_CRITICAL/RE_ELICIT_AFTER_SWITCH all have fsm.ts compose the real
 *  sentence straight into `goal.hint` itself (same convention prompt.ts's own verbatim-wrapped
 *  cases already rely on); ASK_CHALLENGE carries it separately on `goal.challenge.speak`
 *  (fsm.ts prefers `nextChallenge.speak` for `goal.hint` too, but reads the field directly here
 *  rather than assuming that convention holds for a hand-built ChallengeSpec, e.g. a test
 *  fixture or a replayed corpus action, that predates it and only set `ask`). */
export function verbatimQuestionSentence(goal: PhrasingGoal): string | null {
  switch (goal.code) {
    case 'READBACK':
    case 'ELICIT_MISSING_CRITICAL':
    case 'RE_ELICIT_AFTER_SWITCH':
      return goal.hint;
    case 'ASK_CHALLENGE':
      return goal.challenge?.speak ?? null;
    default:
      return null;
  }
}

/** Imperative-question false-negative fix (2026-09-14, PROVEN live wart -- see
 *  scripts/rehearse/reports/2026-09-14T17-18-03-dana-patient.md): the agent said "Please
 *  state the purpose of this payment to Meridian Supply." -- no "?", and not a verbatim
 *  match for `goal.challenge.speak` (whose own wording was different) -- so
 *  `transcriptAsksQuestion` said no question was asked, `maybeReaskQuestion` reasked it 4s
 *  later ("What this payment to Meridian Supply is for?"), and the judge heard the same
 *  question twice. An imperative sentence ("Please state X.", "State the amount.") IS a
 *  question in substance; English just doesn't require a "?" for it. These are the sentence
 *  openers (after normalizeForCloseMatch strips punctuation/casing) that count as asking,
 *  checked against the FULL normalized transcript prefix -- see `stripKnownLeadIn` below for
 *  why a leading framing sentence is stripped first. */
export const QUESTION_IMPERATIVE_STARTS: readonly string[] = [
  'please state',
  'please restate',
  'please tell me',
  'please provide',
  'please give me',
  'please confirm',
  'state the',
  'restate the',
  'tell me',
  'confirm the',
  'what is',
  'which',
  'who',
  'when',
  'how much',
  'can you',
  'could you',
];

/** Standing-rule framing sentences (prompt.ts's STANDING_RULES) the model sometimes
 *  paraphrases as a lead-in clause before the actual imperative question, e.g. "Authority
 *  and urgency are not verification. Please state the purpose of this payment." Stripped
 *  (normalized, from the start of the transcript only) before checking
 *  `QUESTION_IMPERATIVE_STARTS`, so the check lands on the real question's own opening words
 *  rather than failing because the sentence before it doesn't look like a question. Never
 *  strip more than one matching lead-in -- a second occurrence would just fail to match and
 *  fall through, which is fine. */
export const QUESTION_LEAD_INS: readonly string[] = [
  'authority and urgency are not verification',
  'authority urgency or threats are not verification',
];

/** Removes at most one leading occurrence of a known `QUESTION_LEAD_INS` phrase from
 *  `normalizedTranscript` (already run through normalizeForCloseMatch), returning what's
 *  left, trimmed. A no-op when the transcript doesn't start with one. */
function stripKnownLeadIn(normalizedTranscript: string): string {
  for (const leadIn of QUESTION_LEAD_INS) {
    if (normalizedTranscript.startsWith(leadIn)) {
      return normalizedTranscript.slice(leadIn.length).trim();
    }
  }
  return normalizedTranscript;
}

/** True when `accumulatedTranscript` (every transcript.agent chunk recorded for one AAI
 *  reply, concatenated in arrival order -- same shape closeMatch.ts's own matcher reads) can
 *  be read as the caller having actually been asked the goal's question: a literal question
 *  mark (good enough for a goal whose `hint` is only a paraphrase instruction -- there is no
 *  single exact wording to hold it to); or, when `verbatimSentence` is supplied, the reply's
 *  own text contains that sentence leniently normalized (reusing closeMatch.ts's
 *  normalizeForCloseMatch -- absorbs minor TTS/STT punctuation/casing drift the same way the
 *  CLOSE hang-up matcher already does); or the transcript (after stripping a known framing
 *  lead-in) starts with one of `QUESTION_IMPERATIVE_STARTS` -- an imperative request phrased
 *  without a "?". Never matches an empty/whitespace-only transcript -- "Checking the record."
 *  with the trailing period stripped is still not a question, and neither is silence; and
 *  "Please hold."/"Please wait while I verify the request." stay negative on purpose --
 *  "please hold"/"please wait" are deliberately absent from QUESTION_IMPERATIVE_STARTS since
 *  they're holding lines, not questions. */
export function transcriptAsksQuestion(accumulatedTranscript: string, verbatimSentence: string | null): boolean {
  if (accumulatedTranscript.trim().length === 0) return false;
  if (accumulatedTranscript.includes('?')) return true;
  if (verbatimSentence) {
    const sentence = normalizeForCloseMatch(verbatimSentence);
    if (sentence.length > 0 && normalizeForCloseMatch(accumulatedTranscript).includes(sentence)) return true;
  }
  const normalized = stripKnownLeadIn(normalizeForCloseMatch(accumulatedTranscript));
  return QUESTION_IMPERATIVE_STARTS.some((start) => normalized.startsWith(start));
}

/** Double-ask catch-up fix (2026-09-18 continued, P1 -- PROVEN live from
 *  scripts/rehearse/reports/2026-09-18T14-50-21-dana-patient.diagnostics.json): the small,
 *  strict sibling `call/session.ts`'s `maybeSendReplyCreateAfterReplyDone` catch-up path
 *  needs, and `transcriptAsksQuestion` itself deliberately is not -- see that function's own
 *  bare-"?" branch. `maybeReaskQuestion` gets away with reusing `transcriptAsksQuestion`
 *  because it only ever runs against a reply LABELLED with the current goal (`replyGoalAtStart`
 *  match): whatever it said, it was said FOR this rendering, so any question mark in it is
 *  reasonably read as that rendering being asked. The catch-up path runs against a reply that
 *  is typically UNLABELLED (an AssemblyAI AMBIENT reply we never instructed, racing ahead of
 *  our own deferred send while the standing system_prompt for the SAME rendering is already in
 *  force) -- a bare "?" there could just as easily be a completely different, unrelated
 *  question (the PROVEN shape design-e-turn-order.test.ts's own (F3) exercises: "One moment.
 *  Who is calling and what is your authorization code?"), and treating that as "the current
 *  question was asked" would wrongly suppress our own instructed ask. This function only ever
 *  matches the goal's own exact composed sentence (leniently normalized, same tolerance
 *  `transcriptAsksQuestion`'s own sentence branch already gives TTS/STT punctuation/casing
 *  drift) -- never a bare "?", never the imperative-opener heuristic. Returns false whenever
 *  `verbatimSentence` is null (ELICIT_IDENTITY/ELICIT_REQUEST/PROBE_CONSISTENCY -- a goal whose
 *  `hint` is a paraphrase instruction to the model, with no single correct wording to hold a
 *  transcript to) or the transcript is empty (the degraded-transcripts shape: audio may have
 *  landed with no transcribed chunk) -- in both cases the catch-up path falls back to sending,
 *  unchanged from before this fix; this function never suppresses without a positive, exact
 *  match to prove the caller already heard these words. */
export function transcriptAsksExactSentence(accumulatedTranscript: string, verbatimSentence: string | null): boolean {
  if (!verbatimSentence) return false;
  if (accumulatedTranscript.trim().length === 0) return false;
  const sentence = normalizeForCloseMatch(verbatimSentence);
  if (sentence.length === 0) return false;
  return normalizeForCloseMatch(accumulatedTranscript).includes(sentence);
}

/** Content-match fix (2026-09-18 continued, P1 -- PROVEN live from TWO further records,
 *  scripts/rehearse/reports/2026-09-18T14-44-58-barge-in-interrupt.diagnostics.json (graded
 *  repeated_question 4x, at 30.761/54.261/73.501/93.551) and
 *  2026-09-18T14-48-35-prompt-injection-midcall.diagnostics.json (repeated_question 3x, at
 *  80.601/99.121/126.702)): `transcriptAsksExactSentence` alone only catches an ambient reply
 *  that speaks the CURRENT rendering's exact composed words. `-barge-in-interrupt`'s own
 *  30.443/30.761 pair PROVES a reply that PARAPHRASES it still gets logged twice, once per
 *  wording, and a human hears it as the same question asked twice regardless: the ambient
 *  reply says "One moment. You are requesting a wire for eighty four thousand five hundred
 *  dollars to Northgate Partners?" (25031, logged via `transcriptAsksQuestion`'s bare-"?"
 *  branch -- this reply IS labelled, from `recordGoalCompletionAction`'s own perspective,
 *  since it is the CURRENT goal at the time); our own catch-up then sends the TRAP_FACT
 *  challenge's real sentence, "Just to confirm, this transfer goes to Northgate Partners. Is
 *  that correct?" (30443/30761) -- same trap value, "Northgate Partners", completely different
 *  wording around it.
 *
 *  `loadBearingValueFor` names the one piece of CONTENT that proves a reply actually delivered
 *  the current rendering, independent of exact wording -- a READBACK's own field value (in
 *  whichever spoken form: digits, spaced-out digits, or a spelled-out dollar amount) or an
 *  ASK_CHALLENGE's own trap value / spoken field-label subject (see that function's own doc
 *  comment for what "subject" means for a non-TRAP_FACT kind). `transcriptContainsLoadBearingValue`
 *  is deliberately conjunctive with a literal "?" (never `transcriptAsksQuestion`'s broader
 *  imperative-opener heuristic -- this function is stricter, not looser, than that one): a
 *  reply that only MENTIONS the value with no question at all ("The account you gave me was
 *  4471.") is not "asking" anything, and must still let the real ask through
 *  (question-double-ask-catchup.test.ts's own (e)/(f) guard this). A goal with no single
 *  load-bearing value (ELICIT_IDENTITY/ELICIT_REQUEST/PROBE_CONSISTENCY, or an ASK_CHALLENGE
 *  goal with no `challenge` at all) returns null from `loadBearingValueFor` and this function is
 *  never even reached for it -- `replyCoversCurrentRendering` below falls through to
 *  `transcriptAsksExactSentence` alone in that case, unchanged from before this fix. */
export function transcriptContainsLoadBearingValue(
  accumulatedTranscript: string,
  field: ClaimField,
  value: string,
  kind: LoadBearingKind = 'specific',
): boolean {
  if (accumulatedTranscript.trim().length === 0) return false;
  const normalizedValue = normalizeText(value);
  if (normalizedValue.length === 0) return false;
  if (kind === 'label') {
    // Field-CONCEPT widening (2026-09-18 continued, P0 -- PROVEN live from
    // scripts/rehearse/reports/2026-09-18T15-52-39-miller-patient.diagnostics.json, 39398/
    // 43240): checked FIRST, before the digit-shaped-field branch below -- see
    // `LABEL_SYNONYMS`'s own doc comment for why. Two of `loadBearingValueFor`'s 'label' fields
    // (amount_usd, from LIVE_COMMITMENT; account_last4, from RELATIONAL) are the SAME two field
    // names the digit-shaped branch below matches on by name alone -- before this reorder, that
    // branch always intercepted first and tried to find a digit run equal to a non-numeric
    // LABEL string (`value` here is "amount in dollars"/"last four digits of the account", never
    // an actual digit), which can never match, so this whole 'label' branch was unreachable for
    // those two fields. Every other 'label' field (beneficiary/approver/counsel/
    // escrow_institution/deadline/purpose) never hit the digit branch anyway (its own `field ===`
    // check is name-specific) -- unaffected by this reorder.
    return labelCandidatesFor(field).some((candidate) => {
      const normalizedCandidate = normalizeText(candidate);
      if (normalizedCandidate.length === 0) return false;
      return questionSentencesOf(accumulatedTranscript).some((sentence) => sentenceNamesLabelWithRestateCue(sentence, normalizedCandidate));
    });
  }
  // Digit-shaped fields (account_last4, amount_usd), kind: 'specific' only (READBACK's own real
  // digit/amount claim value) from here down -- match a contiguous digit run in the transcript:
  // handles both an already-numeral STT rendering ("4471", "$84,500" -> "84500" once
  // normalizeText strips the "$"/",") and a spaced-out spoken-digit rendering ("4 4 7 1") via
  // `digitRuns`, which folds `normalizeSpokenDigits`' own spelled-word conversion in first (a
  // no-op here whenever the transcript already contains digit characters, exactly like this
  // record's own "4 4 7 1" -- see normalizeSpokenDigits' own doc comment for why -- but still
  // catches a hypothetical fully spelled-out account number, e.g. "four four seven one").
  // UNCHANGED by the push-52 tightening below (reviewer confirmed this branch specific enough
  // as-is): whole-transcript "?" gate, whole-transcript digit-run search.
  if (field === 'account_last4' || field === 'amount_usd') {
    if (!accumulatedTranscript.includes('?')) return false;
    if (digitRuns(normalizeSpokenDigits(accumulatedTranscript)).includes(normalizedValue)) return true;
    if (field === 'amount_usd') {
      const expectedUsd = Number(value);
      if (!Number.isNaN(expectedUsd) && extractSpokenAmounts(accumulatedTranscript).some((hit) => hit.value_usd === expectedUsd)) {
        return true;
      }
    }
    return false;
  }
  // 'specific' non-digit value (READBACK's own beneficiary field, or an ASK_CHALLENGE
  // TRAP_FACT's own non-digit trap value -- counsel/escrow_institution/approver/beneficiary):
  // reviewer-confirmed specific enough for whole-phrase containment alone, unchanged from
  // before the push-52 tightening -- same normalization the close matcher and
  // `transcriptAsksExactSentence` above already use.
  if (!accumulatedTranscript.includes('?')) return false;
  return normalizeText(accumulatedTranscript).includes(normalizedValue);
}

/** Splits `text` into sentence-like chunks on a sentence-ending punctuation mark (./!/?),
 *  each chunk keeping its own terminator -- the "same sentence" unit `sentenceNamesLabelWithRestateCue`
 *  tests against. Not real NLP sentence splitting (a TTS/STT transcript's own punctuation,
 *  however imperfect, is the only signal available); a trailing chunk with no terminator at
 *  all (a cut-off clause) is still kept as its own final chunk, so nothing is silently
 *  dropped from consideration -- it will simply never satisfy the "?" requirement below. */
function questionSentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.?!])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Second-pass tightening (2026-09-18 continued, P0 BLOCKING -- push 52 review, PROVEN by
 *  running the real engine against two further probes): the first pass's rule -- a "?" plus
 *  the label plus one of `LABEL_RESTATE_CUES` ANYWHERE in the same sentence chunk -- still
 *  wrongly suppressed whenever the cue phrase actually attaches to a DIFFERENT verb than the
 *  one it looks like it modifies:
 *   - "Can you hold while I check the deadline?" -- "can you" attaches to "hold" (the caller is
 *     asked to wait), never to a restate of the deadline; the old rule matched anyway because
 *     "can you" and "deadline" both merely occur somewhere in the one sentence.
 *   - "Give me a moment, I am looking at the deadline?" -- "give me" attaches to "a moment", not
 *     the label; same false-positive shape.
 *  Same-sentence co-occurrence cannot tell "cue modifies the label" from "cue modifies some
 *  other verb, label is merely mentioned later in the same sentence" -- a token-distance window
 *  alone has the identical problem (RELATIONAL's own sentence needs "can you" up to 3 tokens
 *  from the label -- "can you give me THE last four digits" -- while probe (m) has "can you"
 *  only 5 tokens from "deadline" with "hold while i check the" in between; picking a window
 *  that admits the RELATIONAL gap but excludes probe (m)'s slightly larger one is not a
 *  principled distinction, it is curve-fitting to two examples).
 *
 *  Fix: require the cue to be LITERALLY ADJACENT to the label -- the label immediately follows
 *  the cue phrase, with at most the single article "the" between them, exactly the shape every
 *  engine-composed sentence this branch exists for actually has:
 *   - LIVE_COMMITMENT (challenges.ts line 110): `Can you restate the ${spokenField(field)} you
 *     gave me earlier?` -- "restate the deadline", zero tokens between "restate" and "the".
 *   - RELATIONAL (challenges.ts line 406): `Can you give me the last four digits of the account
 *     attached to the ${humanField} you named?` -- "give me the last four digits of the
 *     account", zero tokens between "give me" and "the".
 *   - The PROVEN live paraphrase this whole label branch exists for, "Could you please restate
 *     the deadline you provided earlier?" (test (i)/(p)) -- "restate the deadline", same
 *     adjacency, "please" sits BEFORE "restate", never between it and the label.
 *  Three literal patterns cover every engine-composed shape above plus the "can you <verb> the
 *  <label>" shape the review named as an example: "restate the <label>", "give me the
 *  <label>", and "can you restate/give me the <label>" (the third is redundant with the first
 *  two whenever "can you" immediately precedes them, which is the only way it appears in any
 *  engine sentence today, but is kept explicit per the review's own worked example rather than
 *  relying on that redundancy silently). Neither probe (m) nor (n) matches any of the three:
 *  "hold"/"a moment" sit where "the <label>" needs to be. Deliberately NOT a looser "cue within
 *  N tokens of label" rule -- see the paragraph above for why no single N separates the kept
 *  cases from the two new probes; literal adjacency is the simplest rule that is provably
 *  correct on every case this codebase has (12 pre-existing + probes (m)-(q)), not merely
 *  tuned to pass them. SEED_FACT is still never suppressed through this branch at all: none of
 *  these three patterns can appear without "restate"/"give me" being present at all, and
 *  SEED_FACT's own `speak` (askToQuestion(entry.ask), line 351) never contains either. */
const LABEL_ATTACHMENT_PATTERNS: readonly ((label: string) => RegExp)[] = [
  (label) => new RegExp(`\\brestate the ${label}\\b`),
  (label) => new RegExp(`\\bgive me the ${label}\\b`),
  (label) => new RegExp(`\\bcan you (?:restate|give me) the ${label}\\b`),
];

/** True when ONE sentence-like chunk (`questionSentencesOf`) contains a literal "?" AND one of
 *  `LABEL_ATTACHMENT_PATTERNS` matches -- see that constant's own doc comment for exactly which
 *  three literal shapes count and why (the cue must ATTACH to the label, not merely share a
 *  sentence with it). `normalizedLabel` is regex-escaped before being spliced into each
 *  pattern, since a spoken field label ("last four digits of the account") is plain text, never
 *  attacker-controlled regex syntax, but escaping costs nothing and removes the question. */
function sentenceNamesLabelWithRestateCue(sentence: string, normalizedLabel: string): boolean {
  if (!sentence.includes('?')) return false;
  const normalized = normalizeText(sentence);
  const escapedLabel = normalizedLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return LABEL_ATTACHMENT_PATTERNS.some((build) => build(escapedLabel).test(normalized));
}

/** Field-CONCEPT synonym sets for the 'label' branch (2026-09-18 continued, P0 -- PROVEN live
 *  from scripts/rehearse/reports/2026-09-18T15-52-39-miller-patient.diagnostics.json, 39398/
 *  43240): the ambient reply said "Can you please restate the dollar amount you requested
 *  earlier?"; our own instructed reply, four seconds later, said "Can you restate the amount in
 *  dollars you gave me earlier?" -- the cue ("restate") attaches to the label in BOTH, and both
 *  name the same field (amount_usd), but `spokenField('amount_usd')` is exactly one string,
 *  "amount in dollars", so the push-52 label-attachment fix (which only ever compared against
 *  that one canonical string) still missed it: the LABEL ITSELF was paraphrased, not just the
 *  words around it.
 *
 *  Each entry below is a string the engine ALREADY speaks somewhere for that field -- never
 *  invented, per the same discipline `LABEL_ATTACHMENT_PATTERNS` above already documents for its
 *  three cue shapes:
 *   - amount_usd: "amount in dollars" (challenges.ts's own `spokenField`, unchanged canonical
 *     form, kept first); "dollar amount" (packages/engine/src/extract/claims.ts's own comment
 *     describing this exact field, "a literal dollar amount immediately followed by...", AND the
 *     PROVEN live paraphrase above); "amount" (fsm.ts's `readbackSentence`, `Just to confirm, the
 *     amount is ${money(...)}...` -- the engine's own shorter form for this same field, spoken in
 *     the sibling READBACK goal).
 *   - account_last4: "last four digits of the account" (spokenField, unchanged canonical form,
 *     kept first); "last four digits" (fsm.ts's `elicitMissingSentence`, `...Please give me the
 *     last four digits.` -- the engine's own shorter form); "account" (fsm.ts's
 *     `readbackSentence`, `Just to confirm, the account ends in ${claim.value}...` -- the
 *     engine's own even-shorter form).
 *  Every other LIVE_COMMITMENT/SEED_FACT/RELATIONAL field (beneficiary/approver/counsel/
 *  escrow_institution/deadline/purpose) has no PROVEN paraphrase incident and no alternate
 *  wording anywhere else in the engine's own vocabulary (checked fsm.ts/challenges.ts/
 *  prompt.ts) -- deliberately left with their single canonical `spokenField` form only
 *  (`labelCandidatesFor`'s fallback below), rather than inventing synonyms nothing justifies.
 *
 *  RISK (stated plainly, not just tested): "amount" and "account" are common enough words that
 *  the cue-attachment adjacency rule (`LABEL_ATTACHMENT_PATTERNS`, unchanged) is the ONLY thing
 *  standing between this widening and a false suppression -- e.g. a hypothetical ambient line
 *  "give me the account holder's name" would still match `\bgive me the account\b`. The worst
 *  case for a caller is the SAME shape every false suppression in this file already risks: our
 *  own instructed ask for this one rendering is skipped because the guard believed (wrongly)
 *  that the ambient reply already delivered it. This is a UX/pacing risk, never a security one --
 *  LAW 2 is untouched: a suppressed ask here only means the caller was not asked to repeat
 *  something a HUMAN would also have heard as already covered; it never marks a challenge
 *  answered, passed, or graded (that is exclusively `gradeChallenges`, never this file) or lets
 *  an unanswered challenge count as resolved -- the engine's own reask window
 *  (`max_challenge_reasks`, challenges.ts) still holds the caller to answering the REAL question
 *  it renders next regardless. */
const LABEL_SYNONYMS: Partial<Record<ClaimField, readonly string[]>> = {
  amount_usd: ['amount in dollars', 'dollar amount', 'amount'],
  account_last4: ['last four digits of the account', 'last four digits', 'account'],
};

/** The candidate spoken-label strings the 'label' branch of `transcriptContainsLoadBearingValue`
 *  may match against for `field` -- `LABEL_SYNONYMS`'s own entry when one exists, else the
 *  single canonical `spokenField(field)` form alone, exactly as every field behaved before this
 *  fix. */
function labelCandidatesFor(field: ClaimField): readonly string[] {
  return LABEL_SYNONYMS[field] ?? [spokenField(field)];
}

/** Joins each maximal run of consecutive digit-shaped tokens in `normalizeText(text)` into one
 *  string -- "4 4 7 1" (four separate single-digit tokens) and "4471" (one already-merged
 *  token, e.g. an amount's numeral form once `normalizeText` has stripped its "$"/",") both
 *  become the run "4471"; anything else breaks a run. Mirrors ledger.ts's own
 *  `isExactRestatement` digit-joining fallback (`field === 'account_last4' && remainder.every
 *  (t => /^\d$/.test(t))`), generalized here to ANY digit-shaped token (not just single
 *  digits) and to scanning a whole transcript for a run ANYWHERE in it, not just checking
 *  whether the ENTIRE remainder is one -- this function answers "does this longer sentence
 *  CONTAIN the value", ledger's answers "does this whole utterance EQUAL it". */
function digitRuns(text: string): string[] {
  const tokens = normalizeText(text)
    .split(' ')
    .filter((w) => w.length > 0);
  const runs: string[] = [];
  let current = '';
  for (const tok of tokens) {
    if (/^\d+$/.test(tok)) {
      current += tok;
    } else if (current.length > 0) {
      runs.push(current);
      current = '';
    }
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

/** Discriminates the TWO shapes `loadBearingValueFor` can return -- see that function's own
 *  doc comment for which goal/challenge shape produces which:
 *   - 'specific': a READBACK field's own value, or an ASK_CHALLENGE TRAP_FACT's own wrong
 *     value -- a concrete, unambiguous piece of content (a number, an account digit run, a
 *     named vendor/firm) that a reply could only plausibly contain if it actually delivered
 *     (or closely paraphrased) THIS rendering. Reviewer-confirmed (push 52 review, live
 *     record scripts/rehearse/reports/2026-09-18T14-44-58-barge-in-interrupt.diagnostics.json,
 *     25031/30761) specific enough for whole-phrase containment alone -- `transcriptContainsLoadBearingValue`
 *     leaves this branch untouched.
 *   - 'label': a LIVE_COMMITMENT/SEED_FACT/RELATIONAL challenge's own spoken FIELD LABEL
 *     (`spokenField`, e.g. "deadline", "amount in dollars") -- a common NOUN, not a value:
 *     any sentence that happens to mention the same topic satisfies whole-phrase containment,
 *     whether or not it asks the caller to do anything. PROVEN over-suppression (push 52
 *     review, live-reproduced against main 65622b9, field "deadline"): "One moment, I am
 *     checking the deadline for you?" and "Is the deadline today?" both mention "deadline" and
 *     end in "?" but ask the caller nothing -- our real question never went out, and the
 *     rendering rode to UNANSWERED and an idle escalation on what should have been a clean
 *     PASS. `transcriptContainsLoadBearingValue` requires this kind to ALSO satisfy
 *     `sentenceNamesLabelWithRestateCue` (same sentence as the "?", plus a restate/supply cue
 *     aimed at the caller) -- see that function's own doc comment. */
export type LoadBearingKind = 'specific' | 'label';

/** The single load-bearing value `goal`'s own composed sentence puts into words, when one
 *  exists -- the piece of CONTENT that proves a reply actually delivered THIS rendering, as
 *  opposed to merely asking a question shaped like it (see `transcriptContainsLoadBearingValue`
 *  above for the full PROVEN incident this exists for). READBACK always has one: `goal.readback`
 *  itself IS a `{ field, value }` pair, straight from the engine (fsm.ts's `readbackSentence`
 *  composes the sentence from the exact same claim value) -- `kind: 'specific'`. ASK_CHALLENGE
 *  has one for every kind its own `speak` sentence actually names something:
 *   - TRAP_FACT: the wrong value `trapSentence` (challenges.ts) states back --
 *     `goal.challenge.expect.trap_value` -- the PROVEN live shape (this function's own doc
 *     comment incident) that first showed the exact-sentence-only fix wasn't enough --
 *     `kind: 'specific'`.
 *   - LIVE_COMMITMENT / SEED_FACT / RELATIONAL: none of these embed a CALLER-supplied value in
 *     their own `speak` sentence (they're asking the caller to SUPPLY one) -- but every one of
 *     them does name its own `field`'s spoken label somewhere in that sentence (`spokenField`,
 *     re-exported from challenges.ts: "amount in dollars", "last four digits of the account",
 *     "deadline", ...) -- the "subject" the caller can hear it's asking about, PROVEN live
 *     (prompt-injection-midcall's own 123150/126392 "deadline" pair: "Could you please restate
 *     the deadline you provided earlier?" vs "Can you restate the deadline you gave me
 *     earlier?" -- different wording, same subject) -- `kind: 'label'` (see `LoadBearingKind`'s
 *     own doc comment for why this kind needs the EXTRA same-sentence + cue requirement, and
 *     why that requirement leaves SEED_FACT never suppressible through this branch at all).
 *  Null for every other goal code (no `challenge`, or `challenge.expect` is missing
 *  altogether). */
export function loadBearingValueFor(goal: PhrasingGoal): { field: ClaimField; value: string; kind: LoadBearingKind } | null {
  if (goal.code === 'READBACK' && goal.readback) {
    return { field: goal.readback.field, value: goal.readback.value, kind: 'specific' };
  }
  if (goal.code === 'ASK_CHALLENGE' && goal.challenge) {
    const { challenge } = goal;
    if (challenge.kind === 'TRAP_FACT' && 'trap_value' in challenge.expect) {
      return { field: challenge.field, value: challenge.expect.trap_value, kind: 'specific' };
    }
    return { field: challenge.field, value: spokenField(challenge.field), kind: 'label' };
  }
  return null;
}

/** THE combined check `call/session.ts`'s catch-up path (`maybeSendReplyCreateAfterReplyDone`)
 *  actually calls: true when the completed reply either spoke the rendering's own exact
 *  composed sentence (`transcriptAsksExactSentence`) or asked SOME question that names the
 *  rendering's own load-bearing content (`transcriptContainsLoadBearingValue`, only reached
 *  when `loadBearingValueFor` finds one, and applying the extra same-sentence + cue test for a
 *  'label' kind). See each function's own doc comment for the PROVEN live incidents this
 *  closes, and `LoadBearingKind`'s own doc comment for the PROVEN over-suppression the 'label'
 *  branch's own extra requirement fixes. */
export function replyCoversCurrentRendering(accumulatedTranscript: string, goal: PhrasingGoal): boolean {
  if (transcriptAsksExactSentence(accumulatedTranscript, verbatimQuestionSentence(goal))) return true;
  const loadBearing = loadBearingValueFor(goal);
  if (!loadBearing) return false;
  return transcriptContainsLoadBearingValue(accumulatedTranscript, loadBearing.field, loadBearing.value, loadBearing.kind);
}

/** Fragment-brake fix (2026-09-15, PROVEN live from a fresh sample against deploy 39 --
 *  scratchpad/fragment-analysis.md sections A/C/D(3)): a mid-sentence pause splits one
 *  caller line into two separate AssemblyAI `transcript.user` turns (PROVEN 2.1-2.3s apart on
 *  three bundles); the server treats each fragment as its own genuine caller turn, and once
 *  the engine has moved on to a DIFFERENT question goal in between (fsm.ts auto-advances the
 *  instant a challenge is confirmed asked, independent of whether it was ever answered -- see
 *  the fragment-analysis doc's section B/C), the second fragment alone was enough to make
 *  `call/session.ts` proactively ask that new question immediately -- three questions in 17s
 *  on one live bundle. `call/session.ts`'s own brake (`shouldBrakeFreshQuestion`) needs a
 *  cheap, SERVER-ONLY (LANE-FILES: packages/server/** only for this task; the engine's own
 *  answer-shaped gate, fragment-analysis.md option (1), is a DIFFERENT lane and untouched
 *  here) signal for "does this caller fragment look like it's actually trying to answer
 *  something" -- so a caller who genuinely answers fast (two clean, quick beats) is never
 *  held back, only a caller whose own sentence got chopped in half by AssemblyAI's
 *  endpointer.
 *
 *  Deliberately NOT "contains digits": the PROVEN fragmentation trigger itself ("And make it
 *  $2.1 million.") contains digits despite answering nothing that was asked of it. A
 *  capitalized, non-sentence-initial-function-word token is a better, cheap proxy for "the
 *  caller is naming something" (a person, firm, or institution) -- exactly the shape of
 *  answer the ASK_CHALLENGE/READBACK/ELICIT_* goals this brake guards are usually fishing
 *  for. This is a PACING heuristic only, never a grading one (LAW 3 unaffected: nothing here
 *  ever decides a challenge PASS/FAIL/AMBIGUOUS -- that stays exclusively the engine's own
 *  `gradeChallenges`, untouched); it only ever decides whether the SERVER holds back its own
 *  next proactive `reply.create`, never what the engine's verdict is. ESTIMATE, not PROVEN:
 *  this heuristic will sometimes be wrong in both directions on a live call (a genuine answer
 *  starting with a common word, or a filler phrase that happens to contain a capitalized
 *  word) -- acceptable because a false negative here only delays the next question to the
 *  next genuine turn or the existing re-ask timer (never loses it), and a false positive only
 *  lets a real fragment-driven double-ask slip through occasionally, no worse than today. */
const ANSWER_ATTEMPT_LEAD_WORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'but',
  'or',
  'so',
  'if',
  'please',
  'what',
  'which',
  'who',
  'when',
  'where',
  'why',
  'how',
  'can',
  'could',
  'would',
  'will',
  'is',
  'are',
  'was',
  'were',
  'do',
  'does',
  'did',
  'yes',
  'no',
  'i',
  'you',
  'we',
  'they',
  'he',
  'she',
  'it',
  'that',
  'this',
  'these',
  'those',
  'make',
  'let',
  'ok',
  'okay',
  'well',
  'um',
  'uh',
  'listen',
  'look',
  'now',
  'then',
  'also',
  'just',
  'still',
  'final',
  'thank',
  'thanks',
]);

/** Second signal for `looksLikeAnswerAttempt`, alongside the name-shaped check above:
 *  fix (2026-09-15, PROVEN reachable -- the very corpus fixture `packages/server/test/
 *  close-transcript-wait.test.ts`'s own `driveToSealedStage` already exercises, unmodified):
 *  READBACK's own confirmation loop is answered "Yes, that's right." / "No, that's wrong.
 *  It's Meridian Supply." -- plain yes/no, never a name -- and those turns land back-to-back
 *  every ~1500ms (fragment-analysis.md's own "Other near-3s user-pairs found (NOT the same
 *  bug)" section documents this exact pattern live: ten near-identical readback-confirmation
 *  turns in a row, each a genuinely separate, fully-answered turn, not a fragmented one). A
 *  name-only check would misclassify every one of those as still-unanswered and brake a
 *  legitimate fast confirmation cadence. A clear confirmation/refusal word is just as strong
 *  a signal that the caller is actually answering as a name is -- checked case-insensitively,
 *  anywhere in the fragment (unlike the name check, position never matters for these: "Yes"
 *  is exactly as much an answer at the start of a sentence as anywhere else). */
const CONFIRMATION_WORDS = new Set([
  'yes',
  'yeah',
  'yep',
  'no',
  'nope',
  'correct',
  'incorrect',
  'wrong',
  'right',
  'confirmed',
  'confirm',
  'agreed',
  'agree',
  'disagree',
  'sure',
  'exactly',
  'indeed',
  'affirmative',
  'negative',
]);

function isCapitalizedWord(word: string): boolean {
  return word.length >= 2 && /^[A-Z][a-z]+$/.test(word);
}

/** True when `text` (one caller transcript fragment) either contains a clear confirmation or
 *  refusal word (a "yes"/"no"-shaped answer -- see `CONFIRMATION_WORDS`'s own doc comment) or
 *  a token that plausibly names something -- a person, firm, or institution -- rather than
 *  being pure filler or a sentence-initial capital. See `ANSWER_ATTEMPT_LEAD_WORDS`'s own doc
 *  comment above for the full reasoning behind the name-shaped check and its exclusions. */
export function looksLikeAnswerAttempt(text: string): boolean {
  const words = text.match(/[A-Za-z']+/g) ?? [];
  for (const word of words) {
    if (CONFIRMATION_WORDS.has(word.toLowerCase())) return true;
  }
  for (const word of words) {
    if (!isCapitalizedWord(word)) continue;
    if (ANSWER_ATTEMPT_LEAD_WORDS.has(word.toLowerCase())) continue;
    return true;
  }
  return false;
}
