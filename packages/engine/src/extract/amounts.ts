// packages/engine/src/extract/amounts.ts
// Extracts dollar-amount mentions (numeric or spoken) with verbatim quotes. Plain
// transcript parsing — no claim about voice authenticity.
import { extractSpokenAmounts } from './spokenNumbers';

export interface AmountHit {
  value_usd: number;
  quote: string;
}

const SCALE_MULT: Record<string, number> = { million: 1_000_000, m: 1_000_000, thousand: 1000, k: 1000 };

interface RawHit {
  start: number;
  end: number;
  value_usd: number;
}

// $?<amount>(.<decimals>)?<scale>? — accepted only when preceded by $, followed by a scale
// word/M/K, or followed within a few words by "dollars".
const NUMERIC_RE = /\$?\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*(million|m|thousand|k)?\b/gi;

function wordsWithin(text: string, from: number, count: number): string[] {
  const rest = text.slice(from, from + 60);
  const words = rest.toLowerCase().match(/[a-z]+/g) ?? [];
  return words.slice(0, count);
}

function extractNumericAmounts(text: string): RawHit[] {
  const hits: RawHit[] = [];
  for (const m of text.matchAll(NUMERIC_RE)) {
    const full = m[0];
    const digits = m[1]!;
    const decimals = m[2];
    const scaleWord = m[3]?.toLowerCase();
    const start = m.index!;
    const end = start + full.length;

    const precededByDollar = full.startsWith('$');
    const hasScale = scaleWord !== undefined && scaleWord.length > 0;
    const followedByDollars = hasScale ? false : wordsWithin(text, end, 3).includes('dollars');
    if (!precededByDollar && !hasScale && !followedByDollars) continue;

    let value = Number(digits.replace(/,/g, ''));
    if (decimals) value = Number(`${value}.${decimals}`);
    if (hasScale) value = value * (SCALE_MULT[scaleWord!] ?? 1);

    // Rounded to the nearest whole dollar (absorbs float error from decimal*scale, e.g.
    // 1.8*1_000_000); sub-dollar cent precision is not preserved.
    hits.push({ start, end, value_usd: Math.round(value) });
  }
  return hits;
}

/** Returns dollar-amount hits in text order, numeric and spoken forms merged. */
export function extractAmounts(text: string): AmountHit[] {
  const numeric = extractNumericAmounts(text);
  const spoken = extractSpokenAmounts(text).map((h) => ({ start: h.start, end: h.end, value_usd: h.value_usd }));
  const all = [...numeric, ...spoken].sort((a, b) => a.start - b.start);
  return all.map((h) => ({ value_usd: h.value_usd, quote: text.slice(h.start, h.end).trim() }));
}
