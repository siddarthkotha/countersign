import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHttpServer } from '../src/http.js';
import { createStaticServer } from '../src/static.js';
import { newDiagnosticsState, type DiagnosticsState } from '../src/diagnostics.js';
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
    trust_proxy: false,
    browser_grace_ms: 20000,
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
    diagnostics: DiagnosticsState;
    base: string;
  }> {
    let counter = 0;
    const clock = 1000;
    const ids = [
      '11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222',
      '33333333-3333-3333-3333-333333333333',
      '44444444-4444-4444-4444-444444444444',
    ];
    // These http.test.ts cases never open a `/ws/call/:id` socket -- there is no live
    // `CallSession` here, only the caps reservation `/api/session/start` made. A minimal
    // `endCall` stub (free the caps slot if it's active) exercises exactly what http.ts's
    // `/end`/`/reset` routes actually need from it (CRITICAL 1, final review); `ws/browser.
    // test.ts` covers the real `endCall` -- ending a live call, not just a reservation.
    let stateRef: CapsState;
    const diagnostics = newDiagnosticsState();
    const { server, state } = createHttpServer(cfg(cfgOverrides), {
      fetchImpl: globalThis.fetch,
      now: () => clock,
      randomId: () => ids[counter++] ?? `99999999-9999-9999-9999-99999999999${counter}`,
      endCall: (id) => {
        if (stateRef.active.has(id)) {
          stateRef.active.delete(id);
          return true;
        }
        return false;
      },
      diagnostics,
    });
    stateRef = state;
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as AddressInfo;
        close = () => new Promise((res) => server.close(() => res()));
        resolve({ server, state, diagnostics, base: `http://127.0.0.1:${addr.port}` });
      });
    });
  }

  it('start then start then session_in_use, reset frees a slot', async () => {
    const { base } = await start();

    const r1 = await fetch(`${base}/api/session/start`, { method: 'POST' });
    expect(r1.status).toBe(200);
    const b1 = await r1.json();
    expect(b1).toEqual({
      session_id: '11111111-1111-1111-1111-111111111111',
      ws_path: '/ws/call/11111111-1111-1111-1111-111111111111',
      cap_seconds: 300,
    });

    const r2 = await fetch(`${base}/api/session/start`, { method: 'POST' });
    expect(r2.status).toBe(200);
    const b2 = (await r2.json()) as StartResponseBody;
    expect(b2.session_id).toBe('22222222-2222-2222-2222-222222222222');

    const r3 = await fetch(`${base}/api/session/start`, { method: 'POST' });
    expect(r3.status).toBe(429);
    const b3 = await r3.json();
    expect(b3).toEqual({ replay_only: true, reason: 'session_in_use' });

    const rReset = await fetch(`${base}/api/session/11111111-1111-1111-1111-111111111111/reset`, {
      method: 'POST',
    });
    expect(rReset.status).toBe(204);

    const r4 = await fetch(`${base}/api/session/start`, { method: 'POST' });
    expect(r4.status).toBe(200);
    const b4 = (await r4.json()) as StartResponseBody;
    expect(b4.session_id).toBe('33333333-3333-3333-3333-333333333333');
  });

  it('garbage session id returns 404', async () => {
    const { base } = await start();
    const r = await fetch(`${base}/api/session/not-a-uuid/reset`, { method: 'POST' });
    expect(r.status).toBe(404);
    const body = await r.json();
    expect(body).toEqual({ error: 'not_found' });
  });

  it('well-formed but unknown session id returns 404', async () => {
    const { base } = await start();
    const r = await fetch(`${base}/api/session/99999999-9999-9999-9999-999999999999/end`, {
      method: 'POST',
    });
    expect(r.status).toBe(404);
    const body = await r.json();
    expect(body).toEqual({ error: 'not_found' });
  });

  it('active session id returns 204 and frees the slot', async () => {
    const { base } = await start({ max_concurrent: 1 });
    const r1 = await fetch(`${base}/api/session/start`, { method: 'POST' });
    const b1 = (await r1.json()) as StartResponseBody;
    const rReset = await fetch(`${base}/api/session/${b1.session_id}/reset`, { method: 'POST' });
    expect(rReset.status).toBe(204);
    const r2 = await fetch(`${base}/api/session/start`, { method: 'POST' });
    expect(r2.status).toBe(200);
  });

  it('health shape', async () => {
    const { base } = await start();
    const r = await fetch(`${base}/health`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toEqual({ ok: true, active: 0, killed: false, has_key: true });
  });

  it('version reports the deployed commit (null in local dev)', async () => {
    const { base } = await start();
    const r = await fetch(`${base}/version`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { commit: string | null };
    expect(body).toHaveProperty('commit');
    // RENDER_GIT_COMMIT is unset under the test, so the running process reports null here.
    expect(body.commit).toBe(process.env.RENDER_GIT_COMMIT ?? null);
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

  // Same-origin fix (2026-09-02): the deployed Render URL never matched render.yaml's
  // guessed COUNTERSIGN_ALLOWED_ORIGINS (the `countersign` name slug belongs to an unrelated
  // product, so Render appended a suffix) -- http.ts now recognizes a request's OWN origin
  // automatically instead of relying on that guess.
  it('CORS: allows this server\'s own origin via the plain Host header, with no allowlist entry for it', async () => {
    const { base } = await start();
    // `base` is this test server's real address (http://127.0.0.1:<port>) -- fetch sends
    // that same value as the Host header, so it IS this request's own origin, and it is
    // deliberately absent from cfg()'s allowed_origins (['http://localhost:5173']).
    const r = await fetch(`${base}/api/session/start`, {
      method: 'OPTIONS',
      headers: { Origin: base },
    });
    expect(r.headers.get('access-control-allow-origin')).toBe(base);
  });

  it('CORS: allows this server\'s own origin via X-Forwarded-Proto/X-Forwarded-Host when COUNTERSIGN_TRUST_PROXY is on (how Render presents it)', async () => {
    const { base } = await start({ trust_proxy: true });
    const r = await fetch(`${base}/api/session/start`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://countersign-abc123.onrender.com',
        'X-Forwarded-Proto': 'https',
        'X-Forwarded-Host': 'countersign-abc123.onrender.com',
      },
    });
    expect(r.headers.get('access-control-allow-origin')).toBe('https://countersign-abc123.onrender.com');
  });

  it('CORS: a foreign origin is still denied even when X-Forwarded headers are present and trusted', async () => {
    const { base } = await start({ trust_proxy: true });
    const r = await fetch(`${base}/api/session/start`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://evil.example',
        'X-Forwarded-Proto': 'https',
        'X-Forwarded-Host': 'countersign-abc123.onrender.com',
      },
    });
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
  });

  // Requirement (task-origin-fix1-brief.md #2): X-Forwarded-* is only ever honoured when
  // COUNTERSIGN_TRUST_PROXY=1 -- without it (the default everywhere except render.yaml), a
  // direct caller can't lie about its own origin by forging a forwarded header.
  it('CORS: X-Forwarded-Proto/X-Forwarded-Host are ignored when COUNTERSIGN_TRUST_PROXY is off (the default)', async () => {
    const { base } = await start({ trust_proxy: false });

    // The forged forwarded host is NOT trusted, so it must not be treated as same-origin.
    const rForged = await fetch(`${base}/api/session/start`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://countersign-abc123.onrender.com',
        'X-Forwarded-Proto': 'https',
        'X-Forwarded-Host': 'countersign-abc123.onrender.com',
      },
    });
    expect(rForged.headers.get('access-control-allow-origin')).toBeNull();

    // The server's REAL own origin (plain Host header) still works, forwarded headers or not.
    const rReal = await fetch(`${base}/api/session/start`, {
      method: 'OPTIONS',
      headers: {
        Origin: base,
        'X-Forwarded-Proto': 'https',
        'X-Forwarded-Host': 'countersign-abc123.onrender.com',
      },
    });
    expect(rReal.headers.get('access-control-allow-origin')).toBe(base);
  });

  // Requirement (task-origin-fix1-brief.md #5, exact case): a Render-shaped deployed hostname,
  // trusted forwarded headers, matching a browser Origin with no port.
  it('CORS: Host countersign-bf8q.onrender.com + trusted X-Forwarded-Proto https matches Origin https://countersign-bf8q.onrender.com', async () => {
    const { base } = await start({ trust_proxy: true });
    const r = await fetch(`${base}/api/session/start`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://countersign-bf8q.onrender.com',
        'X-Forwarded-Proto': 'https',
        'X-Forwarded-Host': 'countersign-bf8q.onrender.com',
      },
    });
    expect(r.headers.get('access-control-allow-origin')).toBe('https://countersign-bf8q.onrender.com');
  });

  // Requirement (task-origin-fix1-brief.md #5): a Host header that spells out the scheme's
  // default port explicitly (":443" for https) must still match a browser Origin, which never
  // includes a default port.
  it('CORS: Host with explicit :443 matches an Origin with no port, when trusted', async () => {
    const { base } = await start({ trust_proxy: true });
    const r = await fetch(`${base}/api/session/start`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://countersign-bf8q.onrender.com',
        'X-Forwarded-Proto': 'https',
        'X-Forwarded-Host': 'countersign-bf8q.onrender.com:443',
      },
    });
    expect(r.headers.get('access-control-allow-origin')).toBe('https://countersign-bf8q.onrender.com');
  });

  // Minor finding (task-origin-review.md): comparison is case-insensitive, so a mixed-case
  // forwarded Host still recognizes the same origin a lowercase browser Origin sends.
  it('CORS: a mixed-case forwarded Host still matches a lowercase Origin, when trusted', async () => {
    const { base } = await start({ trust_proxy: true });
    const r = await fetch(`${base}/api/session/start`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://countersign-bf8q.onrender.com',
        'X-Forwarded-Proto': 'https',
        'X-Forwarded-Host': 'Countersign-Bf8Q.Onrender.com',
      },
    });
    expect(r.headers.get('access-control-allow-origin')).toBe('https://countersign-bf8q.onrender.com');
  });

  // Minor finding (task-origin-review.md): a configured allowlist entry with a trailing slash
  // still matches a browser Origin, which never carries one.
  it('CORS: a configured allowlist entry with a trailing slash still matches', async () => {
    const { base } = await start({ allowed_origins: ['https://extra.example/'] });
    const r = await fetch(`${base}/api/session/start`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://extra.example' },
    });
    expect(r.headers.get('access-control-allow-origin')).toBe('https://extra.example');
  });

  it('CORS: a configured extra origin is still allowed alongside same-origin', async () => {
    const { base } = await start({ allowed_origins: ['https://extra.example'] });

    const rExtra = await fetch(`${base}/api/session/start`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://extra.example' },
    });
    expect(rExtra.headers.get('access-control-allow-origin')).toBe('https://extra.example');

    const rSelf = await fetch(`${base}/api/session/start`, {
      method: 'OPTIONS',
      headers: { Origin: base },
    });
    expect(rSelf.headers.get('access-control-allow-origin')).toBe(base);
  });

  it('CORS: an empty allowed_origins config (render.yaml\'s production value) allows only same-origin', async () => {
    const { base } = await start({ allowed_origins: [] });

    const rSelf = await fetch(`${base}/api/session/start`, {
      method: 'OPTIONS',
      headers: { Origin: base },
    });
    expect(rSelf.headers.get('access-control-allow-origin')).toBe(base);

    // The old dev default (localhost:5173) is no longer configured, so it's no longer
    // allowed either -- an empty env means no EXTRA origins, never "allow all".
    const rDevDefault = await fetch(`${base}/api/session/start`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:5173' },
    });
    expect(rDevDefault.headers.get('access-control-allow-origin')).toBeNull();

    const rForeign = await fetch(`${base}/api/session/start`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://evil.example' },
    });
    expect(rForeign.headers.get('access-control-allow-origin')).toBeNull();
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

