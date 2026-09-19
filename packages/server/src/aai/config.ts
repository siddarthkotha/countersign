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
export const DEFAULT_GREETING = 'Meridian payments desk, verification line. How can I help you today?';

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
}

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
}

export interface AaiEnvDefaults {
  voice: string;
  llm_model?: string;
}

function envOrUndefined(v: string | undefined): string | undefined {
  return v && v.length > 0 ? v : undefined;
}

/** Reads COUNTERSIGN_VOICE (default DEFAULT_VOICE) and COUNTERSIGN_LLM_MODEL (default:
 *  unset, i.e. keep AssemblyAI's managed model) from a process.env-shaped object. */
export function loadAaiEnvDefaults(env: Record<string, string | undefined>): AaiEnvDefaults {
  const voice = envOrUndefined(env.COUNTERSIGN_VOICE) ?? DEFAULT_VOICE;
  const llm_model = envOrUndefined(env.COUNTERSIGN_LLM_MODEL);
  return llm_model ? { voice, llm_model } : { voice };
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
export function buildInitialSessionUpdate(cfg: AaiSessionConfig): SessionUpdateMessage {
  const keyterms = cfg.keyterms.slice(0, 100);
  const turnDetection: Record<string, unknown> = {
    vad_threshold: cfg.turn_detection?.vad_threshold ?? 0.5,
    interrupt_response: cfg.turn_detection?.interrupt_response ?? true,
  };
  if (cfg.turn_detection?.min_silence !== undefined) turnDetection.min_silence = cfg.turn_detection.min_silence;
  if (cfg.turn_detection?.max_silence !== undefined) turnDetection.max_silence = cfg.turn_detection.max_silence;

  const input: Record<string, unknown> = {
    format: { encoding: AUDIO_ENCODING },
    keyterms,
    turn_detection: turnDetection,
  };

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
