// packages/server/test/question-reask-empty-bound.test.ts
// Fix (2026-09-16, PROVEN live failure -- deploy 41,
// scripts/rehearse/reports/2026-09-16T17-50-00-miller-patient.md +
// its .diagnostics.json): the agent asked "Which institution holds the Hartwell escrow?" at
// t=34374ms, then FOUR more replies ran back to back (34378-63256, ~29s), each with
// reply.started/reply.audio/reply.done but NO `transcript.agent` event at all -- and every one
// of the resulting `question_reask_sent` diagnostics logged `"attempt": 0`. The empty-reply
// forgiveness in `armQuestionReaskTimer` (added so a reply that genuinely said nothing still
// gets a free retry) cannot tell "the model said nothing" apart from "AssemblyAI never
// delivered a transcript event for whatever it said" -- `replyTranscripts.get(replyId) ?? ''`
// is empty either way, so `questionReaskCount` never advances and QUESTION_REASK_MAX (2) never
// actually bounds anything: the agent re-asks the same question forever, holding the floor for
// as long as AssemblyAI keeps failing to deliver a transcript, until the (unrelated) idle timer
// eventually ends the call 33 seconds later.
//
// Fix (session.ts): `questionReaskEmptyCount` bounds the FORGIVEN (empty-transcript) attempts
// separately, at `QUESTION_REASK_MAX_EMPTY` (2) -- once a rendering has been forgiven that many
// times with no transcript ever landing, `maybeReaskQuestion` gives up on it silently (same
// "no new escalation path" shape `QUESTION_REASK_MAX` already has), rather than reasking
// indefinitely.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MERIDIAN, mockToolResult } from '@countersign/engine';
import type { CallContext, ServerEvent } from '@countersign/engine';
import { CallSession } from '../src/call/session.js';
import { FakeAaiSocket } from '../src/aai/fake.js';
import scenarioB from '../../engine/corpus/scenario-b-miller-fraud.json' with { type: 'json' };

const CALL_B = scenarioB.call as CallContext;
const REASK_GAP_MS = 400; // CallSession.CLOSE_RETRY_MIN_GAP_MS, reused for the reask timer
const QUESTION_REASK_MAX_EMPTY = 2; // CallSession.QUESTION_REASK_MAX_EMPTY

function newLiveSession(
  clock: { now: number },
  call: CallContext,
  aai: FakeAaiSocket,
  sent: ServerEvent[],
  diagEvents: { kind: string; detail: unknown }[]
): CallSession {
  const session = new CallSession({
    session_id: call.session_id,
    seed: MERIDIAN,
    call,
    aai,
    now: () => clock.now,
    onServerEvent: (e) => sent.push(e),
    mock: mockToolResult,
    onDiagnostic: (kind, detail) => diagEvents.push({ kind, detail }),
  });
  session.start();
  return session;
}

