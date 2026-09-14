// scripts/rehearse/freePlay.ts
// Free-play addition (2026-09-14, founder's definition of done, 2026-09-14: "a judge speaking
// in their own words, with any pauses and pronunciation, must be understood and get the right
// outcome in every case. A scripted pass is not done."). This is `--free-play` mode's turn
// loop and single-call orchestration -- the improvising counterpart to turnController.ts's
// `runLlmTurns`/run.ts's `runOne`, built ON them (reusing their exported pieces verbatim
// wherever possible) rather than beside them, so the two lanes editing run.ts/turnController.ts
// this same day never have to touch the same lines this file depends on.
//
// This is a TEST HARNESS file (BRIEF LAW 5 scope fence): never imported by product code under
// packages/, never claims to detect a real caller (LAW 1) -- it plays a synthetic, disclosed
// improviser against the real live stack, same as every other file in this directory.
import { setTimeout as sleep } from 'node:timers/promises';
import { chunkToFrames, FRAME_MS, synthesizeLine } from './audio.js';
import { checkCloseLineExpectation, checkScenarioExpectations } from './expectations.js';
import { summarizeDiagnostics } from './diagnosticsSummary.js';
import { nodeFetchHttpClient } from './llmCaller.js';
import { requestNextFreePlayLine } from './freePlayPrompt.js';
import type { FreePlayCallerTurnResult } from './freePlayPrompt.js';
import { gradeFreePlay } from './freePlayGrading.js';
import { createSeededPauseGenerator, type SeededPauseGenerator } from './seededPause.js';
import {
  CLOSE_WAIT_MS,
  computeTurnGaps,
  DEFAULT_AGENT_SILENCE_FAIL_MS,
  lastAgentTranscriptText,
  scriptedCallerShouldStop,
  waitForCountersignSettle,
  waitForGreeting,
  waitForPatientTurn,
  waitForReplyStarted,
  waitForServerHangup,
  waitForVerdict,
} from './turnController.js';
import { connectCall, fetchDiagnostics, mintSession } from './wsClient.js';
import type { CallClient } from './wsClient.js';
import type {
  HttpClient,
  LlmProvider,
  LlmTurnHistoryEntry,
  ResolvedLineRecord,
  RunResult,
  Scenario,
  StateHistoryRecord,
  TranscriptRecord,
} from './types.js';
import type { Verdict } from '@countersign/engine';

function nowT(client: CallClient): number {
  return performance.now() - client.startedAt;
}

async function streamPcm(client: CallClient, pcm: Buffer): Promise<{ startedMs: number; endedMs: number }> {
  const frames = chunkToFrames(pcm);
  const startedMs = nowT(client);
  for (const frame of frames) {
    client.send({ type: 'audio', data: frame.toString('base64') });
    await sleep(FRAME_MS);
  }
  return { startedMs, endedMs: nowT(client) };
}

async function speakLine(client: CallClient, text: string, voice: string | undefined): Promise<{ startedMs: number; endedMs: number }> {
  const pcm = await synthesizeLine(text, voice);
  return streamPcm(client, pcm);
}

/** How long the opening-turn barge-in path waits for the greeting's own first audio frame
 *  before giving up and speaking without a real interruption to reproduce -- same magnitude
 *  as turnController.ts's own `GREETING_TIMEOUT_MS`/`BARGE_IN_REPLY_START_TIMEOUT_MS`, kept
 *  as a local constant (not imported) since neither of those is exported and duplicating one
 *  number is a smaller, safer footprint on turnController.ts than adding a third export. */
const OPENING_BARGE_IN_TIMEOUT_MS = 8_000;
/** A seeded pause draw (600-6000ms by default) is clamped into this narrower window before
 *  being used as an opening-turn barge-in OFFSET -- a caller who waited 6 full seconds to
 *  interrupt a ~5.5s greeting would simply be talking after it finished, not interrupting it
 *  at all (turnController.ts's own barge-in-interrupt.json scripts 1200ms for exactly this
 *  reason). The draw is still recorded in the pause sequence verbatim (reproducibility), only
 *  the ACTUAL wait is clamped. */
const MIN_OPENING_BARGE_IN_MS = 800;
const MAX_OPENING_BARGE_IN_MS = 3000;

