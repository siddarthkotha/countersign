// packages/server/test/close-attempt1-instructions.test.ts
// P0 defect, PROVEN live 2026-09-18 (founder's three calls the same morning, all under
// scripts/rehearse/reports/founder-2026-09-18/, plus a harness bundle
// scripts/rehearse/reports/2026-09-18T09-04-22-prompt-injection-midcall.diagnostics.json):
// the FIRST CLOSE reply.create (reason `tick_end`, attempt 1, sent from
// `maybeSendReplyCreateForTick`) is sent with NO one-shot `instructions` -- session.ts's
// `instructedSentenceFor` returned `undefined` for the CLOSE goal code (its own doc comment
// said so explicitly: "CLOSE's tick_end send stays bare... relying on the standing
// system_prompt alone"). The session.update carrying the CLOSE system_prompt is sent (and
// diagnosed as `session_config_updated`) in the SAME millisecond as the reply.create that
// follows it (proven: case 5's own diagnostics, session_config_updated at t=78125,
// reply_create_sent at t=78125) -- too fast for AssemblyAI to have necessarily applied the new
// system_prompt yet (docs/TEST-PLAN.md: "system_prompt applies on the next turn"). With no
// instructions field to fall back on, AssemblyAI's model composed attempt 1 under
// whatever context/prompt it still had -- in all four live/harness records this was NEVER the
// close sentence: "One moment." alone (idle ESCALATE case), "One moment. What is the specific
// cost center for this transaction?" (STAGE case, a stale ELICIT question), "What is this
// payment to Meridian Supply for?" (FREEZE case, a stale ELICIT_REQUEST question), and the
// caller's own open challenge answered a second time (prompt-injection harness case). Only the
// close_retry attempt (which DOES carry the "Say exactly this and nothing else" wrapper, via
// `armCloseRetryTimer`) reliably produced the real close line.
//
// This test proves the contract that was missing: the FIRST CLOSE reply.create must carry the
// SAME one-shot "say exactly this" wrapper close_retry already sends, so attempt 1 does not
// depend on the racy session.update having landed. FAILS before the fix (instructions is
// `undefined`); PASSES after `instructedSentenceFor` grows a CLOSE branch.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { MERIDIAN, mockToolResult } from '@countersign/engine';
import type { CallContext, ServerEvent } from '@countersign/engine';
import { CallSession } from '../src/call/session.js';
import { FakeAaiSocket } from '../src/aai/fake.js';

function newSession(
  clockRef: { now: number },
  call: CallContext,
  aai: FakeAaiSocket,
  sent: ServerEvent[],
  diagEvents: { kind: string; detail: unknown }[]
): CallSession {
  return new CallSession({
    session_id: call.session_id,
    seed: MERIDIAN,
    call,
    aai,
    now: () => clockRef.now,
    onServerEvent: (e) => sent.push(e),
    mock: mockToolResult,
    onDiagnostic: (kind, detail) => diagEvents.push({ kind, detail }),
  });
}

/** Copied from close-transcript-wait.test.ts's own `driveToSealedStage` (that file's own doc
 *  comment explains why this helper is duplicated per test file rather than exported). Drives a
 *  session to SEALED/CLOSE (verdict STAGE) via a legitimate Dana Whitfield flow. By the end,
 *  ONE `reply.create` for CLOSE has already been sent (attempt 1, reason `tick_end` -- nothing
 *  is speaking when the final caller line's tick reaches SEALED). */
// P0 fix (2026-09-18, call/session.ts's own AUTOMATIC_REPLY_SETTLE_MS doc comment): a
// caller-turn-triggered fresh QUESTION_GOALS send is now deferred by this many ms instead of
// synchronous, so AssemblyAI's own automatic reply for the same turn (if one is coming) has
// time to start first. c1-c4 below each land on such a rendering.
const AUTOMATIC_REPLY_SETTLE_MS = 150; // CallSession.AUTOMATIC_REPLY_SETTLE_MS

