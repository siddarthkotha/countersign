// packages/server/test/aai-session.test.ts
// Drives `connectAai` against a scripted fake `WebSocketImpl` (never a real socket, never
// the network -- LAW: tests never call the live API). Covers: the connect URL carries the
// minted token, session.update is the first message sent, session.ready resolves the
// connect promise, every mapped event shape, input.audio framing, and the resume-on-drop
// path (a fresh token, a new socket, session.resume with the prior session_id, and the
// `link` lost/restored events the screen uses for "voice link lost, security state
// preserved").
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { connectAai, fetchVoices, _resetVoicesCache, type AaiConnectDeps, type WsLike } from '../src/aai/session.js';
import { DEFAULT_VOICE, type AaiSessionConfig } from '../src/aai/config.js';
import type { AaiEvent } from '../src/aai/types.js';

const ALL_VOICES = ['alba', 'eve', 'george', 'jane', 'jean', 'mary', 'michael', 'anna', 'charles', 'paul', 'vera'];

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

function makeDeps(tokens: string[] = ['tok-1', 'tok-2', 'tok-3', 'tok-4', 'tok-5'], voices: string[] = ALL_VOICES) {
  const sockets: FakeWs[] = [];
  let tokenIdx = 0;
  const fetchImpl = vi.fn(async (url: unknown) => {
    if (String(url).includes('/v1/voices')) {
      // The documented shape ({voices:[{id}]}) -- other shapes are covered by the
      // `fetchVoices` unit tests below with their own bespoke fetch mocks.
      return new Response(JSON.stringify({ voices: voices.map((id) => ({ id })) }), { status: 200 });
    }
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

// The live voice-list validation cache (src/aai/session.ts) is per-process by design --
// reset it before every test so one test's fetch/warning does not leak into the next.
beforeEach(() => {
  _resetVoicesCache();
});

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
    await new Promise((r) => setTimeout(r, 20));
    expect(resolved).toBe(false);

    sockets[0]!.triggerMessage({ type: 'session.ready', session_id: 'sess-1' });
    await connectPromise;
    expect(resolved).toBe(true);
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

    await new Promise((r) => setTimeout(r, 20));
    expect(sockets.length).toBe(1);
    expect(received).not.toContainEqual({ type: 'link', state: 'lost', attempt: 1 });
  });

  it('maps session.ended and sends session.end verbatim on close()', async () => {
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

  it('caps resume attempts at 3 for the life of the call, then gives up with session.ended and mints no further tokens', async () => {
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
    await waitFor(() => expect(received).toContainEqual({ type: 'session.ended' }));
    expect(fetchImpl.mock.calls.length).toBe(mintCallsSoFar);
    expect(sockets.length).toBe(4);
  });

  it('gives up without minting a new token once the 30s resumable window has passed', async () => {
    const { deps, sockets, fetchImpl } = makeDeps();
    let t = 0;
    const controlledDeps: AaiConnectDeps = { ...deps, now: () => t };
    const aai = await connectAndReady(controlledDeps, sockets, 'sess-1');

    const received: AaiEvent[] = [];
    aai.on((evt) => received.push(evt));
    const mintCallsBeforeDrop = fetchImpl.mock.calls.length;

    sockets[0]!.triggerClose(1006); // t is 0 at the moment of the drop
    t = 31_000; // advance the clock past the 30s window while the (no-op) backoff is "pending"

    await waitFor(() => expect(received).toContainEqual({ type: 'session.ended' }));
    expect(fetchImpl.mock.calls.length).toBe(mintCallsBeforeDrop); // no resume mint was ever attempted
    expect(sockets.length).toBe(1); // no second socket was ever opened
  });
});

// AMENDMENT (controller, 2026-09-02 11:35 AM CDT, docs/ASSEMBLYAI_AGENT_INSTRUCTIONS.md
// Voices section): voice ids are exact strings and "invented or remembered values silently
// fail" -- fetchVoices() is the live authoritative list, and connectAai validates the
// configured voice against it once per process before the first session.update goes out.
describe('fetchVoices', () => {
  function fakeFetch(body: unknown, status = 200) {
    return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  }

  it('parses the documented {voices:[{id}]} shape', async () => {
    const voices = await fetchVoices(
      { assemblyai_api_key: 'k' },
      fakeFetch({ voices: [{ id: 'anna' }, { id: 'alba' }] })
    );
    expect(voices).toEqual(['anna', 'alba']);
  });

  it('tolerates [{voice_id}]', async () => {
    const voices = await fetchVoices({ assemblyai_api_key: 'k' }, fakeFetch([{ voice_id: 'anna' }, { voice_id: 'alba' }]));
    expect(voices).toEqual(['anna', 'alba']);
  });

  it('tolerates [{id}]', async () => {
    const voices = await fetchVoices({ assemblyai_api_key: 'k' }, fakeFetch([{ id: 'anna' }]));
    expect(voices).toEqual(['anna']);
  });

  it('tolerates a plain string[]', async () => {
    const voices = await fetchVoices({ assemblyai_api_key: 'k' }, fakeFetch(['anna', 'alba']));
    expect(voices).toEqual(['anna', 'alba']);
  });

  it('sends the API key as a Bearer token', async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      expect(init?.headers?.Authorization).toBe('Bearer secret-key');
      return new Response(JSON.stringify({ voices: [] }), { status: 200 });
    });
    await fetchVoices({ assemblyai_api_key: 'secret-key' }, fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('throws on a non-OK response', async () => {
    await expect(fetchVoices({ assemblyai_api_key: 'k' }, fakeFetch({ error: 'nope' }, 500))).rejects.toThrow();
  });
});

describe('connectAai live voice-list validation (once per process, cached)', () => {
  it('uses the configured voice as-is when it is present in the live list, without warning', async () => {
    const { deps, sockets } = makeDeps(undefined, ALL_VOICES);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await connectAndReady(deps, sockets); // cfg() defaults voice to 'alba', which IS in ALL_VOICES

    const sent = JSON.parse(sockets[0]!.sent[0]!) as { session: { output: { voice: string } } };
    expect(sent.session.output.voice).toBe('alba');
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('falls back to DEFAULT_VOICE with a single warning when the configured voice is absent from the live list', async () => {
    const { deps, sockets } = makeDeps(undefined, ['george', 'jane']); // cfg() default 'alba' not present
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await connectAndReady(deps, sockets);

    const sent = JSON.parse(sockets[0]!.sent[0]!) as { session: { output: { voice: string } } };
    expect(sent.session.output.voice).toBe(DEFAULT_VOICE);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('proceeds with the configured voice and warns once when the voices endpoint errors', async () => {
    const sockets: FakeWs[] = [];
    let tokenIdx = 0;
    const tokens = ['tok-1'];
    const fetchImpl = vi.fn(async (url: unknown) => {
      if (String(url).includes('/v1/voices')) return new Response('boom', { status: 500 });
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
      sleep: async () => {},
    };

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await connectAndReady(deps, sockets); // cfg() default voice 'alba' -- unvalidated, but kept
    const sent = JSON.parse(sockets[0]!.sent[0]!) as { session: { output: { voice: string } } };
    expect(sent.session.output.voice).toBe('alba');
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('fetches the voices list only once per process -- a second connect (fresh deps) reuses the cache', async () => {
    const first = makeDeps(['tok-1'], ALL_VOICES);
    await connectAndReady(first.deps, first.sockets, 'sess-1');
    const firstVoicesCalls = first.fetchImpl.mock.calls.filter((c) => String(c[0]).includes('/v1/voices')).length;
    expect(firstVoicesCalls).toBe(1);

    // A second connect, with its OWN deps/fetchImpl (not the same mock instance) -- if the
    // cache is truly per-process (not per-deps), this fetchImpl must never see /v1/voices.
    const second = makeDeps(['tok-2'], ALL_VOICES);
    await connectAndReady(second.deps, second.sockets, 'sess-2');
    const secondVoicesCalls = second.fetchImpl.mock.calls.filter((c) => String(c[0]).includes('/v1/voices')).length;
    expect(secondVoicesCalls).toBe(0);
  });
});
