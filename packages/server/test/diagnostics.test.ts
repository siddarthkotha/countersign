// packages/server/test/diagnostics.test.ts
// The flight recorder (founder's ask, 2026-09-02): "something that can talk back and tell
// you where it went wrong, why and how, from the moment I start the script until it is
// complete." Three layers, three kinds of test:
//  1. diagnostics.ts's own pure functions (ring cap, client-event validation, summary).
//  2. CallSession wired with `onDiagnostic` -- a fake-AAI call lifecycle grows the bundle,
//     tool.call timings are recorded, a thrown error inside event handling is caught and
//     recorded instead of crashing the call.
//  3. The real HTTP surface (GET/POST .../diagnostics) end to end, same server-spin-up
//     pattern as browser-ws.test.ts/http.test.ts: session start -> ws attach -> live events
//     -> GET mid-call -> end -> GET after end -> client POST (valid/oversize/bad-shape) ->
//     unknown id -> 404.
import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import WebSocket from 'ws';
import { MERIDIAN, mockToolResult } from '@countersign/engine';
import type { CallContext, MockCtx, SeedConfig, ServerEvent, ToolName } from '@countersign/engine';
import {
  newDiagnosticsState,
  createBundle,
  recordServerEvent,
  endBundle,
  getBundle,
  addClientEvents,
  summarizeBundle,
  MAX_CLIENT_EVENTS_PER_REQUEST,
  MAX_CLIENT_BODY_BYTES,
} from '../src/diagnostics.js';
import { CallSession } from '../src/call/session.js';
import { FakeAaiSocket } from '../src/aai/fake.js';
import { createHttpServer } from '../src/http.js';
import { attachWebSocketServer } from '../src/ws/browser.js';
import type { CapsState } from '../src/caps.js';
import type { ServerConfig } from '../src/config.js';
import scenarioB from '../../engine/corpus/scenario-b-miller-fraud.json' with { type: 'json' };

const CALL_B = scenarioB.call as CallContext;

/** Replays Scenario B's c1..a4 (same sequence session.test.ts's `driveScenarioBThroughA4`
 *  drives) far enough that `check_sso_context`/`get_request_history`/`verify_out_of_band`
 *  land on the allowlist (EVIDENCE state) -- needed here so a tool.call actually reaches the
 *  mock backend (status "ok", or a throwing mock) instead of being rejected before it ever
 *  does. Duplicated locally rather than imported: session.test.ts doesn't export it, and
 *  this file only needs "far enough to reach EVIDENCE", not the full FREEZE walk. */
function driveScenarioBIntoEvidence(session: CallSession, aai: FakeAaiSocket, clock: { now: number }): void {
  clock.now = 1000;
  aai.emit({ type: 'transcript.user', item_id: 'c1', text: scenarioB.conversation[0]!.text });

  clock.now = 4000;
  aai.emit({ type: 'reply.started', reply_id: 'a1' });
  aai.emit({ type: 'transcript.agent', item_id: 'a1', text: scenarioB.conversation[1]!.text, reply_id: 'a1', interrupted: false });
  aai.emit({ type: 'reply.done', reply_id: 'a1', status: 'completed' });

  clock.now = 8000;
  aai.emit({ type: 'transcript.user', item_id: 'c2', text: scenarioB.conversation[2]!.text });

  clock.now = 12000;
  aai.emit({ type: 'reply.started', reply_id: 'a2' });
  aai.emit({ type: 'transcript.agent', item_id: 'a2', text: scenarioB.conversation[3]!.text, reply_id: 'a2', interrupted: false });
  aai.emit({ type: 'reply.done', reply_id: 'a2', status: 'completed' });

  clock.now = 40000;
  aai.emit({ type: 'transcript.user', item_id: 'c3', text: scenarioB.conversation[4]!.text });

  clock.now = 44000;
  aai.emit({ type: 'reply.started', reply_id: 'a3' });
  aai.emit({ type: 'transcript.agent', item_id: 'a3', text: scenarioB.conversation[5]!.text, reply_id: 'a3', interrupted: true });
  aai.emit({ type: 'reply.done', reply_id: 'a3', status: 'interrupted' });

  clock.now = 48000;
  aai.emit({ type: 'transcript.user', item_id: 'c4', text: scenarioB.conversation[6]!.text });

  clock.now = 50000;
  aai.emit({ type: 'reply.started', reply_id: 'a4' });
  aai.emit({ type: 'transcript.agent', item_id: 'a4', text: scenarioB.conversation[7]!.text, reply_id: 'a4', interrupted: false });
  aai.emit({ type: 'reply.done', reply_id: 'a4', status: 'completed' });
}

