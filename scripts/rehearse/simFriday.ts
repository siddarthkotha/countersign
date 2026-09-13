#!/usr/bin/env -S npx tsx
// scripts/rehearse/simFriday.ts
// `npm run sim:friday -- [--url <url>] [--runs <n>] [--max-minutes <m>] [--dry-run]`
//
// One command for a Friday judge-sim morning (backlog item SIM-ONE-COMMAND, docs/STATE.md
// "Open, in the order to take them" #2). In order:
//
//   a) Runs the five judge-sim scenarios -- the exact set ~/.claude/agents/judge-sim.md's
//      walk order step 4 reads for live-call evidence: scenario-a-dana-legitimate,
//      scenario-b-miller-fraud, judge-out-of-scope, barge-in-interrupt, identity-switch --
//      through the EXISTING batch runner (scripts/rehearse/rehearseBatch.ts, npm script
//      `rehearse:batch`). This file never reimplements scheduling, the stop-condition checks,
//      or spawning run.ts -- it only spawns rehearseBatch.ts itself as a child process with
//      those five scenario names filled in, `--url` passed through (default
//      https://countersign-bf8q.onrender.com, same default the rest of the harness uses),
//      and `--runs`/`--max-minutes` passed through (this command's own `--runs` means runs
//      PER scenario, default 1 -- multiplied by the five scenarios to get the batch's own
//      total `--runs`; `--max-minutes` default 15 passes straight through as the batch's
//      minute cap).
//   b) Regenerates docs/LATENCY.md by calling the SAME generator function
//      `npm run latency:table` runs (scripts/rehearse/latencyTable.ts's
//      `generateLatencyTable`) -- belt-and-suspenders on top of rehearseBatch's own internal
//      regenerate-at-the-end step, so LATENCY.md is guaranteed current after this command
//      even if that internal call ever changes.
//   c) Lists every report file under scripts/rehearse/reports/ (gitignored, local-only)
//      whose mtime is at or after this run's own start time, printing each report's scenario
//      name and verdict, so the judge-sim agent can find today's evidence without grepping
//      the directory itself.
//
// `--dry-run` prints the exact plan (target URL, the five scenarios, runs/max-minutes, the
// batch command that would run, and the latency-table + report-listing steps) and returns
// before touching the network, spawning anything, or reading the reports directory. CLAUDE.md
// rule: a test must never call the live API -- every function below is exercised by
// scripts/rehearse/test/simFriday.test.ts with injected fakes, never a real child process or
// network call.
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { DEFAULT_REPORTS_DIR, generateLatencyTable } from './latencyTable.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const BATCH_TS_PATH = join(HERE, 'rehearseBatch.ts');

export const DEFAULT_URL = 'https://countersign-bf8q.onrender.com';
export const DEFAULT_RUNS_PER_SCENARIO = 1;
export const DEFAULT_MAX_MINUTES = 15;

/** The exact five scenarios ~/.claude/agents/judge-sim.md's walk order step 4 names as what
 *  it reads from scripts/rehearse/reports/ for live-call evidence (golden path, fraud
 *  freeze, out-of-scope, barge-in, identity switch) -- not a reimplemented guess, the
 *  agent definition's own list, copied verbatim. */
export const JUDGE_SIM_SCENARIOS = [
  'scenario-a-dana-legitimate',
  'scenario-b-miller-fraud',
  'judge-out-of-scope',
  'barge-in-interrupt',
  'identity-switch',
] as const;

// ---------- pure: argument parsing ----------

export interface SimFridayArgs {
  url: string;
  runsPerScenario: number;
  maxMinutes: number;
  dryRun: boolean;
}

export type ParsedSimArgs = { ok: true; args: SimFridayArgs } | { ok: false; error: string };

export function parseSimArgs(argv: string[]): ParsedSimArgs {
  let url = DEFAULT_URL;
  let runsPerScenario = DEFAULT_RUNS_PER_SCENARIO;
  let maxMinutes = DEFAULT_MAX_MINUTES;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') {
      const v = argv[++i];
      if (!v) return { ok: false, error: 'sim:friday: --url requires a value.' };
      url = v;
    } else if (a === '--runs') {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v <= 0) {
        return { ok: false, error: 'sim:friday: --runs must be a positive number (runs PER scenario, default 1; multiplied by the five scenarios for the batch total).' };
      }
      runsPerScenario = v;
    } else if (a === '--max-minutes') {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v <= 0) {
        return { ok: false, error: 'sim:friday: --max-minutes must be a positive number (default 15).' };
      }
      maxMinutes = v;
    } else if (a === '--dry-run') {
      dryRun = true;
    } else if (a === '--help' || a === '-h') {
      return { ok: false, error: 'help' };
    } else {
      return { ok: false, error: `sim:friday: unrecognized argument "${a}" (--help for usage)` };
    }
  }
  return { ok: true, args: { url, runsPerScenario, maxMinutes, dryRun } };
}

