#!/usr/bin/env -S npx tsx
// scripts/rehearse/rehearseBatch.ts
// `npm run rehearse:batch -- --url <url> --runs <n> --scenarios a,b,c --max-minutes <m>`
//
// Round-robins the given scenario names through the EXISTING single-run harness
// (scripts/rehearse/run.ts, one real live call per invocation -- this file never re-implements
// minting a session, opening the WebSocket, or running turns) sequentially, stopping at the
// run count, the summed estimated-minutes cap, or a server-side daily_cap refusal, whichever
// comes first. Writes one rollup markdown, then regenerates docs/LATENCY.md from whatever
// diagnostics bundles exist on disk afterward (scripts/rehearse/latencyTable.ts).
//
// Everything that touches the network or spawns a process lives in `main()`/`spawnRun()` at
// the bottom. Everything above that -- scheduling, the stop-condition check, output parsing,
// the rollup renderer -- is pure and unit-tested with no network at all
// (scripts/rehearse/test/rehearseBatch.test.ts), per CLAUDE.md's own rule that a test must
// never call the live API.
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_REPORTS_DIR, generateLatencyTable } from './latencyTable.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const RUN_TS_PATH = join(HERE, 'run.ts');

// ---------- pure: argument parsing ----------

export interface BatchArgs {
  url: string;
  runs: number;
  scenarios: string[];
  maxMinutes: number;
}

export type ParsedBatchArgs = { ok: true; args: BatchArgs } | { ok: false; error: string };

/** No defaults anywhere -- every one of these four flags is required, spelled out on the
 *  command line, same discipline run.ts already applies to `--url` alone (never inferred,
 *  never a fallback to localhost) but total here: a batch run is many live calls, so nothing
 *  about its shape is guessed. */
export function parseBatchArgs(argv: string[]): ParsedBatchArgs {
  let url: string | undefined;
  let runs: number | undefined;
  let scenarios: string[] | undefined;
  let maxMinutes: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') url = argv[++i];
    else if (a === '--runs') runs = Number(argv[++i]);
    else if (a === '--scenarios') {
      scenarios = (argv[++i] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    } else if (a === '--max-minutes') maxMinutes = Number(argv[++i]);
    else if (a === '--help' || a === '-h') return { ok: false, error: 'help' };
    else return { ok: false, error: `rehearse:batch: unrecognized argument "${a}" (--help for usage)` };
  }

  if (!url) {
    return {
      ok: false,
      error:
        'rehearse:batch: refusing to start -- --url <server-url> is required and is never inferred or defaulted, the same rule the single-run harness applies. Pass the exact server you mean, e.g. --url https://countersign-bf8q.onrender.com or --url http://localhost:8787.',
    };
  }
  if (runs === undefined || !Number.isFinite(runs) || runs <= 0) {
    return { ok: false, error: 'rehearse:batch: --runs must be a positive number (the total number of live calls this batch will make, before any cap trims it).' };
  }
  if (!scenarios || scenarios.length === 0) {
    return { ok: false, error: 'rehearse:batch: --scenarios must be a non-empty comma-separated list of scenario names, e.g. --scenarios scenario-a-dana-legitimate,scenario-b-miller-fraud' };
  }
  if (maxMinutes === undefined || !Number.isFinite(maxMinutes) || maxMinutes <= 0) {
    return { ok: false, error: 'rehearse:batch: --max-minutes must be a positive number (the estimated-minutes ceiling for the whole batch, summed from each run\'s own wall-clock ESTIMATE).' };
  }
  return { ok: true, args: { url, runs, scenarios, maxMinutes } };
}

