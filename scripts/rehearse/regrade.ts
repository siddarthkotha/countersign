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
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { checkCloseLineExpectation } from './expectations.js';
import type { TranscriptRecord } from './types.js';

export interface ParsedReport {
  scenario_name: string | null;
  expected_verdict: string | null;
  actual_verdict: string | null;
  ended_reason: string | null;
  original_result: 'PASS' | 'FAIL' | null;
  original_fail_reason: string | null;
  transcript: TranscriptRecord[];
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
 *  observed" back to `null`, matching `RunResult.ended_reason`'s real type. */
export function parseReportMarkdown(md: string): ParsedReport {
  const scenarioMatch = md.match(/^Scenario: `([^`]+)`/m);
  const resultMatch = md.match(/^## Result: (PASS|FAIL)$/m);
  const endedReasonRaw = extractLine(md, 'Call ended reason');
  const failReasonRaw = extractLine(md, 'Fail reason');
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
  };
}

export interface RegradeResult {
  parsed: ParsedReport;
  close_line_status: 'spoken' | 'not_spoken' | 'n/a';
  close_line_failure: string | null;
  /** `original_result && close_line_status !== 'not_spoken'` -- this tool only ever ADDS the
   *  close-line check on top of whatever the report already recorded; it does not
   *  re-derive the base verdict-match/expectations checks (those need the scenario's
   *  `expected` config and the raw diagnostics bundle, only some of which survive in the
   *  persisted `.md`/`.diagnostics.json` pair -- see this file's header comment). A report
   *  that was already FAIL for an unrelated reason stays FAIL either way. */
  regraded_result: 'PASS' | 'FAIL' | null;
  changed: boolean;
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

export function regrade(md: string): RegradeResult {
  const parsed = parseReportMarkdown(md);
  const closeLineCheck = checkCloseLineExpectation(parsed.ended_reason, toVerdictOrNull(parsed.actual_verdict), parsed.transcript);
  const regradedResult: 'PASS' | 'FAIL' | null =
    parsed.original_result === null ? null : parsed.original_result === 'FAIL' ? 'FAIL' : closeLineCheck.status === 'not_spoken' ? 'FAIL' : 'PASS';
  return {
    parsed,
    close_line_status: closeLineCheck.status,
    close_line_failure: closeLineCheck.failure,
    regraded_result: regradedResult,
    changed: regradedResult !== null && parsed.original_result !== null && regradedResult !== parsed.original_result,
  };
}

function printResult(path: string, r: RegradeResult): void {
  const p = r.parsed;
  console.log(`rehearse:regrade -- ${path}`);
  console.log(`  scenario: ${p.scenario_name ?? 'unknown'}`);
  console.log(`  expected verdict: ${p.expected_verdict ?? 'unknown'}  actual verdict: ${p.actual_verdict ?? 'unknown'}`);
  console.log(`  call ended reason: ${p.ended_reason ?? 'unknown'}`);
  console.log(`  original recorded result: ${p.original_result ?? 'unknown'}${p.original_fail_reason ? ` (fail_reason=${p.original_fail_reason})` : ''}`);
  const closeDisplay =
    r.close_line_status === 'spoken' ? 'spoken' : r.close_line_status === 'n/a' ? 'n/a (caller ended)' : `NOT spoken -- ${r.close_line_failure}`;
  console.log(`  close line (regraded): ${closeDisplay}`);
  console.log(`  regraded result: ${r.regraded_result ?? 'unknown'}${r.close_line_status === 'not_spoken' ? ' (fail_reason=close_line_not_spoken)' : ''}`);
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
  const result = regrade(md);
  printResult(mdPath, result);
  process.exitCode = result.regraded_result === 'FAIL' ? 1 : 0;
}

// Guarded (same pattern as simFriday.ts/rehearseBatch.ts/latencyTable.ts): this module is
// imported directly by regrade.test.ts to exercise its pure parsing/regrading functions
// without a real file on disk -- `main()` must only run when this file is the actual CLI
// entry point, never as an import-time side effect of a test importing it.
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) void main();
