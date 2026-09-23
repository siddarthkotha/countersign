// packages/server/test/aai/session-endpoint-connect.test.ts
// ONE-BRAIN LIVE PATH (2026-09-22, docs/plans/2026-09-22-one-brain-live-path.md §1/§4, Lane
// D). Drives `connectAaiEndpoint` (src/aai/session.ts) against a scripted fake
// `WebSocketImpl` -- never a real socket, never the network (LAW: tests never call the live
// API). Same FakeWs shape as `aai-session.test.ts` uses for `connectAai` (that file is out of
// this lane's scope to edit, so this is a small, separately-owned copy under test/aai/).
// Covers: the bind update is sent FIRST, the post-bind update (token marker, keyterms,
// max_accuracy, no silence thresholds) is sent SECOND, only after session.ready; the connect
// promise resolves with a working AaiSocket; session.error before ready rejects.
import { describe, it, expect, vi } from 'vitest';
import { connectAaiEndpoint, type AaiConnectDeps, type WsLike } from '../../src/aai/session.js';
import type { AaiSessionConfig } from '../../src/aai/config.js';
import { extractCallToken } from '../../src/brain/registry.js';

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
}

function makeDeps(): { deps: AaiConnectDeps; sockets: FakeWs[] } {
  const sockets: FakeWs[] = [];
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ token: 'tok-1', expires_in_seconds: 60 }), { status: 200 }));
  const WebSocketImpl = vi.fn((url: string) => {
    const sock = new FakeWs(url);
    sockets.push(sock);
    return sock;
  }) as unknown as new (url: string) => WsLike;
  const deps: AaiConnectDeps = {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    WebSocketImpl,
    now: () => 0,
  };
  return { deps, sockets };
}

function cfg(overrides: Partial<AaiSessionConfig> = {}): AaiSessionConfig {
  return {
    assemblyai_api_key: 'secret-key',
    session_cap_seconds: 300,
    voice: 'alba',
    system_prompt: 'unused by connectAaiEndpoint',
    tools: [],
    keyterms: [],
    ...overrides,
  };
}

/** Opens the socket and completes the two-step bind handshake, returning both the resolved
 *  AaiSocket and the raw FakeWs so a test can inspect exactly what was sent. */
async function connectAndBind(
  bind: { agentId: string; callToken: string; keyterms: string[] },
  deps: AaiConnectDeps,
  sockets: FakeWs[]
) {
  const connectPromise = connectAaiEndpoint(cfg(), bind, deps);
  await vi.waitFor(() => expect(sockets.length).toBe(1));
  const ws = sockets[0]!;
  ws.triggerOpen();
  await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThanOrEqual(1));
  ws.triggerMessage({ type: 'session.ready', session_id: 'sess-endpoint-1' });
  const socket = await connectPromise;
  return { socket, ws };
}

describe('connectAaiEndpoint', () => {
  it('sends the bind update {agent_id} as the FIRST message, before session.ready', async () => {
    const { deps, sockets } = makeDeps();
    const connectPromise = connectAaiEndpoint(cfg(), { agentId: 'agent-abc', callToken: 'a'.repeat(64), keyterms: [] }, deps);
    await vi.waitFor(() => expect(sockets.length).toBe(1));
    const ws = sockets[0]!;
    ws.triggerOpen();
    await vi.waitFor(() => expect(ws.sent.length).toBe(1));
    expect(JSON.parse(ws.sent[0]!)).toEqual({ type: 'session.update', session: { agent_id: 'agent-abc' } });

    ws.triggerMessage({ type: 'session.ready', session_id: 'sess-1' });
    await connectPromise;
  });

  it('sends the post-bind update SECOND, only after session.ready, carrying the token marker, keyterms, and max_accuracy', async () => {
    const { deps, sockets } = makeDeps();
    const token = 'b'.repeat(64);
    const { ws } = await connectAndBind({ agentId: 'agent-abc', callToken: token, keyterms: ['Meridian Supply', 'Hartwell'] }, deps, sockets);

    expect(ws.sent).toHaveLength(2);
    const postBind = JSON.parse(ws.sent[1]!) as { type: string; session: { system_prompt: string; input: Record<string, unknown> } };
    expect(postBind.type).toBe('session.update');
    expect(extractCallToken([{ role: 'system', content: postBind.session.system_prompt }])).toBe(token);
    expect(postBind.session.input.keyterms).toEqual(['Meridian Supply', 'Hartwell']);
    expect(postBind.session.input.transcription_mode).toBe('max_accuracy');
    expect(postBind.session.input).not.toHaveProperty('turn_detection');
  });

  it('never sends voice, greeting, tools, or llm on either update -- both fixed on the stored agent, never resent here', async () => {
    const { deps, sockets } = makeDeps();
    const { ws } = await connectAndBind({ agentId: 'agent-abc', callToken: 'c'.repeat(64), keyterms: [] }, deps, sockets);

    for (const raw of ws.sent) {
      const session = (JSON.parse(raw) as { session: Record<string, unknown> }).session;
      expect(session).not.toHaveProperty('voice');
      expect(session).not.toHaveProperty('greeting');
      expect(session).not.toHaveProperty('tools');
      expect(session).not.toHaveProperty('llm');
    }
  });

  it('resolves with a working AaiSocket once session.ready arrives', async () => {
    const { deps, sockets } = makeDeps();
    const { socket } = await connectAndBind({ agentId: 'agent-abc', callToken: 'd'.repeat(64), keyterms: [] }, deps, sockets);

    const events: unknown[] = [];
    socket.on((evt) => events.push(evt));
    sockets[0]!.triggerMessage({ type: 'transcript.user', item_id: 'u1', text: 'hello' });
    expect(events).toEqual([{ type: 'transcript.user', item_id: 'u1', text: 'hello' }]);
  });

  it('rejects on session.error before ready, without ever sending the post-bind update', async () => {
    const { deps, sockets } = makeDeps();
    const connectPromise = connectAaiEndpoint(cfg(), { agentId: 'agent-abc', callToken: 'e'.repeat(64), keyterms: [] }, deps);
    await vi.waitFor(() => expect(sockets.length).toBe(1));
    const ws = sockets[0]!;
    ws.triggerOpen();
    await vi.waitFor(() => expect(ws.sent.length).toBe(1));
    ws.triggerMessage({ type: 'session.error', code: 'bad_agent', message: 'no such agent' });

    await expect(connectPromise).rejects.toThrow(/session.error/);
    expect(ws.sent).toHaveLength(1); // only the bind update -- post-bind never sent
  });

  it('calls onReady with greeting_configured=true and turn_detection_sent=null (endpoint mode never sends turn_detection)', async () => {
    const { deps, sockets } = makeDeps();
    const onReady = vi.fn();
    const connectPromise = connectAaiEndpoint(cfg(), { agentId: 'agent-abc', callToken: 'f'.repeat(64), keyterms: [] }, { ...deps, onReady });
    await vi.waitFor(() => expect(sockets.length).toBe(1));
    sockets[0]!.triggerOpen();
    await vi.waitFor(() => expect(sockets[0]!.sent.length).toBe(1));
    sockets[0]!.triggerMessage({ type: 'session.ready', session_id: 'sess-1' });
    await connectPromise;

    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenCalledWith(expect.any(Number), true, null);
  });
});
