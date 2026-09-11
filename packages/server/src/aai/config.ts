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

export interface TurnDetectionConfig {
  vad_threshold?: number;
  min_silence?: number;
  max_silence?: number;
  interrupt_response?: boolean;
}

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
 *  module doc comment. */
export function buildInitialSessionUpdate(cfg: AaiSessionConfig): SessionUpdateMessage {
  const keyterms = cfg.keyterms.slice(0, 100);
  const session: Record<string, unknown> = {
    system_prompt: cfg.system_prompt,
    input: {
      format: { encoding: AUDIO_ENCODING },
      keyterms,
      turn_detection: {
        vad_threshold: cfg.turn_detection?.vad_threshold ?? 0.5,
        min_silence: cfg.turn_detection?.min_silence ?? 600,
        max_silence: cfg.turn_detection?.max_silence ?? 4000,
        interrupt_response: cfg.turn_detection?.interrupt_response ?? true,
      },
    },
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
