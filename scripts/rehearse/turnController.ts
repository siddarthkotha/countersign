// scripts/rehearse/turnController.ts
// Drives one scenario's caller turns against a live CallClient in real time. There is no
// scripted agent side: the real AssemblyAI voice agent generates its own replies, so this
// file only ever decides WHEN the synthetic caller should speak, never what the agent says.
//
// "Wait for the agent's reply to finish": the PRIMARY signal is audio silence -- ServerEvent
// `audio` frames are sent immediately, never throttled (PROVEN: packages/server/src/ws/
// browser.ts:136-146), so a gap of SILENCE_MS with no new audio frame is a reliable "the
// reply's TTS has stopped". The SECONDARY, corroborating signal is ScreenState.agent_status
// leaving 'SPEAKING' (PROVEN derivation: packages/server/src/screen/state.ts:122-133 --
// `speaking` is true strictly between reply.started and reply.done). `state` ServerEvents ARE
// throttled server-side to one per ~66ms window (browser.ts's own THROTTLE_WINDOW_MS), so
// agent_status alone can lag or coalesce a transition; audio silence is treated as the
// decisive signal and agent_status as a cross-check recorded for the report, not the gate
// itself.
import { setTimeout as sleep } from 'node:timers/promises';
import type { Verdict } from '@countersign/engine';
import type { CallClient } from './wsClient.js';
import { synthesizeLine, chunkToFrames, FRAME_MS } from './audio.js';
import { resolveTurnText } from './truthEngine.js';
import { requestNextCallerLine } from './llmCaller.js';
import type { HttpClient, LlmProvider, LlmTurnHistoryEntry, ResolvedLineRecord, Scenario, ScenarioTurn, TurnGapRecord } from './types.js';

/** The live agent's most recently received transcript line's text, or null if the agent
 *  hasn't said anything yet (the reactive engine's "no reply to react to" case -- a turn
 *  with `respond` just speaks its fixed `text` then). Reads straight off the latest
 *  ScreenState (packages/engine/src/types.ts:371's `transcript` array, chronological, never
 *  reordered by the server), rather than tracking it separately -- one source of truth. */
function lastAgentTranscriptText(client: CallClient): string | null {
  const state = client.latestState();
  if (!state) return null;
  for (let i = state.transcript.length - 1; i >= 0; i--) {
    const line = state.transcript[i]!;
    if (line.speaker === 'agent') return line.text;
  }
  return null;
}

/** No new audio frame for this long => the current reply's TTS has stopped. */
const SILENCE_MS = 700;
/** How long to wait, before speaking a non-FIRST, non-barge-in turn, to see whether the
 *  agent starts speaking AT ALL (a mid-call goal may render a STALL/holding line, or
 *  nothing, before the caller's next turn). If nothing arrives in this window, the harness
 *  assumes the floor is open and proceeds after `pause_ms` without further waiting. Also
 *  used as `waitForGreeting`'s own fallback path below once its stricter greeting-timeout
 *  has already been given up on. */
const GREETING_GRACE_MS = 1500;
/** Founder ruling 2026-09-11: the agent now speaks FIRST on every call, via AssemblyAI's
 *  connect-time `greeting` field (packages/server/src/aai/config.ts's DEFAULT_GREETING) --
 *  so the very first caller turn actively waits for that greeting reply to finish, rather
 *  than merely giving the agent a short grace window to decide whether to speak at all.
 *  Bounded so a missing/misconfigured greeting (e.g. a live-mode server still wired for the
 *  old "caller speaks first" default) can never deadlock a rehearsal run -- `waitForGreeting`
 *  falls back to the ORIGINAL `GREETING_GRACE_MS` grace-window behavior once this expires. */
const GREETING_TIMEOUT_MS = 8_000;
/** Ceiling on waiting for an in-progress reply to settle before giving up and speaking
 *  anyway (a hung reply must never wedge the whole scenario run). */
const REPLY_SETTLE_TIMEOUT_MS = 60_000;
/** Ceiling on waiting for a barge-in target reply to even START before giving up and
 *  speaking anyway (the barge-in line still gets said, just without a real interruption to
 *  reproduce -- recorded as a warning). Only `runLlmTurns`' own spontaneous (model-decided)
 *  barge-in still uses this -- the scripted `barge_in_after_ms` path below uses the tighter
 *  `BARGE_IN_ANCHOR_TIMEOUT_MS`. */
