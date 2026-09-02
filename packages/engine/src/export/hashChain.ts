// packages/engine/src/export/hashChain.ts
//
// Hash-chained evidence export: turns an EngineOutput's evidence list into a linear
// chain of entries, each hashed over the previous entry's hash and its own canonical
// JSON. This lets a reviewer verify nothing in the export was altered after the fact
// by recomputing the chain and comparing it entry by entry — a "hash-chained evidence
// export", not a promise of immutability or cryptographic guarantee.
//
// No runtime dependencies: uses globalThis.crypto.subtle, which is available in both
// Node 24+ and browsers, so this module can run client-side too.

import type { Evidence, EngineOutput, Verdict, VerdictReason } from '../types';
import { ENGINE_VERSION } from '../index';

export interface ChainEntry {
  index: number;
  prev_hash: string;
  hash: string;
  evidence: Evidence;
}

export interface EvidenceExport {
  review_id: string;
  engine_version: string;
  verdict: Verdict;
  reasons: VerdictReason[];
  entries: ChainEntry[];
  root_hash: string;
  exported_at: string;
}

const GENESIS_PREV_HASH = '0'.repeat(64);

/** Deterministic JSON serialization: object keys sorted recursively, no whitespace. */
export function canonicalJson(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => serialize(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const body = keys
      .map((key) => `${JSON.stringify(key)}:${serialize((value as Record<string, unknown>)[key])}`)
      .join(',');
    return `{${body}}`;
  }
  return JSON.stringify(value);
}

/** SHA-256 of a UTF-8 string, hex-encoded, via globalThis.crypto.subtle. */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Builds a hash-chained evidence export from an engine output. Each entry's hash covers
 * the previous entry's hash plus the canonical JSON of its own evidence card, so entries
 * cannot be reordered, dropped, or edited without changing every hash from that point on.
 * With no evidence, root_hash is sha256Hex('') (the hash of an empty chain).
 */
export async function buildEvidenceExport(
  review_id: string,
  out: Pick<EngineOutput, 'verdict' | 'reasons' | 'evidence'>,
  exported_at: string,
): Promise<EvidenceExport> {
  const entries: ChainEntry[] = [];
  let prev_hash = GENESIS_PREV_HASH;
  let last_hash: string | null = null;

  for (const [index, evidence] of out.evidence.entries()) {
    const hash = await sha256Hex(prev_hash + canonicalJson(evidence));
    entries.push({ index, prev_hash, hash, evidence });
    prev_hash = hash;
    last_hash = hash;
  }

  const root_hash = last_hash ?? (await sha256Hex(''));

  return {
    review_id,
    engine_version: ENGINE_VERSION,
    verdict: out.verdict,
    reasons: out.reasons,
    entries,
    root_hash,
    exported_at,
  };
}

/**
 * Recomputes the hash chain from an export's evidence entries and reports whether it
 * still matches. Returns the index of the first entry whose recomputed hash diverges
 * (evidence was altered, or the chain was reordered/truncated), or null when the whole
 * chain — and the root_hash — still checks out.
 */
export async function verifyEvidenceExport(
  x: EvidenceExport,
): Promise<{ ok: boolean; broken_at: number | null }> {
  if (x.entries.length === 0) {
    const expectedRoot = await sha256Hex('');
    return x.root_hash === expectedRoot ? { ok: true, broken_at: null } : { ok: false, broken_at: null };
  }

  let prev_hash = GENESIS_PREV_HASH;

  for (const [index, entry] of x.entries.entries()) {
    if (entry.prev_hash !== prev_hash) {
      return { ok: false, broken_at: index };
    }
    const expectedHash = await sha256Hex(prev_hash + canonicalJson(entry.evidence));
    if (entry.hash !== expectedHash) {
      return { ok: false, broken_at: index };
    }
    prev_hash = entry.hash;
  }

  if (x.root_hash !== prev_hash) {
    return { ok: false, broken_at: x.entries.length - 1 };
  }

  return { ok: true, broken_at: null };
}
