// packages/engine/src/extract/claims.ts
// Extracts account-last-4, deadline, and cued-name (approver/counsel/escrow/beneficiary)
// mentions with verbatim quotes. Plain transcript parsing — no claim about voice
// authenticity. `value` is the claim as spoken; the story ledger normalizes it.

export interface AccountLast4Hit {
  value: string;
  quote: string;
}

// Cue phrases before the last-4 digits of an account number, in the forms callers and
// judges actually say them (PROVEN gap, docs/analysis/case11-freeplay-2026-09-17.md run
// 21-32-40: the caller's exact words "The account ends in 4471." never matched the old
// "ending|ending in|last four|last 4|suffix" list -- there was no "ends" branch at all).
// Each cue is followed by a MANDATORY single space then exactly 4 digits, so a bare cue
// word with no adjacent number (e.g. "the invoice ends in December") never matches, and a
// short number nearby but not immediately after the cue (e.g. "I need this in 4 minutes",
// which has no cue word at all) never matches either -- see the negative tests below.
// Branches:
//   - "ending" / "ending in" / "ending with" 4471
//   - "ends in" / "ends with" 4471
//   - "last four" / "last 4" [digits are/is] 4471 (covers "the last four digits are 4471")
//   - "suffix" [is] 4471
//   - bare "account" 4471 (no connector word -- callers often just read the digits off)
const ACCOUNT_LAST4_RE =
  /\b(?:ending(?:\s+(?:in|with))?|ends\s+(?:in|with)|last\s+(?:four|4)(?:\s+digits\s+(?:are|is))?|suffix(?:\s+is)?|account)\s+(\d{4})\b/i;

export function extractAccountLast4(text: string): AccountLast4Hit | null {
  const m = ACCOUNT_LAST4_RE.exec(text);
  if (!m) return null;
  const start = m.index;
  return { value: m[1]!, quote: text.slice(start, start + m[0].length) };
}

export interface DeadlineHit {
  value: string;
  quote: string;
}

const DEADLINE_RELATIVE_RE = /\b(?:in|within)\b\s+(?:the\s+next\s+)?(\w+)\s+(minutes?|hours?)\b/i;
// RULING (fix round 1, finding 2): "today"/"tonight"/"eod"/"end of day"/"close of business"
// match standalone, with an optional leading "by "; weekday names always require "by ".
const DEADLINE_ABSOLUTE_RE =
  /\btoday\b|\btonight\b|\b(?:by\s+)?(?:end of day|eod|close of business)\b|\bby\s+(?:friday|monday|tuesday|wednesday|thursday)\b/i;

export function extractDeadline(text: string): DeadlineHit | null {
  const relative = DEADLINE_RELATIVE_RE.exec(text);
  if (relative) {
    const start = relative.index;
    const quote = text.slice(start, start + relative[0].length);
    const value = `${relative[1]!.toLowerCase()} ${relative[2]!.toLowerCase()}`;
    return { value, quote };
  }
  const absolute = DEADLINE_ABSOLUTE_RE.exec(text);
  if (absolute) {
    const start = absolute.index;
    const quote = text.slice(start, start + absolute[0].length);
    return { value: absolute[0].toLowerCase(), quote };
  }
  return null;
}

