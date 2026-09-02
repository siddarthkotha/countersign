import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createHttpServer } from '../src/http.js';
import type { CapsState } from '../src/caps.js';
import type { ServerConfig } from '../src/config.js';

interface StartResponseBody {
  session_id: string;
  ws_path: string;
  cap_seconds: number;
}

function cfg(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    port: 0,
    assemblyai_api_key: 'secret-key',
    session_cap_seconds: 300,
    max_concurrent: 2,
    idle_timeout_ms: 30000,
    daily_session_cap: 40,
    mint_rate_per_minute: 100,
    kill_switch: false,
    allowed_origins: ['http://localhost:5173'],
    ...overrides,
  };
}

describe('http server', () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (close) {
      await close();
      close = undefined;
    }
  });

  function start(cfgOverrides: Partial<ServerConfig> = {}): Promise<{
    server: Server;
    state: CapsState;
    base: string;
  }> {
    let counter = 0;
    const clock = 1000;
    const ids = ['id-1', 'id-2', 'id-3', 'id-4'];
    const { server, state } = createHttpServer(cfg(cfgOverrides), {
      fetchImpl: globalThis.fetch,
      now: () => clock,
      randomId: () => ids[counter++] ?? `id-${counter}`,
    });
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as AddressInfo;
        close = () => new Promise((res) => server.close(() => res()));
        resolve({ server, state, base: `http://127.0.0.1:${addr.port}` });
      });
    });
  }

  it('start then start then session_in_use, reset frees a slot', async () => {
    const { base } = await start();

    const r1 = await fetch(`${base}/api/session/start`, { method: 'POST' });
    expect(r1.status).toBe(200);
    const b1 = await r1.json();
    expect(b1).toEqual({ session_id: 'id-1', ws_path: '/ws/call/id-1', cap_seconds: 300 });

    const r2 = await fetch(`${base}/api/session/start`, { method: 'POST' });
    expect(r2.status).toBe(200);
    const b2 = (await r2.json()) as StartResponseBody;
    expect(b2.session_id).toBe('id-2');

    const r3 = await fetch(`${base}/api/session/start`, { method: 'POST' });
    expect(r3.status).toBe(429);
    const b3 = await r3.json();
    expect(b3).toEqual({ replay_only: true, reason: 'session_in_use' });

    const rReset = await fetch(`${base}/api/session/id-1/reset`, { method: 'POST' });
    expect(rReset.status).toBe(204);

    const r4 = await fetch(`${base}/api/session/start`, { method: 'POST' });
    expect(r4.status).toBe(200);
    const b4 = (await r4.json()) as StartResponseBody;
    expect(b4.session_id).toBe('id-3');
  });

  it('health shape', async () => {
    const { base } = await start();
    const r = await fetch(`${base}/health`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toEqual({ ok: true, active: 0, killed: false, has_key: true });
  });

  it('unknown path returns 404', async () => {
    const { base } = await start();
    const r = await fetch(`${base}/nope`);
    expect(r.status).toBe(404);
    const body = await r.json();
    expect(body).toHaveProperty('error');
  });

  it('CORS: echoes an allowed origin, omits the header for a disallowed origin', async () => {
    const { base } = await start();

    const rAllowed = await fetch(`${base}/api/session/start`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:5173' },
    });
    expect(rAllowed.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');

    const rDisallowed = await fetch(`${base}/api/session/start`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://evil.example' },
    });
    expect(rDisallowed.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('kill switch returns 503 replay_only', async () => {
    const { base } = await start({ kill_switch: true });
    const r = await fetch(`${base}/api/session/start`, { method: 'POST' });
    expect(r.status).toBe(503);
    const body = await r.json();
    expect(body).toEqual({ replay_only: true, reason: 'kill_switch' });
  });

  it('no api key returns 503 replay_only', async () => {
    const { base } = await start({ assemblyai_api_key: null });
    const r = await fetch(`${base}/api/session/start`, { method: 'POST' });
    expect(r.status).toBe(503);
    const body = await r.json();
    expect(body).toEqual({ replay_only: true, reason: 'no_api_key' });
  });

  it('end frees a concurrency slot', async () => {
    const { base } = await start({ max_concurrent: 1 });
    const r1 = await fetch(`${base}/api/session/start`, { method: 'POST' });
    const b1 = (await r1.json()) as StartResponseBody;
    const rEnd = await fetch(`${base}/api/session/${b1.session_id}/end`, { method: 'POST' });
    expect(rEnd.status).toBe(204);
    const r2 = await fetch(`${base}/api/session/start`, { method: 'POST' });
    expect(r2.status).toBe(200);
  });
});
