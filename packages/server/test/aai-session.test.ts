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

  /** Debug-hook counterpart to `close()` -- an abrupt teardown with no closing handshake,
   *  matching what the real `ws` package's `WebSocket#terminate()` does: the peer sees an
   *  unsolicited close (code 1006), same as `triggerClose(1006, ...)` below simulates for a
   *  genuine network drop. */
  terminate(): void {
    this.closed = true;
    this.triggerClose(1006, 'terminated');
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
    const readyCalls: [number, boolean][] = [];
    deps.onReady = (ms, greeting_configured) => readyCalls.push([ms, greeting_configured]);

    const connectPromise = connectAai(cfg(), deps);
    await waitFor(() => expect(sockets.length).toBe(1));
    clock = 40;
    sockets[0]!.triggerOpen();
    await waitFor(() => expect(sockets[0]!.sent.length).toBe(1));

    expect(readyCalls).toHaveLength(0); // not yet -- session.ready hasn't arrived

    clock = 137;
    sockets[0]!.triggerMessage({ type: 'session.ready', session_id: 'sess-1' });
    await connectPromise;

    // Second element is `greeting_configured` -- false here because `cfg()` (no override)
    // carries no greeting, same as this file's other tests. See the next test for the
    // true case.
    expect(readyCalls).toEqual([[137, false]]);
  });

  // Founder ruling 2026-09-11: the flight recorder's raw bundle must be able to prove
  // whether a live call's connect actually asked AssemblyAI to speak first -- this is the
  // `greeting_configured` half of that proof (index.ts logs it on the `aai_ready` diag
  // event; this test proves `connectAai` computes it correctly from the connect config).
  it('reports greeting_configured true to onReady when the connect config carries a greeting', async () => {
    const { deps, sockets } = makeDeps();
    const readyCalls: [number, boolean][] = [];
    deps.onReady = (ms, greeting_configured) => readyCalls.push([ms, greeting_configured]);

    const connectPromise = connectAai(cfg({ greeting: 'Meridian payments desk, verification line. How can I help you today?' }), deps);
    await waitFor(() => expect(sockets.length).toBe(1));
    sockets[0]!.triggerOpen();
    await waitFor(() => expect(sockets[0]!.sent.length).toBe(1));
    sockets[0]!.triggerMessage({ type: 'session.ready', session_id: 'sess-1' });
    await connectPromise;

    expect(readyCalls).toHaveLength(1);
    expect(readyCalls[0]![1]).toBe(true);
  });

  // TURN-DETECTION-RESTORE-EXPLICIT-CONFIG (2026-09-19): `onReady`'s third argument must be
  // the EXACT `turn_detection` object this connect's initial session.update put on the
  // wire, read back off the built message rather than recomputed -- so index.ts's
  // `aai_ready` diag can prove what was actually sent (see aai/config.ts's
  // `buildInitialSessionUpdate` for the documented defaults).
  it('reports the exact turn_detection object sent on connect as onReady\'s third argument', async () => {
    const { deps, sockets } = makeDeps();
    const readyCalls: Record<string, unknown>[] = [];
    deps.onReady = (_ms, _greeting_configured, turn_detection_sent) => readyCalls.push(turn_detection_sent);

    const connectPromise = connectAai(cfg(), deps);
    await waitFor(() => expect(sockets.length).toBe(1));
    sockets[0]!.triggerOpen();
    await waitFor(() => expect(sockets[0]!.sent.length).toBe(1));
    sockets[0]!.triggerMessage({ type: 'session.ready', session_id: 'sess-1' });
    await connectPromise;

    expect(readyCalls).toEqual([{ vad_threshold: 0.5, interrupt_response: true }]);
  });

  it('reports a caller-supplied turn_detection override to onReady exactly as it was sent', async () => {
    const { deps, sockets } = makeDeps();
    const readyCalls: Record<string, unknown>[] = [];
    deps.onReady = (_ms, _greeting_configured, turn_detection_sent) => readyCalls.push(turn_detection_sent);

    const connectPromise = connectAai(cfg({ turn_detection: { min_silence: 1200 } }), deps);
    await waitFor(() => expect(sockets.length).toBe(1));
    sockets[0]!.triggerOpen();
    await waitFor(() => expect(sockets[0]!.sent.length).toBe(1));
    sockets[0]!.triggerMessage({ type: 'session.ready', session_id: 'sess-1' });
    await connectPromise;

    expect(readyCalls).toEqual([{ vad_threshold: 0.5, interrupt_response: true, min_silence: 1200 }]);
  });

  // Founder ruling 2026-09-11 (agent speaks first): AssemblyAI treats `greeting` as
  // immutable after session.ready -- "changing them returns immutable_field"
  // (docs/aai-verify-2026-09-02.md). This proves the resume path structurally cannot
  // violate that: on an unexpected drop, `handleUnexpectedClose` (src/aai/session.ts,
  // the `ws.send(JSON.stringify({ type: 'session.resume', session_id: sessionId }))` line)
  // sends session.resume alone, never `buildInitialSessionUpdate`'s greeting field, even
  // when the connect config that started the call carried one.
  it('never resends the greeting on session.resume after a drop, even when the connect config carries one', async () => {
    const { deps, sockets } = makeDeps();
    const greeting = 'Meridian payments desk, verification line. How can I help you today?';
    const connectPromise = connectAai(cfg({ greeting }), deps);
    await waitFor(() => expect(sockets.length).toBe(1));
    sockets[0]!.triggerOpen();
    await waitFor(() => expect(sockets[0]!.sent.length).toBe(1));
    const firstMsg = JSON.parse(sockets[0]!.sent[0]!);
    expect(firstMsg.session.greeting).toBe(greeting);
    sockets[0]!.triggerMessage({ type: 'session.ready', session_id: 'sess-1' });
    await connectPromise;

    sockets[0]!.triggerClose(1006, 'abnormal');
    await waitFor(() => expect(sockets.length).toBe(2));
    sockets[1]!.triggerOpen();
    await waitFor(() => expect(sockets[1]!.sent.length).toBe(1));

    const resumeMsg = JSON.parse(sockets[1]!.sent[0]!);
    expect(resumeMsg).toEqual({ type: 'session.resume', session_id: 'sess-1' });
    expect(resumeMsg).not.toHaveProperty('greeting');
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

  // Rehearsal-harness debug hook (judge-sim finding 2026-09-11: "zero AssemblyAI socket
  // drops occurred" across three live bundles -- session.resume had never actually been
  // exercised on a live call). `debugForceDrop()` must take the SAME code path a real
  // network drop does (`handleUnexpectedClose`, proven above via `triggerClose(1006, ...)`),
  // not a separately-faked `link`/`session.resume` pair that would prove nothing about the
  // real resume logic.
  it('debugForceDrop() terminates the socket and runs the real resume-on-drop path', async () => {
    const { deps, sockets } = makeDeps();
    const aai = await connectAndReady(deps, sockets, 'sess-1');

    const received: AaiEvent[] = [];
    aai.on((evt) => received.push(evt));

    expect(aai.debugForceDrop?.()).toBe(true);
    expect(sockets[0]!.closed).toBe(true);
    expect(received).toContainEqual({ type: 'link', state: 'lost', attempt: 1 });

    await waitFor(() => expect(sockets.length).toBe(2));
    expect(sockets[1]!.url).toBe('wss://agents.assemblyai.com/v1/ws?token=tok-2');
    sockets[1]!.triggerOpen();
    await waitFor(() => expect(sockets[1]!.sent.length).toBe(1));
    expect(JSON.parse(sockets[1]!.sent[0]!)).toEqual({ type: 'session.resume', session_id: 'sess-1' });
    await waitFor(() => expect(received).toContainEqual({ type: 'link', state: 'restored', attempt: 1 }));
  });

  it('debugForceDrop() returns false once the socket is already closed', async () => {
    const { deps, sockets } = makeDeps();
    const aai = await connectAndReady(deps, sockets, 'sess-1');
    aai.close();
    expect(aai.debugForceDrop?.()).toBe(false);
  });

  it('second close() is idempotent -- session.end is sent exactly once', async () => {
    // goodbye-tail lane (2026-09-15 review, Minor): `close()` (above) already guards on
    // `this.closed` before sending `session.end` or touching the socket again -- this test
    // makes that idempotency an explicit, executable assertion rather than an unverified
    // property of the source.
    const { deps, sockets } = makeDeps();
    const aai = await connectAndReady(deps, sockets, 'sess-1');

    aai.close();
    const sendsAfterFirstClose = sockets[0]!.sent.filter((m) => JSON.parse(m).type === 'session.end').length;
    expect(sendsAfterFirstClose).toBe(1);

    aai.close();
    const sendsAfterSecondClose = sockets[0]!.sent.filter((m) => JSON.parse(m).type === 'session.end').length;
    expect(sendsAfterSecondClose).toBe(1); // the second close() sent nothing further
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

  // Defect 2 fix (timing-analysis.md §E, PROVEN: `billed_seconds` null on 11/11 live
  // bundles -- close() used to send `session.end` and call `ws.close()` in the same tick,
  // so AssemblyAI's own Termination event could never arrive in time to be read). Now:
  // send `session.end`, wait up to `closeTerminationTimeoutMs` for `session.ended`
  // (resolving early the instant it arrives), THEN close the socket.
  describe('close() waits for AssemblyAI\'s own session.ended Termination event (Defect 2 fix)', () => {
    // (a) session.ended arriving within the window is recorded (emitted to handlers with
    // its billing duration fields) and resolves the wait early -- the socket is NOT closed
    // the instant close() is called, only once that message actually lands. This is the
    // event `call/session.ts`'s existing `case 'session.ended'` already turns into the
    // `aai_session_terminated` diag that feeds `populateBilledSeconds` once it can actually
    // arrive at all.
    it('(a) session.ended arriving after session.end is emitted with its billing durations, and only then closes the socket', async () => {
      const { deps, sockets } = makeDeps();
      const aai = await connectAndReady(deps, sockets, 'sess-1');
      const received: AaiEvent[] = [];
      aai.on((evt) => received.push(evt));

      const sock = sockets[0]!;
      const sentBefore = sock.sent.length;
      const closeResult = aai.close();
      expect(closeResult).toBeUndefined(); // synchronous void, never a Promise -- see (c)

      await waitFor(() => expect(sock.sent.length).toBe(sentBefore + 1));
      expect(JSON.parse(sock.sent[sentBefore]!)).toEqual({ type: 'session.end' });

      // Not closed yet -- still waiting on AssemblyAI's own Termination event, unlike the
      // pre-fix behavior (session.end + ws.close() in the same tick).
      expect(sock.closed).toBe(false);

      // AssemblyAI's Termination event arrives (stands in for "300ms later" -- this fake
      // transport has no real clock, only event order matters to it).
      sock.triggerMessage({ type: 'session.ended', session_duration_seconds: 42, audio_duration_seconds: 40 });

      expect(received).toContainEqual({
        type: 'session.ended',
        session_duration_seconds: 42,
        audio_duration_seconds: 40,
      });
      // Resolved early -- closes right away once the message arrives, not after waiting
      // out the rest of the timeout window.
      await waitFor(() => expect(sock.closed).toBe(true));
    });

    // (b) nothing arrives within the window: closes anyway, reports the timeout, never
    // throws. `closeTerminationTimeoutMs` shrinks the real 2000ms production wait the same
    // way `openTimeoutMs` shrinks the connect-side open wait elsewhere in this file -- the
    // MECHANISM under test (give up and close once the deadline passes) is the same
    // regardless of the deadline's length.
    it('(b) closes anyway once the wait times out with no session.ended, reporting onCloseTimeout and never throwing', async () => {
      const { deps, sockets } = makeDeps();
      let closeTimeoutCalls = 0;
      const fastDeps: AaiConnectDeps = {
        ...deps,
        closeTerminationTimeoutMs: 30,
        onCloseTimeout: () => {
          closeTimeoutCalls += 1;
        },
      };
      const aai = await connectAndReady(fastDeps, sockets, 'sess-1');
      const sock = sockets[0]!;

      expect(() => aai.close()).not.toThrow();
      expect(sock.closed).toBe(false); // not yet -- still within the window

      await waitFor(() => expect(sock.closed).toBe(true));
      expect(closeTimeoutCalls).toBe(1);
    });

    // (c) browser hang-up timing unchanged: close() is a plain synchronous void call, same
    // signature as before this fix -- `call/session.ts`'s `end()` calls `aai.close()` then
    // immediately emits `ended` to the browser and closes ITS socket, all in the same tick,
    // completely unaffected by however long the AAI-leg wait above takes in the background.
    it("(c) close() returns synchronously (void, not a Promise) -- the caller's own hang-up sequence is never made to wait on it", async () => {
      const { deps, sockets } = makeDeps();
      const aai = await connectAndReady(deps, sockets, 'sess-1');

      const result = aai.close();
      expect(result).toBeUndefined();
      // A second close() call while the first is still waiting must also be a synchronous
      // no-op (the existing idempotency guard, `if (this.closed) return;`), never a second
      // session.end or a throw.
      expect(() => aai.close()).not.toThrow();
    });
  });

  it('stats() reports server messages this adapter does not model, excluding known-ignored types', async () => {
    const { deps, sockets } = makeDeps();
    const aai = await connectAndReady(deps, sockets, 'sess-1');

    expect(aai.stats?.()).toEqual({ unknown_events: 0 });

    // transcript.agent.delta gets its own dedicated channel, never increments unknown_events
    sockets[0]!.triggerMessage({ type: 'transcript.agent.delta', reply_id: 'r1', delta: 'hi' });
    expect(aai.stats?.()).toEqual({ unknown_events: 0 });

    // session.updated is known-ignored, never increments unknown_events
    sockets[0]!.triggerMessage({ type: 'session.updated' });
    expect(aai.stats?.()).toEqual({ unknown_events: 0 });

    // An actual unknown type increments the counter
    sockets[0]!.triggerMessage({ type: 'some.other.type' });
    expect(aai.stats?.()).toEqual({ unknown_events: 1 });

    // ignoredEventStats() reports the known-ignored types separately
    expect(aai.ignoredEventStats?.()).toEqual(new Map([['session.updated', 1]]));
  });

  // aai-observability lane (2026-09-16, dead-transcript investigation finding 1 continued):
  // `deps.onUnhandledMessage` and `AaiSocket.onUnhandledMessage` are the two channels a
  // message this adapter does not model can reach a caller through -- see both fields' own
  // doc comments (aai/session.ts's AaiConnectDeps, aai/types.ts's AaiSocket) for why both
  // exist. `transcript.agent.delta` and known-ignored types (session.updated,
  // transcript.user.delta) are deliberately excluded from BOTH (deltas have their own
  // dedicated channel, ignored types are tracked separately).
  describe('unhandled messages (aai-observability lane, 2026-09-16)', () => {
    it('calls deps.onUnhandledMessage with the type and a <=200-char JSON slice, for a message mapServerEvent does not model (excluding known-ignored types)', async () => {
      const { deps, sockets } = makeDeps();
      const calls: [string, string][] = [];
      deps.onUnhandledMessage = (type, detail) => calls.push([type, detail]);
      const aai = await connectAndReady(deps, sockets, 'sess-1');

      sockets[0]!.triggerMessage({ type: 'some.unknown.type', config: { voice: 'alba' } });

      expect(calls).toHaveLength(1);
      expect(calls[0]![0]).toBe('some.unknown.type');
      const detail = calls[0]![1];
      expect(detail.length).toBeLessThanOrEqual(200);
      expect(JSON.parse(detail)).toEqual({ type: 'some.unknown.type', config: { voice: 'alba' } });
      // stats() and the deps hook both fire off the very same drop -- proving the delta
      // count from the earlier test and this one are counting the same event, not two
      // different mechanisms.
      expect(aai.stats?.()).toEqual({ unknown_events: 1 });
      // Known-ignored types do not appear in either stats or calls
      expect(aai.ignoredEventStats?.()).toEqual(new Map());
    });

    it('does NOT call deps.onUnhandledMessage for known-ignored types (session.updated, transcript.user.delta)', async () => {
      const { deps, sockets } = makeDeps();
      const calls: [string, string][] = [];
      deps.onUnhandledMessage = (type, detail) => calls.push([type, detail]);
      const aai = await connectAndReady(deps, sockets, 'sess-1');

      sockets[0]!.triggerMessage({ type: 'session.updated', config: { voice: 'alba' } });

      expect(calls).toHaveLength(0);
      expect(aai.stats?.()).toEqual({ unknown_events: 0 });
      expect(aai.ignoredEventStats?.()).toEqual(new Map([['session.updated', 1]]));
    });

    it('truncates detail to 200 chars for a large unmodelled message, without throwing', async () => {
      const { deps, sockets } = makeDeps();
      const calls: [string, string][] = [];
      deps.onUnhandledMessage = (type, detail) => calls.push([type, detail]);
      await connectAndReady(deps, sockets, 'sess-1');

      sockets[0]!.triggerMessage({ type: 'some.unknown.type', huge: 'x'.repeat(500) });

      expect(calls).toHaveLength(1);
      expect(calls[0]![1].length).toBe(200);
    });

    it('never calls deps.onUnhandledMessage for a transcript.agent.delta -- that type has its own dedicated channel', async () => {
      const { deps, sockets } = makeDeps();
      const calls: [string, string][] = [];
      deps.onUnhandledMessage = (type, detail) => calls.push([type, detail]);
      await connectAndReady(deps, sockets, 'sess-1');

      sockets[0]!.triggerMessage({ type: 'transcript.agent.delta', reply_id: 'r1', item_id: 'i1', delta: 'hi' });

      expect(calls).toHaveLength(0);
    });

    it('AaiSocket.onUnhandledMessage receives the same (type, detail) a caller registered before the message arrived, excluding known-ignored types', async () => {
      const { deps, sockets } = makeDeps();
      const aai = await connectAndReady(deps, sockets, 'sess-1');
      const calls: [string, string][] = [];
      aai.onUnhandledMessage?.((type, detail) => calls.push([type, detail]));

      sockets[0]!.triggerMessage({ type: 'some.unknown.type' });

      expect(calls).toEqual([['some.unknown.type', JSON.stringify({ type: 'some.unknown.type' })]]);

      // Known-ignored types are never passed to this handler
      sockets[0]!.triggerMessage({ type: 'session.updated' });
      expect(calls).toHaveLength(1); // Still just the one from above
    });

    it("falls back to type 'unknown' for a message with no string type field at all", async () => {
      const { deps, sockets } = makeDeps();
      const calls: [string, string][] = [];
      deps.onUnhandledMessage = (type, detail) => calls.push([type, detail]);
      await connectAndReady(deps, sockets, 'sess-1');

      sockets[0]!.triggerMessage({ oops: true });

      expect(calls).toEqual([['unknown', JSON.stringify({ oops: true })]]);
    });
  });

  // aai-observability lane (2026-09-16, item 3): `transcript.agent.delta`'s own dedicated
  // channel -- structured (reply_id, delta) fields, never folded into the generic
  // onUnhandledMessage flood-prone path (see both methods' own doc comments in
  // aai/types.ts).
  describe('AaiSocket.onAgentTranscriptDelta (aai-observability lane, 2026-09-16)', () => {
    it('fires once per transcript.agent.delta chunk with the reply_id and delta text', async () => {
      const { deps, sockets } = makeDeps();
      const aai = await connectAndReady(deps, sockets, 'sess-1');
      const calls: [string, string][] = [];
      aai.onAgentTranscriptDelta?.((replyId, delta) => calls.push([replyId, delta]));

      sockets[0]!.triggerMessage({ type: 'transcript.agent.delta', reply_id: 'a1', item_id: 'i1', delta: 'Hel' });
      sockets[0]!.triggerMessage({ type: 'transcript.agent.delta', reply_id: 'a1', item_id: 'i1', delta: 'lo' });

      expect(calls).toEqual([
        ['a1', 'Hel'],
        ['a1', 'lo'],
      ]);
      // transcript.agent.delta uses its own dedicated channel, never increments unknown_events
      expect(aai.stats?.()).toEqual({ unknown_events: 0 });
    });
  });
});
