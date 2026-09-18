// packages/server/test/aai-config.test.ts
// Verifies the initial session.update payload `src/aai/config.ts` builds is exactly what
// the verified docs (docs/aai-verify-2026-09-02.md) say AssemblyAI expects: flat tool
// schemas, audio/pcm on both directions, keyterms capped at 100, turn_detection present,
// the `llm` block only when a model is configured (Q5: omit to keep the managed default),
// and voice/greeting set once at connect time (Q1/Q2: both immutable after session.ready).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildInitialSessionUpdate,
  loadAaiEnvDefaults,
  DEFAULT_VOICE,
  DEFAULT_GREETING,
  LLM_GATEWAY_BASE_URL,
  KNOWN_VOICES,
  LIVE_SESSION_TOOLS,
  resolveVoice,
  _resetVoiceWarning,
  type AaiSessionConfig,
} from '../src/aai/config.js';
import { allToolSchemas } from '../src/aai/schemas.js';

function cfg(overrides: Partial<AaiSessionConfig> = {}): AaiSessionConfig {
  return {
    assemblyai_api_key: 'secret-key',
    session_cap_seconds: 300,
    voice: 'alba',
    system_prompt: 'You are Countersign.',
    tools: allToolSchemas(),
    keyterms: ['Meridian Dynamics', 'Robert Miller'],
    ...overrides,
  };
}

describe('buildInitialSessionUpdate', () => {
  it('wraps the payload as a session.update message', () => {
    const msg = buildInitialSessionUpdate(cfg());
    expect(msg.type).toBe('session.update');
    expect(msg.session).toBeTruthy();
  });

  it('sets audio/pcm encoding on both input and output, and the configured voice', () => {
    const msg = buildInitialSessionUpdate(cfg({ voice: 'eve' }));
    expect(msg.session.input).toMatchObject({ format: { encoding: 'audio/pcm' } });
    expect(msg.session.output).toMatchObject({ voice: 'eve', format: { encoding: 'audio/pcm' } });
  });

  it('caps keyterms at 100 even when more are supplied', () => {
    const many = Array.from({ length: 150 }, (_, i) => `term-${i}`);
    const msg = buildInitialSessionUpdate(cfg({ keyterms: many }));
    const keyterms = (msg.session.input as { keyterms: string[] }).keyterms;
    expect(keyterms).toHaveLength(100);
    expect(keyterms[0]).toBe('term-0');
  });

  // 2026-09-18 follow-up fix (SONNET-JUSTIFIED lane, founder's SECOND live complaint,
  // "does not let me complete my sentence" still measured on the deploy that shipped the
  // first fix -- PROVEN, scripts/rehearse/reports/2026-09-18T15-46-44-barge-in-interrupt
  // .diagnostics.json, ~6ms reply-start after speech-stop). The first fix (below) stopped
  // sending min_silence/max_silence but still sent `turn_detection: { vad_threshold: 0.5,
  // interrupt_response: true }` unconditionally -- the KEY was always present. Live docs
  // (turn-detection-and-interruptions, re-fetched 2026-09-18) describe full adaptive
  // behavior as following from "no turn_detection config" being sent at all, not merely an
  // empty min_silence/max_silence within one -- whether a present-but-partial object is
  // equivalent to omission is UNDOCUMENTED. So by default the `turn_detection` key is now
  // OMITTED FROM THE WIRE ENTIRELY -- not sent as `{}`, not sent with default
  // vad_threshold/interrupt_response restated.
  it('omits the turn_detection key entirely from the wire when no override is configured', () => {
    const msg = buildInitialSessionUpdate(cfg());
    expect(msg.session.input).not.toHaveProperty('turn_detection');
  });

  // 2026-09-18 fix (SONNET-JUSTIFIED lane, founder's "does not let me complete my
  // sentence" complaint): AssemblyAI's docs (turn-detection-and-interruptions, fetched
  // 2026-09-18) -- "Setting min_silence or max_silence turns off the adaptive pacing and
  // entity-aware waiting described above for the rest of the session. Prefer leaving them
  // unset." -- so by default neither key is sent at all, letting AssemblyAI's own adaptive
  // system decide (see config.ts's own doc comment for the measured trade-off that ruled
  // out just raising the old fixed 600ms value instead).
  it('omits min_silence and max_silence entirely by default (AssemblyAI adaptive pacing/entity-aware waiting stays on)', () => {
    const msg = buildInitialSessionUpdate(cfg());
    expect(msg.session.input).not.toHaveProperty('turn_detection');
  });

  it('lets a caller override turn_detection fields -- min_silence sent exactly as given when explicitly set, and no other field is backfilled', () => {
    const msg = buildInitialSessionUpdate(cfg({ turn_detection: { min_silence: 1200 } }));
    const turnDetection = (msg.session.input as { turn_detection: Record<string, unknown> }).turn_detection;
    expect(turnDetection).toEqual({ min_silence: 1200 });
  });

  it('lets a caller override max_silence independently of min_silence, with no other field backfilled', () => {
    const msg = buildInitialSessionUpdate(cfg({ turn_detection: { max_silence: 5000 } }));
    const turnDetection = (msg.session.input as { turn_detection: Record<string, unknown> }).turn_detection;
    expect(turnDetection).toEqual({ max_silence: 5000 });
  });

  it('lets a caller override vad_threshold or interrupt_response explicitly, sent exactly as given', () => {
    const msg = buildInitialSessionUpdate(cfg({ turn_detection: { vad_threshold: 0.7, interrupt_response: false } }));
    const turnDetection = (msg.session.input as { turn_detection: Record<string, unknown> }).turn_detection;
    expect(turnDetection).toEqual({ vad_threshold: 0.7, interrupt_response: false });
  });

  it('sends flat tool schemas -- {type, name, description, parameters, execution_mode, timeout_seconds}, never a nested "function" key', () => {
    const msg = buildInitialSessionUpdate(cfg());
    const tools = msg.session.tools as Record<string, unknown>[];
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) {
      expect(t.type).toBe('function');
      expect(typeof t.name).toBe('string');
      expect(typeof t.description).toBe('string');
      expect(typeof t.parameters).toBe('object');
      expect(['interactive', 'hold']).toContain(t.execution_mode);
      expect(typeof t.timeout_seconds).toBe('number');
      expect(t).not.toHaveProperty('function');
    }
  });

  it('includes the greeting only when configured', () => {
    const withGreeting = buildInitialSessionUpdate(cfg({ greeting: 'Countersign smoke test' }));
    expect(withGreeting.session.greeting).toBe('Countersign smoke test');

    const withoutGreeting = buildInitialSessionUpdate(cfg());
    expect(withoutGreeting.session).not.toHaveProperty('greeting');
  });

  it('omits the llm block by default so the session uses AssemblyAI\'s managed model', () => {
    const msg = buildInitialSessionUpdate(cfg());
    expect(msg.session).not.toHaveProperty('llm');
  });

  it('emits the llm block through the gateway when a model is configured', () => {
    const msg = buildInitialSessionUpdate(cfg({ llm_model: 'claude-sonnet-4-6' }));
    expect(msg.session.llm).toEqual([
      { base_url: LLM_GATEWAY_BASE_URL, model: 'claude-sonnet-4-6', api_key: 'secret-key' },
    ]);
  });
});