// FIX (founder live defect, 2026-09-25, PROVEN: scripts/rehearse/reports/founder-2026-09-25/
// 140b3584-b8c7-4f09-a1c5-1c930ba44859.diagnostics.json): a caller answering a LIVE_COMMITMENT
// deadline challenge with a plain immediate-time phrase -- "Right now.", "Immediately.",
// "ASAP." -- matched neither DEADLINE_RELATIVE_RE ("in/within ... minutes/hours") nor
// DEADLINE_ABSOLUTE_RE (today/tonight/eod/weekday), so `extractDeadline` returned null.
// `hasFieldSignal`'s own 'deadline' branch (challenges.ts) then found no digit and no weekday
// name either, `isAnswerShapedFor` graded the reply NOT answer-shaped, and `gradeChallenges`
// left the challenge AWAITING forever -- the caller's real answer was silently discarded, the
// engine's own evaluate() output never changed (same verdict/state/goal/evidence), and the
// server (call/session.ts's one-brain `nextSpokenLine()`) re-rendered the byte-identical
// challenge question the next time AssemblyAI called our endpoint (49.08s ask, 54.48s "Right
// now.", 58.74s identical re-ask -- founder's own top complaint, "keeps asking the same
// questions").
//
// REVIEW FIX (2026-09-25, BLOCKING finding on the first cut of this fix): the first cut put
// this recognition INSIDE `extractDeadline` itself -- but `extractDeadline` is also called by
// `ledger.ts`'s general claim-building pass (line ~479), which runs over EVERY caller
// utterance, not just a challenge answer. An honest caller saying "right now"/"immediately"/
// "asap" in ordinary urgency speech (never as a restated challenge answer) would then create a
// brand-new STATED deadline claim that did not exist on main's HEAD; a later REAL deadline
// ("in the next 10 minutes", "today") with no correction-lexicon word nearby would read as a
// SECOND, different value for the same field -- `classifyDifferentValue`'s default ->
// CONTRADICTED -> a `consistency_flag` FAIL card (compose.ts) feeding the freeze/escalate
// tally, on a caller who never actually contradicted anything. `extractDeadline` above is now
// byte-identical to main's HEAD (immediate-time phrases removed from it entirely -- see
// packages/engine/test/ledger.test.ts's own "REVIEW FIX" tests) -- `ledger.ts` never sees this
// recognition at all. `extractDeadlineAnswer` below is a SEPARATE function, used ONLY at the
// two challenge-answer call sites (`challenges.ts`'s `hasFieldSignal`/`gradeLiveCommitment`),
// where "was this specific reply an attempt to restate the committed deadline" is exactly the
// question being asked -- never in the general ledger pass. It never decides PASS/FAIL/
// AMBIGUOUS (LAW 3): `gradeLiveCommitment`'s own literal-value comparison still grades it on
// its actual content, exactly like a normal wrong-value restatement would (here: FAIL, "right
// now" != the committed relative/absolute deadline). Deliberately does NOT match bare "now"
// alone (a common filler word elsewhere in this codebase -- see packages/server/src/call/
// questionMatch.ts's own ANSWER_ATTEMPT_LEAD_WORDS, which excludes it for the same reason) --
// only these named, unambiguous immediate-time phrases.
const DEADLINE_IMMEDIATE_RE = /\b(?:right\s+now|right\s+away|immediately|immediate|asap|as\s+soon\s+as\s+possible)\b/i;

export function extractDeadlineAnswer(text: string): DeadlineHit | null {
  const base = extractDeadline(text);
  if (base) return base;
  const immediate = DEADLINE_IMMEDIATE_RE.exec(text);
  if (immediate) {
    const start = immediate.index;
    const quote = text.slice(start, start + immediate[0].length);
    return { value: immediate[0].toLowerCase(), quote };
  }
  return null;
}

export type CuedNameField = 'approver' | 'counsel' | 'escrow_institution' | 'beneficiary';

export interface CuedNameHit {
  field: CuedNameField;
  value: string;
  quote: string;
}

// A name is 1-4 capitalized words, allowing "&", "and", "of", "the", ".", "'" to bind them
// together; the run stops at a comma, period, a lower-case word that isn't a connector, or
// after 4 words (fix round 1, finding 3: the trailing repeat is capped at {0,3}).
const NAME = "[A-Z][A-Za-z.']*(?:\\s+(?:&|and|of|the|[A-Z][A-Za-z.']*)){0,3}";