const BARGE_IN_REPLY_START_TIMEOUT_MS = 30_000;
/** Bug fix (2026-09-11, PROVEN from scripts/rehearse/reports/2026-09-11T23-28-26-
 *  barge-in-interrupt.md): a `barge_in_after_ms` turn used to sleep that many ms from
 *  whenever the harness happened to CHECK for a reply, not from when the targeted reply's
 *  audio actually started -- so the interruption could land after the reply had already
 *  finished (0 `interrupted` lines, min_interrupted_agent_lines FAIL) even though a real
 *  reply had started well within any reasonable timeout. `waitForBargeIn` below anchors the
 *  wait to the reply's own first audio frame instead. 8s (not the LLM path's 30s) is enough
 *  time for a real reply to start after the caller's previous turn, while still keeping a
 *  hung/never-replying call from wedging a rehearsal run. */
const BARGE_IN_ANCHOR_TIMEOUT_MS = 8_000;
const POLL_MS = 40;

function lastAudioAt(client: CallClient): number | null {
  const ts = client.audioTimestamps;
  return ts.length > 0 ? ts[ts.length - 1]! : null;
}

function nowT(client: CallClient): number {
  return performance.now() - client.startedAt;
}

/** Resolves once the agent's current reply looks finished: no audio frame for SILENCE_MS
 *  AND the latest known agent_status is not 'SPEAKING'. Resolves `settled:false` (a
 *  timeout, not a throw) if this drags past `timeoutMs` -- the caller decides whether that's
 *  worth a warning. */
async function waitForReplySettled(client: CallClient, timeoutMs: number): Promise<{ settled: boolean }> {
  const deadline = nowT(client) + timeoutMs;
  for (;;) {
    const t = nowT(client);
    const la = lastAudioAt(client);
    const silentEnough = la === null || t - la >= SILENCE_MS;
    const state = client.latestState();
    const notSpeaking = !state || state.agent_status !== 'SPEAKING';
    if (silentEnough && notSpeaking) return { settled: true };
    if (t > deadline) return { settled: false };
    await sleep(POLL_MS);
  }
}

/** Resolves once at least one NEW audio frame has arrived since `markerCount` (i.e. a reply
 *  has started) -- returns that frame's own client-relative timestamp (the `reply.audio.first`
 *  anchor this module's barge-in and greeting waits key off of), or null on timeout. Reading
 *  the marker frame's own recorded timestamp, rather than `nowT(client)` at the moment this
 *  poll notices it, keeps the anchor accurate to within one `POLL_MS` tick instead of drifting
 *  by however long the polling loop took to wake up. */
async function waitForReplyStarted(client: CallClient, markerCount: number, timeoutMs: number): Promise<number | null> {
  const deadline = nowT(client) + timeoutMs;
  for (;;) {
    if (client.audioTimestamps.length > markerCount) return client.audioTimestamps[markerCount]!;
    if (nowT(client) > deadline) return null;
    await sleep(POLL_MS);
  }
}

/** Shared by `waitBeforeSpeaking` and `waitForGreeting`'s fallback: give the agent a short
 *  grace window (from `markerCount`, not "now" -- callers may have already waited) to start
 *  speaking at all; if it does, wait for that reply to settle. Never speaks or sleeps a
 *  trailing pause itself -- that's each caller's own job. */
async function graceWindowThenSettle(client: CallClient, markerCount: number, warnings: string[]): Promise<void> {
  const graceDeadline = nowT(client) + GREETING_GRACE_MS;
  while (nowT(client) < graceDeadline && client.audioTimestamps.length === markerCount) {
    await sleep(POLL_MS);
  }
  if (client.audioTimestamps.length > markerCount) {
    const { settled } = await waitForReplySettled(client, REPLY_SETTLE_TIMEOUT_MS);
    if (!settled) warnings.push(`reply did not settle within ${REPLY_SETTLE_TIMEOUT_MS}ms; speaking the next line anyway`);
  }
}

/** Ordinary (non-FIRST, non-barge-in) inter-turn wait: give the agent a short grace window
 *  to start speaking at all; if it does, wait for that reply to settle; either way, then
 *  wait the turn's own `pause_ms` before speaking. */
