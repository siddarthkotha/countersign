#!/usr/bin/env -S npx tsx
// scripts/rehearse/latencyTable.ts
// `npm run latency:table` -- reads EVERY *.diagnostics.json bundle under
// scripts/rehearse/reports/ (gitignored; not part of this repo's tracked history, see
// docs/REHEARSAL-HARNESS.md's "what is not committed"), computes the latency columns
// docs/LATENCY.md documents, and overwrites docs/LATENCY.md with the result.
//
// This is read-only against the reports directory (never writes a report, never touches a
// server, never calls the live API -- BRIEF LAW 5 scope fence, same as the rest of this
// harness) and pure math otherwise (latencyMath.ts). The only I/O here is: list files, read
// JSON + the paired .md's "Target"/"Scenario" lines, write one markdown file.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyTarget, computeRunLatencyMetrics, percentile, type RunLatencyMetrics, type TargetKind } from './latencyMath.js';
import type { RehearseDiagnosticBundle } from './types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPORTS_DIR = join(HERE, 'reports');
export const DEFAULT_OUTPUT_PATH = join(HERE, '..', '..', 'docs', 'LATENCY.md');

export interface LoadedRun {
  source_file: string;
  target_url: string | null;
  target_kind: TargetKind;
  scenario: string;
  date_iso: string;
  metrics: RunLatencyMetrics;
}

/** Pulls "Target: <url>" and "Scenario: `<name>`" out of the paired .md report -- the same
 *  file run.ts's own report.ts always writes next to a diagnostics bundle, same timestamp
 *  basename (report.ts's `reportFileName`/`diagnosticsFileName`). Falls back to parsing the
 *  scenario name back out of the diagnostics file's own name (it is always
 *  "<timestamp>-<scenario-name>.diagnostics.json") when the .md is missing, and to `null`
 *  target (UNKNOWN) when neither the .md nor the filename says. */
