import { describe, it, expect } from 'vitest';
import {
  transcriptMatchesCloseSentence,
  ENGINE_CLOSE_SENTENCES,
  DISTINGUISHING_CLAUSE_BY_VERDICT,
} from '../src/call/closeMatch.js';

// reply.create fix, round 3 (2026-09-13): unit tests for the matcher that decides whether a
// reply's accumulated transcript.agent text actually said the CLOSE sentence, per
// docs/ASSEMBLYAI_INTEGRATION.md's "close is transcript-confirmed" note. See
// closeMatch.ts's own doc comment for the PROVEN live failure this replaces.
describe('transcriptMatchesCloseSentence', () => {
  const freeze = ENGINE_CLOSE_SENTENCES.FREEZE;

  it('matches an exact transcript', () => {
    expect(transcriptMatchesCloseSentence(freeze, freeze)).toBe(true);
  });

  it('matches a lowercased transcript', () => {
    expect(transcriptMatchesCloseSentence(freeze.toLowerCase(), freeze)).toBe(true);
  });

  it('matches when the trailing period is missing', () => {
    expect(transcriptMatchesCloseSentence(freeze.slice(0, -1), freeze)).toBe(true);
  });

  it('matches the "Good bye" (two-word) STT spelling variant', () => {
    expect(transcriptMatchesCloseSentence(freeze.replace('Goodbye', 'Good bye'), freeze)).toBe(true);
  });

  it('matches the distinguishing (first) clause verbatim plus a REWORDED second clause, plus "goodbye" (leniency preserved)', () => {
    // Founder ruling 2026-09-16: STAGE and FREEZE now share their final clause ("The payment
    // is not released"), so that shared clause can no longer be what proves which verdict was
    // spoken -- only FREEZE's own first clause can. A live model rewording the shared clause
    // must still match as long as the distinguishing clause and "goodbye" are both present.
    expect(
      transcriptMatchesCloseSentence(
        'This transfer is frozen and an incident is open. Nothing further will move on this account. Goodbye.',
        freeze,
      ),
    ).toBe(true);
  });

  it('does not match unrelated speech', () => {
    expect(transcriptMatchesCloseSentence('Please hold for a moment.', freeze)).toBe(false);
  });

  it('does not match "goodbye" alone, without the distinguishing clause', () => {
    expect(transcriptMatchesCloseSentence('Goodbye.', freeze)).toBe(false);
  });

  it('does not match the shared "payment is not released" clause alone, without "goodbye" or the distinguishing clause', () => {
    expect(transcriptMatchesCloseSentence('The payment is not released.', freeze)).toBe(false);
  });

  it('does not match an empty transcript', () => {
    expect(transcriptMatchesCloseSentence('', freeze)).toBe(false);
  });

  it('matches every one of the four engine close sentences against itself', () => {
    for (const sentence of Object.values(ENGINE_CLOSE_SENTENCES)) {
      expect(transcriptMatchesCloseSentence(sentence, sentence)).toBe(true);
    }
  });

  it('does not cross-match a different verdict\'s close sentence (STAGE never matches FREEZE and vice versa)', () => {
    expect(transcriptMatchesCloseSentence(ENGINE_CLOSE_SENTENCES.STAGE, ENGINE_CLOSE_SENTENCES.FREEZE)).toBe(false);
    expect(transcriptMatchesCloseSentence(ENGINE_CLOSE_SENTENCES.FREEZE, ENGINE_CLOSE_SENTENCES.STAGE)).toBe(false);
  });

  it('does not cross-match via the lenient fallback either: FREEZE\'s distinguishing clause plus "goodbye" never satisfies STAGE\'s sentence', () => {
    expect(
      transcriptMatchesCloseSentence(
        'This transfer is frozen and an incident is open. The payment is not released. Goodbye.',
        ENGINE_CLOSE_SENTENCES.STAGE,
      ),
    ).toBe(false);
  });

  it('does NOT match a garbled duplicated transcript where words are doubled and interleaved (known limit: distinguishing clause is not contiguous)', () => {
    // PROVEN gap (live STT artifact 2026-09-16): words doubled and interleaved, e.g.
    // "ThisThis transfer transfer is is frozen frozen and an incident is open. The payment is
    // not released. Goodbye." -- the distinguishing clause "this transfer is frozen and an
    // incident is open" is no longer contiguous after normalization, so the fallback does not
    // match. This is a known limit of the current matcher design.
    expect(
      transcriptMatchesCloseSentence(
        'ThisThis transfer transfer is is frozen frozen and an incident is open. The payment is not released. Goodbye.',
        freeze,
      ),
    ).toBe(false);
  });
});

describe('DISTINGUISHING_CLAUSE_BY_VERDICT', () => {
  it('gives every verdict a clause that is unique across all four verdicts', () => {
    const values = Object.values(DISTINGUISHING_CLAUSE_BY_VERDICT);
    expect(new Set(values).size).toBe(values.length);
  });

  it('is present, non-empty, for every verdict in ENGINE_CLOSE_SENTENCES', () => {
    for (const verdict of Object.keys(ENGINE_CLOSE_SENTENCES) as Array<keyof typeof ENGINE_CLOSE_SENTENCES>) {
      expect(DISTINGUISHING_CLAUSE_BY_VERDICT[verdict].length).toBeGreaterThan(0);
    }
  });
});