describe('CallSession -- question reask gives up after a bounded number of empty/no-transcript replies (fix, 2026-09-16)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops reasking after QUESTION_REASK_MAX_EMPTY forgiven (transcript-less) replies, instead of forever', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newLiveSession(clock, CALL_B, aai, sent, diagEvents);

    clock.now = 1000;
    aai.emit({ type: 'transcript.user', item_id: 'c1', text: scenarioB.conversation[0]!.text });
    expect(session.last?.state).toBe('CHALLENGE');
    expect(session.last?.goal.code).toBe('ASK_CHALLENGE');
    expect(session.last?.goal.challenge?.challenge_id).toBe('sess-b-1');

    const replyCreates = () => aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create');
    const baseline = replyCreates().length; // c1's own fresh-question proactive send (Design E)

    // Simulate the live shape exactly: every reply gets reply.started + reply.audio + a
    // completed reply.done, but NEVER a transcript.agent event -- AssemblyAI stopped
    // delivering agent transcripts while still delivering audio.
    let t = 1500;
    let replyN = 0;
    function emitTranscriptlessReply(): void {
      replyN += 1;
      const replyId = `no-transcript-${replyN}`;
      clock.now = t;
      aai.emit({ type: 'reply.started', reply_id: replyId });
      aai.emit({ type: 'reply.audio', data: Buffer.alloc(100).toString('base64') });
      clock.now = t + 300;
      aai.emit({ type: 'reply.done', reply_id: replyId, status: 'completed' });
      t += 500;
    }

    // First reply (answers c1's own proactive send) -- no transcript at all.
    emitTranscriptlessReply();
    expect(session.logs.actions.some((a) => a.kind === 'challenge_issued')).toBe(false);

    // The spaced reask fires +400ms: this is empty-forgiven attempt #1.
    vi.advanceTimersByTime(REASK_GAP_MS);
    t += REASK_GAP_MS;
    expect(replyCreates().length).toBe(baseline + 1);
    expect(diagEvents.filter((e) => e.kind === 'question_reask_sent')).toHaveLength(1);
    // The engine's own goal never advanced -- the question was never actually put to the
    // caller (the bug this whole mechanism exists to prevent claiming, LAW 4's spirit).
    expect(session.last?.goal.challenge?.challenge_id).toBe('sess-b-1');

    // Second reply (answers reask #1) -- still no transcript.
    emitTranscriptlessReply();
    vi.advanceTimersByTime(REASK_GAP_MS);
    t += REASK_GAP_MS;
    expect(replyCreates().length).toBe(baseline + 2); // empty-forgiven attempt #2 (QUESTION_REASK_MAX_EMPTY)
    expect(diagEvents.filter((e) => e.kind === 'question_reask_sent')).toHaveLength(2);

    // Third, fourth, fifth reply -- still no transcript. The empty-forgiveness budget
    // (QUESTION_REASK_MAX_EMPTY = 2) is now exhausted: no further reply.create is EVER sent
    // for this rendering, no matter how many more transcript-less replies arrive. This is the
    // fix -- before it, this loop continued indefinitely (PROVEN: 4 such replies live, cut
    // short only by the unrelated idle timer 33s later, not by this mechanism).
    for (let i = 0; i < 3; i++) {
      emitTranscriptlessReply();
      vi.advanceTimersByTime(REASK_GAP_MS);
      t += REASK_GAP_MS;
    }
    expect(replyCreates().length).toBe(baseline + QUESTION_REASK_MAX_EMPTY); // still capped at 2
    expect(diagEvents.filter((e) => e.kind === 'question_reask_sent')).toHaveLength(QUESTION_REASK_MAX_EMPTY);
    // Still never claimed the question was asked -- no false `challenge_issued` action either.
    expect(session.logs.actions.some((a) => a.kind === 'challenge_issued')).toBe(false);
  });

  it('a reply that DOES carry a real (non-empty) transcript still counts toward the ordinary QUESTION_REASK_MAX, unaffected by the empty-budget fix', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newLiveSession(clock, CALL_B, aai, sent, diagEvents);

    clock.now = 1000;
    aai.emit({ type: 'transcript.user', item_id: 'c1', text: scenarioB.conversation[0]!.text });
    const sentence = session.last!.goal.challenge!.speak!;
    const replyCreates = () => aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create');
    const baseline = replyCreates().length;

    // "Checking the record." -- a real, non-empty, but non-question reply.
    clock.now = 1500;
    aai.emit({ type: 'reply.started', reply_id: 'a1' });
    aai.emit({ type: 'transcript.agent', item_id: 'a1', text: 'Checking the record.', reply_id: 'a1', interrupted: false });
    clock.now = 2000;
    aai.emit({ type: 'reply.done', reply_id: 'a1', status: 'completed' });

    vi.advanceTimersByTime(REASK_GAP_MS);
    expect(replyCreates().length).toBe(baseline + 1);
    expect(diagEvents.find((e) => e.kind === 'question_reask_sent')?.detail).toEqual({ goal_code: 'ASK_CHALLENGE', attempt: 1 });

    // A second non-empty, non-question reply -- exhausts QUESTION_REASK_MAX (2).
    clock.now = 2500;
    aai.emit({ type: 'reply.started', reply_id: 'a2' });
    aai.emit({ type: 'transcript.agent', item_id: 'a2', text: 'One moment.', reply_id: 'a2', interrupted: false });
    clock.now = 3000;
    aai.emit({ type: 'reply.done', reply_id: 'a2', status: 'completed' });

    vi.advanceTimersByTime(REASK_GAP_MS);
    expect(replyCreates().length).toBe(baseline + 2);

    // A third non-empty, non-question reply -- QUESTION_REASK_MAX is exhausted; no further
    // reask, exactly as before this fix (this path is unchanged by the empty-budget addition).
    clock.now = 3500;
    aai.emit({ type: 'reply.started', reply_id: 'a3' });
    aai.emit({ type: 'transcript.agent', item_id: 'a3', text: 'Still checking.', reply_id: 'a3', interrupted: false });
    clock.now = 4000;
    aai.emit({ type: 'reply.done', reply_id: 'a3', status: 'completed' });

    vi.advanceTimersByTime(REASK_GAP_MS);
    expect(replyCreates().length).toBe(baseline + 2); // capped, unchanged from before this fix
    expect(sentence).toBeTruthy();
  });
});
