// packages/server/test/aai-observability-diag.test.ts
// aai-observability lane (2026-09-16, dead-transcript investigation finding 1 continued):
// two live calls today (scripts/rehearse/reports/2026-09-16T17-50-00-miller-patient and
// .../19-31-28-dana-patient, both gitignored) lost every agent transcript mid-call, with
// zero `aai_unknown_events` diagnostics (index.ts's real `PendingAaiSocket` implemented no
// `stats()`, so `CallSession.checkAaiUnknownEvents`'s check was always a silent no-op live)
// and no other error signal at all. The best-fit hypothesis: the final `transcript.agent`
// event for one reply never arrived (a delta-only or dropped-finalize case) and the call
// never recovered.
//
// This file proves the two new CallSession-side diagnostics that close that blindness:
//  1. `aai_unhandled_message` (item 1): every server message `aai/session.ts`'s
//     `mapServerEvent` does not model at all reaches CallSession via
//     `AaiSocket.onUnhandledMessage` (driven here through `FakeAaiSocket`, per this task's
//     own item 4 -- "keep FakeAaiSocket in step so tests can emit an unknown message type
//     and a delta"), rate-limited per type (first `UNHANDLED_MESSAGE_LOG_CAP` logged
//     individually, then one `_capped` notice, then one true-total `_summary` at `end()`).
//  2. `aai_transcript_deltas` (item 3): `transcript.agent.delta` chunks (via
//     `AaiSocket.onAgentTranscriptDelta`) are aggregated per reply id and, ONLY when a
//     reply's own `reply.done` fires with no non-empty final transcript ever recorded for
//     it, surfaced as one diagnostic proving whether the words were on the wire as deltas.
import { describe, it, expect } from 'vitest';
import { MERIDIAN, mockToolResult } from '@countersign/engine';
import type { CallContext, ServerEvent } from '@countersign/engine';
import { CallSession } from '../src/call/session.js';
import { FakeAaiSocket } from '../src/aai/fake.js';
import scenarioB from '../../engine/corpus/scenario-b-miller-fraud.json' with { type: 'json' };

const CALL_B = scenarioB.call as CallContext;

function newSession(aai: FakeAaiSocket, sent: ServerEvent[], diagEvents: { kind: string; detail: unknown }[]): CallSession {
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

describe('aai_unhandled_message (aai-observability lane, 2026-09-16, item 1)', () => {
  it('logs aai_unhandled_message with {type, detail} for a message FakeAaiSocket reports as unhandled (excluding known-ignored types)', () => {
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newSession(aai, sent, diagEvents);
    session.start();

    aai.emitUnhandledMessage('some.unknown.type', '{"type":"some.unknown.type"}');

    const entries = diagEvents.filter((e) => e.kind === 'aai_unhandled_message');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.detail).toEqual({ type: 'some.unknown.type', detail: '{"type":"some.unknown.type"}' });
  });

  it('rate-limits per type: the first 20 occurrences of a type each log individually, the 21st logs one _capped notice, and nothing further logs live', () => {
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newSession(aai, sent, diagEvents);
    session.start();

    for (let i = 0; i < 25; i++) {
      aai.emitUnhandledMessage('some.unknown.type', `{"n":${i}}`);
    }

    const logged = diagEvents.filter((e) => e.kind === 'aai_unhandled_message');
    expect(logged).toHaveLength(20);
    const capped = diagEvents.filter((e) => e.kind === 'aai_unhandled_message_capped');
    expect(capped).toHaveLength(1);
    expect(capped[0]!.detail).toEqual({ type: 'some.unknown.type' });
  });

  it('rate-limits independently per type -- a second, rare type is never capped by the first type crossing its own cap', () => {
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newSession(aai, sent, diagEvents);
    session.start();

    for (let i = 0; i < 25; i++) aai.emitUnhandledMessage('some.unknown.type.a', `{"n":${i}}`);
    aai.emitUnhandledMessage('some.unknown.type.b', '{"rare":true}');

    expect(diagEvents.filter((e) => e.kind === 'aai_unhandled_message_capped')).toHaveLength(1);
    const other = diagEvents.filter((e) => e.kind === 'aai_unhandled_message' && (e.detail as { type: string }).type === 'some.unknown.type.b');
    expect(other).toHaveLength(1);
  });

  it('records a true-total summary per type at end(), including a type that never crossed the cap', () => {
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newSession(aai, sent, diagEvents);
    session.start();

    for (let i = 0; i < 25; i++) aai.emitUnhandledMessage('some.unknown.type.a', `{"n":${i}}`);
    aai.emitUnhandledMessage('some.unknown.type.b', '{}');
    aai.emitUnhandledMessage('some.unknown.type.b', '{}');

    expect(diagEvents.some((e) => e.kind === 'aai_unhandled_message_summary')).toBe(false);

    session.end('caller_ended');

    const summaries = diagEvents.filter((e) => e.kind === 'aai_unhandled_message_summary');
    expect(summaries).toContainEqual({ kind: 'aai_unhandled_message_summary', detail: { type: 'some.unknown.type.a', total: 25 } });
    expect(summaries).toContainEqual({ kind: 'aai_unhandled_message_summary', detail: { type: 'some.unknown.type.b', total: 2 } });
  });

  it('never logs aai_unhandled_message for a transcript.agent.delta emitted through the dedicated delta channel', () => {
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newSession(aai, sent, diagEvents);
    session.start();

    aai.emitAgentDelta('a1', 'hi');

    expect(diagEvents.some((e) => e.kind === 'aai_unhandled_message')).toBe(false);
  });
});