export interface FreePlayTurnCaps {
  max_turns: number;
  max_wall_ms: number;
  max_words_per_line: number;
}

export interface FreePlayTurnOutcome {
  warnings: string[];
  callerEndTimes: { turn_id: string; caller_end_ms: number; barge_in: boolean }[];
  resolvedLines: ResolvedLineRecord[];
  llm_turns: number;
  /** Set only when `waitForPatientTurn` (turnController.ts, reused unmodified) caught a
   *  holding line followed by permanent silence -- same semantics as the scripted patient
   *  caller's own `fail_reason`. */
  fail_reason?: 'agent_silent_after_hold';
  /** True iff the free-play caller itself deliberately went silent this call
   *  (`FreePlayCallerTurnResult.silent`) -- `runFreePlayOne` uses this, together with the last
   *  entry in `callerEndTimes`, to build `freePlayGrading.ts`'s `silentAfterMs` so a later
   *  agent question never counts against a caller who was SUPPOSED to have gone quiet. */
  went_silent: boolean;
}

/** The free-play counterpart to turnController.ts's `runLlmTurns`: instead of a fixed scenario
 *  turn list OR that function's ordinary "wait a grace window, then ask" loop, this improvises
 *  every line from the scenario's `persona`/`truth` (freePlayPrompt.ts, never the scripted
 *  `turns`) and:
 *   - waits PATIENTLY for the agent between turns, reusing `waitForPatientTurn` VERBATIM (spec
 *     item 1c: "reuse the patient-caller logic") -- a holding line waits further rather than
 *     being treated as the real answer, an engine CLOSE sentence stops the caller from
 *     speaking again, and a holding line followed by permanent silence fails the run exactly
 *     as it does for the scripted patient caller;
 *   - inserts a SEEDED random pause (spec item 1b) before every non-opening line, drawn from
 *     `pauseGen` (scripts/rehearse/seededPause.ts) -- reproducible from the run's own seed,
 *     recorded in the report;
 *   - is capped by `caps.max_turns`/`caps.max_wall_ms`, same discipline as `runLlmTurns`.
 *  Programmatic barge-in (spec item 1a/1c's "never talk while agent is mid-sentence unless
 *  free_play.barge_in is true") is exercised ONLY on the OPENING turn, talking over the
 *  agent's greeting -- matching the one scripted scenario this knob exists for
 *  (barge-in-interrupt.json, which barges on its opening line only, never a later turn); every
 *  turn after the first always waits patiently regardless of `free_play.barge_in`. This is a
 *  deliberate, disclosed scope limit, not an oversight: modeling a live, mid-reply barge-in
 *  decision on an ARBITRARY later turn would need the model to be asked WHILE a reply is still
 *  in flight (a second concurrent, throttled LLM call per turn) for a mechanic no scenario in
 *  this repo currently exercises past the opening line. */
