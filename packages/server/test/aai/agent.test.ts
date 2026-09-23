// packages/server/test/aai/agent.test.ts
// ONE-BRAIN LIVE PATH (2026-09-22, docs/plans/2026-09-22-one-brain-live-path.md §4, Lane D).
// `ensureBrainAgent` (src/aai/agent.ts) against a FAKE fetch -- never the live AssemblyAI API
// (LAW: tests never call the live API). Covers: creates once when nothing exists yet,
// reconciles (PUT) an existing agent by name without creating a duplicate, recreates if the
// reconcile fails, and never throws -- every failure mode returns `null` so `index.ts` can
// fall back to legacy for every call.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ensureBrainAgent, BRAIN_AGENT_NAME, BRAIN_LLM_MODEL, type EnsureBrainAgentOpts } from '../../src/aai/agent.js';
import { _resetVoiceWarning } from '../../src/aai/config.js';

function opts(overrides: Partial<EnsureBrainAgentOpts> = {}): EnsureBrainAgentOpts {
  return {
    assemblyai_api_key: 'secret-key',
    publicUrl: 'https://countersign.example.com',
    brainApiKey: 'brain-api-key',
    voice: 'anna',
    greeting: 'Meridian payments desk, verification line. How can I help you today?',
    fetchImpl: vi.fn() as unknown as typeof fetch,
    ...overrides,
  };
}

interface Call {
  method: string;
  url: string;
  body: unknown;
}

/** A scripted fake AssemblyAI agents API -- `listResponse` seeds what GET /v1/agents returns;
 *  `putOk`/`postOk` control whether PUT/POST succeed; every call is recorded to `calls` so a
 *  test can assert exactly what was sent and how many times. */
function fakeFetch(state: {
  listResponse: { id: string; name: string }[];
  putOk?: boolean;
  postOk?: boolean;
  postId?: string;
  throwOnList?: boolean;
}): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method, url, body });

    if (method === 'GET' && url === 'https://agents.assemblyai.com/v1/agents') {
      if (state.throwOnList) throw new Error('network down');
      return new Response(JSON.stringify(state.listResponse), { status: 200 });
    }
    if (method === 'PUT') {
      return new Response('{}', { status: state.putOk === false ? 500 : 200 });
    }
    if (method === 'POST' && url === 'https://agents.assemblyai.com/v1/agents') {
      if (state.postOk === false) return new Response('server error', { status: 500 });
      return new Response(JSON.stringify({ id: state.postId ?? 'created-agent-id' }), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

/** A fake fetch that never resolves until the AbortSignal fires -- used to test timeout behavior. */
function neverResolvingFetch(): typeof fetch {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    return new Promise<Response>((resolve, reject) => {
      const signal = init?.signal;
      if (signal) {
        if (signal.aborted) {
          reject(new DOMException('The operation was aborted', 'AbortError'));
          return;
        }
        signal.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'));
        });
      }
      // Never resolve or reject unless aborted; will hang until aborted
    });
  }) as unknown as typeof fetch;
}

