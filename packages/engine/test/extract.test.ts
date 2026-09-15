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

  // RULING (red team item 7, 2026-09-09): a bare scale word with no numeral or number word
  // before it must not produce an amount claim -- "thanks a million" is not $1,000,000.
  // "a million dollars" and "one million" (explicit numeral, or scale cued by "dollars")
  // must still parse.
  it('does not read a bare scale word with nothing before it as an implicit one', () => {
    expect(extractAmounts('thanks a million for helping out')).toEqual([]);
  });

  it.each([
    ['send a million dollars to the account', 1_000_000, 'million'],
    ['wire one million to the escrow account', 1_000_000, 'one million'],
  ])('%s → %d', (text, value, quote) => {
    const hits = extractAmounts(text);
    expect(hits[0]?.value_usd).toBe(value);
    expect(hits[0]?.quote).toBe(quote);
    expect(text.includes(hits[0]!.quote)).toBe(true);
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

  // RULING (identity-cue fix): a bare name mention is not a self-identification. A named
  // approver/counsel/escrow/beneficiary elsewhere in the sentence is never the caller.
  it.each([
    ['This is Robert Miller. I am about to close', 'robert-miller'],
    ["Actually, I'm Dana Whitfield", 'dana-whitfield'],
    ['Robert Miller here', 'robert-miller'],
    ['Dana Whitfield, corporate treasury', 'dana-whitfield'],
    ['no, it was approved by Elena Park', null],
    ['Marcus Obi approved it yesterday', null],
    ['counsel is Calder & Finch and Marcus said go', null],
    ['Mr. Miller here', 'robert-miller'],
    ['I spoke with Dana Whitfield earlier', null],
  ])('%s → %s', (text, identity_id) => {
    const hit = extractIdentityClaim(text, MERIDIAN);
    expect(hit?.identity_id ?? null).toBe(identity_id);
  });

  // Fix round 1 (review of 2a08920 + 7d16440), finding 2: an auxiliary/adverb run between
  // the name and the disqualifying verb must still disqualify -- and the plain "starts the
  // utterance" matches must keep working alongside the wider exclusion.
  it.each([
    ['Marcus Obi has approved it', null],
    ['Marcus Obi was our counsel', null],
    ['Marcus Obi already approved it', null],
    ['Dana Whitfield will approve', null],
    ['Dana Whitfield, corporate treasury', 'dana-whitfield'],
    ['Robert Miller here', 'robert-miller'],
  ])('%s → %s', (text, identity_id) => {
    const hit = extractIdentityClaim(text, MERIDIAN);
    expect(hit?.identity_id ?? null).toBe(identity_id);
  });

  // Fix (bare-name-challenge-answer, 2026-09-14): a bare name opening an utterance is NOT
  // a self-identification when that utterance is an answer to a pending question about a
  // person (challenge_issued or readback for approver, counsel, beneficiary, escrow_institution).
  // The caller responding "Marcus Obi." to "who approved this payment?" is naming an approver,
  // not identifying themselves. Explicit self-identification cues still work (e.g. "this is X").
  it('treats a bare opening name as non-self-id when answering a person challenge', () => {
    // Without answeringPersonQuestion flag: bare name opening utterance is a self-id
    expect(extractIdentityClaim('Marcus Obi.', MERIDIAN))
      .toEqual({ identity_id: 'marcus-obi', quote: 'Marcus Obi' });

    // With answeringPersonQuestion=true: bare name opening is NOT a self-id
    expect(extractIdentityClaim('Marcus Obi.', MERIDIAN, true))
      .toBeNull();

    // Even when answering a person challenge, explicit self-id cues still work
    expect(extractIdentityClaim('This is Marcus Obi.', MERIDIAN, true))
      .toEqual({ identity_id: 'marcus-obi', quote: 'Marcus Obi' });

    // "actually this is X" after a challenge still triggers identity switch
    expect(extractIdentityClaim('Actually, hold on, this is Robert Miller speaking', MERIDIAN, true))
      .toEqual({ identity_id: 'robert-miller', quote: 'Robert Miller' });
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

  // Fix round 1, finding 2: today/tonight/eod/end of day/close of business are standalone
  // (optional leading "by "); weekday names always require "by ".
  it.each([
    ['This needs to close today', 'today', 'today'],
    ["I'll wire it tonight", 'tonight', 'tonight'],
    ['it has to land by Friday', 'by friday', 'by Friday'],
    ['this is due by end of day', 'by end of day', 'by end of day'],
    ['wire this EOD, no exceptions', 'eod', 'EOD'],
    ['needs to happen close of business', 'close of business', 'close of business'],
  ])('%s → %s', (text, value, quote) => {
    const hit = extractDeadline(text);
    expect(hit).toEqual({ value, quote });
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

  // fix (P2, 2026-09-14, rehearsal report 2026-09-14T18-05-49-single-wrong-answer.md): the
  // caller named the approver AFTER "approved" ("Elena Park approved it"), not via "approved
  // by NAME" -- the only pattern that used to exist. Mirrors the reversed counsel patterns
  // just above ("X handled the deal", "X is/was our counsel").
  it('matches the reversed approver cue "<Name> approved ..." alongside "approved by <Name>"', () => {
    expect(extractCuedNames('wait, I mean Elena Park approved it')).toEqual([
      { field: 'approver', value: 'Elena Park', quote: 'Elena Park' },
    ]);
    const both = 'approved by Marcus Obie— wait, I mean Elena Park approved it.';
    expect(extractCuedNames(both)).toEqual([
      { field: 'approver', value: 'Marcus Obie', quote: 'Marcus Obie' },
      { field: 'approver', value: 'Elena Park', quote: 'Elena Park' },
    ]);
  });

  // Fix round 1, finding 1: bare "counsel <Name>" (no is/was/of record is/of record was) must
  // NOT match — only a real connector counts.
  it('does not match a bare "counsel <Name>" with no connector', () => {
    expect(extractCuedNames('the counsel Jane Doe filed a motion')).toEqual([]);
  });
  it('still matches "counsel is <Name>" with the mandatory connector', () => {
    const text = 'counsel is Calder & Finch';
    const hits = extractCuedNames(text);
    expect(hits).toEqual([{ field: 'counsel', value: 'Calder & Finch', quote: 'Calder & Finch' }]);
    expect(text.includes(hits[0]!.quote)).toBe(true);
  });

  // Fix round 1, finding 3: a name run is capped at 4 words even when more capitalized
  // words follow.
  it('caps a name run at 4 words', () => {
    const text = 'approved by Alpha Beta Gamma Delta Epsilon Zeta in the meeting';
    const hits = extractCuedNames(text);
    expect(hits).toEqual([{ field: 'approver', value: 'Alpha Beta Gamma Delta', quote: 'Alpha Beta Gamma Delta' }]);
    expect(text.includes(hits[0]!.quote)).toBe(true);
  });

  // Fix round 1, finding 4: escrow_institution "is at" / "with" phrasing, and the "will be"
  // beneficiary/vendor forms.
  it('matches escrow_institution cue variants', () => {
    const isAt = 'escrow is at First Meridian Trust';
    expect(extractCuedNames(isAt)).toEqual([
      { field: 'escrow_institution', value: 'First Meridian Trust', quote: 'First Meridian Trust' },
    ]);
    const escrowedWith = 'escrowed with First Meridian Trust';
    expect(extractCuedNames(escrowedWith)).toEqual([
      { field: 'escrow_institution', value: 'First Meridian Trust', quote: 'First Meridian Trust' },
    ]);
  });
  it('matches the "will be" beneficiary and vendor cue forms', () => {
    const beneficiary = 'the beneficiary will be Elena Park';
    expect(extractCuedNames(beneficiary)).toEqual([
      { field: 'beneficiary', value: 'Elena Park', quote: 'Elena Park' },
    ]);
    const vendor = 'the vendor will be Meridian Supply';
    expect(extractCuedNames(vendor)).toEqual([{ field: 'beneficiary', value: 'Meridian Supply', quote: 'Meridian Supply' }]);
  });

  // Fix round 2 (2026-09-14, item ii): the reversed approver cue "(NAME) approved" was
  // capturing department names like "Treasury", "Compliance", "Finance" because they match
  // the NAME pattern (capitalized words). Add a department stoplist to distinguish
  // "Elena Park approved it" (person) from "Corporate Treasury approved this" (department).
  it('keeps person names in reversed approver cue "(Name) approved"', () => {
    // Two-word person name should still match.
    expect(extractCuedNames('wait, Elena Park approved it')).toEqual([
      { field: 'approver', value: 'Elena Park', quote: 'Elena Park' },
    ]);
    // Single-word person name should match.
    expect(extractCuedNames('Marcus approved the transfer')).toEqual([
      { field: 'approver', value: 'Marcus', quote: 'Marcus' },
    ]);
  });

  it('excludes department names in reversed approver cue "(Name) approved"', () => {
    // Department names should not match the approver pattern, even though they are capitalized.
    expect(extractCuedNames('Corporate Treasury approved this')).toEqual([]);
    expect(extractCuedNames('Finance approved the wire')).toEqual([]);
    expect(extractCuedNames('Compliance approved it yesterday')).toEqual([]);
    expect(extractCuedNames('Legal Department approved')).toEqual([]);
    expect(extractCuedNames('Operations approved the request')).toEqual([]);
    expect(extractCuedNames('HR approved the transaction')).toEqual([]);
    expect(extractCuedNames('Payroll approved the check')).toEqual([]);
    expect(extractCuedNames('Audit approved this')).toEqual([]);
    expect(extractCuedNames('Risk Management approved')).toEqual([]);
    expect(extractCuedNames('Security approved the transfer')).toEqual([]);
    expect(extractCuedNames('Procurement approved')).toEqual([]);
    expect(extractCuedNames('Accounting approved the expense')).toEqual([]);
  });

  it('keeps two-word person names like "Elena Park" while excluding multi-word departments', () => {
    // Elena Park (person, two words) should match.
    expect(extractCuedNames('wait, Elena Park approved it')).toEqual([
      { field: 'approver', value: 'Elena Park', quote: 'Elena Park' },
    ]);
    // "Corporate Treasury" (department, two words) should NOT match.
    expect(extractCuedNames('Corporate Treasury approved this')).toEqual([]);
  });
});
