// packages/engine/src/normalize.ts
// Shared text-normalization helper: lower-case, strip punctuation, "&" -> "and", collapse
// whitespace. Used to compare a caller-stated beneficiary/vendor name against the mock
// backend's vendor strings without being tripped up by punctuation or case.
import { escapeRegExp } from './util.js';
import type { ClaimField } from './types.js';

export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** v2 (story ledger, src/ledger.ts): normalize a claim value for comparison and storage.
 *  Amounts stay numeric (as-is). Account digits and identity ids are kept as plain strings
 *  (never text-normalized — an identity id is already a canonical key, not a spoken name;
 *  account digits are a code, not prose). Everything else (beneficiary, approver, counsel,
 *  escrow_institution, deadline, purpose, others_aware) goes through `normalizeText`. */
export function normalizeValue(field: ClaimField, v: string | number): string | number {
  if (field === 'amount_usd') {
    return typeof v === 'number' ? v : Number(v);
  }
  if (field === 'account_last4' || field === 'identity') {
    return String(v);
  }
  return typeof v === 'number' ? v : normalizeText(v);
}

/** v2 (shared by ledger.ts and challenges.ts): does any lexicon phrase occur in `text` as a
 *  whole word/phrase — never as a bare substring? Both `text` and each phrase are run
 *  through `normalizeText` first (so "Calder & Finch" matches the lexicon phrase "calder
 *  and finch", and an apostrophe inside a phrase like "that's not" still matches even
 *  though normalization strips it from both sides identically), then a phrase matches only
 *  when bounded by non-word characters or the string edges on both sides — so "no" never
 *  fires on "know", and "right" never fires on "copyright". Returns the first matching
 *  lexicon entry (in lexicon order) verbatim, or null. */
export function lexiconHit(text: string, lexicon: string[]): string | null {
  const normalizedText = normalizeText(text);
  for (const phrase of lexicon) {
    const normalizedPhrase = normalizeText(phrase);
    if (normalizedPhrase.length === 0) continue;
    const pattern = `\\b${escapeRegExp(normalizedPhrase).replace(/\s+/g, '\\s+')}\\b`;
    if (new RegExp(pattern, 'i').test(normalizedText)) return phrase;
  }
  return null;
}

export function hasLexiconHit(text: string, lexicon: string[]): boolean {
  return lexiconHit(text, lexicon) !== null;
}

// ---------- spoken digit-run normalization ----------
// FIX (2026-09-16, terse-answers lane, finding 1): account/phone-style digit readbacks are
// often spoken as compound number words rather than literal digits or single spelled digits
// -- "eighty-eight thirty" (two-digit chunks), "eight eight three zero" (single digits), or
// "double eight three oh" (a doubled digit word). None of these are recognized by a bare
// `\d{2,}` or single-spelled-digit regex. Distinct from extract/spokenNumbers.ts's magnitude
// parser (which sums "two point one million" into a dollar VALUE) -- this reads digit PAIRS
// or singles the way people read back an account number, never sums a quantity. Scans `text`
// word-by-word for maximal runs of digit-shaped tokens (bare numerals, "double X", a tens
// word alone or compounded with a trailing ones word, a teen word, or a single ones word) and
// replaces each run in place with its concatenated digit string; anything that doesn't
// resolve to a digit token breaks the run immediately and is left completely untouched, so
// ordinary prose around the digits (and any lexicon/name matching done on it elsewhere) is
// unaffected. Kept engine-dependency-free (LAW 3): no import from scripts/rehearse's harness
// helper -- this is a from-scratch, narrower reimplementation for the same purpose.
const DIGIT_ONES: Record<string, string> = {
  zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4',
  five: '5', six: '6', seven: '7', eight: '8', nine: '9',
};
const DIGIT_TEENS: Record<string, string> = {
  ten: '10', eleven: '11', twelve: '12', thirteen: '13', fourteen: '14',
  fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18', nineteen: '19',
};
const DIGIT_TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

interface DigitToken {
  word: string;
  start: number;
  end: number;
}

function tokenizeDigitWords(text: string): DigitToken[] {
  const tokens: DigitToken[] = [];
  const re = /[A-Za-z]+|\d+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    tokens.push({ word: m[0].toLowerCase(), start: m.index, end: m.index + m[0].length });
  }
  return tokens;
}

export function normalizeSpokenDigits(text: string): string {
  const tokens = tokenizeDigitWords(text);
  if (tokens.length === 0) return text;

  const runs: { start: number; end: number; digits: string }[] = [];
  let i = 0;
  while (i < tokens.length) {
    const digits: string[] = [];
    let runStart = -1;
    let j = i;
    while (j < tokens.length) {
      const tok = tokens[j]!;
      const w = tok.word;
      if (/^\d+$/.test(w)) {
        if (runStart === -1) runStart = tok.start;
        digits.push(w);
        j++;
        continue;
      }
      if (w === 'double' && j + 1 < tokens.length && tokens[j + 1]!.word in DIGIT_ONES) {
        if (runStart === -1) runStart = tok.start;
        const d = DIGIT_ONES[tokens[j + 1]!.word]!;
        digits.push(d, d);
        j += 2;
        continue;
      }
      if (w in DIGIT_TENS) {
        if (runStart === -1) runStart = tok.start;
        const tensVal = DIGIT_TENS[w]!;
        const next = tokens[j + 1];
        // Optional trailing ones word makes a compound two-digit number, e.g. "eighty
        // eight" -> 88 ("eighty oh"/a trailing zero never occurs in natural speech for
        // this shape, so a trailing "zero"/"oh" is treated as a SEPARATE digit instead).
        if (next && next.word in DIGIT_ONES && DIGIT_ONES[next.word] !== '0') {
          digits.push(String(tensVal + Number(DIGIT_ONES[next.word])));
          j += 2;
        } else {
          digits.push(String(tensVal));
          j += 1;
        }
        continue;
      }
      if (w in DIGIT_TEENS) {
        if (runStart === -1) runStart = tok.start;
        digits.push(DIGIT_TEENS[w]!);
        j += 1;
        continue;
      }
      if (w in DIGIT_ONES) {
        if (runStart === -1) runStart = tok.start;
        digits.push(DIGIT_ONES[w]!);
        j += 1;
        continue;
      }
      break;
    }
    if (digits.length > 0 && j > i) {
      runs.push({ start: runStart, end: tokens[j - 1]!.end, digits: digits.join('') });
      i = j;
    } else {
      i++;
    }
  }

  if (runs.length === 0) return text;
  let out = '';
  let cursor = 0;
  for (const run of runs) {
    out += text.slice(cursor, run.start);
    out += run.digits;
    cursor = run.end;
  }
  out += text.slice(cursor);
  return out;
}
