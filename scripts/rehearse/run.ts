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
import { mintSession, connectCall, fetchDiagnostics, forceDropAai } from './wsClient.js';
import type { CallClient } from './wsClient.js';
import { loadScenario, loadAllScenarios, ScenarioValidationError } from './scenario.js';
import { runTurns, runLlmTurns, computeTurnGaps, waitForVerdict, waitForCountersignSettle, waitForServerHangup, CLOSE_WAIT_MS } from './turnController.js';
import { summarizeDiagnostics } from './diagnosticsSummary.js';
import { checkScenarioExpectations, checkCloseLineExpectation } from './expectations.js';
import { renderRollup, oneLineSummary, rollupFileName } from './report.js';
import { writeRunArtifacts } from './artifacts.js';
import { resolveLlmConfig, getApiKey, apiKeyEnvVarFor, nodeFetchHttpClient } from './llmCaller.js';
// Free-play addition (2026-09-14): `--free-play` is handled entirely by freePlay.ts's own
// `runFreePlayOne` (a parallel, self-contained path -- see that file's doc comment for why),
// so this file's only job is to parse the two extra flags and route to it instead of `runOne`.
import { runFreePlayOne } from './freePlay.js';
import type { LlmProvider, ResolvedLineRecord, RollupResult, RollupRow, RunResult, Scenario, StateHistoryRecord, TranscriptRecord } from './types.js';
import type { Verdict } from '@countersign/engine';
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
  /** Free-play addition (2026-09-14): improvises every caller line from the scenario's
   *  persona/truth instead of any scripted turn list -- see freePlay.ts. Requires --model,
   *  independent of --caller (free play is its own caller mode, not a third value of
   *  --caller). */
  freePlay: boolean;
  /** Seeds free play's pause sequence (scripts/rehearse/seededPause.ts) for reproducibility.
   *  Defaults to the current time when omitted -- still recorded in the report either way. */
  seed?: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { url: DEFAULT_URL, scenario: 'all', repeat: 1, caller: 'reactive', freePlay: false };
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
    } else if (a === '--free-play') {
      args.freePlay = true;
    } else if (a === '--seed') {
      args.seed = Number(argv[++i] ?? '');
      if (!Number.isFinite(args.seed)) {
        console.error('rehearse: --seed must be a number');
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
      '                           [--free-play [--seed N]]',
      '',
      `  --url URL        target server (default ${DEFAULT_URL}). Must be spelled out explicitly to hit the deployed site.`,
      '  --scenario NAME  a scenario file name under scripts/rehearse/scenarios/ (without .json), or "all" (default).',
      '  --repeat N       run each selected scenario N times in a row, sequentially (default 1). For G2: --scenario scenario-b-miller-fraud --repeat 2',
      '  --voice NAME     macOS `say` voice for the synthetic caller (default: Samantha, or COUNTERSIGN_REHEARSE_VOICE).',
      '  --caller MODE    "reactive" (default, no network beyond our own server) or "llm" (an external model plays the caller live).',
      '  --model ID       required with --caller llm. An OpenRouter model id (needs OPENROUTER_API_KEY), or "gemini/<id>" for Gemini (needs GEMINI_API_KEY).',
      '  --max-calls N    hard cap on the number of live calls this invocation will make (guards --scenario all --repeat N from an unbounded credit spend).',
      '  --free-play      the caller improvises every line from the scenario\'s persona/truth instead of any scripted turn list. Requires --model (an OpenRouter or "gemini/<id>" model, same as --caller llm).',
      '  --seed N         seeds free play\'s pause sequence for reproducibility (default: derived from the current time; every report records the seed it actually used either way).',
      '',
      'Exit codes: 0 every run passed; 1 at least one run failed its expected verdict/timing; 2 a protocol/connection error occurred (including a missing API key for --caller llm).',
    ].join('\n'),
  );
}

