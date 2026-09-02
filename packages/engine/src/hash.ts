// packages/engine/src/hash.ts
// Tiny FNV-1a 32-bit hash over a string. Used only to derive a deterministic, per-session
// ORDERING (e.g. which SEED_FACT challenge comes up first) — never anything about voice
// authenticity, never security-relevant. No runtime dependencies.

export function fnv1a(s: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
