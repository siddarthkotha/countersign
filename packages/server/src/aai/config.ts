// packages/server/src/aai/config.ts
// Pure builder for the AssemblyAI initial session.update payload. No I/O, no randomness --
// given the same AaiSessionConfig, always the same wire payload. Voice, output encoding and
// greeting are set ONCE here, at connect time, because AssemblyAI treats them as immutable
// for the life of the session:
//   "The voice is bound to the TTS connection at session start" / "raising an
//   immutable_field error if altered" and "The output audio encoding is fixed for the
//   session." / "The greeting is spoken once at session start -- cannot be modified
//   afterward." (docs/aai-verify-2026-09-02.md Q1/Q2). Nothing downstream (call/session.ts's
//   per-goal session.update) may resend these three fields.
// The `llm` block (docs/aai-verify-2026-09-02.md Q5) is OMITTED by default -- "By default,
// agents use AssemblyAI's managed conversational model without any configuration needed" --
// and only added when COUNTERSIGN_LLM_MODEL is set. The verify doc did not confirm whether
// the gateway (`https://llm-gateway.assemblyai.com/v1`) accepts the AssemblyAI API key or a
// separate provider key; per the task ruling this passes the AssemblyAI key and documents
// the gap below rather than guessing at a different shape.
// AMENDMENT (controller, 2026-09-02 11:35 AM CDT, from AssemblyAI's own coding-agent
// instructions, docs/ASSEMBLYAI_AGENT_INSTRUCTIONS.md "Voices" section): the documented
// default voice is `anna`. COUNTERSIGN_VOICE overrides it below.
// ONE-BRAIN LIVE PATH (2026-09-22, docs/plans/2026-09-22-one-brain-live-path.md §4, Lane D).
// `formatCallTokenMarker` is Lane B's own fixed marker format (brain/registry.ts) -- imported
// here, not redefined, so the post-bind system_prompt built below and the endpoint's own
// `extractCallToken` (brain/registry.ts, brain/endpoint.ts) can never drift apart on the
// marker's exact shape.
import { formatCallTokenMarker } from '../brain/registry.js';

export const DEFAULT_VOICE = 'anna';

// Bug fix (2026-09-03, founder-observed live run tonight, see
// scripts/rehearse/reports/2026-09-03T23-04-42-scenario-a-dana-legitimate.md): the live
// server used to advertise all eight tool schemas (`aai/schemas.ts`'s `allToolSchemas()`) in
// the FIRST session.update -- including the three EVIDENCE/CONSISTENCY_CHECK lookups, each
// carrying a required `identity_id: string` parameter. The voice model learned that field
// name from the schema and started asking the caller for their "identity id" on live turns,
// violating the standing rule (one question at a time) and inventing a system field the
// caller can never know. Since commit 422d750 the server runs get_request_history/
// check_sso_context/verify_out_of_band itself (`runLookupsIfNeeded`, call/session.ts) the
// instant EVIDENCE/CONSISTENCY_CHECK is reached, and every terminal action was already
// server-run before that (`runTerminalActionsIfNeeded`) -- the model never needed to be
// OFFERED any tool schema at all. `fsm.ts`'s `allowedTools` now returns [] for every
// EngineState for the same reason (LAW 2/3: the ceiling of what the LLM is even offered is
// zero tools, full stop). `LIVE_SESSION_TOOLS` is the empty array `index.ts` passes as
// `tools` in the real (non-fake) connect config -- named and exported here, rather than
// inlined in `index.ts`, so it stays independently testable: `index.ts` is the process
// entrypoint and importing it for a test would execute `server.listen`.
export const LIVE_SESSION_TOOLS: object[] = [];