export interface CallEndOutcome {
  transcript: TranscriptRecord[];
  stateHistory: StateHistoryRecord[];
  endedReason: string | null;
  hangupFailReason: 'server_never_hung_up' | undefined;
  verdictReached: boolean;
  actualVerdict: Verdict | 'PENDING' | null;
  warnings: string[];
}

/** PROVEN gap (2026-09-14, reports 2026-09-14T15-49-25-structuring-two-wires and
 *  2026-09-14T15-47-29-miller-patient, read together with their .diagnostics.json server_events):
 *  `runOne` used to snapshot `client.latestState()`/`client.stateHistory` into `transcript`/
 *  `stateHistory` BEFORE the hang-up wait below (the block that calls `waitForServerHangup`,
 *  landed 630a0b1) -- so any agent transcript/state events that arrive WHILE the harness is
 *  waiting for the server's own hang-up (including the goodbye reply itself: both bundles show
 *  a `transcript {role: agent, length: 92}` event, 92 being the exact length of the ESCALATE
 *  close sentence, landing AFTER the caller's last scripted turn and BEFORE `session_ended`)
 *  were captured by the live WebSocket listener (`wsClient.ts`'s `latest`/`stateHistory`
 *  closures, which are never torn down mid-call) but then silently dropped from the report,
 *  because the report's `transcript`/`state_history` fields were already frozen from an EARLIER
 *  read of those same closures. The close-line grader (`checkCloseLineExpectation`) then
 *  graded "NOT spoken" against that stale, goodbye-less transcript even though the server said
 *  it. Fix: this function takes the snapshot AFTER the hang-up wait resolves (server-initiated
 *  or self-ended), so every agent line up to the `ended` event is included, exactly as it would
 *  be for a line spoken during an ordinary scripted turn. Split out of `runOne` so it can be
 *  unit-tested directly against a fake `CallClient` (no network) -- see test/run.test.ts. */
