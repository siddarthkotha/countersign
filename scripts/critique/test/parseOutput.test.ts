// scripts/critique/test/parseOutput.test.ts
import { describe, it, expect } from 'vitest';
import { parseCriticOutput, extractJsonArray } from '../parseOutput.js';

describe('extractJsonArray', () => {
  it('is string-aware: brackets inside a quoted string do not confuse the bracket matcher', () => {
    const text = 'prefix [{"a": "text with [brackets] inside"}] suffix';
    const found = extractJsonArray(text);
    expect(found).not.toBeNull();
    expect(JSON.parse(found!.json)).toEqual([{ a: 'text with [brackets] inside' }]);
  });

  it('returns null when there is no array', () => {
    expect(extractJsonArray('no array here')).toBeNull();
  });
});

describe('parseCriticOutput', () => {
  it('parses a clean response: JSON array then prose verdict', () => {
    const raw = `[{"severity":"critical","area":"rule table","claim":"x","evidence_quote":"y","suggested_test":"z"}]\n\nLine one.\nLine two.\nLine three.\nLine four.\nLine five.`;
    const parsed = parseCriticOutput(raw);
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]!.severity).toBe('critical');
    expect(parsed.prose_verdict).toContain('Line one.');
    expect(parsed.parse_error).toBeUndefined();
  });

  it('strips markdown code fences around the JSON array', () => {
    const raw = '```json\n[{"severity":"minor","area":"a","claim":"c","evidence_quote":"","suggested_test":""}]\n```\n\nprose here';
    const parsed = parseCriticOutput(raw);
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]!.claim).toBe('c');
  });

  it('defaults a malformed severity to minor rather than dropping the finding', () => {
    const raw = '[{"severity":"super-bad","area":"a","claim":"c","evidence_quote":"","suggested_test":""}]';
    const parsed = parseCriticOutput(raw);
    expect(parsed.findings[0]!.severity).toBe('minor');
  });

  it('returns an empty array with a parse_error when no JSON array is present, but keeps the raw text', () => {
    const raw = 'I refuse to answer in JSON today.';
    const parsed = parseCriticOutput(raw);
    expect(parsed.findings).toEqual([]);
    expect(parsed.parse_error).toBeDefined();
    expect(parsed.prose_verdict).toContain('I refuse');
  });

  it('returns an empty findings array (not an error) for an explicit empty array response', () => {
    const raw = '[]\n\nFive lines of prose follow here explaining nothing was found today at all.';
    const parsed = parseCriticOutput(raw);
    expect(parsed.findings).toEqual([]);
    expect(parsed.parse_error).toBeUndefined();
  });
});
