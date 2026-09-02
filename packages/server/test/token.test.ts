import { describe, it, expect, vi } from 'vitest';
import { mintToken } from '../src/token.js';
import type { ServerConfig } from '../src/config.js';

function cfg(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    port: 8787,
    assemblyai_api_key: 'secret-key',
    session_cap_seconds: 300,
    max_concurrent: 2,
    idle_timeout_ms: 30000,
    daily_session_cap: 40,
    mint_rate_per_minute: 6,
    kill_switch: false,
    allowed_origins: ['http://localhost:5173'],
    browser_grace_ms: 20000,
    ...overrides,
  };
}

describe('mintToken', () => {
  it('calls the AssemblyAI token endpoint with both query params and the bearer header', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
      return new Response(JSON.stringify({ token: 'tok-123', expires_in_seconds: 60 }), { status: 200 });
    });

    const result = await mintToken(cfg({ session_cap_seconds: 900 }), fetchImpl as unknown as typeof fetch);

    expect(result).toEqual({ token: 'tok-123', expires_in_seconds: 60 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchImpl.mock.calls[0]!;
    expect(String(calledUrl)).toBe(
      'https://agents.assemblyai.com/v1/token?expires_in_seconds=60&max_session_duration_seconds=900'
    );
    expect((calledInit as RequestInit).headers).toMatchObject({ Authorization: 'Bearer secret-key' });
  });

  it('throws with the status code on a non-2xx response', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response('unauthorized', { status: 401 }));
    await expect(mintToken(cfg(), fetchImpl as unknown as typeof fetch)).rejects.toThrow('401');
  });

  it('throws when no api key is configured', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response('{}', { status: 200 }));
    await expect(mintToken(cfg({ assemblyai_api_key: null }), fetchImpl as unknown as typeof fetch)).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
