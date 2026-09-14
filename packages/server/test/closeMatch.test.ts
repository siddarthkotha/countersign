import { describe, it, expect } from 'vitest';
import { transcriptMatchesCloseSentence, ENGINE_CLOSE_SENTENCES } from '../src/call/closeMatch.js';

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

  it('matches on the content clause plus "goodbye" alone, without the opening clause (partial/tail-clause match)', () => {
    expect(transcriptMatchesCloseSentence('Nothing has moved. Goodbye.', freeze)).toBe(true);
  });

  it('does not match unrelated speech', () => {
    expect(transcriptMatchesCloseSentence('Please hold for a moment.', freeze)).toBe(false);
  });

  it('does not match "goodbye" alone, without the content clause', () => {
    expect(transcriptMatchesCloseSentence('Goodbye.', freeze)).toBe(false);
  });

  it('does not match the content clause alone, without "goodbye"', () => {
    expect(transcriptMatchesCloseSentence('Nothing has moved.', freeze)).toBe(false);
  });

  it('does not match an empty transcript', () => {
    expect(transcriptMatchesCloseSentence('', freeze)).toBe(false);
  });

  it('matches every one of the four engine close sentences against itself', () => {
    for (const sentence of Object.values(ENGINE_CLOSE_SENTENCES)) {
      expect(transcriptMatchesCloseSentence(sentence, sentence)).toBe(true);
    }
  });

  it('does not cross-match a different verdict\'s close sentence', () => {
    expect(transcriptMatchesCloseSentence(ENGINE_CLOSE_SENTENCES.STAGE, ENGINE_CLOSE_SENTENCES.FREEZE)).toBe(false);
  });
});