async function waitBeforeSpeaking(client: CallClient, pauseMs: number, warnings: string[]): Promise<void> {
  await graceWindowThenSettle(client, client.audioTimestamps.length, warnings);
  await sleep(pauseMs);
}

/** FIRST-turn-only wait (founder ruling 2026-09-11): the agent now speaks a fixed greeting
 *  first, so this actively waits for that greeting reply to finish -- audio starts, then
 *  settles (the same settle signal every other turn already uses; AssemblyAI does not
 *  surface a separate observable "greeting done" event over this transport) -- instead of
 *  only giving the agent a grace window to decide whether to speak at all. Bounded by
 *  `GREETING_TIMEOUT_MS` (8s) so a missing/misconfigured greeting can never deadlock the
 *  run: on timeout this falls back to the ORIGINAL `GREETING_GRACE_MS` grace-window
 *  behavior, unchanged, via `graceWindowThenSettle`. `timeoutMs` defaults to
 *  `GREETING_TIMEOUT_MS`; tests override it to a small value so the fallback path can be
 *  exercised without a real 8-second wait. */
export async function waitForGreeting(client: CallClient, warnings: string[], timeoutMs = GREETING_TIMEOUT_MS): Promise<void> {
  const markerCount = client.audioTimestamps.length;
  const anchorMs = await waitForReplyStarted(client, markerCount, timeoutMs);
  if (anchorMs === null) {
    warnings.push(
      `no greeting audio observed within ${timeoutMs}ms; falling back to the ${GREETING_GRACE_MS}ms grace-window check before speaking the opening line`,
    );
    await graceWindowThenSettle(client, markerCount, warnings);
    return;
  }
  const { settled } = await waitForReplySettled(client, REPLY_SETTLE_TIMEOUT_MS);
  if (!settled) warnings.push(`greeting did not settle within ${REPLY_SETTLE_TIMEOUT_MS}ms; speaking the opening line anyway`);
}

/** Streams already-synthesized PCM in real time (one frame every FRAME_MS, matching the real
 *  capture cadence -- AssemblyAI's own turn detection depends on realistic timing, not a
 *  dumped buffer). Returns the harness-relative ms the line started and finished streaming.
 *  Split out of `speakLine` below so a barge-in turn can synthesize its line CONCURRENTLY with
 *  waiting out its timing (see `waitForBargeIn`), instead of only starting synthesis once the
 *  wait is already over -- `say`/`ffmpeg` synthesis (audio.ts) is a real subprocess round trip
 *  and was itself eating into the intended barge-in offset when it ran after the wait. */
async function streamPcm(client: CallClient, pcm: Buffer): Promise<{ startedMs: number; endedMs: number }> {
  const frames = chunkToFrames(pcm);
  const startedMs = nowT(client);
  for (const frame of frames) {
    client.send({ type: 'audio', data: frame.toString('base64') });
    await sleep(FRAME_MS);
  }
  return { startedMs, endedMs: nowT(client) };
}

/** Synthesizes one caller line and streams it -- the ordinary (non-barge-in) path, where
 *  synthesis latency landing before the line is spoken is not a determinism concern. */
async function speakLine(client: CallClient, text: string, voice: string | undefined): Promise<{ startedMs: number; endedMs: number }> {
  const pcm = await synthesizeLine(text, voice);
  return streamPcm(client, pcm);
}

/** How a `barge_in_after_ms` turn's timing was decided, returned by `waitForBargeIn` once it
 *  is time to speak -- `note` builds this turn's TurnGapRecord.note (report.ts) from the
 *  actual streaming start time once that's known (after synthesis, which the caller runs
 *  concurrently with this wait). Kept free of any audio synthesis itself so the anchor/timeout
 *  logic is unit-testable against a fake CallClient with no real TTS involved. */
export interface BargeInTiming {
  /** ms since connect that the targeted reply's first audio frame arrived, or null if none
   *  arrived within the anchor timeout (the bounded fallback below). */
  anchor_ms: number | null;
  note(startedMs: number): string;
}

