#!/usr/bin/env -S npx tsx
// scripts/rehearse/run.ts
// Entry point: `npx tsx scripts/rehearse/run.ts [--url URL] [--scenario NAME|all] [--repeat N]
// [--voice NAME] [--caller reactive|llm] [--model MODEL_ID] [--max-calls N]`
// or `npm run rehearse -- --scenario scenario-a-dana-legitimate`.
//
// Plays a synthetic caller against the REAL live stack (a real server, a real AssemblyAI
// Voice Agent connection) with no human and no browser. Two caller modes:
//  - `--caller reactive` (default): a scripted caller whose lines react to the live agent's
//    actual words, per scenario file (scripts/rehearse/scenarios/*.json's `truth`/`respond`)
//    -- see truthEngine.ts.
//  - `--caller llm --model <id>`: an external model plays the caller live, from the
//    scenario's `persona` field -- see llmCaller.ts. `<id>` is an OpenRouter model id
//    (OPENROUTER_API_KEY) unless prefixed `gemini/`, which uses Gemini's own API
//    (GEMINI_API_KEY) instead. Both keys are read from `process.env` only -- same convention
//    as ASSEMBLYAI_API_KEY: export them into the shell first (docs/REHEARSAL-HARNESS.md).
//
// This is a TEST HARNESS (BRIEF LAW 5 scope fence): it never claims to detect
// synthetic/deepfake voices (LAW 1), and it is never imported by product code under packages/.
//
// Every run costs real AssemblyAI minutes on the founder's credits -- see the printed
// ESTIMATE after each call and the total at the end. Defaults to the local server; running
// against the deployed URL requires spelling it out explicitly with --url (never inferred,
// never a default).
import { mintSession, connectCall, fetchDiagnostics } from './wsClient.js';
import { loadScenario, loadAllScenarios, ScenarioValidationError } from './scenario.js';
import { runTurns, runLlmTurns, computeTurnGaps, waitForVerdict, waitForCountersignSettle } from './turnController.js';
import { summarizeDiagnostics } from './diagnosticsSummary.js';
import { renderReport, renderRollup, oneLineSummary, reportFileName, rollupFileName } from './report.js';
import { resolveLlmConfig, getApiKey, apiKeyEnvVarFor, nodeFetchHttpClient } from './llmCaller.js';
import type { LlmProvider, ResolvedLineRecord, RollupResult, RollupRow, RunResult, Scenario, StateHistoryRecord, TranscriptRecord } from './types.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = join(HERE, 'reports');

const DEFAULT_URL = 'http://localhost:8787';
/** Ceiling on waiting for the socket's first `state` event (proof the call is live) --
 *  distinct from any scenario's own `expected.max_wall_ms`. */
const READY_TIMEOUT_MS = 20_000;
const ENDED_TIMEOUT_MS = 8_000;
/** Defaults for the LLM caller's own caps (turnController.ts's `LlmTurnCaps`) -- deliberately
 *  independent of any scenario's `expected.max_wall_ms`, since a live model can meander in a
 *  way a fixed script never could. */
const DEFAULT_LLM_MAX_TURNS = 12;
const DEFAULT_LLM_MAX_WALL_MS = 180_000;
const DEFAULT_LLM_MAX_WORDS_PER_LINE = 30;

interface CliArgs {
  url: string;
  scenario: string; // a scenario name, or "all"
  repeat: number;
  voice?: string;
  caller: 'reactive' | 'llm';
  model?: string;
  maxCalls?: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { url: DEFAULT_URL, scenario: 'all', repeat: 1, caller: 'reactive' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') args.url = argv[++i] ?? args.url;
    else if (a === '--scenario') args.scenario = argv[++i] ?? args.scenario;
    else if (a === '--repeat') args.repeat = Number(argv[++i] ?? '1') || 1;
    else if (a === '--voice') {
      const v = argv[++i];
      if (v !== undefined) args.voice = v;
    } else if (a === '--caller') {
      const v = argv[++i];
      if (v === 'reactive' || v === 'llm') args.caller = v;
      else {
        console.error(`rehearse: --caller must be "reactive" or "llm", got ${JSON.stringify(v)}`);
        process.exit(2);
      }
    } else if (a === '--model') {
      const v = argv[++i];
      if (v !== undefined) args.model = v;
    } else if (a === '--max-calls') {
      args.maxCalls = Number(argv[++i] ?? '');
      if (!Number.isFinite(args.maxCalls) || args.maxCalls! <= 0) {
        console.error('rehearse: --max-calls must be a positive number');
        process.exit(2);
      }
    } else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else {
      console.error(`rehearse: unrecognized argument "${a}" (--help for usage)`);
      process.exit(2);
    }
  }
  return args;
}

