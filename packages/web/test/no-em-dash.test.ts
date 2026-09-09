// packages/web/test/no-em-dash.test.ts
// Founder style law (CLAUDE.md, user-level): no em-dashes (U+2014) anywhere in the founder's
// voice, and the shipped interface copy was full of them. This scans the REAL source files
// under src/components and src/screens (the only two directories that render user-visible
// copy) and fails if a U+2014 shows up outside a comment -- so it can never creep back in a
// future edit. Comments (`// ...` and `/* ... */`) are stripped first: code comments are
// exempt by the same ruling ("leave code comments... alone"), and this is a source-text scan,
// not a parser, so stripping comments before scanning is the only way to avoid flagging this
// file's own explanatory prose above.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCAN_DIRS = ['../src/components', '../src/screens'].map((d) => resolve(__dirname, d));

const EM_DASH = '—';

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (entry.isFile() && ['.ts', '.tsx'].includes(extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

// Strips `/* block */` and `// line` comments. Deliberately simple (string scan, not a real
// tokenizer) per the ruling's own instruction to keep this test simple -- good enough to
// exempt this file's own header comment and every inline explanatory comment in the scanned
// files, which is all it needs to do.
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('no em-dashes in user-visible copy', () => {
  const files = SCAN_DIRS.flatMap(listSourceFiles);

  it('found source files to scan (this test would be a false pass otherwise)', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const relative = file.replace(resolve(__dirname, '..') + '/', '');
    it(`${relative} has no em-dash (U+2014) outside a comment`, () => {
      const withoutComments = stripComments(readFileSync(file, 'utf8'));
      expect(withoutComments.includes(EM_DASH)).toBe(false);
    });
  }
});