// Founder ruling 2026-09-11: the agent speaks FIRST on every call, using AssemblyAI's
// connect-time `greeting` field -- "The greeting is spoken once at session start -- cannot
// be modified afterward" (docs/aai-verify-2026-09-02.md Q2). Payments-desk voice, plain
// English, no ids requested, no detection language (LAW 1). `index.ts`'s real connect
// wiring sends this by default now (previously left `greeting` unset there, "the caller
// speaks first" -- see the AaiSessionConfig field doc below for the amendment). Defined
// here, not in `index.ts`, so it's a single named constant a test can import directly --
// `index.ts` has no exports and is the process entrypoint (importing it would run
// `server.listen`, see aai/session.ts's own doc comment on why tests never do that).
//
// AMENDMENT (founder ruling 2026-09-25 7:35 PM, PROVEN tonight -- offline tests streaming
// the founder's recorded voice): AssemblyAI's voice agent ends a caller's FIRST turn early
// during continuous speech (13/13 when a long request was the first thing said; 3/3 whole
// when one short name line came first). The old open-ended "How can I help you today?"
// invited exactly the long first turn that gets cut; asking for the NAME instead makes the
// first turn short by design. Downstream, the engine already answers a name-only first turn
// with ELICIT_REQUEST ("What do you need today?", proven live tonight) and a request-only
// first turn with ELICIT_IDENTITY -- see `packages/engine/src/fsm.ts`'s `INTAKE`/`CLAIM`
// branches, unchanged by this swap. Audited (SONNET-JUSTIFIED lane, 2026-09-25):
// `QUESTION_GOALS` (`packages/server/src/call/questionMatch.ts`) never includes `GREET`, and
// `call/session.ts` labels the automatic greeting reply's `replyGoalAtStart` as `GREET` (the
// goal already in force from `start()`'s first `tick()`, before any caller speech) -- so this
// greeting can never register as an owed/asked identity question, never suppress the real
// `ELICIT_IDENTITY` ask, and the experience grader's `repeatedQuestion` transcript signal
// (`scripts/rehearse/experienceGrading.ts`) requires an EXACT normalized match with NO caller
// speech between two agent question lines, which a caller stating only a request (no name)
// between the greeting and the following `ELICIT_IDENTITY` ask never satisfies either way.
export const DEFAULT_GREETING = 'Meridian payments desk, verification line. Who am I speaking with?';

// AMENDMENT round 3 (controller, verified live 2026-09-02 11:49 AM CDT + docs check --
// see docs/aai-voices-endpoint-2026-09-02.md, and the CORRECTION line in
// docs/ASSEMBLYAI_AGENT_INSTRUCTIONS.md): `GET https://agents.assemblyai.com/v1/voices`
// does NOT exist -- it returns HTTP 426. AssemblyAI publishes voice ids as a static
// reference table (the Voices doc page), not a live endpoint. This replaces round 2's
// network `fetchVoices()` call: exactly the documented ids, validated with the same
// one-warning fallback to DEFAULT_VOICE, but as a plain synchronous table lookup -- no
// fetch, no cache, no endpoint-error path, and no extra round trip before connecting.
export const KNOWN_VOICES = [
  'alba',
  'eve',
  'george',
  'jane',
  'jean',
  'mary',
  'michael',
  'anna',
  'charles',
  'paul',
  'vera',
  'giovanni',
  'lola',
  'juergen',
  'rafael',
  'estelle',
] as const;

let warnedInvalidVoice = false;

/** Test-only: clears the one-shot invalid-voice warning flag. */
export function _resetVoiceWarning(): void {
  warnedInvalidVoice = false;
}

/** Validates a configured voice id against `KNOWN_VOICES`. Absent -> falls back to
 *  `DEFAULT_VOICE` ('anna') with ONE console warning for the life of the process. Pure and
 *  synchronous (no network, no I/O) -- never throws, so a voice-id typo can never block a
 *  call from connecting. */
export function resolveVoice(voice: string): string {
  if ((KNOWN_VOICES as readonly string[]).includes(voice)) return voice;
  if (!warnedInvalidVoice) {
    warnedInvalidVoice = true;
    console.warn(
      `countersign: configured voice "${voice}" is not in the documented AssemblyAI voice table -- falling back to "${DEFAULT_VOICE}".`
    );
  }
  return DEFAULT_VOICE;
}
export const LLM_GATEWAY_BASE_URL = 'https://llm-gateway.assemblyai.com/v1';
const AUDIO_ENCODING = 'audio/pcm';

