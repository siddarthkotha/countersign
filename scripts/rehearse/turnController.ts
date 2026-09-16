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
export function lastAgentTranscriptText(client: CallClient): string | null {
  const state = client.latestState();
  if (!state) return null;
  for (let i = state.transcript.length - 1; i >= 0; i--) {
    const line = state.transcript[i]!;
    if (line.speaker === 'agent') return line.text;
  }
  return null;
}

/** Count of agent transcript lines recorded so far -- used only by `waitForPatientTurn`
 *  (2026-09-14 fix) to tell whether a reply it just waited out actually produced a NEW
 *  transcript line, as opposed to `lastAgentTranscriptText` still returning a STALE line left
 *  over from an earlier reply that produced no transcript of its own. */
function agentTranscriptCount(client: CallClient): number {
  const state = client.latestState();
  if (!state) return 0;
  let count = 0;
  for (const line of state.transcript) {
    if (line.speaker === 'agent') count++;
  }
  return count;
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

/** PROVEN gap (2026-09-13): the deterministic engine's own STALL/lookup-in-flight goals
 *  (packages/engine/src/prompt.ts) phrase mid-verification holding lines in the model's own
 *  words, never a fixed sentence -- so this is a small, generic phrase list, not a single
 *  string match. Case-insensitive. Used only by patient-mode waits (`waitForPatientTurn`
 *  below) to tell "the agent is stalling for time" apart from a real substantive reply or the
 *  engine's actual CLOSE line -- never a verdict signal (LAW 3 untouched; this is timing
 *  logic in a test harness, not the product). */
export const HOLDING_LINE_PATTERNS: RegExp[] = [
  /one moment/i,
  /please hold/i,
  /hold on/i,
  /bear with me/i,
  /checking/i,
  /verifying/i,
  /let me verify/i,
  /while i verify/i,
];

/** Detects whether text contains a question that requires a caller response. Checks for
 *  "?" or imperative question forms like "what is", "which", "who", "can you", "please state".
 *  PROVEN gap (2026-09-14, defect 1): a reply like "One moment while I verify. What is the
 *  amount?" starts with a holding line prefix but contains a real question -- it is NOT a holding
 *  line, it is a request for specific information the caller must answer. */
export function containsQuestion(text: string): boolean {
  if (text.includes('?')) return true;
  const lower = text.toLowerCase();
  return (
    /\bwhat\s+is\b/.test(lower) ||
    /\bwhich\b/.test(lower) ||
    /\bwho\s+is\b/.test(lower) ||
    /\bcan\s+you\b/.test(lower) ||
    /\bplease\s+state\b/.test(lower)
  );
}

export function isHoldingLine(text: string): boolean {
  const startsWithHolding = HOLDING_LINE_PATTERNS.some((p) => p.test(text));
  // A holding line that contains a question is not a pure holding line -- the agent is
  // asking for something specific, not just stalling for time (defect 1, 2026-09-14).
  if (startsWithHolding && containsQuestion(text)) return false;
  return startsWithHolding;
}

/** Copied, NOT imported, verbatim from `closeSentence` in packages/engine/src/fsm.ts:207-218
 *  -- that function is not exported (and this is a test harness, BRIEF LAW 5, so it never
 *  reaches into product internals). Cites the source so a future edit to fsm.ts's closing
 *  wording is a merge conflict this file's author has to notice, not a silently stale copy:
 *  if `closeSentence`'s four return strings ever change, these four must be updated to
 *  match, or `isClosingLine` below silently stops firing. Used only by patient-mode waits to
 *  recognize "the agent has reached its real final line" so the caller stops talking instead
 *  of speaking over the goodbye. */
/** Same copy as above, indexed by the verdict each sentence actually belongs to (`fsm.ts`'s
 *  `closeSentence` switches on `Verdict`) -- `NO_ACTION` stands in for that function's
 *  `default` branch (PENDING is not a terminal verdict a call ever closes on, per LAW 2, so
 *  it carries no sentence here). Added 2026-09-13 (PROVEN gap: run.ts's grading used to
 *  accept any of the four sentences from ANY agent line as proof of a spoken close, which
 *  would have let a run that reached FREEZE but only ever spoke the STAGE sentence -- or no
 *  sentence at all, paired with a coincidental substring match -- pass; the grader needs the
 *  ONE sentence that matches the call's ACTUAL verdict). `ENGINE_CLOSE_SENTENCES` above is
 *  now derived from this map's values so the two can never drift apart. */
export const CLOSE_SENTENCE_BY_VERDICT: Record<'STAGE' | 'FREEZE' | 'ESCALATE' | 'NO_ACTION', string> = {
  STAGE: 'Your request is staged for independent approval. The payment is not released. Goodbye.',
  FREEZE: 'This transfer is frozen and an incident is open. The payment is not released. Goodbye.',
  ESCALATE: 'This cannot be completed by voice. A callback on the registered number will follow. Goodbye.',
  NO_ACTION: 'Thank you for calling. Goodbye.',
};

export const ENGINE_CLOSE_SENTENCES: readonly string[] = Object.values(CLOSE_SENTENCE_BY_VERDICT);

export function isClosingLine(text: string): boolean {
  return ENGINE_CLOSE_SENTENCES.some((s) => text.includes(s));
}

/** Strips everything but letters/digits/spaces and collapses whitespace, so a close-line
 *  match tolerates STT/TTS punctuation and casing drift ("The payment is not released," vs "the
 *  payment is not released") without tolerating a genuinely different sentence. */
function normalizeForCloseMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Shortest normalized prefix `isClosingLineStart` will act on -- long enough to clear the
 *  four close sentences' shared opening words (FREEZE and ESCALATE both start "this ", 5
 *  chars) so a generic partial like "This" or "This is" never counts as the start of a close
 *  sentence, short enough to fire well before a real close sentence would ever finish. */
