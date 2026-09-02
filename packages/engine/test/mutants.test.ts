// packages/engine/test/mutants.test.ts
// Mutation tests (amendment-v2-brief.md §E): for each `RuleMutant` key, replay every corpus
// file with that mutant injected into the real `decide` (via `evaluate`'s third parameter)
// and assert at least one file's verdict stops matching its recorded `expected.verdict`.
// This proves every rule the mutant breaks is load-bearing -- if a mutant changed NOTHING,
// the rule it disables was dead code. README section "Break the rules and watch the tests
// fail" is this file, described in prose.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluate } from '../src/evaluate';
import { MERIDIAN } from '../src/seed/meridian';
import type { CorpusFile } from '../src/types';
import type { RuleMutant } from '../src/rules';

const dir = join(__dirname, '..', 'corpus');
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .sort();
const corpora = files.map((f) => ({
  file: f,
  corpus: JSON.parse(readFileSync(join(dir, f), 'utf8')) as CorpusFile,
}));

const MUTANTS: { key: keyof RuleMutant; mutant: RuleMutant }[] = [
  { key: 'ignore_contradictions', mutant: { ignore_contradictions: true } },
  { key: 'or_instead_of_and_in_7a', mutant: { or_instead_of_and_in_7a: true } },
  { key: 'skip_readback_gate', mutant: { skip_readback_gate: true } },
  { key: 'ignore_exposure', mutant: { ignore_exposure: true } },
];

describe('mutation tests: every RuleMutant breaks at least one corpus verdict', () => {
  for (const { key, mutant } of MUTANTS) {
    it(`${key}: at least one corpus file's verdict fails to reproduce under this mutant`, () => {
      const brokenFiles = corpora
        .filter(({ corpus }) => {
          const out = evaluate(
            {
              conversation: corpus.conversation,
              tools: corpus.tools,
              actions: corpus.actions,
              call: corpus.call,
              seed: MERIDIAN,
            },
            undefined,
            mutant,
          );
          return out.verdict !== corpus.expected.verdict;
        })
        .map(({ file }) => file);

      expect(brokenFiles.length, `expected mutant "${key}" to break at least one corpus file`).toBeGreaterThan(0);
    });
  }
});
