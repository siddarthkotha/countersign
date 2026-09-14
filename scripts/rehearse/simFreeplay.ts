#!/usr/bin/env -S npx tsx
// scripts/rehearse/simFreeplay.ts
// `npm run sim:freeplay -- --url <url> --model <id> --runs <n per case> [--seed <n>] [--dry-run]`
//
// Founder's definition of done (2026-09-14): "a judge speaking in their own words, with any
// pauses and pronunciation, must be understood and get the right outcome in every case. A
// scripted pass is not done." This is the one command that exercises that definition: it runs
// the ten judge-facing scenarios (below) through `--free-play` mode (freePlay.ts) via the
// EXISTING single-run harness (run.ts, one real live call per invocation -- this file never
// re-implements minting a session, opening the WebSocket, or running turns), SEQUENTIALLY
// (concurrency 1, one call at a time, same discipline rehearseBatch.ts already uses), and
// prints a pass table: case, runs, passes, fail reasons, report paths.
//
// Everything that touches the network or spawns a process lives in `spawnRunTs`/`main` at the
// bottom. Everything above that -- argument parsing, the plan (which run gets which seed and
// argv), output parsing, the pass-table renderer -- is pure and unit-tested with no network at
// all (scripts/rehearse/test/simFreeplay.test.ts), per CLAUDE.md's "tests must not need the
// network" rule, exactly the discipline simFriday.ts/rehearseBatch.ts already established.
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRunOutput } from './rehearseBatch.js';
import { deriveRunSeed } from './seededPause.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const RUN_TS_PATH = join(HERE, 'run.ts');
const REPORTS_DIR = join(HERE, 'reports');

/** The ten judge-facing free-play cases named in the founder's spec (2026-09-14), verbatim --
 *  every one already carries a `persona` rich enough to improvise (scripts/rehearse/scenarios/
 *  *.json), and hangup-after-request/miller-silent-after-amount's personas include the
 *  explicit instruction to go silent at their defined point. */
export const FREEPLAY_JUDGE_CASES = [
  'dana-patient',
  'miller-patient',
  'judge-out-of-scope',
  'identity-switch',
  'barge-in-interrupt',
  'single-wrong-answer',
  'hangup-after-request',
  'prompt-injection-midcall',
  'structuring-two-wires',
  'miller-silent-after-amount',
] as const;

// ---------- pure: argument parsing ----------

export interface SimFreeplayArgs {
  url: string;
  model: string;
  runsPerCase: number;
  /** Always a concrete number by the time this shape exists -- resolved from `--seed` when
   *  given, else derived from the injected clock (`now`) at parse time and recorded here so
   *  it can be logged/printed even when the founder never typed `--seed`. */
  seed: number;
  dryRun: boolean;
}

export type ParsedSimFreeplayArgs = { ok: true; args: SimFreeplayArgs; seedWasExplicit: boolean } | { ok: false; error: string };

export function parseSimFreeplayArgs(argv: string[], now: () => number = Date.now): ParsedSimFreeplayArgs {
  let url: string | undefined;
  let model: string | undefined;
  let runsPerCase: number | undefined;
  let seed: number | undefined;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') url = argv[++i];
    else if (a === '--model') model = argv[++i];
    else if (a === '--runs') runsPerCase = Number(argv[++i]);
    else if (a === '--seed') seed = Number(argv[++i]);
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--help' || a === '-h') return { ok: false, error: 'help' };
    else return { ok: false, error: `sim:freeplay: unrecognized argument "${a}" (--help for usage)` };
  }

  if (!url) {
    return { ok: false, error: 'sim:freeplay: --url <server-url> is required and is never inferred or defaulted, same rule the rest of the harness applies.' };
  }
  if (!model) {
    return { ok: false, error: 'sim:freeplay: --model <id> is required (an OpenRouter model id, or "gemini/<id>" for Gemini).' };
  }
  if (runsPerCase === undefined || !Number.isFinite(runsPerCase) || runsPerCase <= 0) {
    return { ok: false, error: 'sim:freeplay: --runs must be a positive number (runs PER case; there are 10 cases, so total live calls = 10 x --runs).' };
  }
  if (seed !== undefined && !Number.isFinite(seed)) {
    return { ok: false, error: 'sim:freeplay: --seed must be a number when given.' };
  }

  const seedWasExplicit = seed !== undefined;
  const resolvedSeed = (seed ?? now()) >>> 0;
  return { ok: true, args: { url, model, runsPerCase, seed: resolvedSeed, dryRun }, seedWasExplicit };
}