function parsePairedMd(mdText: string | null, diagnosticsFileName: string): { target_url: string | null; scenario: string } {
  const targetMatch = mdText ? /^Target: (.+)$/m.exec(mdText) : null;
  const scenarioMatch = mdText ? /^Scenario: `([^`]+)`/m.exec(mdText) : null;
  const nameFromFile = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.diagnostics\.json$/.exec(diagnosticsFileName);
  return {
    target_url: targetMatch ? targetMatch[1]!.trim() : null,
    scenario: scenarioMatch ? scenarioMatch[1]! : nameFromFile ? nameFromFile[1]! : 'unknown-scenario',
  };
}

export async function loadRuns(reportsDir: string): Promise<LoadedRun[]> {
  let entries: string[];
  try {
    entries = await readdir(reportsDir);
  } catch {
    return [];
  }
  const diagnosticsFiles = entries.filter((f) => f.endsWith('.diagnostics.json')).sort();

  const runs: LoadedRun[] = [];
  for (const fileName of diagnosticsFiles) {
    const bundleText = await readFile(join(reportsDir, fileName), 'utf-8');
    let bundle: RehearseDiagnosticBundle;
    try {
      bundle = JSON.parse(bundleText) as RehearseDiagnosticBundle;
    } catch {
      continue; // skip a corrupt/truncated bundle rather than fail the whole table
    }

    const mdFileName = fileName.replace(/\.diagnostics\.json$/, '.md');
    let mdText: string | null = null;
    try {
      mdText = await readFile(join(reportsDir, mdFileName), 'utf-8');
    } catch {
      mdText = null;
    }
    const { target_url, scenario } = parsePairedMd(mdText, fileName);

    const dateMatch = /^(\d{4}-\d{2}-\d{2})T/.exec(fileName);
    const date_iso = dateMatch ? dateMatch[1]! : new Date(bundle.started_at).toISOString().slice(0, 10);

    runs.push({
      source_file: fileName,
      target_url,
      target_kind: classifyTarget(target_url),
      scenario,
      date_iso,
      metrics: computeRunLatencyMetrics(bundle),
    });
  }
  return runs;
}

function fmt(ms: number | null): string {
  return ms === null ? 'UNKNOWN' : `${Math.round(ms)}ms`;
}

interface PctRow {
  label: string;
  n: number;
  p50: string;
  p95: string;
}

function pctRow(label: string, values: number[]): PctRow {
  return {
    label,
    n: values.length,
    p50: fmt(percentile(values, 0.5)),
    p95: fmt(percentile(values, 0.95)),
  };
}

function renderPctTable(rows: PctRow[]): string {
  const lines = ['| group | n | p50 | p95 |', '| --- | --- | --- | --- |'];
  for (const r of rows) lines.push(`| ${r.label} | ${r.n} | ${r.p50} | ${r.p95} |`);
  return lines.join('\n');
}

/** Groups a flat metric-picking function's non-null values by every (target, scenario) pair
 *  present, plus one "all scenarios" row per target and one grand-total row. `label` names
 *  the group in the rendered table. */
function groupedPctRows(runs: LoadedRun[], pick: (m: RunLatencyMetrics) => number | number[] | null): PctRow[] {
  const flatten = (v: number | number[] | null): number[] => (v === null ? [] : Array.isArray(v) ? v : [v]);

  const rows: PctRow[] = [];
  const targets: TargetKind[] = ['local', 'deployed', 'unknown'];
  for (const target of targets) {
    const targetRuns = runs.filter((r) => r.target_kind === target);
    if (targetRuns.length === 0) continue;
    const scenarios = [...new Set(targetRuns.map((r) => r.scenario))].sort();
    for (const scenario of scenarios) {
      const values = targetRuns.filter((r) => r.scenario === scenario).flatMap((r) => flatten(pick(r.metrics)));
      rows.push(pctRow(`${target} / ${scenario}`, values));
    }
    const allValues = targetRuns.flatMap((r) => flatten(pick(r.metrics)));
    rows.push(pctRow(`${target} / all scenarios`, allValues));
  }
  const grandTotal = runs.flatMap((r) => flatten(pick(r.metrics)));
  rows.push(pctRow('all targets / all scenarios', grandTotal));
  return rows;
}

/** Column 2 gets its own aggregation (rather than reusing groupedPctRows) because a plain
 *  target/scenario split would silently average a true greeting-latency number together
 *  with a number dominated by caller talk time (see greetingLabel's doc comment) -- exactly
 *  the confound docs/AUTOPILOT_LOG.md's 2026-09-11 entry already found by hand ("the 17s was
 *  the harness caller pacing and speaking; agent reply-start to first audio 1-150ms, n=3").
 *  Splitting by label first keeps that from ever being silently re-introduced here. */
function groupedPctRowsForReadyToAudio(runs: LoadedRun[]): PctRow[] {
  const rows: PctRow[] = [];
  const targets: TargetKind[] = ['local', 'deployed', 'unknown'];
  const valuesFor = (subset: LoadedRun[]): number[] => subset.map((r) => r.metrics.ready_to_first_audio_ms).filter((v): v is number => v !== null);

  for (const target of targets) {
    const targetRuns = runs.filter((r) => r.target_kind === target);
    if (targetRuns.length === 0) continue;
    const labels = [...new Set(targetRuns.map((r) => greetingLabel(r.metrics.greeting)))];
    for (const label of labels) {
      rows.push(pctRow(`${target} / ${label}`, valuesFor(targetRuns.filter((r) => greetingLabel(r.metrics.greeting) === label))));
    }
  }
  const allLabels = [...new Set(runs.map((r) => greetingLabel(r.metrics.greeting)))];
  for (const label of allLabels) {
    rows.push(pctRow(`all targets / ${label}`, valuesFor(runs.filter((r) => greetingLabel(r.metrics.greeting) === label))));
  }
  return rows;
}

/** How the run's `aai_ready`.`greeting_configured` field (or its absence, on an older bundle)
 *  is described in both the per-run table and the column-2 aggregate table. `false`/`null`
 *  are named explicitly as NOT a pure agent-turnaround measurement (see the caveat printed
 *  above section 2 of the doc) -- PROVEN by every bundle on disk today where `greeting` is
 *  not `true`: the agent's first audio there only occurs after `input.speech.stopped` for
 *  the caller's own opening turn (checked directly against 2026-09-09T18-20-23 and
 *  2026-09-09T20-06-19's raw event streams while building this table), so "ready to first
 *  audio" on those rows is dominated by how long the caller took to speak, not by the agent. */
function greetingLabel(greeting: boolean | null): string {
  if (greeting === true) return 'greeting';
  if (greeting === false) return 'first reply, no greeting configured (includes caller talk time before the agent speaks)';
  return 'first reply, greeting_configured unknown -- older bundle (includes caller talk time before the agent speaks)';
}

function renderPerRunTable(runs: LoadedRun[]): string {
  const lines = [
    '| file | date | target | scenario | connect->ready | ready->first-audio | label | connect->verdict | verdict->end | turns w/ reply |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of runs) {
    const label = greetingLabel(r.metrics.greeting);
    lines.push(
      `| ${r.source_file} | ${r.date_iso} | ${r.target_kind} | ${r.scenario} | ${fmt(r.metrics.connect_to_ready_ms)} | ${fmt(r.metrics.ready_to_first_audio_ms)} | ${label} | ${fmt(r.metrics.connect_to_verdict_ms)} | ${fmt(r.metrics.verdict_to_end_ms)} | ${r.metrics.turn_response_gaps_ms.length} |`,
    );
  }
  return lines.join('\n');
}

export function renderLatencyDoc(runs: LoadedRun[], skippedCount: number): string {
  const lines: string[] = [];
  lines.push('# Latency table');
  lines.push('');
  lines.push(
    'Every number below is either PROVEN (a real subtraction between two events a live run actually emitted, computed by `scripts/rehearse/latencyMath.ts`) or UNKNOWN (the bundle this row/column needs is missing or predates the event) -- never a guess, and never rounded off into a vague qualitative claim (CLAUDE.md rule: always measured p50/p95, milliseconds, stated plainly). p50/p95 use linear interpolation over the sorted sample (the same convention numpy/R-7 use); `n` is the exact sample size for that cell, stated so a small `n` reads as small, not as confidence.',
  );
  lines.push('');
  lines.push('How to regenerate this file: `npm run latency:table` (reads every `*.diagnostics.json` under `scripts/rehearse/reports/`, which is gitignored and lives only on the machine that ran the rehearsals -- see docs/REHEARSAL-HARNESS.md).');
  lines.push('');

  if (runs.length === 0) {
    lines.push('_No `*.diagnostics.json` bundles found under `scripts/rehearse/reports/` at generation time. Every column below is UNKNOWN until at least one rehearsal run with a diagnostics bundle exists on this machine._');
    lines.push('');
    return lines.join('\n');
  }

  const dates = runs.map((r) => r.date_iso).sort();
  lines.push(`Runs with a diagnostics bundle: n=${runs.length}, date range ${dates[0]} to ${dates[dates.length - 1]!}.`);
  if (skippedCount > 0) {
    lines.push(
      `${skippedCount} additional \`.md\` rehearsal report(s) exist in the same directory with NO matching \`.diagnostics.json\` bundle (older runs, before the flight-recorder fetch was added 2026-09-09) -- every column here is UNKNOWN for those runs; they are not counted in any \`n\` above.`,
    );
  }
  lines.push('');

  lines.push('## Method, per column');
  lines.push('');
  lines.push('1. **Socket connect to AssemblyAI ready**: `aai_ready` event minus `aai_connect_start` event (the `aai_ready` event\'s own `ms_since_connect_start` detail is used when present, since that is the server\'s own measurement of the same interval; otherwise the two events\' timestamps are subtracted).');
  lines.push('2. **Ready to first agent audio**: the first `reply.audio.first` event at or after `aai_ready`, minus `aai_ready`. Labeled "greeting" when that run\'s `aai_ready` event carries `greeting_configured: true`; every other row is labeled "first reply" and is NOT a pure agent-latency number -- see the caveat under section 2 below.');
  lines.push('3. **Response latency (the gap a judge feels)**: per caller turn, the LAST `input.speech.stopped` event before the next `reply.audio.first` event, subtracted from that `reply.audio.first` (falls back to the last `transcript` event with `role: "user"` on a bundle with no `input.speech.stopped` events at all -- none of the runs on disk today needed that fallback). A turn the call ended without ever hearing a reply to contributes nothing to this column (same as a run report\'s own "no reply audio observed after this turn" note) -- it is not counted as 0ms.');
  lines.push('4. **Connect to terminal verdict**: the first `terminal_action` event\'s timestamp (baseline: `aai_connect_start` at t=0). A run with no `terminal_action` event (it never reached a verdict -- a FAIL) is UNKNOWN for this column, and excluded from `n`.');
  lines.push('5. **Verdict to call end**: `session_ended` minus that same `terminal_action` event.');
  lines.push('');

  lines.push('## Per-run raw numbers');
  lines.push('');
  lines.push(renderPerRunTable(runs));
  lines.push('');

  lines.push('## 1. Socket connect to AssemblyAI ready -- p50/p95 across runs');
  lines.push('');
  lines.push(renderPctTable(groupedPctRows(runs, (m) => m.connect_to_ready_ms)));
  lines.push('');

  lines.push('## 2. Ready to first agent audio -- p50/p95 across runs, split by whether a greeting was configured');
  lines.push('');
  lines.push(
    '**Caveat (PROVEN against the raw event streams of every non-greeting bundle on disk):** this column is only a pure agent-turnaround number on a "greeting" row. On every other row, this scenario has the CALLER speak first (there is no scripted agent greeting), so the agent\'s first audio frame only fires after the caller\'s own opening utterance ends -- the number is dominated by how long the caller took to speak, not by the agent. This is the exact confound docs/AUTOPILOT_LOG.md\'s 2026-09-11 entry already flagged by hand ("the 17s was the harness caller pacing and speaking; agent reply-start to first audio 1-150ms, n=3"). Rows are split by label below specifically so a "first reply" number is never averaged together with a "greeting" number.',
  );
  lines.push('');
  lines.push(renderPctTable(groupedPctRowsForReadyToAudio(runs)));
  lines.push('');

  lines.push('## 3. Response latency (caller speech end -> next agent audio) -- p50/p95 across ALL TURNS, not runs');
  lines.push('');
  lines.push(renderPctTable(groupedPctRows(runs, (m) => m.turn_response_gaps_ms)));
  lines.push('');

  lines.push('## 4. Connect to terminal verdict -- p50/p95 across runs');
  lines.push('');
  lines.push(renderPctTable(groupedPctRows(runs, (m) => m.connect_to_verdict_ms)));
  lines.push('');

  lines.push('## 5. Verdict to call end -- p50/p95 across runs');
  lines.push('');
  lines.push(renderPctTable(groupedPctRows(runs, (m) => m.verdict_to_end_ms)));
  lines.push('');

  return lines.join('\n');
}

export async function generateLatencyTable(reportsDir: string = DEFAULT_REPORTS_DIR, outputPath: string = DEFAULT_OUTPUT_PATH): Promise<{ runs: LoadedRun[]; outputPath: string }> {
  const runs = await loadRuns(reportsDir);

  let skippedCount = 0;
  try {
    const entries = await readdir(reportsDir);
    const mdCount = entries.filter((f) => f.endsWith('.md') && !f.endsWith('-rollup.md')).length;
    skippedCount = Math.max(0, mdCount - runs.length);
  } catch {
    skippedCount = 0;
  }

  const doc = renderLatencyDoc(runs, skippedCount);
  await writeFile(outputPath, doc, 'utf-8');
  return { runs, outputPath };
}

async function main(): Promise<void> {
  const { runs, outputPath } = await generateLatencyTable();
  console.log(`latency:table: read ${runs.length} diagnostics bundle(s), wrote ${outputPath}`);
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) void main();