export async function runFreePlayTurns(
  client: CallClient,
  scenario: Scenario,
  provider: LlmProvider,
  model: string,
  apiKey: string,
  caps: FreePlayTurnCaps,
  http: HttpClient,
  voice: string | undefined,
  pauseGen: SeededPauseGenerator,
): Promise<FreePlayTurnOutcome> {
  if (!scenario.persona) {
    throw new Error(`scenario "${scenario.name}" has no "persona" field -- required for --free-play`);
  }
  const persona = scenario.persona;
  const truth = scenario.truth;
  const bargeInAllowed = scenario.free_play?.barge_in === true;
  const agentSilenceFailMs = scenario.agent_silence_fail_ms ?? DEFAULT_AGENT_SILENCE_FAIL_MS;

  const warnings: string[] = [];
  const callerEndTimes: FreePlayTurnOutcome['callerEndTimes'] = [];
  const resolvedLines: ResolvedLineRecord[] = [];
  const history: LlmTurnHistoryEntry[] = [];
  const deadline = nowT(client) + caps.max_wall_ms;

  let turnIndex = 0;
  let wentSilent = false;
  while (turnIndex < caps.max_turns) {
    const { stop, warning } = scriptedCallerShouldStop(client.endedReason());
    if (stop) {
      if (warning) warnings.push(`free-play turn ${turnIndex}: ${warning}`);
      break;
    }
    if (nowT(client) > deadline) {
      warnings.push(`free-play: stopped after ${turnIndex} turn(s), hit its own max_wall_ms cap (${caps.max_wall_ms}ms)`);
      break;
    }

    if (turnIndex === 0 && bargeInAllowed) {
      // Opening-turn barge-in: fetch the model's opening line CONCURRENTLY with waiting for
      // the greeting's first audio frame (same reasoning as turnController.ts's `runTurns`
      // barge-in branches -- network/TTS latency landing on top of the intended offset was
      // itself the bug those branches were written to fix), then wait the clamped seeded
      // offset from that anchor before speaking, interrupting the greeting mid-sentence.
      const markerCount = client.audioTimestamps.length;
      const requestPromise = requestNextFreePlayLine(http, provider, model, apiKey, persona, truth, [], caps.max_words_per_line);
      const anchorMs = await waitForReplyStarted(client, markerCount, OPENING_BARGE_IN_TIMEOUT_MS);

      let turnResult: FreePlayCallerTurnResult;
      try {
        turnResult = await requestPromise;
      } catch (err) {
        warnings.push(`free-play turn 0: request failed (${err instanceof Error ? err.message : String(err)}); stopping the free-play caller for this call`);
        break;
      }
      if (turnResult.silent || turnResult.text.trim().length === 0) {
        // The opening turn is always this caller's initial request -- a persona has no reason
        // to go silent before ever speaking. Treat this as a formatting slip, not a real
        // silence, and stop the whole run rather than stream an empty line: nothing useful can
        // happen on a call where the caller never states a request at all.
        warnings.push('free-play turn 0: the model returned an empty/silent opening line; stopping the free-play caller for this call');
        break;
      }
      history.push({ speaker: 'caller', text: turnResult.text });

      let bargedIn = false;
      if (anchorMs === null) {
        warnings.push(`free-play: no greeting audio observed within ${OPENING_BARGE_IN_TIMEOUT_MS}ms; speaking the opening line without a real interruption to reproduce`);
      } else {
        const offsetMs = Math.min(MAX_OPENING_BARGE_IN_MS, Math.max(MIN_OPENING_BARGE_IN_MS, pauseGen.next()));
        const remaining = anchorMs + offsetMs - nowT(client);
        if (remaining > 0) await sleep(remaining);
        bargedIn = true;
      }

      const { endedMs } = await speakLine(client, turnResult.text, voice);
      const turnId = 'freeplay-1';
      resolvedLines.push({ turn_id: turnId, text: turnResult.text, source: 'llm', reacted_to: null });
      callerEndTimes.push({ turn_id: turnId, caller_end_ms: endedMs, barge_in: bargedIn });
      turnIndex++;
      continue;
    }

    if (turnIndex === 0) {
      await waitForGreeting(client, warnings);
    } else {
      const patientResult = await waitForPatientTurn(client, agentSilenceFailMs, warnings);
      if (patientResult.outcome === 'fail') {
        warnings.push(
          `free-play turn ${turnIndex}: agent spoke a holding line and then went silent for ${agentSilenceFailMs}ms with no further reply; failing this run (agent_silent_after_hold)`,
        );
        return { warnings, callerEndTimes, resolvedLines, llm_turns: turnIndex, fail_reason: 'agent_silent_after_hold', went_silent: wentSilent };
      }
      if (patientResult.outcome === 'stop') break; // the agent's own closing line -- nothing left to say.
      await sleep(pauseGen.next());
    }

    const lastAgentText = lastAgentTranscriptText(client);
    if (lastAgentText !== null && (history.length === 0 || history[history.length - 1]!.text !== lastAgentText)) {
      history.push({ speaker: 'agent', text: lastAgentText });
    }

    let turnResult: FreePlayCallerTurnResult;
    try {
      turnResult = await requestNextFreePlayLine(http, provider, model, apiKey, persona, truth, history, caps.max_words_per_line);
    } catch (err) {
      warnings.push(`free-play turn ${turnIndex}: request failed (${err instanceof Error ? err.message : String(err)}); stopping the free-play caller for this call`);
      break;
    }

    if (turnResult.silent) {
      // PROVEN gap (2026-09-14, FreePlayCallerTurnResult's own doc comment): the persona has
      // reached its defined "go silent forever" point (hangup-after-request,
      // miller-silent-after-amount). Never speak, never ask for another line again -- the
      // call is left to the real stack's own idle/hold handling from here, exactly like the
      // scripted hangup-after-request.json scenario (a one-turn script with nothing after
      // c1) already does by simply running out of turns.
      warnings.push(`free-play turn ${turnIndex}: the caller has gone silent per persona instruction; no further caller turns will be spoken`);
      wentSilent = true;
      break;
    }

    history.push({ speaker: 'caller', text: turnResult.text });

    const { endedMs } = await speakLine(client, turnResult.text, voice);
    const turnId = `freeplay-${turnIndex + 1}`;
    resolvedLines.push({ turn_id: turnId, text: turnResult.text, source: 'llm', reacted_to: lastAgentText });
    callerEndTimes.push({ turn_id: turnId, caller_end_ms: endedMs, barge_in: false });
    turnIndex++;
  }

  return { warnings, callerEndTimes, resolvedLines, llm_turns: turnIndex, went_silent: wentSilent };
}