// ---------------------------------------------------------------------------------------
// 1. diagnostics.ts's own pure functions
// ---------------------------------------------------------------------------------------

describe('diagnostics.ts — pure functions', () => {
  it('records server_events timestamped relative to the bundle start', () => {
    const state = newDiagnosticsState();
    createBundle(state, 'sess-1', 1000);
    recordServerEvent(state, 'sess-1', 1250, 'evaluate', { verdict: 'PENDING', state: 'INTAKE' });
    recordServerEvent(state, 'sess-1', 1400, 'tool_call', { name: 'get_request_history', duration_ms: 0.4, status: 'ok' });

    const bundle = getBundle(state, 'sess-1')!;
    expect(bundle.server_events).toEqual([
      { t_ms: 250, kind: 'evaluate', detail: { verdict: 'PENDING', state: 'INTAKE' } },
      { t_ms: 400, kind: 'tool_call', detail: { name: 'get_request_history', duration_ms: 0.4, status: 'ok' } },
    ]);
  });

  it('a bundle stays readable after it ends, unchanged except ended_at/end_reason', () => {
    const state = newDiagnosticsState();
    createBundle(state, 'sess-1', 1000);
    recordServerEvent(state, 'sess-1', 1100, 'link', { leg: 'browser', state: 'attach' });
    const ended = endBundle(state, 'sess-1', 2000, 'caller_ended');
    expect(ended?.ended_at).toBe(2000);
    expect(ended?.end_reason).toBe('caller_ended');

    const readBack = getBundle(state, 'sess-1');
    expect(readBack?.end_reason).toBe('caller_ended');
    expect(readBack?.server_events).toHaveLength(1);
  });

  it('endBundle/recordServerEvent are no-ops (never throw) for an unknown session id', () => {
    const state = newDiagnosticsState();
    expect(() => recordServerEvent(state, 'nope', 100, 'x', {})).not.toThrow();
    expect(endBundle(state, 'nope', 100, 'x')).toBeNull();
    expect(getBundle(state, 'nope')).toBeNull();
  });

  it('caps server_events at 2000 per bundle', () => {
    const state = newDiagnosticsState();
    createBundle(state, 'sess-1', 0);
    for (let i = 0; i < 2100; i++) {
      recordServerEvent(state, 'sess-1', i, 'x', { i });
    }
    expect(getBundle(state, 'sess-1')?.server_events).toHaveLength(2000);
  });

  it('the ring keeps only the last 50 bundles, evicting the oldest', () => {
    const state = newDiagnosticsState();
    for (let i = 0; i < 55; i++) {
      createBundle(state, `sess-${i}`, i);
    }
    expect(state.bundles.size).toBe(50);
    // The first 5 (sess-0..sess-4) were evicted; the most recent 50 remain, still readable.
    expect(getBundle(state, 'sess-0')).toBeNull();
    expect(getBundle(state, 'sess-4')).toBeNull();
    expect(getBundle(state, 'sess-5')).not.toBeNull();
    expect(getBundle(state, 'sess-54')).not.toBeNull();
  });

  it('an ended bundle still counts toward (and can still be evicted from) the ring', () => {
    const state = newDiagnosticsState();
    createBundle(state, 'sess-old', 0);
    endBundle(state, 'sess-old', 10, 'caller_ended');
    for (let i = 0; i < 50; i++) {
      createBundle(state, `sess-${i}`, i);
    }
    // 51 total ever created (sess-old + 50 more), ring cap 50 -> sess-old evicted even
    // though it had already ended (ended sessions stay readable only while still in the
    // ring, not forever).
    expect(getBundle(state, 'sess-old')).toBeNull();
  });

  describe('addClientEvents', () => {
    function setup(): { state: ReturnType<typeof newDiagnosticsState> } {
      const state = newDiagnosticsState();
      createBundle(state, 'sess-1', 0);
      return { state };
    }

    it('accepts a valid batch and appends it as client_events', () => {
      const { state } = setup();
      const result = addClientEvents(state, 'sess-1', JSON.stringify({ events: [{ t_ms: 10, kind: 'mic_permission', detail: { granted: true } }] }));
      expect(result).toEqual({ ok: true, accepted: 1 });
      expect(getBundle(state, 'sess-1')?.client_events).toEqual([{ t_ms: 10, kind: 'mic_permission', detail: { granted: true } }]);
    });

    it('rejects an unknown session id', () => {
      const { state } = setup();
      expect(addClientEvents(state, 'nope', JSON.stringify({ events: [{ t_ms: 1, kind: 'x' }] }))).toEqual({
        ok: false,
        reason: 'not_found',
      });
    });

    it('rejects malformed JSON', () => {
      const { state } = setup();
      expect(addClientEvents(state, 'sess-1', 'not json')).toEqual({ ok: false, reason: 'invalid' });
    });

    it('rejects a body missing the events array', () => {
      const { state } = setup();
      expect(addClientEvents(state, 'sess-1', JSON.stringify({ foo: 1 }))).toEqual({ ok: false, reason: 'invalid' });
    });

    it('rejects an event missing kind or with a non-numeric t_ms', () => {
      const { state } = setup();
      expect(addClientEvents(state, 'sess-1', JSON.stringify({ events: [{ t_ms: 'soon', kind: 'x' }] }))).toEqual({
        ok: false,
        reason: 'invalid',
      });
      expect(addClientEvents(state, 'sess-1', JSON.stringify({ events: [{ t_ms: 1 }] }))).toEqual({ ok: false, reason: 'invalid' });
    });

    it('rejects a batch over MAX_CLIENT_EVENTS_PER_REQUEST', () => {
      const { state } = setup();
      const events = Array.from({ length: MAX_CLIENT_EVENTS_PER_REQUEST + 1 }, (_, i) => ({ t_ms: i, kind: 'x' }));
      expect(addClientEvents(state, 'sess-1', JSON.stringify({ events }))).toEqual({ ok: false, reason: 'invalid' });
    });
  });

  it('summarizeBundle counts kinds, surfaces the last evaluate verdict, and counts errors', () => {
    const state = newDiagnosticsState();
    createBundle(state, 'sess-1', 0);
    recordServerEvent(state, 'sess-1', 10, 'evaluate', { verdict: 'PENDING', state: 'INTAKE' });
    recordServerEvent(state, 'sess-1', 20, 'evaluate', { verdict: 'STAGE', state: 'ACTION' });
    recordServerEvent(state, 'sess-1', 30, 'error', { message: 'boom', where: 'x' });
    endBundle(state, 'sess-1', 40, 'caller_ended');

    const summary = summarizeBundle(getBundle(state, 'sess-1')!);
    expect(summary).toEqual({
      id: 'sess-1',
      end_reason: 'caller_ended',
      counts: { evaluate: 2, error: 1 },
      verdict: 'STAGE',
      errors: 1,
    });
  });
});