export function printSimHelp(): string {
  return [
    'Countersign Friday judge-sim wrapper -- runs the five judge-sim scenarios through the existing batch runner, regenerates docs/LATENCY.md, then lists this run\'s report files.',
    '',
    'Usage: npm run sim:friday -- [--url <url>] [--runs <n>] [--max-minutes <m>] [--dry-run]',
    '',
    `  --url URL          target server. Default ${DEFAULT_URL}.`,
    `  --runs N           runs PER scenario (there are ${String(JUDGE_SIM_SCENARIOS.length)} scenarios). Default ${String(DEFAULT_RUNS_PER_SCENARIO)}.`,
    `  --max-minutes M    estimated-minutes cap for the whole batch, passed straight through to rehearse:batch. Default ${String(DEFAULT_MAX_MINUTES)}.`,
    '  --dry-run          print the exact plan and exit. No network, no spawned process, no credits.',
    '',
    `Scenarios run (fixed, from ~/.claude/agents/judge-sim.md walk order step 4): ${JUDGE_SIM_SCENARIOS.join(', ')}.`,
    '',
    'Every non-dry-run invocation spends real AssemblyAI credits, the same as running rehearse:batch directly.',
  ].join('\n');
}

// ---------- pure: batch invocation shape ----------

export function buildBatchTotalRuns(args: Pick<SimFridayArgs, 'runsPerScenario'>): number {
  return args.runsPerScenario * JUDGE_SIM_SCENARIOS.length;
}

export function buildBatchArgv(args: SimFridayArgs): string[] {
  return ['--url', args.url, '--runs', String(buildBatchTotalRuns(args)), '--scenarios', JUDGE_SIM_SCENARIOS.join(','), '--max-minutes', String(args.maxMinutes)];
}

export function renderDryRunPlan(args: SimFridayArgs): string {
  const lines: string[] = [];
  lines.push('sim:friday DRY RUN -- nothing below is executed. No network call, no spawned process, no credits spent.');
  lines.push('');
  lines.push(`Target: ${args.url}`);
  lines.push(`Scenarios (${String(JUDGE_SIM_SCENARIOS.length)}, fixed -- from ~/.claude/agents/judge-sim.md walk order step 4): ${JUDGE_SIM_SCENARIOS.join(', ')}`);
  lines.push(`Runs per scenario: ${String(args.runsPerScenario)} (batch total --runs: ${String(buildBatchTotalRuns(args))})`);
  lines.push(`Max minutes cap: ${String(args.maxMinutes)}`);
  lines.push('');
  lines.push('Step (a) would spawn the existing batch runner:');
  lines.push(`  npx tsx scripts/rehearse/rehearseBatch.ts ${buildBatchArgv(args).join(' ')}`);
  lines.push('');
  lines.push('Step (b) would regenerate docs/LATENCY.md (the same generateLatencyTable() function npm run latency:table calls).');
  lines.push('');
  lines.push(`Step (c) would list every *.md report under scripts/rehearse/reports/ (excluding batch roll-up files) modified at or after this run's own start time, printing each report's scenario name and verdict.`);
  return lines.join('\n');
}

// ---------- pure: parsing one report file ----------

export interface ReportListing {
  file: string;
  scenario: string;
  verdict: string;
}

/** Reads the same two lines report.ts's renderReport always writes -- `Scenario:
 *  \`<name>\`` and `- Actual verdict: <verdict>` -- falling back to the "## Result: PASS/FAIL"
 *  line (older or malformed reports) and finally to the scenario name embedded in the
 *  filename itself (same convention latencyTable.ts's parsePairedMd already relies on:
 *  "<timestamp>-<scenario-name>.md"), so a report missing one line still reports something
 *  useful rather than nothing. */