export function printSimFreeplayHelp(): string {
  return [
    'Countersign free-play judge-case runner -- runs the ten judge-facing scenarios through --free-play mode (an improvising LLM caller), sequentially, via the existing single-run harness (run.ts).',
    '',
    'Usage: npm run sim:freeplay -- --url <url> --model <id> --runs <n per case> [--seed <n>] [--dry-run]',
    '',
    '  --url URL     target server. REQUIRED -- never inferred, never a default.',
    '  --model ID    REQUIRED. An OpenRouter model id, or "gemini/<id>" for Gemini (same as run.ts --model).',
    '  --runs N      REQUIRED. Runs PER case (there are 10 cases) -- total live calls = 10 x N.',
    '  --seed N      base seed for reproducible pause sequences (default: derived from the current time; every run gets its own DERIVED seed from this base -- see seededPause.ts\'s deriveRunSeed -- so no two runs replay the identical pause sequence).',
    '  --dry-run     print the exact plan (every run\'s case, seed, and the run.ts command line it would spawn) and exit. No network, no spawned process, no credits.',
    '',
    `Cases run, in order (fixed): ${FREEPLAY_JUDGE_CASES.join(', ')}.`,
    '',
    'Every non-dry-run invocation spends real AssemblyAI credits AND real LLM-caller API spend (OpenRouter/Gemini), the same as running run.ts --free-play directly, 10 x --runs times over.',
  ].join('\n');
}

// ---------- pure: the plan ----------

export interface FreeplayPlannedRun {
  case: string;
  case_index: number;
  /** 1-based, within this case only (not a global run counter). */
  run_index: number;
  seed: number;
  /** The exact argv run.ts would be spawned with for this one run. */
  argv: string[];
}

/** Builds every planned run up front: for each of the 10 fixed cases, `args.runsPerCase`
 *  runs, each with its OWN seed derived from `args.seed` (seededPause.ts's `deriveRunSeed`)
 *  so `--seed 42 --runs 3` gives 30 distinct, still-fully-reproducible pause sequences instead
 *  of the same one repeated 30 times. Pure -- no I/O, no randomness of its own. */
export function buildFreeplayPlan(args: SimFreeplayArgs): FreeplayPlannedRun[] {
  const plan: FreeplayPlannedRun[] = [];
  FREEPLAY_JUDGE_CASES.forEach((caseName, caseIndex) => {
    for (let runIndex = 1; runIndex <= args.runsPerCase; runIndex++) {
      const seed = deriveRunSeed(args.seed, caseIndex, runIndex - 1);
      plan.push({
        case: caseName,
        case_index: caseIndex,
        run_index: runIndex,
        seed,
        argv: ['--url', args.url, '--scenario', caseName, '--free-play', '--model', args.model, '--seed', String(seed), '--max-calls', '1'],
      });
    }
  });
  return plan;
}

export function renderDryRunPlan(args: SimFreeplayArgs, plan: FreeplayPlannedRun[]): string {
  const lines: string[] = [];
  lines.push('sim:freeplay DRY RUN -- nothing below is executed. No network call, no spawned process, no credits spent.');
  lines.push('');
  lines.push(`Target: ${args.url}`);
  lines.push(`Model: ${args.model}`);
  lines.push(`Base seed: ${args.seed}`);
  lines.push(`Cases (${String(FREEPLAY_JUDGE_CASES.length)}): ${FREEPLAY_JUDGE_CASES.join(', ')}`);
  lines.push(`Runs per case: ${String(args.runsPerCase)} (total live calls: ${String(plan.length)})`);
  lines.push('');
  lines.push('Planned runs, in execution order (sequential, concurrency 1):');
  for (const p of plan) {
    lines.push(`  - ${p.case} run ${String(p.run_index)}/${String(args.runsPerCase)} (seed ${String(p.seed)}): npx tsx scripts/rehearse/run.ts ${p.argv.join(' ')}`);
  }
  return lines.join('\n');
}

// ---------- pure: parsing one run's stdout ----------

/** Same string this harness's own `report.ts` `oneLineSummary` always prints when a run
 *  fails with a distinct reason -- " reason=<fail_reason>" -- so this never needs to
 *  re-derive fail-reason logic, only read what run.ts already printed. */