function printHelp(): void {
  console.log(
    [
      'Countersign rehearsal harness -- plays a synthetic caller against the real live stack.',
      '',
      'Usage: npm run rehearse -- [--url URL] [--scenario NAME|all] [--repeat N] [--voice NAME]',
      '                           [--caller reactive|llm] [--model MODEL_ID] [--max-calls N]',
      '',
      `  --url URL        target server (default ${DEFAULT_URL}). Must be spelled out explicitly to hit the deployed site.`,
      '  --scenario NAME  a scenario file name under scripts/rehearse/scenarios/ (without .json), or "all" (default).',
      '  --repeat N       run each selected scenario N times in a row, sequentially (default 1). For G2: --scenario scenario-b-miller-fraud --repeat 2',
      '  --voice NAME     macOS `say` voice for the synthetic caller (default: Samantha, or COUNTERSIGN_REHEARSE_VOICE).',
      '  --caller MODE    "reactive" (default, no network beyond our own server) or "llm" (an external model plays the caller live).',
      '  --model ID       required with --caller llm. An OpenRouter model id (needs OPENROUTER_API_KEY), or "gemini/<id>" for Gemini (needs GEMINI_API_KEY).',
      '  --max-calls N    hard cap on the number of live calls this invocation will make (guards --scenario all --repeat N from an unbounded credit spend).',
      '',
      'Exit codes: 0 every run passed; 1 at least one run failed its expected verdict/timing; 2 a protocol/connection error occurred (including a missing API key for --caller llm).',
    ].join('\n'),
  );
}