/** Proper nouns only (PANEL doc Round 2, seat 6's caution) -- never the generic domain words
 *  `seed.keyterms` (packages/engine/src/seed/meridian.ts) already carries for the legacy
 *  path ("wire transfer", "escrow", "treasury", ...); those bias transcription toward the
 *  DOMAIN, not toward any one caller's claim. Checked against the real seed
 *  (packages/engine/src/seed/meridian.ts) and the real trap-decoy table
 *  (packages/engine/src/challenges.ts's `TRAP_DECOYS`), 2026-09-22:
 *   - Identity names (needed for ASR regardless of any trap question): `Robert Miller`,
 *     `Dana Whitfield`, `Marcus Obi` (meridian.ts `identities[]`) -- included independent of
 *     the trap pairs below (Marcus Obi is ALSO the seed's true `approver`, but that is not
 *     why it is here).
 *   - `Hartwell` -- the acquisition's own name (meridian.ts `knowledge[].topic`), needed to
 *     recognize the topic itself, not any one answer to a question about it.
 *   - `beneficiary` trap pair, SYMMETRIC (both sides, never one alone): `Meridian Supply`
 *     (meridian.ts `payments[0].vendor`, the truth) and `Northgate Partners`
 *     (challenges.ts `TRAP_DECOYS.beneficiary`, the decoy).
 *   - `counsel` trap pair, SYMMETRIC: `Calder & Finch` (meridian.ts
 *     `knowledge[].truth`, "Calder & Finch") and `Whitmore & Bass` (challenges.ts
 *     `TRAP_DECOYS.counsel`).
 *   - `escrow_institution` and `approver` trap pairs are deliberately excluded ENTIRELY (not
 *     one side each) -- "symmetric trap pairs or none" (PANEL doc Round 2): neither
 *     `First Meridian Trust`/`Harbor Fidelity Trust` nor `Priya Ramanathan` (the `approver`
 *     decoy; `Marcus Obi`, its truth, is already present above as an identity name for an
 *     unrelated reason) is added here, so transcription is never biased toward recognizing
 *     one side of either pair better than the other. */
export const BRAIN_KEYTERMS: readonly string[] = [
  'Meridian Supply',
  'Northgate Partners',
  'Marcus Obi',
  'Dana Whitfield',
  'Robert Miller',
  'Hartwell',
  'Whitmore & Bass',
  'Calder & Finch',
];

/** The one short neutral sentence appended after the token marker in the post-bind
 *  `system_prompt` below -- deliberately generic (LAW 1: no detection language anywhere),
 *  never read for meaning by anything (brain/endpoint.ts's `extractCallToken` only ever
 *  regexes the marker out of this same string; the sentence itself is cosmetic, for a human
 *  glancing at a raw AssemblyAI request log). */
const BRAIN_NEUTRAL_SENTENCE = "This call is routed through Countersign's verification system.";

// SONNET-JUSTIFIED lane fix (2026-09-18, founder's second live complaint: "does not let me
// complete my sentence"). PROVEN from the founder's own recorded call
// (scripts/rehearse/reports/founder-2026-09-18/391e2a37-....diagnostics.json, 35.8s): he
// says "No." then, 1.7s later (1155ms after his OWN speech-stop event, itself already
// min_silence past his true last word), "Meridian Supply." -- the agent's reply.started
// fired 7ms after "stopped", i.e. essentially the instant AssemblyAI's own silence timer
// (whatever value was active) elapsed. `turn_to_reply_gap` diagnostics (added
// packages/server/src/call/session.ts, commit ef38029) confirm AssemblyAI's own ambient
// reply starts 1-7ms after it decides a turn ended -- our server reaction time is not the
// lever; AssemblyAI's own end-of-turn DECISION is.
//
// Live docs re-check, fetched 2026-09-18 (two independent agent fetches, same page, same
// text both times):
//   https://www.assemblyai.com/docs/voice-agents/voice-agent-api/turn-detection-and-interruptions
//   "Setting `min_silence` or `max_silence` turns off the adaptive pacing and entity-aware
//   waiting described above for the rest of the session. Prefer leaving them unset."
//   Adaptive pacing, same page: "If a speaker pauses a lot, the agent gives them more
//   room; if they're crisp, it replies faster. This gets better over the call." /
//   entity-aware waiting: "When a tool parameter expects a phone number, email, date, or
//   other entity, the agent waits for the whole value before ending your turn." -- this is
//   a direct, built-in description of the exact problem the founder hit, with NO flat
//   latency cost added to every turn (unlike a raised fixed min_silence, which taxes every
//   genuinely-finished caller turn too -- see the ANALYSIS note below).
//   `turn_detection`'s five documented fields: vad_threshold (float 0-1, default 0.5),
//   min_silence (int ms, default adaptive), max_silence (int ms, default adaptive),
//   interrupt_response (bool, default true), interruption_delay (int ms, 0-1000, default
//   varies by transcription_mode -- not yet plumbed through this config, kept UNKNOWN/unset
//   here). No separate settable "end_of_turn_confidence_threshold" exists; a same-named
//   response field appears on Turn events but is not a tunable input.
//
// ANALYSIS (this lane, 2026-09-18, from every scripts/rehearse/reports/*.diagnostics.json
// bundle on disk including the founder's own founder-2026-09-18/ recordings): a
// same-breath detector (an agent reply.started firing <=300ms after a caller utterance
// ends, with the caller resuming <=2000ms later -- the same signature the founder's
// PROVEN 391e2a37 cutoff matches) found 217 such candidates across the harness corpus.
// Their caller-side silence gap (the extra pause beyond whatever min_silence was already
// active) has min=635ms, p50=1098ms, p90=1297ms, max=1991ms (bucketed by the utterance's
// own word count -- 1-2 words n=53 p50=999ms, 3-6 words n=104 p50=1142ms, 7+ words n=60
// p50=1097ms -- word count does NOT meaningfully predict pause length, so no word-count-
// keyed fixed threshold would help either). A raised FIXED min_silence of 1300ms would
// have covered 201/217 (92.6%) of these -- but would also add ~700ms of pure added
// latency (1300ms - the current 600ms default) to every one of the far larger set of
// turns that were already genuinely finished (560 measured gaps over 3s, plus 42 normal
// round trips) -- no single fixed number separates "still talking" from "truly done";
// the same "Yes, that's correct." text appears in both populations. Leaving min_silence/
// max_silence UNSET instead asks AssemblyAI's own adaptive system to make that
// per-utterance judgment call, at zero added floor for turns that need none. The live
// effect of this change is UNKNOWN until the next rehearsal batch measures it (this
// analysis never called the live API -- it replays recorded bundles only). Full
// methodology and quotes: docs/ASSEMBLYAI_INTEGRATION.md, "VERIFY-AT-BUILD re-check
// 2026-09-18 (turn_detection / same-breath cutoffs)".
export interface TurnDetectionConfig {
  vad_threshold?: number;
  min_silence?: number;
  max_silence?: number;
  interrupt_response?: boolean;
  interruption_delay?: number;
}

