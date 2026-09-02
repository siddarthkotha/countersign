// packages/web/test/checks-row-layout.test.ts
// Task W5, fix round 3, item 7: `.checks-row` (styles.css) used to lay its four columns out
// with `flex: none; width: 9rem` / `width: 5rem` -- fixed pixel-equivalent widths that cannot
// shrink, so on a phone-width viewport (~375-600px) the row overflows horizontally. The fix
// is a CSS grid with `minmax()` columns instead, which CAN shrink, plus a <600px media query
// that lets the detail column wrap onto its own row. jsdom has no layout engine, so this
// can't be proven by rendering and measuring pixels (BRIEF: real render-test only, never
// invented data -- here that means reading the REAL styles.css rather than asserting numbers
// jsdom cannot actually produce); instead this test reads the real CSS and asserts the
// mechanism directly: no `.checks-row`/`.checks-label`/`.checks-status`/`.checks-detail` rule
// (top-level or inside the <600px media query) declares a bare fixed `width`, and the grid
// template does use `minmax(`. It fails if a fixed width creeps back in.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CSS_PATH = resolve(__dirname, '../src/styles.css');
const css = readFileSync(CSS_PATH, 'utf-8');

/** Every declaration block for a given selector, wherever it appears (top-level or nested
 *  inside a `@media` block) -- a small brace-matching scan rather than a single regex, since
 *  the same selector can legitimately appear more than once (a base rule plus a narrower
 *  override inside a media query). */
function ruleBodiesFor(selector: string): string[] {
  const bodies: string[] = [];
  const pattern = new RegExp(`(?:^|[\\s{};])${selector.replace('.', '\\.')}\\s*\\{`, 'g');
  for (const match of css.matchAll(pattern)) {
    const start = (match.index ?? 0) + match[0].length;
    const end = css.indexOf('}', start);
    if (end !== -1) bodies.push(css.slice(start, end));
  }
  return bodies;
}

describe('checks-row responsive layout (styles.css, parsed directly -- no jsdom layout)', () => {
  it('finds the .checks-row rule at least once', () => {
    expect(ruleBodiesFor('.checks-row').length).toBeGreaterThan(0);
  });

  it('.checks-row uses a minmax() grid template, not fixed-width flex columns', () => {
    const bodies = ruleBodiesFor('.checks-row');
    const base = bodies[0]!;
    expect(base).toMatch(/display:\s*grid/);
    expect(base).toMatch(/grid-template-columns:.*minmax\(/);
  });

  it('no .checks-row / .checks-label / .checks-status / .checks-detail rule declares a bare fixed width, anywhere in the file (base rule or the <600px media override)', () => {
    // A bare `width: <number><unit>;` declaration -- `grid-template-columns` is a DIFFERENT
    // property name (the substring "width:" never occurs in it), so it never false-matches
    // here even though its `minmax(6rem, 9rem)` values contain rem numbers.
    const fixedWidthPattern = /\bwidth:\s*\d/;
    for (const selector of ['.checks-row', '.checks-label', '.checks-status', '.checks-detail']) {
      for (const body of ruleBodiesFor(selector)) {
        expect(body).not.toMatch(fixedWidthPattern);
      }
    }
  });

  it('the <600px media query lets the detail column span the full row width (wraps onto its own row) instead of forcing horizontal overflow', () => {
    const mediaMatch = css.match(/@media \(max-width:\s*600px\)\s*\{([\s\S]*?)\n\}\n/);
    expect(mediaMatch, 'no <600px media query found for .checks-row').not.toBeNull();
    const mediaBlock = mediaMatch![1]!;
    expect(mediaBlock).toMatch(/\.checks-row\s*\{[^}]*grid-template-columns/);
    expect(mediaBlock).toMatch(/\.checks-detail\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/);
  });
});
