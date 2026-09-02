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

  async function start(opts: { browser_grace_ms?: number; session_cap_seconds?: number } = {}): Promise<{
    base: string;
    wsBase: string;
    state: CapsState;
    aaiInstances: Map<string, FakeAaiSocket>;
    endCall: (session_id: string, reason: string) => boolean;
  }> {
    const ids = ['id-1', 'id-2', 'id-3'];
    let counter = 0;
    const aaiInstances = new Map<string, FakeAaiSocket>();

    const { server, state } = createHttpServer(cfg(), {
      fetchImpl: globalThis.fetch,
      now: () => Date.now(),
      randomId: () => ids[counter++] ?? `id-${counter}`,
      // These tests exercise `endCall` directly (returned by `attachWebSocketServer` below,
      // captured into `wsApi` after both are constructed) rather than through http.ts's
      // routes -- http.test.ts already covers the http.ts side of the CRITICAL 1 wiring.
      endCall: (id, reason) => wsApi.endCall(id, reason),
    });

    const wsApi = attachWebSocketServer(server, {
      caps: state,
      now: () => Date.now(),
      createAai: (session_id) => {
        const aai = new FakeAaiSocket();
        aaiInstances.set(session_id, aai);
        return aai;
      },
      ...(opts.browser_grace_ms !== undefined ? { browser_grace_ms: opts.browser_grace_ms } : {}),
      ...(opts.session_cap_seconds !== undefined ? { session_cap_seconds: opts.session_cap_seconds } : {}),
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

    return {
      base: `http://127.0.0.1:${addr.port}`,
      wsBase: `ws://127.0.0.1:${addr.port}`,
      state,
      aaiInstances,
      endCall: wsApi.endCall,
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

  /** Finding 5 (final review): replaces a fixed `setTimeout(resolve, N)` guess with an actual
   *  wait on the condition the test cares about -- a real socket/timer integration test still
   *  needs SOME real wait (there is no fake-timer story for a live `ws`/`http` server), but a
   *  fixed guess is either too short (flaky under load) or wastefully long; polling converges
   *  the instant the condition is true and only times out (loudly, not silently) if it never
   *  is. Never shorter than the real thing it's waiting on -- `stepMs` is a poll interval, not
   *  a substitute deadline. */
  async function pollUntil(cond: () => boolean, timeoutMs = 3000, stepMs = 5): Promise<void> {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`pollUntil: condition still false after ${timeoutMs}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, stepMs));
    }
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

    await pollUntil(() => messages.some((m) => m.type === 'state'));

    expect(aaiInstances.has(session_id)).toBe(true);
    expect(messages.some((m) => m.type === 'state')).toBe(true);
    const stateMsg = messages.find((m) => m.type === 'state');
    if (stateMsg?.type === 'state') {
      expect(stateMsg.state.session_id).toBe(session_id);
      expect(stateMsg.state.link).toBe('live');
    }

    ws.close();
  });

  it('throttles rapid state updates to fewer sends than updates (exact per-window timing is unit-tested in throttle.test.ts with fake timers)', async () => {
    // The EXACT throttle timing (leading-edge send, one trailing coalesced flush at the
    // window boundary, latest-state-wins) is proven deterministically in
    // packages/server/test/throttle.test.ts against the pure `makeThrottle` function using
    // vitest fake timers -- no real clock involved, so no flakiness under load. This test
    // stays a real socket/timer integration test, but only asserts the timing-INSENSITIVE
    // fact that end-to-end wiring (browser.ts's `makeThrottledSender` actually calls into the
    // throttle for `state` events): a burst of state-changing updates produces strictly fewer
    // `state` sends than updates, never one send per update. That is true for ANY throttle
    // window that fires more slowly than the burst, so it can't flake on timing the way an
    // exact upper/lower bound over a fixed real wait could.
    const { base, wsBase, aaiInstances } = await start();
    const startRes = await fetch(`${base}/api/session/start`, { method: 'POST' });
    const { session_id, ws_path } = (await startRes.json()) as { session_id: string; ws_path: string };

    const { ws, messages } = await connectAndCollect(`${wsBase}${ws_path}`);
    ws.send(JSON.stringify({ type: 'start' }));
    await pollUntil(() => messages.some((m) => m.type === 'state'));

    const aai = aaiInstances.get(session_id)!;
    const stateCountBeforeBurst = messages.filter((m) => m.type === 'state').length;
    const burstSize = 10;
    // Fire a burst of user transcripts well within one 66ms throttle window -- each one
    // changes the conversation log and would otherwise trigger its own `state` send.
    for (let i = 0; i < burstSize; i++) {
      aai.emit({ type: 'transcript.user', item_id: `burst-${i}`, text: `hello ${i}` });
    }

    try {
      // Give the throttle's trailing flush (and the socket) time to deliver whatever it's
      // going to send -- generous on purpose (this is a "let it settle" wait, not a
      // boundary-proving one, so being longer than strictly necessary costs nothing).
      await new Promise((resolve) => setTimeout(resolve, 300));

      const stateEventsAfterBurst = messages.filter((m) => m.type === 'state').length - stateCountBeforeBurst;
      // Never one send per burst event -- strictly fewer sends than updates. (The exact
      // bound of "at most 2" lives in throttle.test.ts, proven with fake timers.)
      expect(stateEventsAfterBurst).toBeLessThan(burstSize);
      expect(stateEventsAfterBurst).toBeGreaterThanOrEqual(1);
    } finally {
      // Finding 5 (final review): cleanup runs even if the assertion above throws -- an
      // uncleaned socket left open after a failed assertion is what turned one flaky
      // assertion into a cascading 10s `afterEach` hook timeout on the NEXT test too.
      ws.close();
    }
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
    await pollUntil(() => !state.active.has(session_id));

    expect(state.active.has(session_id)).toBe(false);
  });

  it('a reattach within the grace window receives link:restored then the latest state, and the call keeps running', async () => {
    const { base, wsBase, state, aaiInstances } = await start({ browser_grace_ms: 2000 });
    const startRes = await fetch(`${base}/api/session/start`, { method: 'POST' });
    const { session_id, ws_path } = (await startRes.json()) as { session_id: string; ws_path: string };

    const { ws: ws1, messages: messages1 } = await connectAndCollect(`${wsBase}${ws_path}`);
    ws1.send(JSON.stringify({ type: 'start' }));
    await pollUntil(() => messages1.some((m) => m.type === 'state'));
    ws1.close();
    // No externally observable condition distinguishes "the server has processed this
    // socket's close (and entered the grace window)" from "still attached" -- `state.active`
    // reads true in both. A short real wait for the close to propagate is the only option
    // here (same as before this fix); 40ms is generous for a same-machine loopback close.
    await new Promise((resolve) => setTimeout(resolve, 40));

    // Still within grace: slot held, session alive.
    expect(state.active.has(session_id)).toBe(true);

    const { ws: ws2, messages } = await connectAndCollect(`${wsBase}${ws_path}`);
    await pollUntil(() => messages.some((m) => m.type === 'state'));

    expect(messages[0]).toEqual({ type: 'link', state: 'restored', leg: 'browser' });
    const stateMsg = messages.find((m) => m.type === 'state');
    expect(stateMsg?.type).toBe('state');
    if (stateMsg?.type === 'state') expect(stateMsg.state.session_id).toBe(session_id);

    // The same underlying call session (and its AAI socket) is still the one that was
    // started before the drop -- a reattach never spins up a second AssemblyAI connection.
    expect(aaiInstances.size).toBe(1);

    // Live events keep flowing to the reattached socket.
    const aai = aaiInstances.get(session_id)!;
    const stateCountBefore = messages.filter((m) => m.type === 'state').length;
    aai.emit({ type: 'transcript.user', item_id: 'after-reattach', text: 'hello again' });
    await pollUntil(() => messages.filter((m) => m.type === 'state').length > stateCountBefore);
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

  it('CRITICAL 1 (final review): endCall ends a LIVE call -- the browser gets `ended`, its socket closes, and the caps slot frees', async () => {
    const { base, wsBase, state, endCall } = await start();
    const startRes = await fetch(`${base}/api/session/start`, { method: 'POST' });
    const { session_id, ws_path } = (await startRes.json()) as { session_id: string; ws_path: string };

    const { ws, messages } = await connectAndCollect(`${wsBase}${ws_path}`);
    ws.send(JSON.stringify({ type: 'start' }));
    await pollUntil(() => messages.some((m) => m.type === 'state'));

    const closeCode = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));

    // Simulates what index.ts's idle reaper does with `reapIdle`'s returned ids -- this is
    // the exact bug CRITICAL 1 fixed: previously only `CapsState` was touched, and the live
    // `CallSession` (and its AAI socket, and the attached browser socket) kept right on
    // running past the reason it was supposed to end for.
    const ended = endCall(session_id, 'idle_timeout');
    expect(ended).toBe(true);

    await pollUntil(() => messages.some((m) => m.type === 'ended'));
    expect(messages.find((m) => m.type === 'ended')).toEqual({ type: 'ended', reason: 'idle_timeout' });
    // The browser socket itself is closed by `endCall`, not left dangling for the client to
    // notice on its own.
    await closeCode;
    expect(state.active.has(session_id)).toBe(false);

    // A second call is a no-op, not an error -- the call already ended.
    expect(endCall(session_id, 'idle_timeout')).toBe(false);
  });

  it('CRITICAL 1 (final review): endCall on an id that only ever held a caps reservation (never attached a socket) still frees the slot', async () => {
    const { base, state, endCall } = await start();
    const startRes = await fetch(`${base}/api/session/start`, { method: 'POST' });
    const { session_id } = (await startRes.json()) as { session_id: string; ws_path: string };
    expect(state.active.has(session_id)).toBe(true);

    expect(endCall(session_id, 'reset')).toBe(true);
    expect(state.active.has(session_id)).toBe(false);

    // Unknown id entirely: no-op, not an error.
    expect(endCall('never-existed', 'reset')).toBe(false);
  });

  it('CRITICAL 1 (final review): the per-call cap timer ends a live call with reason cap_reached once its total time is up', async () => {
    // 60ms cap -- short enough for a fast real-timer test, long enough to reliably outlast
    // the initial connect/start handshake above it.
    const { base, wsBase, state } = await start({ session_cap_seconds: 0.06 });
    const startRes = await fetch(`${base}/api/session/start`, { method: 'POST' });
    const { session_id, ws_path } = (await startRes.json()) as { session_id: string; ws_path: string };

    const { ws, messages } = await connectAndCollect(`${wsBase}${ws_path}`);
    ws.send(JSON.stringify({ type: 'start' }));

    await pollUntil(() => messages.some((m) => m.type === 'ended'));
    expect(messages.find((m) => m.type === 'ended')).toEqual({ type: 'ended', reason: 'cap_reached' });
    expect(state.active.has(session_id)).toBe(false);
  });

  it('IMPORTANT 2 (final review): an AAI-leg link event forwards to the browser tagged leg:"aai" (distinct from a browser-leg reattach\'s leg:"browser")', async () => {
    const { base, wsBase, aaiInstances } = await start({ browser_grace_ms: 2000 });
    const startRes = await fetch(`${base}/api/session/start`, { method: 'POST' });
    const { session_id, ws_path } = (await startRes.json()) as { session_id: string; ws_path: string };

    const { ws, messages } = await connectAndCollect(`${wsBase}${ws_path}`);
    ws.send(JSON.stringify({ type: 'start' }));
    await pollUntil(() => messages.some((m) => m.type === 'state'));

    const aai = aaiInstances.get(session_id)!;
    aai.emit({ type: 'link', state: 'lost', attempt: 1 });
    await pollUntil(() => messages.some((m) => m.type === 'link'));

    expect(messages.find((m) => m.type === 'link')).toEqual({ type: 'link', state: 'lost', leg: 'aai' });

    ws.close();
  });
});