/** Waits out one barge-in turn's timing so the interruption lands relative to the AGENT'S OWN
 *  reply, not to whenever the harness happened to get around to checking for one: waits for
 *  the first NEW audio frame after the caller's previous turn ended (i.e. `reply.audio.first`
 *  for the reply being barged into), then waits `turn.barge_in_after_ms` more from THAT anchor
 *  (not from "now") before returning. Bounded by `timeoutMs` (default
 *  `BARGE_IN_ANCHOR_TIMEOUT_MS`) -- if no reply audio starts in time, falls back to the
 *  pre-fix behaviour (sleep `barge_in_after_ms` from right now, then speak with no real
 *  interruption to reproduce) and records a warning, exactly as a missing greeting does in
 *  `waitForGreeting` above. Never speaks or synthesizes anything itself -- the caller decides
 *  what to do with the resolved timing (see `runTurns`, which starts synthesis in parallel
 *  with this wait so that latency never lands on top of the deterministic offset). */
export async function waitForBargeIn(
  client: CallClient,
  turn: ScenarioTurn,
  warnings: string[],
  timeoutMs: number = BARGE_IN_ANCHOR_TIMEOUT_MS,
): Promise<BargeInTiming> {
  const bargeInAfterMs = turn.barge_in_after_ms;
  if (bargeInAfterMs === undefined) {
    throw new Error(`waitForBargeIn called on turn ${turn.id}, which has no barge_in_after_ms`);
  }
  const markerCount = client.audioTimestamps.length;
  const anchorMs = await waitForReplyStarted(client, markerCount, timeoutMs);
  if (anchorMs === null) {
    warnings.push(
      `turn ${turn.id}: expected a reply to barge into, but no reply audio started within ${timeoutMs}ms; falling back to speaking ${bargeInAfterMs}ms from now with no real interruption to reproduce`,
    );
    await sleep(bargeInAfterMs);
    return {
      anchor_ms: null,
      note: () => `barge-in: no agent audio observed within ${timeoutMs}ms; spoke ${bargeInAfterMs}ms after this turn began (unanchored fallback)`,
    };
  }
  const target = anchorMs + bargeInAfterMs;
  const remaining = target - nowT(client);
  if (remaining > 0) await sleep(remaining);
  return {
    anchor_ms: anchorMs,
    note: (startedMs: number) => `barge-in: spoke ${Math.round(startedMs - anchorMs)}ms after agent audio started`,
  };
}

/** Bug fix (2026-09-11, PROVEN from scripts/rehearse/reports/2026-09-11T16-35-23-
 *  scenario-a-dana-legitimate.md): the server now hangs up on its own once it reaches
 *  SEALED (packages/server/src/call/session.ts's CLOSE grace period/hard cap) -- a scripted
 *  or LLM caller that still has turns queued must notice the call already ended and stop,
 *  rather than keep sending scripted lines (or asking an LLM for more) into a closed
 *  socket. "agent_closed" is the NORMAL, expected shape of that end (the fix this function
 *  exists to accommodate) and produces no warning; any other reason ending the call mid-
 *  script is still worth a warning (an idle timeout, a cap, or a dropped socket cutting the
 *  scenario short is not something this fix is about). Pure and independently testable --
 *  the two loops below only ever call it, never re-implement the branching. */
export function scriptedCallerShouldStop(endedReason: string | null): { stop: boolean; warning: string | null } {
  if (endedReason === null) return { stop: false, warning: null };
  if (endedReason === 'agent_closed') return { stop: true, warning: null };
  return { stop: true, warning: `call already ended (reason: ${endedReason}) before every scripted turn was spoken; stopping the caller` };
}

export interface TurnRunOutcome {
  warnings: string[];
  /** `note`, when set, is this turn's own TurnGapRecord.note verbatim (currently only set for
   *  a scripted `barge_in_after_ms` turn -- see `waitForBargeIn`'s `note()` builder); absent
   *  entries fall back to `computeTurnGaps`' generic per-case text, unchanged. */
  callerEndTimes: { turn_id: string; caller_end_ms: number; barge_in: boolean; note?: string }[];
  resolvedLines: ResolvedLineRecord[];
}

/** Injected so `runTurns` never has to know about HTTP/URLs/session ids itself (same shape
 *  as llmCaller.ts's own `HttpClient` injection) -- run.ts binds this to
 *  `forceDropAai(url, session.session_id)` (wsClient.ts). Omitted entirely for a run that
 *  never wires it up (every existing scenario/caller before this feature). */
