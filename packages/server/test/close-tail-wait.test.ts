// packages/server/test/close-tail-wait.test.ts
// goodbye-tail lane (2026-09-15) -- Defect A, PROVEN live from
// `scripts/rehearse/reports/live/*.json` (11 case bundles, deploy 35, 2026-09-14 9:50-10:14
// PM CDT): all 8 `agent_closed` bundles showed `session_ended` firing a FIXED 1500ms
// (CLOSE_GRACE_MS) after the goodbye reply's own `reply.done`, regardless of how much of
// that reply's `reply.audio` had actually reached (let alone finished playing on) the
// browser -- a caller can hear the last part of the goodbye cut off while the screen still
// shows it in full.
//
// Fix (session.ts `beginCloseGrace`): the wait is now max(reply.done/confirmation-time +
// CLOSE_GRACE_MS, first_audio_relayed_at + audio_seconds + 1000ms), where audio_seconds
// comes from the bytes of `reply.audio` actually relayed for that reply (PROVEN 24kHz PCM16
// mono output, docs/ASSEMBLYAI_INTEGRATION.md line 17, so 48000 bytes/sec of decoded PCM) --
// still capped by the existing CLOSE_TOTAL_MS (45s) hard backstop, which `beginCloseGrace`
// no longer clears.
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
 *  same helper across its own describe blocks for the same reason). By the end of this
 *  helper, ONE `reply.create` for CLOSE has already been sent (attempt 1, reason `tick_end`
 *  -- nothing is speaking when the final caller line's tick reaches SEALED). */
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

/** `seconds` of decoded 24kHz PCM16 mono silence, base64-encoded -- the exact wire shape
 *  `reply.audio.data` carries (docs/ASSEMBLYAI_INTEGRATION.md line 17). Content is irrelevant
 *  (only the decoded BYTE COUNT drives `beginCloseGrace`'s math); silence keeps the fixture
 *  cheap to construct. */
function pcmBase64ForSeconds(seconds: number): string {
  const bytes = Math.round(seconds * 48_000); // PROVEN: 24000 samples/sec * 2 bytes/sample * 1 channel
  return Buffer.alloc(bytes).toString('base64');
}

const CALL: CallContext = { session_id: 'sess-tail', origin_kind: 'registered_device', origin_geo: 'Austin, TX' };

describe('Defect A: CLOSE hang-up waits for the goodbye\'s own estimated playback length', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('(a) 6.0s of relayed PCM with reply.done 1.0s after first audio: session ends no earlier than 7.0s after first audio', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newSession(clock, { ...CALL, session_id: 'sess-tail-a' }, aai, sent, diagEvents);
    session.start();
    driveToSealedStage(session, aai, clock);
    expect(session.last?.goal.code).toBe('CLOSE');

    // First audio relayed at server-clock t=7500; a burst of 6.0s of PCM arrives in one frame
    // (AssemblyAI can deliver faster than real-time -- the whole point of measuring bytes
    // instead of assuming audio streams at exactly real-time speed).
    clock.now = 7500;
    aai.emit({ type: 'reply.started', reply_id: 'a5' });
    aai.emit({ type: 'reply.audio', data: pcmBase64ForSeconds(6.0) });
    // reply.done 1.0s after that first audio frame -- the transcript matches, confirming the
    // goodbye on this same event.
    clock.now = 8500;
    aai.emit({ type: 'transcript.agent', item_id: 'a5', text: session.last!.goal.hint, reply_id: 'a5', interrupted: false });
    aai.emit({ type: 'reply.done', reply_id: 'a5', status: 'completed' });

    // Formula: graceBasedDeadline = 8500 + 1500 = 10000; audioBasedDeadline = 7500 + 6000 +
    // 1000 = 14500; max = 14500 => delayMs = 14500 - 8500 = 6000 (vi's fake-timer clock,
    // still at 0 here since nothing has been advanced yet). Session must not end before that,
    // and 14500 - 7500 = 7000ms = 7.0s after first audio, matching the PROVEN requirement.
    const closeTailWait = diagEvents.find((e) => e.kind === 'close_tail_wait');
    expect(closeTailWait?.detail).toEqual({ audio_seconds: 6, waited_ms: 6000 });

    vi.advanceTimersByTime(5_999);
    expect(sent.some((e) => e.type === 'ended')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(sent.at(-1)).toEqual({ type: 'ended', reason: 'agent_closed' });
  });

  // GOODBYE-CUT-BY-CALLER-PRESSURE fix, mechanism B (2026-09-19): a 1.0s goodbye is no longer
  // a realistic fixture -- the two clean, fully-relayed goodbyes measured live the same day
  // took 7.08s/7.52s for an 86-char sentence (~4,000 bytes/char), and confirmation now
  // requires at least 50% of that expected byte count (`closeReplyHasEnoughAudio`,
  // call/session.ts) before the goodbye can be confirmed heard at all -- 1.0s of audio for a
  // sentence this long would now be REJECTED and retried, never reach `beginCloseGrace`. This
  // test's subject (once confirmed, a goodbye whose audio already finished streaming keeps
  // the flat CLOSE_GRACE_MS wait, not stretched by the audio-tail formula) still needs its own
  // case: sized dynamically off the REAL sentence so it clears the new confirmation floor with
  // headroom, and with `reply.done` arriving well after that audio would already have finished
  // playing, so the GRACE-based deadline (not the audio-based one) is what dominates.
  it('(b) once confirmed, a goodbye whose audio already finished streaming well before reply.done keeps today\'s timing: the wait stays CLOSE_GRACE_MS (1500ms), not stretched by the audio floor', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newSession(clock, { ...CALL, session_id: 'sess-tail-b' }, aai, sent, diagEvents);
    session.start();
    driveToSealedStage(session, aai, clock);

    const sentence = session.last!.goal.hint;
    // 50% of ~4,000 bytes/char (session.ts's own `closeAudioFloorBytes` formula), plus 20%
    // headroom, rounded up to a whole second for a clean fixture value.
    const floorBytes = sentence.length * 4_000 * 0.5;
    const audioSeconds = Math.ceil((floorBytes / 48_000) * 1.2);
    clock.now = 7500;
    aai.emit({ type: 'reply.started', reply_id: 'a5' });
    aai.emit({ type: 'reply.audio', data: pcmBase64ForSeconds(audioSeconds) });
    // reply.done arrives 5s after that audio would have finished playing -- the audio-based
    // deadline (first_audio + audioSeconds + 1s tail buffer) is already in the past by the
    // time reply.done fires, leaving only the flat CLOSE_GRACE_MS window to matter.
    clock.now = 7500 + audioSeconds * 1000 + 5000;
    aai.emit({ type: 'transcript.agent', item_id: 'a5', text: sentence, reply_id: 'a5', interrupted: false });
    aai.emit({ type: 'reply.done', reply_id: 'a5', status: 'completed' });

    const closeTailWait = diagEvents.find((e) => e.kind === 'close_tail_wait');
    expect(closeTailWait?.detail).toEqual({ audio_seconds: audioSeconds, waited_ms: 1500 });

    vi.advanceTimersByTime(1_499);
    expect(sent.some((e) => e.type === 'ended')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(sent.at(-1)).toEqual({ type: 'ended', reason: 'agent_closed' });
  });

  it('(c) the hard cap (CLOSE_TOTAL_MS) still wins: an implausibly long relayed goodbye does not stretch the call past the 45s absolute budget', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newSession(clock, { ...CALL, session_id: 'sess-tail-c' }, aai, sent, diagEvents);
    session.start();
    driveToSealedStage(session, aai, clock); // arms the 45s hard cap on vi's fake-timer clock, from t=0

    // 50 seconds of relayed PCM -- the audio-based deadline this would compute (58,500ms
    // measured from first audio, 50,000ms of *delay* from reply.done) is well past
    // CLOSE_TOTAL_MS (45,000ms). `beginCloseGrace` still schedules its own timer for that
    // long delay -- it is the ALREADY-ARMED hard cap timer (never cleared by this fix, see
    // `beginCloseGrace`'s own doc comment) that must win the race instead.
    clock.now = 7500;
    aai.emit({ type: 'reply.started', reply_id: 'a5' });
    aai.emit({ type: 'reply.audio', data: pcmBase64ForSeconds(50) });
    clock.now = 8500;
    aai.emit({ type: 'transcript.agent', item_id: 'a5', text: session.last!.goal.hint, reply_id: 'a5', interrupted: false });
    aai.emit({ type: 'reply.done', reply_id: 'a5', status: 'completed' });

    const closeTailWait = diagEvents.find((e) => e.kind === 'close_tail_wait');
    expect(closeTailWait?.detail).toEqual({ audio_seconds: 50, waited_ms: 50_000 });

    // The hard cap was armed the instant CLOSE first rendered, at vi-fake-timer-clock t=0 --
    // still not ended just short of CLOSE_TOTAL_MS...
    vi.advanceTimersByTime(44_999);
    expect(sent.some((e) => e.type === 'ended')).toBe(false);
    // ...and ends exactly at it, reason close_timeout (the hard cap's own default reason --
    // not agent_closed, proving the grace timer did NOT win this race).
    vi.advanceTimersByTime(1);
    expect(sent.at(-1)).toEqual({ type: 'ended', reason: 'close_timeout' });

    // The (much later) grace timer computed above must not ALSO fire and double-end the call.
    const endedCountBefore = sent.filter((e) => e.type === 'ended').length;
    vi.advanceTimersByTime(60_000);
    expect(sent.filter((e) => e.type === 'ended').length).toBe(endedCountBefore);
  });
});