export function printBatchHelp(): string {
  return [
    'Countersign batch rehearsal runner -- round-robins scenarios through the single-run harness (run.ts), sequentially.',
    '',
    'Usage: npm run rehearse:batch -- --url <url> --runs <n> --scenarios a,b,c --max-minutes <m>',
    '',
    '  --url URL          target server. REQUIRED -- never inferred, never a default (same rule run.ts applies to a non-local URL).',
    '  --runs N           total number of live calls to attempt, round-robin across --scenarios, before any cap trims it. REQUIRED.',
    '  --scenarios LIST   comma-separated scenario names (scripts/rehearse/scenarios/*.json, without .json). REQUIRED.',
    '  --max-minutes M    stop once the summed ESTIMATE of minutes streamed across completed runs reaches M. REQUIRED.',
    '',
    'Stops early, before the --runs count, on: the --max-minutes cap being reached, or the server refusing a fresh session with reason "daily_cap" (the server\'s own COUNTERSIGN_DAILY_CAP, default 40 sessions/day -- packages/server/src/config.ts).',
    '',
    'Every call this makes spends real AssemblyAI credits, the same as running run.ts directly, --runs times over.',
  ].join('\n');
}

// ---------- pure: scheduling ----------

/** Round-robins `scenarios` up to `runs` total entries: ["a","b","c"], 7 -> a,b,c,a,b,c,a.
 *  Empty `scenarios` -> empty schedule (the caller's argument validation should have already
 *  refused this; this function just never produces something impossible from nothing). */
export function buildRoundRobinSchedule(scenarios: string[], runs: number): string[] {
  if (scenarios.length === 0 || runs <= 0) return [];
  const schedule: string[] = [];
  for (let i = 0; i < runs; i++) schedule.push(scenarios[i % scenarios.length]!);
  return schedule;
}

// ---------- pure: stop-condition check ----------

export interface BatchProgress {
  completedRuns: number;
  totalMinutes: number;
}

export interface BatchCaps {
  maxRuns: number;
  maxMinutes: number;
}

export type StopReason = 'run_cap' | 'minute_cap' | null;

/** Checked BEFORE starting each scheduled run (never mid-run -- a call in flight always
 *  finishes). `maxRuns` is a belt-and-suspenders check: buildRoundRobinSchedule already
 *  produces exactly `runs` entries, so in practice this only ever fires on the minute cap; it
 *  is still checked explicitly so this function stays correct even if a caller schedules more
 *  entries than `runs` for some other reason. */
export function nextStopDecision(progress: BatchProgress, caps: BatchCaps): { stop: boolean; reason: StopReason } {
  if (progress.completedRuns >= caps.maxRuns) return { stop: true, reason: 'run_cap' };
  if (progress.totalMinutes >= caps.maxMinutes) return { stop: true, reason: 'minute_cap' };
  return { stop: false, reason: null };
}

// ---------- pure: parsing one run's stdout ----------

export interface ParsedRunOutput {
  /** true/false from the run's own "[PASS] ..."/"[FAIL] ..." summary line; null if that line
   *  never appeared at all (a protocol error before any scenario summary printed). */
  pass: boolean | null;
  /** From the run's own final "ESTIMATE: ~X total minutes" line; null if absent (the process
   *  crashed, or printed nothing recognizable). */
  minutes_estimate: number | null;
  /** True the moment the string "daily_cap" appears anywhere in the output -- that's exactly
   *  how a refused mintSession surfaces (wsClient.ts's mintSession throws with the server's
   *  own `{"replay_only":true,"reason":"daily_cap"}` body embedded in the message, and run.ts
   *  prints that message as a "warning: ..." line). */
  daily_cap_hit: boolean;
}

export function parseRunOutput(stdout: string): ParsedRunOutput {
  const passMatch = /^\[(PASS|FAIL)\]/m.exec(stdout);
  const minutesMatch = /ESTIMATE: ~([\d.]+) total minutes/.exec(stdout);
  return {
    pass: passMatch ? passMatch[1] === 'PASS' : null,
    minutes_estimate: minutesMatch ? Number(minutesMatch[1]) : null,
    daily_cap_hit: stdout.includes('daily_cap'),
  };
}

