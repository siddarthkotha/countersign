// packages/server/test/close-transcript-wait.test.ts
// goodbye-tail lane (2026-09-15) -- Defect B, PROVEN live from
// `scripts/rehearse/reports/live/*.json` (11 case bundles, deploy 35, 2026-09-14 9:50-10:14
// PM CDT): CLOSE reply.create sent twice on 6 of 8 live founder calls, three times on one --
// because the final `transcript.agent` chunk for a reply arrives at (or just after) that SAME
// reply's own `reply.done` (measured: within tens of ms, either order), and the old code
// concluded "not spoken, retry" the instant `reply.done` fired with no match accumulated YET.
// Underrun bursts inside those retries (client playback queue running dry while the retry
// itself streams) were PROVEN in the same live sample.
//
// Fix (session.ts `scheduleCloseIfNeeded` / `armCloseTranscriptWait`): the retry decision now
// waits CLOSE_TRANSCRIPT_WAIT_MS (1500ms) for a possible late chunk before concluding the
// goodbye was not spoken; a matching transcript inside the window cancels the retry.
import { describe, it, expect, vi, afterEach } from 'vitest';
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

/** Drives a session to SEALED/CLOSE (verdict STAGE) via the same legitimate Dana Whitfield
 *  flow session.test.ts's own `driveToSealedStage` uses -- copied here rather than exported
 *  (that helper is scoped to its own describe block; session.test.ts already duplicates this
 *  same helper across its own describe blocks for the same reason; close-tail-wait.test.ts,
 *  the Defect A sibling of this file, duplicates it a third time). By the end of this helper,
 *  ONE `reply.create` for CLOSE has already been sent (attempt 1, reason `tick_end` -- nothing
 *  is speaking when the final caller line's tick reaches SEALED). */
function driveToSealedStage(session: CallSession, aai: FakeAaiSocket, clock: { now: number }): void {
  clock.now = 1000;
  aai.emit({
    type: 'transcript.user',
    item_id: 'c1',
    text: "This is Dana Whitfield, corporate treasury. I need to wire it to Meridian Supply — $84,500, account ending 4471 — moving today instead of Friday, approved in yesterday's close meeting.",
  });
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
  clock.now = 3000;
  aai.emit({ type: 'reply.started', reply_id: 'a2' });
  aai.emit({ type: 'transcript.agent', item_id: 'a2', text: session.last!.goal.hint, reply_id: 'a2', interrupted: false });
  clock.now = 3500;
  aai.emit({ type: 'reply.done', reply_id: 'a2', status: 'completed' });

  clock.now = 4000;
  aai.emit({ type: 'transcript.user', item_id: 'c3', text: "Yes, that's right." });
  clock.now = 4500;
  aai.emit({ type: 'reply.started', reply_id: 'a3' });
  aai.emit({ type: 'transcript.agent', item_id: 'a3', text: session.last!.goal.hint, reply_id: 'a3', interrupted: false });
  clock.now = 5000;
  aai.emit({ type: 'reply.done', reply_id: 'a3', status: 'completed' });

  clock.now = 5500;
  aai.emit({ type: 'transcript.user', item_id: 'c4', text: 'Yes, correct.' });
  clock.now = 6000;
  aai.emit({ type: 'reply.started', reply_id: 'a4' });
  aai.emit({ type: 'transcript.agent', item_id: 'a4', text: session.last!.goal.hint, reply_id: 'a4', interrupted: false });
  clock.now = 6500;
  aai.emit({ type: 'reply.done', reply_id: 'a4', status: 'completed' });

  clock.now = 7000;
  aai.emit({ type: 'transcript.user', item_id: 'c5', text: "Yes, that's right." });
}

/** `seconds` of decoded 24kHz PCM16 mono silence, base64-encoded (docs/
 *  ASSEMBLYAI_INTEGRATION.md line 17) -- used only by test (c) below to prove the pre-existing
 *  post-goodbye suppression path still drops audio correctly alongside this lane's new
 *  audio-byte tracking (Defect A). */
function pcmBase64ForSeconds(seconds: number): string {
  const bytes = Math.round(seconds * 48_000); // PROVEN: 24000 samples/sec * 2 bytes/sample * 1 channel
  return Buffer.alloc(bytes).toString('base64');
}

const CALL: CallContext = { session_id: 'sess-transcript', origin_kind: 'registered_device', origin_geo: 'Austin, TX' };

