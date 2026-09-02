// packages/engine/src/extract/outOfScope.ts
// Detects the honest-judge / off-script utterance so the FSM can route to an
// OUT_OF_SCOPE state instead of deadlocking. No claim about voice authenticity.

/** First case-insensitive lexicon hit against `text`, quote sliced verbatim. */
export function extractOutOfScope(text: string, lexicon: string[]): { quote: string } | null {
  const lowerText = text.toLowerCase();
  for (const phrase of lexicon) {
    const idx = lowerText.indexOf(phrase.toLowerCase());
    if (idx !== -1) {
      return { quote: text.slice(idx, idx + phrase.length) };
    }
  }
  return null;
}
