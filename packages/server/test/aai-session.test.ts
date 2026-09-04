// packages/server/test/aai-session.test.ts
// Drives `connectAai` against a scripted fake `WebSocketImpl` (never a real socket, never
// the network -- LAW: tests never call the live API). Covers: the connect URL carries the
// minted token, session.update is the first message sent, session.ready resolves the
// connect promise, every mapped event shape, input.audio framing, the resume-on-drop path
// (a fresh token, a new socket, session.resume with the prior session_id, and the `link`
// lost/restored events the screen uses for "voice link lost, security state preserved"),
// the bounded give-up path (`session.ended` reason `link_lost`), and `stats()`.
//
// Live voice-id validation (KNOWN_VOICES / resolveVoice) is a pure, synchronous table
// lookup in src/aai/config.ts as of round 3 (docs/aai-voices-endpoint-2026-09-02.md: GET
// /v1/voices returns HTTP 426, does not exist) -- tested there, not here.
import { describe, it, expect, vi } from 'vitest';
import { connectAai, type AaiConnectDeps, type WsLike } from '../src/aai/session.js';
import type { AaiSessionConfig } from '../src/aai/config.js';
import type { AaiEvent } from '../src/aai/types.js';

type Listener = (...args: unknown[]) => void;

class FakeWs implements WsLike {
  readonly url: string;
  readonly sent: string[] = [];
  readonly listeners: Record<string, Listener[]> = {};
  closed = false;

  constructor(url: string) {
    this.url = url;
  }