const MIN_CLOSE_PREFIX_CHARS = 10;

/** PROVEN gap (2026-09-14, scripts/rehearse/reports/2026-09-14T13-47-07-miller-patient
 *  .diagnostics.json): the run's actual FREEZE close reply was interrupted mid-sentence --
 *  the only transcript line it ever produced was "This transfer is frozen", never the full
 *  `CLOSE_SENTENCE_BY_VERDICT.FREEZE` text -- because the caller (see `waitForPatientTurn`'s
 *  fix below) spoke its next scripted line over it. `isClosingLine` above requires the WHOLE
 *  sentence and so can never catch this in time; this instead asks "does any close sentence
 *  START WITH this (possibly partial, possibly interrupted) transcript text" -- true the
 *  moment the agent has clearly begun a close sentence, whether or not it ever gets to
 *  finish. A full close sentence trivially matches too (it is its own prefix). Guarded by
 *  `MIN_CLOSE_PREFIX_CHARS` so a one- or two-word fragment shared by more than one close
 *  sentence (or by ordinary conversation) never false-positives. */
export function isClosingLineStart(text: string): boolean {
  const partial = normalizeForCloseMatch(text);
  if (partial.length < MIN_CLOSE_PREFIX_CHARS) return false;
  return ENGINE_CLOSE_SENTENCES.some((s) => normalizeForCloseMatch(s).startsWith(partial));
}

/** The close sentence's own final substantive clause -- e.g. "The payment is not released" for FREEZE,
 *  "The payment is not released" for STAGE -- with the trailing "Goodbye." clause
 *  dropped. Used as the lenient fallback match: a transcript that got the closing "Goodbye"
 *  and this one distinguishing clause, but not the sentence's opening clause verbatim (a
 *  live model's own minor rewording, or the caller/harness's STT dropping a word), still
 *  counts as "the close line was spoken" -- ANY other combination (e.g. "Goodbye" alone, or
 *  the opening clause without "Goodbye") does not. */
function lastSubstantiveClause(sentence: string): string {
  const clauses = sentence
    .split('.')
    .map((c) => c.trim())
    .filter((c) => c.length > 0 && c.toLowerCase() !== 'goodbye');
  return clauses[clauses.length - 1] ?? sentence;
}

/** True iff `agentLines` (every agent transcript line, in order, concatenated -- the close
 *  sentence can land split across two transcript records when a reply gets interrupted mid
 *  final-clause and the model is asked again) together contain the ONE close sentence that
 *  matches `verdict` -- either verbatim (modulo `normalizeForCloseMatch`'s case/punctuation/
 *  whitespace leniency) or, failing that, ALL of this verdict's own substantive clauses
 *  AND the word "goodbye", present somewhere in the concatenation. Never matches on a
 *  DIFFERENT verdict's sentence, and never matches on "goodbye" alone. */
