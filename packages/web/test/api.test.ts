import { describe, it, expect, vi } from 'vitest';
import { startSession } from '../src/api';

interface FakeResult {
  ok: boolean;
  body: unknown;
}

function fakeFetch(result: FakeResult): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: result.ok,
    json: async () => result.body
  }) as unknown as typeof fetch;
}

const SUCCESS_BODY = { session_id: 's1', ws_path: '/ws/call/s1', cap_seconds: 300 };

// Bug fix (2026-09-04): the browser may NAME a demo persona; it must never invent or send
// telemetry values (`origin_kind`/`origin_geo`) itself -- the server alone owns that mapping
// (packages/server/src/personas.ts). These tests exercise the REAL `startSession`
// implementation (an injected fetchImpl, not a mocked module) so the actual request shape is
// proven, not assumed.
describe('startSession', () => {
  it('posts the legitimate persona as a JSON body', async () => {
    const fetchImpl = fakeFetch({ ok: true, body: SUCCESS_BODY });
    await startSession('legitimate', fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith('/api/session/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ persona: 'legitimate' })
    });
  });

  it('posts the attacker persona as a JSON body', async () => {
    const fetchImpl = fakeFetch({ ok: true, body: SUCCESS_BODY });
    await startSession('attacker', fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/session/start',
      expect.objectContaining({ body: JSON.stringify({ persona: 'attacker' }) })
    );
  });

  it('sends no persona field when no role has been chosen (null) -- never invents a default', async () => {
    const fetchImpl = fakeFetch({ ok: true, body: SUCCESS_BODY });
    await startSession(null, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith('/api/session/start', expect.objectContaining({ body: JSON.stringify({}) }));
  });

  it('sends no persona field when called with no arguments at all', async () => {
    const fetchImpl = fakeFetch({ ok: true, body: SUCCESS_BODY });
    await startSession(undefined, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith('/api/session/start', expect.objectContaining({ body: JSON.stringify({}) }));
  });

  it('never sends origin_kind or origin_geo -- the server alone owns simulated telemetry', async () => {
    const fetchImpl = fakeFetch({ ok: true, body: SUCCESS_BODY }) as ReturnType<typeof vi.fn>;
    await startSession('legitimate', fetchImpl as unknown as typeof fetch);

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sentBody).not.toHaveProperty('origin_kind');
    expect(sentBody).not.toHaveProperty('origin_geo');
    expect(sentBody).toEqual({ persona: 'legitimate' });
  });

  it('returns the parsed success body unchanged', async () => {
    const fetchImpl = fakeFetch({ ok: true, body: SUCCESS_BODY });
    const result = await startSession('legitimate', fetchImpl);
    expect(result).toEqual(SUCCESS_BODY);
  });

  it('returns replay_only "server unreachable" when the fetch itself throws', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch;
    const result = await startSession('legitimate', fetchImpl);
    expect(result).toEqual({ replay_only: true, reason: 'server unreachable' });
  });

  it('surfaces a replay_only reason the server returns on a non-ok response', async () => {
    const fetchImpl = fakeFetch({ ok: false, body: { replay_only: true, reason: 'daily_cap' } });
    const result = await startSession('legitimate', fetchImpl);
    expect(result).toEqual({ replay_only: true, reason: 'daily_cap' });
  });
});