export interface TurnRunDeps {
  dropAai?: () => Promise<{ ok: boolean; status: number }>;
}

/** Judge-sim finding 2026-09-11 (docs/JUDGE-SIM-2026-09-11.md addendum: "zero AssemblyAI
 *  socket drops occurred -- session.resume never exercised"). Pure and independently
 *  testable (like `scriptedCallerShouldStop` above) -- decides what, if anything, to do
 *  about one turn's `drop_aai_before` flag, given whatever `dropAai` hook (if any) this run
 *  was wired with. Never throws: a scenario with no `dropAai` wired, or a target server with
 *  the debug hook disabled, both just produce a warning and let the scripted turns continue
 *  -- `Scenario.expected.require_aai_link_restored` (expectations.ts) is what actually fails
 *  the run if the drop/resume evidence never shows up. */
export async function maybeDropAai(
  turn: ScenarioTurn,
  dropAai: (() => Promise<{ ok: boolean; status: number }>) | undefined,
): Promise<{ attempted: boolean; ok: boolean; warning: string | null }> {
  if (!turn.drop_aai_before) return { attempted: false, ok: true, warning: null };
  if (!dropAai) {
    return {
      attempted: true,
      ok: false,
      warning: `turn ${turn.id}: drop_aai_before requested a forced AAI drop, but no dropAai hook was wired into this run -- continuing without forcing a drop`,
    };
  }
  const result = await dropAai();
  if (!result.ok) {
    return {
      attempted: true,
      ok: false,
      warning: `turn ${turn.id}: drop_aai_before requested a forced AAI drop, but the debug hook responded HTTP ${result.status} (is COUNTERSIGN_DEBUG_HOOKS=1 set on the target server?) -- continuing without forcing a drop`,
    };
  }
  return { attempted: true, ok: true, warning: null };
}

/** Plays every scripted caller turn against a live, already-`start`ed call. Does not itself
 *  wait for a verdict -- see `waitForVerdict` below, called separately by run.ts once every
 *  turn has been spoken. Reactive turns (carrying `respond`) have their actual line decided
 *  right before speaking, from whatever the live agent has said so far -- see
 *  truthEngine.ts's `resolveTurnText`, which is why this has to happen turn-by-turn rather
 *  than all up front. */
export async function runTurns(
  client: CallClient,
  scenario: Scenario,
  voice: string | undefined,
  deps: TurnRunDeps = {},
): Promise<TurnRunOutcome> {
  const warnings: string[] = [];
  const callerEndTimes: TurnRunOutcome['callerEndTimes'] = [];
  const resolvedLines: ResolvedLineRecord[] = [];

  for (let turnIdx = 0; turnIdx < scenario.turns.length; turnIdx++) {
    const { stop, warning } = scriptedCallerShouldStop(client.endedReason());
    if (stop) {
      if (warning) warnings.push(warning);
      break;
    }
    const turn = scenario.turns[turnIdx]!;
    const dropOutcome = await maybeDropAai(turn, deps.dropAai);
    if (dropOutcome.warning) warnings.push(dropOutcome.warning);
    if (turn.barge_in_after_ms !== undefined) {
      // Resolved up front (safe: a barge-in turn is documented to carry no `respond` block --
      // the interruption itself is the point, not a reaction to a still-in-flight reply -- so
      // `lastAgentText` here is the same value resolving after the wait would see) so synthesis
      // can start CONCURRENTLY with `waitForBargeIn`'s timing wait below, instead of only after
      // it -- see `streamPcm`'s doc comment for why that ordering was the actual bug.
      const lastAgentText = lastAgentTranscriptText(client);
      const resolved = resolveTurnText(turn, scenario.truth, lastAgentText);
      resolvedLines.push({ turn_id: turn.id, text: resolved.text, source: resolved.source, reacted_to: lastAgentText });
      const pcmPromise = synthesizeLine(resolved.text, voice);
      const timing = await waitForBargeIn(client, turn, warnings);
      const pcm = await pcmPromise;
      const { startedMs, endedMs } = await streamPcm(client, pcm);
      callerEndTimes.push({ turn_id: turn.id, caller_end_ms: endedMs, barge_in: true, note: timing.note(startedMs) });
      continue;
    } else if (turnIdx === 0) {
      // Founder ruling 2026-09-11: the agent greets first -- wait for that greeting to
      // finish (bounded, never deadlocks) before the caller's opening line.
      await waitForGreeting(client, warnings);
      await sleep(turn.pause_ms ?? 400);
    } else {
      await waitBeforeSpeaking(client, turn.pause_ms ?? 400, warnings);
    }
    const lastAgentText = lastAgentTranscriptText(client);
    const resolved = resolveTurnText(turn, scenario.truth, lastAgentText);
    resolvedLines.push({ turn_id: turn.id, text: resolved.text, source: resolved.source, reacted_to: lastAgentText });
    const { endedMs } = await speakLine(client, resolved.text, voice);
    callerEndTimes.push({ turn_id: turn.id, caller_end_ms: endedMs, barge_in: false });
  }

  return { warnings, callerEndTimes, resolvedLines };
}

