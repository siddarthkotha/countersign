// scripts/critique/test/report.test.ts
import { describe, it, expect } from 'vitest';
import { buildRollup, normalizeClaim, callFileBase, safeFileToken } from '../report.js';
import type { CriticResult } from '../types.js';

function result(model: string, persona: string, findings: CriticResult['findings']): CriticResult {
  return {
    provider: 'openrouter',
    model,
    model_label: model,
    persona,
    persona_label: persona,
    ok: true,
    findings,
    requested_at_iso: '2026-09-03T00:00:00.000Z',
    latency_ms: 100,
    prompt_char_estimate: 1000,
    token_estimate: 250,
  };
}

describe('normalizeClaim', () => {
  it('collapses case, whitespace, and trailing punctuation', () => {
    expect(normalizeClaim('  The Engine Leaks A Fact.  ')).toBe('the engine leaks a fact');
    expect(normalizeClaim('the engine leaks   a fact!')).toBe('the engine leaks a fact');
  });
});

describe('buildRollup', () => {
  it('dedupes the same claim raised by different critics and counts distinct raisers', () => {
    const results: CriticResult[] = [
      result('openai/gpt-4o', 'social-engineer', [
        { severity: 'important', area: 'rule table', claim: 'The readback gate can be skipped.', evidence_quote: 'q1', suggested_test: 't1' },
      ]),
      result('x-ai/grok-2', 'security-architect', [
        { severity: 'critical', area: 'rule table', claim: 'the readback gate can be skipped', evidence_quote: 'q2', suggested_test: 't2' },
      ]),
      result('perplexity/sonar-pro', 'hackathon-judge', [{ severity: 'minor', area: 'ui', claim: 'Colour used alone for the verdict banner.', evidence_quote: 'q3', suggested_test: 't3' }]),
    ];

    const rows = buildRollup(results);
    expect(rows).toHaveLength(2);

    const readback = rows.find((r) => r.normalized_claim === 'the readback gate can be skipped')!;
    expect(readback.count).toBe(2);
    expect(readback.raised_by.sort()).toEqual(['openai/gpt-4o__social-engineer', 'x-ai/grok-2__security-architect'].sort());
    // Escalates to the more severe rating seen across duplicates.
    expect(readback.severity).toBe('critical');
  });

  it('ranks critical above important above minor, then by raiser count within a severity', () => {
    const results: CriticResult[] = [
      result('m1', 'p1', [{ severity: 'minor', area: 'a', claim: 'minor claim raised twice', evidence_quote: '', suggested_test: '' }]),
      result('m2', 'p2', [{ severity: 'minor', area: 'a', claim: 'minor claim raised twice', evidence_quote: '', suggested_test: '' }]),
      result('m3', 'p3', [{ severity: 'important', area: 'a', claim: 'a lone important claim', evidence_quote: '', suggested_test: '' }]),
      result('m4', 'p4', [{ severity: 'critical', area: 'a', claim: 'a lone critical claim', evidence_quote: '', suggested_test: '' }]),
    ];
    const rows = buildRollup(results);
    expect(rows.map((r) => r.severity)).toEqual(['critical', 'important', 'minor']);
  });

  it('does not double count the same model+persona raising the same claim twice in one response', () => {
    const results: CriticResult[] = [
      result('m1', 'p1', [
        { severity: 'important', area: 'a', claim: 'duplicate within one response', evidence_quote: '', suggested_test: '' },
        { severity: 'important', area: 'a', claim: 'duplicate within one response', evidence_quote: '', suggested_test: '' },
      ]),
    ];
    const rows = buildRollup(results);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.count).toBe(1);
  });
});

describe('file naming helpers', () => {
  it('produces filesystem-safe tokens from model ids containing slashes', () => {
    expect(safeFileToken('openai/gpt-4o')).toBe('openai-gpt-4o');
    expect(safeFileToken('gemini/gemini-1.5-pro')).toBe('gemini-gemini-1.5-pro');
  });

  it('builds a stable, unique base name per (model, persona) pair', () => {
    const r = result('openai/gpt-4o', 'social-engineer', []);
    expect(callFileBase(r)).toBe('openai-gpt-4o__social-engineer');
  });
});
