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
import { request as httpRequest } from 'node:http';
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
  checkClientPostRate,
  summarizeBundle,
  MAX_CLIENT_EVENTS_PER_REQUEST,
  MAX_CLIENT_BODY_BYTES,
  MAX_CLIENT_EVENTS_PER_SESSION,
  MAX_CLIENT_BYTES_PER_SESSION,
  MAX_CLIENT_EVENT_KIND_LENGTH,
  MAX_CLIENT_EVENT_DETAIL_BYTES,
  MAX_CLIENT_POSTS_PER_MINUTE,
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

    // Fix round 1 (IMPORTANT review finding): per-event caps -- a single adversarial event
    // (an oversize `detail`, or a `kind` string used as a dumping ground) must not itself be
    // able to dominate the per-session cumulative budget checked below.
    it('rejects an event whose kind exceeds MAX_CLIENT_EVENT_KIND_LENGTH', () => {
      const { state } = setup();
      const longKind = 'x'.repeat(MAX_CLIENT_EVENT_KIND_LENGTH + 1);
      expect(addClientEvents(state, 'sess-1', JSON.stringify({ events: [{ t_ms: 1, kind: longKind }] }))).toEqual({
        ok: false,
        reason: 'invalid',
      });
      // Exactly at the limit is still fine.
      const exactKind = 'x'.repeat(MAX_CLIENT_EVENT_KIND_LENGTH);
      expect(addClientEvents(state, 'sess-1', JSON.stringify({ events: [{ t_ms: 1, kind: exactKind }] }))).toEqual({
        ok: true,
        accepted: 1,
      });
    });

    it('rejects an event whose detail exceeds MAX_CLIENT_EVENT_DETAIL_BYTES when serialized', () => {
      const { state } = setup();
      const bigDetail = { blob: 'x'.repeat(MAX_CLIENT_EVENT_DETAIL_BYTES) }; // the wrapper alone pushes it over 1 KB
      expect(addClientEvents(state, 'sess-1', JSON.stringify({ events: [{ t_ms: 1, kind: 'x', detail: bigDetail }] }))).toEqual({
        ok: false,
        reason: 'invalid',
      });
    });

    // Note: `addClientEvents` also guards `JSON.stringify(detail)` in a try/catch (see its
    // own comment) as defensive-in-depth, but there's no way to reach that branch through the
    // public API -- `detail` only ever exists after `JSON.parse(rawBody)`, which by
    // construction can never produce a circular reference or a throwing `toJSON` (JSON simply
    // cannot represent either). Not tested here for exactly that reason: it isn't reachable.

    // Fix round 1 (IMPORTANT review finding): the SESSION-WIDE cumulative budget -- many
    // individually-valid POSTs must not be able to grow one bundle without bound. Whole-
    // request rejection (never partial truncation) once either budget would be exceeded.
    it('rejects a request that would push the session over MAX_CLIENT_EVENTS_PER_SESSION, without partially ingesting it', () => {
      const { state } = setup();
      // Fill to exactly the session cap across several requests (each under the per-request
      // cap), then prove the next single valid event is rejected whole, not truncated in.
      const perRequest = 100;
      for (let i = 0; i < MAX_CLIENT_EVENTS_PER_SESSION / perRequest; i++) {
        const events = Array.from({ length: perRequest }, (_, j) => ({ t_ms: i * perRequest + j, kind: 'x' }));
        expect(addClientEvents(state, 'sess-1', JSON.stringify({ events }))).toEqual({ ok: true, accepted: perRequest });
      }
      expect(getBundle(state, 'sess-1')?.client_events).toHaveLength(MAX_CLIENT_EVENTS_PER_SESSION);

      const result = addClientEvents(state, 'sess-1', JSON.stringify({ events: [{ t_ms: 999999, kind: 'one-more' }] }));
      expect(result).toEqual({ ok: false, reason: 'session_full' });
      // Rejected whole -- the bundle did not grow at all from the rejected request.
      expect(getBundle(state, 'sess-1')?.client_events).toHaveLength(MAX_CLIENT_EVENTS_PER_SESSION);
    });

    it('rejects a request that would push the session over MAX_CLIENT_BYTES_PER_SESSION', () => {
      const { state } = setup();
      // One near-max-size event per request, well under the event-COUNT cap, until the
      // cumulative BYTE budget itself is what blocks the next one.
      const nearMaxDetail = { blob: 'x'.repeat(MAX_CLIENT_EVENT_DETAIL_BYTES - 32) };
      let lastResult: ReturnType<typeof addClientEvents> = { ok: true, accepted: 0 };
      let requests = 0;
      while (lastResult.ok && requests < MAX_CLIENT_EVENTS_PER_SESSION) {
        lastResult = addClientEvents(state, 'sess-1', JSON.stringify({ events: [{ t_ms: requests, kind: 'x', detail: nearMaxDetail }] }));
        requests += 1;
      }
      expect(lastResult).toEqual({ ok: false, reason: 'session_full' });
      // Failed on bytes, well before ever reaching the (much higher, in this scenario)
      // event-count cap.
      expect(requests).toBeLessThan(MAX_CLIENT_EVENTS_PER_SESSION);
      expect(getBundle(state, 'sess-1')!.client_bytes).toBeLessThanOrEqual(MAX_CLIENT_BYTES_PER_SESSION);
    });
  });

  describe('checkClientPostRate', () => {
    it('allows up to MAX_CLIENT_POSTS_PER_MINUTE, then rate-limits further posts in the same window', () => {
      const state = newDiagnosticsState();
      createBundle(state, 'sess-1', 0);
      let now = 0;
      for (let i = 0; i < MAX_CLIENT_POSTS_PER_MINUTE; i++) {
        expect(checkClientPostRate(state, 'sess-1', now)).toBe('ok');
        now += 100;
      }
      expect(checkClientPostRate(state, 'sess-1', now)).toBe('rate_limited');
    });

    it('the window slides -- a post older than 60s ages out and frees up a slot', () => {
      const state = newDiagnosticsState();
      createBundle(state, 'sess-1', 0);
      for (let i = 0; i < MAX_CLIENT_POSTS_PER_MINUTE; i++) {
        expect(checkClientPostRate(state, 'sess-1', i)).toBe('ok');
      }
      expect(checkClientPostRate(state, 'sess-1', 100)).toBe('rate_limited');
      // 61s after the FIRST post -- it's aged out of the 60s window, freeing one slot.
      expect(checkClientPostRate(state, 'sess-1', 61_000)).toBe('ok');
    });

    it('returns not_found for an unknown session id (never counts against any window)', () => {
      const state = newDiagnosticsState();
      expect(checkClientPostRate(state, 'nope', 0)).toBe('not_found');
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

  /** Fix round 2: same as `newSession` above but also captures `ServerEvent`s, so a test can
   *  inspect the actual `ScreenState` (`export_hash`, `verdict`) the terminal-action retry/
   *  abandon logic produces -- most tests in this file only care about the diagnostics
   *  channel, so this stays a separate helper rather than changing `newSession`'s signature
   *  (and every existing call site) for the few that need it. */
  function newSessionWithState(
    clockRef: { now: number },
    aai: FakeAaiSocket,
    events: { kind: string; detail: unknown }[],
    mock: typeof mockToolResult = mockToolResult,
  ): { session: CallSession; sent: ServerEvent[] } {
    const sent: ServerEvent[] = [];
    const session = new CallSession({
      session_id: CALL_B.session_id,
      seed: MERIDIAN,
      call: CALL_B,
      aai,
      now: () => clockRef.now,
      onServerEvent: (e) => sent.push(e),
      mock,
      onDiagnostic: (kind, detail) => events.push({ kind, detail }),
    });
    return { session, sent };
  }

  /** The most recent `state` ServerEvent's own `ScreenState`, if any have been sent yet. */
  function latestState(sent: ServerEvent[]): Extract<ServerEvent, { type: 'state' }>['state'] | null {
    for (let i = sent.length - 1; i >= 0; i--) {
      const e = sent[i]!;
      if (e.type === 'state') return e.state;
    }
    return null;
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

    // Fix round 1 (IMPORTANT review finding): a throw partway through `reply.done`'s own
    // handling used to skip that event's trailing `tick()` entirely -- the engine never
    // re-evaluated, and the call just sat on stale state. `recoverFromDispatchError` now
    // runs `tick()` from its catch block, so the LAST diag event recorded for this turn is a
    // fresh `evaluate` (from the caught event's own recovery), not the `error` itself sitting
    // unfollowed.
    const lastEvent = events.at(-1)!;
    expect(lastEvent.kind).toBe('evaluate');

    // And the call still reaches a real terminal state afterward -- a caught mid-dispatch
    // error must never leave it stuck relying on cap/idle to force it closed; `end()` still
    // works exactly as it would have with no error at all.
    session.end('cap_reached');
    expect(session.hasEnded()).toBe(true);
    expect(events.some((e) => e.kind === 'session_ended' && (e.detail as { reason: string }).reason === 'cap_reached')).toBe(true);
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

    // Fix round 1 (IMPORTANT review finding): a throw inside `handleToolCall` (here, the
    // mock backend itself) used to leave NO trace in `logs.tools` -- the `ToolLogEntry` push
    // only happens AFTER a successful mock call, so a throwing mock meant AAI would wait
    // forever for a `tool.result` that was never queued, and the engine's own I4 rule
    // (rules.ts: a tool result carrying an error forces ESCALATE/NO_ACTION, never STAGE)
    // never got a failed result to see. `recoverFromDispatchError` now backfills one.
    const backfilled = session.logs.tools.find((t) => t.id === 't1');
    expect(backfilled?.name).toBe('get_request_history');
    expect(backfilled?.result?.error).toBe('internal_error');
    expect(session.logs.tools.filter((t) => t.id === 't1')).toHaveLength(1); // no double-log

    // ...and it's queued to actually reach AAI, not silently dropped -- the very next
    // reply.done flushes it, same as any other tool.result would be.
    aai.emit({ type: 'reply.started', reply_id: 'tools-1' });
    aai.emit({ type: 'reply.done', reply_id: 'tools-1', status: 'completed' });
    const sentResult = aai.sent.find((m) => (m as { type?: string; call_id?: string }).call_id === 't1') as
      | { type: string; is_error: boolean }
      | undefined;
    expect(sentResult?.type).toBe('tool.result');
    expect(sentResult?.is_error).toBe(true);

    // The engine itself now sees a failed tool result -- I4 forces ESCALATE/NO_ACTION, and
    // LAW 2 (the ceiling is STAGE, but never reached via a failure path) means it must never
    // be STAGE.
    expect(session.last?.verdict).not.toBe('STAGE');
    expect(['ESCALATE', 'NO_ACTION']).toContain(session.last?.verdict);
  });

  it('a caught mid-dispatch error still lets tick() re-run for THAT event, not just the next one', () => {
    // Narrower than the reply.done test above: proves the fix's core claim directly on
    // `tool.call` (the other throwing path) -- the diag sequence for the SAME synchronous
    // `emit()` call is [error, evaluate, ...], never just [error] followed by silence until
    // some unrelated later event. Only `check_sso_context` throws (the other two evidence
    // tools aren't called in this test), so the verdict stays short of terminal and
    // `runTerminalActionsIfNeeded` has nothing to do -- keeps this test isolated to the
    // `tool.call`-throw recovery path, not the (separately tested below) nested-failure case.
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const events: { kind: string; detail: unknown }[] = [];
    const throwingMock: typeof mockToolResult = (name, args, seed, ctx) => {
      if (name === 'check_sso_context') throw new Error('boom');
      return mockToolResult(name, args, seed, ctx);
    };
    const session = newSession(clock, aai, events, throwingMock);

    session.start();
    driveScenarioBIntoEvidence(session, aai, clock);
    const evaluateCountBefore = events.filter((e) => e.kind === 'evaluate').length;

    clock.now = 60000;
    aai.emit({ type: 'tool.call', call_id: 't1', name: 'check_sso_context', arguments: { identity_id: session.last?.claimed_identity_id } });

    const evaluateCountAfter = events.filter((e) => e.kind === 'evaluate').length;
    expect(evaluateCountAfter).toBeGreaterThan(evaluateCountBefore); // tick() ran for this event
    // ...and kept running: the backfilled failed result makes this verdict terminal (I4), so
    // recovery's `tick()` goes all the way through `runTerminalActionsIfNeeded` too -- the
    // last diag event is neither the `error` itself nor silence, but real forward progress.
    expect(events.at(-1)?.kind).not.toBe('error');
  });

  it('survives a NESTED failure -- every tool including every terminal action failing -- without crashing the call; fix round 2 catches each terminal action individually now, so recovery\'s tick() itself no longer needs to', () => {
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const events: { kind: string; detail: unknown }[] = [];
    // Throws for every tool, including whatever `runTerminalActionsIfNeeded` tries once the
    // backfilled failed result (from the FIRST throw) pushes the verdict terminal. Must still
    // not crash.
    const alwaysThrowingMock: typeof mockToolResult = () => {
      throw new Error('every tool is broken');
    };
    const session = newSession(clock, aai, events, alwaysThrowingMock);

    session.start();
    driveScenarioBIntoEvidence(session, aai, clock);

    clock.now = 60000;
    expect(() =>
      aai.emit({ type: 'tool.call', call_id: 't1', name: 'check_sso_context', arguments: { identity_id: session.last?.claimed_identity_id } }),
    ).not.toThrow();

    // Fix round 2 (LAW 2/3 re-review finding): `runTerminalActionsIfNeeded` now catches each
    // owed action's own throw individually -- `tick()` itself no longer throws just because
    // EVERY terminal action also fails, so recovery's own nested `tick()` try/catch (still
    // present, still defensive) never actually fires here anymore. Exactly ONE generic
    // `error` event (the original `tool.call` throw), never a second
    // `recoverFromDispatchError:tick` one for this scenario -- the terminal-action failures
    // are diagnosed through their own, more specific `terminal_action_result` events instead.
    const errorEvents = events.filter((e) => e.kind === 'error');
    expect(errorEvents).toHaveLength(1);
    expect((errorEvents[0]!.detail as { where: string }).where).toBe('handleAaiEvent:tool.call');
    expect(errorEvents.some((e) => (e.detail as { where: string }).where === 'recoverFromDispatchError:tick')).toBe(false);

    // ESCALATE (the verdict the backfilled failure pushes this to) owes open_incident/
    // alert_principal/seal_evidence_record -- each attempted once on this one tick, each
    // caught individually and diagnosed, none of them abandoned yet (bounded to 3 attempts).
    const failures = events.filter((e) => e.kind === 'terminal_action_result' && (e.detail as { status: string }).status === 'error');
    expect(failures.map((e) => (e.detail as { name: string }).name).sort()).toEqual(
      ['alert_principal', 'open_incident', 'seal_evidence_record'].sort(),
    );
    expect(events.some((e) => e.kind === 'terminal_action_abandoned')).toBe(false);
    expect(session.hasEnded()).toBe(false);

    // The call is still fully alive afterward -- a stack of caught faults doesn't leave it in
    // some half-constructed state that a normal end() can't close out.
    expect(() => session.end('caller_ended')).not.toThrow();
    expect(session.hasEnded()).toBe(true);
  });

  it('fix round 2: a throwing terminal action that SUCCEEDS on retry still lets the other owed actions land, and the export is produced only after everything succeeds', async () => {
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const events: { kind: string; detail: unknown }[] = [];
    let freezeCalls = 0;
    const flakyMock: typeof mockToolResult = (name, args, seed, ctx) => {
      if (name === 'freeze_transaction_rail') {
        freezeCalls += 1;
        if (freezeCalls === 1) throw new Error('rail backend hiccup');
      }
      return mockToolResult(name, args, seed, ctx);
    };
    const { session, sent } = newSessionWithState(clock, aai, events, flakyMock);

    session.start();
    driveScenarioBIntoEvidence(session, aai, clock);

    // Drive the scenario the rest of the way to FREEZE, same three evidence tool.calls
    // session.test.ts's own Scenario B walk uses.
    clock.now = 51000;
    aai.emit({ type: 'tool.call', call_id: 't1', name: 'check_sso_context', arguments: { identity_id: session.last?.claimed_identity_id } });
    clock.now = 51500;
    aai.emit({ type: 'tool.call', call_id: 't2', name: 'get_request_history', arguments: { identity_id: session.last?.claimed_identity_id } });
    clock.now = 52000;
    aai.emit({ type: 'tool.call', call_id: 't3', name: 'verify_out_of_band', arguments: { identity_id: session.last?.claimed_identity_id } });

    expect(session.last?.verdict).toBe('FREEZE');
    // First tick after FREEZE: freeze_transaction_rail throws (attempt 1), but incident/
    // alert/seal are independent -- they still fire in the SAME pass, not blocked by
    // freeze's own failure.
    expect(session.logs.tools.some((t) => t.name === 'open_incident' && !t.result?.error)).toBe(true);
    expect(session.logs.tools.some((t) => t.name === 'alert_principal' && !t.result?.error)).toBe(true);
    expect(session.logs.tools.some((t) => t.name === 'seal_evidence_record' && !t.result?.error)).toBe(true);
    // freeze_transaction_rail's own failed attempt is logged too (evidence of what was tried).
    expect(session.logs.tools.some((t) => t.name === 'freeze_transaction_rail' && t.result?.error === 'internal_error')).toBe(true);
    // Not settled yet -- no export/countersign until freeze itself lands.
    expect(latestState(sent)?.forensic.export_hash).toBeNull();

    // Next tick (any AAI event) retries freeze -- this time it succeeds.
    clock.now = 53000;
    aai.emit({ type: 'transcript.user', item_id: 'c-extra', text: 'still there?' });

    expect(session.logs.tools.some((t) => t.name === 'freeze_transaction_rail' && !t.result?.error)).toBe(true);
    await session.whenIdle();
    expect(latestState(sent)?.forensic.export_hash).not.toBeNull();
  });

  it('fix round 2: a terminal action that fails MAX_TERMINAL_ACTION_ATTEMPTS times is abandoned -- no export ever, diagnostics records it, verdict stays exactly what it was before any terminal action was attempted', async () => {
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const events: { kind: string; detail: unknown }[] = [];
    const freezeAlwaysFails: typeof mockToolResult = (name, args, seed, ctx) => {
      if (name === 'freeze_transaction_rail') throw new Error('rail backend permanently down');
      return mockToolResult(name, args, seed, ctx);
    };
    const { session, sent } = newSessionWithState(clock, aai, events, freezeAlwaysFails);

    session.start();
    driveScenarioBIntoEvidence(session, aai, clock);
    clock.now = 51000;
    aai.emit({ type: 'tool.call', call_id: 't1', name: 'check_sso_context', arguments: { identity_id: session.last?.claimed_identity_id } });
    clock.now = 51500;
    aai.emit({ type: 'tool.call', call_id: 't2', name: 'get_request_history', arguments: { identity_id: session.last?.claimed_identity_id } });
    clock.now = 52000;
    aai.emit({ type: 'tool.call', call_id: 't3', name: 'verify_out_of_band', arguments: { identity_id: session.last?.claimed_identity_id } });

    expect(session.last?.verdict).toBe('FREEZE');
    const verdictBeforeActions = session.last?.verdict;

    // Two more ticks (attempts 2 and 3) -- freeze keeps failing every time.
    clock.now = 53000;
    aai.emit({ type: 'transcript.user', item_id: 'c-extra-1', text: 'hello?' });
    clock.now = 54000;
    aai.emit({ type: 'transcript.user', item_id: 'c-extra-2', text: 'still there?' });

    const abandoned = events.find((e) => e.kind === 'terminal_action_abandoned');
    expect((abandoned?.detail as { name: string } | undefined)?.name).toBe('freeze_transaction_rail');
    expect((abandoned?.detail as { attempts: number } | undefined)?.attempts).toBe(3);

    // A fourth tick proves it's truly abandoned, not just slow -- no further attempt.
    const freezeAttemptsBefore = session.logs.tools.filter((t) => t.name === 'freeze_transaction_rail').length;
    clock.now = 55000;
    aai.emit({ type: 'transcript.user', item_id: 'c-extra-3', text: 'one more' });
    expect(session.logs.tools.filter((t) => t.name === 'freeze_transaction_rail').length).toBe(freezeAttemptsBefore);

    // Never exported, never countersigned -- and the verdict this call shows is EXACTLY what
    // it was before any terminal action was ever attempted (LAW 2/3: an incomplete
    // containment step must never look complete).
    await session.whenIdle();
    expect(latestState(sent)?.forensic.export_hash).toBeNull();
    expect(latestState(sent)?.verdict).toBe(verdictBeforeActions);
    expect(session.last?.verdict).toBe(verdictBeforeActions);
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

  async function start(opts: { diagnostics_post_timeout_ms?: number } = {}): Promise<{
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
      ...(opts.diagnostics_post_timeout_ms !== undefined ? { diagnostics_post_timeout_ms: opts.diagnostics_post_timeout_ms } : {}),
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
  async function startAndAttach(opts: { diagnostics_post_timeout_ms?: number } = {}): Promise<{
    base: string;
    session_id: string;
    ws: WebSocket;
  }> {
    const { base, wsBase } = await start(opts);
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

  // Fix round 1 (IMPORTANT review finding): per-event size caps, end to end over real HTTP.
  it('POST 400s a single event whose kind or detail exceeds the per-event cap', async () => {
    const { base, session_id, ws } = await startAndAttach();

    const longKind = await fetch(`${base}/api/session/${session_id}/diagnostics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: [{ t_ms: 1, kind: 'x'.repeat(65) }] }),
    });
    expect(longKind.status).toBe(400);

    const bigDetail = await fetch(`${base}/api/session/${session_id}/diagnostics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: [{ t_ms: 1, kind: 'x', detail: { blob: 'x'.repeat(2000) } }] }),
    });
    expect(bigDetail.status).toBe(400);
    ws.close();
  });

  // Fix round 1 (IMPORTANT review finding): the SESSION-WIDE cumulative cap, end to end --
  // many individually-valid POSTs adding up must eventually 413, with a JSON reason, rather
  // than growing the bundle without bound.
  it('POST 413s once the session-wide cumulative event/byte budget is exhausted, across multiple POSTs', async () => {
    const { base, session_id, ws } = await startAndAttach();

    // One request, right at the per-request/session cap (500 == 500) -- accepted whole.
    const fill = await fetch(`${base}/api/session/${session_id}/diagnostics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: Array.from({ length: MAX_CLIENT_EVENTS_PER_REQUEST }, (_, i) => ({ t_ms: i, kind: 'x' })) }),
    });
    expect(fill.status).toBe(200);

    // The next POST -- individually well-formed, a single tiny event -- is rejected whole
    // because the SESSION is now full, with a JSON body naming why.
    const overflow = await fetch(`${base}/api/session/${session_id}/diagnostics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: [{ t_ms: 999, kind: 'one-more' }] }),
    });
    expect(overflow.status).toBe(413);
    const overflowBody = (await overflow.json()) as { error: string };
    expect(overflowBody.error).toBe('session_full');
    ws.close();
  });

  // Fix round 1 (IMPORTANT review finding): the per-session POST rate limit, end to end.
  it('POST 429s once MAX_CLIENT_POSTS_PER_MINUTE is exceeded for one session', async () => {
    const { base, session_id, ws } = await startAndAttach();

    const post = () =>
      fetch(`${base}/api/session/${session_id}/diagnostics`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: [{ t_ms: 1, kind: 'x' }] }),
      });

    for (let i = 0; i < MAX_CLIENT_POSTS_PER_MINUTE; i++) {
      const res = await post();
      expect(res.status).toBe(200);
    }
    const limited = await post();
    expect(limited.status).toBe(429);
    const limitedBody = (await limited.json()) as { error: string };
    expect(limitedBody.error).toBe('rate_limited');
    ws.close();
  });

  // Fix round 1 (MINOR review finding): the explicit read-body timeout, end to end -- a body
  // that trickles in below the byte cap but never actually finishes must not hang the
  // request forever; a short configured timeout (this test overrides the 10s default) means
  // the server gives up and answers 408 instead.
  it('POST 408s a body that never finishes arriving, past the configured timeout', async () => {
    const { base, session_id, ws } = await startAndAttach({ diagnostics_post_timeout_ms: 100 });

    const url = new URL(`${base}/api/session/${session_id}/diagnostics`);
    const clientReq = httpRequest(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: { 'Content-Type': 'application/json' } },
    );
    // Write a partial, syntactically-incomplete JSON body and never call `.end()` -- a
    // slow/stalled client, not a malformed-but-complete one (that's the 400 test's job).
    clientReq.write('{"events":[{"t_ms":1,"kind":"x"');

    const res = await new Promise<{ statusCode: number | undefined }>((resolve, reject) => {
      clientReq.once('response', (r) => resolve({ statusCode: r.statusCode }));
      clientReq.once('error', reject);
    });
    expect(res.statusCode).toBe(408);

    clientReq.destroy();
    ws.close();
  });
});
