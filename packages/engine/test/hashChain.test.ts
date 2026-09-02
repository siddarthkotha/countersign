import { describe, expect, it } from 'vitest';
import {
  buildEvidenceExport,
  canonicalJson,
  sha256Hex,
  verifyEvidenceExport,
} from '../src/export/hashChain';
import type { EngineOutput, Evidence } from '../src/types';

function evidenceFixture(id: string, detail: string): Evidence {
  return {
    id,
    kind: 'identity_claim',
    t_ms: 1000,
    label: 'Identity',
    status: 'PASS',
    detail,
    facts: { name: 'Robert Miller' },
    quotes: [{ utterance_id: 'u1', text: 'This is Robert Miller' }],
    source: 'transcript',
    provenance: 'CALLER_SAID',
    request_version: 1,
  };
}

// Minimal Pick<EngineOutput, 'verdict' | 'reasons' | 'evidence'>-shaped object for tests.
function outputFixture(evidence: Evidence[]): Pick<EngineOutput, 'verdict' | 'reasons' | 'evidence'> {
  return {
    verdict: 'STAGE',
    reasons: [],
    evidence,
  };
}

describe('canonicalJson', () => {
  it('sorts nested keys and emits no whitespace', () => {
    const value = { b: 1, a: { d: 2, c: 3 }, e: [3, 1, 2] };
    expect(canonicalJson(value)).toBe('{"a":{"c":3,"d":2},"b":1,"e":[3,1,2]}');
  });
});

describe('sha256Hex', () => {
  it('is deterministic for the same input', async () => {
    const a = await sha256Hex('hello');
    const b = await sha256Hex('hello');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes the empty string to the well-known SHA-256 constant', async () => {
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});

describe('buildEvidenceExport / verifyEvidenceExport', () => {
  it('produces the same root_hash for the same input twice', async () => {
    const out = outputFixture([evidenceFixture('e1', 'Caller claimed identity Robert Miller')]);
    const exportA = await buildEvidenceExport('review-1', out, '2026-09-01T00:00:00.000Z');
    const exportB = await buildEvidenceExport('review-1', out, '2026-09-01T00:00:00.000Z');
    expect(exportA.root_hash).toBe(exportB.root_hash);
  });

  it('sets entries[0].prev_hash to 64 zeros', async () => {
    const out = outputFixture([evidenceFixture('e1', 'Caller claimed identity Robert Miller')]);
    const built = await buildEvidenceExport('review-1', out, '2026-09-01T00:00:00.000Z');
    expect(built.entries[0]!.prev_hash).toBe('0'.repeat(64));
  });

  it('computes each entry.hash as sha256Hex(prev_hash + canonicalJson(evidence))', async () => {
    const evidenceList = [
      evidenceFixture('e1', 'Caller claimed identity Robert Miller'),
      evidenceFixture('e2', 'SSO context confirmed'),
    ];
    const out = outputFixture(evidenceList);
    const built = await buildEvidenceExport('review-1', out, '2026-09-01T00:00:00.000Z');

    const expectedHash0 = await sha256Hex('0'.repeat(64) + canonicalJson(evidenceList[0]));
    expect(built.entries[0]!.hash).toBe(expectedHash0);

    const expectedHash1 = await sha256Hex(built.entries[0]!.hash + canonicalJson(evidenceList[1]));
    expect(built.entries[1]!.hash).toBe(expectedHash1);

    expect(built.root_hash).toBe(built.entries[built.entries.length - 1]!.hash);
  });

  it('verifies ok: true for an untouched export', async () => {
    const out = outputFixture([
      evidenceFixture('e1', 'Caller claimed identity Robert Miller'),
      evidenceFixture('e2', 'SSO context confirmed'),
    ]);
    const built = await buildEvidenceExport('review-1', out, '2026-09-01T00:00:00.000Z');
    const result = await verifyEvidenceExport(built);
    expect(result).toEqual({ ok: true, broken_at: null });
  });

  it('reports ok: false, broken_at: <index> when one evidence detail changes', async () => {
    const out = outputFixture([
      evidenceFixture('e1', 'Caller claimed identity Robert Miller'),
      evidenceFixture('e2', 'SSO context confirmed'),
      evidenceFixture('e3', 'Out-of-band verification confirmed'),
    ]);
    const built = await buildEvidenceExport('review-1', out, '2026-09-01T00:00:00.000Z');

    // Tamper with the second entry's evidence detail after the fact.
    built.entries[1]!.evidence = { ...built.entries[1]!.evidence, detail: 'TAMPERED' };

    const result = await verifyEvidenceExport(built);
    expect(result.ok).toBe(false);
    expect(result.broken_at).toBe(1);
  });

  it('reports ok: false, broken_at: <first moved index> when two entries are reordered', async () => {
    const out = outputFixture([
      evidenceFixture('e1', 'Caller claimed identity Robert Miller'),
      evidenceFixture('e2', 'SSO context confirmed'),
      evidenceFixture('e3', 'Out-of-band verification confirmed'),
    ]);
    const built = await buildEvidenceExport('review-1', out, '2026-09-01T00:00:00.000Z');

    // Swap entries 0 and 1 wholesale — their own hash/evidence fields are left
    // untouched, only their position in the array changes. This breaks the
    // prev_hash linkage between entries without breaking any individual entry's
    // own hash, so it exercises the prev_hash-mismatch branch in
    // verifyEvidenceExport (hashChain.ts:117-119), not the hash-recompute branch.
    const first = built.entries[0]!;
    const second = built.entries[1]!;
    built.entries[0] = second;
    built.entries[1] = first;

    const result = await verifyEvidenceExport(built);
    expect(result.ok).toBe(false);
    expect(result.broken_at).toBe(0);
  });

  it('handles empty evidence: ok: true, root_hash === sha256Hex("")', async () => {
    const out = outputFixture([]);
    const built = await buildEvidenceExport('review-1', out, '2026-09-01T00:00:00.000Z');
    expect(built.entries).toEqual([]);
    expect(built.root_hash).toBe(await sha256Hex(''));

    const result = await verifyEvidenceExport(built);
    expect(result).toEqual({ ok: true, broken_at: null });
  });
});