describe('Defect B: CLOSE retry waits for a late transcript before concluding the goodbye was not spoken', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('(a) reply.done at t, matching transcript at t+400ms: exactly one CLOSE reply.create for the whole call', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newSession(clock, { ...CALL, session_id: 'sess-transcript-a' }, aai, sent, diagEvents);
    session.start();
    driveToSealedStage(session, aai, clock);
    const replyCreates = () => aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create');
    expect(replyCreates()).toHaveLength(1); // the original send (attempt 1, tick_end)

    // reply.done fires with NO transcript recorded yet for this reply at all.
    clock.now = 7500;
    aai.emit({ type: 'reply.started', reply_id: 'a5' });
    clock.now = 7700;
    aai.emit({ type: 'reply.done', reply_id: 'a5', status: 'completed' });
    expect(replyCreates()).toHaveLength(1); // no retry sent synchronously

    // The close line's own transcript.agent chunk lands 400ms later -- well inside the
    // CLOSE_TRANSCRIPT_WAIT_MS (1500ms) window this fix adds.
    vi.advanceTimersByTime(400);
    aai.emit({ type: 'transcript.agent', item_id: 'a5', text: session.last!.goal.hint, reply_id: 'a5', interrupted: false });

    // No retry was ever sent -- the late transcript confirmed the goodbye instead.
    expect(replyCreates()).toHaveLength(1);

    // Advancing well past the transcript-wait window (which is now moot -- goodbyeConfirmed
    // is already true) must not produce a retry either.
    vi.advanceTimersByTime(1_500);
    expect(replyCreates()).toHaveLength(1);

    // The call still ends normally (no audio was ever relayed for this reply, so the grace
    // period is the unchanged flat CLOSE_GRACE_MS off the transcript match -- confirmed via
    // CLOSE_DONE_WAIT_MS, since reply.done already happened before the match was seen).
    vi.advanceTimersByTime(10_000);
    expect(sent.at(-1)).toEqual({ type: 'ended', reason: 'agent_closed' });
    expect(replyCreates()).toHaveLength(1);
  });

  it('(b) no transcript within the window: retry as today (spaced CLOSE_RETRY_MIN_GAP_MS after the wait elapses)', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newSession(clock, { ...CALL, session_id: 'sess-transcript-b' }, aai, sent, diagEvents);
    session.start();
    driveToSealedStage(session, aai, clock);
    const replyCreates = () => aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create');
    expect(replyCreates()).toHaveLength(1);

    clock.now = 7500;
    aai.emit({ type: 'reply.started', reply_id: 'a5' });
    clock.now = 7700;
    aai.emit({ type: 'reply.done', reply_id: 'a5', status: 'completed' });

    // Nothing ever arrives -- the window elapses with no match.
    vi.advanceTimersByTime(1_500); // CLOSE_TRANSCRIPT_WAIT_MS
    expect(replyCreates()).toHaveLength(1); // wait just elapsed; retry timer now arming, not yet fired
    vi.advanceTimersByTime(400); // CLOSE_RETRY_MIN_GAP_MS
    expect(replyCreates()).toHaveLength(2); // the retry, sent exactly as it would have been "today"

    const retryMsg = aai.sent.at(-1) as { type: string; instructions?: string };
    expect(retryMsg.instructions).toContain('Say exactly this');
  });

  it('(c) post-goodbye suppression still drops audio of a later reply (regression: unaffected by the audio-byte tracking Defect A adds)', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newSession(clock, { ...CALL, session_id: 'sess-suppress-c' }, aai, sent, diagEvents);
    session.start();
    driveToSealedStage(session, aai, clock);

    // The goodbye is confirmed immediately -- a fully-matching reply, reply.done, no audio.
    clock.now = 7500;
    aai.emit({ type: 'reply.started', reply_id: 'a5' });
    aai.emit({ type: 'transcript.agent', item_id: 'a5', text: session.last!.goal.hint, reply_id: 'a5', interrupted: false });
    clock.now = 7700;
    aai.emit({ type: 'reply.done', reply_id: 'a5', status: 'completed' });

    const audioEventsBefore = sent.filter((e) => e.type === 'audio').length;

    // A NEW reply starts (AssemblyAI's own turn-driven follow-up, or a queued reply.create) --
    // its audio must be dropped, never relayed, and must not be double-counted into
    // `replyAudioBytes` for the (already-confirmed) goodbye reply id either.
    clock.now = 7750;
    aai.emit({ type: 'reply.started', reply_id: 'a6' });
    aai.emit({ type: 'reply.audio', data: pcmBase64ForSeconds(2.0) });

    expect(sent.filter((e) => e.type === 'audio').length).toBe(audioEventsBefore); // dropped, not relayed
    const suppressed = diagEvents.filter((e) => e.kind === 'post_goodbye_reply_suppressed');
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0]!.detail).toEqual({ reply_id: 'a6' });

    // The call still ends on the unchanged schedule (no audio was ever relayed for the
    // CONFIRMED reply 'a5' -- the suppressed frames belong to 'a6' -- so the flat
    // CLOSE_GRACE_MS applies).
    vi.advanceTimersByTime(1_500);
    expect(sent.at(-1)).toEqual({ type: 'ended', reason: 'agent_closed' });
  });
});