// ---------- orchestration (network/process boundary is the injected executor only) ----------

export interface RunExecResult {
  stdout: string;
  exit_code: number;
}

export type RunExecutor = (scenario: string, url: string) => Promise<RunExecResult>;

export interface BatchRow {
  run_index: number;
  scenario: string;
  pass: boolean | null;
  minutes_estimate: number | null;
}

export interface BatchResult {
  rows: BatchRow[];
  total_minutes: number;
  runs_executed: number;
  runs_scheduled: number;
  stop_reason: 'completed' | 'run_cap' | 'minute_cap' | 'daily_cap';
}

/** The one function that ties scheduling + the stop check + output parsing together. Takes
 *  its executor as a parameter specifically so tests can supply a fake one and exercise the
 *  full loop (round-robin order, minute-cap cutoff mid-batch, a daily_cap refusal partway
 *  through) with zero network calls -- see scripts/rehearse/test/rehearseBatch.test.ts. */
export async function runBatch(args: BatchArgs, executor: RunExecutor, log: (line: string) => void = () => {}): Promise<BatchResult> {
  const schedule = buildRoundRobinSchedule(args.scenarios, args.runs);
  const rows: BatchRow[] = [];
  let totalMinutes = 0;
  let stopReason: BatchResult['stop_reason'] = 'completed';

  for (let i = 0; i < schedule.length; i++) {
    const decision = nextStopDecision({ completedRuns: rows.length, totalMinutes }, { maxRuns: args.runs, maxMinutes: args.maxMinutes });
    if (decision.stop) {
      stopReason = decision.reason === 'minute_cap' ? 'minute_cap' : 'run_cap';
      break;
    }

    const scenario = schedule[i]!;
    log(`rehearse:batch: run ${String(i + 1)}/${String(schedule.length)} -- ${scenario} (running minutes so far: ${totalMinutes.toFixed(2)}/${String(args.maxMinutes)})`);
    const { stdout, exit_code } = await executor(scenario, args.url);
    const parsed = parseRunOutput(stdout);

    if (parsed.daily_cap_hit) {
      log('rehearse:batch: server refused a fresh session with reason "daily_cap" -- stopping. The founder\'s daily session cap (COUNTERSIGN_DAILY_CAP, default 40) has been reached; try again after the server\'s day boundary, or raise the cap on the server if this was intentional.');
      stopReason = 'daily_cap';
      break;
    }

    totalMinutes += parsed.minutes_estimate ?? 0;
    const pass = parsed.pass !== null ? parsed.pass : exit_code === 0 ? null : false;
    rows.push({ run_index: i + 1, scenario, pass, minutes_estimate: parsed.minutes_estimate });
  }

  return { rows, total_minutes: totalMinutes, runs_executed: rows.length, runs_scheduled: schedule.length, stop_reason: stopReason };
}

// ---------- pure: rollup rendering ----------

export function renderBatchRollup(args: BatchArgs, result: BatchResult, startedAtIso: string, endedAtIso: string): string {
  const lines: string[] = [];
  lines.push('# Batch rehearsal roll-up');
  lines.push('');
  lines.push(`Target: ${args.url}`);
  lines.push(`Scenarios (round-robin order): ${args.scenarios.join(', ')}`);
  lines.push(`Requested runs: ${args.runs}, max minutes cap: ${args.maxMinutes}`);
  lines.push(`Started: ${startedAtIso}`);
  lines.push(`Ended: ${endedAtIso}`);
  lines.push(`Runs scheduled: ${result.runs_scheduled}, runs executed: ${result.runs_executed}`);
  lines.push(`Stop reason: ${result.stop_reason}`);
  lines.push('');
  lines.push('## Pass/fail per run');
  lines.push('');
  lines.push('| run | scenario | result | minutes (ESTIMATE) |');
  lines.push('| --- | --- | --- | --- |');
  for (const row of result.rows) {
    const resultLabel = row.pass === true ? 'PASS' : row.pass === false ? 'FAIL' : 'UNKNOWN (no summary line parsed)';
    lines.push(`| ${row.run_index} | ${row.scenario} | ${resultLabel} | ${row.minutes_estimate === null ? 'UNKNOWN' : row.minutes_estimate.toFixed(2)} |`);
  }
  lines.push('');
  lines.push('## Credits (ESTIMATE, not read from AssemblyAI billing)');
  lines.push('');
  lines.push('- Method: sum of each run\'s own wall-clock ESTIMATE (parsed from that run\'s stdout, itself computed by run.ts from connect-to-end wall time); the actual AssemblyAI billing unit is UNKNOWN to this script.');
  lines.push(`- ESTIMATE: ~${result.total_minutes.toFixed(2)} total minutes streamed across this batch.`);
  lines.push('');
  return lines.join('\n');
}