describe('aai_transcript_deltas (aai-observability lane, 2026-09-16, item 3)', () => {
  it('logs aai_transcript_deltas at reply.done when the reply ended with NO final transcript, aggregating count/length/tail', () => {
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newSession(aai, sent, diagEvents);
    session.start();

    aai.emit({ type: 'reply.started', reply_id: 'a1' });
    // The dead-transcript incident's own shape: real audio, real deltas, but no final
    // transcript.agent event ever arrives for this reply.
    aai.emitAgentDelta('a1', 'The ');
    aai.emitAgentDelta('a1', 'transaction ');
    aai.emitAgentDelta('a1', 'has been staged.');
    aai.emit({ type: 'reply.done', reply_id: 'a1', status: 'completed' });

    const entries = diagEvents.filter((e) => e.kind === 'aai_transcript_deltas');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.detail).toEqual({
      reply_id: 'a1',
      delta_count: 3,
      delta_total_length: 'The '.length + 'transaction '.length + 'has been staged.'.length,
      last_chars: 'The transaction has been staged.',
    });
  });

  it('does NOT log aai_transcript_deltas when a non-empty final transcript.agent arrived for the reply', () => {
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newSession(aai, sent, diagEvents);
    session.start();

    aai.emit({ type: 'reply.started', reply_id: 'a1' });
    aai.emitAgentDelta('a1', 'Hello.');
    aai.emit({ type: 'transcript.agent', item_id: 'a1', text: 'Hello.', reply_id: 'a1', interrupted: false });
    aai.emit({ type: 'reply.done', reply_id: 'a1', status: 'completed' });

    expect(diagEvents.some((e) => e.kind === 'aai_transcript_deltas')).toBe(false);
  });

  it('does NOT log aai_transcript_deltas for a reply with no delta traffic at all (an ordinary empty reply, not this finding)', () => {
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newSession(aai, sent, diagEvents);
    session.start();

    aai.emit({ type: 'reply.started', reply_id: 'a1' });
    aai.emit({ type: 'reply.done', reply_id: 'a1', status: 'completed' });

    expect(diagEvents.some((e) => e.kind === 'aai_transcript_deltas')).toBe(false);
  });

  it('truncates last_chars to the trailing 120 characters across many small chunks', () => {
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newSession(aai, sent, diagEvents);
    session.start();

    aai.emit({ type: 'reply.started', reply_id: 'a1' });
    const chunk = '0123456789'; // 10 chars
    for (let i = 0; i < 20; i++) aai.emitAgentDelta('a1', chunk); // 200 chars total
    aai.emit({ type: 'reply.done', reply_id: 'a1', status: 'completed' });

    const entries = diagEvents.filter((e) => e.kind === 'aai_transcript_deltas');
    expect(entries).toHaveLength(1);
    const detail = entries[0]!.detail as { delta_count: number; delta_total_length: number; last_chars: string };
    expect(detail.delta_count).toBe(20);
    expect(detail.delta_total_length).toBe(200);
    expect(detail.last_chars).toHaveLength(120);
    expect(detail.last_chars).toBe(chunk.repeat(12)); // last 120 of 200 chars of a repeating 10-char pattern
  });

  it('treats a whitespace-only final transcript the same as no final transcript at all', () => {
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newSession(aai, sent, diagEvents);
    session.start();

    aai.emit({ type: 'reply.started', reply_id: 'a1' });
    aai.emitAgentDelta('a1', 'hi');
    aai.emit({ type: 'transcript.agent', item_id: 'a1', text: '   ', reply_id: 'a1', interrupted: false });
    aai.emit({ type: 'reply.done', reply_id: 'a1', status: 'completed' });

    expect(diagEvents.some((e) => e.kind === 'aai_transcript_deltas')).toBe(true);
  });

  it('scopes accounting per reply id -- a later, healthy reply is unaffected by an earlier dead one', () => {
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newSession(aai, sent, diagEvents);
    session.start();

    aai.emit({ type: 'reply.started', reply_id: 'a1' });
    aai.emitAgentDelta('a1', 'dead reply text');
    aai.emit({ type: 'reply.done', reply_id: 'a1', status: 'completed' });

    aai.emit({ type: 'reply.started', reply_id: 'a2' });
    aai.emitAgentDelta('a2', 'healthy reply');
    aai.emit({ type: 'transcript.agent', item_id: 'a2', text: 'healthy reply', reply_id: 'a2', interrupted: false });
    aai.emit({ type: 'reply.done', reply_id: 'a2', status: 'completed' });

    const entries = diagEvents.filter((e) => e.kind === 'aai_transcript_deltas');
    expect(entries).toHaveLength(1);
    expect((entries[0]!.detail as { reply_id: string }).reply_id).toBe('a1');
  });
});