export function parseReportFile(mdText: string, fileName: string): { scenario: string; verdict: string } {
  const scenarioMatch = /^Scenario: `([^`]+)`/m.exec(mdText);
  const actualVerdictMatch = /^- Actual verdict: (.+)$/m.exec(mdText);
  const resultMatch = /^## Result: (PASS|FAIL)/m.exec(mdText);
  const nameFromFile = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.md$/.exec(fileName);

  const scenario = scenarioMatch ? scenarioMatch[1]! : nameFromFile ? nameFromFile[1]! : 'unknown-scenario';
  const verdict = actualVerdictMatch ? actualVerdictMatch[1]!.trim() : resultMatch ? resultMatch[1]! : 'UNKNOWN (no verdict line parsed)';
  return { scenario, verdict };
}

// ---------- I/O: listing this run's report files (local filesystem only, no network) ----------

/** Lists every `*.md` report under `reportsDir` (excluding the batch's own `-rollup.md`
 *  roll-up file, which has no single scenario/verdict) whose mtime is at or after
 *  `sinceMs`, sorted by filename (== chronological, the harness's own timestamp-prefixed
 *  naming convention). Real filesystem I/O -- this is local disk, never the network, so it
 *  is fine to exercise directly in tests against a temp directory (CLAUDE.md's "no live API
 *  in tests" rule is about the network, not the local filesystem). Missing directory ->
 *  empty list, same as latencyTable.ts's loadRuns. */
export async function listRunReports(reportsDir: string, sinceMs: number): Promise<ReportListing[]> {
  let entries: string[];
  try {
    entries = await readdir(reportsDir);
  } catch {
    return [];
  }
  const mdFiles = entries.filter((f) => f.endsWith('.md') && !f.endsWith('-rollup.md')).sort();

  const results: ReportListing[] = [];
  for (const fileName of mdFiles) {
    const fullPath = join(reportsDir, fileName);
    const info = await stat(fullPath);
    if (info.mtimeMs < sinceMs) continue;
    const text = await readFile(fullPath, 'utf-8');
    const { scenario, verdict } = parseReportFile(text, fileName);
    results.push({ file: fileName, scenario, verdict });
  }
  return results;
}

export function renderReportListing(reports: ReportListing[]): string {
  if (reports.length === 0) {
    return 'sim:friday: no report files found under scripts/rehearse/reports/ modified since this run started.';
  }
  const lines = [`sim:friday: ${String(reports.length)} report(s) from this run:`];
  for (const r of reports) lines.push(`  - ${r.file} -- scenario: ${r.scenario}, verdict: ${r.verdict}`);
  return lines.join('\n');
}

// ---------- orchestration (network/process boundary is the injected deps only) ----------

export interface SimFridayDeps {
  runBatchProcess: (argv: string[]) => Promise<{ exit_code: number }>;
  regenerateLatency: () => Promise<{ outputPath: string }>;
  listReports: (reportsDir: string, sinceMs: number) => Promise<ReportListing[]>;
  log: (line: string) => void;
}

export interface SimFridayResult {
  exit_code: number;
  reports: ReportListing[];
}

/** The one function that ties the three steps together. Takes its side effects as injected
 *  `deps` specifically so tests can supply fakes and exercise the full flow (dry-run short
 *  circuit, batch exit code pass-through, the report listing being filtered by
 *  `startedAtMs`) with zero network calls and zero spawned processes -- see
 *  scripts/rehearse/test/simFriday.test.ts. */
export async function runSimFriday(args: SimFridayArgs, deps: SimFridayDeps, startedAtMs: number = Date.now()): Promise<SimFridayResult> {
  if (args.dryRun) {
    deps.log(renderDryRunPlan(args));
    return { exit_code: 0, reports: [] };
  }

  deps.log(`sim:friday: (a) running ${String(JUDGE_SIM_SCENARIOS.length)} judge-sim scenarios (${String(buildBatchTotalRuns(args))} total call(s)) against ${args.url} via rehearse:batch.`);
  const batchResult = await deps.runBatchProcess(buildBatchArgv(args));

  deps.log('sim:friday: (b) regenerating docs/LATENCY.md.');
  const { outputPath } = await deps.regenerateLatency();
  deps.log(`sim:friday: wrote ${outputPath}`);

  deps.log('sim:friday: (c) listing this run\'s report files.');
  const reports = await deps.listReports(DEFAULT_REPORTS_DIR, startedAtMs);
  deps.log(renderReportListing(reports));

  return { exit_code: batchResult.exit_code, reports };
}

// ---------- I/O: spawning rehearseBatch.ts, the CLI entry point ----------

/** Spawns `npx tsx scripts/rehearse/rehearseBatch.ts <argv>` as a real child process,
 *  streaming its output live to this process's own stdout/stderr (the same shape
 *  rehearseBatch.ts itself uses for spawning run.ts) -- this is the ONLY function in this
 *  file that touches the network (indirectly, via the spawned process) or spawns anything.
 *  Everything above is pure or local-filesystem-only and covered by
 *  scripts/rehearse/test/simFriday.test.ts with injected fakes instead of this one. */
function spawnBatch(argv: string[]): Promise<{ exit_code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', BATCH_TS_PATH, ...argv], {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: 'inherit',
    });
    child.once('error', (err) => reject(err));
    child.once('close', (code) => resolve({ exit_code: code ?? 1 }));
  });
}

async function main(): Promise<void> {
  const parsed = parseSimArgs(process.argv.slice(2));
  if (!parsed.ok) {
    if (parsed.error === 'help') {
      console.log(printSimHelp());
      process.exitCode = 0;
      return;
    }
    console.error(parsed.error);
    process.exitCode = 2;
    return;
  }
  const { args } = parsed;
  const startedAtMs = Date.now();

  const result = await runSimFriday(
    args,
    {
      runBatchProcess: spawnBatch,
      regenerateLatency: generateLatencyTable,
      listReports: listRunReports,
      log: (line) => console.log(line),
    },
    startedAtMs,
  );

  process.exitCode = result.exit_code;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) void main();
