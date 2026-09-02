import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import WebSocket from 'ws';
import { createHttpServer } from '../src/http.js';
import { attachWebSocketServer } from '../src/ws/browser.js';
import { FakeAaiSocket } from '../src/aai/fake.js';
import type { CapsState } from '../src/caps.js';
import type { ServerConfig } from '../src/config.js';
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
    ...overrides,
  };
}

describe('ws/browser — /ws/call/:id', () => {
  let closers: (() => Promise<void>)[] = [];

  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
  });

  async function start(): Promise<{
    base: string;
    wsBase: string;
    state: CapsState;
    aaiInstances: Map<string, FakeAaiSocket>;
  }> {
    const ids = ['id-1', 'id-2', 'id-3'];
    let counter = 0;
    const aaiInstances = new Map<string, FakeAaiSocket>();

    const { server, state } = createHttpServer(cfg(), {
      fetchImpl: globalThis.fetch,
      now: () => Date.now(),
      randomId: () => ids[counter++] ?? `id-${counter}`,
    });

    attachWebSocketServer(server, {
      caps: state,
      now: () => Date.now(),
      createAai: (session_id) => {
        const aai = new FakeAaiSocket();
        aaiInstances.set(session_id, aai);
        return aai;
      },
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

    return {
      base: `http://127.0.0.1:${addr.port}`,
      wsBase: `ws://127.0.0.1:${addr.port}`,
      state,
      aaiInstances,
    };
  }

  function connect(url: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.once('open', () => resolve(ws));
      ws.once('error', reject);
    });
  }

  function collectMessages(ws: WebSocket): ServerEvent[] {
    const out: ServerEvent[] = [];
    ws.on('message', (data) => out.push(JSON.parse(data.toString()) as ServerEvent));
    return out;
  }

  it('closes with 4404 for an id nobody started', async () => {
    const { wsBase } = await start();
    const ws = new WebSocket(`${wsBase}/ws/call/nonexistent-id`);
    const closeCode = await new Promise<number>((resolve) => {
      ws.once('close', (code) => resolve(code));
    });
    expect(closeCode).toBe(4404);
  });

  it('a started session accepts the connection and sends state after {type:"start"}', async () => {
    const { base, wsBase, aaiInstances } = await start();
    const startRes = await fetch(`${base}/api/session/start`, { method: 'POST' });
    const { session_id, ws_path } = (await startRes.json()) as { session_id: string; ws_path: string };
    expect(ws_path).toBe(`/ws/call/${session_id}`);

    const ws = await connect(`${wsBase}${ws_path}`);
    const messages = collectMessages(ws);
    ws.send(JSON.stringify({ type: 'start' }));

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(aaiInstances.has(session_id)).toBe(true);
    expect(messages.some((m) => m.type === 'state')).toBe(true);
    const stateMsg = messages.find((m) => m.type === 'state');
    if (stateMsg?.type === 'state') {
      expect(stateMsg.state.session_id).toBe(session_id);
      expect(stateMsg.state.link).toBe('live');
    }

    ws.close();
  });

  it('throttles rapid state updates to at most one send per ~66ms window', async () => {
    const { base, wsBase, aaiInstances } = await start();
    const startRes = await fetch(`${base}/api/session/start`, { method: 'POST' });
    const { session_id, ws_path } = (await startRes.json()) as { session_id: string; ws_path: string };

    const ws = await connect(`${wsBase}${ws_path}`);
    const messages: ServerEvent[] = [];
    const timestamps: number[] = [];
    ws.on('message', (data) => {
      messages.push(JSON.parse(data.toString()) as ServerEvent);
      timestamps.push(Date.now());
    });
    ws.send(JSON.stringify({ type: 'start' }));
    await new Promise((resolve) => setTimeout(resolve, 30));

    const aai = aaiInstances.get(session_id)!;
    // Fire a burst of user transcripts well within one 66ms throttle window -- each one
    // changes the conversation log and would otherwise trigger its own `state` send.
    for (let i = 0; i < 10; i++) {
      aai.emit({ type: 'transcript.user', item_id: `burst-${i}`, text: `hello ${i}` });
    }

    await new Promise((resolve) => setTimeout(resolve, 200));

    const stateEvents = messages.filter((m) => m.type === 'state');
    // Everything fired inside one throttle window: at most 2 sends (one immediate leading
    // send, one trailing coalesced flush) -- never one per burst event.
    expect(stateEvents.length).toBeLessThanOrEqual(2);
    expect(stateEvents.length).toBeGreaterThanOrEqual(1);

    ws.close();
  });

  it('releases the caps slot when the browser socket closes', async () => {
    const { base, wsBase, state } = await start();
    const startRes = await fetch(`${base}/api/session/start`, { method: 'POST' });
    const { session_id, ws_path } = (await startRes.json()) as { session_id: string; ws_path: string };
    expect(state.active.has(session_id)).toBe(true);

    const ws = await connect(`${wsBase}${ws_path}`);
    ws.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(state.active.has(session_id)).toBe(false);
  });
});