// GOODBYE-CUT-BY-CALLER-PRESSURE fix, mechanism A (2026-09-19): the documented default for
// `turn_detection.vad_threshold` (also `buildInitialSessionUpdate`'s own default just below),
// exported so `call/session.ts`'s per-goal CLOSE update (the one exception to "never resend
// turn_detection mid-call", see that file's own doc comment) can echo the SAME value back
// instead of hardcoding a second copy that could silently drift from this one. Today's real
// connect wiring (`index.ts`) never overrides `vad_threshold`, so this constant IS what every
// live call's connect-time value actually is -- if that ever changes (a future
// `COUNTERSIGN_VAD_THRESHOLD` env, say), both send sites must be updated together, or the
// per-goal CLOSE update would silently reset vad_threshold back to this default mid-call.
export const DEFAULT_VAD_THRESHOLD = 0.5;

// REVERSAL (2026-09-18, coordinator ruling, same day as the ANALYSIS above): the first pass
// of this fix left `call/session.ts`'s 'patient'-hint goals (CHALLENGE, CONSISTENCY_CHECK
// rule_hit 5) sending an explicit `min_silence: 1200`, reasoning that value was PROVEN
// insufficient but "left for a follow-up." That reasoning was wrong on its own terms: per
// the docs quote above, sending an explicit min_silence/max_silence even ONCE disables
// adaptive pacing/entity-aware waiting "for the rest of the session" -- and a CHALLENGE goal
// is reached within the first turn or two of essentially every real call, so the 'default'-
// branch fix above bought nothing live; adaptive pacing was still off for the rest of every
// call. The 1200ms floor existed to satisfy docs/BRIEF.md's engineering law (f) ("Eager
// turn-detection can cut off spoken amounts/account numbers -- tune to wait for complete
// numeric answers or the FSM freezes rails on ASR fragments") -- written before AssemblyAI's
// documented entity-aware waiting ("the agent waits for the whole value before ending your
// turn") was known to satisfy that exact concern natively. `call/session.ts` now sends `{}`
// (no min_silence/max_silence) for EVERY goal, patient or default -- no constant is exported
// here for that floor any more since none is sent. Live effect of this second change is also
// UNKNOWN until the next rehearsal batch measures it.
//
// SECOND REVERSAL (2026-09-19, this SONNET-JUSTIFIED lane, TURN-DETECTION-RESTORE-EXPLICIT-
// CONFIG): push 53 (commit f880b91, 2026-09-18 4:04 PM) went one step further than the
// REVERSAL above and stopped sending the `turn_detection` KEY AT ALL on connect -- on the
// reading that the docs tie full adaptive pacing to "no turn_detection config" being sent,
// not merely to min_silence/max_silence being absent from one that IS sent. Re-verified
// VERBATIM against the live docs today (2026-09-19 1:39 PM,
// https://www.assemblyai.com/docs/voice-agents/voice-agent-api/turn-detection-and-interruptions,
// copied character for character): "Setting `min_silence` or `max_silence` turns off the
// adaptive pacing and entity-aware waiting described above for the rest of the session." and
// "With no `turn_detection` config, the agent adapts to each speaker's pace and automatically
// slows down to capture values your tools need, like a phone number or email." The docs name
// FIVE `turn_detection` sub-fields: vad_threshold, min_silence, max_silence,
// interrupt_response, interruption_delay -- and tie the pacing-disabling behavior to
// min_silence/max_silence specifically, never to vad_threshold or interrupt_response. So the
// 2026-09-18 reading (this file's own comment on `buildInitialSessionUpdate`, below, until
// this reversal) was WRONG about which fields disable adaptive pacing: a present-but-partial
// `turn_detection` object carrying only vad_threshold/interrupt_response was never the
// documented trigger -- min_silence/max_silence being SET is, and this file already omits
// both of those by default.
//
// Live evidence this reversal is the right call, not just a docs re-reading (full quotes,
// methodology and the seven-client-event/no-auto-cancel verification: docs/
// ASSEMBLYAI_INTEGRATION.md, "VERIFY-AT-BUILD re-check 2026-09-19 (turn_detection
// restored)"): on deploy 52 (2be1d3e, turn_detection SENT with vad_threshold/
// interrupt_response) the CLOSE goodbye in the miller-patient bundle went out as OUR reply
// (`ours:true`, `scripts/rehearse/reports/2026-09-18T15-52-39-miller-patient
// .diagnostics.json`) with no glued/merged text; on deploy 53 (f880b91, key omitted
// entirely) the automatic reply raced ours and merged text into one reply_id on 3/3 CLOSE
// turns that day (docs/AUTOPILOT_LOG.md, 2026-09-19 12:37 PM entry, MERGED-FREEZE-GOODBYE-
// MILLER); on deploy 55 (turn_detection still omitted, plus 76969ee's forceSpeak deferral)
// the merge is gone but an ambient automatic reply now reliably starts BEFORE our forced
// CLOSE reply and speaks a stale pre-verdict line first, adding measured goodbye_delay of
// 7.98s (miller-patient, `2026-09-19T13-28-41-miller-patient.diagnostics.json`) and 17.95s
// (identity-switch, `2026-09-19T13-30-33-identity-switch.diagnostics.json`) before the real
// goodbye is ever spoken. Restoring the connect-time `turn_detection: {vad_threshold: 0.5,
// interrupt_response: true}` (exactly what deploy 52 sent) puts the CLOSE reply back in the
// position of winning that race outright in the common case, the way it did on deploy 52 --
// while 76969ee's deferral logic stays in place underneath as the safety net for whenever an
// automatic reply still starts first. `call/session.ts`'s own per-goal session.update is
// UNCHANGED by this reversal: it still omits `turn_detection` entirely on every goal change
// (never resending `{}`), since that omission was never the field this reversal is about --
// only the CONNECT-time defaults are restored here.