// escrow_institution cue, split into named pieces so the alternation is legible (fix round
// 1, finding 4: "is at" was added so "escrow is at X" matches, not just "escrow is X" /
// "escrow at X"; spacing is embedded per-alternative in the connector so there's no
// backtracking ambiguity between "is" and "at"). The three pieces read left to right as:
// "escrow" [+ optional "institution "/"bank "] [+ is-at/is/at/with/account-is-at] + NAME
// -- e.g. "escrow institution is at Harbor Fidelity", "escrow with Harbor Fidelity",
// "escrow account is at Harbor Fidelity".
const ESCROW_CUE_HEAD = '\\bescrow\\b\\s+';
const ESCROW_CUE_KIND = '(?:institution\\s+|bank\\s+)?';
const ESCROW_CUE_CONNECTOR = '(?:is\\s+at\\s+|is\\s+|at\\s+|with\\s+|account\\s+(?:is\\s+)?at\\s+)';

// Department/functional unit names that should not match as person names in the approver
// pattern "(NAME) approved". These are excluded to avoid capturing "Treasury approved this"
// or "Finance approved it" as if a person named "Treasury" or "Finance" approved.
const DEPARTMENT_STOPLIST = new Set([
  'accounting',
  'audit',
  'compliance',
  'corporate',
  'finance',
  'financial',
  'hr',
  'legal',
  'operations',
  'payroll',
  'procurement',
  'risk',
  'security',
  'treasury',
]);

// PROVEN false positive (founder live record 2026-09-18, scripts/rehearse/reports/
// founder-2026-09-18/95b9ad42-7798-40d0-918a-7187295f5fb0.diagnostics.json): "It's
// approved." matched the reversed approver cue "(NAME) approved" -- the NAME pattern's char
// class (`[A-Za-z.']*`) allows an apostrophe, so the sentence-initial capital of the
// contraction "It's" was captured as if it were a one-word person name, creating a real
// approver claim with junk value "its" that the engine then legitimately tried to challenge
// the caller to restate -- a value he never actually stated. Closed-class function words
// (pronouns, contractions, demonstratives, interrogatives) are never person/organisation
// names regardless of capitalization, the same principle `isDepartmentName` below already
// applies to department words. Checked as a WHOLE-NAME match (case-insensitive, apostrophe
// stripped) so it only rejects the captured name itself being one of these words -- a real
// name elsewhere in the same sentence, or a multi-word name that merely contains one of
// these as a non-final word, is unaffected.
const NON_NAME_WORD_STOPLIST = new Set([
  'it', 'its', 'that', 'thats', 'this', 'thiss', 'there', 'theres', 'here', 'heres',
  'what', 'whats', 'who', 'whos', 'which', 'they', 'theyre', 'he', 'hes', 'she', 'shes',
]);

/** True when `name` (the exact captured span, trimmed) is nothing but a single closed-class
 *  function word -- an apostrophe/contraction is stripped before the stoplist check so
 *  "It's" and "It" both match the same "it" entry. A multi-word name is never rejected by
 *  this check, even if one of its words happens to appear in the stoplist. */
function isNonNameWord(name: string): boolean {
  if (name.includes(' ')) return false;
  const bare = name.toLowerCase().replace(/[^a-z]/g, '');
  return NON_NAME_WORD_STOPLIST.has(bare);
}

// Check if a name looks like a department name rather than a person name. A department
// name is one or more words from the stoplist, optionally with "department" or "management".
function isDepartmentName(name: string): boolean {
  const lower = name.toLowerCase();
  const words = lower.split(/\s+/);
  // If any word in the name is a department word (and not "the"/"of"/"and"/"&"),
  // and the name doesn't have typical person-name indicators, treat it as a department.
  const hasDepartmentWord = words.some((w) => DEPARTMENT_STOPLIST.has(w) || w === 'department' || w === 'management');
  if (!hasDepartmentWord) return false;

  // A department name typically has no lowercase "the"/"of"/"and" connectors between
  // capitalized words, or consists mostly of department words. For simplicity, if it
  // contains any department stoplist word and more than one word total, assume it's a
  // department. Single-word matches like "Marcus" won't trigger this.
  return words.length > 1 || words.some((w) => DEPARTMENT_STOPLIST.has(w));
}