// ---------- verdict + hang-up wait ----------

/** Same magnitude as run.ts's own `ENDED_TIMEOUT_MS` -- declared here (not below, next to
 *  `READY_TIMEOUT_MS`) so `waitForFreePlayVerdictAndHangup`'s default parameter below resolves
 *  against an already-initialized constant, not one declared later in the module. */
const ENDED_TIMEOUT_MS = 8_000;

export interface FreePlayCallEndOutcome {
  transcript: TranscriptRecord[];
  stateHistory: StateHistoryRecord[];
  endedReason: string | null;
  /** Set only when the server never produced its own `ended` event within the wait budget and
   *  the harness had to end the call itself as a last resort -- same unconditional-fail
   *  treatment `run.ts`'s scripted/LLM paths already give `server_never_hung_up`. */
  hangupFailReason: 'server_never_hung_up' | undefined;
  verdictReached: boolean;
  actualVerdict: Verdict | 'PENDING' | null;
  warnings: string[];
}

/** PROVEN gap (2026-09-14, scripts/rehearse/reports/2026-09-14T17-18-03-dana-patient.md): a
 *  free-play run where the agent spoke the full STAGE goodbye ended with "Call ended reason:
 *  caller_ended" and "Close line: n/a (caller ended)" -- `runFreePlayOne` used to send its own
 *  `{type:'end'}` unconditionally right after the verdict/settle wait, exactly the same race
 *  against the server's own CLOSE hang-up and its goodbye that `waitForServerHangup` (this
 *  module reuses, verbatim) and run.ts's `waitForVerdictAndHangup` were built to fix for the
 *  scripted/LLM paths (see turnController.ts's `CLOSE_WAIT_MS` doc comment). Free play has no
 *  `ScenarioTurn.hang_up` concept at all -- that field only exists on the scripted turn list a
 *  free-play run never uses -- so, unlike run.ts's dual `callerHungUp` branch, EVERY free-play
 *  call always waits for the server's own `ended` event here, whether the caller model stopped
 *  because it ran out of turns, hit its own caps, said `silent: true`, or the agent's own close
 *  line was heard mid-loop (`waitForPatientTurn`'s `'stop'` outcome) -- only ending the call
 *  itself, as `server_never_hung_up`, if that wait expires. Extracted (like run.ts's own
 *  `waitForVerdictAndHangup`) so it is unit-testable directly against a fake `CallClient`, no
 *  network involved -- see test/freePlay.test.ts. The transcript/state-history snapshot is
 *  taken AFTER this wait resolves, for the same reason run.ts's fix takes its snapshot after
 *  its own hang-up wait: any agent transcript line (including the goodbye) that lands WHILE the
 *  harness is waiting must still make it into the report and the close-line grade. */
