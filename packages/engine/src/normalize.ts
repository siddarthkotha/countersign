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
