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

const CUE_PATTERNS: { field: CuedNameField; re: RegExp }[] = [
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
    re: new RegExp(`\\b(?:pay|wire|send|transfer)\\b(?:\\s+(?!\\.)\\S+){0,10}?\\s+to\\s+(${NAME})`, 'g'),
  },
  { field: 'beneficiary', re: new RegExp(`\\bbeneficiary\\b (?:is|will be)\\s+(${NAME})`, 'g') },
  { field: 'beneficiary', re: new RegExp(`\\bvendor\\b (?:is|will be)\\s+(${NAME})`, 'g') },
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
  for (let patternIdx = 0; patternIdx < CUE_PATTERNS.length; patternIdx++) {
    const pattern = CUE_PATTERNS[patternIdx]!;
    const { field, re } = pattern;
    const isReversedApproverPattern = field === 'approver' && patternIdx === 1; // The second approver pattern is the reversed one
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const rawName = m[1]!;
      const name = trimName(rawName);
      if (name.length === 0) continue;
      // For the reversed approver pattern "(NAME) approved", exclude department names.
      if (isReversedApproverPattern && isDepartmentName(name)) continue;
      const nameStart = m.index + m[0].indexOf(rawName);
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
