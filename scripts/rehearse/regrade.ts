#!/usr/bin/env -S npx tsx
// scripts/rehearse/regrade.ts
// Usage: npm run rehearse:regrade -- <path-to-report.md-or-diagnostics.json>
//
// Re-applies run.ts's own PASS/FAIL grading -- specifically the close-line check added
// 2026-09-13 (expectations.ts's `checkCloseLineExpectation`, the PROVEN gap that let
// scripts/rehearse/reports/2026-09-13T22-23-50-miller-patient.md pass despite the agent
// never speaking its FREEZE close line) -- to an ALREADY-COMPLETED run's persisted
// artifacts. No live call, no AssemblyAI credits spent: this reads files already on disk.
//
// Reads the run's rendered markdown REPORT (report.ts's `renderReport` output), not the
// sibling `.diagnostics.json`: artifacts.ts's raw flight-recorder bundle records each
// transcript line as `{role, length}` only (PROVEN: read scripts/rehearse/reports/
// 2026-09-13T22-23-50-miller-patient.diagnostics.json -- every "transcript" server_event
// carries a `length`, never the words), so it alone can never be re-graded against a
// wording-sensitive check like this one. The `.md` report is the only persisted artifact
// that carries the actual spoken transcript text. Accepts either sibling's path (both share
// one `<timestamp>-<scenario name>` basename, per report.ts's `reportFileName`/
// `diagnosticsFileName`) and reads the `.md` file either way.
//
// This is a TEST HARNESS (BRIEF LAW 5 scope fence): it never calls AssemblyAI, never touches
// a live server, and is never imported by product code under packages/.
//
// CANNOT re-grade the two specific reports this file's transcript-snapshot-timing fix (run.ts's
// `waitForVerdictAndHangup`) concerns -- 2026-09-14T15-49-25-structuring-two-wires.md and
// 2026-09-14T15-47-29-miller-patient.md, both written by the PRE-FIX code -- back to "spoken".
// PROVEN (both bundles' server_events): the goodbye reply IS there as a
// `transcript {role: agent, length: 92}` event, 92 being the exact length of the ESCALATE close
// sentence, but the sibling `.diagnostics.json` never carries the actual words (see this file's
// header above), and the `.md` report's transcript table -- the only artifact that ever could
// -- was itself rendered from the pre-fix, goodbye-less snapshot, so the words were never
// written to disk anywhere. There is no stored artifact this tool (or any tool) can regrade
// those two runs from; the only way to get a "spoken" report for them is to RE-RUN those
// scenarios live against the fixed harness.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { checkCloseLineExpectation } from './expectations.js';
import { computeExperienceGrade } from './experienceGrading.js';
import type { ExperienceGrade } from './experienceGrading.js';
import { computeQuestionAnswerRatio, questionAnswerRatioDisplay, detectQuestionsWithNoChance } from './freePlayGrading.js';
import type { RehearseDiagnosticBundle, TranscriptRecord } from './types.js';

export interface ParsedReport {
  scenario_name: string | null;
  expected_verdict: string | null;
  actual_verdict: string | null;
  ended_reason: string | null;
  original_result: 'PASS' | 'FAIL' | null;
  original_fail_reason: string | null;
  transcript: TranscriptRecord[];
  is_free_play: boolean;
  caller_mode: string | null;
}

function extractLine(md: string, label: string): string | null {
  const m = md.match(new RegExp(`^- ${label}: (.+)$`, 'm'));
  return m ? m[1]!.trim() : null;
}

/** Splits one transcript table row ("| t | speaker | text |", report.ts's `renderTranscript`)
 *  into its three columns. Only the last column (text) can ever contain a literal "|" (always
 *  escaped there as "\|" by `renderTranscript`) -- the `t`/`speaker` columns never do -- so
 *  the first two "|" delimiters found are always the real column boundaries, whatever the
 *  text column contains. */
function splitTranscriptRow(row: string): [string, string, string] | null {
  const trimmed = row.trim().replace(/^\|/, '').replace(/\|$/, '');
  const firstPipe = trimmed.indexOf('|');
  if (firstPipe === -1) return null;
  const secondPipe = trimmed.indexOf('|', firstPipe + 1);
  if (secondPipe === -1) return null;
  return [trimmed.slice(0, firstPipe), trimmed.slice(firstPipe + 1, secondPipe), trimmed.slice(secondPipe + 1)];
}

