// packages/engine/src/util.ts
// Small formatting/text helpers shared across extractors, evidence builders and the FSM.
// No runtime dependencies; no claim about voice authenticity anywhere in this file.

/** Formats a USD amount as "$1,800,000" (en-US grouping, no decimals implied). Used
 *  wherever an amount is phrased back to the caller or into an evidence card's detail. */
export function money(n: number): string {
  return `$${n.toLocaleString('en-US')}`;
}

/** Escapes every regex-special character in `s` so it can be dropped into a `new RegExp`
 *  template literally (e.g. a caller-stated name or lexicon phrase that may itself contain
 *  characters like "." or "&"). */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
