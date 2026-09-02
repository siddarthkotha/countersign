// packages/engine/test/corpus.test.ts
// G3 evidence: every file in ../corpus replayed through the REAL `evaluate`, asserting the
// engine reproduces exactly the `expected` block recorded in the file. This is the mechanism
// behind "FSM verdicts reproducible" (BRIEF gate G3) and "the rulebook is load-bearing" for
// judges: nothing here is hand-wished, every `expected` was pasted from an actual replay run
// (see scripts/replay.ts and task-6-report.md for the RED/GREEN evidence).
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluate } from '../src/evaluate';
import { MERIDIAN } from '../src/seed/meridian';
import type { AssuranceChecklist, CorpusFile } from '../src/types';

const dir = join(__dirname, '..', 'corpus');
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .sort();

describe('adversarial replay corpus reproduces through the real engine (G3 evidence)', () => {
  it('has at least 16 transcripts', () => {
    expect(files.length).toBeGreaterThanOrEqual(16);
  });

  for (const f of files) {
    const corpus = JSON.parse(readFileSync(join(dir, f), 'utf8')) as CorpusFile;

    describe(`${f}: ${corpus.expected.verdict}`, () => {
      const out = evaluate({
        conversation: corpus.conversation,
        tools: corpus.tools,
        actions: corpus.actions,
        call: corpus.call,
        seed: MERIDIAN,
      });

      it('reproduces the recorded verdict/state/reasons/failure_tally/request_version exactly', () => {
        // `assurance` (when present) is checked separately below -- it's asserted
        // key-by-key against AssuranceChecklist there, not folded into this deep-equal.
        const { assurance: _assurance, ...expectedCore } = corpus.expected;
        expect({
          verdict: out.verdict,
          state: out.state,
          reasons: out.reasons,
          failure_tally: out.failure_tally,
          request_version: out.request_version,
        }).toEqual(expectedCore);
      });

      it('LAW 2: never RELEASE, anywhere in the output', () => {
        expect(out.verdict).not.toBe('RELEASE' as never);
        expect(out.allowed_tools).not.toContain('RELEASE' as never);
        expect(out.required_actions).not.toContain('RELEASE' as never);
      });

      it('LAW 4: every evidence quote is a verbatim substring of the utterance it cites', () => {
        for (const e of out.evidence) {
          for (const q of e.quotes) {
            const u = corpus.conversation.find((x) => x.id === q.utterance_id);
            expect(u, `quote ${JSON.stringify(q)} cites an unknown utterance id`).toBeDefined();
            expect(u!.text).toContain(q.text);
          }
        }
      });

      it('determinism: evaluating the same input twice is deep-equal', () => {
        const again = evaluate({
          conversation: corpus.conversation,
          tools: corpus.tools,
          actions: corpus.actions,
          call: corpus.call,
          seed: MERIDIAN,
        });
        expect(again).toEqual(out);
      });

      if (corpus.expected.assurance) {
        it('recorded assurance fields match the real engine output', () => {
          for (const [key, value] of Object.entries(corpus.expected.assurance!)) {
            expect(out.assurance[key as keyof AssuranceChecklist]).toBe(value);
          }
        });
      }

      if (corpus.expected.verdict === 'STAGE') {
        it('STAGE files: every AssuranceChecklist item is true (I2)', () => {
          expect(Object.values(out.assurance).every((v) => v === true)).toBe(true);
        });
      }
    });
  }
});
