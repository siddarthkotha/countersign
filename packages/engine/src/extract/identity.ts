// packages/engine/src/extract/identity.ts
// Matches a spoken identity claim against the seed's known identities/aliases. This is a
// STATED-fact extractor only — it never implies anything about voice authenticity.
import type { SeedConfig } from '../types';

export interface IdentityHit {
  identity_id: string;
  quote: string;
}

/** True when `candidate` (already lower-case) occurs in `lowerText` at `idx` with a word
 *  boundary on both sides (neither neighbor is a letter or digit). */
function isWordBounded(lowerText: string, idx: number, len: number): boolean {
  const before = idx > 0 ? lowerText[idx - 1] : undefined;
  const after = idx + len < lowerText.length ? lowerText[idx + len] : undefined;
  const isWordChar = (c: string | undefined): boolean => c !== undefined && /[a-z0-9]/.test(c);
  return !isWordChar(before) && !isWordChar(after);
}

function findCandidate(text: string, lowerText: string, candidate: string): string | null {
  const lowerCandidate = candidate.toLowerCase();
  let from = 0;
  while (from <= lowerText.length) {
    const idx = lowerText.indexOf(lowerCandidate, from);
    if (idx === -1) return null;
    if (isWordBounded(lowerText, idx, lowerCandidate.length)) {
      return text.slice(idx, idx + lowerCandidate.length);
    }
    from = idx + 1;
  }
  return null;
}

/** Full names take priority over aliases: try every identity's `name` first, then every
 *  identity's aliases, both in seed order. Returns the first match found. */
export function extractIdentityClaim(text: string, seed: SeedConfig): IdentityHit | null {
  const lowerText = text.toLowerCase();

  for (const identity of seed.identities) {
    const quote = findCandidate(text, lowerText, identity.name);
    if (quote) return { identity_id: identity.id, quote };
  }

  for (const identity of seed.identities) {
    for (const alias of identity.aliases) {
      const quote = findCandidate(text, lowerText, alias);
      if (quote) return { identity_id: identity.id, quote };
    }
  }

  return null;
}
