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
  /** Spoken once at session start; immutable afterward. Left unset in normal server
   *  wiring (the caller speaks first) -- only the live smoke script sets one. */
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