export function parseFailReasonFromOutput(stdout: string): string | null {
  const m = /\breason=(\S+)/.exec(stdout);
  return m ? m[1]! : null;
}

/** Same "report=<path>" suffix `oneLineSummary` always prints, whether the run passed or
 *  failed. */
export function parseReportPathFromOutput(stdout: string): string | null {
  const m = /report=(\S+)/.exec(stdout);
  return m ? m[1]! : null;
}

// ---------- pure: rows -> per-case summary + pass table ----------

export interface FreeplayRunRow {
  case: string;
  run_index: number;
  pass: boolean | null;
  fail_reason: string | null;
  report_path: string | null;
  minutes_estimate: number | null;
}

export interface FreeplayCaseSummary {
  case: string;
  runs: number;
  passes: number;
  /** Unique fail reasons seen for this case, in first-seen order. */
  fail_reasons: string[];
  report_paths: string[];
}

export function summarizeByCase(rows: readonly FreeplayRunRow[]): FreeplayCaseSummary[] {
  const order: string[] = [];
  const byCase = new Map<string, FreeplayCaseSummary>();
  for (const row of rows) {
    let summary = byCase.get(row.case);
    if (!summary) {
      summary = { case: row.case, runs: 0, passes: 0, fail_reasons: [], report_paths: [] };
      byCase.set(row.case, summary);
      order.push(row.case);
    }
    summary.runs += 1;
    if (row.pass === true) summary.passes += 1;
    if (row.fail_reason && !summary.fail_reasons.includes(row.fail_reason)) summary.fail_reasons.push(row.fail_reason);
    if (row.report_path) summary.report_paths.push(row.report_path);
  }
  return order.map((c) => byCase.get(c)!);
}

export function renderPassTable(summaries: readonly FreeplayCaseSummary[]): string {
  const lines: string[] = [];
  lines.push('| case | runs | passes | fail reasons | report paths |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const s of summaries) {
    lines.push(
      `| ${s.case} | ${String(s.runs)} | ${String(s.passes)} | ${s.fail_reasons.length > 0 ? s.fail_reasons.join(', ') : '_none_'} | ${s.report_paths.length > 0 ? s.report_paths.join('<br>') : '_none_'} |`,
    );
  }
  return lines.join('\n');
}

export function renderFreeplayRollup(args: SimFreeplayArgs, rows: readonly FreeplayRunRow[], summaries: readonly FreeplayCaseSummary[], startedAtIso: string, endedAtIso: string): string {
  const lines: string[] = [];
  lines.push('# Free-play judge-case roll-up');
  lines.push('');
  lines.push(`Target: ${args.url}`);
  lines.push(`Model: ${args.model}, base seed: ${String(args.seed)}`);
  lines.push(`Cases: ${FREEPLAY_JUDGE_CASES.join(', ')}`);
  lines.push(`Runs per case: ${String(args.runsPerCase)} (total: ${String(rows.length)})`);
  lines.push(`Started: ${startedAtIso}`);
  lines.push(`Ended: ${endedAtIso}`);
  lines.push('');
  lines.push('## Pass table');
  lines.push('');
  lines.push(renderPassTable(summaries));
  lines.push('');
  const totalMinutes = rows.reduce((sum, r) => sum + (r.minutes_estimate ?? 0), 0);
  lines.push('## Credits (ESTIMATE, not read from AssemblyAI billing)');
  lines.push('');
  lines.push('- Method: sum of each run\'s own wall-clock ESTIMATE (parsed from that run\'s stdout); the actual AssemblyAI/LLM-provider billing units are UNKNOWN to this script.');
  lines.push(`- ESTIMATE: ~${totalMinutes.toFixed(2)} total AssemblyAI minutes streamed across this batch (LLM-caller API spend is separate and not measured here).`);
  lines.push('');
  return lines.join('\n');
}

// ---------- orchestration (network/process boundary is the injected executor only) ----------

export type FreeplayCaseExecutor = (planned: FreeplayPlannedRun) => Promise<{ stdout: string; exit_code: number }>;

/** Runs every planned entry SEQUENTIALLY (concurrency 1 -- one live call at a time, spec item
 *  4's own requirement), through the injected executor, parsing each run's own stdout the
 *  same way rehearseBatch.ts already does (`parseRunOutput`, reused unmodified) plus this
 *  file's own fail-reason/report-path parsing. */
