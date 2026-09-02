// packages/engine/src/extract/claims.ts
// Extracts account-last-4, deadline, and cued-name (approver/counsel/escrow/beneficiary)
// mentions with verbatim quotes. Plain transcript parsing — no claim about voice
// authenticity. `value` is the claim as spoken; the story ledger normalizes it.

export interface AccountLast4Hit {
  value: string;
  quote: string;
}

const ACCOUNT_LAST4_RE = /\b(?:ending|ending in|last four|last 4|suffix)\s*(?:in\s*)?(\d{4})\b/i;

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

const CUE_PATTERNS: { field: CuedNameField; re: RegExp }[] = [
  { field: 'approver', re: new RegExp(`\\bapproved by\\s+(${NAME})`, 'g') },
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
  {
    field: 'beneficiary',
    re: new RegExp(`\\b(?:pay|wire|send|transfer)\\b\\s+(?:it\\s+|the money\\s+|the funds\\s+)?to\\s+(${NAME})`, 'g'),
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
  for (const { field, re } of CUE_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const rawName = m[1]!;
      const name = trimName(rawName);
      if (name.length === 0) continue;
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