export interface AaiSessionConfig {
  assemblyai_api_key: string;
  session_cap_seconds: number;
  /** Output voice id (English ids per docs/aai-verify-2026-09-02.md Q2: alba, eve, george,
   *  jane, jean, mary, michael, anna, charles, paul, vera). Immutable once set. */
  voice: string;
  /** COUNTERSIGN_LLM_MODEL, if configured -- see the module doc comment above. */
  llm_model?: string;
  system_prompt: string;
  /** Spoken once at session start; immutable afterward. Founder ruling 2026-09-11: the
   *  agent now speaks FIRST on every call -- `index.ts`'s real connect wiring sets this to
   *  `DEFAULT_GREETING` (above) by default; the live smoke script sets its own separate
   *  greeting for that script's purpose. Still optional here (and still omitted from the
   *  wire payload entirely when unset, see `buildInitialSessionUpdate` below) so tests that
   *  don't care about the greeting can keep omitting it. */
  greeting?: string;
  tools: object[];
  keyterms: string[];
  turn_detection?: TurnDetectionConfig;
  /** TURN-DETECTION-ENV-VARS (2026-09-22): env default min_silence_ms from
   *  COUNTERSIGN_MIN_SILENCE_MS, applied in explicit mode. */
  env_min_silence_ms?: number;
  /** TURN-DETECTION-ENV-VARS (2026-09-22): env default max_silence_ms from
   *  COUNTERSIGN_MAX_SILENCE_MS, applied in explicit mode. */
  env_max_silence_ms?: number;
  /** TURN-DETECTION-ENV-VARS (2026-09-22): env default interruption_delay_ms from
   *  COUNTERSIGN_INTERRUPTION_DELAY_MS, applied in explicit mode. */
  env_interruption_delay_ms?: number;
}

