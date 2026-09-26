// packages/server/test/challenge-reask-reword.test.ts
// NEVER-BYTE-IDENTICAL-REASK safety net (2026-09-25, founder live defect P0 -- PROVEN:
// scripts/rehearse/reports/founder-2026-09-25/140b3584-b8c7-4f09-a1c5-1c930ba44859
// .diagnostics.json). Live timeline (server clock): 49.08s agent asks the LIVE_COMMITMENT
// deadline challenge "Can you restate the deadline you gave me earlier?"; 54.48s caller
// answers "Right now."; NO evaluate event follows (the engine's own extraction gap -- fixed
// at the root in packages/engine/src/extract/claims.ts's DEADLINE_IMMEDIATE_RE, see that
// file's own doc comment and packages/engine/test/challenges.test.ts's "FOUNDER LIVE DEFECT"
// describe block); 58.74s the agent speaks the BYTE-IDENTICAL question again. This file tests
// the DEFENSE-IN-DEPTH safety net on TOP of the root-cause fix: `CallSession.nextSpokenLine()`
// (session.ts) must never speak a challenge sentence that byte-for-byte repeats the agent's own
// immediately-preceding turn once a caller turn has landed in between -- whatever the reason the
// engine's goal failed to advance. Imports the REAL CallSession (LAW: never a copy, never the
// live API) and drives it with direct-state construction, the same technique
// session-endpoint-mode.test.ts's own CLOSE describe block already uses (see its doc comment):
// this isolates the mechanism itself rather than re-deriving a full live conversation just to
// reach the same ASK_CHALLENGE goal that file already covers driving for real.
import { describe, it, expect } from 'vitest';
import { MERIDIAN, mockToolResult } from '@countersign/engine';
import type { CallContext, ChallengeSpec, ServerEvent } from '@countersign/engine';
import { CallSession } from '../src/call/session.js';
import { FakeAaiSocket } from '../src/aai/fake.js';
import { CHALLENGE_REASK_REWORD_LINE } from '../src/brain/spokenLines.js';

const CALL: CallContext = { session_id: 'sess-reask-reword', origin_kind: 'unverified_voip', origin_geo: 'unknown' };

const DEADLINE_CHALLENGE: ChallengeSpec = {
  challenge_id: 'sess-reask-reword-2',
  kind: 'LIVE_COMMITMENT',
  field: 'deadline',
  ask: 'Ask the caller to restate the deadline they gave earlier. Do not say the value yourself.',
  speak: 'Can you restate the deadline you gave me earlier?',
  expect: { commitment_claim_id: 'c-dl' },
};

function newSession(): { session: CallSession; aai: FakeAaiSocket; sent: ServerEvent[] } {
  const aai = new FakeAaiSocket();
  const sent: ServerEvent[] = [];
  const session = new CallSession({
    session_id: CALL.session_id,
    seed: MERIDIAN,
    call: CALL,
    aai,
    now: () => 0,
    onServerEvent: (e) => sent.push(e),
    mock: mockToolResult,
    brainMode: 'endpoint',
  });
  session.start();
  return { session, aai, sent };
}

/** Forces `session.last.goal` to ASK_CHALLENGE for `DEADLINE_CHALLENGE`, and pushes the agent's
 *  own utterance for it directly into `logs.conversation` -- the same log a real `transcript.
 *  agent` dispatch would populate (dispatchAaiEvent's `transcript.user`/`transcript.agent` case,
 *  session.ts). Accessing `logs` through a narrow internal cast is the same technique this
 *  file's sibling (session-endpoint-mode.test.ts) uses for `dispatchAaiEvent` directly. */
function forceAskChallengeSpokenAt(session: CallSession, text: string, t_ms: number): void {
  session.last = {
    ...session.last!,
    goal: { code: 'ASK_CHALLENGE', hint: DEADLINE_CHALLENGE.ask, challenge: DEADLINE_CHALLENGE, keyterms: [], turn_detection_hint: 'patient' },
  };
  const internals = session as unknown as { logs: { conversation: { id: string; speaker: string; text: string; t_ms: number }[] } };
  internals.logs.conversation.push({ id: `agent-${t_ms}`, speaker: 'agent', text, t_ms });
}