// D1 fix round 1 #1: the static-server mount (http.ts) used to gate on `req.method ===
// 'GET'` only, so a HEAD request fell through to the generic JSON 404 even though
// static.ts's `handle` always supported HEAD -- invisible to every other test in this file
// (none of them ever configure a `staticServer`) and to static.test.ts (it exercises
// `staticServer.handle` directly, bypassing http.ts's mount entirely). This suite builds the
// REAL `createHttpServer` with a real `staticServer`, which is the only way to catch a
// regression in the mount's own method gate rather than in static.ts's internal one.
describe('http server -- static mount (D1 fix round 1 #1)', () => {
  let close: (() => Promise<void>) | undefined;
  let fixtureDir: string;

  afterEach(async () => {
    if (close) {
      await close();
      close = undefined;
    }
    if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  });

  async function startWithStatic(): Promise<{ base: string }> {
    fixtureDir = mkdtempSync(join(tmpdir(), 'countersign-http-static-'));
    writeFileSync(join(fixtureDir, 'index.html'), '<!doctype html><html><body>shell</body></html>');

    const { server } = createHttpServer(cfg(), {
      fetchImpl: globalThis.fetch,
      now: () => 1000,
      randomId: () => '11111111-1111-1111-1111-111111111111',
      endCall: () => false,
      staticServer: createStaticServer(fixtureDir),
      diagnostics: newDiagnosticsState(),
    });
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as AddressInfo;
        close = () =>
          new Promise((res) => {
            server.closeAllConnections();
            server.close(() => res());
          });
        resolve({ base: `http://127.0.0.1:${addr.port}` });
      });
    });
  }

  it('GET / reaches the static server and serves index.html', async () => {
    const { base } = await startWithStatic();
    const r = await fetch(`${base}/`);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('shell');
  });

  it('HEAD / reaches the static server too -- not the JSON 404 (the actual bug found)', async () => {
    const { base } = await startWithStatic();
    const r = await fetch(`${base}/`, { method: 'HEAD' });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/html');
    expect(await r.text()).toBe('');
  });

  it('unmatched /api path still gets the JSON 404, HEAD included', async () => {
    const { base } = await startWithStatic();
    const rGet = await fetch(`${base}/api/nonexistent`);
    expect(rGet.status).toBe(404);
    expect(await rGet.json()).toEqual({ error: 'not found' });

    const rHead = await fetch(`${base}/api/nonexistent`, { method: 'HEAD' });
    expect(rHead.status).toBe(404);
  });
});