export async function runFreeplayPlan(plan: readonly FreeplayPlannedRun[], executor: FreeplayCaseExecutor, log: (line: string) => void = () => {}): Promise<FreeplayRunRow[]> {
  const rows: FreeplayRunRow[] = [];
  for (let i = 0; i < plan.length; i++) {
    const planned = plan[i]!;
    log(`sim:freeplay: run ${String(i + 1)}/${String(plan.length)} -- ${planned.case} (seed ${String(planned.seed)})`);
    const { stdout, exit_code } = await executor(planned);
    const parsed = parseRunOutput(stdout);
    const pass = parsed.pass !== null ? parsed.pass : exit_code === 0 ? null : false;
    rows.push({
      case: planned.case,
      run_index: planned.run_index,
      pass,
      fail_reason: pass === false ? parseFailReasonFromOutput(stdout) : null,
      report_path: parseReportPathFromOutput(stdout),
      minutes_estimate: parsed.minutes_estimate,
    });
  }
  return rows;
}

export interface SimFreeplayDeps {
  runCase: FreeplayCaseExecutor;
  log: (line: string) => void;
}

export interface SimFreeplayResult {
  exit_code: number;
  plan: FreeplayPlannedRun[];
  rows: FreeplayRunRow[];
  summaries: FreeplayCaseSummary[];
}

/** The one function that ties the plan + execution + summary together -- takes its side
 *  effects as injected `deps` specifically so tests can supply a fake executor and exercise
 *  the full flow (dry-run short circuit, per-case pass/fail aggregation, the pass table) with
 *  zero network calls and zero spawned processes -- see
 *  scripts/rehearse/test/simFreeplay.test.ts. */
export async function runSimFreeplay(args: SimFreeplayArgs, deps: SimFreeplayDeps): Promise<SimFreeplayResult> {
  const plan = buildFreeplayPlan(args);

  if (args.dryRun) {
    deps.log(renderDryRunPlan(args, plan));
    return { exit_code: 0, plan, rows: [], summaries: [] };
  }

  deps.log(
    `sim:freeplay: running ${String(plan.length)} live call(s) (${String(FREEPLAY_JUDGE_CASES.length)} case(s) x ${String(args.runsPerCase)} run(s)) against ${args.url} with model ${args.model}, base seed ${String(args.seed)}, sequentially.`,
  );
  const rows = await runFreeplayPlan(plan, deps.runCase, deps.log);
  const summaries = summarizeByCase(rows);
  deps.log('');
  deps.log(renderPassTable(summaries));

  const anyFail = rows.some((r) => r.pass !== true);
  return { exit_code: anyFail ? 1 : 0, plan, rows, summaries };
}

// ---------- I/O: spawning run.ts, writing the rollup, the CLI entry point ----------

function timestampForFilename(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

/** Spawns `npx tsx scripts/rehearse/run.ts <argv>` as a real child process, streaming its
 *  output live (same pattern rehearseBatch.ts's own `spawnRun` uses) while buffering it for
 *  `parseRunOutput`/`parseFailReasonFromOutput`/`parseReportPathFromOutput`. The ONLY function
 *  in this file that touches the network (indirectly) or a live server. */
function spawnRunTs(planned: FreeplayPlannedRun): Promise<{ stdout: string; exit_code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', RUN_TS_PATH, ...planned.argv], { cwd: REPO_ROOT, env: process.env });
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
  const parsed = parseSimFreeplayArgs(process.argv.slice(2));
  if (!parsed.ok) {
    if (parsed.error === 'help') {
      console.log(printSimFreeplayHelp());
      process.exitCode = 0;
      return;
    }
    console.error(parsed.error);
    process.exitCode = 2;
    return;
  }
  const { args } = parsed;
  const startedAtIso = new Date().toISOString();

  const result = await runSimFreeplay(args, { runCase: spawnRunTs, log: (line) => console.log(line) });

  if (!args.dryRun) {
    const endedAtIso = new Date().toISOString();
    await mkdir(REPORTS_DIR, { recursive: true });
    const rollupPath = join(REPORTS_DIR, `${timestampForFilename()}-freeplay-rollup.md`);
    await writeFile(rollupPath, renderFreeplayRollup(args, result.rows, result.summaries, startedAtIso, endedAtIso), 'utf-8');
    console.log(`sim:freeplay: roll-up written to ${rollupPath}`);
  }

  process.exitCode = result.exit_code;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) void main();