export interface AaiEnvDefaults {
  voice: string;
  llm_model?: string;
  turn_detection_mode: TurnDetectionMode;
  min_silence_ms?: number;
  max_silence_ms?: number;
  interruption_delay_ms?: number;
}

function envOrUndefined(v: string | undefined): string | undefined {
  return v && v.length > 0 ? v : undefined;
}

/** Parses and validates an integer env var. Returns undefined if unset, malformed,
 *  negative, zero, or exceeds maxValue. Logs a console.warn if maxValue is exceeded. */
function parsePositiveInt(v: string | undefined, maxValue: number): number | undefined {
  if (!v || v.length === 0) return undefined;
  const num = parseInt(v, 10);
  if (isNaN(num) || num <= 0) return undefined;
  if (num > maxValue) {
    console.warn(`countersign: env value "${v}" exceeds max ${maxValue} -- ignored`);
    return undefined;
  }
  return num;
}

/** Reads COUNTERSIGN_VOICE (default DEFAULT_VOICE), COUNTERSIGN_LLM_MODEL (default:
 *  unset, i.e. keep AssemblyAI's managed model), COUNTERSIGN_TURN_DETECTION (default:
 *  'omit'), COUNTERSIGN_MIN_SILENCE_MS, COUNTERSIGN_MAX_SILENCE_MS, and
 *  COUNTERSIGN_INTERRUPTION_DELAY_MS from a process.env-shaped object. */
export function loadAaiEnvDefaults(env: Record<string, string | undefined>): AaiEnvDefaults {
  const voice = envOrUndefined(env.COUNTERSIGN_VOICE) ?? DEFAULT_VOICE;
  const llm_model = envOrUndefined(env.COUNTERSIGN_LLM_MODEL);
  // TURN-DETECTION-ENV-SWITCH (2026-09-19, build lane): read COUNTERSIGN_TURN_DETECTION
  // and validate it's one of 'explicit' or 'omit'. Default to 'omit' if unset or invalid.
  const rawMode = envOrUndefined(env.COUNTERSIGN_TURN_DETECTION);
  const turn_detection_mode: TurnDetectionMode = (rawMode === 'explicit' || rawMode === 'omit') ? rawMode : 'omit';

  // TURN-DETECTION-ENV-VARS (2026-09-22, build lane): read COUNTERSIGN_MIN_SILENCE_MS,
  // COUNTERSIGN_MAX_SILENCE_MS, and COUNTERSIGN_INTERRUPTION_DELAY_MS. Each is validated
  // as a positive integer within its documented bounds. If turn_detection_mode is 'omit'
  // and any value is set, warn that it will be ignored.
  const min_silence_ms = parsePositiveInt(env.COUNTERSIGN_MIN_SILENCE_MS, 10000);
  const max_silence_ms = parsePositiveInt(env.COUNTERSIGN_MAX_SILENCE_MS, 10000);
  const interruption_delay_ms = parsePositiveInt(env.COUNTERSIGN_INTERRUPTION_DELAY_MS, 1000);

  if (turn_detection_mode === 'omit' && (min_silence_ms !== undefined || max_silence_ms !== undefined || interruption_delay_ms !== undefined)) {
    console.warn(`countersign: COUNTERSIGN_MIN_SILENCE_MS/COUNTERSIGN_MAX_SILENCE_MS/COUNTERSIGN_INTERRUPTION_DELAY_MS are ignored because COUNTERSIGN_TURN_DETECTION is not 'explicit'.`);
  }

  const result: AaiEnvDefaults = { voice, turn_detection_mode };
  if (llm_model) result.llm_model = llm_model;
  if (min_silence_ms !== undefined) result.min_silence_ms = min_silence_ms;
  if (max_silence_ms !== undefined) result.max_silence_ms = max_silence_ms;
  if (interruption_delay_ms !== undefined) result.interruption_delay_ms = interruption_delay_ms;
  return result;
}

export interface SessionUpdateMessage {
  type: 'session.update';
  session: Record<string, unknown>;
}