// ---------- I/O: spawning run.ts, writing files, the CLI entry point ----------

function timestampForFilename(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

/** Spawns `npx tsx scripts/rehearse/run.ts --url <url> --scenario <name> --max-calls 1` as a
 *  real child process, streaming its output to this process's own stdout/stderr live (so a
 *  founder watching a 30-run batch sees exactly what a single `npm run rehearse` run would
 *  show, run after run) while also buffering it for parseRunOutput. This is the ONLY function
 *  in this file that touches the network (indirectly, via the spawned process) or a live
 *  server -- everything above is pure and covered by scripts/rehearse/test/rehearseBatch.test.ts
 *  with an injected fake executor instead of this one. */
function spawnRun(scenario: string, url: string): Promise<RunExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', RUN_TS_PATH, '--url', url, '--scenario', scenario, '--max-calls', '1'], {
      cwd: REPO_ROOT,
      env: process.env,
    });
    let buffered = '';
    child.stdout.on('data', (chunk: Buffer) => {
      process.stdout.write(chunk);
      buffered += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
      buffered += chunk.toString();
    });
    child.once('error', (err) => reject(err));
    child.once('close', (code) => resolve({ stdout: buffered, exit_code: code ?? 1 }));
  });
}

async function main(): Promise<void> {
  const parsed = parseBatchArgs(process.argv.slice(2));
  if (!parsed.ok) {
    if (parsed.error === 'help') {
      console.log(printBatchHelp());
      process.exitCode = 0;
      return;
    }
    console.error(parsed.error);
    process.exitCode = 2;
    return;
  }
  const { args } = parsed;

  // Same credits disclosure the single-run harness prints (run.ts:337), unconditionally here
  // because a batch is many live calls no matter which URL was named.
  console.log(`rehearse:batch: targeting ${args.url} explicitly named on the command line. Proceeding -- every call below spends real AssemblyAI credits, up to ${args.runs} call(s) or ${args.maxMinutes} estimated minute(s), whichever comes first.`);

  const startedAtIso = new Date().toISOString();
  const result = await runBatch(args, spawnRun, (line) => console.log(line));
  const endedAtIso = new Date().toISOString();

  console.log(`rehearse:batch: ${result.runs_executed}/${result.runs_scheduled} run(s) executed, stop reason: ${result.stop_reason}, ESTIMATE ~${result.total_minutes.toFixed(2)} total minutes.`);

  await mkdir(DEFAULT_REPORTS_DIR, { recursive: true });
  const rollupPath = join(DEFAULT_REPORTS_DIR, `${timestampForFilename()}-batch-rollup.md`);
  await writeFile(rollupPath, renderBatchRollup(args, result, startedAtIso, endedAtIso), 'utf-8');
  console.log(`rehearse:batch: roll-up written to ${rollupPath}`);

  const { outputPath } = await generateLatencyTable();
  console.log(`rehearse:batch: regenerated ${outputPath}`);

  const anyFail = result.rows.some((r) => r.pass === false);
  process.exitCode = anyFail ? 1 : 0;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) void main();