async function runOne(
  scenario: Scenario,
  url: string,
  voice: string | undefined,
  callerMode: 'reactive' | 'llm',
  llm: { provider: LlmProvider; model: string; apiKey: string } | undefined,
): Promise<RunResult> {
  const startedAtIso = new Date().toISOString();
  const warnings: string[] = [];

  let session;
  try {
    session = await mintSession(url);
  } catch (err) {
    return protocolErrorResult(scenario, url, startedAtIso, callerMode, `could not mint a session: ${err instanceof Error ? err.message : String(err)}`);
  }

  let client;
  try {
    client = await connectCall(url, session.ws_path);
  } catch (err) {
    return protocolErrorResult(
      scenario,
      url,
      startedAtIso,
      callerMode,
      `could not open the call WebSocket: ${err instanceof Error ? err.message : String(err)}`,
      session.session_id,
    );
  }

  client.send({ type: 'start' });

  // "Ready" = the first `state` ServerEvent -- the earliest signal on the wire that the call
  // is live (same convention packages/web/src/screens/Call.tsx:267-274 uses for its own
  // "start -> ready" timing).
  const readyDeadline = performance.now() + READY_TIMEOUT_MS;
  while (client.latestState() === null && performance.now() < readyDeadline) {
    await new Promise((r) => setTimeout(r, 40));
  }
  if (client.latestState() === null) {
    client.close();
    return protocolErrorResult(scenario, url, startedAtIso, callerMode, `no "state" event within ${READY_TIMEOUT_MS}ms of connecting`, session.session_id);
  }
  const readyMs = client.stateHistory[0]!.t_ms;
  const firstAudioMs = client.audioTimestamps.length > 0 ? client.audioTimestamps[0]! - readyMs : null;

  let callerEndTimes: { turn_id: string; caller_end_ms: number; barge_in: boolean }[];
  let resolvedLines: ResolvedLineRecord[];
  if (callerMode === 'llm') {
    if (!llm) throw new Error('runOne: --caller llm requires an llm config');
    const outcome = await runLlmTurns(
      client,
      scenario,
      llm.provider,
      llm.model,
      llm.apiKey,
      { max_turns: DEFAULT_LLM_MAX_TURNS, max_wall_ms: DEFAULT_LLM_MAX_WALL_MS, max_words_per_line: DEFAULT_LLM_MAX_WORDS_PER_LINE },
      nodeFetchHttpClient,
      voice,
    );
    warnings.push(...outcome.warnings);
    callerEndTimes = outcome.callerEndTimes;
    resolvedLines = outcome.resolvedLines;
  } else {
    const outcome = await runTurns(client, scenario, voice);
    warnings.push(...outcome.warnings);
    callerEndTimes = outcome.callerEndTimes;
    resolvedLines = outcome.resolvedLines;
  }

  const remainingMs = Math.max(1000, scenario.expected.max_wall_ms - (performance.now() - client.startedAt));
  const verdictResult = await waitForVerdict(client, remainingMs);
  if (!verdictResult.reached) {
    warnings.push(`no terminal verdict within the scenario's max_wall_ms (${scenario.expected.max_wall_ms}ms)`);
  } else {
    await waitForCountersignSettle(client);
  }

  const finalState = client.latestState();
  const transcript: TranscriptRecord[] = finalState
    ? finalState.transcript.map((l) => ({ speaker: l.speaker, text: l.text, t_ms: l.t_ms, ...(l.interrupted ? { interrupted: true } : {}) }))
    : [];
  const stateHistory: StateHistoryRecord[] = client.stateHistory.map((s) => ({
    t_ms: s.t_ms,
    state: s.state.state,
    verdict: s.state.verdict,
    agent_status: s.state.agent_status,
  }));

  client.send({ type: 'end' });
  const endedReason = await client.waitForEnded(ENDED_TIMEOUT_MS);
  if (endedReason === null) warnings.push(`no "ended" event within ${ENDED_TIMEOUT_MS}ms of sending end; closing the socket anyway`);
  client.close();

  const totalWallMs = performance.now() - client.startedAt;

  const bundle = await fetchDiagnostics(url, session.session_id);
  const diagnostics = summarizeDiagnostics(bundle);

  const turnGaps = computeTurnGaps(client, callerEndTimes);

  const actualVerdict = verdictResult.verdict;
  const pass = verdictResult.reached && actualVerdict === scenario.expected.verdict;

  const minutesEstimate = totalWallMs / 60000;

  return {
    scenario,
    target_url: url,
    session_id: session.session_id,
    started_at_iso: startedAtIso,
    ended_reason: endedReason,
    verdict_reached: verdictResult.reached,
    actual_verdict: actualVerdict,
    pass,
    timings: {
      ready_ms: readyMs,
      first_audio_ms: firstAudioMs,
      turn_gaps: turnGaps,
      total_wall_ms: totalWallMs,
    },
    transcript,
    state_history: stateHistory,
    diagnostics,
    warnings,
    exit_code: pass ? 0 : 1,
    minutes_estimate: minutesEstimate,
    resolved_lines: resolvedLines,
    caller_mode: callerMode,
  };
}