  on(event: string, cb: Listener): void {
    (this.listeners[event] ??= []).push(cb);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  triggerOpen(): void {
    for (const cb of this.listeners.open ?? []) cb();
  }

  triggerMessage(payload: unknown): void {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    for (const cb of this.listeners.message ?? []) cb(data);
  }

  triggerClose(code: number, reason = ''): void {
    for (const cb of this.listeners.close ?? []) cb(code, reason);
  }
}

function makeDeps(tokens: string[] = ['tok-1', 'tok-2', 'tok-3', 'tok-4', 'tok-5']) {
  const sockets: FakeWs[] = [];
  let tokenIdx = 0;
  const fetchImpl = vi.fn(async () => {
    const token = tokens[Math.min(tokenIdx, tokens.length - 1)]!;
    tokenIdx += 1;
    return new Response(JSON.stringify({ token, expires_in_seconds: 60 }), { status: 200 });
  });
  const WebSocketImpl = vi.fn((url: string) => {
    const sock = new FakeWs(url);
    sockets.push(sock);
    return sock;
  }) as unknown as new (url: string) => WsLike;
  const deps: AaiConnectDeps = {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    WebSocketImpl,
    now: () => 0,
    // The bounded-resume backoff (500ms/1500ms/3000ms) is real-timer based in production;
    // tests inject a no-op so waiting on it doesn't make the suite slow. Tests that care
    // about backoff/window timing override `now` (and keep this no-op) rather than waiting
    // on real delays.
    sleep: async () => {},
  };
  return { deps, sockets, fetchImpl };
}

function cfg(overrides: Partial<AaiSessionConfig> = {}): AaiSessionConfig {
  return {
    assemblyai_api_key: 'secret-key',
    session_cap_seconds: 300,
    voice: 'alba',
    system_prompt: 'be calm',
    tools: [],
    keyterms: ['Meridian Dynamics'],
    ...overrides,
  };
}

async function waitFor(check: () => void): Promise<void> {
  await vi.waitFor(check, { timeout: 1000, interval: 5 });
}

/** Connects and completes the ready handshake on `sockets[0]`, returning the resolved
 *  socket -- the shared setup every test after the first one needs. */
async function connectAndReady(deps: AaiConnectDeps, sockets: FakeWs[], sessionId = 'sess-1') {
  const connectPromise = connectAai(cfg(), deps);
  await waitFor(() => expect(sockets.length).toBe(1));
  sockets[0]!.triggerOpen();
  await waitFor(() => expect(sockets[0]!.sent.length).toBe(1));
  sockets[0]!.triggerMessage({ type: 'session.ready', session_id: sessionId });
  return connectPromise;
}

describe('connectAai', () => {
  it('opens the socket with the minted token in the URL and sends session.update as the first message', async () => {
    const { deps, sockets } = makeDeps();
    const connectPromise = connectAai(cfg(), deps);

    await waitFor(() => expect(sockets.length).toBe(1));
    expect(sockets[0]!.url).toBe('wss://agents.assemblyai.com/v1/ws?token=tok-1');

    sockets[0]!.triggerOpen();
    await waitFor(() => expect(sockets[0]!.sent.length).toBe(1));
    const firstMsg = JSON.parse(sockets[0]!.sent[0]!);
    expect(firstMsg.type).toBe('session.update');

    sockets[0]!.triggerMessage({ type: 'session.ready', session_id: 'sess-1' });
    const aai = await connectPromise;
    expect(aai).toBeTruthy();
  });

  it('resolves only once session.ready arrives, not merely on socket open', async () => {
    const { deps, sockets } = makeDeps();
    let resolved = false;
    const connectPromise = connectAai(cfg(), deps).then((aai) => {
      resolved = true;
      return aai;
    });

    await waitFor(() => expect(sockets.length).toBe(1));
    sockets[0]!.triggerOpen();
    await waitFor(() => expect(sockets[0]!.sent.length).toBe(1));
    // Deterministic, not a timed guess: `sent.length` becomes 1 in the SAME synchronous
    // continuation (right after `await openSocket` resolves in session.ts) that then
    // registers the `message` listener connectAai's returned promise resolves from -- so by
    // this point that listener is already registered, and `resolved` can only flip to true
    // via an explicit `triggerMessage` call, which we have not made yet. No real wait is
    // needed to prove it's still false.
    expect(resolved).toBe(false);

    sockets[0]!.triggerMessage({ type: 'session.ready', session_id: 'sess-1' });
    await connectPromise;
    expect(resolved).toBe(true);
  });

  // Bug fix (2026-09-03, founder-observed live): the server-side flight recorder could never
  // answer "when did AssemblyAI become ready" for a real call -- `connectAai` itself consumes
  // the `session.ready` message while resolving its connect promise, before the RealAaiSocket
  // (and therefore `call/session.ts`'s own event dispatch) exists, so no `session.ready`
  // AaiEvent is ever emitted for a real adapter. `deps.onReady` is the fix: called once,
  // right here, with the elapsed ms from `connectAai`'s own entry to the moment
  // `session.ready` actually arrived -- index.ts wires it straight into the flight recorder.
  it('calls deps.onReady once, with the elapsed ms from connect start to session.ready, and never before session.ready arrives', async () => {
    const { deps, sockets } = makeDeps();
    let clock = 0;
    deps.now = () => clock;
    const readyCalls: number[] = [];
    deps.onReady = (ms) => readyCalls.push(ms);

    const connectPromise = connectAai(cfg(), deps);
    await waitFor(() => expect(sockets.length).toBe(1));
    clock = 40;
    sockets[0]!.triggerOpen();
    await waitFor(() => expect(sockets[0]!.sent.length).toBe(1));

    expect(readyCalls).toHaveLength(0); // not yet -- session.ready hasn't arrived

    clock = 137;
    sockets[0]!.triggerMessage({ type: 'session.ready', session_id: 'sess-1' });
    await connectPromise;

    expect(readyCalls).toEqual([137]);
  });

  it('maps transcript, reply, tool.call and session.error events onto AaiEvent', async () => {
    const { deps, sockets } = makeDeps();
    const aai = await connectAndReady(deps, sockets);

    const received: AaiEvent[] = [];
    aai.on((evt) => received.push(evt));

    sockets[0]!.triggerMessage({ type: 'transcript.user', item_id: 'u1', text: 'This is Robert Miller' });
    sockets[0]!.triggerMessage({
      type: 'transcript.agent',
      item_id: 'a1',
      reply_id: 'r1',
      text: 'Confirming.',
      interrupted: true,
    });
    sockets[0]!.triggerMessage({ type: 'reply.audio', data: 'QkFTRTY0' });
    sockets[0]!.triggerMessage({ type: 'reply.done', reply_id: 'r1', status: 'interrupted' });
    sockets[0]!.triggerMessage({
      type: 'tool.call',
      call_id: 'c1',
      name: 'check_sso_context',
      arguments: { identity_id: 'id-1' },
    });
    sockets[0]!.triggerMessage({ type: 'session.error', code: 'bad_request', message: 'nope' });
    // an event type this adapter does not model -- must be dropped, not thrown on
    sockets[0]!.triggerMessage({ type: 'transcript.agent.delta', reply_id: 'r1', delta: 'Conf' });

    expect(received).toEqual([
      { type: 'transcript.user', item_id: 'u1', text: 'This is Robert Miller' },
      { type: 'transcript.agent', item_id: 'a1', text: 'Confirming.', reply_id: 'r1', interrupted: true },
      { type: 'reply.audio', data: 'QkFTRTY0' },
      { type: 'reply.done', reply_id: 'r1', status: 'interrupted' },
      { type: 'tool.call', call_id: 'c1', name: 'check_sso_context', arguments: { identity_id: 'id-1' } },
      { type: 'session.error', code: 'bad_request', message: 'nope' },
    ]);
  });

  it('frames input.audio, session.update, tool.result and session.end sends verbatim', async () => {
    const { deps, sockets } = makeDeps();
    const aai = await connectAndReady(deps, sockets);
    const sock = sockets[0]!;
    const before = sock.sent.length;

    aai.send({ type: 'input.audio', audio: 'AAAA' });
    aai.send({ type: 'tool.result', call_id: 'c1', result: '{"ok":true}', is_error: false });

    await waitFor(() => expect(sock.sent.length).toBe(before + 2));
    expect(JSON.parse(sock.sent[before]!)).toEqual({ type: 'input.audio', audio: 'AAAA' });
    expect(JSON.parse(sock.sent[before + 1]!)).toEqual({
      type: 'tool.result',
      call_id: 'c1',
      result: '{"ok":true}',
      is_error: false,
    });
  });

  it('resumes with a fresh token and session.resume on an unexpected close within the window', async () => {
    const { deps, sockets } = makeDeps();
    const aai = await connectAndReady(deps, sockets, 'sess-1');

    const received: AaiEvent[] = [];
    aai.on((evt) => received.push(evt));

    sockets[0]!.triggerClose(1006, 'abnormal');
    expect(received).toContainEqual({ type: 'link', state: 'lost', attempt: 1 });

    await waitFor(() => expect(sockets.length).toBe(2));
    expect(sockets[1]!.url).toBe('wss://agents.assemblyai.com/v1/ws?token=tok-2');

    sockets[1]!.triggerOpen();
    await waitFor(() => expect(sockets[1]!.sent.length).toBe(1));
    expect(JSON.parse(sockets[1]!.sent[0]!)).toEqual({ type: 'session.resume', session_id: 'sess-1' });

    await waitFor(() => expect(received).toContainEqual({ type: 'link', state: 'restored', attempt: 1 }));
  });

  it('does not attempt a resume on a close the caller itself requested', async () => {
    const { deps, sockets } = makeDeps();
    const aai = await connectAndReady(deps, sockets, 'sess-1');

    const received: AaiEvent[] = [];
    aai.on((evt) => received.push(evt));

    aai.close();
    sockets[0]!.triggerClose(1000, 'normal');

    // Deterministic, not a timed guess: `aai.close()` sets `expectClose` synchronously before
    // `triggerClose` runs, and `FakeWs.triggerClose` invokes the wired close handler
    // synchronously (no microtask in between, unlike a real socket) -- the `expectClose` guard
    // in session.ts's `wire()` returns immediately without ever starting
    // `handleUnexpectedClose`, so by the time `triggerClose` returns, no resume attempt could
    // have been made or started. No real wait is needed to prove it.
    expect(sockets.length).toBe(1);
    expect(received).not.toContainEqual({ type: 'link', state: 'lost', attempt: 1 });
  });

  it('maps a real AssemblyAI-originated session.ended (no reason) and sends session.end verbatim on close()', async () => {
    const { deps, sockets } = makeDeps();
    const aai = await connectAndReady(deps, sockets, 'sess-1');

    const received: AaiEvent[] = [];
    aai.on((evt) => received.push(evt));

    sockets[0]!.triggerMessage({ type: 'session.ended' });
    expect(received).toContainEqual({ type: 'session.ended' });

    const before = sockets[0]!.sent.length;
    aai.close();
    expect(JSON.parse(sockets[0]!.sent[before]!)).toEqual({ type: 'session.end' });
  });

  it('rejects if the socket never opens within the open timeout', async () => {
    const { deps, sockets } = makeDeps();
    const fastDeps: AaiConnectDeps = { ...deps, openTimeoutMs: 20 };

    await expect(connectAai(cfg(), fastDeps)).rejects.toThrow(/timed out waiting for open/);
    await waitFor(() => expect(sockets.length).toBe(1)); // it did try to open one socket
  });

  it('caps resume attempts at 3 for the life of the call, then gives up with session.ended reason link_lost and mints no further tokens', async () => {
    const { deps, sockets, fetchImpl } = makeDeps();
    const aai = await connectAndReady(deps, sockets, 'sess-1');

    const received: AaiEvent[] = [];
    aai.on((evt) => received.push(evt));

    // attempt 1: succeeds
    sockets[0]!.triggerClose(1006);
    await waitFor(() => expect(sockets.length).toBe(2));
    sockets[1]!.triggerOpen();
    await waitFor(() => expect(sockets[1]!.sent.length).toBe(1));
    await waitFor(() => expect(received).toContainEqual({ type: 'link', state: 'restored', attempt: 1 }));

    // attempt 2: succeeds
    sockets[1]!.triggerClose(1006);
    await waitFor(() => expect(sockets.length).toBe(3));
    sockets[2]!.triggerOpen();
    await waitFor(() => expect(sockets[2]!.sent.length).toBe(1));
    await waitFor(() => expect(received).toContainEqual({ type: 'link', state: 'restored', attempt: 2 }));

    // attempt 3: succeeds -- this is the last one the cap allows
    sockets[2]!.triggerClose(1006);
    await waitFor(() => expect(sockets.length).toBe(4));
    sockets[3]!.triggerOpen();
    await waitFor(() => expect(sockets[3]!.sent.length).toBe(1));
    await waitFor(() => expect(received).toContainEqual({ type: 'link', state: 'restored', attempt: 3 }));

    const mintCallsSoFar = fetchImpl.mock.calls.length;

    // attempt 4: the cap is exhausted -- must give up without minting again or opening a 5th socket
    sockets[3]!.triggerClose(1006);
    await waitFor(() => expect(received).toContainEqual({ type: 'session.ended', reason: 'link_lost' }));
    expect(fetchImpl.mock.calls.length).toBe(mintCallsSoFar);
    expect(sockets.length).toBe(4);
  });

  it('gives up with session.ended reason link_lost, minting no new token, once the 30s resumable window has passed', async () => {
    const { deps, sockets, fetchImpl } = makeDeps();
    let t = 0;
    const controlledDeps: AaiConnectDeps = { ...deps, now: () => t };
    const aai = await connectAndReady(controlledDeps, sockets, 'sess-1');

    const received: AaiEvent[] = [];
    aai.on((evt) => received.push(evt));
    const mintCallsBeforeDrop = fetchImpl.mock.calls.length;

    sockets[0]!.triggerClose(1006); // t is 0 at the moment of the drop
    t = 31_000; // advance the clock past the 30s window while the (no-op) backoff is "pending"

    await waitFor(() => expect(received).toContainEqual({ type: 'session.ended', reason: 'link_lost' }));
    expect(fetchImpl.mock.calls.length).toBe(mintCallsBeforeDrop); // no resume mint was ever attempted
    expect(sockets.length).toBe(1); // no second socket was ever opened
  });

  it('stats() reports server messages this adapter does not model', async () => {
    const { deps, sockets } = makeDeps();
    const aai = await connectAndReady(deps, sockets, 'sess-1');

    expect(aai.stats?.()).toEqual({ unknown_events: 0 });

    sockets[0]!.triggerMessage({ type: 'transcript.agent.delta', reply_id: 'r1', delta: 'hi' });
    sockets[0]!.triggerMessage({ type: 'session.updated' });

    expect(aai.stats?.()).toEqual({ unknown_events: 2 });
  });
});