function forceCallerTurnAt(session: CallSession, text: string, t_ms: number): void {
  const internals = session as unknown as { logs: { conversation: { id: string; speaker: string; text: string; t_ms: number }[] } };
  internals.logs.conversation.push({ id: `caller-${t_ms}`, speaker: 'caller', text, t_ms });
}

describe('CallSession#nextSpokenLine — NEVER-BYTE-IDENTICAL-REASK safety net (ASK_CHALLENGE only)', () => {
  it('the founder-2026-09-25 shape: challenge spoken, caller answers, goal never advances (the underlying gap this net defends against) -- the SECOND render is reworded, never the byte-identical question', () => {
    const { session } = newSession();

    // 49.08s: the challenge is asked and actually spoken (recorded in the conversation log,
    // exactly as a real transcript.agent dispatch would).
    forceAskChallengeSpokenAt(session, DEADLINE_CHALLENGE.speak!, 49_082);
    expect(session.nextSpokenLine()).toBe(DEADLINE_CHALLENGE.speak);

    // 54.48s: the caller answers -- "Right now." in the live record -- but the goal (forced
    // here to simulate whatever gap left it unresolved) never advances off the SAME challenge.
    forceCallerTurnAt(session, 'Right now.', 54_485);

    // The engine's own goal is unchanged (still the identical ASK_CHALLENGE rendering) -- this
    // is exactly the shape `nextSpokenLine()` would otherwise re-render byte-identical.
    const secondLine = session.nextSpokenLine();
    expect(secondLine).not.toBe(DEADLINE_CHALLENGE.speak);
    expect(secondLine).toBe(CHALLENGE_REASK_REWORD_LINE);
    // LAW 3: the reword never leaks the field name or the expected value.
    expect(secondLine!.toLowerCase()).not.toContain('deadline');
    expect(secondLine!.toLowerCase()).not.toContain('10 minutes');
  });

  it('never fires with NO caller turn in between -- repeated calls before anything new happens still return the SAME (real) sentence, unchanged (nextSpokenLine stays read-only/idempotent)', () => {
    const { session } = newSession();
    forceAskChallengeSpokenAt(session, DEADLINE_CHALLENGE.speak!, 49_082);

    const a = session.nextSpokenLine();
    const b = session.nextSpokenLine();
    const c = session.nextSpokenLine();
    expect(a).toBe(DEADLINE_CHALLENGE.speak);
    expect(b).toBe(DEADLINE_CHALLENGE.speak);
    expect(c).toBe(DEADLINE_CHALLENGE.speak);
  });

  it('a DIFFERENT challenge sentence (the goal genuinely moved on) is spoken normally, never reworded, even with caller turns in between', () => {
    const { session } = newSession();
    forceAskChallengeSpokenAt(session, DEADLINE_CHALLENGE.speak!, 49_082);
    forceCallerTurnAt(session, 'Right now.', 54_485);
    expect(session.nextSpokenLine()).toBe(CHALLENGE_REASK_REWORD_LINE);

    // The engine genuinely advances to a NEW challenge (a different sentence) -- this is not a
    // repeat, and must be spoken exactly as composed, never reworded.
    const nextChallenge: ChallengeSpec = { ...DEADLINE_CHALLENGE, challenge_id: 'sess-reask-reword-3', speak: 'Which law firm is our counsel of record on this deal?' };
    session.last = { ...session.last!, goal: { code: 'ASK_CHALLENGE', hint: nextChallenge.ask, challenge: nextChallenge, keyterms: [], turn_detection_hint: 'patient' } };
    expect(session.nextSpokenLine()).toBe(nextChallenge.speak);
  });
});

