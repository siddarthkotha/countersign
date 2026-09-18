#!/usr/bin/env -S npx tsx
// scripts/rehearse/gradeRecord.ts
// Usage: npm run grade:record -- <path-to-diagnostics.json>
//
// Founder-experience grading (2026-09-18, SONNET-JUSTIFIED build lane: the harness reported
// PASS on all four of that morning's calls while the founder, replaying the same build live,
// heard "keeps asking the same questions", "does not let me complete my sentence", "repeated
// questions, lame quality", and quit). Grades ANY raw diagnostics bundle -- a fresh harness
// run's own fetched bundle, an old report's sibling `.diagnostics.json`, or (the case this
// tool exists for) one of the founder's OWN recorded bundles under scripts/rehearse/reports/
// founder-2026-09-18/*.diagnostics.json -- straight through experienceGrading.ts's
// `computeExperienceGrade`, with no scenario, no expected verdict, and no live call needed.
//
// This is a TEST HARNESS (BRIEF LAW 5 scope fence): it never calls AssemblyAI, never touches
// a live server, and is never imported by product code under packages/.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { computeExperienceGrade } from './experienceGrading.js';
import type { RehearseDiagnosticBundle } from './types.js';

export function printGrade(path: string, bundle: RehearseDiagnosticBundle): boolean {
  const grade = computeExperienceGrade(bundle);
  console.log(`grade:record -- ${path}`);
  console.log(`  session: ${bundle.session_id}`);
  console.log(`  end reason: ${bundle.end_reason ?? 'unknown'}`);
  console.log(`  result: ${grade.ok ? 'PASS' : 'FAIL'}`);
  console.log(
    `  repeated_question=${grade.repeated_question.count} merged_reply=${grade.merged_reply.count} talk_over=${grade.talk_over.count} holding_spam=${grade.holding_spam.count}`,
  );
  if (grade.repeated_question.count > 0) console.log(`    repeated_question at: ${grade.repeated_question.timestamps_s.join(', ')}s`);
  if (grade.merged_reply.count > 0) console.log(`    merged_reply at: ${grade.merged_reply.timestamps_s.join(', ')}s`);
  if (grade.talk_over.count > 0) console.log(`    talk_over at: ${grade.talk_over.timestamps_s.join(', ')}s`);
  if (grade.holding_spam.count > 0) console.log(`    holding_spam at: ${grade.holding_spam.timestamps_s.join(', ')}s`);
  console.log(
    `  question_lag: ${grade.question_lag.skipped ? `SKIPPED -- ${grade.question_lag.skip_reason}` : `${grade.question_lag.count}`} (informational)`,
  );
  console.log(
    `  goodbye_delay: ${grade.goodbye_delay.seconds === null ? 'n/a' : `${grade.goodbye_delay.seconds}s`}${grade.goodbye_delay.close_retry_needed ? ' (close_retry needed)' : ''} (informational)`,
  );
  return grade.ok;
}

async function main(): Promise<void> {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error('usage: npm run grade:record -- <path-to-diagnostics.json>');
    process.exitCode = 2;
    return;
  }
  let bundle: RehearseDiagnosticBundle;
  try {
    const raw = await readFile(inputPath, 'utf-8');
    bundle = JSON.parse(raw);
  } catch (err) {
    console.error(`grade:record: could not read/parse ${inputPath}: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
    return;
  }
  const ok = printGrade(inputPath, bundle);
  process.exitCode = ok ? 0 : 1;
}

// Guarded (same pattern as run.ts/regrade.ts/rehearseBatch.ts): this module is safe to import
// from a test without running the CLI as a side effect.
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) void main();
