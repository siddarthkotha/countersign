// packages/engine/test/normalize.test.ts
// The shared word-boundary lexicon matcher (fix-round-1: the old raw-substring test let
// "no" fire on "know" and "right" fire on "copyright"). Used by ledger.ts and challenges.ts.
import { describe, expect, it } from 'vitest';
import { hasLexiconHit, lexiconHit } from '../src/normalize';

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
