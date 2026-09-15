// packages/engine/test/normalize.test.ts
// The shared word-boundary lexicon matcher (fix-round-1: the old raw-substring test let
// "no" fire on "know" and "right" fire on "copyright"). Used by ledger.ts and challenges.ts.
import { describe, expect, it } from 'vitest';
import { hasLexiconHit, lexiconHit, normalizeSpokenDigits } from '../src/normalize';

describe('lexiconHit', () => {
  it('does not fire on a lexicon word embedded inside a longer word', () => {
    expect(lexiconHit("I know that's correct", ['no', 'not'])).toBeNull();
  });

  it('matches a whole-word hit and returns the matched phrase', () => {
    expect(lexiconHit("no, that's wrong", ['no', 'not', 'wrong'])).toBe('no');
  });

  it('matches a multi-word phrase, apostrophe intact on both sides', () => {
    expect(lexiconHit("that's right", ["that's right", 'right'])).toBeTruthy();
  });

  it('does not fire on a lexicon word embedded inside a longer word (copyright/right)', () => {
    expect(lexiconHit('copyright', ['right'])).toBeNull();
  });

  it('normalizes both sides before matching, so "&" matches a spelled-out "and"', () => {
    expect(lexiconHit('Calder & Finch', ['calder and finch'])).toBe('calder and finch');
  });

  it('returns null when nothing in the lexicon matches', () => {
    expect(lexiconHit('everything is fine here', ['no', 'not', 'wrong'])).toBeNull();
  });
});

describe('hasLexiconHit', () => {
  it('is true exactly when lexiconHit is non-null', () => {
    expect(hasLexiconHit("no, that's wrong", ['no'])).toBe(true);
    expect(hasLexiconHit('copyright', ['right'])).toBe(false);
  });
});

// FIX (2026-09-16, terse-answers lane, finding 1): account/phone-style digit readbacks
// spoken as compound number words, not literal digits or single spelled digits.
describe('normalizeSpokenDigits', () => {
  it('converts a compound tens+ones reading ("eighty-eight thirty") to the concatenated digit string', () => {
    expect(normalizeSpokenDigits('Eighty-eight, thirty.')).toBe('8830.');
  });

  it('converts individually spelled-out single digits ("eight eight three zero")', () => {
    expect(normalizeSpokenDigits('eight eight three zero')).toBe('8830');
  });

  it('converts a "double X" doubled-digit reading ("double eight three oh")', () => {
    expect(normalizeSpokenDigits('double eight three oh')).toBe('8830');
  });

  it('converts a Meridian-style account number ("forty-four seventy-one" -> 4471)', () => {
    expect(normalizeSpokenDigits('forty-four seventy-one')).toBe('4471');
  });

  it('converts a doubled reading of the same account number ("double four seven one" -> 4471)', () => {
    expect(normalizeSpokenDigits('double four seven one')).toBe('4471');
  });

  it('leaves ordinary prose with no digit-shaped words completely untouched', () => {
    expect(normalizeSpokenDigits('the final figure moved this morning')).toBe('the final figure moved this morning');
  });

  it('leaves bare numerals untouched (already digits)', () => {
    expect(normalizeSpokenDigits('account ending 4471')).toBe('account ending 4471');
  });

  it('only converts the digit-shaped run, leaving surrounding prose intact', () => {
    expect(normalizeSpokenDigits('it ends in eighty-eight thirty, I think')).toBe('it ends in 8830, I think');
  });

  it('does not treat a lone tens word with no trailing ones as a two-digit answer signal by itself (still converts to its own value)', () => {
    // "thirty" alone -> "30": a real value, but callers should note isAnswerShapedFor's
    // account_last4 signal still requires >=2 resulting digits, which a bare "30" satisfies.
    expect(normalizeSpokenDigits('thirty')).toBe('30');
  });

  it('a bare compound reading with no punctuation still converts ("eighty-eight thirty" -> 8830)', () => {
    expect(normalizeSpokenDigits('eighty-eight thirty')).toBe('8830');
  });
});

// CRITICAL FIX (2026-09-16, name-tokens lane, Sonnet review of 6a81b98): the previous
// version let a run continue across ANY gap, including punctuation, an existing digit
// sequence, or a currency sign -- so "84 471" became "84471", "Forty-four. Seventy-one."
// became "4471.", "forty-four seventy-one dollars" became "4471 dollars", and "$84,500"
// became "$84500". Each of those merges is wrong for a different reason (see the function's
// own doc comment); this describe block pins the corrected behavior for each exact case.
describe('normalizeSpokenDigits — CRITICAL (Sonnet review of 6a81b98, 2026-09-16): must not merge across an existing digit sequence, punctuation, or an amount suffix', () => {
  it('never touches a string that already contains digits -- two separate existing digit groups must not merge ("84 471")', () => {
    expect(normalizeSpokenDigits('84 471')).toBe('84 471');
  });

  it('never touches a string that already contains a currency sign ("$84,500")', () => {
    expect(normalizeSpokenDigits('$84,500')).toBe('$84,500');
  });

  it('a "." sentence boundary breaks the run -- two separate sentences must not merge ("Forty-four. Seventy-one." -> "44. 71.", not "4471.")', () => {
    expect(normalizeSpokenDigits('Forty-four. Seventy-one.')).toBe('44. 71.');
  });

  it('a run followed by "dollars" is an amount, not account digits -- left completely unconverted ("forty-four seventy-one dollars")', () => {
    expect(normalizeSpokenDigits('forty-four seventy-one dollars')).toBe('forty-four seventy-one dollars');
  });

  it('a run followed by "dollar" (singular) is also left unconverted', () => {
    expect(normalizeSpokenDigits('twenty dollar bill')).toBe('twenty dollar bill');
  });

  it('a run followed by "bucks" is also left unconverted', () => {
    expect(normalizeSpokenDigits('forty five bucks')).toBe('forty five bucks');
  });

  it('a comma pause within one continuous reading still merges (distinct from a sentence-ending period) -- "forty-four, seventy-one" -> "4471"', () => {
    expect(normalizeSpokenDigits('forty-four, seventy-one')).toBe('4471');
  });
});