// ---------------------------------------------------------------------------------------
// 2. CallSession wired with onDiagnostic -- a fake-AAI lifecycle
// ---------------------------------------------------------------------------------------

describe('CallSession — onDiagnostic', () => {
  function newSession(
    clockRef: { now: number },
    aai: FakeAaiSocket,
    events: { kind: string; detail: unknown }[],
    mock: typeof mockToolResult = mockToolResult,
  ) {
    return new CallSession({
      session_id: CALL_B.session_id,
      seed: MERIDIAN,
      call: CALL_B,
      aai,
      now: () => clockRef.now,
      onServerEvent: () => {},
      mock,
      onDiagnostic: (kind, detail) => events.push({ kind, detail }),
    });
  }

  it('records at least one evaluate event on start, and a tool_call event with a duration and status for a rejected call', () => {
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const events: { kind: string; detail: unknown }[] = [];
    const session = newSession(clock, aai, events);

    session.start(); // INTAKE -- allowed_tools is empty, so any tool.call is rejected

    expect(events.some((e) => e.kind === 'evaluate')).toBe(true);

    clock.now = 1000;
    aai.emit({ type: 'tool.call', call_id: 't1', name: 'get_request_history', arguments: {} });

    const toolEvents = events.filter((e) => e.kind === 'tool_call');
    expect(toolEvents).toHaveLength(1);
    const detail = toolEvents[0]!.detail as { name: ToolName; duration_ms: number; status: string };
    expect(detail.name).toBe('get_request_history');
    expect(detail.status).toBe('not_allowed_in_state');
    expect(detail.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('records a successful tool_call (status "ok") once the scenario reaches EVIDENCE', () => {
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const events: { kind: string; detail: unknown }[] = [];
    const session = newSession(clock, aai, events);

    session.start();
    driveScenarioBIntoEvidence(session, aai, clock);

    expect(session.last?.allowed_tools).toContain('check_sso_context');

    clock.now = 5000;
    aai.emit({ type: 'tool.call', call_id: 't1', name: 'check_sso_context', arguments: { identity_id: session.last?.claimed_identity_id } });

    const toolEvents = events.filter((e) => e.kind === 'tool_call');
    expect(toolEvents).toHaveLength(1);
    const detail = toolEvents[0]!.detail as { name: ToolName; duration_ms: number; status: string };
    expect(detail.name).toBe('check_sso_context');
    expect(detail.status).toBe('ok');
    expect(detail.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('a thrown error inside event handling is caught, recorded as an error event, and the call survives (does not crash, does not silently end)', () => {
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const events: { kind: string; detail: unknown }[] = [];
    const session = newSession(clock, aai, events);

    session.start();
    clock.now = 1000;
    // `reply.started` itself re-runs `applyEvaluate` (dispatchAaiEvent's own trailing
    // `tick()`), which would overwrite a mutated `session.last` -- so the mutation below has
    // to land strictly AFTER `reply.started` and strictly BEFORE `reply.done`, in the same
    // synchronous frame. `goal` is read as `PhrasingGoal` but is actually `undefined` here,
    // so `recordGoalCompletionAction`'s `goal.code` throws a TypeError -- exactly the kind of
    // bug-shaped failure the flight recorder exists to surface without taking the call down
    // with it.
    aai.emit({ type: 'reply.started', reply_id: 'a1' });
    session.last = { ...session.last!, goal: undefined as never };
    expect(() => {
      aai.emit({ type: 'reply.done', reply_id: 'a1', status: 'completed' });
    }).not.toThrow();

    const errorEvents = events.filter((e) => e.kind === 'error');
    expect(errorEvents).toHaveLength(1);
    const detail = errorEvents[0]!.detail as { message: string; where: string };
    expect(detail.where).toBe('handleAaiEvent:reply.done');
    expect(detail.message).toMatch(/cannot read propert/i);

    // The call itself is still alive -- a caught internal error is diagnostics, not a
    // terminal condition.
    expect(session.hasEnded()).toBe(false);
  });

  it('records session_ended (with reason) and aai_unknown_events (when the socket reports stats) on end', () => {
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    // FakeAaiSocket has no `stats()` -- give this one instance a stub, matching the shape
    // the real adapter (aai/session.ts's RealAaiSocket) exposes.
    (aai as unknown as { stats: () => { unknown_events: number } }).stats = () => ({ unknown_events: 3 });
    const events: { kind: string; detail: unknown }[] = [];
    const session = newSession(clock, aai, events);

    session.start();
    session.end('caller_ended');

    expect(events.some((e) => e.kind === 'session_ended' && (e.detail as { reason: string }).reason === 'caller_ended')).toBe(true);
    expect(events.some((e) => e.kind === 'aai_unknown_events' && (e.detail as { unknown_events: number }).unknown_events === 3)).toBe(
      true,
    );
  });

  it('never calls onDiagnostic if it was not supplied (an unwired session behaves exactly as before)', () => {
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const session = new CallSession({
      session_id: CALL_B.session_id,
      seed: MERIDIAN,
      call: CALL_B,
      aai,
      now: () => clock.now,
      onServerEvent: () => {},
      mock: mockToolResult,
    });
    expect(() => session.start()).not.toThrow();
  });

  it('a tool mock throwing still gets caught by the outer handler and recorded as an error, not crashed', () => {
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const events: { kind: string; detail: unknown }[] = [];
    const throwingMock: typeof mockToolResult = (name: ToolName, _args: Record<string, unknown>, _seed: SeedConfig, _ctx: MockCtx) => {
      if (name === 'get_request_history') throw new Error('mock backend exploded');
      return mockToolResult(name, _args, _seed, _ctx);
    };
    const session = newSession(clock, aai, events, throwingMock);

    session.start();
    driveScenarioBIntoEvidence(session, aai, clock);

    clock.now = 50000;
    expect(() => aai.emit({ type: 'tool.call', call_id: 't1', name: 'get_request_history', arguments: {} })).not.toThrow();

    const errorEvents = events.filter((e) => e.kind === 'error');
    expect(errorEvents).toHaveLength(1);
    expect((errorEvents[0]!.detail as { message: string }).message).toBe('mock backend exploded');
  });
});

// ---------------------------------------------------------------------------------------
// 3. The real HTTP surface, end to end
// ---------------------------------------------------------------------------------------

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

describe('GET/POST /api/session/:id/diagnostics', () => {
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
    const ids = ['aaaaaaaa-1111-1111-1111-111111111111'];
    let counter = 0;
    const aaiInstances = new Map<string, FakeAaiSocket>();
    const diagnostics = newDiagnosticsState();
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
      createAai: (session_id) => {
        const aai = new FakeAaiSocket();
        aaiInstances.set(session_id, aai);
        return aai;
      },
      cfg: serverCfg,
      diagnostics,
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

    return { base: `http://127.0.0.1:${addr.port}`, wsBase: `ws://127.0.0.1:${addr.port}`, state, aaiInstances };
  }

  function selfOriginFor(wsBase: string): string {
    return wsBase.replace(/^ws:/, 'http:');
  }

  async function pollUntil(cond: () => boolean, timeoutMs = 3000, stepMs = 5): Promise<void> {
    const startedAt = Date.now();
    while (!cond()) {
      if (Date.now() - startedAt > timeoutMs) throw new Error(`pollUntil: condition still false after ${timeoutMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, stepMs));
    }
  }

  it('GET 404s for an id that never started a session', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/api/session/aaaaaaaa-0000-0000-0000-000000000000/diagnostics`);
    expect(res.status).toBe(404);
  });

  it('GET 404s for a non-UUID id', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/api/session/not-a-uuid/diagnostics`);
    expect(res.status).toBe(404);
  });

  it('grows through a live fake-AAI call and stays readable after the call ends', async () => {
    const { base, wsBase, aaiInstances } = await start();
    const startRes = await fetch(`${base}/api/session/start`, { method: 'POST' });
    const { session_id, ws_path } = (await startRes.json()) as { session_id: string; ws_path: string };

    const ws = new WebSocket(`${wsBase}${ws_path}`, { origin: selfOriginFor(wsBase) });
    const messages: ServerEvent[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.on('message', (data) => messages.push(JSON.parse(data.toString()) as ServerEvent));
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    ws.send(JSON.stringify({ type: 'start' }));
    await pollUntil(() => messages.some((m) => m.type === 'state'));

    // Mid-call: the bundle already has the browser attach, the AAI connect start, and at
    // least one evaluate from the initial tick.
    const midRes = await fetch(`${base}/api/session/${session_id}/diagnostics`);
    expect(midRes.status).toBe(200);
    const mid = (await midRes.json()) as { session_id: string; ended_at: number | null; server_events: { kind: string }[] };
    expect(mid.session_id).toBe(session_id);
    expect(mid.ended_at).toBeNull();
    const midKinds = mid.server_events.map((e) => e.kind);
    expect(midKinds).toContain('link');
    expect(midKinds).toContain('aai_connect_start');
    expect(midKinds).toContain('evaluate');

    // Emit a live transcript + a tool.call rejected at INTAKE, to grow the bundle further.
    const aai = aaiInstances.get(session_id)!;
    aai.emit({ type: 'tool.call', call_id: 't1', name: 'get_request_history', arguments: {} });
    await pollUntil(() => messages.length > 0); // already true, just settle a tick

    ws.close();
    // `/end` -> `endCall` -> `CallSession.end` all run synchronously (the `ended` ServerEvent
    // is emitted and handled -- including `endBundle` -- before `endCall` returns), so the
    // bundle is already closed out by the time this fetch resolves; no polling needed.
    const endRes = await fetch(`${base}/api/session/${session_id}/end`, { method: 'POST' });
    expect(endRes.status).toBe(204);

    // After end: GET still works (ended sessions stay readable), end_reason is set, and the
    // rejected tool.call shows up with its status.
    const afterRes = await fetch(`${base}/api/session/${session_id}/diagnostics`);
    expect(afterRes.status).toBe(200);
    const after = (await afterRes.json()) as {
      end_reason: string | null;
      ended_at: number | null;
      server_events: { kind: string; detail: { status?: string } }[];
    };
    expect(after.ended_at).not.toBeNull();
    expect(after.end_reason).toBe('caller_ended');
    const toolEvent = after.server_events.find((e) => e.kind === 'tool_call');
    expect(toolEvent?.detail.status).toBe('not_allowed_in_state');
  });

  it('POST accepts a valid client_events batch and it shows up on the next GET', async () => {
    const { base, wsBase } = await start();
    const startRes = await fetch(`${base}/api/session/start`, { method: 'POST' });
    const { session_id, ws_path } = (await startRes.json()) as { session_id: string; ws_path: string };
    const ws = new WebSocket(`${wsBase}${ws_path}`, { origin: selfOriginFor(wsBase) });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    ws.send(JSON.stringify({ type: 'start' }));
    await pollUntil(() => true, 50); // let the attach land

    const postRes = await fetch(`${base}/api/session/${session_id}/diagnostics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: [{ t_ms: 12, kind: 'mic_permission_denied', detail: { code: 'NotAllowedError' } }] }),
    });
    expect(postRes.status).toBe(200);
    const postBody = (await postRes.json()) as { ok: boolean; accepted: number };
    expect(postBody).toEqual({ ok: true, accepted: 1 });

    const getRes = await fetch(`${base}/api/session/${session_id}/diagnostics`);
    const bundle = (await getRes.json()) as { client_events: { kind: string }[] };
    expect(bundle.client_events).toEqual([{ t_ms: 12, kind: 'mic_permission_denied', detail: { code: 'NotAllowedError' } }]);

    ws.close();
  });

  /** A bundle only exists once the call actually attaches (`createBundle` runs on the first
   *  `/ws/call/:id` socket, ws/browser.ts) -- `/api/session/start` alone only makes the caps
   *  reservation. The 413/400 tests below care about body validation, not session lifecycle,
   *  but still need a real bundle behind the id for those checks to be reachable at all
   *  (400/413 both run before or independent of the not_found check, but a clean setup that
   *  mirrors how the route is actually used beats relying on check ordering). */
  async function startAndAttach(): Promise<{ base: string; session_id: string; ws: WebSocket }> {
    const { base, wsBase } = await start();
    const startRes = await fetch(`${base}/api/session/start`, { method: 'POST' });
    const { session_id, ws_path } = (await startRes.json()) as { session_id: string; ws_path: string };
    const ws = new WebSocket(`${wsBase}${ws_path}`, { origin: selfOriginFor(wsBase) });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    ws.send(JSON.stringify({ type: 'start' }));
    await pollUntil(() => true, 50); // let the attach (createBundle) land
    return { base, session_id, ws };
  }

  it('POST 413s for an oversize body', async () => {
    const { base, session_id, ws } = await startAndAttach();

    const oversized = 'x'.repeat(MAX_CLIENT_BODY_BYTES + 1024);
    const res = await fetch(`${base}/api/session/${session_id}/diagnostics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: [{ t_ms: 1, kind: 'x', detail: oversized }] }),
    });
    expect(res.status).toBe(413);
    ws.close();
  });

  it('POST 400s for a malformed body (bad JSON, missing events, or an over-count batch)', async () => {
    const { base, session_id, ws } = await startAndAttach();

    const badJson = await fetch(`${base}/api/session/${session_id}/diagnostics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });
    expect(badJson.status).toBe(400);

    const missingEvents = await fetch(`${base}/api/session/${session_id}/diagnostics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nope: true }),
    });
    expect(missingEvents.status).toBe(400);

    const tooMany = await fetch(`${base}/api/session/${session_id}/diagnostics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: Array.from({ length: MAX_CLIENT_EVENTS_PER_REQUEST + 1 }, (_, i) => ({ t_ms: i, kind: 'x' })) }),
    });
    expect(tooMany.status).toBe(400);
    ws.close();
  });

  it('POST 404s for an unknown session id', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/api/session/aaaaaaaa-0000-0000-0000-000000000000/diagnostics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: [{ t_ms: 1, kind: 'x' }] }),
    });
    expect(res.status).toBe(404);
  });
});