export async function waitForVerdictAndHangup(
  client: CallClient,
  scenario: Scenario,
  callerHungUp: boolean,
  endedTimeoutMs: number = ENDED_TIMEOUT_MS,
): Promise<CallEndOutcome> {
  const warnings: string[] = [];

  const remainingMs = Math.max(1000, scenario.expected.max_wall_ms - (performance.now() - client.startedAt));
  const verdictResult = await waitForVerdict(client, remainingMs);
  if (!verdictResult.reached) {
    warnings.push(`no terminal verdict within the scenario's max_wall_ms (${scenario.expected.max_wall_ms}ms)`);
  } else {
    await waitForCountersignSettle(client);
  }

  // PROVEN gap (2026-09-14, types.ts's ScenarioTurn.hang_up doc comment): the harness used to
  // send its own `end` unconditionally right here, racing the server's own CLOSE hang-up and
  // its goodbye -- six of today's reports show "caller_ended" with no goodbye in the agent
  // transcript, graded PASS on verdict alone. Now: a scenario whose LAST spoken turn carried
  // `hang_up: true` keeps the old immediate-hangup behavior (the caller deliberately walks
  // away); every other scenario waits for the server's own `ended` event instead
  // (`waitForServerHangup`), only ending the call itself if that wait expires.
  let endedReason: string | null;
  let hangupFailReason: 'server_never_hung_up' | undefined;
  if (callerHungUp) {
    client.send({ type: 'end' });
    endedReason = await client.waitForEnded(endedTimeoutMs);
    if (endedReason === null) warnings.push(`no "ended" event within ${endedTimeoutMs}ms of sending end; closing the socket anyway`);
  } else {
    const closeWaitMs = Math.max(scenario.expected.max_wall_ms, CLOSE_WAIT_MS);
    const hangup = await waitForServerHangup(client, closeWaitMs, () => client.send({ type: 'end' }), endedTimeoutMs);
    endedReason = hangup.ended_reason;
    if (hangup.self_ended) {
      hangupFailReason = 'server_never_hung_up';
      warnings.push(
        `the server never ended this call on its own within ${closeWaitMs}ms after the last scripted turn; the harness ended it itself (reason: ${endedReason ?? 'none observed even after ending it itself'})`,
      );
    }
  }

  // Snapshot taken HERE -- after the hang-up wait has resolved -- so every agent transcript/
  // state event received up to (and including) the `ended` event is captured, not just
  // whatever had arrived by the time the verdict/settle wait finished.
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

  return {
    transcript,
    stateHistory,
    endedReason,
    hangupFailReason,
    verdictReached: verdictResult.reached,
    actualVerdict: verdictResult.verdict,
    warnings,
  };
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
    session = await mintSession(url, scenario.demo_persona);
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
  // PROVEN gap (2026-09-13, types.ts's ScenarioTurn.wait_for_agent doc comment): set only by
  // the reactive (`runTurns`) path, when a patient-mode wait caught a holding line followed
  // by permanent silence -- the LLM caller path never sets this.
  let turnsFailReason: 'agent_silent_after_hold' | undefined;
  // PROVEN gap (2026-09-14, types.ts's ScenarioTurn.hang_up doc comment): whether the LAST
  // turn actually spoken carried `hang_up: true` -- decides, below, whether this call's own
  // caller hangs up (the old behavior, still correct for a scenario whose script has the
  // caller deliberately walk away) or must instead wait for the server's OWN `ended` event.
  let callerHungUp = false;
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
    callerHungUp = outcome.caller_hung_up;
  } else {
    // Judge-sim finding 2026-09-11: always wired (harmless when no turn carries
    // `drop_aai_before`) so any scenario, present or future, can opt into forcing a real
    // AAI-leg drop mid-call without run.ts needing scenario-specific branching here.
    const outcome = await runTurns(client, scenario, voice, { dropAai: () => forceDropAai(url, session.session_id) });
    warnings.push(...outcome.warnings);
    callerEndTimes = outcome.callerEndTimes;
    resolvedLines = outcome.resolvedLines;
    turnsFailReason = outcome.fail_reason;
    callerHungUp = outcome.caller_hung_up;
  }

  // PROVEN gap (2026-09-14, reports 2026-09-14T15-49-25-structuring-two-wires and
  // 2026-09-14T15-47-29-miller-patient): this used to be inlined here, with the
  // transcript/stateHistory snapshot taken BEFORE the hang-up wait below -- see
  // `waitForVerdictAndHangup`'s own doc comment for the full PROVEN gap and fix. Extracted so
  // it can be unit-tested directly against a fake CallClient (test/run.test.ts).
  const endOutcome = await waitForVerdictAndHangup(client, scenario, callerHungUp, ENDED_TIMEOUT_MS);
  warnings.push(...endOutcome.warnings);
  const { transcript, stateHistory, endedReason, hangupFailReason } = endOutcome;
  client.close();

  const totalWallMs = performance.now() - client.startedAt;

  const bundle = await fetchDiagnostics(url, session.session_id);
  const diagnostics = summarizeDiagnostics(bundle);

  const turnGaps = computeTurnGaps(client, callerEndTimes);

  const actualVerdict = endOutcome.actualVerdict;
  // Judge-sim finding 2026-09-11 (expectations.ts's doc comment has the full reasoning): a
  // scenario's own opt-in min_interrupted_agent_lines/require_aai_link_restored checks are
  // ADDITIONAL fail conditions, on top of (never instead of) the base verdict check --
  // reaching the right verdict without the mechanic the scenario exists to prove is still a
  // FAIL, not a pass with a hopeful warning.
  const expectationCheck = checkScenarioExpectations(scenario, transcript, bundle);
  for (const failure of expectationCheck.failures) warnings.push(failure);
  // PROVEN gap (2026-09-13, expectations.ts's `checkCloseLineExpectation` doc comment): when
  // the server ends the call itself, the agent transcript must actually contain the closing
  // sentence matching the verdict the call reached -- reaching the right verdict is not
  // enough if a judge would hear a hang-up with no goodbye.
  const closeLineCheck = checkCloseLineExpectation(endedReason, actualVerdict, transcript);
  if (closeLineCheck.failure) warnings.push(closeLineCheck.failure);
  // PROVEN gap (2026-09-13): a patient-mode "agent went silent after a holding line" fail, and
  // a "close line never spoken" fail, are both unconditional -- either overrides whatever
  // verdict the call separately reached (or didn't), same as any other structural fail
  // condition above.
  const pass =
    turnsFailReason === undefined &&
    hangupFailReason === undefined &&
    endOutcome.verdictReached &&
    actualVerdict === scenario.expected.verdict &&
    expectationCheck.ok &&
    closeLineCheck.status !== 'not_spoken';

  const minutesEstimate = totalWallMs / 60000;

  return {
    scenario,
    target_url: url,
    session_id: session.session_id,
    started_at_iso: startedAtIso,
    ended_reason: endedReason,
    verdict_reached: endOutcome.verdictReached,
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
    raw_diagnostics: bundle,
    warnings,
    exit_code: pass ? 0 : 1,
    minutes_estimate: minutesEstimate,
    resolved_lines: resolvedLines,
    caller_mode: callerMode,
    close_line_status: closeLineCheck.status,
    ...(turnsFailReason !== undefined
      ? { fail_reason: turnsFailReason }
      : hangupFailReason !== undefined
        ? { fail_reason: hangupFailReason }
        : closeLineCheck.status === 'not_spoken'
          ? { fail_reason: 'close_line_not_spoken' as const }
          : {}),
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
    raw_diagnostics: null,
    warnings: [message],
    exit_code: 2,
    minutes_estimate: 0,
    resolved_lines: [],
    caller_mode: callerMode,
    close_line_status: 'n/a',
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let llm: { provider: LlmProvider; model: string; apiKey: string } | undefined;
  if (args.caller === 'llm' || args.freePlay) {
    const flagName = args.freePlay ? '--free-play' : '--caller llm';
    if (!args.model) {
      console.error(`rehearse: ${flagName} requires --model <id> (an OpenRouter model id, or "gemini/<id>" for Gemini)`);
      process.exitCode = 2;
      return;
    }
    const { provider, model } = resolveLlmConfig(args.model);
    const apiKey = getApiKey(provider);
    if (!apiKey) {
      console.error(`rehearse: ${flagName} needs ${apiKeyEnvVarFor(provider)} set in the environment (export it from .env first: set -a; source .env; set +a). No key found -- not making any network call.`);
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

  if (args.caller === 'llm' || args.freePlay) {
    const flagName = args.freePlay ? '--free-play' : '--caller llm';
    const missingPersona = scenarios.filter((s) => !s.persona);
    if (missingPersona.length > 0) {
      console.error(`rehearse: ${flagName} requires a "persona" field on every selected scenario; missing on: ${missingPersona.map((s) => s.name).join(', ')}`);
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
      const result = args.freePlay
        ? await runFreePlayOne(scenario, args.url, args.voice, { ...llm!, seed: args.seed ?? Date.now() })
        : await runOne(scenario, args.url, args.voice, args.caller, llm);
      totalMinutes += result.minutes_estimate;
      worstExit = Math.max(worstExit, result.exit_code) as 0 | 1 | 2;

      const { reportPath, diagnosticsPath } = await writeRunArtifacts(result, REPORTS_DIR);
      console.log(oneLineSummary(result, reportPath));
      console.log(`  raw diagnostics bundle: ${diagnosticsPath}`);
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
        report_path: reportPath,
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

// PROVEN gap (2026-09-14, found while adding test/run.test.ts): `main()` used to be called
// unconditionally at module load, so simply IMPORTING run.ts (e.g. to unit-test
// `waitForVerdictAndHangup`) ran the whole real CLI -- minting real sessions, hitting the
// network, and writing report files into scripts/rehearse/reports/ as a test side effect. Same
// "only run main() when this file is the actual entry point" guard rehearseBatch.ts already
// uses, so `npx tsx scripts/rehearse/run.ts` (and `npm run rehearse`) behave identically to
// before -- only an import from another module (a test) is now side-effect-free.
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) void main();
