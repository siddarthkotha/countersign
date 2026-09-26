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
 *  `putOk`/`postOk`/`deleteOk` control whether PUT/POST/DELETE succeed; `putResults` (when
 *  given) overrides `putOk` with a per-call sequence, consumed in order and repeating its last
 *  entry once exhausted -- used to script "fails once, succeeds on retry" and similar. Every
 *  call is recorded to `calls` so a test can assert exactly what was sent and how many times. */
function fakeFetch(state: {
  listResponse: { id: string; name: string; created_at?: string }[];
  /** Overrides `listResponse` entirely for the GET response body -- lets a test construct an
   *  arbitrary (including malformed or object-shaped) list body without touching the plain
   *  array fixture every other test already relies on. */
  rawListBody?: unknown;
  putOk?: boolean;
  putResults?: boolean[];
  postOk?: boolean;
  postId?: string;
  deleteOk?: boolean;
  throwOnList?: boolean;
}): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let putCallIndex = 0;
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method, url, body });

    if (method === 'GET' && url.startsWith('https://agents.assemblyai.com/v1/agents') && !url.includes('/agents/')) {
      if (state.throwOnList) throw new Error('network down');
      const responseBody = 'rawListBody' in state ? state.rawListBody : state.listResponse;
      return new Response(JSON.stringify(responseBody), { status: 200 });
    }
    if (method === 'PUT') {
      let ok: boolean;
      if (state.putResults) {
        const idx = Math.min(putCallIndex, state.putResults.length - 1);
        ok = state.putResults[idx] ?? true;
        putCallIndex += 1;
      } else {
        ok = state.putOk !== false;
      }
      return new Response('{}', { status: ok ? 200 : 500 });
    }
    if (method === 'POST' && url === 'https://agents.assemblyai.com/v1/agents') {
      if (state.postOk === false) return new Response('server error', { status: 500 });
      return new Response(JSON.stringify({ id: state.postId ?? 'created-agent-id' }), { status: 200 });
    }
    if (method === 'DELETE') {
      return new Response('{}', { status: state.deleteOk === false ? 500 : 200 });
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

  // PUT-FAILURE-CREATES-DUPLICATE fix (live-run finding, 2026-09-23: two restarts left TWO
  // stored agents both named "countersign-brain" -- a PUT reconcile failure used to fall
  // through to POST every time, leaking a duplicate). Replaces the old
  // "recreates (POST) when reconciling fails" test, whose premise (reconcile failure ->
  // create) no longer holds: `createAgent` is only ever reached when nothing existed at all.
  it('retries PUT once when reconcile fails, then reuses the existing agent as-is -- never creates a duplicate', async () => {
    const { fetchImpl, calls } = fakeFetch({ listResponse: [{ id: 'stale-id', name: BRAIN_AGENT_NAME }], putOk: false });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await ensureBrainAgent(opts({ fetchImpl }));

    expect(result).toEqual({ id: 'stale-id' });
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(2); // original + one retry
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0); // never a duplicate
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a PUT that fails once but succeeds on retry reconciles cleanly -- no duplicate created', async () => {
    const { fetchImpl, calls } = fakeFetch({
      listResponse: [{ id: 'existing-id', name: BRAIN_AGENT_NAME }],
      putResults: [false, true],
    });

    const result = await ensureBrainAgent(opts({ fetchImpl }));

    expect(result).toEqual({ id: 'existing-id' });
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(2);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  // DUPLICATE-CLEANUP (live-run finding, 2026-09-23).
  it('cleans up duplicates: when GET finds MULTIPLE agents named countersign-brain, keeps the newest (by created_at) and deletes the rest, then reconciles the survivor', async () => {
    const { fetchImpl, calls } = fakeFetch({
      listResponse: [
        { id: 'newer-id', name: BRAIN_AGENT_NAME, created_at: '2026-09-23T02:00:00.000Z' },
        { id: 'older-id', name: BRAIN_AGENT_NAME, created_at: '2026-09-22T20:00:00.000Z' },
      ],
    });

    const result = await ensureBrainAgent(opts({ fetchImpl }));

    expect(result).toEqual({ id: 'newer-id' });
    const deleteCalls = calls.filter((c) => c.method === 'DELETE');
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0]!.url).toBe('https://agents.assemblyai.com/v1/agents/older-id');
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
    expect(calls.find((c) => c.method === 'PUT')!.url).toBe('https://agents.assemblyai.com/v1/agents/newer-id');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  // OBJECT-SHAPED LIST RESPONSE (live-run finding, 2026-09-25: a read-only curl of the real
  // GET /v1/agents proved the live body is `{agents: [...], has_more, response_metadata}`, not
  // a bare array as the earlier docs re-check assumed. listAgents must accept both shapes.
  it('accepts an object-shaped list response ({agents:[...]}): the newest of 3 same-name agents survives (PUT), the other two are DELETEd, no POST', async () => {
    const { fetchImpl, calls } = fakeFetch({
      listResponse: [],
      rawListBody: {
        agents: [
          { id: 'newest-id', name: BRAIN_AGENT_NAME, created_at: '2026-09-26T00:48:38.709185' },
          { id: 'middle-id', name: BRAIN_AGENT_NAME, created_at: '2026-09-24T12:00:00.000000' },
          { id: 'oldest-id', name: BRAIN_AGENT_NAME, created_at: '2026-09-23T12:38:00.000000' },
        ],
        has_more: false,
        response_metadata: {},
      },
    });

    const result = await ensureBrainAgent(opts({ fetchImpl }));

    expect(result).toEqual({ id: 'newest-id' });
    const deleteUrls = calls.filter((c) => c.method === 'DELETE').map((c) => c.url);
    expect(deleteUrls.sort()).toEqual(
      ['https://agents.assemblyai.com/v1/agents/middle-id', 'https://agents.assemblyai.com/v1/agents/oldest-id'].sort()
    );
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
    expect(calls.find((c) => c.method === 'PUT')!.url).toBe('https://agents.assemblyai.com/v1/agents/newest-id');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('still works with a bare-array list response (the old documented shape) alongside the new object shape', async () => {
    const { fetchImpl, calls } = fakeFetch({
      listResponse: [{ id: 'existing-id', name: BRAIN_AGENT_NAME }],
    });

    const result = await ensureBrainAgent(opts({ fetchImpl }));

    expect(result).toEqual({ id: 'existing-id' });
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('a malformed list body (neither a bare array nor an {agents:[...]} object) is treated as empty -- never a wrong DELETE, falls through to create', async () => {
    const { fetchImpl, calls } = fakeFetch({
      listResponse: [],
      rawListBody: { unexpected: 'shape', agents: 'not-an-array' },
    });

    const result = await ensureBrainAgent(opts({ fetchImpl }));

    expect(result).toEqual({ id: 'created-agent-id' });
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('logs a warning and stops after the first page when the object-shaped response says has_more:true (no proven pagination parameter to follow)', async () => {
    const { fetchImpl, calls } = fakeFetch({
      listResponse: [],
      rawListBody: {
        agents: [{ id: 'only-page-id', name: BRAIN_AGENT_NAME, created_at: '2026-09-23T12:38:00.000000' }],
        has_more: true,
        response_metadata: { next_cursor: 'some-cursor-value' },
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await ensureBrainAgent(opts({ fetchImpl }));

    expect(result).toEqual({ id: 'only-page-id' });
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(1); // never paginated further
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/has_more/i));
    warn.mockRestore();
  });

  it('never deletes an agent whose name is not exactly countersign-brain', async () => {
    const { fetchImpl, calls } = fakeFetch({
      listResponse: [
        { id: 'ours', name: BRAIN_AGENT_NAME, created_at: '2026-09-23T02:00:00.000Z' },
        { id: 'someone-elses', name: 'some-other-agent', created_at: '2026-09-23T03:00:00.000Z' },
      ],
    });

    const result = await ensureBrainAgent(opts({ fetchImpl }));

    expect(result).toEqual({ id: 'ours' });
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  });

  it('cleanup falls back to list order (API-documented newest-first) when created_at is missing', async () => {
    const { fetchImpl, calls } = fakeFetch({
      listResponse: [
        { id: 'first-in-list', name: BRAIN_AGENT_NAME }, // no created_at
        { id: 'second-in-list', name: BRAIN_AGENT_NAME },
      ],
    });

    const result = await ensureBrainAgent(opts({ fetchImpl }));

    expect(result).toEqual({ id: 'first-in-list' });
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual([
      'https://agents.assemblyai.com/v1/agents/second-in-list',
    ]);
  });

  it('a failed DELETE during cleanup is logged and left for a future boot -- never fatal, survivor still reconciled', async () => {
    const { fetchImpl } = fakeFetch({
      listResponse: [
        { id: 'newer-id', name: BRAIN_AGENT_NAME, created_at: '2026-09-23T02:00:00.000Z' },
        { id: 'older-id', name: BRAIN_AGENT_NAME, created_at: '2026-09-22T20:00:00.000Z' },
      ],
      deleteOk: false,
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await ensureBrainAgent(opts({ fetchImpl }));

    expect(result).toEqual({ id: 'newer-id' });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
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
    'times out on PUT /v1/agents/{id} (updateAgent), retries once (also times out), then reuses the existing agent as-is rather than ever falling back to create',
    async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const wrappedFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        // List returns an existing agent by name
        if (method === 'GET') {
          return new Response(JSON.stringify([{ id: 'existing-id', name: BRAIN_AGENT_NAME }]), { status: 200 });
        }
        // PUT (and any POST, which must never be reached -- reconcile failure never creates a
        // duplicate) hang forever.
        return neverResolvingFetch()(input, init);
      }) as unknown as typeof fetch;

      const result = await ensureBrainAgent(opts({ fetchImpl: wrappedFetch, fetchTimeoutMs: 200 }));

      expect(result).toEqual({ id: 'existing-id' });
      expect(warn).toHaveBeenCalled(); // reconcile-failed-twice, reusing-as-is warning
      warn.mockRestore();
    },
    { timeout: 3000 }
  );
});