export function closeLineSpokenForVerdict(verdict: 'STAGE' | 'FREEZE' | 'ESCALATE' | 'NO_ACTION', agentLines: readonly string[]): boolean {
  const concatenated = normalizeForCloseMatch(agentLines.join(' '));
  const fullSentence = CLOSE_SENTENCE_BY_VERDICT[verdict];
  if (concatenated.includes(normalizeForCloseMatch(fullSentence))) return true;

  // Lenient fallback: check that ALL substantive clauses are present, allowing the model
  // to rephrase any individual clause while keeping all the key parts
  const clauses = fullSentence
    .split('.')
    .map((c) => c.trim())
    .filter((c) => c.length > 0 && c.toLowerCase() !== 'goodbye');

  const allClausesPresent = clauses.every((clause) =>
    concatenated.includes(normalizeForCloseMatch(clause))
  );
  return allClausesPresent && concatenated.includes('goodbye');
}

/** Scenario-level default for `Scenario.agent_silence_fail_ms` (types.ts) when a patient-mode
 *  turn doesn't specify one. */
export const DEFAULT_AGENT_SILENCE_FAIL_MS = 12_000;

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

/** PROVEN gap (2026-09-14, same report as `MIN_SPOKEN_MS` above): the run's real close reply
 *  ("This transfer is frozen...") was interrupted by the caller's next scripted line before
 *  it, or the ordinary `waitForReplySettled` silence check, ever finished -- patient mode must
 *  never let that happen. Same polling shape as `waitForReplySettled`, but on EVERY tick also
 *  checks whether the agent's latest transcript line has already begun a close sentence
 *  (`isClosingLineStart`, which matches a partial/interrupted line, unlike `isClosingLine`);
 *  if so, returns immediately with `closingDetected: true` -- `waitForPatientTurn` treats that
 *  as an immediate `{outcome:'stop'}`, without waiting out the rest of this function's own
 *  settle logic. Used only by `waitForPatientTurn`; every other wait in this file keeps using
 *  the plain `waitForReplySettled` (this scenario is patient-mode-specific: an ordinary or
 *  barge-in turn's caller line is already scripted for a fixed cadence). */
async function waitForReplySettledOrClose(client: CallClient, timeoutMs: number): Promise<{ settled: boolean; closingDetected: boolean }> {
  const deadline = nowT(client) + timeoutMs;
  for (;;) {
    const text = lastAgentTranscriptText(client);
    if (text !== null && isClosingLineStart(text)) return { settled: true, closingDetected: true };
    const t = nowT(client);
    const la = lastAudioAt(client);
    const silentEnough = la === null || t - la >= SILENCE_MS;
    const state = client.latestState();
    const notSpeaking = !state || state.agent_status !== 'SPEAKING';
    if (silentEnough && notSpeaking) return { settled: true, closingDetected: false };
    if (t > deadline) return { settled: false, closingDetected: false };
    await sleep(POLL_MS);
  }
}

/** PROVEN gap (2026-09-14, scripts/rehearse/reports/2026-09-14T13-47-07-miller-patient
 *  .diagnostics.json): a reply whose `reply.started`/`reply.done` landed 64ms apart with no
 *  transcript.agent text at all -- a real CLOSE-goal retry the server sent and then abandoned
 *  -- must never count as "the agent spoke". Used only by `waitForPatientTurn` (below): a
 *  reply counts as spoken once it has produced a non-empty transcript line, OR, failing that
 *  (transcript not observed yet), at least this many ms of audio between its first frame and
 *  its last. A person does not answer a reply that said nothing and played for a blink. */
export const MIN_SPOKEN_MS = 700;

/** Resolves once at least one NEW audio frame has arrived since `markerCount` (i.e. a reply
 *  has started) -- returns that frame's own client-relative timestamp (the `reply.audio.first`
 *  anchor this module's barge-in and greeting waits key off of), or null on timeout. Reading
 *  the marker frame's own recorded timestamp, rather than `nowT(client)` at the moment this
 *  poll notices it, keeps the anchor accurate to within one `POLL_MS` tick instead of drifting
 *  by however long the polling loop took to wake up. */
/** Exported (2026-09-14, free-play addition) so scripts/rehearse/freePlay.ts can anchor an
 *  improvised barge-in to a reply's own first audio frame the same way `waitForBargeIn`
 *  does, without duplicating this polling loop. Every other caller in this file is
 *  unaffected -- this is a visibility change only. */