export async function waitForFreePlayVerdictAndHangup(
  client: CallClient,
  scenario: Scenario,
  endedTimeoutMs: number = ENDED_TIMEOUT_MS,
): Promise<FreePlayCallEndOutcome> {
  const warnings: string[] = [];

  const remainingMs = Math.max(1000, scenario.expected.max_wall_ms - (performance.now() - client.startedAt));
  const verdictResult = await waitForVerdict(client, remainingMs);
  if (!verdictResult.reached) {
    warnings.push(`no terminal verdict within the scenario's max_wall_ms (${scenario.expected.max_wall_ms}ms)`);
  } else {
    await waitForCountersignSettle(client);
  }

  const closeWaitMs = Math.max(scenario.expected.max_wall_ms, CLOSE_WAIT_MS);
  const hangup = await waitForServerHangup(client, closeWaitMs, () => client.send({ type: 'end' }), endedTimeoutMs);
  const endedReason = hangup.ended_reason;
  let hangupFailReason: 'server_never_hung_up' | undefined;
  if (hangup.self_ended) {
    hangupFailReason = 'server_never_hung_up';
    warnings.push(
      `the server never ended this call on its own within ${closeWaitMs}ms after the free-play caller stopped/went silent; the harness ended it itself (reason: ${endedReason ?? 'none observed even after ending it itself'})`,
    );
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

// ---------- one full free-play call ----------

const READY_TIMEOUT_MS = 20_000;
const DEFAULT_FREEPLAY_MAX_TURNS = 14;
const DEFAULT_FREEPLAY_MAX_WALL_MS = 240_000;
const DEFAULT_FREEPLAY_MAX_WORDS_PER_LINE = 30;

export interface FreePlayLlmConfig {
  provider: LlmProvider;
  model: string;
  apiKey: string;
  /** The base seed this specific call's pause sequence is drawn from -- recorded verbatim in
   *  the resulting RunResult.free_play.seed so the report can be replayed by eye. */
  seed: number;
}

function emptyFreePlayExtras(llm: FreePlayLlmConfig): NonNullable<RunResult['free_play']> {
  return { model: llm.model, seed: llm.seed, pause_sequence_ms: [], question_answer: { answered: 0, total: 0, unanswered: [] } };
}

function protocolErrorResult(scenario: Scenario, url: string, startedAtIso: string, llm: FreePlayLlmConfig, message: string, sessionId = 'none'): RunResult {
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
    caller_mode: 'freeplay',
    close_line_status: 'n/a',
    free_play: emptyFreePlayExtras(llm),
  };
}

/** The free-play counterpart to run.ts's `runOne`: mints a session, opens the call, runs
 *  `runFreePlayTurns` above, waits for a terminal verdict, then grades the run against every
 *  check every other mode already gets (the scenario's own opt-in `expectations.ts` checks,
 *  `checkCloseLineExpectation`'s close-line check) PLUS the free-play-only checks
 *  (freePlayGrading.ts's `gradeFreePlay`: an acceptable verdict from `expected.verdicts`, no
 *  excessive agent silence, every agent question answered). Deliberately does NOT call or
 *  modify run.ts's `runOne` -- this is a parallel, self-contained path built entirely from
 *  exported pieces of wsClient.ts/turnController.ts/expectations.ts/diagnosticsSummary.ts, so
 *  it never collides with the concurrent lane changing run.ts's/turnController.ts's own
 *  call-ending behavior. */
export async function runFreePlayOne(scenario: Scenario, url: string, voice: string | undefined, llm: FreePlayLlmConfig): Promise<RunResult> {
  const startedAtIso = new Date().toISOString();
  const warnings: string[] = [];

  let session;
  try {
    session = await mintSession(url, scenario.demo_persona);
  } catch (err) {
    return protocolErrorResult(scenario, url, startedAtIso, llm, `could not mint a session: ${err instanceof Error ? err.message : String(err)}`);
  }

  let client: CallClient;
  try {
    client = await connectCall(url, session.ws_path);
  } catch (err) {
    return protocolErrorResult(
      scenario,
      url,
      startedAtIso,
      llm,
      `could not open the call WebSocket: ${err instanceof Error ? err.message : String(err)}`,
      session.session_id,
    );
  }

  client.send({ type: 'start' });

  const readyDeadline = performance.now() + READY_TIMEOUT_MS;
  while (client.latestState() === null && performance.now() < readyDeadline) {
    await sleep(40);
  }
  if (client.latestState() === null) {
    client.close();
    return protocolErrorResult(scenario, url, startedAtIso, llm, `no "state" event within ${READY_TIMEOUT_MS}ms of connecting`, session.session_id);
  }
  const readyMs = client.stateHistory[0]!.t_ms;
  const firstAudioMs = client.audioTimestamps.length > 0 ? client.audioTimestamps[0]! - readyMs : null;

  const pauseGen = createSeededPauseGenerator(llm.seed, scenario.free_play?.pause_min_ms, scenario.free_play?.pause_max_ms);

  const outcome = await runFreePlayTurns(
    client,
    scenario,
    llm.provider,
    llm.model,
    llm.apiKey,
    { max_turns: DEFAULT_FREEPLAY_MAX_TURNS, max_wall_ms: DEFAULT_FREEPLAY_MAX_WALL_MS, max_words_per_line: DEFAULT_FREEPLAY_MAX_WORDS_PER_LINE },
    nodeFetchHttpClient,
    voice,
    pauseGen,
  );
  warnings.push(...outcome.warnings);

  // PROVEN gap (2026-09-14, scripts/rehearse/reports/2026-09-14T17-18-03-dana-patient.md): see
  // `waitForFreePlayVerdictAndHangup`'s own doc comment -- this used to be inlined here, ending
  // the call itself unconditionally and snapshotting the transcript BEFORE that, exactly the bug
  // run.ts's `waitForVerdictAndHangup` was built to fix for the scripted/LLM paths.
  const endOutcome = await waitForFreePlayVerdictAndHangup(client, scenario, ENDED_TIMEOUT_MS);
  warnings.push(...endOutcome.warnings);
  const { transcript, stateHistory, endedReason, hangupFailReason, verdictReached, actualVerdict } = endOutcome;
  client.close();

  const totalWallMs = performance.now() - client.startedAt;

  const bundle = await fetchDiagnostics(url, session.session_id);
  const diagnostics = summarizeDiagnostics(bundle);

  const turnGaps = computeTurnGaps(client, outcome.callerEndTimes);

  const expectationCheck = checkScenarioExpectations(scenario, transcript, bundle);
  for (const failure of expectationCheck.failures) warnings.push(failure);

  const closeLineCheck = checkCloseLineExpectation(endedReason, actualVerdict, transcript);
  if (closeLineCheck.failure) warnings.push(closeLineCheck.failure);

  const agentSilenceFailMs = scenario.agent_silence_fail_ms ?? DEFAULT_AGENT_SILENCE_FAIL_MS;
  const silentAfterMs = outcome.went_silent
    ? (outcome.callerEndTimes[outcome.callerEndTimes.length - 1]?.caller_end_ms ?? 0)
    : undefined;
  const freePlayGrade = gradeFreePlay({
    scenario,
    actualVerdict,
    verdictReached,
    turnGaps,
    transcript,
    agentSilenceFailMs,
    ...(outcome.fail_reason !== undefined ? { turnLoopFailReason: outcome.fail_reason } : {}),
    ...(silentAfterMs !== undefined ? { silentAfterMs } : {}),
  });
  warnings.push(...freePlayGrade.failures);

  // PROVEN gap (2026-09-14): a server that never hangs up on its own is an unconditional fail
  // here too -- same precedence run.ts's `runOne` already uses (a turn-loop fail outranks
  // everything, already folded into `freePlayGrade.fail_reason` via `turnLoopFailReason`; a
  // forced self-hangup outranks the close-line check, since the harness ending the call itself
  // is the more specific, more actionable diagnosis even when a close line happened to be heard
  // first).
  const pass = freePlayGrade.pass && expectationCheck.ok && closeLineCheck.status !== 'not_spoken' && hangupFailReason === undefined;
  const failReason =
    freePlayGrade.fail_reason ?? hangupFailReason ?? (closeLineCheck.status === 'not_spoken' ? ('close_line_not_spoken' as const) : undefined);

  const minutesEstimate = totalWallMs / 60000;

  return {
    scenario,
    target_url: url,
    session_id: session.session_id,
    started_at_iso: startedAtIso,
    ended_reason: endedReason,
    verdict_reached: verdictReached,
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
    resolved_lines: outcome.resolvedLines,
    caller_mode: 'freeplay',
    close_line_status: closeLineCheck.status,
    ...(failReason !== undefined ? { fail_reason: failReason } : {}),
    free_play: {
      model: llm.model,
      seed: llm.seed,
      pause_sequence_ms: pauseGen.sequence,
      question_answer: freePlayGrade.question_answer,
    },
  };
}
