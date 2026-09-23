// packages/server/test/brain/wiring.test.ts
// ONE-BRAIN LIVE PATH (2026-09-22, docs/plans/2026-09-22-one-brain-live-path.md §1/§5, Lane
// D). Drives the REAL `attachWebSocketServer` (src/ws/browser.ts) + REAL `BrainCallRegistry`
// (src/brain/registry.ts) + REAL `CallSession` (via a `FakeAaiSocket`, never the live API)
// through a REAL HTTP+WS server on loopback -- the same harness shape
// `test/browser-ws.test.ts` already uses. Proves the Lane D wiring plan §1/§9 risk 3
// requires: a fresh call in endpoint mode generates a token, registers it (resolvable) the
// instant the call starts, passes it to `createAai`, and unregisters it (unresolvable) the
// instant the call ends -- never before, never lingering after. Legacy mode (brainMode
// omitted) never touches the registry at all.
import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import WebSocket from 'ws';
import { createHttpServer } from '../../src/http.js';
import { attachWebSocketServer } from '../../src/ws/browser.js';
import { FakeAaiSocket } from '../../src/aai/fake.js';
import { CallSession } from '../../src/call/session.js';
import { BrainCallRegistry } from '../../src/brain/registry.js';
import { newDiagnosticsState } from '../../src/diagnostics.js';
import type { CapsState } from '../../src/caps.js';
import type { ServerConfig } from '../../src/config.js';
import type { ServerEvent } from '@countersign/engine';

function cfg(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    port: 0,
    assemblyai_api_key: 'secret-key',
    session_cap_seconds: 300,
    max_concurrent: 4,
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

async function pollUntil(cond: () => boolean, timeoutMs = 3000, stepMs = 5): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`pollUntil: condition still false after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

describe('ws/browser — brain registry wiring (ONE-BRAIN LIVE PATH, Lane D)', () => {
  let closers: (() => Promise<void>)[] = [];

  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
  });

  async function start(opts: { brainMode?: 'legacy' | 'endpoint' } = {}): Promise<{
    base: string;
    wsBase: string;
    state: CapsState;
    brainRegistry: BrainCallRegistry;
    aaiInstances: Map<string, FakeAaiSocket>;
    tokensPassedToCreateAai: (string | undefined)[];
    endCall: (session_id: string, reason: string) => boolean;
  }> {
    const ids = ['id-1', 'id-2', 'id-3'];
    let counter = 0;
    const aaiInstances = new Map<string, FakeAaiSocket>();
    const tokensPassedToCreateAai: (string | undefined)[] = [];
    const diagnostics = newDiagnosticsState();
    const brainRegistry = new BrainCallRegistry();
    const serverCfg = cfg();

    const { server, state } = createHttpServer(serverCfg, {
      fetchImpl: globalThis.fetch,
      now: () => Date.now(),
      randomId: () => ids[counter++] ?? `id-${counter}`,
      endCall: (id, reason) => wsApi.endCall(id, reason),
      diagnostics,
    });

    const wsApi = attachWebSocketServer(server, {
      caps: state,
      now: () => Date.now(),
      createAai: (session_id, brainToken) => {
        tokensPassedToCreateAai.push(brainToken);
        const aai = new FakeAaiSocket();
        aaiInstances.set(session_id, aai);
        return aai;
      },
      cfg: serverCfg,
      diagnostics,
      brainRegistry,
      ...(opts.brainMode !== undefined ? { brainMode: opts.brainMode } : {}),
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

    return {
      base: `http://127.0.0.1:${addr.port}`,
      wsBase: `ws://127.0.0.1:${addr.port}`,
      state,
      brainRegistry,
      aaiInstances,
      tokensPassedToCreateAai,
      endCall: wsApi.endCall,
    };
  }

  function selfOriginFor(url: string): string {
    const u = new URL(url);
    return `${u.protocol === 'wss:' ? 'https:' : 'http:'}//${u.host}`;
  }

  function connect(url: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { origin: selfOriginFor(url) });
      ws.once('open', () => resolve(ws));
      ws.once('error', reject);
    });
  }

  function collectMessages(ws: WebSocket): ServerEvent[] {
    const out: ServerEvent[] = [];
    ws.on('message', (data) => out.push(JSON.parse(data.toString()) as ServerEvent));
    return out;
  }

  async function startAndAttach(server: Awaited<ReturnType<typeof start>>): Promise<{ session_id: string; ws: WebSocket; messages: ServerEvent[] }> {
    const startRes = await fetch(`${server.base}/api/session/start`, { method: 'POST' });
    const { session_id, ws_path } = (await startRes.json()) as { session_id: string; ws_path: string };
    const ws = await connect(`${server.wsBase}${ws_path}`);
    const messages = collectMessages(ws);
    ws.send(JSON.stringify({ type: 'start' }));
    await pollUntil(() => messages.some((m) => m.type === 'state'));
    return { session_id, ws, messages };
  }

  it('endpoint mode: generates a per-call token, passes it to createAai, and registers a resolvable CallSession the instant the call starts', async () => {
    const server = await start({ brainMode: 'endpoint' });
    const { session_id, ws } = await startAndAttach(server);

    expect(server.tokensPassedToCreateAai).toHaveLength(1);
    const token = server.tokensPassedToCreateAai[0];
    expect(token).toBeDefined();
    expect(token).toMatch(/^[0-9a-f]{64}$/); // 32 bytes hex, generateCallToken()'s own shape

    expect(server.brainRegistry.size).toBe(1);
    const resolved = server.brainRegistry.get(token!);
    expect(resolved).toBeInstanceOf(CallSession);

    ws.close();
  });

  it('endpoint mode: unregisters the token the instant the call ends -- not resolvable afterward', async () => {
    const server = await start({ brainMode: 'endpoint' });
    const { session_id, ws } = await startAndAttach(server);
    const token = server.tokensPassedToCreateAai[0]!;
    expect(server.brainRegistry.get(token)).toBeInstanceOf(CallSession);

    server.endCall(session_id, 'test_end');
    await pollUntil(() => server.brainRegistry.size === 0);

    expect(server.brainRegistry.get(token)).toBeUndefined();
    ws.close();
  });

  it('endpoint mode: two concurrent calls get two DIFFERENT tokens, each resolving to its own session (no cross-talk)', async () => {
    const server = await start({ brainMode: 'endpoint' });
    const call1 = await startAndAttach(server);
    const call2 = await startAndAttach(server);

    expect(server.tokensPassedToCreateAai).toHaveLength(2);
    const [token1, token2] = server.tokensPassedToCreateAai as [string, string];
    expect(token1).not.toBe(token2);
    expect(server.brainRegistry.size).toBe(2);

    const session1 = server.brainRegistry.get(token1);
    const session2 = server.brainRegistry.get(token2);
    expect(session1).not.toBe(session2);

    call1.ws.close();
    call2.ws.close();
  });

  it('legacy mode (brainMode omitted): createAai is called with no brain token, and the registry is never touched', async () => {
    const server = await start();
    const { ws } = await startAndAttach(server);

    expect(server.tokensPassedToCreateAai).toHaveLength(1);
    expect(server.tokensPassedToCreateAai[0]).toBeUndefined();
    expect(server.brainRegistry.size).toBe(0);

    ws.close();
  });

  it('legacy mode explicitly set: same as omitted -- no token, no registration', async () => {
    const server = await start({ brainMode: 'legacy' });
    const { ws } = await startAndAttach(server);

    expect(server.tokensPassedToCreateAai[0]).toBeUndefined();
    expect(server.brainRegistry.size).toBe(0);

    ws.close();
  });
});