export interface LlmTurnCaps {
  max_turns: number;
  /** Wall-clock ceiling (ms) for the LLM caller's OWN turn loop -- independent of, and
   *  typically tighter than, the scenario's own `expected.max_wall_ms` (bounds API spend
   *  even if the deterministic engine never reaches a verdict). */
  max_wall_ms: number;
  max_words_per_line: number;
}

export interface LlmTurnRunOutcome extends TurnRunOutcome {
  llm_turns: number;
}

/** The open-ended counterpart to `runTurns`: instead of a fixed scenario turn list, an
 *  external model plays the caller live (llmCaller.ts). Each round: wait for the agent's
 *  reply to settle (or the opening grace window, on the first turn), read its transcript
 *  text, ask the model for the caller's next line via `requestNextCallerLine`, speak it (with
 *  a real barge-in if the model asked for one), and repeat -- bounded by `caps.max_turns` and
 *  `caps.max_wall_ms` so a stuck or chatty model can never wedge a run indefinitely. Stops
 *  early (with a warning, not a throw) on either cap or on a request failure -- the run.ts
 *  caller still gets to wait for whatever verdict the call reached before the model stopped. */
export async function runLlmTurns(
  client: CallClient,
  scenario: Scenario,
  provider: LlmProvider,
  model: string,
  apiKey: string,
  caps: LlmTurnCaps,
  http: HttpClient,
  voice: string | undefined,
): Promise<LlmTurnRunOutcome> {
  if (!scenario.persona) {
    throw new Error(`scenario "${scenario.name}" has no "persona" field -- required for --caller llm`);
  }
  const persona = scenario.persona;
  const warnings: string[] = [];
  const callerEndTimes: TurnRunOutcome['callerEndTimes'] = [];
  const resolvedLines: ResolvedLineRecord[] = [];
  const history: LlmTurnHistoryEntry[] = [];
  const deadline = nowT(client) + caps.max_wall_ms;

  let turnIndex = 0;
  while (turnIndex < caps.max_turns) {
    const { stop, warning } = scriptedCallerShouldStop(client.endedReason());
    if (stop) {
      if (warning) warnings.push(`llm caller turn ${turnIndex}: ${warning}`);
      break;
    }
    if (nowT(client) > deadline) {
      warnings.push(`llm caller: stopped after ${turnIndex} turn(s), hit its own max_wall_ms cap (${caps.max_wall_ms}ms)`);
      break;
    }

    if (turnIndex === 0) {
      // Founder ruling 2026-09-11: the agent greets first -- wait for that greeting to
      // finish (bounded, never deadlocks) before asking the model for its opening line.
      await waitForGreeting(client, warnings);
    } else {
      const { settled } = await waitForReplySettled(client, REPLY_SETTLE_TIMEOUT_MS);
      if (!settled) warnings.push(`llm caller turn ${turnIndex}: reply did not settle within ${REPLY_SETTLE_TIMEOUT_MS}ms; asking for the next line anyway`);
    }

    const lastAgentText = lastAgentTranscriptText(client);
    if (lastAgentText !== null && (history.length === 0 || history[history.length - 1]!.text !== lastAgentText)) {
      history.push({ speaker: 'agent', text: lastAgentText });
    }

    let turnResult;
    try {
      turnResult = await requestNextCallerLine(http, provider, model, apiKey, persona, history, caps.max_words_per_line);
    } catch (err) {
      warnings.push(`llm caller turn ${turnIndex}: request failed (${err instanceof Error ? err.message : String(err)}); stopping the LLM caller for this call`);
      break;
    }
    history.push({ speaker: 'caller', text: turnResult.text });

    if (turnResult.barge_in) {
      const markerCount = client.audioTimestamps.length;
      const anchorMs = await waitForReplyStarted(client, markerCount, BARGE_IN_REPLY_START_TIMEOUT_MS);
      if (anchorMs === null) warnings.push(`llm caller turn ${turnIndex}: model asked to barge in, but there was no reply audio to interrupt; speaking anyway`);
    }
    const { endedMs } = await speakLine(client, turnResult.text, voice);

    const turnId = `llm-${turnIndex + 1}`;
    resolvedLines.push({ turn_id: turnId, text: turnResult.text, source: 'llm', reacted_to: lastAgentText });
    callerEndTimes.push({ turn_id: turnId, caller_end_ms: endedMs, barge_in: turnResult.barge_in });
    turnIndex++;
  }

  return { warnings, callerEndTimes, resolvedLines, llm_turns: turnIndex };
}

