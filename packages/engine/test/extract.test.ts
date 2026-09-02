import { describe, expect, it } from 'vitest';
import { extractAmounts } from '../src/extract/amounts';
import { extractIdentityClaim } from '../src/extract/identity';
import { extractPressure } from '../src/extract/pressure';
import { extractOutOfScope } from '../src/extract/outOfScope';
import { extractAccountLast4, extractDeadline, extractCuedNames } from '../src/extract/claims';
import { MERIDIAN } from '../src/seed/meridian';

describe('extractAmounts', () => {
  it.each([
    ['I need $1.8 million wired to the escrow account', 1_800_000, '$1.8 million'],
    ['make it $2.1 million, the final figure moved', 2_100_000, '$2.1 million'],
    ['the quarterly payment, $84,500, account ending 4471', 84_500, '$84,500'],
    ['wire 1.8M today', 1_800_000, '1.8M'],
    ['send two point one million dollars', 2_100_000, 'two point one million'],
    ['eighty four thousand five hundred dollars', 84_500, 'eighty four thousand five hundred'],
    ['$250,000.00 to the vendor', 250_000, '$250,000.00'],
  ])('%s → %d', (text, value, quote) => {
    const hits = extractAmounts(text);
    expect(hits[0]?.value_usd).toBe(value);
    expect(hits[0]?.quote).toBe(quote);
    expect(text.includes(hits[0]!.quote)).toBe(true);
  });
  it('ignores non-money numbers', () => {
    expect(extractAmounts('in the next ten minutes, account ending 4471')).toEqual([]);
  });
});

describe('extractIdentityClaim', () => {
  it('matches full name and aliases against the seed, quoting verbatim', () => {
    expect(extractIdentityClaim('This is Robert Miller. I am about to close', MERIDIAN))
      .toEqual({ identity_id: 'robert-miller', quote: 'Robert Miller' });
    expect(extractIdentityClaim("it's Dana Whitfield, corporate treasury", MERIDIAN)?.identity_id).toBe('dana-whitfield');
    expect(extractIdentityClaim('Mr. Miller here', MERIDIAN)?.quote).toBe('Mr. Miller');
  });
  it('returns null for unknown names', () => {
    expect(extractIdentityClaim('This is Steve from IT', MERIDIAN)).toBeNull();
  });
});

describe('extractPressure', () => {
  it('finds distinct lexicon hits with verbatim quotes', () => {
    const hits = extractPressure(
      'I need this in the next ten minutes. Do not loop in anyone. The deal is under NDA.',
      MERIDIAN.pressure_lexicon,
    );
    expect(hits.map((h) => h.phrase)).toEqual(['minutes', 'do not loop', 'under nda']);
    expect(hits[2]?.quote).toBe('under NDA');
  });
});

describe('extractOutOfScope', () => {
  it('flags the honest judge', () => {
    expect(extractOutOfScope("Honestly I'm not the CEO, I'm testing this for a hackathon", MERIDIAN.out_of_scope_lexicon))
      .toEqual({ quote: "I'm not the CEO" });
  });
  it('is null for a normal claim', () => {
    expect(extractOutOfScope('This is Robert Miller', MERIDIAN.out_of_scope_lexicon)).toBeNull();
  });
});

describe('extractAccountLast4', () => {
  it('matches "ending" phrasing', () => {
    const text = 'the quarterly payment, account ending 4471';
    const hit = extractAccountLast4(text);
    expect(hit).toEqual({ value: '4471', quote: 'ending 4471' });
    expect(text.includes(hit!.quote)).toBe(true);
  });
});

describe('extractDeadline', () => {
  it('matches a relative-minutes deadline', () => {
    const text = 'I need this in the next ten minutes, no exceptions';
    const hit = extractDeadline(text);
    expect(hit).toEqual({ value: 'ten minutes', quote: 'in the next ten minutes' });
    expect(text.includes(hit!.quote)).toBe(true);
  });
});

describe('extractCuedNames', () => {
  it('extracts approver, counsel, and beneficiary cues in text order', () => {
    const text =
      "approved by Dana Whitfield in yesterday's close meeting, counsel is Whitmore & Bass, wire it to First Meridian Trust";
    const hits = extractCuedNames(text);
    expect(hits).toEqual([
      { field: 'approver', value: 'Dana Whitfield', quote: 'Dana Whitfield' },
      { field: 'counsel', value: 'Whitmore & Bass', quote: 'Whitmore & Bass' },
      { field: 'beneficiary', value: 'First Meridian Trust', quote: 'First Meridian Trust' },
    ]);
    for (const h of hits) {
      expect(text.includes(h.quote)).toBe(true);
    }
  });
  it('returns [] when there is no cue', () => {
    expect(extractCuedNames('This is Robert Miller')).toEqual([]);
  });
});