// Bug fix (2026-09-03, founder-observed live run): `index.ts` sends `LIVE_SESSION_TOOLS`
// (never `allToolSchemas()`) as `tools` in the real connect config -- the voice model must
// never be offered any tool schema (see fsm.ts's `allowedTools` and this constant's own doc
// comment in aai/config.ts for the incident this closes).
describe('LIVE_SESSION_TOOLS', () => {
  it('is the empty array', () => {
    expect(LIVE_SESSION_TOOLS).toEqual([]);
  });

  it('produces an initial session.update with no tool schemas at all when used as the connect config\'s tools', () => {
    const msg = buildInitialSessionUpdate(cfg({ tools: LIVE_SESSION_TOOLS }));
    expect(msg.session.tools).toEqual([]);
  });
});

describe('DEFAULT_VOICE', () => {
  it('is "anna" -- AssemblyAI\'s documented default (docs/ASSEMBLYAI_AGENT_INSTRUCTIONS.md Voices)', () => {
    expect(DEFAULT_VOICE).toBe('anna');
  });
});

// Founder ruling 2026-09-11: the agent speaks FIRST on every call, using this exact,
// payments-desk-voice, plain-English line -- no ids requested, no detection language
// (LAW 1). index.ts's real connect wiring sets `greeting: DEFAULT_GREETING`; this proves
// the constant's exact wording and that it flows into the connect payload unchanged.
describe('DEFAULT_GREETING', () => {
  it('is the founder-specified payments-desk greeting, with no ids requested and no detection language', () => {
    expect(DEFAULT_GREETING).toBe('Meridian payments desk, verification line. How can I help you today?');
  });

  it('is carried onto the FIRST connect config\'s session.greeting unchanged', () => {
    const msg = buildInitialSessionUpdate(cfg({ greeting: DEFAULT_GREETING }));
    expect(msg.session.greeting).toBe(DEFAULT_GREETING);
  });
});

// AMENDMENT round 3 (controller, verified live 2026-09-02 11:49 AM CDT + docs check --
// docs/aai-voices-endpoint-2026-09-02.md): GET /v1/voices does NOT exist (HTTP 426) --
// AssemblyAI publishes voice ids as a static reference table. This replaces the round-2
// network fetchVoices()/connectAai-cache tests with a plain synchronous table lookup.
describe('KNOWN_VOICES / resolveVoice (static table -- no live endpoint)', () => {
  beforeEach(() => {
    _resetVoiceWarning();
  });

  it('KNOWN_VOICES is exactly the documented table (docs/ASSEMBLYAI_AGENT_INSTRUCTIONS.md Voices)', () => {
    expect(KNOWN_VOICES).toEqual([
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
    ]);
  });

  it('returns a voice that is in the table as-is, without warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveVoice('alba')).toBe('alba');
    expect(resolveVoice('estelle')).toBe('estelle');
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('falls back to DEFAULT_VOICE with a single warning when the voice is not in the table', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveVoice('not-a-real-voice')).toBe(DEFAULT_VOICE);
    // A second (different) invalid voice must not warn again -- one warning for the life
    // of the process, same as round 2's live-list validation.
    expect(resolveVoice('also-not-a-real-voice')).toBe(DEFAULT_VOICE);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('loadAaiEnvDefaults', () => {
  it('defaults voice to anna and leaves llm_model unset when no env vars are present', () => {
    expect(loadAaiEnvDefaults({})).toEqual({ voice: DEFAULT_VOICE });
  });

  it('reads COUNTERSIGN_VOICE and COUNTERSIGN_LLM_MODEL from env', () => {
    expect(loadAaiEnvDefaults({ COUNTERSIGN_VOICE: 'eve', COUNTERSIGN_LLM_MODEL: 'claude-x' })).toEqual({
      voice: 'eve',
      llm_model: 'claude-x',
    });
  });

  it('treats an empty-string env var as unset', () => {
    expect(loadAaiEnvDefaults({ COUNTERSIGN_VOICE: '', COUNTERSIGN_LLM_MODEL: '' })).toEqual({
      voice: DEFAULT_VOICE,
    });
  });
});