export async function waitForReplyStarted(client: CallClient, markerCount: number, timeoutMs: number): Promise<number | null> {
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

/** How a patient-mode wait (`waitForPatientTurn` below) resolved: `'speak'` -- proceed to
 *  speak this turn's line, exactly as the ordinary caller would; `'stop'` -- the agent's
 *  reply was an engine CLOSE sentence (`isClosingLine`), so the caller stops talking and lets
 *  the call end (not a failure); `'fail'` -- the exact bug this feature exists to catch: a
 *  HOLDING line (`isHoldingLine`), then no further reply started within
 *  `agent_silence_fail_ms` -- the run FAILS with `agent_silent_after_hold`. */
export interface PatientWaitResult {
  outcome: 'speak' | 'stop' | 'fail';
}

/** PROVEN gap (2026-09-13, see types.ts's ScenarioTurn.wait_for_agent doc comment): the
 *  patient-caller wait for one non-opening, non-barge-in turn. Unlike `waitBeforeSpeaking`
 *  (a short grace window, then speak regardless of whether the agent ever replied), this:
 *
 *   1. waits for a NEW reply -- one whose first audio frame arrives after this call's current
 *      `audioTimestamps` marker, i.e. after the caller's own previous line ended -- to fully
 *      START, then to SETTLE (the same `reply.audio.first`/silence-plus-not-SPEAKING signals
 *      every other wait in this file already uses);
 *   2. reads that reply's transcript text (`lastAgentTranscriptText`) and judges it:
 *      - an engine CLOSE sentence (`isClosingLine`) -> resolves `{outcome:'stop'}` immediately;
 *      - a HOLDING line (`isHoldingLine`) -> loops back to step 1, waiting up to
 *        `agentSilenceFailMs` this time for a FURTHER new reply (never assumes a holding line
 *        is the real answer) -- if none starts within that window, resolves
 *        `{outcome:'fail'}`, the exact "holding line, then permanent silence" bug this feature
 *        was built to catch;
 *      - anything else -> resolves `{outcome:'speak'}`.
 *
 *  The very FIRST wait-for-a-reply-to-start in this loop is bounded the same way (by
 *  `agentSilenceFailMs`) but is NOT preceded by a holding line yet, so a genuinely silent
 *  agent from turn one -- never having said anything to hold on -- still resolves `speak`
 *  (with a warning), the same tolerant fallback discipline every other wait in this file
 *  uses; ONLY "a holding line, then silence" is a hard fail. This is a deliberate design
 *  choice, not a spec requirement: rather than invent a second, separate timeout for "wait
 *  for the very first reply to start" (the earlier BRIEF task text names
 *  `agent_silence_fail_ms` only for the post-hold wait), this reuses the one scenario-level
 *  knob for every "wait for the agent's next reply to start" step in patient mode -- one
 *  configurable number, not two, and the same semantics either way: "if the agent goes
 *  silent for this long while we're waiting on it, something is wrong enough to at least
 *  warn about, and if it just finished stalling, wrong enough to fail."
 *
 *  Two further fixes, both PROVEN gaps from 2026-09-14 (scripts/rehearse/reports/
 *  2026-09-14T13-47-07-miller-patient.md and its .diagnostics.json -- read together):
 *
 *   1. A reply only counts as "the agent spoke" if it produced a non-empty transcript.agent
 *      line, or (transcript not observed yet) at least `MIN_SPOKEN_MS` of audio between its
 *      first and last frame. The deployed server retried its CLOSE-goal reply three times in
 *      a row; the MIDDLE attempt's `reply.started`/`reply.done` landed 64ms apart with no
 *      transcript at all. The old code judged the turn by whatever `lastAgentTranscriptText`
 *      returned regardless -- here, a STALE line left over from the first attempt -- and fell
 *      through to `speak`. Such a reply is now ignored outright: the loop goes back to
 *      waiting for a further new reply, still bounded by `agentSilenceFailMs`, without
 *      touching `sawHolding` either way (an empty reply is neither a hold nor an answer).
 *   2. The moment the agent's latest transcript line has BEGUN a close sentence
 *      (`isClosingLineStart`, which matches a partial/interrupted line -- unlike `isClosingLine`
 *      below, which needs the whole sentence), this resolves `{outcome:'stop'}` immediately,
 *      without waiting for that reply to fully settle. The THIRD retry attempt above actually
 *      began "This transfer is frozen" but never finished it: the caller (still mis-timed by
 *      bug #1) spoke its next scripted line first and talked over the goodbye. A scripted
 *      caller must never do that in patient mode -- deliberate talk-over is what the separate
 *      barge-in scenario is for, not this one. */
export async function waitForPatientTurn(client: CallClient, agentSilenceFailMs: number, warnings: string[]): Promise<PatientWaitResult> {
  let markerCount = client.audioTimestamps.length;
  let agentLineCount = agentTranscriptCount(client);
  let sawHolding = false;
  for (;;) {
    const anchorMs = await waitForReplyStarted(client, markerCount, agentSilenceFailMs);
    if (anchorMs === null) {
      if (sawHolding) return { outcome: 'fail' };
      warnings.push(`patient caller: no agent reply started within ${agentSilenceFailMs}ms; speaking the next line anyway`);
      return { outcome: 'speak' };
    }
    const { settled, closingDetected } = await waitForReplySettledOrClose(client, REPLY_SETTLE_TIMEOUT_MS);
    if (closingDetected) return { outcome: 'stop' };
    if (!settled) warnings.push(`patient caller: reply did not settle within ${REPLY_SETTLE_TIMEOUT_MS}ms; judging it anyway`);
    markerCount = client.audioTimestamps.length;
    const newAgentLineCount = agentTranscriptCount(client);
    const audioSpanMs = (lastAudioAt(client) ?? anchorMs) - anchorMs;
    const spoke = newAgentLineCount > agentLineCount || audioSpanMs >= MIN_SPOKEN_MS;
    if (!spoke) {
      // Empty or sub-threshold reply (bug #1 above): nothing was actually said -- keep
      // waiting for a further reply rather than judging stale earlier text.
      continue;
    }
    agentLineCount = newAgentLineCount;
    const text = lastAgentTranscriptText(client);
    if (text !== null && isClosingLine(text)) return { outcome: 'stop' };
    if (text !== null && isHoldingLine(text)) {
      sawHolding = true;
      continue;
    }
    return { outcome: 'speak' };
  }
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

/** Finding 2026-09-11 (PROVEN from tonight's bundles; scratchpad bargein-no-interrupt.md):
 *  every anchored barge-in scenario written so far targeted a LATER, LLM-phrased readback
 *  turn that lasts only ~4s, while AssemblyAI confirms the caller's own speech onset
 *  2.4-3.7s after the caller's audio starts -- so the interruption usually lands AFTER that
 *  reply has already finished (`reply.done` already fired, no `interrupted` line produced).
 *  The fixed greeting ("Meridian payments desk, verification line. How can I help you
 *  today?") lasts 5.3-5.8s in every run -- a much bigger, more reliable barge-in target.
 *
 *  This is the OPENING (turn-index-0) counterpart to `waitForBargeIn` above: an opening turn
 *  that carries `barge_in_after_ms` now takes PRECEDENCE over the ordinary greeting-wait
 *  (`waitForGreeting`) -- it talks over the greeting itself, anchored to the greeting's own
 *  `reply.audio.first` (the very first agent audio frame after connect, since nothing has
 *  been sent by anyone before turn 0), via the exact same `waitForBargeIn` path any other
 *  barge-in turn uses (commit ffb8141) -- never a separate implementation. An opening turn
 *  with no `barge_in_after_ms` is unchanged: it still waits for the greeting to finish.
 *  Returns the `BargeInTiming` `waitForBargeIn` resolved when it barged in, or `null` for the
 *  ordinary greeting-wait path (nothing for a barge-in note to build). `timeoutMs` is plumbed
 *  through to whichever underlying wait is used (tests override it to a small value so
 *  neither fallback path needs a real multi-second wait, same pattern as `waitForGreeting`
 *  and `waitForBargeIn` themselves). */
export async function waitForOpeningTurn(
  client: CallClient,
  turn: ScenarioTurn,
  warnings: string[],
  timeoutMs?: number,
): Promise<BargeInTiming | null> {
  if (turn.barge_in_after_ms !== undefined) {
    return timeoutMs === undefined ? waitForBargeIn(client, turn, warnings) : waitForBargeIn(client, turn, warnings, timeoutMs);
  }
  await (timeoutMs === undefined ? waitForGreeting(client, warnings) : waitForGreeting(client, warnings, timeoutMs));
  return null;
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
  /** Set only when a patient-mode turn (`waitForPatientTurn`) resolved `'fail'` -- the caller
   *  loop stopped speaking further turns immediately, without waiting for any verdict, and
   *  run.ts must fail this run with this exact reason regardless of whatever verdict the call
   *  may separately reach. Absent for every ordinary run, including one with no patient-mode
   *  turn at all. */
  fail_reason?: 'agent_silent_after_hold';
  /** True iff the LAST turn this caller actually spoke carried `hang_up: true` (types.ts's
   *  `ScenarioTurn.hang_up` doc comment) -- run.ts uses this to decide whether the caller
   *  hangs up itself right after speaking (the old, still-correct behavior for a scenario
   *  that deliberately has the caller walk away) or must instead wait for the SERVER's own
   *  `ended` event (`waitForServerHangup` below -- the PROVEN-gap fix, 2026-09-14). False for
   *  every scenario/turn that doesn't set `hang_up`, including a patient-mode `stop` (the
   *  agent's own close line was detected, so the caller must wait for the real hang-up, not
   *  perform one itself) and every LLM-driven call (`runLlmTurns` has no `hang_up` concept). */
  caller_hung_up: boolean;
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
    if (turnIdx === 0) {
      // Founder ruling 2026-09-11: the agent greets first. Ordinarily the caller's opening
      // line waits for that greeting to finish; `waitForOpeningTurn` gives an opening turn's
      // own `barge_in_after_ms` PRECEDENCE over that wait instead (finding 2026-09-11: the
      // greeting is a much bigger, more reliable barge-in target than a later readback --
      // see `waitForOpeningTurn`'s own doc comment). Resolved up front either way (safe: an
      // opening turn is never reactive -- nothing has been said yet to react to) so synthesis
      // can start CONCURRENTLY with the wait below, same reasoning as the generic barge-in
      // branch further down (`streamPcm`'s doc comment covers why that ordering matters).
      const lastAgentText = lastAgentTranscriptText(client);
      const resolved = resolveTurnText(turn, scenario.truth, lastAgentText);
      resolvedLines.push({ turn_id: turn.id, text: resolved.text, source: resolved.source, reacted_to: lastAgentText });
      const pcmPromise = synthesizeLine(resolved.text, voice);
      const timing = await waitForOpeningTurn(client, turn, warnings);
      if (timing === null) {
        // Ordinary opening: the greeting has already finished settling; still honor this
        // turn's own pause before speaking, same as before this dispatcher existed.
        await sleep(turn.pause_ms ?? 400);
      }
      const pcm = await pcmPromise;
      const { startedMs, endedMs } = await streamPcm(client, pcm);
      callerEndTimes.push(
        timing
          ? { turn_id: turn.id, caller_end_ms: endedMs, barge_in: true, note: timing.note(startedMs) }
          : { turn_id: turn.id, caller_end_ms: endedMs, barge_in: false },
      );
      if (turn.hang_up) return { warnings, callerEndTimes, resolvedLines, caller_hung_up: true };
      continue;
    }
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
      if (turn.hang_up) return { warnings, callerEndTimes, resolvedLines, caller_hung_up: true };
      continue;
    }
    // PROVEN gap (2026-09-13, types.ts's ScenarioTurn.wait_for_agent doc comment): a
    // patient-mode turn (this turn's own `wait_for_agent`, or every turn after the first when
    // `scenario.caller_style === 'patient'`) replaces the ordinary grace-window wait below
    // with `waitForPatientTurn`, which can end the run outright (a holding line then silence)
    // or make the caller stop talking (the engine's own closing line) instead of speaking.
    const patientMode = turn.wait_for_agent ?? (scenario.caller_style === 'patient' && turnIdx > 0);
    if (patientMode) {
      const agentSilenceFailMs = scenario.agent_silence_fail_ms ?? DEFAULT_AGENT_SILENCE_FAIL_MS;
      const patientResult = await waitForPatientTurn(client, agentSilenceFailMs, warnings);
      if (patientResult.outcome === 'fail') {
        warnings.push(
          `turn ${turn.id}: agent spoke a holding line and then went silent for ${agentSilenceFailMs}ms with no further reply; failing this run (agent_silent_after_hold)`,
        );
        return { warnings, callerEndTimes, resolvedLines, fail_reason: 'agent_silent_after_hold', caller_hung_up: false };
      }
      if (patientResult.outcome === 'stop') break; // the agent's own closing line -- nothing left to say.
      await sleep(turn.pause_ms ?? 400);
      const lastAgentText = lastAgentTranscriptText(client);
      const resolved = resolveTurnText(turn, scenario.truth, lastAgentText);
      resolvedLines.push({ turn_id: turn.id, text: resolved.text, source: resolved.source, reacted_to: lastAgentText });
      const { endedMs } = await speakLine(client, resolved.text, voice);
      callerEndTimes.push({ turn_id: turn.id, caller_end_ms: endedMs, barge_in: false });
      if (turn.hang_up) return { warnings, callerEndTimes, resolvedLines, caller_hung_up: true };
      continue;
    }
    await waitBeforeSpeaking(client, turn.pause_ms ?? 400, warnings);
    const lastAgentText = lastAgentTranscriptText(client);
    const resolved = resolveTurnText(turn, scenario.truth, lastAgentText);
    resolvedLines.push({ turn_id: turn.id, text: resolved.text, source: resolved.source, reacted_to: lastAgentText });
    const { endedMs } = await speakLine(client, resolved.text, voice);
    callerEndTimes.push({ turn_id: turn.id, caller_end_ms: endedMs, barge_in: false });
    if (turn.hang_up) return { warnings, callerEndTimes, resolvedLines, caller_hung_up: true };
  }

  return { warnings, callerEndTimes, resolvedLines, caller_hung_up: false };
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

  return { warnings, callerEndTimes, resolvedLines, llm_turns: turnIndex, caller_hung_up: false };
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

/** PROVEN gap (2026-09-14, today's reports for miller-patient/structuring-two-wires/
 *  single-wrong-answer/hangup-after-request/judge-out-of-scope/prompt-injection-midcall):
 *  the harness used to send its own `{type:'end'}` right after the verdict/settle wait,
 *  regardless of whether the server had said anything at all -- racing the server's own
 *  CLOSE hang-up (packages/server/src/call/session.ts, CLOSE_TOTAL_MS hard cap = 45s) and its
 *  goodbye. `waitForServerHangup` below waits for the real `ended` event instead, up to
 *  `Math.max(scenario_max_wall_ms, CLOSE_WAIT_MS)` -- 60s gives 15s of margin over the
 *  server's own 45s hard cap even for a scenario whose own `expected.max_wall_ms` is small. */
export const CLOSE_WAIT_MS = 60_000;

export interface ServerHangupResult {
  ended_reason: string | null;
  /** True iff the server never produced its own `ended` event within the wait budget and
   *  the harness had to end the call itself as a last resort (a `caller_ended` reason from
   *  the server's point of view) so the run could still be reported -- always paired with
   *  `fail_reason: 'server_never_hung_up'` in run.ts, same unconditional-fail treatment as
   *  `agent_silent_after_hold`/`close_line_not_spoken` elsewhere in this file. */
  self_ended: boolean;
}

/** Called once every scripted (or LLM-driven) turn is done and the verdict/settle wait has
 *  already run -- see `ScenarioTurn.hang_up`'s doc comment for the one exception (a scenario
 *  whose script has the caller deliberately walk away, which run.ts handles by NOT calling
 *  this at all and instead sending `end` itself immediately, the old behavior, still correct
 *  for that case). Waits for the server's own `ended` event up to `waitMs`; if it never
 *  arrives, sends `end` itself via the injected `sendEnd` (run.ts binds this to
 *  `client.send({type:'end'})`) and gives the socket `fallbackTimeoutMs` more to report a
 *  reason before giving up for good. Never throws -- a run that hits this always finishes and
 *  gets reported, just with `self_ended: true` so run.ts can fail it correctly. */
export async function waitForServerHangup(
  client: CallClient,
  waitMs: number,
  sendEnd: () => void,
  fallbackTimeoutMs: number,
): Promise<ServerHangupResult> {
  const reason = await client.waitForEnded(waitMs);
  if (reason !== null) return { ended_reason: reason, self_ended: false };
  sendEnd();
  const fallbackReason = await client.waitForEnded(fallbackTimeoutMs);
  return { ended_reason: fallbackReason, self_ended: true };
}

export function frameMs(): number {
  return FRAME_MS;
}