describe('aai_unhandled_message_summary with known-ignored types (aai-observability lane, 2026-09-16, finding 2)', () => {
  it('never logs aai_unhandled_message for known-ignored types (session.updated, transcript.user.delta)', () => {
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newSession(aai, sent, diagEvents);
    session.start();

    aai.emitIgnoredMessage('session.updated');
    aai.emitIgnoredMessage('transcript.user.delta');

    expect(diagEvents.filter((e) => e.kind === 'aai_unhandled_message')).toHaveLength(0);
  });

  it('records known-ignored types in summary at end() with ignored: true flag', () => {
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newSession(aai, sent, diagEvents);
    session.start();

    aai.emitIgnoredMessage('session.updated');
    aai.emitIgnoredMessage('session.updated');
    aai.emitIgnoredMessage('transcript.user.delta');

    session.end('caller_ended');

    const summaries = diagEvents.filter((e) => e.kind === 'aai_unhandled_message_summary');
    expect(summaries).toContainEqual({
      kind: 'aai_unhandled_message_summary',
      detail: { type: 'session.updated', total: 2, ignored: true },
    });
    expect(summaries).toContainEqual({
      kind: 'aai_unhandled_message_summary',
      detail: { type: 'transcript.user.delta', total: 1, ignored: true },
    });
  });

  it('mixes unknown types and ignored types in the same summary', () => {
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newSession(aai, sent, diagEvents);
    session.start();

    aai.emitUnhandledMessage('some.unknown.type', '{}');
    aai.emitIgnoredMessage('session.updated');

    session.end('caller_ended');

    const summaries = diagEvents.filter((e) => e.kind === 'aai_unhandled_message_summary');
    expect(summaries).toHaveLength(2);
    expect(summaries).toContainEqual({
      kind: 'aai_unhandled_message_summary',
      detail: { type: 'some.unknown.type', total: 1 },
    });
    expect(summaries).toContainEqual({
      kind: 'aai_unhandled_message_summary',
      detail: { type: 'session.updated', total: 1, ignored: true },
    });
  });
});
