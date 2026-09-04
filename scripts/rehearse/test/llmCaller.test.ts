// Exercises the LLM-driven caller's network layer with a MOCKED HttpClient -- no real
// network call is ever made here (BRIEF: "the tests must not need the network"). Covers
// request shape (OpenRouter and Gemini), response parsing, and the missing-key/config
// resolution helpers run.ts uses for its exit-code-2 path.
import { describe, expect, it } from 'vitest';
import {
  resolveLlmConfig,
  apiKeyEnvVarFor,
  getApiKey,
  buildMessages,
  callOpenRouter,
  callGemini,
  parseCallerReply,
  requestNextCallerLine,
} from '../llmCaller.js';
import type { HttpClient, LlmTurnHistoryEntry } from '../types.js';

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

describe('resolveLlmConfig', () => {
  it('routes a bare model id to openrouter', () => {
    expect(resolveLlmConfig('openai/gpt-4o-mini')).toEqual({ provider: 'openrouter', model: 'openai/gpt-4o-mini' });
  });

  it('routes a "gemini/" prefixed model id to gemini, stripping the prefix', () => {
    expect(resolveLlmConfig('gemini/gemini-1.5-flash')).toEqual({ provider: 'gemini', model: 'gemini-1.5-flash' });
  });
});

describe('apiKeyEnvVarFor / getApiKey', () => {
  it('names the right env var per provider', () => {
    expect(apiKeyEnvVarFor('openrouter')).toBe('OPENROUTER_API_KEY');
    expect(apiKeyEnvVarFor('gemini')).toBe('GEMINI_API_KEY');
  });

  it('reads straight from process.env and never throws when absent', () => {
    const original = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    expect(getApiKey('openrouter')).toBeUndefined();
    process.env.OPENROUTER_API_KEY = 'test-key-value';
    expect(getApiKey('openrouter')).toBe('test-key-value');
    if (original === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = original;
  });
});

describe('buildMessages', () => {
  it('opens with a system prompt and an opening trigger when history is empty', () => {
    const messages = buildMessages('You are Dana Whitfield.', [], 30);
    expect(messages[0]!.role).toBe('system');
    expect(messages[0]!.content).toContain('You are Dana Whitfield.');
    expect(messages[1]!.role).toBe('user');
    expect(messages[1]!.content).toMatch(/opening line/i);
  });

  it('maps agent -> user and caller -> assistant, folding the continue-trigger into the last agent line', () => {
    const history: LlmTurnHistoryEntry[] = [
      { speaker: 'caller', text: 'This is Dana.' },
      { speaker: 'agent', text: 'Confirming the amount, is that right?' },
    ];
    const messages = buildMessages('persona', history, 30);
    const roles = messages.map((m) => m.role);
    expect(roles).toEqual(['system', 'assistant', 'user']);
    expect(messages[2]!.content).toContain('Confirming the amount');
    expect(messages[2]!.content).toMatch(/next line now/i);
    // No stray extra trailing user message was appended.
    expect(messages.length).toBe(3);
  });

  it('appends a continue-trigger user message when history ends on the caller\'s own line', () => {
    const history: LlmTurnHistoryEntry[] = [{ speaker: 'caller', text: 'Opening line.' }];
    const messages = buildMessages('persona', history, 30);
    expect(messages[messages.length - 1]!.role).toBe('user');
    expect(messages[messages.length - 1]!.content).toMatch(/next line now/i);
  });
});

describe('callOpenRouter', () => {
  it('posts the right URL, auth header, and model, and parses choices[0].message.content', async () => {
    const http = mockHttp({ choices: [{ message: { content: '{"text":"Yes, that is right.","barge_in":false}' } }] });
    const content = await callOpenRouter(http, 'sk-test', 'openai/gpt-4o-mini', [{ role: 'system', content: 'x' }]);
    expect(content).toContain('Yes, that is right.');
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]!.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const init = http.calls[0]!.init as { headers: Record<string, string>; body: string };
    expect(init.headers.Authorization).toBe('Bearer sk-test');
    const body = JSON.parse(init.body) as { model: string };
    expect(body.model).toBe('openai/gpt-4o-mini');
  });

  it('throws (without leaking the key) on a non-ok response', async () => {
    const http = mockHttp({ error: 'bad request' }, false, 401);
    await expect(callOpenRouter(http, 'sk-secret-key', 'x', [])).rejects.toThrow(/HTTP 401/);
  });

  it('throws when the response is missing the expected content field', async () => {
    const http = mockHttp({ choices: [] });
    await expect(callOpenRouter(http, 'sk-test', 'x', [])).rejects.toThrow(/missing/i);
  });
});

describe('callGemini', () => {
  it('posts to the generateContent endpoint with the key as a query param, and parses the reply', async () => {
    const http = mockHttp({ candidates: [{ content: { parts: [{ text: '{"text":"Hello.","barge_in":false}' }] } }] });
    const content = await callGemini(http, 'gk-test', 'gemini-1.5-flash', [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }]);
    expect(content).toContain('Hello.');
    expect(http.calls[0]!.url).toContain('models/gemini-1.5-flash:generateContent');
    expect(http.calls[0]!.url).toContain('key=gk-test');
  });

  it('never includes the API key in a thrown error message', async () => {
    const http = mockHttp({}, false, 403);
    await expect(callGemini(http, 'gk-super-secret', 'x', [])).rejects.not.toThrow(/gk-super-secret/);
  });
});

describe('parseCallerReply', () => {
  it('parses a clean JSON reply', () => {
    expect(parseCallerReply('{"text":"Yes, that\'s right.","barge_in":false}')).toEqual({ text: "Yes, that's right.", barge_in: false });
  });

  it('extracts JSON from a reply wrapped in extra prose or a code fence', () => {
    const raw = '```json\n{"text":"No, it is Meridian Supply.","barge_in":true}\n```';
    expect(parseCallerReply(raw)).toEqual({ text: 'No, it is Meridian Supply.', barge_in: true });
  });

  it('falls back to the raw text (barge_in false) when JSON parsing fails entirely', () => {
    expect(parseCallerReply('Yes, that is correct.')).toEqual({ text: 'Yes, that is correct.', barge_in: false });
  });

  it('defaults barge_in to false when absent from the JSON', () => {
    expect(parseCallerReply('{"text":"ok"}')).toEqual({ text: 'ok', barge_in: false });
  });
});

describe('requestNextCallerLine', () => {
  it('routes to openrouter for a non-gemini provider and returns the parsed result', async () => {
    const http = mockHttp({ choices: [{ message: { content: '{"text":"Release it now!","barge_in":true}' } }] });
    const result = await requestNextCallerLine(http, 'openrouter', 'openai/gpt-4o-mini', 'sk-test', 'persona', [], 30);
    expect(result).toEqual({ text: 'Release it now!', barge_in: true });
  });

  it('routes to gemini when provider is gemini', async () => {
    const http = mockHttp({ candidates: [{ content: { parts: [{ text: '{"text":"Whitmore and Bass.","barge_in":false}' }] } }] });
    const result = await requestNextCallerLine(http, 'gemini', 'gemini-1.5-flash', 'gk-test', 'persona', [], 30);
    expect(result).toEqual({ text: 'Whitmore and Bass.', barge_in: false });
  });
});
