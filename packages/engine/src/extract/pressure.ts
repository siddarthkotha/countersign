// packages/engine/src/extract/pressure.ts
// Verbatim pressure-lexicon hits. Behavioral only — no claim about voice authenticity.

export interface PressureHit {
  phrase: string;
  quote: string;
}

/** For each lexicon phrase (in lexicon order), a case-insensitive first-match hit against
 *  `text`, with `quote` sliced verbatim from the original string. */
export function extractPressure(text: string, lexicon: string[]): PressureHit[] {
  const lowerText = text.toLowerCase();
  const hits: PressureHit[] = [];
  for (const phrase of lexicon) {
    const idx = lowerText.indexOf(phrase.toLowerCase());
    if (idx === -1) continue;
    hits.push({ phrase, quote: text.slice(idx, idx + phrase.length) });
  }
  return hits;
}