function protocolErrorResult(
  scenario: Scenario,
  url: string,
  startedAtIso: string,
  callerMode: 'reactive' | 'llm',
  message: string,
  sessionId = 'none',
): RunResult {
  return {
    scenario,
    target_url: url,
    session_id: sessionId,
    started_at_iso: startedAtIso,
    ended_reason: null,
    verdict_reached: false,
    actual_verdict: null,
    pass: false,
    timings: { ready_ms: null, first_audio_ms: null, turn_gaps: [], total_wall_ms: 0 },
    transcript: [],
    state_history: [],
    diagnostics: { ok: false, error: 'no diagnostics: the call never connected' },
    warnings: [message],
    exit_code: 2,
    minutes_estimate: 0,
    resolved_lines: [],
    caller_mode: callerMode,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let llm: { provider: LlmProvider; model: string; apiKey: string } | undefined;
  if (args.caller === 'llm') {
    if (!args.model) {
      console.error('rehearse: --caller llm requires --model <id> (an OpenRouter model id, or "gemini/<id>" for Gemini)');
      process.exitCode = 2;
      return;
    }
    const { provider, model } = resolveLlmConfig(args.model);
    const apiKey = getApiKey(provider);
    if (!apiKey) {
      console.error(`rehearse: --caller llm needs ${apiKeyEnvVarFor(provider)} set in the environment (export it from .env first: set -a; source .env; set +a). No key found -- not making any network call.`);
      process.exitCode = 2;
      return;
    }
    llm = { provider, model, apiKey };
  }

  let scenarios: Scenario[];
  try {
    scenarios = args.scenario === 'all' ? await loadAllScenarios() : [await loadScenario(args.scenario)];
  } catch (err) {
    if (err instanceof ScenarioValidationError) {
      console.error(`rehearse: ${err.message}`);
      process.exitCode = 2;
      return;
    }
    throw err;
  }

  if (args.caller === 'llm') {
    const missingPersona = scenarios.filter((s) => !s.persona);
    if (missingPersona.length > 0) {
      console.error(`rehearse: --caller llm requires a "persona" field on every selected scenario; missing on: ${missingPersona.map((s) => s.name).join(', ')}`);
      process.exitCode = 2;
      return;
    }
  }

  if (args.url !== DEFAULT_URL && !args.url.includes('localhost') && !args.url.includes('127.0.0.1')) {
    console.log(`rehearse: targeting a NON-local URL (${args.url}) explicitly named on the command line. Proceeding -- every call below spends real AssemblyAI credits.`);
  }

  const totalPlannedCalls = scenarios.length * args.repeat;
  if (args.maxCalls !== undefined && totalPlannedCalls > args.maxCalls) {
    console.error(
      `rehearse: this invocation would make ${totalPlannedCalls} calls (${scenarios.length} scenario(s) x ${args.repeat} repeat(s)), which exceeds --max-calls ${args.maxCalls}. Refusing to start any call. Lower --repeat, select fewer scenarios, or raise --max-calls.`,
    );
    process.exitCode = 2;
    return;
  }

  await mkdir(REPORTS_DIR, { recursive: true });

  let worstExit: 0 | 1 | 2 = 0;
  let totalMinutes = 0;
  let runCount = 0;
  const rollupRows: RollupRow[] = [];
  const batchStartedAtIso = new Date().toISOString();

  for (const scenario of scenarios) {
    for (let i = 0; i < args.repeat; i++) {
      runCount += 1;
      if (args.repeat > 1) console.log(`rehearse: ${scenario.name} run ${i + 1}/${args.repeat}`);
      const result = await runOne(scenario, args.url, args.voice, args.caller, llm);
      totalMinutes += result.minutes_estimate;
      worstExit = Math.max(worstExit, result.exit_code) as 0 | 1 | 2;

      const fileName = reportFileName(scenario.name);
      const filePath = join(REPORTS_DIR, fileName);
      await writeFile(filePath, renderReport(result), 'utf-8');
      console.log(oneLineSummary(result, filePath));
      if (result.warnings.length > 0) {
        for (const w of result.warnings) console.log(`  warning: ${w}`);
      }

      rollupRows.push({
        scenario_name: scenario.name,
        run_index: i + 1,
        pass: result.pass,
        expected_verdict: scenario.expected.verdict,
        actual_verdict: result.actual_verdict,
        total_wall_ms: result.timings.total_wall_ms,
        minutes_estimate: result.minutes_estimate,
        report_path: filePath,
      });
    }
  }

  console.log(`rehearse: ${runCount} run(s) complete. ESTIMATE: ~${totalMinutes.toFixed(2)} total minutes streamed to AssemblyAI (method: wall-clock call duration; not read from AssemblyAI billing).`);

  const isBatch = scenarios.length > 1 || args.repeat > 1;
  if (isBatch) {
    const rollup: RollupResult = {
      rows: rollupRows,
      total_minutes_estimate: totalMinutes,
      started_at_iso: batchStartedAtIso,
      ended_at_iso: new Date().toISOString(),
    };
    const rollupPath = join(REPORTS_DIR, rollupFileName());
    await writeFile(rollupPath, renderRollup(rollup), 'utf-8');
    console.log(`rehearse: roll-up written to ${rollupPath}`);
  }

  process.exitCode = worstExit;
}

void main();
