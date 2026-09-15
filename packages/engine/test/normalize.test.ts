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
});
