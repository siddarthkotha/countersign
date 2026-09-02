// packages/web/test/contrast.test.ts
// Task W5, requirement D: every foreground/background pairing declared in styles.css's
// `:root` custom properties and actually used for text must clear WCAG 2.1 4.5:1 (>=3:1 for
// text >=24px -- none of ours relies on that carve-out, so 4.5:1 is the bar for every pair
// below). This test reads the REAL styles.css from disk, parses the hex values straight out
// of the one `:root` block, and computes relative luminance + contrast itself (no library,
// per the brief) -- it fails if anyone lowers a pairing below threshold, whether by editing
// the hex value or by wiring a new low-contrast pair into the CSS.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CSS_PATH = resolve(__dirname, '../src/styles.css');

const MIN_CONTRAST_NORMAL_TEXT = 4.5;

function parseRootCustomProperties(css: string): Record<string, string> {
  const rootMatch = css.match(/:root\s*\{([^}]*)\}/);
  if (!rootMatch) throw new Error('contrast.test.ts: no :root block found in styles.css');
  const body = rootMatch[1] ?? '';
  const props: Record<string, string> = {};
  // Matches each `--name: value;` declaration directly, wherever it sits in the block --
  // robust against the block's own explanatory comments (which never match `--name:`), so a
  // comment with no trailing semicolon can never swallow the declaration after it.
  const declarationPattern = /(--[\w-]+)\s*:\s*([^;]+);/g;
  for (const match of body.matchAll(declarationPattern)) {
    const [, name, value] = match;
    if (name && value) props[name] = value.trim();
  }
  return props;
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  if (clean.length !== 6) throw new Error(`contrast.test.ts: expected a 6-digit hex colour, got "${hex}"`);
  return [parseInt(clean.slice(0, 2), 16), parseInt(clean.slice(2, 4), 16), parseInt(clean.slice(4, 6), 16)];
}

// WCAG 2.x relative luminance: linearize each sRGB channel, then weight and sum.
function srgbChannelToLinear(c: number): number {
  const normalized = c / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4);
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * srgbChannelToLinear(r) + 0.7152 * srgbChannelToLinear(g) + 0.0722 * srgbChannelToLinear(b);
}

// WCAG 2.x contrast ratio: (lighter + 0.05) / (darker + 0.05).
function contrastRatio(hexA: string, hexB: string): number {
  const lumA = relativeLuminance(hexToRgb(hexA));
  const lumB = relativeLuminance(hexToRgb(hexB));
  const lighter = Math.max(lumA, lumB);
  const darker = Math.min(lumA, lumB);
  return (lighter + 0.05) / (darker + 0.05);
}

const css = readFileSync(CSS_PATH, 'utf-8');
const root = parseRootCustomProperties(css);

// Every text colour token, over every background token it is actually painted on in
// styles.css: --cs-fg, --cs-muted and --cs-accent all appear as text on both --cs-bg (the
// call/replay/landing surface) and --cs-panel (the board and verdict-banner surface).
const TEXT_TOKENS = ['--cs-fg', '--cs-muted', '--cs-accent'] as const;
const BACKGROUND_TOKENS = ['--cs-bg', '--cs-panel'] as const;

describe('contrast (styles.css :root palette)', () => {
  it('parses a non-empty :root block with every token this test needs', () => {
    for (const token of [...TEXT_TOKENS, ...BACKGROUND_TOKENS]) {
      expect(root[token], `missing custom property ${token} in styles.css :root`).toBeDefined();
    }
  });

  for (const textToken of TEXT_TOKENS) {
    for (const bgToken of BACKGROUND_TOKENS) {
      it(`${textToken} on ${bgToken} meets ${MIN_CONTRAST_NORMAL_TEXT}:1`, () => {
        const ratio = contrastRatio(root[textToken]!, root[bgToken]!);
        expect(ratio).toBeGreaterThanOrEqual(MIN_CONTRAST_NORMAL_TEXT);
      });
    }
  }

  // Task W5 requirement A/D: black-on-accent -- the primary button (button.primary uses
  // color:#000000 on background:var(--cs-accent) in styles.css) is the one text pairing that
  // does not use a :root token as its own background is the accent colour; #000000 is exact
  // and needs no token lookup.
  it('#000000 on --cs-accent (the primary button) meets 4.5:1', () => {
    const ratio = contrastRatio('#000000', root['--cs-accent']!);
    expect(ratio).toBeGreaterThanOrEqual(MIN_CONTRAST_NORMAL_TEXT);
  });
});