/** Parses the "## Full transcript (as received from the server)" table back into
 *  `TranscriptRecord[]` -- the exact inverse of report.ts's `renderTranscript`. Returns `[]`
 *  for "_No transcript received._" or a missing section (an older report, or a protocol-error
 *  run that never connected). */
export function parseTranscriptTable(md: string): TranscriptRecord[] {
  const sectionMatch = md.match(/## Full transcript \(as received from the server\)\n\n([\s\S]*?)(\n\n##|\n*$)/);
  if (!sectionMatch) return [];
  const block = sectionMatch[1]!;
  if (block.includes('_No transcript received._')) return [];
  const lines = block.split('\n').filter((l) => l.trim().startsWith('|'));
  const rows = lines.slice(2); // [0] header, [1] "| --- | --- | --- |" separator
  const records: TranscriptRecord[] = [];
  for (const row of rows) {
    const cells = splitTranscriptRow(row);
    if (!cells) continue;
    const [tCell, speakerCell, textCellRaw] = cells;
    const tStr = tCell!.trim();
    const t_ms = tStr === 'n/a' ? 0 : Number(tStr.replace(/ms$/, ''));
    const speaker = speakerCell!.trim();
    let textCell = textCellRaw!.trim().replace(/\\\|/g, '|');
    let interrupted = false;
    if (textCell.startsWith('(interrupted) ')) {
      interrupted = true;
      textCell = textCell.slice('(interrupted) '.length);
    }
    records.push({ speaker, text: textCell, t_ms, ...(interrupted ? { interrupted: true as const } : {}) });
  }
  return records;
}

/** Parses the fixed fields `renderReport` always writes out of the Result section, plus the
 *  full transcript table -- everything `checkCloseLineExpectation` needs to re-grade this run.
 *  `ended_reason` mirrors report.ts's own fallback text for "no ended event was ever
 *  observed" back to `null`, matching `RunResult.ended_reason`'s real type. Also detects
 *  whether this is a free-play run (which has additional grading rules). */
export function parseReportMarkdown(md: string): ParsedReport {
  const scenarioMatch = md.match(/^Scenario: `([^`]+)`/m);
  const resultMatch = md.match(/^## Result: (PASS|FAIL)$/m);
  const endedReasonRaw = extractLine(md, 'Call ended reason');
  const failReasonRaw = extractLine(md, 'Fail reason');
  // Caller mode appears in the header before the Result section, without a leading dash
  const callerModeMatch = md.match(/^Caller mode: (.+)$/m);
  const callerModeRaw = callerModeMatch ? callerModeMatch[1]!.trim() : null;
  const is_free_play = callerModeRaw !== null && callerModeRaw.includes('freeplay');
  return {
    scenario_name: scenarioMatch ? scenarioMatch[1]! : null,
    expected_verdict: extractLine(md, 'Expected verdict'),
    actual_verdict: extractLine(md, 'Actual verdict'),
    ended_reason: endedReasonRaw === null || endedReasonRaw.startsWith('unknown (') ? null : endedReasonRaw,
    original_result: resultMatch ? (resultMatch[1] as 'PASS' | 'FAIL') : null,
    // extractLine's regex captures everything after "Fail reason: " on one line, including
    // the trailing "(...)" explanation report.ts appends -- only the leading token is the
    // actual fail_reason value.
    original_fail_reason: failReasonRaw ? failReasonRaw.split(' ')[0]! : null,
    transcript: parseTranscriptTable(md),
    is_free_play,
    caller_mode: callerModeRaw,
  };
}

export interface RegradeResult {
  parsed: ParsedReport;
  close_line_status: 'spoken' | 'not_spoken' | 'n/a';
  close_line_failure: string | null;
  /** Regraded result computed from all applicable checks: verdict reached/acceptable,
   *  close-line (if server-ended), and for free-play the new no-chance question rule.
   *  This is a fresh computation, not carried forward from the original_result. */
  regraded_result: 'PASS' | 'FAIL' | null;
  changed: boolean;
  /** Free-play specific regrading: the new question-answer ratio with the refined rules. */
  free_play_question_answer?: { answered: number; total: number; unanswered: string[]; unanswered_no_chance: string[] };
  /** Founder-experience grading (2026-09-18): only computed when the sibling
   *  `.diagnostics.json` bundle was readable -- the `.md` report's own transcript table alone
   *  cannot support `repeated_question` (needs each `action_logged` event's field/challenge
   *  id), `talk_over` (needs `input.speech.started`/`stopped`), or `holding_spam`'s "no
   *  substantive follow-up" timing (needs every transcript timestamp, which the table does
   *  carry, so this one COULD be done from `.md` alone -- but is computed from the bundle here
   *  for one consistent code path). `undefined` when no sibling bundle was found or it failed
   *  to parse; `experience_skipped_reason` explains why in that case. */
  experience?: ExperienceGrade;
  experience_skipped_reason?: string;
}

const TERMINAL_VERDICT_STRINGS = new Set(['PENDING', 'ESCALATE', 'STAGE', 'FREEZE', 'NO_ACTION']);

/** `parsed.actual_verdict` is free text lifted from the report's "Actual verdict: <...>"
 *  line -- always one of the five real `Verdict` strings, or report.ts's own "none reached"
 *  fallback when no terminal verdict was ever hit. Only the five real strings are ever handed
 *  to `checkCloseLineExpectation`; anything else (just "none reached" in practice) becomes
 *  `null`, which that function already treats as "nothing to check". */
function toVerdictOrNull(actualVerdict: string | null): Parameters<typeof checkCloseLineExpectation>[1] {
  if (actualVerdict !== null && TERMINAL_VERDICT_STRINGS.has(actualVerdict)) {
    return actualVerdict as Parameters<typeof checkCloseLineExpectation>[1];
  }
  return null;
}

/** `bundle`: the sibling `.diagnostics.json` (report.ts's `diagnosticsFileName` convention),
 *  already read and JSON.parsed by the caller -- `undefined` when it wasn't found/parseable,
 *  in which case experience regrading is skipped (`experience_skipped_reason` explains why)
 *  rather than silently treated as a pass. Optional so every existing caller/test that only
 *  ever passed `md` keeps working unchanged. */
export function regrade(md: string, bundle?: RehearseDiagnosticBundle, bundleSkipReason?: string): RegradeResult {
  const parsed = parseReportMarkdown(md);
  const closeLineCheck = checkCloseLineExpectation(parsed.ended_reason, toVerdictOrNull(parsed.actual_verdict), parsed.transcript);

  // Recompute regraded result from scratch using all checks
  // For free-play reports with unanswered_agent_question failure, re-evaluate with the new rules
  let regradedResult: 'PASS' | 'FAIL' | null = null;

  if (parsed.is_free_play && parsed.original_fail_reason === 'unanswered_agent_question') {
    // Re-grade free-play unanswered_agent_question with the new "no-chance" rule
    const questionsNoChance = detectQuestionsWithNoChance(parsed.transcript);
    // Only fail if the agent actually gave no chance; otherwise it's just a warning
    regradedResult = questionsNoChance.length > 0 ? 'FAIL' : 'PASS';
  } else {
    // For other cases, start with the original result
    regradedResult = parsed.original_result;
  }

  // Check 1: Close line (if server-ended) - can only fail it, never pass
  if (regradedResult === 'PASS' && closeLineCheck.status === 'not_spoken') {
    regradedResult = 'FAIL';
  }

  // Founder-experience grading (2026-09-18): only when a raw bundle is available. Can only
  // ever turn a PASS into a FAIL, same convention as the close-line check above -- it never
  // resurrects a run that failed for an unrelated reason.
  const experience = bundle ? computeExperienceGrade(bundle) : undefined;
  if (experience && regradedResult === 'PASS' && !experience.ok) {
    regradedResult = 'FAIL';
  }

  const result: RegradeResult = {
    parsed,
    close_line_status: closeLineCheck.status,
    close_line_failure: closeLineCheck.failure,
    regraded_result: regradedResult,
    changed: regradedResult !== null && parsed.original_result !== null && regradedResult !== parsed.original_result,
    ...(experience !== undefined ? { experience } : {}),
    ...(experience === undefined ? { experience_skipped_reason: bundleSkipReason ?? 'no sibling .diagnostics.json bundle was supplied' } : {}),
  };

  // For free-play runs, also include the question-answer details
  if (parsed.is_free_play) {
    result.free_play_question_answer = computeQuestionAnswerRatio(parsed.transcript);
  }

  return result;
}

function printResult(path: string, r: RegradeResult): void {
  const p = r.parsed;
  console.log(`rehearse:regrade -- ${path}`);
  console.log(`  scenario: ${p.scenario_name ?? 'unknown'}`);
  console.log(`  caller mode: ${p.caller_mode ?? 'unknown'}`);
  console.log(`  expected verdict: ${p.expected_verdict ?? 'unknown'}  actual verdict: ${p.actual_verdict ?? 'unknown'}`);
  console.log(`  call ended reason: ${p.ended_reason ?? 'unknown'}`);
  console.log(`  original recorded result: ${p.original_result ?? 'unknown'}${p.original_fail_reason ? ` (fail_reason=${p.original_fail_reason})` : ''}`);
  const closeDisplay =
    r.close_line_status === 'spoken' ? 'spoken' : r.close_line_status === 'n/a' ? 'n/a (caller ended)' : `NOT spoken -- ${r.close_line_failure}`;
  console.log(`  close line (regraded): ${closeDisplay}`);
  console.log(`  regraded result: ${r.regraded_result ?? 'unknown'}${r.close_line_status === 'not_spoken' ? ' (fail_reason=close_line_not_spoken)' : ''}`);

  // Free-play specific output
  if (r.free_play_question_answer) {
    const qa = r.free_play_question_answer;
    console.log(`  free-play question-answer (regraded): ${questionAnswerRatioDisplay(qa)}`);
    if (qa.unanswered_no_chance.length > 0) {
      console.log(`    unanswered (agent gave no chance): ${qa.unanswered_no_chance.map((q) => JSON.stringify(q)).join(', ')}`);
    }
    if (qa.unanswered.length > qa.unanswered_no_chance.length) {
      const with_chance = qa.unanswered.filter((q) => !qa.unanswered_no_chance.includes(q));
      console.log(`    unanswered (caller chose not to respond): ${with_chance.map((q) => JSON.stringify(q)).join(', ')}`);
    }
  }

  // Founder-experience grading (2026-09-18).
  if (r.experience) {
    const g = r.experience;
    console.log(`  experience (regraded): ${g.ok ? 'OK' : 'FAILED'}`);
    console.log(
      `    repeated_question=${g.repeated_question.count} merged_reply=${g.merged_reply.count} talk_over=${g.talk_over.count} holding_spam=${g.holding_spam.count}`,
    );
    if (!g.ok) {
      if (g.repeated_question.count > 0) console.log(`    repeated_question at: ${g.repeated_question.timestamps_s.join(', ')}s`);
      if (g.merged_reply.count > 0) console.log(`    merged_reply at: ${g.merged_reply.timestamps_s.join(', ')}s`);
      if (g.talk_over.count > 0) console.log(`    talk_over at: ${g.talk_over.timestamps_s.join(', ')}s`);
      if (g.holding_spam.count > 0) console.log(`    holding_spam at: ${g.holding_spam.timestamps_s.join(', ')}s`);
    }
  } else {
    console.log(`  experience (regraded): SKIPPED -- ${r.experience_skipped_reason ?? 'unknown reason'}`);
  }

  if (r.changed) {
    console.log(`  REGRADE CHANGED: ${p.original_result} -> ${r.regraded_result}`);
  } else {
    console.log('  (no change from the originally recorded result)');
  }
}

async function main(): Promise<void> {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error('usage: npm run rehearse:regrade -- <path-to-report.md-or-diagnostics.json>');
    process.exitCode = 2;
    return;
  }
  const mdPath = inputPath.endsWith('.diagnostics.json') ? inputPath.replace(/\.diagnostics\.json$/, '.md') : inputPath;
  let md: string;
  try {
    md = await readFile(mdPath, 'utf-8');
  } catch (err) {
    console.error(`rehearse:regrade: could not read ${mdPath}: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
    return;
  }
  // Founder-experience grading (2026-09-18): the sibling `.diagnostics.json` (same basename,
  // report.ts's `diagnosticsFileName` convention) -- read it too, best-effort, so old reports
  // regrade with the full experience check whenever their raw bundle still exists on disk.
  const diagnosticsPath = mdPath.replace(/\.md$/, '.diagnostics.json');
  let bundle: import('./types.js').RehearseDiagnosticBundle | undefined;
  let bundleSkipReason: string | undefined;
  try {
    const raw = await readFile(diagnosticsPath, 'utf-8');
    bundle = JSON.parse(raw);
  } catch (err) {
    bundleSkipReason = `could not read/parse ${diagnosticsPath}: ${err instanceof Error ? err.message : String(err)}`;
  }
  const result = regrade(md, bundle, bundleSkipReason);
  printResult(mdPath, result);
  process.exitCode = result.regraded_result === 'FAIL' ? 1 : 0;
}

// Guarded (same pattern as simFriday.ts/rehearseBatch.ts/latencyTable.ts): this module is
// imported directly by regrade.test.ts to exercise its pure parsing/regrading functions
// without a real file on disk -- `main()` must only run when this file is the actual CLI
// entry point, never as an import-time side effect of a test importing it.
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) void main();
