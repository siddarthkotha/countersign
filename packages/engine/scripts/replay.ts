// packages/engine/scripts/replay.ts
// Judge-legible replay CLI (G3 evidence): reads a corpus JSON file, runs it through the
// real `evaluate`, and prints state, verdict, reasons, tally, request_version, one line
// per evidence card, the assurance checklist, required actions, and the counterfactual
// "why?" flips. Exits 1 if the file's `expected` block does not match the real output --
// this is what makes "16 transcripts replay-tested" an enforced claim, not an assertion.
//
// Run from the repo root: `npm run replay -- packages/engine/corpus/<file>.json`
// Run from packages/engine: `npm run replay -- corpus/<file>.json`
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { evaluate } from '../src/evaluate';
import { counterfactuals } from '../src/counterfactual';
import { MERIDIAN } from '../src/seed/meridian';
import type { AssuranceChecklist, CorpusFile } from '../src/types';

function resolveCorpusPath(argPath: string): string {
  // Root's `replay` script forwards to `npm run replay --workspace @countersign/engine --`,
  // which runs this script with cwd = packages/engine -- but the documented invocation
  // (`npm run replay -- packages/engine/corpus/<file>.json`, run from the repo ROOT) passes
  // a path that already includes the `packages/engine/` prefix. Try cwd-relative first (for
  // direct `tsx scripts/replay.ts corpus/<file>.json` runs from packages/engine, and for an
  // already-absolute path); fall back to repo-root-relative (cwd's grandparent) so the
  // documented root invocation resolves correctly too.
  const direct = resolve(process.cwd(), argPath);
  if (existsSync(direct)) return direct;
  const fromRepoRoot = resolve(process.cwd(), '..', '..', argPath);
  if (existsSync(fromRepoRoot)) return fromRepoRoot;
  throw new Error(`corpus file not found (tried ${direct} and ${fromRepoRoot})`);
}

const argPath = process.argv[2];
if (!argPath) {
  console.error('usage: replay.ts <path-to-corpus-file.json>');
  process.exit(1);
}

const resolvedPath = resolveCorpusPath(argPath);
const corpus = JSON.parse(readFileSync(resolvedPath, 'utf8')) as CorpusFile;

const input = {
  conversation: corpus.conversation,
  tools: corpus.tools,
  actions: corpus.actions,
  call: corpus.call,
  seed: MERIDIAN,
};

const out = evaluate(input);

console.log(`${corpus.title}`);
console.log(corpus.description);
console.log('');
console.log(`state:            ${out.state}`);
console.log(`verdict:          ${out.verdict}`);
console.log(`reasons:          ${out.reasons.length > 0 ? out.reasons.join(', ') : '(none)'}`);
console.log(`failure_tally:    ${out.failure_tally}`);
console.log(`request_version:  ${out.request_version}`);
console.log('');

console.log('evidence:');
for (const e of out.evidence) {
  const quotes = e.quotes.map((q) => `«${q.text}»`).join(' ');
  console.log(`  [${e.status}] ${e.label} — ${e.detail}${quotes ? `  ${quotes}` : ''}  (${e.provenance})`);
}
console.log('');

console.log('assurance checklist:');
for (const [key, value] of Object.entries(out.assurance) as [keyof AssuranceChecklist, boolean][]) {
  console.log(`  ${value ? '✓' : '✗'} ${key}`);
}
console.log('');

console.log(`required actions: ${out.required_actions.length > 0 ? out.required_actions.join(', ') : '(none)'}`);
console.log('');

console.log('counterfactuals (single-card flips that change the verdict):');
const flips = counterfactuals(input);
if (flips.length === 0) console.log('  (none)');
for (const flip of flips) {
  const label = flip.verdict === 'PENDING' || flip.verdict === 'NO_ACTION' ? `${flip.verdict} (${flip.state})` : flip.verdict;
  console.log(`  ${flip.flip}  =>  ${label}`);
}
console.log('');

const actual = {
  verdict: out.verdict,
  state: out.state,
  reasons: out.reasons,
  failure_tally: out.failure_tally,
  request_version: out.request_version,
};
const expected = {
  verdict: corpus.expected.verdict,
  state: corpus.expected.state,
  reasons: corpus.expected.reasons,
  failure_tally: corpus.expected.failure_tally,
  request_version: corpus.expected.request_version,
};

let mismatched = JSON.stringify(actual) !== JSON.stringify(expected);
const assuranceMismatches: string[] = [];
if (corpus.expected.assurance) {
  for (const [key, value] of Object.entries(corpus.expected.assurance) as [keyof AssuranceChecklist, boolean][]) {
    if (out.assurance[key] !== value) assuranceMismatches.push(`${key}: expected ${value}, got ${out.assurance[key]}`);
  }
}
if (assuranceMismatches.length > 0) mismatched = true;

if (!mismatched) {
  console.log('MATCH: recorded `expected` reproduces exactly.');
} else {
  console.log('MISMATCH: recorded `expected` does NOT reproduce.');
  console.log(`  expected: ${JSON.stringify(expected)}`);
  console.log(`  actual:   ${JSON.stringify(actual)}`);
  for (const m of assuranceMismatches) console.log(`  assurance mismatch -- ${m}`);
  process.exit(1);
}
