// packages/web/test/agent-states-layout.test.ts
// Task W7, item 3: `.agent-states` (styles.css) is the state-tab strip (LISTENING / SPEAKING
// / VERIFYING / AWAITING OUT-OF-BAND / VERDICT) in the transcript board's left column. At
// phone width (<=420px) the five pills overflow the strip's right edge by ~10px -- each pill
// insists on an equal `flex: 1 1 0` share regardless of its own text width. jsdom has no
// layout engine (BRIEF: real render-test only, never invented data -- here that means reading
// the REAL styles.css rather than asserting pixel numbers jsdom cannot actually produce), same
// approach as test/checks-row-layout.test.ts: read the real CSS and assert the mechanism
// directly -- a media query at (or narrower than) 420px gives `.agent-states` either
// `overflow-x: auto` or `flex-wrap: wrap`, so the strip wraps or scrolls inside its own
// container instead of overflowing it.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CSS_PATH = resolve(__dirname, '../src/styles.css');
const css = readFileSync(CSS_PATH, 'utf-8');

/** Every `@media (max-width: Npx)` block whose N is <= the given breakpoint -- a phone-width
 *  fix could reasonably land at 420px, 400px, 390px, etc.; what matters is that SOME media
 *  query at or below the phone breakpoint carries the fix, not one exact number. */
function maxWidthMediaBlocksAtOrBelow(breakpointPx: number): string[] {
  const blocks: string[] = [];
  for (const match of css.matchAll(/@media \(max-width:\s*(\d+)px\)\s*\{/g)) {
    const width = Number(match[1]);
    if (Number.isNaN(width) || width > breakpointPx) continue;
    const start = (match.index ?? 0) + match[0].length;
    // Balance braces so a nested rule's own `}` doesn't end the block early.
    let depth = 1;
    let i = start;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
      i++;
    }
    blocks.push(css.slice(start, i - 1));
  }
  return blocks;
}

function ruleBodiesFor(selector: string, within: string): string[] {
  const bodies: string[] = [];
  const pattern = new RegExp(`(?:^|[\\s{};])${selector.replace('.', '\\.')}\\s*\\{`, 'g');
  for (const match of within.matchAll(pattern)) {
    const start = (match.index ?? 0) + match[0].length;
    const end = within.indexOf('}', start);
    if (end !== -1) bodies.push(within.slice(start, end));
  }
  return bodies;
}

describe('agent-states phone-width layout (styles.css, parsed directly -- no jsdom layout)', () => {
  it('finds the .agent-states rule at least once', () => {
    expect(css).toMatch(/\.agent-states\s*\{/);
  });

  it('some media query at or below 420px gives .agent-states either overflow-x: auto or flex-wrap: wrap', () => {
    const phoneBlocks = maxWidthMediaBlocksAtOrBelow(420);
    expect(phoneBlocks.length, 'no @media (max-width: <=420px) block found').toBeGreaterThan(0);

    const agentStatesBodies = phoneBlocks.flatMap((block) => ruleBodiesFor('.agent-states', block));
    expect(agentStatesBodies.length, '.agent-states has no rule inside a <=420px media query').toBeGreaterThan(0);

    const hasFix = agentStatesBodies.some(
      (body) => /overflow-x:\s*auto/.test(body) || /flex-wrap:\s*wrap/.test(body),
    );
    expect(hasFix, '.agent-states media-query rule has neither overflow-x: auto nor flex-wrap: wrap').toBe(true);
  });
});
