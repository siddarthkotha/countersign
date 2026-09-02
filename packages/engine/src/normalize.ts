// packages/engine/src/normalize.ts
// Shared text-normalization helper: lower-case, strip punctuation, "&" -> "and", collapse
// whitespace. Used to compare a caller-stated beneficiary/vendor name against the mock
// backend's vendor strings without being tripped up by punctuation or case.

export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