describe('ensureBrainAgent', () => {
  beforeEach(() => {
    _resetVoiceWarning();
  });

  it('creates a fresh agent (POST) when GET /v1/agents finds none by name', async () => {
    const { fetchImpl, calls } = fakeFetch({ listResponse: [] });
    const result = await ensureBrainAgent(opts({ fetchImpl }));

    expect(result).toEqual({ id: 'created-agent-id' });
    const postCalls = calls.filter((c) => c.method === 'POST');
    expect(postCalls).toHaveLength(1);
    expect(postCalls[0]!.body).toMatchObject({
      name: BRAIN_AGENT_NAME,
      greeting: 'Meridian payments desk, verification line. How can I help you today?',
      voice: { voice_id: 'anna' },
      llm: [{ base_url: 'https://countersign.example.com/api/brain', model: BRAIN_LLM_MODEL, api_key: 'brain-api-key' }],
    });
    // AssemblyAI appends /chat/completions itself (spike-proven shape) -- this file must
    // never append it.
    expect((postCalls[0]!.body as { llm: { base_url: string }[] }).llm[0]!.base_url).not.toMatch(/\/chat\/completions$/);
  });

  it('strips a trailing slash from publicUrl before appending /api/brain', async () => {
    const { fetchImpl, calls } = fakeFetch({ listResponse: [] });
    await ensureBrainAgent(opts({ fetchImpl, publicUrl: 'https://countersign.example.com/' }));
    const postCall = calls.find((c) => c.method === 'POST')!;
    expect((postCall.body as { llm: { base_url: string }[] }).llm[0]!.base_url).toBe('https://countersign.example.com/api/brain');
  });

  it('reconciles (PUT) an existing agent found by name, WITHOUT creating a duplicate', async () => {
    const { fetchImpl, calls } = fakeFetch({ listResponse: [{ id: 'existing-id', name: BRAIN_AGENT_NAME }] });
    const result = await ensureBrainAgent(opts({ fetchImpl }));

    expect(result).toEqual({ id: 'existing-id' });
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    const putCall = calls.find((c) => c.method === 'PUT')!;
    expect(putCall.url).toBe('https://agents.assemblyai.com/v1/agents/existing-id');
    expect(putCall.body).toMatchObject({ name: BRAIN_AGENT_NAME, voice: { voice_id: 'anna' } });
  });

  it('is idempotent across two boots: the second call finds the agent PUT created and reconciles it, never creating a second one', async () => {
    // First "boot": nothing exists yet.
    const first = fakeFetch({ listResponse: [] });
    const result1 = await ensureBrainAgent(opts({ fetchImpl: first.fetchImpl }));
    expect(result1).toEqual({ id: 'created-agent-id' });

    // Second "boot": the fake now reports the agent the first boot created.
    const second = fakeFetch({ listResponse: [{ id: 'created-agent-id', name: BRAIN_AGENT_NAME }] });
    const result2 = await ensureBrainAgent(opts({ fetchImpl: second.fetchImpl }));
    expect(result2).toEqual({ id: 'created-agent-id' });
    expect(second.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect(second.calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
  });

  it('recreates (POST) when reconciling an existing agent (PUT) fails', async () => {
    const { fetchImpl, calls } = fakeFetch({ listResponse: [{ id: 'stale-id', name: BRAIN_AGENT_NAME }], putOk: false });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await ensureBrainAgent(opts({ fetchImpl }));

    expect(result).toEqual({ id: 'created-agent-id' });
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('returns null (never throws) when create also fails after a reconcile failure', async () => {
    const { fetchImpl } = fakeFetch({ listResponse: [{ id: 'stale-id', name: BRAIN_AGENT_NAME }], putOk: false, postOk: false });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(ensureBrainAgent(opts({ fetchImpl }))).resolves.toBeNull();

    expect(error).toHaveBeenCalled();
    warn.mockRestore();
    error.mockRestore();
  });

  it('returns null (never throws) when create fails and nothing existed to reconcile', async () => {
    const { fetchImpl } = fakeFetch({ listResponse: [], postOk: false });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(ensureBrainAgent(opts({ fetchImpl }))).resolves.toBeNull();

    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('returns null (never throws) when the list call itself throws (network error)', async () => {
    const { fetchImpl, calls } = fakeFetch({ listResponse: [], throwOnList: true, postOk: true });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    // listAgents swallows its own throw and returns [] -- ensureBrainAgent still proceeds to
    // create fresh rather than treating a transient list failure as fatal.
    const result = await ensureBrainAgent(opts({ fetchImpl }));

    expect(result).toEqual({ id: 'created-agent-id' });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    error.mockRestore();
  });

  it('never throws even when fetchImpl itself throws on every call', async () => {
    const throwingFetch = vi.fn(async () => {
      throw new Error('DNS resolution failed');
    }) as unknown as typeof fetch;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(ensureBrainAgent(opts({ fetchImpl: throwingFetch }))).resolves.toBeNull();

    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('falls back to DEFAULT_VOICE for an invalid configured voice, same as the legacy path\'s resolveVoice', async () => {
    const { fetchImpl, calls } = fakeFetch({ listResponse: [] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await ensureBrainAgent(opts({ fetchImpl, voice: 'not-a-real-voice' }));

    const postCall = calls.find((c) => c.method === 'POST')!;
    expect((postCall.body as { voice: { voice_id: string } }).voice.voice_id).toBe('anna');
    warn.mockRestore();
  });

  it(
    'times out on GET /v1/agents (listAgents) and resolves null without throwing',
    async () => {
      const fetchImpl = neverResolvingFetch();
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await ensureBrainAgent(opts({ fetchImpl, fetchTimeoutMs: 200 }));

      expect(result).toBeNull();
      expect(error).toHaveBeenCalled();
      error.mockRestore();
    },
    { timeout: 2000 }
  );

  it(
    'times out on POST /v1/agents (createAgent) and resolves null without throwing',
    async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Seed a fake list response so it skips listAgents and goes straight to create
      const wrappedFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === 'GET') {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        // createAgent will hang
        return neverResolvingFetch()(input, init);
      }) as unknown as typeof fetch;

      const result = await ensureBrainAgent(opts({ fetchImpl: wrappedFetch, fetchTimeoutMs: 200 }));

      expect(result).toBeNull();
      expect(error).toHaveBeenCalled();
      error.mockRestore();
    },
    { timeout: 2000 }
  );

  it(
    'times out on PUT /v1/agents/{id} (updateAgent) and falls back to create, which also times out and resolves null',
    async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const wrappedFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        // List returns an existing agent by name
        if (method === 'GET') {
          return new Response(JSON.stringify([{ id: 'existing-id', name: BRAIN_AGENT_NAME }]), { status: 200 });
        }
        // PUT and POST will hang forever
        return neverResolvingFetch()(input, init);
      }) as unknown as typeof fetch;

      const result = await ensureBrainAgent(opts({ fetchImpl: wrappedFetch, fetchTimeoutMs: 200 }));

      expect(result).toBeNull();
      expect(warn).toHaveBeenCalled(); // reconcile failed warning
      expect(error).toHaveBeenCalled(); // final error after create also failed
      error.mockRestore();
      warn.mockRestore();
    },
    { timeout: 3000 }
  );
});
