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

// Founder-law item 2 (2026-09-09): the flagship corpus recording's title used an em-dash --
// caught only because the founder happened to read that one file. Every corpus file's
// `title`/`description` reaches a real screen too: `/api/replay` (packages/server/src/http.ts)
// copies `title` verbatim into the recording label Replay.tsx renders in its dropdown, so an
// em-dash there is exactly as user-visible as one in a .tsx file -- this guard now covers both.
const CORPUS_DIR = resolve(__dirname, '../../engine/corpus');

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

// Founder-law item 2: corpus `title`/`description` fields, scanned directly (no comment
// stripping -- JSON has no comments) since both reach the screen verbatim: `title` via the
// Replay dropdown label (see comment above), `description` via the same corpus record if a
// future screen ever surfaces it. Recording bodies (`conversation`/`tools`/`actions`) are
// untouched by this scan -- verbatim caller/agent lines are LAW 4 evidence text, not the
// founder's own copy, and the styling law does not reach into them.
describe('no em-dashes in corpus title/description (reaches the screen via the replay list)', () => {
  const corpusFiles = readdirSync(CORPUS_DIR)
    .filter((name) => extname(name) === '.json')
    .map((name) => join(CORPUS_DIR, name));

  it('found corpus files to scan (this test would be a false pass otherwise)', () => {
    expect(corpusFiles.length).toBeGreaterThan(0);
  });

  for (const file of corpusFiles) {
    const relative = file.replace(resolve(CORPUS_DIR, '..') + '/', '');
    it(`${relative}: title has no em-dash (U+2014)`, () => {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { title?: unknown };
      expect(typeof parsed.title).toBe('string');
      expect((parsed.title as string).includes(EM_DASH)).toBe(false);
    });

    it(`${relative}: description has no em-dash (U+2014)`, () => {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { description?: unknown };
      expect(typeof parsed.description).toBe('string');
      expect((parsed.description as string).includes(EM_DASH)).toBe(false);
    });
  }
});