// EXTENDED (2026-09-25, judge-dana defect -- PROVEN: scripts/rehearse/reports/
// 2026-09-25T22-31-41-judge-dana.diagnostics.json/.md): "Who is the beneficiary of this
// payment?" (ELICIT_MISSING_CRITICAL) was spoken byte-identically six times in a row while
// the caller answered "Meridian Supply." every time (the root cause -- the answer never
// becoming a claim -- is fixed separately in packages/engine/src/extract/claims.ts's
// `extractElicitAnswerName` and ledger.ts's `activePersonElicit`, which stops the FIELD
// from staying missing after the caller's first bare-name answer). This is the
// defense-in-depth net for ELICIT_MISSING_CRITICAL specifically (the founder's own
// question 3: "why did the byte-identical re-ask guard not reword it -- does it cover
// ASK_CHALLENGE only?" -- yes, it did, and still does for READBACK/RE_ELICIT_AFTER_SWITCH,
// which keep their own tuned re-ask/exhaustion caps and a legitimate reason to repeat exact
// confirmation wording; ELICIT_MISSING_CRITICAL has neither -- a missing field is either
// claimed, engine-side stopping the elicit, or it is not, so a THIRD byte-identical render
// is never legitimate): whatever future gap leaves a field looking missing despite a real
// answer, this net still guarantees the caller is never asked the identical question a
// third time running.
function forceElicitSpokenAt(session: CallSession, field: 'beneficiary', text: string, t_ms: number): void {
  session.last = {
    ...session.last!,
    goal: { code: 'ELICIT_MISSING_CRITICAL', hint: text, keyterms: [], turn_detection_hint: 'patient', elicit: { field } },
  };
  const internals = session as unknown as { logs: { conversation: { id: string; speaker: string; text: string; t_ms: number }[] } };
  internals.logs.conversation.push({ id: `agent-${t_ms}`, speaker: 'agent', text, t_ms });
}

const BENEFICIARY_ELICIT_HINT = 'Who is the beneficiary of this payment?';

describe('CallSession#nextSpokenLine — NEVER-BYTE-IDENTICAL-REASK safety net (ELICIT_MISSING_CRITICAL)', () => {
  it('the judge-dana shape: elicit spoken, caller answers, the field never advances -- the SECOND identical render is reworded, never byte-identical', () => {
    const { session } = newSession();
    forceElicitSpokenAt(session, 'beneficiary', BENEFICIARY_ELICIT_HINT, 75_338);
    expect(session.nextSpokenLine()).toBe(BENEFICIARY_ELICIT_HINT);

    forceCallerTurnAt(session, 'Meridian Supply.', 89_397);

    const secondLine = session.nextSpokenLine();
    expect(secondLine).not.toBe(BENEFICIARY_ELICIT_HINT);
    expect(secondLine).toBe(CHALLENGE_REASK_REWORD_LINE);
  });

  it('never fires with NO caller turn in between', () => {
    const { session } = newSession();
    forceElicitSpokenAt(session, 'beneficiary', BENEFICIARY_ELICIT_HINT, 75_338);
    expect(session.nextSpokenLine()).toBe(BENEFICIARY_ELICIT_HINT);
    expect(session.nextSpokenLine()).toBe(BENEFICIARY_ELICIT_HINT);
  });

  it('a DIFFERENT elicit (the goal genuinely moved on to a new field) is spoken normally, never reworded', () => {
    const { session } = newSession();
    forceElicitSpokenAt(session, 'beneficiary', BENEFICIARY_ELICIT_HINT, 75_338);
    forceCallerTurnAt(session, 'Meridian Supply.', 89_397);
    expect(session.nextSpokenLine()).toBe(CHALLENGE_REASK_REWORD_LINE);

    session.last = {
      ...session.last!,
      goal: {
        code: 'ELICIT_MISSING_CRITICAL',
        hint: 'What is the exact amount for this payment?',
        keyterms: [],
        turn_detection_hint: 'patient',
        elicit: { field: 'amount_usd' },
      },
    };
    expect(session.nextSpokenLine()).toBe('What is the exact amount for this payment?');
  });
});
