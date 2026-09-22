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

  // RESTORED 2026-09-19 (SONNET-JUSTIFIED lane, TURN-DETECTION-RESTORE-EXPLICIT-CONFIG,
  // see config.ts's "SECOND REVERSAL" doc comment for the full docs quote + deploy 52/53/55
  // evidence): push 53 (f880b91) had made this OMIT the key entirely, reasoning the docs
  // tied full adaptive pacing to "no turn_detection config" being sent at all. Re-verified
  // live docs (2026-09-19) show the pacing-disabling behavior is tied to min_silence/
  // max_silence being SET, never to vad_threshold/interrupt_response being present -- so
  // the key is restored, unconditionally, exactly as deploy 52 sent it, with deploy 55's
  // measured stale-line-first goodbye race (7.98s/17.95s delay) as the live cost of leaving
  // it omitted.
  // TURN-DETECTION-ENV-SWITCH (2026-09-19, build lane): when mode is "explicit", the key
  // is sent with documented defaults.
  it('sends turn_detection on connect with the documented defaults (vad_threshold 0.5, interrupt_response true) when mode is explicit', () => {
    const msg = buildInitialSessionUpdate(cfg(), 'explicit');
    const turnDetection = (msg.session.input as { turn_detection: Record<string, unknown> }).turn_detection;
    expect(turnDetection).toEqual({ vad_threshold: 0.5, interrupt_response: true });
  });

  // 2026-09-18 fix (SONNET-JUSTIFIED lane, founder's "does not let me complete my
  // sentence" complaint): AssemblyAI's docs (turn-detection-and-interruptions, fetched
  // 2026-09-18) -- "Setting min_silence or max_silence turns off the adaptive pacing and
  // entity-aware waiting described above for the rest of the session. Prefer leaving them
  // unset." -- so by default neither key is sent at all, letting AssemblyAI's own adaptive
  // system decide (see config.ts's own doc comment for the measured trade-off that ruled
  // out just raising the old fixed 600ms value instead). Still true after the 2026-09-19
  // restore above: only min_silence/max_silence stay omitted -- vad_threshold/
  // interrupt_response are sent (previous test), because the docs never tie those two to
  // disabling adaptive pacing.
  // TURN-DETECTION-ENV-SWITCH (2026-09-19, build lane): this applies to explicit mode only.
  it('omits min_silence and max_silence when mode is explicit (AssemblyAI adaptive pacing/entity-aware waiting stays on)', () => {
    const msg = buildInitialSessionUpdate(cfg(), 'explicit');
    const turnDetection = (msg.session.input as { turn_detection: Record<string, unknown> }).turn_detection;
    expect(turnDetection).not.toHaveProperty('min_silence');
    expect(turnDetection).not.toHaveProperty('max_silence');
  });

  it('lets a caller override turn_detection fields in explicit mode -- min_silence sent exactly as given when explicitly set, alongside the defaulted vad_threshold/interrupt_response', () => {
    const msg = buildInitialSessionUpdate(cfg({ turn_detection: { min_silence: 1200 } }), 'explicit');
    const turnDetection = (msg.session.input as { turn_detection: Record<string, unknown> }).turn_detection;
    expect(turnDetection).toEqual({ vad_threshold: 0.5, interrupt_response: true, min_silence: 1200 });
  });

  it('lets a caller override max_silence independently of min_silence in explicit mode, alongside the defaulted vad_threshold/interrupt_response', () => {
    const msg = buildInitialSessionUpdate(cfg({ turn_detection: { max_silence: 5000 } }), 'explicit');
    const turnDetection = (msg.session.input as { turn_detection: Record<string, unknown> }).turn_detection;
    expect(turnDetection).toEqual({ vad_threshold: 0.5, interrupt_response: true, max_silence: 5000 });
  });

  it('lets a caller override vad_threshold or interrupt_response explicitly in explicit mode, sent exactly as given', () => {
    const msg = buildInitialSessionUpdate(cfg({ turn_detection: { vad_threshold: 0.7, interrupt_response: false } }), 'explicit');
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

  // TURN-DETECTION-ENV-SWITCH (2026-09-19, build lane): buildInitialSessionUpdate accepts a
  // turn_detection_mode parameter to support measured experiments without code changes. Mode
  // 'explicit' sends the defaults (current behavior), 'omit' sends NO key (deploy 53 behavior).
  // Default when unset: 'omit'.
  describe('turn_detection_mode parameter', () => {
    it('sends turn_detection with defaults when mode is "explicit"', () => {
      const msg = buildInitialSessionUpdate(cfg(), 'explicit');
      const turnDetection = (msg.session.input as { turn_detection: Record<string, unknown> }).turn_detection;
      expect(turnDetection).toEqual({ vad_threshold: 0.5, interrupt_response: true });
    });

    it('omits turn_detection key entirely when mode is "omit"', () => {
      const msg = buildInitialSessionUpdate(cfg(), 'omit');
      expect((msg.session.input as Record<string, unknown>)).not.toHaveProperty('turn_detection');
    });

    it('sends only caller-supplied override fields when mode is "omit" and a caller override is set', () => {
      const msg = buildInitialSessionUpdate(cfg({ turn_detection: { min_silence: 1500 } }), 'omit');
      const input = msg.session.input as Record<string, unknown>;
      const turnDetection = input.turn_detection as Record<string, unknown> | undefined;
      expect(turnDetection).toEqual({ min_silence: 1500 });
    });

    it('defaults to "omit" mode when no mode parameter is provided', () => {
      const msg = buildInitialSessionUpdate(cfg());
      expect((msg.session.input as Record<string, unknown>)).not.toHaveProperty('turn_detection');
    });

    it('sends turn_detection with defaults when mode is "explicit" and a caller override is set', () => {
      const msg = buildInitialSessionUpdate(cfg({ turn_detection: { min_silence: 1200 } }), 'explicit');
      const turnDetection = (msg.session.input as { turn_detection: Record<string, unknown> }).turn_detection;
      expect(turnDetection).toEqual({ vad_threshold: 0.5, interrupt_response: true, min_silence: 1200 });
    });
  });

  // TURN-DETECTION-ENV-VARS (2026-09-22, build lane): env defaults from loadAaiEnvDefaults
  // are applied to the initial session.update when in explicit mode.
  describe('turn_detection env vars applied in buildInitialSessionUpdate', () => {
    it('applies env min_silence_ms in explicit mode (byte-identical without it)', () => {
      const withoutEnv = buildInitialSessionUpdate(cfg(), 'explicit');
      const withEnv = buildInitialSessionUpdate(cfg({ env_min_silence_ms: 1500 }), 'explicit');
      const withoutTd = (withoutEnv.session.input as { turn_detection: Record<string, unknown> }).turn_detection;
      const withTd = (withEnv.session.input as { turn_detection: Record<string, unknown> }).turn_detection;
      expect(withoutTd).not.toHaveProperty('min_silence');
      expect(withTd).toHaveProperty('min_silence', 1500);
    });

    it('applies env max_silence_ms in explicit mode (byte-identical without it)', () => {
      const withoutEnv = buildInitialSessionUpdate(cfg(), 'explicit');
      const withEnv = buildInitialSessionUpdate(cfg({ env_max_silence_ms: 4000 }), 'explicit');
      const withoutTd = (withoutEnv.session.input as { turn_detection: Record<string, unknown> }).turn_detection;
      const withTd = (withEnv.session.input as { turn_detection: Record<string, unknown> }).turn_detection;
      expect(withoutTd).not.toHaveProperty('max_silence');
      expect(withTd).toHaveProperty('max_silence', 4000);
    });

    it('applies env interruption_delay_ms in explicit mode (byte-identical without it)', () => {
      const withoutEnv = buildInitialSessionUpdate(cfg(), 'explicit');
      const withEnv = buildInitialSessionUpdate(cfg({ env_interruption_delay_ms: 200 }), 'explicit');
      const withoutTd = (withoutEnv.session.input as { turn_detection: Record<string, unknown> }).turn_detection;
      const withTd = (withEnv.session.input as { turn_detection: Record<string, unknown> }).turn_detection;
      expect(withoutTd).not.toHaveProperty('interruption_delay');
      expect(withTd).toHaveProperty('interruption_delay', 200);
    });

    it('applies all three env vars when all are set in explicit mode', () => {
      const msg = buildInitialSessionUpdate(cfg({
        env_min_silence_ms: 1500,
        env_max_silence_ms: 4000,
        env_interruption_delay_ms: 200,
      }), 'explicit');
      const turnDetection = (msg.session.input as { turn_detection: Record<string, unknown> }).turn_detection;
      expect(turnDetection).toEqual({
        vad_threshold: 0.5,
        interrupt_response: true,
        min_silence: 1500,
        max_silence: 4000,
        interruption_delay: 200,
      });
    });

    it('allows cfg.turn_detection overrides to override env defaults in explicit mode', () => {
      const msg = buildInitialSessionUpdate(cfg({
        env_min_silence_ms: 1500,
        turn_detection: { min_silence: 2000 },
      }), 'explicit');
      const turnDetection = (msg.session.input as { turn_detection: Record<string, unknown> }).turn_detection;
      expect(turnDetection.min_silence).toBe(2000);
    });

    it('has no effect on env vars when mode is omit (byte-identical to no env vars)', () => {
      const withoutEnv = buildInitialSessionUpdate(cfg(), 'omit');
      const withEnv = buildInitialSessionUpdate(cfg({
        env_min_silence_ms: 1500,
        env_max_silence_ms: 4000,
        env_interruption_delay_ms: 200,
      }), 'omit');
      expect(withoutEnv.session.input).toEqual(withEnv.session.input);
    });

    it('still allows caller cfg.turn_detection overrides in omit mode even when env vars are present', () => {
      const msg = buildInitialSessionUpdate(cfg({
        env_min_silence_ms: 1500,
        turn_detection: { min_silence: 2000 },
      }), 'omit');
      const input = msg.session.input as Record<string, unknown>;
      const turnDetection = input.turn_detection as Record<string, unknown> | undefined;
      expect(turnDetection).toEqual({ min_silence: 2000 });
    });

    it('combines env vars with cfg.turn_detection overrides correctly in explicit mode', () => {
      const msg = buildInitialSessionUpdate(cfg({
        env_min_silence_ms: 1500,
        env_max_silence_ms: 4000,
        turn_detection: { max_silence: 5000, vad_threshold: 0.7 },
      }), 'explicit');
      const turnDetection = (msg.session.input as { turn_detection: Record<string, unknown> }).turn_detection;
      expect(turnDetection).toEqual({
        vad_threshold: 0.7,
        interrupt_response: true,
        min_silence: 1500,
        max_silence: 5000,
      });
    });
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
  it('defaults voice to anna, turn_detection_mode to omit, and leaves llm_model unset when no env vars are present', () => {
    expect(loadAaiEnvDefaults({})).toEqual({ voice: DEFAULT_VOICE, turn_detection_mode: 'omit' });
  });

  it('reads COUNTERSIGN_VOICE, COUNTERSIGN_LLM_MODEL, and COUNTERSIGN_TURN_DETECTION from env', () => {
    expect(loadAaiEnvDefaults({ COUNTERSIGN_VOICE: 'eve', COUNTERSIGN_LLM_MODEL: 'claude-x', COUNTERSIGN_TURN_DETECTION: 'explicit' })).toEqual({
      voice: 'eve',
      llm_model: 'claude-x',
      turn_detection_mode: 'explicit',
    });
  });

  it('treats an empty-string env var as unset', () => {
    expect(loadAaiEnvDefaults({ COUNTERSIGN_VOICE: '', COUNTERSIGN_LLM_MODEL: '', COUNTERSIGN_TURN_DETECTION: '' })).toEqual({
      voice: DEFAULT_VOICE,
      turn_detection_mode: 'omit',
    });
  });

  it('defaults turn_detection_mode to omit when COUNTERSIGN_TURN_DETECTION is invalid', () => {
    expect(loadAaiEnvDefaults({ COUNTERSIGN_TURN_DETECTION: 'invalid' })).toEqual({
      voice: DEFAULT_VOICE,
      turn_detection_mode: 'omit',
    });
  });

  it('reads COUNTERSIGN_TURN_DETECTION as explicit when set', () => {
    expect(loadAaiEnvDefaults({ COUNTERSIGN_TURN_DETECTION: 'explicit' })).toEqual({
      voice: DEFAULT_VOICE,
      turn_detection_mode: 'explicit',
    });
  });

  // TURN-DETECTION-ENV-VARS (2026-09-22): min_silence_ms, max_silence_ms, interruption_delay_ms
  describe('turn_detection env vars (MIN_SILENCE_MS, MAX_SILENCE_MS, INTERRUPTION_DELAY_MS)', () => {
    it('reads all three env vars when set to valid values', () => {
      expect(loadAaiEnvDefaults({
        COUNTERSIGN_MIN_SILENCE_MS: '1500',
        COUNTERSIGN_MAX_SILENCE_MS: '4000',
        COUNTERSIGN_INTERRUPTION_DELAY_MS: '200',
      })).toEqual({
        voice: DEFAULT_VOICE,
        turn_detection_mode: 'omit',
        min_silence_ms: 1500,
        max_silence_ms: 4000,
        interruption_delay_ms: 200,
      });
    });

    it('ignores min_silence_ms when malformed (non-numeric)', () => {
      expect(loadAaiEnvDefaults({ COUNTERSIGN_MIN_SILENCE_MS: 'abc' })).toEqual({
        voice: DEFAULT_VOICE,
        turn_detection_mode: 'omit',
      });
    });

    it('ignores max_silence_ms when malformed (non-numeric)', () => {
      expect(loadAaiEnvDefaults({ COUNTERSIGN_MAX_SILENCE_MS: 'xyz' })).toEqual({
        voice: DEFAULT_VOICE,
        turn_detection_mode: 'omit',
      });
    });

    it('ignores interruption_delay_ms when malformed (non-numeric)', () => {
      expect(loadAaiEnvDefaults({ COUNTERSIGN_INTERRUPTION_DELAY_MS: 'not-a-number' })).toEqual({
        voice: DEFAULT_VOICE,
        turn_detection_mode: 'omit',
      });
    });

    it('ignores min_silence_ms when negative', () => {
      expect(loadAaiEnvDefaults({ COUNTERSIGN_MIN_SILENCE_MS: '-500' })).toEqual({
        voice: DEFAULT_VOICE,
        turn_detection_mode: 'omit',
      });
    });

    it('ignores max_silence_ms when negative', () => {
      expect(loadAaiEnvDefaults({ COUNTERSIGN_MAX_SILENCE_MS: '-1000' })).toEqual({
        voice: DEFAULT_VOICE,
        turn_detection_mode: 'omit',
      });
    });

    it('ignores interruption_delay_ms when negative', () => {
      expect(loadAaiEnvDefaults({ COUNTERSIGN_INTERRUPTION_DELAY_MS: '-100' })).toEqual({
        voice: DEFAULT_VOICE,
        turn_detection_mode: 'omit',
      });
    });

    it('ignores min_silence_ms when zero', () => {
      expect(loadAaiEnvDefaults({ COUNTERSIGN_MIN_SILENCE_MS: '0' })).toEqual({
        voice: DEFAULT_VOICE,
        turn_detection_mode: 'omit',
      });
    });

    it('ignores max_silence_ms when zero', () => {
      expect(loadAaiEnvDefaults({ COUNTERSIGN_MAX_SILENCE_MS: '0' })).toEqual({
        voice: DEFAULT_VOICE,
        turn_detection_mode: 'omit',
      });
    });

    it('ignores interruption_delay_ms when zero', () => {
      expect(loadAaiEnvDefaults({ COUNTERSIGN_INTERRUPTION_DELAY_MS: '0' })).toEqual({
        voice: DEFAULT_VOICE,
        turn_detection_mode: 'omit',
      });
    });

    it('ignores min_silence_ms when exceeds upper bound (10000)', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(loadAaiEnvDefaults({ COUNTERSIGN_MIN_SILENCE_MS: '99999' })).toEqual({
        voice: DEFAULT_VOICE,
        turn_detection_mode: 'omit',
      });
      expect(warn).toHaveBeenCalledWith('countersign: env value "99999" exceeds max 10000 -- ignored');
      warn.mockRestore();
    });

    it('ignores max_silence_ms when exceeds upper bound (10000)', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(loadAaiEnvDefaults({ COUNTERSIGN_MAX_SILENCE_MS: '11000' })).toEqual({
        voice: DEFAULT_VOICE,
        turn_detection_mode: 'omit',
      });
      expect(warn).toHaveBeenCalledWith('countersign: env value "11000" exceeds max 10000 -- ignored');
      warn.mockRestore();
    });

    it('ignores interruption_delay_ms when exceeds upper bound (1000)', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(loadAaiEnvDefaults({ COUNTERSIGN_INTERRUPTION_DELAY_MS: '2000' })).toEqual({
        voice: DEFAULT_VOICE,
        turn_detection_mode: 'omit',
      });
      expect(warn).toHaveBeenCalledWith('countersign: env value "2000" exceeds max 1000 -- ignored');
      warn.mockRestore();
    });

    it('warns when mode is omit and any of the three env vars are set', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      loadAaiEnvDefaults({
        COUNTERSIGN_TURN_DETECTION: 'omit',
        COUNTERSIGN_MIN_SILENCE_MS: '1500',
      });
      expect(warn).toHaveBeenCalledWith(
        'countersign: COUNTERSIGN_MIN_SILENCE_MS/COUNTERSIGN_MAX_SILENCE_MS/COUNTERSIGN_INTERRUPTION_DELAY_MS are ignored because COUNTERSIGN_TURN_DETECTION is not \'explicit\'.'
      );
      warn.mockRestore();
    });

    it('does not warn when mode is explicit and the env vars are set', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      loadAaiEnvDefaults({
        COUNTERSIGN_TURN_DETECTION: 'explicit',
        COUNTERSIGN_MIN_SILENCE_MS: '1500',
      });
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it('does not warn when no env vars are set, regardless of mode', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      loadAaiEnvDefaults({ COUNTERSIGN_TURN_DETECTION: 'omit' });
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });
  });
});
