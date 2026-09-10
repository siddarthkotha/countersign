// packages/server/test/session-transcript-dedupe.test.ts
// Flight-recorder finding (2026-09-09, read-only review of aai/session.ts 198-254 + this
// file's transcript ingestion): the AAI leg has a bounded resume path (three attempts in 30
// seconds, re-sending session.resume with the prior session id), and transcript.user /
// transcript.agent events are pushed onto logs.conversation unconditionally, with no dedupe
// by item_id. A REPEATED delivery of the CURRENT value is a harmless no-op in the ledger
// (buildLedger only bumps request_version / classifies CONTRADICTED on a DIFFERENT value),
// but a redelivered STALE transcript -- an earlier value re-sent after a later correction --
// gets a fresh server timestamp, sorts after the correction, and can be misclassified
// CONTRADICTED with a spurious request_version bump. UNKNOWN whether AssemblyAI ever actually
// redelivers a transcript after a resume; this is cheap insurance either way.
//
// Ruling: a final transcript whose item_id has already been recorded for this session is
// ignored entirely -- not pushed onto conversation, not run through evaluate -- and a
// diagnostics event `transcript_duplicate_ignored` carrying {item_id, speaker} is recorded so
// the flight recorder shows it happened. Diagnostics vocabulary only (LAW 4): never the
// transcript text itself, never a verdict.
import { describe, it, expect } from 'vitest';
import { MERIDIAN, mockToolResult } from '@countersign/engine';
import type { CallContext, ServerEvent } from '@countersign/engine';
import { CallSession } from '../src/call/session.js';
import { FakeAaiSocket } from '../src/aai/fake.js';
import scenarioB from '../../engine/corpus/scenario-b-miller-fraud.json' with { type: 'json' };

const CALL_B = scenarioB.call as CallContext;

describe('CallSession -- duplicate transcript.* delivery (resume-redelivery insurance)', () => {
  it('ignores a redelivered transcript event whose item_id was already recorded, and records a diagnostic', () => {
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = new CallSession({
      session_id: CALL_B.session_id,
      seed: MERIDIAN,
      call: CALL_B,
      aai,
      now: () => clock.now,
      onServerEvent: (e) => sent.push(e),
      mock: mockToolResult,
      onDiagnostic: (kind, detail) => diagEvents.push({ kind, detail }),
    });

    session.start(); // INTAKE

    // c1: identity + the request, stating $1.8 million (scenario B's own opening line).
    const c1 = scenarioB.conversation[0]!; // { id: 'c1', speaker: 'caller', text: '...$1.8 million...' }
    clock.now = 1000;
    aai.emit({ type: 'transcript.user', item_id: c1.id, text: c1.text });

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

    // c3: the correction -- "...and make it $2.1 million." Classified CONTRADICTED (amount
    // jumped, not an approximate refinement) and bumps request_version to 2 -- this is the
    // real, legitimate correction the fix must not disturb.
    const c3 = scenarioB.conversation[4]!;
    clock.now = 40000;
    aai.emit({ type: 'transcript.user', item_id: c3.id, text: c3.text });

    const conversationLenAfterCorrection = session.logs.conversation.length;
    const requestVersionAfterCorrection = session.last?.request_version;
    const ledgerLenAfterCorrection = session.last?.ledger.length;
    expect(requestVersionAfterCorrection).toBe(2);
    expect(session.last?.ledger.some((c) => c.field === 'amount_usd' && c.kind === 'CONTRADICTED')).toBe(true);

    // The bounded resume redelivers the FIRST transcript event, with its ORIGINAL item_id
    // ('c1') and original text ($1.8 million) -- a stale value re-sent after the correction
    // already moved the current value to $2.1 million.
    clock.now = 41000;
    aai.emit({ type: 'transcript.user', item_id: c1.id, text: c1.text });

    // The redelivery must be a complete no-op on the logs and the engine's own state --
    // ignored before it ever reaches evaluate().
    expect(session.logs.conversation.length).toBe(conversationLenAfterCorrection);
    expect(session.last?.request_version).toBe(requestVersionAfterCorrection);
    expect(session.last?.ledger.length).toBe(ledgerLenAfterCorrection);
    expect(session.last?.ledger.filter((c) => c.field === 'amount_usd' && c.kind === 'CONTRADICTED')).toHaveLength(1);
    // No spurious second CONTRADICTED / STORY_INCONSISTENCY-driven reasons appear from the
    // redelivery alone (the real correction's own STORY_INCONSISTENCY, if any, is untouched).
    expect(session.last?.request_version).not.toBe(3);

    const dup = diagEvents.find((e) => e.kind === 'transcript_duplicate_ignored');
    expect(dup?.detail).toEqual({ item_id: c1.id, speaker: 'caller' });
  });
});
