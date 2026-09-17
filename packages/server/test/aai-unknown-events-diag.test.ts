// packages/server/test/aai-unknown-events-diag.test.ts
// Finding 1 (2026-09-16 dead-transcript investigation -- dead-transcripts lane):
// `mapServerEvent`'s `default` branch (aai/session.ts) silently drops any AssemblyAI server
// message this adapter does not model, recording only a bare running total on
// `RealAaiSocket.stats().unknown_events` -- no type name, no detail. Before this fix, the
// ONLY place `call/session.ts` ever read that total was `end()`, once, after the call was
// already over, so a still-running call's diagnostics bundle never showed a drop as it
// happened. Two PROVEN live failures (scripts/rehearse/reports/2026-09-16T17-50-00-miller-
// patient and .../19-31-28-dana-patient) had a 9.3-9.5s reply with real audio and no agent
// transcript, after which the agent-transcript channel never recovered for the rest of the
// call -- zero `session.error`/thrown-exception diagnostics either -- exactly the shape an
// unmodeled/dropped server message would produce, and exactly what `stats().unknown_events`
// exists to surface. This file proves `CallSession` now checks it on every dispatched AAI
// event (`checkAaiUnknownEvents`, called from `handleAaiEvent`), not only once at `end()`,
// and that the check is a harmless no-op for any `AaiSocket` that doesn't implement `stats()`
// at all (FakeAaiSocket, and -- PROVEN separately, see that field's own doc comment in
// session.ts -- index.ts's real `PendingAaiSocket` wrapper today).
import { describe, it, expect } from 'vitest';
import { MERIDIAN, mockToolResult } from '@countersign/engine';
import type { CallContext, ServerEvent } from '@countersign/engine';
import { CallSession } from '../src/call/session.js';
import type { AaiEvent, AaiSocket } from '../src/aai/types.js';
import scenarioB from '../../engine/corpus/scenario-b-miller-fraud.json' with { type: 'json' };

const CALL_B = scenarioB.call as CallContext;

/** A minimal `AaiSocket` test double that DOES implement the optional `stats()` method, with
 *  a running `unknown_events` count the test controls directly (`bumpUnknownEvents`) --
 *  standing in for what `RealAaiSocket.stats()` (aai/session.ts) reports once a real drop
 *  has happened, without needing a live AssemblyAI connection (LAW: tests never call the
 *  live API). */
class StubAaiSocketWithStats implements AaiSocket {
  private handlers: ((evt: AaiEvent) => void)[] = [];
  private unknownEvents = 0;

  send(_msg: object): void {
    // Not exercised by this test -- only inbound events and stats() matter here.
  }

  on(handler: (evt: AaiEvent) => void): void {
    this.handlers.push(handler);
  }

  close(): void {
    // No-op: nothing here to tear down.
  }

  emit(evt: AaiEvent): void {
    for (const h of this.handlers) h(evt);
  }

  bumpUnknownEvents(by: number): void {
    this.unknownEvents += by;
  }

  stats(): { unknown_events: number } {
    return { unknown_events: this.unknownEvents };
  }
}

/** The counterpart with NO `stats()` at all -- mirrors both `FakeAaiSocket` (aai/fake.ts) and,
 *  PROVEN separately (see session.ts's `lastKnownAaiUnknownEvents` doc comment), `index.ts`'s
 *  real `PendingAaiSocket` wrapper, which implements only `send`/`on`/`close`. */
class StubAaiSocketNoStats implements AaiSocket {
  private handlers: ((evt: AaiEvent) => void)[] = [];

  send(_msg: object): void {}

  on(handler: (evt: AaiEvent) => void): void {
    this.handlers.push(handler);
  }

  close(): void {}

  emit(evt: AaiEvent): void {
    for (const h of this.handlers) h(evt);
  }
}

function newSession(
  aai: AaiSocket,
  sent: ServerEvent[],
  diagEvents: { kind: string; detail: unknown }[]
): CallSession {
  return new CallSession({
    session_id: CALL_B.session_id,
    seed: MERIDIAN,
    call: CALL_B,
    aai,
    now: () => 0,
    onServerEvent: (e) => sent.push(e),
    mock: mockToolResult,
    onDiagnostic: (kind, detail) => diagEvents.push({ kind, detail }),
  });
}

describe('finding 1 (2026-09-16): AssemblyAI messages this adapter never modeled are surfaced to diagnostics', () => {
  it('logs aai_unknown_events with the DELTA the moment stats() first shows a drop, on the very next dispatched event -- not only at end()', () => {
    const aai = new StubAaiSocketWithStats();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newSession(aai, sent, diagEvents);
    session.start();

    // Nothing dropped yet -- no diagnostic.
    expect(diagEvents.some((e) => e.kind === 'aai_unknown_events')).toBe(false);

    // AssemblyAI silently drops two messages this adapter doesn't model (e.g.
    // transcript.agent.delta, session.updated) between two events it DOES model.
    aai.bumpUnknownEvents(2);

    // The very next dispatched event (a real caller transcript, nothing to do with the drop
    // itself) is what surfaces it -- proving this no longer waits for the call to end.
    aai.emit({ type: 'transcript.user', item_id: 'c1', text: scenarioB.conversation[0]!.text });

    const first = diagEvents.filter((e) => e.kind === 'aai_unknown_events');
    expect(first).toHaveLength(1);
    expect(first[0]!.detail).toEqual({ unknown_events: 2, new_since_last_check: 2 });

    // A second, later drop is reported as its OWN delta (1), never re-reporting the 2 already
    // seen -- this is what lets a live bundle count actual new drops instead of a running
    // total that looks the same on every check.
    aai.bumpUnknownEvents(1);
    aai.emit({ type: 'reply.started', reply_id: 'a1' });
    const second = diagEvents.filter((e) => e.kind === 'aai_unknown_events');
    expect(second).toHaveLength(2);
    expect(second[1]!.detail).toEqual({ unknown_events: 3, new_since_last_check: 1 });

    // Dispatching an event with NO new drop in between logs nothing further.
    aai.emit({ type: 'reply.done', reply_id: 'a1', status: 'completed' });
    expect(diagEvents.filter((e) => e.kind === 'aai_unknown_events')).toHaveLength(2);
  });

  it('is a harmless no-op for an AaiSocket with no stats() at all (FakeAaiSocket today, and PROVEN separately index.ts\'s real PendingAaiSocket)', () => {
    const aai = new StubAaiSocketNoStats();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newSession(aai, sent, diagEvents);
    session.start();

    aai.emit({ type: 'transcript.user', item_id: 'c1', text: scenarioB.conversation[0]!.text });
    aai.emit({ type: 'reply.started', reply_id: 'a1' });
    aai.emit({ type: 'reply.done', reply_id: 'a1', status: 'completed' });

    expect(diagEvents.some((e) => e.kind === 'aai_unknown_events')).toBe(false);
  });
});
