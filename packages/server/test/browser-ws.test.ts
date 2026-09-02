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
    browser_grace_ms: 20000,
    ...overrides,
  };
}

describe('ws/browser — /ws/call/:id', () => {
  let closers: (() => Promise<void>)[] = [];

  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
  });

  async function start(opts: { browser_grace_ms?: number } = {}): Promise<{
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
      ...(opts.browser_grace_ms !== undefined ? { browser_grace_ms: opts.browser_grace_ms } : {}),
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

  /** Attaches the message collector in the SAME tick as the socket is constructed, before
   *  `open` fires -- a reattach can have the server writing its replay (link:restored, the
   *  latest state, buffered audio) the instant the connection completes, so collecting only
   *  starts from `await connect()`'s resolution (like the other tests here, which never race
   *  because the server has nothing to say until they send `start`) would lose it. */
  function connectAndCollect(url: string): Promise<{ ws: WebSocket; messages: ServerEvent[] }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const messages: ServerEvent[] = [];
      ws.on('message', (data) => messages.push(JSON.parse(data.toString()) as ServerEvent));
      ws.once('open', () => resolve({ ws, messages }));
      ws.once('error', reject);
    });
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

  it('keeps the caps slot (and the session alive) during the grace window after the browser socket closes', async () => {
    const { base, wsBase, state } = await start({ browser_grace_ms: 500 });
    const startRes = await fetch(`${base}/api/session/start`, { method: 'POST' });
    const { session_id, ws_path } = (await startRes.json()) as { session_id: string; ws_path: string };
    expect(state.active.has(session_id)).toBe(true);

    const ws = await connect(`${wsBase}${ws_path}`);
    ws.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Well within the 500ms grace window: the slot is still taken -- a browser drop does not
    // end the call (the AssemblyAI session and the evidence live on the server).
    expect(state.active.has(session_id)).toBe(true);
  });

  it('ends the session and frees the caps slot once the grace window expires with no reattach', async () => {
    const { base, wsBase, state } = await start({ browser_grace_ms: 150 });
    const startRes = await fetch(`${base}/api/session/start`, { method: 'POST' });
    const { session_id, ws_path } = (await startRes.json()) as { session_id: string; ws_path: string };

    const ws = await connect(`${wsBase}${ws_path}`);
    ws.close();
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(state.active.has(session_id)).toBe(false);
  });

  it('a reattach within the grace window receives link:restored then the latest state, and the call keeps running', async () => {
    const { base, wsBase, state, aaiInstances } = await start({ browser_grace_ms: 2000 });
    const startRes = await fetch(`${base}/api/session/start`, { method: 'POST' });
    const { session_id, ws_path } = (await startRes.json()) as { session_id: string; ws_path: string };

    const ws1 = await connect(`${wsBase}${ws_path}`);
    ws1.send(JSON.stringify({ type: 'start' }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    ws1.close();
    await new Promise((resolve) => setTimeout(resolve, 30));

    // Still within grace: slot held, session alive.
    expect(state.active.has(session_id)).toBe(true);

    const { ws: ws2, messages } = await connectAndCollect(`${wsBase}${ws_path}`);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(messages[0]).toEqual({ type: 'link', state: 'restored' });
    const stateMsg = messages.find((m) => m.type === 'state');
    expect(stateMsg?.type).toBe('state');
    if (stateMsg?.type === 'state') expect(stateMsg.state.session_id).toBe(session_id);

    // The same underlying call session (and its AAI socket) is still the one that was
    // started before the drop -- a reattach never spins up a second AssemblyAI connection.
    expect(aaiInstances.size).toBe(1);

    // Live events keep flowing to the reattached socket.
    const aai = aaiInstances.get(session_id)!;
    aai.emit({ type: 'transcript.user', item_id: 'after-reattach', text: 'hello again' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(messages.some((m) => m.type === 'state')).toBe(true);

    ws2.close();
  });

  it('refuses a second concurrent attach for the same id with 4409 while the first is still live', async () => {
    const { base, wsBase } = await start();
    const startRes = await fetch(`${base}/api/session/start`, { method: 'POST' });
    const { ws_path } = (await startRes.json()) as { session_id: string; ws_path: string };

    const ws1 = await connect(`${wsBase}${ws_path}`);
    const ws2 = new WebSocket(`${wsBase}${ws_path}`);
    const closeCode = await new Promise<number>((resolve) => {
      ws2.once('close', (code) => resolve(code));
    });

    expect(closeCode).toBe(4409);
    ws1.close();
  });
});
