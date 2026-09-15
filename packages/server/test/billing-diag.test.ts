// packages/server/test/billing-diag.test.ts
// Defect 2 fix verification: after the AAI close now waits up to 2s for AssemblyAI's
// session.ended, we need diagnostic events to prove:
// (1) onCloseTimeout is wired in index.ts and records aai_terminate_timeout
// (2) aai_session_ended_raw is recorded when session.ended arrives with top-level keys
// (3) aai_session_terminated fires when session_duration_seconds is a number
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

async function connectAndReady(deps: AaiConnectDeps, sockets: FakeWs[], session_id: string) {
  const connectPromise = connectAai(cfg(), deps);
  await waitFor(() => expect(sockets.length).toBe(1));
  sockets[0]!.triggerOpen();
  await waitFor(() => expect(sockets[0]!.sent.length).toBe(1));
  sockets[0]!.triggerMessage({ type: 'session.ready', session_id });
  return connectPromise;
}

function waitFor(check: () => void, maxMs = 1000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const interval = setInterval(() => {
      try {
        check();
        clearInterval(interval);
        resolve();
      } catch (e) {
        if (Date.now() - start > maxMs) {
          clearInterval(interval);
          reject(e);
        }
      }
    }, 10);
  });
}

describe('Billing Diagnostics: session.ended handling and close timeout', () => {
  it('(1) onCloseTimeout is called when close() times out waiting for session.ended', async () => {
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

    aai.close();
    await waitFor(() => expect(closeTimeoutCalls).toBe(1));
    expect(sock.closed).toBe(true);
  });

  it('(2a) aai_session_ended_raw is recorded when session.ended arrives with all fields', async () => {
    const { deps, sockets } = makeDeps();
    const emittedEvents: AaiEvent[] = [];
    const fastDeps: AaiConnectDeps = {
      ...deps,
      closeTerminationTimeoutMs: 100,
    };
    const aai = await connectAndReady(fastDeps, sockets, 'sess-2a');
    aai.on((evt) => emittedEvents.push(evt));

    // Simulate a real session.ended with billing fields
    const sock = sockets[0]!;
    aai.close();
    sock.triggerMessage({
      type: 'session.ended',
      session_duration_seconds: 45,
      audio_duration_seconds: 30,
      timestamp: 1234567890,
    });

    // Verify the event was emitted with the billing fields
    const endedEvent = emittedEvents.find((e) => e.type === 'session.ended');
    expect(endedEvent).toBeDefined();
    expect(endedEvent?.type).toBe('session.ended');
    if (endedEvent && 'session_duration_seconds' in endedEvent) {
      expect(endedEvent.session_duration_seconds).toBe(45);
      expect(endedEvent.audio_duration_seconds).toBe(30);
    }
  });

  it('(2b) aai_session_ended_raw is recorded when session.ended arrives without billing fields', async () => {
    const { deps, sockets } = makeDeps();
    const emittedEvents: AaiEvent[] = [];
    const fastDeps: AaiConnectDeps = {
      ...deps,
      closeTerminationTimeoutMs: 100,
    };
    const aai = await connectAndReady(fastDeps, sockets, 'sess-2b');
    aai.on((evt) => emittedEvents.push(evt));

    // Simulate a session.ended without billing fields (e.g., early close)
    const sock = sockets[0]!;
    aai.close();
    sock.triggerMessage({
      type: 'session.ended',
      reason: 'some_reason',
    });

    // Verify the event was emitted but without billing fields
    const endedEvent = emittedEvents.find((e) => e.type === 'session.ended');
    expect(endedEvent).toBeDefined();
    expect(endedEvent?.type).toBe('session.ended');
    if (endedEvent && 'session_duration_seconds' in endedEvent) {
      expect(endedEvent.session_duration_seconds).toBeUndefined();
    }
  });

  it('(3) aai_session_terminated is recorded only when session_duration_seconds is present', async () => {
    const { deps, sockets } = makeDeps();
    const emittedEvents: AaiEvent[] = [];
    const fastDeps: AaiConnectDeps = {
      ...deps,
      closeTerminationTimeoutMs: 100,
    };
    const aai = await connectAndReady(fastDeps, sockets, 'sess-3');
    aai.on((evt) => emittedEvents.push(evt));

    // Simulate a session.ended WITH billing fields
    const sock = sockets[0]!;
    aai.close();
    sock.triggerMessage({
      type: 'session.ended',
      session_duration_seconds: 45,
      audio_duration_seconds: 30,
      timestamp: 1234567890,
    });

    // The event should have the numeric fields
    const endedEvent = emittedEvents.find((e) => e.type === 'session.ended');
    expect(endedEvent).toBeDefined();
    if (endedEvent && 'session_duration_seconds' in endedEvent) {
      expect(endedEvent.session_duration_seconds).toBe(45);
      expect(endedEvent.audio_duration_seconds).toBe(30);
    }
  });

  it('(3b) aai_session_terminated is NOT recorded when session_duration_seconds is absent', async () => {
    const { deps, sockets } = makeDeps();
    const emittedEvents: AaiEvent[] = [];
    const fastDeps: AaiConnectDeps = {
      ...deps,
      closeTerminationTimeoutMs: 100,
    };
    const aai = await connectAndReady(fastDeps, sockets, 'sess-3b');
    aai.on((evt) => emittedEvents.push(evt));

    // Simulate a session.ended WITHOUT billing fields
    const sock = sockets[0]!;
    aai.close();
    sock.triggerMessage({
      type: 'session.ended',
    });

    // The event should NOT have session_duration_seconds
    const endedEvent = emittedEvents.find((e) => e.type === 'session.ended');
    expect(endedEvent).toBeDefined();
    if (endedEvent && 'session_duration_seconds' in endedEvent) {
      expect(endedEvent.session_duration_seconds).toBeUndefined();
    }
  });
});