/** Builds the FIRST session.update sent right after the socket opens (before
 *  session.ready). Every later session.update on this connection (call/session.ts, per
 *  goal change) must never touch voice, output.format.encoding, or greeting -- see the
 *  module doc comment.
 *
 *  `turn_detection` (RESTORED 2026-09-19, see the SECOND REVERSAL doc comment on
 *  `TurnDetectionConfig` above for the full docs quote + deploy 52/53/55 evidence): the key
 *  is now ALWAYS present on connect, exactly as deploy 52 sent it -- `vad_threshold`
 *  defaults to 0.5 and `interrupt_response` defaults to true unless `cfg.turn_detection`
 *  overrides them. `min_silence`/`max_silence` stay OMITTED unless `cfg.turn_detection`
 *  explicitly sets one, so AssemblyAI's own adaptive pacing / entity-aware waiting still
 *  runs by default (the docs tie disabling that behavior to min_silence/max_silence being
 *  SET, never to vad_threshold/interrupt_response being present) -- an explicit override is
 *  still sent exactly as given alongside the two defaulted fields. `call/session.ts`'s own
 *  per-goal session.update is UNCHANGED: it still omits `turn_detection` entirely on every
 *  goal change unless a caller-supplied override sets a field. */
/** TURN-DETECTION-ENV-SWITCH (2026-09-19, build lane): controls whether the initial
 *  session.update includes a turn_detection key. 'explicit' sends defaults
 *  (vad_threshold: 0.5, interrupt_response: true); 'omit' sends NO key unless a
 *  caller-supplied cfg.turn_detection sets a field, then sends only that field. */
export type TurnDetectionMode = 'explicit' | 'omit';

export function buildInitialSessionUpdate(cfg: AaiSessionConfig, turn_detection_mode: TurnDetectionMode = 'omit'): SessionUpdateMessage {
  const keyterms = cfg.keyterms.slice(0, 100);

  const input: Record<string, unknown> = {
    format: { encoding: AUDIO_ENCODING },
    keyterms,
  };

  // TURN-DETECTION-ENV-SWITCH: mode 'explicit' always sends the two defaults; mode 'omit'
  // sends the key only if a caller override sets a field, or omits it entirely if no override.
  if (turn_detection_mode === 'explicit') {
    const turnDetection: Record<string, unknown> = {
      vad_threshold: cfg.turn_detection?.vad_threshold ?? DEFAULT_VAD_THRESHOLD,
      interrupt_response: cfg.turn_detection?.interrupt_response ?? true,
    };
    // TURN-DETECTION-ENV-VARS (2026-09-22): apply env defaults from loadAaiEnvDefaults if set,
    // then allow cfg.turn_detection overrides on top.
    if (cfg.env_min_silence_ms !== undefined) turnDetection.min_silence = cfg.env_min_silence_ms;
    if (cfg.env_max_silence_ms !== undefined) turnDetection.max_silence = cfg.env_max_silence_ms;
    if (cfg.env_interruption_delay_ms !== undefined) turnDetection.interruption_delay = cfg.env_interruption_delay_ms;
    if (cfg.turn_detection?.min_silence !== undefined) turnDetection.min_silence = cfg.turn_detection.min_silence;
    if (cfg.turn_detection?.max_silence !== undefined) turnDetection.max_silence = cfg.turn_detection.max_silence;
    if (cfg.turn_detection?.interruption_delay !== undefined) turnDetection.interruption_delay = cfg.turn_detection.interruption_delay;
    input.turn_detection = turnDetection;
  } else if (cfg.turn_detection && (cfg.turn_detection.vad_threshold !== undefined ||
                                      cfg.turn_detection.interrupt_response !== undefined ||
                                      cfg.turn_detection.min_silence !== undefined ||
                                      cfg.turn_detection.max_silence !== undefined ||
                                      cfg.turn_detection.interruption_delay !== undefined)) {
    // Mode 'omit' with a caller override: send only the fields that are set
    const turnDetection: Record<string, unknown> = {};
    if (cfg.turn_detection.vad_threshold !== undefined) turnDetection.vad_threshold = cfg.turn_detection.vad_threshold;
    if (cfg.turn_detection.interrupt_response !== undefined) turnDetection.interrupt_response = cfg.turn_detection.interrupt_response;
    if (cfg.turn_detection.min_silence !== undefined) turnDetection.min_silence = cfg.turn_detection.min_silence;
    if (cfg.turn_detection.max_silence !== undefined) turnDetection.max_silence = cfg.turn_detection.max_silence;
    if (cfg.turn_detection.interruption_delay !== undefined) turnDetection.interruption_delay = cfg.turn_detection.interruption_delay;
    input.turn_detection = turnDetection;
  }
  // else: mode 'omit' with no override: omit turn_detection key entirely

  const session: Record<string, unknown> = {
    system_prompt: cfg.system_prompt,
    input,
    output: {
      voice: cfg.voice,
      format: { encoding: AUDIO_ENCODING },
    },
    tools: cfg.tools,
  };

  if (cfg.greeting) session.greeting = cfg.greeting;

  if (cfg.llm_model) {
    session.llm = [{ base_url: LLM_GATEWAY_BASE_URL, model: cfg.llm_model, api_key: cfg.assemblyai_api_key }];
  }

  return { type: 'session.update', session };
}

