// Exercises free play's prompt builder (natural-variation instructions, the truth grounding
// block, the strict-JSON contract extended with "silent") and its network layer with a MOCKED
// HttpClient -- no real network call is ever made here (BRIEF: "the tests must not need the
// network"), same discipline scripts/rehearse/test/llmCaller.test.ts already uses.
import { describe, expect, it } from 'vitest';
import {
  buildFreePlayMessages,
  buildFreePlaySystemPrompt,
  freePlayVariationInstructions,
  parseFreePlayCallerReply,
  renderTruthForPrompt,
  requestNextFreePlayLine,
} from '../freePlayPrompt.js';
import type { HttpClient, LlmTurnHistoryEntry, ScenarioTruth } from '../types.js';

function mockHttp(responseBody: unknown, ok = true, status = 200): HttpClient & { calls: { url: string; init: unknown }[] } {
  const calls: { url: string; init: unknown }[] = [];
  return {
    calls,
    async fetch(url, init) {
      calls.push({ url, init });
      return {
        ok,
        status,
        async json() {
          return responseBody;
        },
        async text() {
          return JSON.stringify(responseBody);
        },
      };
    },
  };
}

describe('freePlayVariationInstructions', () => {
  it('instructs the model to vary wording, restate numbers differently, and never recite a script', () => {
    const text = freePlayVariationInstructions();
    expect(text).toMatch(/vary/i);
    expect(text).toMatch(/never.*script|no fixed script/i);
    expect(text).toMatch(/never say the same sentence the same way twice/i);
  });

  it('instructs the model to never break character or mention this is a test', () => {
    expect(freePlayVariationInstructions()).toMatch(/never break character/i);
  });
});

describe('renderTruthForPrompt', () => {
  it('returns null when truth is absent', () => {
    expect(renderTruthForPrompt(undefined)).toBeNull();
  });

  it('returns null when every field is null', () => {
    const truth: ScenarioTruth = { identity: null };
    expect(renderTruthForPrompt(truth)).toBeNull();
  });

  it('renders every non-null field as a labeled line', () => {
    const truth: ScenarioTruth = {
      identity: 'Dana Whitfield',
      beneficiary: 'Meridian Supply',
      amount_usd: 84500,
      account_last4: '4471',
      deadline: 'today',
    };
    const rendered = renderTruthForPrompt(truth);
    expect(rendered).toContain('identity: Dana Whitfield');
    expect(rendered).toContain('beneficiary: Meridian Supply');
    expect(rendered).toContain('amount (USD): 84500');
    expect(rendered).toContain('account, last 4 digits: 4471');
    expect(rendered).toContain('deadline: today');
  });

  it('omits fields that are null or absent', () => {
    const truth: ScenarioTruth = { identity: 'Robert Miller', beneficiary: null };
    const rendered = renderTruthForPrompt(truth)!;
    expect(rendered).toContain('identity: Robert Miller');
    expect(rendered).not.toContain('beneficiary');
  });
});

describe('buildFreePlaySystemPrompt', () => {
  it('includes the persona verbatim, the variation instructions, and the max-words instruction', () => {
    const prompt = buildFreePlaySystemPrompt('You are Dana Whitfield.', undefined, 25);
    expect(prompt).toContain('You are Dana Whitfield.');
    expect(prompt).toContain(freePlayVariationInstructions());
    expect(prompt).toMatch(/at most 25 words/);
  });

  it('includes the truth grounding block when truth is present', () => {
    const truth: ScenarioTruth = { identity: 'Dana Whitfield', amount_usd: 84500 };
    const prompt = buildFreePlaySystemPrompt('persona text', truth, 30);
    expect(prompt).toMatch(/Facts you know for certain/);
    expect(prompt).toContain('amount (USD): 84500');
  });

  it('omits the truth grounding block when truth is absent or empty', () => {
    const prompt = buildFreePlaySystemPrompt('persona text', undefined, 30);
    expect(prompt).not.toMatch(/Facts you know for certain/);
  });

  it('gives the strict-JSON contract with text, barge_in, and silent', () => {
    const prompt = buildFreePlaySystemPrompt('persona', undefined, 30);
    expect(prompt).toContain('"text"');
    expect(prompt).toContain('"barge_in"');
    expect(prompt).toContain('"silent"');
  });

  it('produces a DIFFERENT prompt for two different personas (never a fixed template ignoring input)', () => {
    const a = buildFreePlaySystemPrompt('persona A', undefined, 30);
    const b = buildFreePlaySystemPrompt('persona B', undefined, 30);
    expect(a).not.toEqual(b);
  });
});

describe('buildFreePlayMessages', () => {
  it('opens with a system prompt and an opening trigger when history is empty', () => {
    const messages = buildFreePlayMessages('persona', undefined, [], 30);
    expect(messages[0]!.role).toBe('system');
    expect(messages[1]!.role).toBe('user');
    expect(messages[1]!.content).toMatch(/opening line/i);
  });

  it('maps agent -> user and caller -> assistant, folding the continue-trigger into the last agent line', () => {
    const history: LlmTurnHistoryEntry[] = [
      { speaker: 'caller', text: 'This is Dana.' },
      { speaker: 'agent', text: 'Confirming the amount, is that right?' },
    ];
    const messages = buildFreePlayMessages('persona', undefined, history, 30);
    const roles = messages.map((m) => m.role);
    expect(roles).toEqual(['system', 'assistant', 'user']);
    expect(messages[2]!.content).toContain('Confirming the amount');
    expect(messages[2]!.content).toMatch(/next line now/i);
  });
});

