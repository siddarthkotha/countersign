// packages/engine/src/extract/spokenNumbers.ts
// Spoken-word number parsing ("two point one million", "eighty four thousand five hundred").
// Used only by amounts.ts to recognize money phrases in a transcript; never asserts
// anything about voice authenticity.

const ONES: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const SCALES: Record<string, number> = { hundred: 100, thousand: 1000, million: 1_000_000 };

interface Token {
  word: string;
  start: number;
  end: number;
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const re = /[A-Za-z]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    tokens.push({ word: m[0].toLowerCase(), start: m.index, end: m.index + m[0].length });
  }
  return tokens;
}

/** Walks a run of consecutive number-words starting at token index `i` using a standard
 *  total/current accumulator: ones and tens add into `current`; "hundred" scales `current`;
 *  "thousand"/"million" fold `current` (or 1, if bare) into `total` at that scale. */
function parseIntegerRun(words: string[], i: number): { value: number; end: number; hasScale: boolean } | null {
  let total = 0;
  let current = 0;
  let count = 0;
  let hasScale = false;
  let j = i;
  while (j < words.length) {
    const w = words[j]!;
    if (w in ONES) {
      current += ONES[w]!;
      j++;
      count++;
      continue;
    }
    if (w in TENS) {
      current += TENS[w]!;
      j++;
      count++;
      continue;
    }
    if (w === 'hundred') {
      current = (current === 0 ? 1 : current) * 100;
      j++;
      count++;
      continue;
    }
    if (w === 'thousand' || w === 'million') {
      total += (current === 0 ? 1 : current) * SCALES[w]!;
      current = 0;
      hasScale = true;
      j++;
      count++;
      continue;
    }
    break;
  }
  if (count === 0) return null;
  return { value: total + current, end: j, hasScale };
}

export interface SpokenAmountHit {
  value_usd: number;
  start: number;
  end: number; // exclusive char index; a trailing "dollars" word is NOT included
}

/** Scans `text` word-by-word for spoken money amounts. A run is accepted only when it
 *  contains a scale word (thousand/million) — including one introduced by a "point"
 *  fraction, e.g. "two point one million" — or is immediately followed by "dollars". */
export function extractSpokenAmounts(text: string): SpokenAmountHit[] {
  const tokens = tokenize(text);
  const words = tokens.map((t) => t.word);
  const hits: SpokenAmountHit[] = [];
  let i = 0;
  while (i < words.length) {
    const run = parseIntegerRun(words, i);
    if (!run) {
      i++;
      continue;
    }
    let value = run.value;
    let hasScale = run.hasScale;
    let end = run.end;

    if (words[end] === 'point') {
      let j = end + 1;
      let fractionDigits = '';
      while (j < words.length) {
        const w = words[j]!;
        if (w in ONES && ONES[w]! < 10) {
          fractionDigits += String(ONES[w]);
          j++;
          continue;
        }
        break;
      }
      if (fractionDigits.length > 0) {
        value = value + Number(`0.${fractionDigits}`);
        end = j;
        const scaleWord = words[end];
        if (scaleWord === 'thousand' || scaleWord === 'million') {
          value = value * SCALES[scaleWord]!;
          hasScale = true;
          end = end + 1;
        }
      }
    }

    const followedByDollars = words[end] === 'dollars' || words[end] === 'dollar';
    if (hasScale || followedByDollars) {
      hits.push({ value_usd: Math.round(value), start: tokens[i]!.start, end: tokens[end - 1]!.end });
      i = end;
    } else {
      i++;
    }
  }
  return hits;
}
