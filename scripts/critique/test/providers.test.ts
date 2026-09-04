// scripts/critique/test/providers.test.ts
// No network: global.fetch is mocked in every test. Verifies request shapes (URL, headers,
// body) for both providers, routing by model id prefix, retry-once on 429/5xx, and that a
// non-retryable 4xx or an empty response surfaces as a thrown ProviderError.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { openRouterProvider } from '../providers/openrouter.js';
import { geminiProvider } from '../providers/gemini.js';
import { providerFor, apiKeyEnvVar } from '../providers/index.js';
import { ProviderError } from '../providers/types.js';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('routing', () => {
  it('routes "gemini/..." ids to the gemini provider and everything else to openrouter', () => {
    expect(providerFor('gemini/gemini-1.5-pro').name).toBe('gemini');
    expect(providerFor('openai/gpt-4o').name).toBe('openrouter');
    expect(providerFor('x-ai/grok-2').name).toBe('openrouter');
  });

  it('names the correct env var per provider', () => {
    expect(apiKeyEnvVar(geminiProvider)).toBe('GEMINI_API_KEY');
    expect(apiKeyEnvVar(openRouterProvider)).toBe('OPENROUTER_API_KEY');
  });
});

describe('openRouterProvider.call request shape', () => {
  it('POSTs the OpenAI-compatible chat completions body with a bearer header', async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
      const body = JSON.parse(init.body as string);
      expect(body.model).toBe('openai/gpt-4o');
      expect(body.messages).toEqual([
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'user prompt' },
      ]);
      return jsonResponse(200, { choices: [{ message: { content: 'the critique text' } }] });
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await openRouterProvider.call({ model: 'openai/gpt-4o', systemPrompt: 'sys', userPrompt: 'user prompt' }, { apiKey: 'test-key', timeoutMs: 5000 });
    expect(res.text).toBe('the critique text');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries once on a 429 then succeeds', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return jsonResponse(429, { error: 'rate limited' });
      return jsonResponse(200, { choices: [{ message: { content: 'ok on retry' } }] });
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await openRouterProvider.call({ model: 'openai/gpt-4o', systemPrompt: 's', userPrompt: 'u' }, { apiKey: 'k', timeoutMs: 5000 });
    expect(res.text).toBe('ok on retry');
    expect(calls).toBe(2);
  });

  it('does not retry a non-retryable 4xx and throws ProviderError', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(400, { error: { message: 'bad request' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(openRouterProvider.call({ model: 'openai/gpt-4o', systemPrompt: 's', userPrompt: 'u' }, { apiKey: 'k', timeoutMs: 5000 })).rejects.toBeInstanceOf(ProviderError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws ProviderError on an empty content response', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { choices: [{ message: { content: '' } }] }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(openRouterProvider.call({ model: 'openai/gpt-4o', systemPrompt: 's', userPrompt: 'u' }, { apiKey: 'k', timeoutMs: 5000 })).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('geminiProvider.call request shape', () => {
  it('builds the generateContent URL with the model name (prefix stripped) and key query param', async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=test-gemini-key');
      const body = JSON.parse(init.body as string);
      expect(body.systemInstruction.parts[0].text).toBe('sys');
      expect(body.contents[0].parts[0].text).toBe('user prompt');
      return jsonResponse(200, { candidates: [{ content: { parts: [{ text: 'gemini critique text' }] } }] });
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await geminiProvider.call({ model: 'gemini/gemini-1.5-pro', systemPrompt: 'sys', userPrompt: 'user prompt' }, { apiKey: 'test-gemini-key', timeoutMs: 5000 });
    expect(res.text).toBe('gemini critique text');
  });

  it('retries once on a 500 then succeeds', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return jsonResponse(500, {});
      return jsonResponse(200, { candidates: [{ content: { parts: [{ text: 'ok' }] } }] });
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await geminiProvider.call({ model: 'gemini/gemini-1.5-pro', systemPrompt: 's', userPrompt: 'u' }, { apiKey: 'k', timeoutMs: 5000 });
    expect(res.text).toBe('ok');
    expect(calls).toBe(2);
  });
});