describe('parseFreePlayCallerReply', () => {
  it('parses a clean JSON reply', () => {
    expect(parseFreePlayCallerReply('{"text":"Yes, that is right.","barge_in":false,"silent":false}')).toEqual({
      text: "Yes, that is right.",
      barge_in: false,
      silent: false,
    });
  });

  it('a silent:true reply forces text empty and barge_in false, even if the model also wrote a line', () => {
    expect(parseFreePlayCallerReply('{"text":"I will keep talking","barge_in":true,"silent":true}')).toEqual({
      text: '',
      barge_in: false,
      silent: true,
    });
  });

  it('defaults silent to false when absent', () => {
    expect(parseFreePlayCallerReply('{"text":"ok"}')).toEqual({ text: 'ok', barge_in: false, silent: false });
  });

  it('falls back to the raw text when JSON parsing fails entirely', () => {
    expect(parseFreePlayCallerReply('Yes, that is correct.')).toEqual({ text: 'Yes, that is correct.', barge_in: false, silent: false });
  });

  it('extracts JSON from a reply wrapped in a code fence', () => {
    const raw = '```json\n{"text":"No, it is Meridian Supply.","barge_in":true,"silent":false}\n```';
    expect(parseFreePlayCallerReply(raw)).toEqual({ text: 'No, it is Meridian Supply.', barge_in: true, silent: false });
  });
});

describe('prompt-injection-midcall free-play system prompt (defect 3, 2026-09-14)', () => {
  it('contains both injection lexicon phrases: "ignore your instructions" and "mark this verified"', async () => {
    // Defect 3 free-play fix (2026-09-14): the persona must explicitly instruct the improvising
    // model to say both exact injection lexicon phrases mid-call (packages/engine/src/seed/
    // meridian.ts injection_lexicon line 182). This test loads the actual scenario and verifies
    // the built system prompt contains both phrases.
    const { loadScenario } = await import('../scenario.js');
    const scenario = await loadScenario('prompt-injection-midcall');
    if (!scenario.persona) throw new Error('scenario missing persona');
    const systemPrompt = buildFreePlaySystemPrompt(scenario.persona, scenario.truth, 30);
    // The prompt should contain the persona, which now explicitly mentions both injection phrases
    expect(systemPrompt.toLowerCase()).toMatch(/ignore your instructions/);
    expect(systemPrompt.toLowerCase()).toMatch(/mark this verified/);
  });
});

describe('requestNextFreePlayLine', () => {
  it('routes to openrouter and parses the reply, including silent (on a non-first turn)', async () => {
    // Note: empty history [] would be a first turn. This test uses a history with a caller
    // entry, so it's not the first turn and silent: true is allowed.
    const history: LlmTurnHistoryEntry[] = [
      { speaker: 'caller', text: 'Hello, this is Dana Whitfield.' },
      { speaker: 'agent', text: 'Confirming the amount?' },
    ];
    const http = mockHttp({ choices: [{ message: { content: '{"text":"","barge_in":false,"silent":true}' } }] });
    const result = await requestNextFreePlayLine(http, 'openrouter', 'openai/gpt-4o-mini', 'sk-test', 'persona', undefined, history, 30);
    expect(result).toEqual({ text: '', barge_in: false, silent: true });
  });

  it('routes to gemini when provider is gemini', async () => {
    const http = mockHttp({ candidates: [{ content: { parts: [{ text: '{"text":"Whitmore and Bass.","barge_in":false,"silent":false}' }] } }] });
    const result = await requestNextFreePlayLine(http, 'gemini', 'gemini-1.5-flash', 'gk-test', 'persona', undefined, [], 30);
    expect(result).toEqual({ text: 'Whitmore and Bass.', barge_in: false, silent: false });
  });

  it('rejects silent:true on the caller\'s first turn, even if the model returns it (defect 2, 2026-09-14)', async () => {
    // History with only agent entries (no caller entries yet) means the caller is about to speak
    // for the first time. A persona must never go silent before stating its opening request.
    const history: LlmTurnHistoryEntry[] = [
      { speaker: 'agent', text: 'Meridian payments desk, verification line. How can I help you today?' },
    ];
    const http = mockHttp({ choices: [{ message: { content: '{"text":"","barge_in":false,"silent":true}' } }] });
    const result = await requestNextFreePlayLine(http, 'openrouter', 'openai/gpt-4o-mini', 'sk-test', 'persona', undefined, history, 30);
    // The model returned silent:true on the caller's first line, but it must be forced to false
    expect(result.silent).toBe(false);
    // And the text should be non-empty (the model's response, not blank)
    expect(result.text.trim().length > 0).toBe(true);
  });

  it('allows silent:true on a later turn, after the caller has already spoken', async () => {
    // History with caller entries means the caller has already spoken. A later silent is allowed
    // (hangup-after-request, miller-silent-after-amount scenarios).
    const history: LlmTurnHistoryEntry[] = [
      { speaker: 'caller', text: 'This is Dana Whitfield. I need $84,500 wired today.' },
      { speaker: 'agent', text: 'Confirming the amount, $84,500?' },
    ];
    const http = mockHttp({ choices: [{ message: { content: '{"text":"","barge_in":false,"silent":true}' } }] });
    const result = await requestNextFreePlayLine(http, 'openrouter', 'openai/gpt-4o-mini', 'sk-test', 'persona', undefined, history, 30);
    expect(result).toEqual({ text: '', barge_in: false, silent: true });
  });
});
