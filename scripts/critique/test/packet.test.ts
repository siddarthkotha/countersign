// scripts/critique/test/packet.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assemblePacket, buildPacket, buildSections, extractBriefSections, redactSecrets } from '../packet.js';
import type { PacketSection } from '../types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');

const FAKE_SECTIONS: PacketSection[] = [
  { id: 'a', label: 'Section A', content: 'x'.repeat(100) },
  { id: 'b', label: 'Section B', content: 'y'.repeat(100) },
  { id: 'c', label: 'Section C', content: 'z'.repeat(100) },
];

describe('assemblePacket priority order and cap', () => {
  it('includes every section in full when the cap is generous', () => {
    const packet = assemblePacket(FAKE_SECTIONS, 10_000);
    expect(packet.included).toEqual(['a', 'b', 'c']);
    expect(packet.truncated).toEqual([]);
    expect(packet.text).toContain('x'.repeat(100));
    expect(packet.text).toContain('y'.repeat(100));
    expect(packet.text).toContain('z'.repeat(100));
    expect(packet.cut_note).toMatch(/Nothing cut/);
  });

  it('respects deterministic priority order: earlier sections win the budget', () => {
    // Section "a" (28-char header + 100 chars) fits fully; "b"'s header pushes past 170,
    // leaving only a partial budget for its content; "c" never gets a header at all.
    const packet = assemblePacket(FAKE_SECTIONS, 170);
    expect(packet.included).toEqual(['a']);
    expect(packet.truncated[0]).toBe('b');
    expect(packet.truncated).toContain('c');
    expect(packet.text).not.toContain('z'.repeat(100));
  });

  it('truncates the crossing section instead of skipping it outright, and notes the cut', () => {
    const packet = assemblePacket(FAKE_SECTIONS, 170);
    expect(packet.text).toMatch(/TRUNCATED/);
    expect(packet.cut_note).toMatch(/Cap reached/);
    expect(packet.cut_note).toContain('b');
  });

  it('bounds overflow past the cap to the truncation-marker and summary overhead only', () => {
    const packet = assemblePacket(FAKE_SECTIONS, 200);
    // Body content (everything before the PACKET NOTE marker) must stay within a small,
    // bounded overhead of the cap -- the inline "...[TRUNCATED]" marker text, not unbounded
    // growth (see packet.ts's assemblePacket doc comment).
    const bodyLen = packet.text.split('===== PACKET NOTE =====')[0]!.length;
    expect(bodyLen).toBeLessThanOrEqual(200 + 150);
  });
});

describe('extractBriefSections', () => {
  const fixture = [
    '## 1. FIRST',
    'first body line',
    '',
    '## 3. THIRD',
    'third body line',
    'more third',
    '',
    '## 4. FOURTH',
    'fourth body',
    '',
    '## 12. TWELFTH',
    'twelfth body',
  ].join('\n');

  it('extracts only the requested numbered sections, each up to the next numbered heading', () => {
    const out = extractBriefSections(fixture, [3, 4, 12]);
    expect([...out.keys()].sort((a, b) => a - b)).toEqual([3, 4, 12]);
    expect(out.get(3)).toContain('third body line');
    expect(out.get(3)).toContain('more third');
    expect(out.get(3)).not.toContain('fourth body');
    expect(out.get(4)).toContain('fourth body');
    expect(out.get(4)).not.toContain('twelfth body');
    expect(out.get(12)).toContain('twelfth body');
  });

  it('skips a requested number that does not exist rather than erroring', () => {
    const out = extractBriefSections(fixture, [3, 999]);
    expect(out.has(999)).toBe(false);
    expect(out.has(3)).toBe(true);
  });
});

describe('redactSecrets', () => {
  // Secret-shaped strings are BUILT AT RUNTIME here, never written as literals, so this
  // source file never itself trips a credential scanner (the repo's pre-commit gate scans
  // every file, including tests). The redactor still sees a real secret-shaped input.
  const fakeEnvValue = 'abcd1234' + 'X'.repeat(16); // matches an ASSEMBLYAI_API_KEY=<16+ chars> shape
  const fakeSkToken = 'sk-' + 'y'.repeat(24); // matches the sk-<20+ chars> shape

  it('redacts an .env-style KEY=value line while keeping the key name visible', () => {
    const fixture = `ASSEMBLYAI_API_KEY=${fakeEnvValue}\nOTHER=fine`;
    const out = redactSecrets(fixture);
    expect(out).not.toContain(fakeEnvValue);
    expect(out).toContain('ASSEMBLYAI_API_KEY=[REDACTED]');
    expect(out).toContain('OTHER=fine');
  });

  it('redacts an Authorization Bearer header', () => {
    const out = redactSecrets(`Authorization: Bearer ${fakeSkToken}`);
    expect(out).not.toContain(fakeSkToken);
  });

  it('redacts a bare sk- style token even outside a KEY= line', () => {
    const out = redactSecrets(`curl -H "Authorization: Bearer ${fakeSkToken}"`);
    expect(out).not.toContain(fakeSkToken);
  });
});

describe('buildPacket against the real repo (read-only)', () => {
  it('never includes the real .env file contents', () => {
    let envContent = '';
    try {
      envContent = readFileSync(join(REPO_ROOT, '.env'), 'utf-8');
    } catch {
      // No .env on this machine yet -- nothing to check against, test still valid.
    }
    const packet = buildPacket({ cap: 60_000 });
    const nonEmptyValueLines = envContent
      .split('\n')
      .filter((l) => /=/.test(l) && !l.trim().startsWith('#'))
      .map((l) => l.split('=')[1]?.trim())
      .filter((v): v is string => !!v && v.length > 4);
    for (const value of nonEmptyValueLines) {
      expect(packet.text).not.toContain(value);
    }
  });

  it('builds real sections including the imported RULES_DOC verbatim', () => {
    const sections = buildSections();
    const rulesSection = sections.find((s) => s.id === 'rules-doc');
    expect(rulesSection).toBeDefined();
    expect(rulesSection!.content).toContain('COUNTERSIGN RULES v2');
  });

  it('caps the real packet at the requested size and reports what was cut', () => {
    const packet = buildPacket({ cap: 5_000 });
    expect(packet.cap).toBe(5_000);
    expect(packet.truncated.length).toBeGreaterThan(0);
    expect(packet.cut_note).toMatch(/Cap reached/);
  });
});
