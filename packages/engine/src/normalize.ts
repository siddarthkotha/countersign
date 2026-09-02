// packages/engine/src/normalize.ts
// Shared text-normalization helper: lower-case, strip punctuation, "&" -> "and", collapse
// whitespace. Used to compare a caller-stated beneficiary/vendor name against the mock
// backend's vendor strings without being tripped up by punctuation or case.
import type { ClaimField } from './types';

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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