// PROVEN false-positive vectors (review, 2026-09-17, run by executing the regex) opened by
// the "verb ... to NAME" filler widening above: "send my regards to Marcus" and "transfer
// me to Elena" both matched even though the OLD (pre-widening) pattern rejected them (it
// required the verb to be followed immediately by "to NAME", no filler at all) -- so a
// generic filler needs its own guardrails, not just a length cap. A filler is rejected
// (the whole beneficiary match is dropped for that verb) if:
//   (a) its FIRST word is a bare pronoun or possessive object ("me"/"us"/"him"/"her"/
//       "them"/"my"/"our"/"your"/"his"/"their") -- "transfer me to Elena" is a request to be
//       transferred to a person, not a beneficiary claim; an ordinary object word like "it"
//       is NOT on this list, so "send it to Meridian Supply" is unaffected.
//   (b) it contains an idiom word ("regards"/"love"/"thanks"/"best"/"greetings") anywhere --
//       "send my regards to Marcus" and "give my love to Elena" are pleasantries, not wires.
const BENEFICIARY_FILLER_PRONOUN_STOPLIST = new Set(['me', 'us', 'him', 'her', 'them', 'my', 'our', 'your', 'his', 'their']);
const BENEFICIARY_FILLER_IDIOM_RE = /\b(?:regards|love|thanks|best|greetings)\b/i;

