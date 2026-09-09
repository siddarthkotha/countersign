// packages/server/test/session-evaluate-diag-detail.test.ts
// PROVEN gap (founder, 2026-09-09): the flight recorder's 'evaluate' diagnostic event only
// ever recorded { verdict, state }. When a live call ends on the wrong verdict, nobody can
// tell from the bundle which assurance-checklist item was false, which rule table row fired,
// or which evidence cards flagged -- it had to be reconstructed by hand twice in one week.
// This test drives a real transition (INTAKE -> CLAIM, via the real engine/MERIDIAN seed,
// same transcript line session-audio-tick.test.ts already proves moves the FSM) and asserts
// the diagnostics 'evaluate' event recorded for that transition carries the richer detail:
// rule_row, assurance (item name -> boolean), evidence cards ({id, kind, status} only -- no
// quotes, no facts, no transcript text -- LAW 4: this is diagnostics, never evidence), the
// challenge counters, and the per-field readback confirmation status.
import { describe, it, expect } from 'vitest';
import { MERIDIAN, mockToolResult } from '@countersign/engine';
import type { CallContext, ServerEvent } from '@countersign/engine';
import { CallSession } from '../src/call/session.js';
import { FakeAaiSocket } from '../src/aai/fake.js';

const CALL: CallContext = { session_id: 'sess-diag-detail', origin_kind: 'unverified_voip', origin_geo: 'unknown' };

function newSessionWithDiagnostics() {
  const clock = { now: 0 };
  const aai = new FakeAaiSocket();
  const sent: ServerEvent[] = [];
  const diagnostics: { kind: string; detail: unknown }[] = [];
  const session = new CallSession({
    session_id: CALL.session_id,
    seed: MERIDIAN,
    call: CALL,
    aai,
    now: () => clock.now,
    onServerEvent: (e) => sent.push(e),
    mock: mockToolResult,
    onDiagnostic: (kind, detail) => diagnostics.push({ kind, detail }),
  });
  return { clock, aai, sent, diagnostics, session };
}

describe('CallSession -- evaluate diagnostics detail carries transition context', () => {
  it('records rule_row, assurance, evidence cards, challenge counters and readback on a transition', () => {
    const { clock, aai, diagnostics, session } = newSessionWithDiagnostics();

    session.start(); // one tick from start(), state INTAKE, verdict PENDING

    clock.now += 10;
    // PROVEN (session-audio-tick.test.ts) to move INTAKE -> CLAIM against the real engine.
    aai.emit({ type: 'transcript.user', item_id: 'u1', text: 'This is Robert Miller.' });

    const evaluateEvents = diagnostics.filter((d) => d.kind === 'evaluate');
    expect(evaluateEvents.length).toBeGreaterThanOrEqual(2);
    const last = evaluateEvents[evaluateEvents.length - 1]!.detail as {
      verdict: string;
      state: string;
      rule_row: number;
      assurance: Record<string, boolean>;
      evidence: { id: string; kind: string; status: string }[];
      challenges: { issued: number; passed: number; failed: number };
      readback: Record<string, boolean>;
    };

    // The transition itself: state actually changed (this is what makes it worth recording
    // the richer detail on, per the founder's ruling).
    expect(last.state).toBe('CLAIM');

    // rule row: a specific table row (1-13), not the placeholder invariant-override 0.
    expect(typeof last.rule_row).toBe('number');
    expect(last.rule_row).toBeGreaterThan(0);

    // assurance: the full checklist, every item a real boolean (not a summary/count).
    expect(last.assurance).toHaveProperty('identity_claimed');
    expect(typeof last.assurance.identity_claimed).toBe('boolean');

    // evidence cards: small shape only -- id/kind/status, never quotes or facts or text.
    expect(last.evidence.length).toBeGreaterThan(0);
    for (const card of last.evidence) {
      expect(Object.keys(card).sort()).toEqual(['id', 'kind', 'status']);
    }

    // challenge counters: issued/passed/failed, all numbers.
    expect(last.challenges).toEqual({ issued: expect.any(Number), passed: expect.any(Number), failed: expect.any(Number) });

    // per-field readback confirmation status: a map, every value a boolean.
    expect(Object.keys(last.readback).length).toBeGreaterThan(0);
    for (const confirmed of Object.values(last.readback)) {
      expect(typeof confirmed).toBe('boolean');
    }

    // LAW 4 -- this is diagnostics, never evidence: no raw transcript text or verbatim quotes
    // anywhere in the recorded detail.
    expect(JSON.stringify(last)).not.toContain('This is Robert Miller');
  });
});