function driveToSealedStage(session: CallSession, aai: FakeAaiSocket, clock: { now: number }): void {
  vi.useFakeTimers();
  clock.now = 1000;
  aai.emit({
    type: 'transcript.user',
    item_id: 'c1',
    text: "This is Dana Whitfield, corporate treasury. I need to wire it to Meridian Supply — $84,500, account ending 4471 — moving today instead of Friday, approved in yesterday's close meeting.",
  });
  vi.advanceTimersByTime(AUTOMATIC_REPLY_SETTLE_MS);
  clock.now = 1500;
  aai.emit({ type: 'reply.started', reply_id: 'a1' });
  aai.emit({
    type: 'transcript.agent',
    item_id: 'a1',
    text: 'You are requesting a wire transfer of $84,500 to Northgate Partners. Is that correct?',
    reply_id: 'a1',
    interrupted: false,
  });
  clock.now = 2000;
  aai.emit({ type: 'reply.done', reply_id: 'a1', status: 'completed' });

  clock.now = 2500;
  aai.emit({ type: 'transcript.user', item_id: 'c2', text: "No, that's wrong. It's Meridian Supply." });
  vi.advanceTimersByTime(AUTOMATIC_REPLY_SETTLE_MS);
  clock.now = 3000;
  aai.emit({ type: 'reply.started', reply_id: 'a2' });
  aai.emit({ type: 'transcript.agent', item_id: 'a2', text: session.last!.goal.hint, reply_id: 'a2', interrupted: false });
  clock.now = 3500;
  aai.emit({ type: 'reply.done', reply_id: 'a2', status: 'completed' });

  clock.now = 4000;
  aai.emit({ type: 'transcript.user', item_id: 'c3', text: "Yes, that's right." });
  vi.advanceTimersByTime(AUTOMATIC_REPLY_SETTLE_MS);
  clock.now = 4500;
  aai.emit({ type: 'reply.started', reply_id: 'a3' });
  aai.emit({ type: 'transcript.agent', item_id: 'a3', text: session.last!.goal.hint, reply_id: 'a3', interrupted: false });
  clock.now = 5000;
  aai.emit({ type: 'reply.done', reply_id: 'a3', status: 'completed' });

  clock.now = 5500;
  aai.emit({ type: 'transcript.user', item_id: 'c4', text: 'Yes, correct.' });
  vi.advanceTimersByTime(AUTOMATIC_REPLY_SETTLE_MS);
  clock.now = 6000;
  aai.emit({ type: 'reply.started', reply_id: 'a4' });
  aai.emit({ type: 'transcript.agent', item_id: 'a4', text: session.last!.goal.hint, reply_id: 'a4', interrupted: false });
  clock.now = 6500;
  aai.emit({ type: 'reply.done', reply_id: 'a4', status: 'completed' });

  clock.now = 7000;
  aai.emit({ type: 'transcript.user', item_id: 'c5', text: "Yes, that's right." });
}

const CALL: CallContext = { session_id: 'sess-close-attempt1', origin_kind: 'registered_device', origin_geo: 'Austin, TX' };

describe('P0 (2026-09-18): the first CLOSE reply.create (attempt 1, tick_end) carries the same exact-words wrapper the retry does', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('attempt 1 (reason tick_end) is sent with instructions === "Say exactly this and nothing else: <close sentence>", not undefined', () => {
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newSession(clock, CALL, aai, sent, diagEvents);
    session.start();
    driveToSealedStage(session, aai, clock);

    expect(session.last?.state).toBe('SEALED');
    expect(session.last?.goal.code).toBe('CLOSE');
    const closeSentence = session.last!.goal.hint;

    const attempt1Diag = diagEvents.find(
      (e) =>
        e.kind === 'reply_create_sent' &&
        (e.detail as { goal_code: string; reason: string }).goal_code === 'CLOSE' &&
        (e.detail as { goal_code: string; reason: string }).reason === 'tick_end'
    );
    expect(attempt1Diag).toBeDefined();

    const replyCreates = aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create') as {
      type: string;
      instructions?: string;
    }[];
    // `driveToSealedStage`'s own caller turns (c1..c4) each land on a fresh READBACK rendering
    // and send their own proactive reply.create along the way (Design E) -- see
    // close-transcript-wait.test.ts's own "baseline" pattern for the same shape. The CLOSE
    // attempt (tick_end) is sent synchronously right after the final caller turn (c5) reaches
    // SEALED, so it is always the LAST reply.create in the sequence.
    expect(replyCreates.length).toBeGreaterThan(0);
    const attempt1 = replyCreates.at(-1)!;

    // The bug: before the fix this was `undefined` (instructedSentenceFor returned undefined
    // for CLOSE), so AssemblyAI had no one-shot override and, live, never spoke the close line
    // on this attempt -- see this file's own header comment for the four proven transcripts.
    expect(attempt1.instructions).toBe(`Say exactly this and nothing else: "${closeSentence}"`);
  });
});