function beneficiaryFillerIsClean(filler: string): boolean {
  const trimmed = filler.trim();
  if (trimmed.length === 0) return true;
  const firstWord = trimmed.split(/\s+/)[0]!.toLowerCase().replace(/[^a-z']/g, '');
  if (BENEFICIARY_FILLER_PRONOUN_STOPLIST.has(firstWord)) return false;
  return !BENEFICIARY_FILLER_IDIOM_RE.test(trimmed);
}

// PROVEN false positive (review, 2026-09-17): "do not wire anything to Northgate, send it
// to Meridian" matched Northgate -- the pattern never looked at what preceded the verb, so
// a negated clause ("do not wire...") was read the same as an instruction. The OLD
// (pre-widening) pattern didn't match this sentence at all (it has no filler support), so
// this is a genuinely new gap opened by the filler widening, not a prior regression.
//
// PROVEN false negative (review, 2026-09-17, negation-scope lane): the first fix scanned
// ANY "not" (or other negation word) within the three words before the verb, which is wider
// than the negation actually reaches. "not sure, but wire it to Meridian", "why not wire it
// to Meridian", and "if not today then wire it to Meridian" all contain a "not" within three
// words of "wire" but none of them negates the wire -- the "not" belongs to a different
// clause ("not sure", a rhetorical "why not", a dangling "if not today") and the old code
// dropped Meridian from all three, while the pre-fix code correctly extracted it.
//
// RULE: negation only suppresses the verb when the negation cue is the auxiliary/adverb
// chain DIRECTLY ATTACHED to that verb -- i.e. the text immediately before the verb, after
// stripping at most a short run of adverbs ("ever"/"actually"/"really"), IS one of the cue
// phrases ("do not"/"don't"/"never"/"won't"/"shouldn't"/"can't"/"cannot"/"no need to"). Any
// other word, punctuation, or clause break ("but", "then", a comma) sitting between the cue
// and the verb means the cue is NOT attached to this verb, so it does not negate it -- that
// is why "not sure, but" (tail word "but"), "why not" (bare "not" is not a cue phrase on its
// own; only "do not" is), and "not today then" (tail word "then") all fail to match and the
// verb is read as un-negated. A later, un-negated clause in the same utterance ("send it to
// Meridian" after "do not wire anything to Northgate") still extracts normally, since only
// the text directly before EACH verb occurrence is checked.
const BENEFICIARY_NEGATION_ADVERB = '(?:ever|actually|really)';
const BENEFICIARY_NEGATION_ADJACENT_RE = new RegExp(
  `(?:\\bdo not|\\bdon'?t|\\bnever|\\bwon'?t|\\bshouldn'?t|\\bcan'?t|\\bcannot|\\bno need to)` +
    `(?:\\s+${BENEFICIARY_NEGATION_ADVERB})*\\s*$`,
  'i',
);

/** Pure: true iff the text immediately before `verbIndex` ends in a negation cue phrase
 *  (optionally followed by a short adverb chain) with nothing else between the cue and the
 *  verb. See the RULE comment above for why adjacency, not proximity, is what matters. */
function verbIsNegated(text: string, verbIndex: number): boolean {
  const before = text.slice(0, verbIndex);
  return BENEFICIARY_NEGATION_ADJACENT_RE.test(before);
}

/** Validates a "verb ... to NAME" beneficiary match against the two false-positive guards
 *  above. `m.groups.filler` is the captured run of words between the verb and "to" (see the
 *  regex below); `m.index` is where the verb itself starts. */
function validateBeneficiaryVerbToName(m: RegExpExecArray, text: string): boolean {
  const filler = m.groups?.filler ?? '';
  if (!beneficiaryFillerIsClean(filler)) return false;
  return !verbIsNegated(text, m.index);
}

const CUE_PATTERNS: { field: CuedNameField; re: RegExp; validate?: (m: RegExpExecArray, text: string) => boolean }[] = [
  { field: 'approver', re: new RegExp(`\\bapproved by\\s+(${NAME})`, 'g') },
  // fix (P2, 2026-09-14, rehearsal report 2026-09-14T18-05-49-single-wrong-answer.md): a
  // caller correcting themselves said "...wait, I mean Elena Park approved it." -- the name
  // comes BEFORE "approved", not after "approved by", so the only pattern above never
  // captured it and the ledger's approver claim stayed on the pre-correction name for the
  // rest of the call (the readback and the trap-fact challenge both spoke it). Mirrors the
  // reversed counsel patterns just below ("(NAME) is/are/was/were counsel", "(NAME) handled
  // it"): a name immediately followed by "approved" (optionally "it"/"this"/"that"/"the
  // payment"/"the transfer"/"the wire") is an approver claim too.
  { field: 'approver', re: new RegExp(`(${NAME})\\s+approved\\b`, 'g') },
  // Fix round 1, finding 1: connector is now mandatory (was `?\s*`, which let bare
  // "counsel Jane Doe" match with no "is"/"was"/etc.), matching the beneficiary/vendor shape.
  { field: 'counsel', re: new RegExp(`\\bcounsel\\b (?:is|was|of record is|of record was)\\s+(${NAME})`, 'g') },
  { field: 'counsel', re: new RegExp(`(${NAME})\\s+handled (?:it|the deal)\\b`, 'g') },
  // Fix round 1 (review of 2a08920 + 7d16440), finding 2: was/were alongside is/are, so
  // "X was our counsel" is recognized the same as "X is our counsel".
  { field: 'counsel', re: new RegExp(`(${NAME})\\s+(?:is|are|was|were)\\s+(?:our\\s+)?counsel\\b`, 'g') },
  {
    field: 'escrow_institution',
    re: new RegExp(`${ESCROW_CUE_HEAD}${ESCROW_CUE_KIND}${ESCROW_CUE_CONNECTOR}(${NAME})`, 'g'),
  },
  { field: 'escrow_institution', re: new RegExp(`\\bescrowed\\b\\s+(?:at\\s+|with\\s+)(${NAME})`, 'g') },
  // PROVEN gap (docs/analysis/case11-freeplay-2026-09-17.md run 21-32-40): the caller's
  // exact words "wire transfer of $84,500 to Meridian Supply" (and, worse, the same line
  // with a self-correction still in it -- "...a wire transfer of $84,100— ah, sorry, wait,
  // I meant $84,500 to Meridian Supply.") never matched, because the old pattern required
  // the verb to be followed immediately (give or take "it"/"the money"/"the funds") by
  // "to NAME" -- any amount or short aside between the verb and "to" broke it. The filler
  // between the verb and "to" is now a short, BOUNDED, non-greedy run of up to 10 words
  // (an amount, a correction aside, "it"/"the money"/"the funds", any mix of these) so it
  // still finds the nearest "to NAME" rather than swallowing an entire unrelated sentence;
  // each filler word is also barred from itself starting with "." so the run can't cross a
  // full stop into a later, unrelated sentence in the same utterance.
  {
    field: 'beneficiary',
    re: new RegExp(`\\b(?:pay|wire|send|transfer)\\b(?<filler>(?:\\s+(?!\\.)\\S+){0,10}?)\\s+to\\s+(?<name>${NAME})`, 'g'),
    validate: validateBeneficiaryVerbToName,
  },
  { field: 'beneficiary', re: new RegExp(`\\bbeneficiary\\b (?:is|will be)\\s+(${NAME})`, 'g') },
  { field: 'beneficiary', re: new RegExp(`\\bvendor\\b (?:is|will be)\\s+(${NAME})`, 'g') },
  // PROVEN gap (found 2026-09-17: docs/analysis/... free-play Dana line "The amount is
  // $84,600 to Meridian Supply, account ending 4471" never matched any beneficiary cue,
  // because every cue above requires a verb (pay/wire/send/transfer) before "to NAME" --
  // amount-led and noun-led phrasings have no such verb at all. These five cues add the
  // no-verb shapes judges/callers actually use, without touching the verb cue above or its
  // guards (pronoun stoplist, idiom stoplist, negation adjacency): a caller who leads with
  // the dollar figure, or narrates in the present-progressive/noun-phrase register, still
  // gets a beneficiary claim.
  //   - "<amount> to NAME": a literal dollar amount immediately followed by "to NAME"
  //     ("$84,600 to Meridian Supply", "the amount is $84,600 to Meridian Supply"). NAME
  //     itself requires a leading capital letter, so a lowercase object ("$1.8 million wired
  //     to the escrow account") can never match this cue by construction.
  //   - "going to NAME": present-progressive narration ("it's going to Meridian Supply").
  //   - "for NAME", gated: "for" alone is far too common to cue on bare, so this only fires
  //     when "for" is directly preceded by "payment is" / "transfer is" / "wire is" / "it is"
  //     / "it's" -- "the payment is for Meridian Supply", "it's for Meridian Supply". This
  //     also keeps "This payment is for system upgrades" (lowercase object) from matching.
  //   - "payable to NAME": "payable to Meridian Supply".
  //   - "recipient is NAME": "the recipient is Meridian Supply" (mirrors the existing
  //     "beneficiary is NAME" / "vendor is NAME" cues just above).
  // De-duping in collectCuedNameMatches (below) drops any of these that lands on the exact
  // same name span as the verb cue already matched (e.g. "wire $84,500 to Meridian Supply"
  // is also a valid "<amount> to NAME" match) so no beneficiary hit is ever double-counted.
  { field: 'beneficiary', re: new RegExp(`\\$[\\d,]+(?:\\.\\d{1,2})?\\s+to\\s+(${NAME})`, 'g') },
  { field: 'beneficiary', re: new RegExp(`\\bgoing\\s+to\\s+(${NAME})`, 'g') },
  {
    field: 'beneficiary',
    re: new RegExp(`(?:\\b(?:payment|transfer|wire)\\s+is|\\bit(?:'s|\\s+is))\\s+for\\s+(${NAME})`, 'g'),
  },
  { field: 'beneficiary', re: new RegExp(`\\bpayable\\s+to\\s+(${NAME})`, 'g') },
  { field: 'beneficiary', re: new RegExp(`\\brecipient\\b (?:is|will be)\\s+(${NAME})`, 'g') },
];

/** Trims a matched name run at the first comma/period, since the NAME pattern's own
 *  connector list ("the", "of", ...) can't itself exclude sentence punctuation. */
function trimName(raw: string): string {
  const cut = raw.search(/[,.]/);
  return (cut === -1 ? raw : raw.slice(0, cut)).trimEnd();
}

interface RawCuedNameMatch {
  field: CuedNameField;
  index: number; // char offset of the (trimmed) name within `text`
  name: string;
}

/** Shared scan used by both `extractCuedNames` and `cuedNameSpans` so the two never drift
 *  apart -- a name the ledger records as an approver/counsel/escrow/beneficiary is exactly
 *  the same span the identity extractor is told to ignore. */
function collectCuedNameMatches(text: string): RawCuedNameMatch[] {
  const matches: RawCuedNameMatch[] = [];
  // De-dupe by (field, name start index): the no-verb beneficiary cues added above can land
  // on the exact same name span the verb cue already matched (e.g. "wire $84,500 to Meridian
  // Supply" is both the verb cue and the new "<amount> to NAME" cue) -- keep only the first
  // pattern's hit for that span so a single spoken name is never counted twice.
  const seenSpans = new Set<string>();
  for (let patternIdx = 0; patternIdx < CUE_PATTERNS.length; patternIdx++) {
    const pattern = CUE_PATTERNS[patternIdx]!;
    const { field, re, validate } = pattern;
    const isReversedApproverPattern = field === 'approver' && patternIdx === 1; // The second approver pattern is the reversed one
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      // `validate` is only set on the "verb ... to NAME" beneficiary pattern (its own named
      // capture groups let it inspect the filler and what preceded the verb) -- every other
      // pattern has no `validate` and behaves exactly as before.
      if (validate && !validate(m, text)) continue;
      // A pattern with a named `name` group (currently only the one above, which also has a
      // `filler` group ahead of it, shifting the positional index) is read from there;
      // every other pattern still reads the name from its one-and-only capturing group, m[1].
      const rawName = (m.groups?.name ?? m[1])!;
      const name = trimName(rawName);
      if (name.length === 0) continue;
      // A closed-class function word (pronoun/contraction/demonstrative) is never a real
      // name, whichever cue pattern captured it (2026-09-18 founder live defect, "It's
      // approved" -- see NON_NAME_WORD_STOPLIST's own doc comment above).
      if (isNonNameWord(name)) continue;
      // For the reversed approver pattern "(NAME) approved", exclude department names.
      if (isReversedApproverPattern && isDepartmentName(name)) continue;
      const nameStart = m.index + m[0].indexOf(rawName);
      const spanKey = `${field}:${nameStart}`;
      if (seenSpans.has(spanKey)) continue;
      seenSpans.add(spanKey);
      matches.push({ field, index: nameStart, name });
    }
  }
  matches.sort((a, b) => a.index - b.index);
  return matches;
}

export function extractCuedNames(text: string): CuedNameHit[] {
  return collectCuedNameMatches(text).map(({ field, index, name }) => ({
    field,
    value: name,
    quote: text.slice(index, index + name.length),
  }));
}

/** Character spans (start inclusive, end exclusive) of every name captured by a cued-name
 *  pattern -- "approved by X", "counsel is X", "escrow ... X", "pay/wire/send/transfer to
 *  X", "beneficiary/vendor is X", etc. `extractIdentityClaim` (src/extract/identity.ts)
 *  skips any name match that falls inside one of these spans: a named approver, counsel,
 *  escrow institution, or beneficiary is never the caller's own identity claim. */
export function cuedNameSpans(text: string): { start: number; end: number }[] {
  return collectCuedNameMatches(text).map(({ index, name }) => ({ start: index, end: index + name.length }));
}