/** Post-hoc turn-gap computation: for each non-barge-in turn, the gap is the time from that
 *  turn's own caller_end_ms to the first audio frame received afterward. A barge-in turn's
 *  "gap" is not a meaningful "how long did the agent take" number (the caller spoke
 *  deliberately while a reply was already in flight), so it is reported as a note instead. */
export function computeTurnGaps(client: CallClient, callerEndTimes: TurnRunOutcome['callerEndTimes']): TurnGapRecord[] {
  const audioTimes = client.audioTimestamps;
  return callerEndTimes.map(({ turn_id, caller_end_ms, barge_in, note }) => {
    if (barge_in) {
      return { turn_id, caller_end_ms, first_reply_audio_ms: null, gap_ms: null, note: note ?? 'barge-in turn: gap not meaningful' };
    }
    const firstAfter = audioTimes.find((t) => t > caller_end_ms);
    if (firstAfter === undefined) {
      return { turn_id, caller_end_ms, first_reply_audio_ms: null, gap_ms: null, note: 'no reply audio observed after this turn' };
    }
    return { turn_id, caller_end_ms, first_reply_audio_ms: firstAfter, gap_ms: firstAfter - caller_end_ms };
  });
}

/** Waits for ScreenState.verdict to leave 'PENDING' (every other Verdict value is terminal --
 *  PROVEN: packages/engine/src/types.ts:241, "LAW 2: STAGE is the ceiling. There is no
 *  release." -- all of ESCALATE/STAGE/FREEZE/NO_ACTION are decision outcomes, not
 *  in-progress states). */
export async function waitForVerdict(
  client: CallClient,
  timeoutMs: number,
): Promise<{ reached: boolean; verdict: Verdict | 'PENDING' | null; at_ms: number }> {
  const deadline = nowT(client) + timeoutMs;
  for (;;) {
    const state = client.latestState();
    const t = nowT(client);
    if (state && state.verdict !== 'PENDING') {
      return { reached: true, verdict: state.verdict, at_ms: t };
    }
    if (t > deadline) {
      return { reached: false, verdict: state?.verdict ?? null, at_ms: t };
    }
    await sleep(POLL_MS);
  }
}

/** After a terminal verdict is observed, the countersign's terminal actions (open_incident,
 *  alert_principal, the hash export, ...) still run server-side over one or more further
 *  ticks (packages/server/src/call/session.ts's `runTerminalActionsIfNeeded`). Best-effort:
 *  give that a short additional window to land before ending the call, so the report can
 *  show the export hash when the stack actually produced one in time. Never fails the run if
 *  it doesn't show up -- this is polish for the report, not a pass/fail condition. */
export async function waitForCountersignSettle(client: CallClient, timeoutMs = 8000): Promise<void> {
  const deadline = nowT(client) + timeoutMs;
  for (;;) {
    const state = client.latestState();
    if (state && (state.forensic.export_hash !== null || state.forensic.countersign.recomputed)) return;
    if (nowT(client) > deadline) return;
    await sleep(POLL_MS);
  }
}

export function frameMs(): number {
  return FRAME_MS;
}