// ONE-BRAIN LIVE PATH (2026-09-22, docs/plans/2026-09-22-one-brain-live-path.md §1/§4, Lane
// D). Additive: neither function below is called by `buildInitialSessionUpdate` or anything
// on the legacy path -- both are only ever used by `aai/session.ts`'s `connectAaiEndpoint`,
// itself only reached when `COUNTERSIGN_BRAIN=endpoint` AND the boot-time stored-agent
// bootstrap succeeded (index.ts). The legacy connect path (`connectAai`,
// `buildInitialSessionUpdate` above) is byte-for-byte unchanged by this addition.

/** The FIRST session.update sent on an endpoint-mode connection, right after the socket
 *  opens -- PROVEN shape (gate-results.json G0): `{type:'session.update',
 *  session:{agent_id}}`, mutually exclusive with any inline field (voice/greeting/tools/llm
 *  are fixed on the stored agent itself instead, see aai/agent.ts). Resolves once
 *  `session.ready` arrives, exactly like the legacy connect's own first-and-only update. */
export function buildAgentBindUpdate(agentId: string): SessionUpdateMessage {
  return { type: 'session.update', session: { agent_id: agentId } };
}

export interface PostBindSessionUpdateOpts {
  /** This call's per-call correlation token (brain/registry.ts's `generateCallToken()`
   *  output) -- embedded via `formatCallTokenMarker` so `/api/brain/chat/completions`
   *  (brain/endpoint.ts) can parse it back out of `messages[0]` on every request AssemblyAI
   *  sends for this call (plan §1's G1-proven "system_prompt arrives as messages[0],
   *  verbatim"). */
  token: string;
  /** Proper-nouns-only list -- see `BRAIN_KEYTERMS`'s own doc comment above for exactly
   *  which seed values are included/excluded and why. Not defaulted to `BRAIN_KEYTERMS`
   *  here so a test can supply its own fixed list without importing the seed-derived one. */
  keyterms: string[];
}

/** The SECOND session.update, sent only after `session.ready` acks the bind above -- PROVEN
 *  shape (gate-results.json G0B: "second session.update ... -> session.updated"). Carries
 *  ONLY `system_prompt` (this call's token marker plus one short neutral sentence -- see
 *  `BRAIN_NEUTRAL_SENTENCE`'s own doc comment), `input.keyterms`, and
 *  `input.transcription_mode: 'max_accuracy'` (PROVEN in G8: 1 request per utterance through
 *  1.0-1.2s mid-sentence pauses, gate-results.json). Deliberately carries NO
 *  `input.turn_detection` key at all -- neither `min_silence`/`max_silence` (the existing
 *  Sep-18/19 finding already coded into `buildInitialSessionUpdate`'s own comment: setting
 *  either disables adaptive pacing/entity-aware waiting for the rest of the session) NOR
 *  `vad_threshold`/`interrupt_response` (plan §4's own bullet list for this update names only
 *  `system_prompt`/`keyterms`/`input.transcription_mode` -- turn detection is left fully
 *  adaptive in endpoint mode). `voice`/`output.format.encoding`/`greeting`/`tools`/`llm` are
 *  NEVER sent here either -- all five are fixed on the stored agent itself (aai/agent.ts) or
 *  immutable-once-set, same law `buildInitialSessionUpdate`'s own module comment states for
 *  the legacy path. */
export function buildPostBindSessionUpdate(opts: PostBindSessionUpdateOpts): SessionUpdateMessage {
  return {
    type: 'session.update',
    session: {
      system_prompt: `${formatCallTokenMarker(opts.token)}\n${BRAIN_NEUTRAL_SENTENCE}`,
      input: {
        keyterms: opts.keyterms.slice(0, 100),
        transcription_mode: 'max_accuracy',
      },
    },
  };
}
