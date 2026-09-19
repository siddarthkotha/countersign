// packages/server/test/reply-audio-summary.test.ts
// CLOSE-TAIL-AUDIO-SECONDS-UNDERCOUNT diagnostics (board item, 2026-09-19): `close_tail_wait`
// read implausibly short `audio_seconds` on two live bundles (0.87s for a 142-char goodbye,
// 1.26s for an 86-char one -- scripts/rehearse/reports/2026-09-19T12-33-07-miller-patient and
// .../2026-09-19T12-28-00-barge-in-interrupt .diagnostics.json), and neither bundle carried
// enough per-reply detail to say whether audio arriving AFTER that reply's own `reply.done`
// was ever counted at all. DIAGNOSTICS ONLY: this file proves session.ts's new
// `finalizeReplyAudioSummary` records, for each reply id, total relayed bytes, bytes relayed
// after that reply's own `reply.done`, the last relayed frame's time relative to `reply.done`,
// and the first-to-last-audio span -- as one `reply.audio.summary` server_event per reply --
// without changing `close_tail_wait`'s own payload shape or any close-timing decision.
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

/** `seconds` of decoded 24kHz PCM16 mono silence, base64-encoded -- same helper
 *  close-tail-wait.test.ts uses (docs/ASSEMBLYAI_INTEGRATION.md line 17: 48000 bytes/sec of
 *  decoded PCM). Content is irrelevant -- only the decoded BYTE COUNT matters here. */
function pcmBase64ForSeconds(seconds: number): string {
  const bytes = Math.round(seconds * 48_000);
  return Buffer.alloc(bytes).toString('base64');
}

const CALL: CallContext = { session_id: 'sess-audio-summary', origin_kind: 'registered_device', origin_geo: 'Austin, TX' };

// Copied from close-tail-wait.test.ts (that file's own doc comment: this helper is scoped to
// its own describe block, so other files duplicate it rather than export it across a lane
// boundary).
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
  aai.emit({ type: 'transcript.user', item_id: 'c5', text: 'Yes, that\'s right.' });
}

describe('CallSession -- per-reply audio summary diagnostics (CLOSE-TAIL-AUDIO-SECONDS-UNDERCOUNT)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits total/after-done/last-frame/first-to-last numbers for a reply once the NEXT reply.started fires', () => {
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newSession(clock, { ...CALL, session_id: 'sess-summary-a' }, aai, sent, diagEvents);
    session.start();

    clock.now = 1000;
    aai.emit({ type: 'reply.started', reply_id: 'r1' });
    aai.emit({ type: 'reply.audio', data: Buffer.alloc(1000).toString('base64') }); // first frame, t=1000
    clock.now = 1100;
    aai.emit({ type: 'reply.audio', data: Buffer.alloc(500).toString('base64') }); // t=1100, total 1500
    clock.now = 1200;
    aai.emit({ type: 'reply.done', reply_id: 'r1', status: 'completed' }); // bytesAtDone=1500, doneAt=1200
    clock.now = 1250;
    // Still arrives while currentReplyId is still 'r1' -- the next reply.started hasn't
    // happened yet, so this is (correctly) still counted for 'r1', 50ms AFTER its own
    // reply.done. This is exactly the shape the board item is asking about: does the server
    // notice audio that keeps coming in after reply.done?
    aai.emit({ type: 'reply.audio', data: Buffer.alloc(200).toString('base64') }); // total 1700
    clock.now = 1300;
    aai.emit({ type: 'reply.started', reply_id: 'r2' }); // finalizes r1's summary before reassigning

    const summaries = diagEvents.filter((d) => d.kind === 'reply.audio.summary');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.detail).toEqual({
      reply_id: 'r1',
      total_bytes: 1700,
      bytes_after_done: 200, // 1700 total - 1500 at reply.done
      last_audio_ms_after_done: 50, // last frame at t=1250, reply.done at t=1200
      first_to_last_audio_ms: 250, // first frame t=1000, last frame t=1250
    });
  });

  it('finalizes the still-open reply at session end when no further reply.started ever arrives', () => {
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newSession(clock, { ...CALL, session_id: 'sess-summary-b' }, aai, sent, diagEvents);
    session.start();

    clock.now = 2000;
    aai.emit({ type: 'reply.started', reply_id: 'r1' });
    aai.emit({ type: 'reply.audio', data: Buffer.alloc(800).toString('base64') }); // one frame, t=2000
    clock.now = 2500;
    aai.emit({ type: 'reply.done', reply_id: 'r1', status: 'completed' }); // bytesAtDone=800, doneAt=2500

    expect(diagEvents.some((d) => d.kind === 'reply.audio.summary')).toBe(false); // not yet -- no next reply.started, call not ended

    session.end('agent_closed');

    const summaries = diagEvents.filter((d) => d.kind === 'reply.audio.summary');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.detail).toEqual({
      reply_id: 'r1',
      total_bytes: 800,
      bytes_after_done: 0, // no more audio arrived after reply.done
      last_audio_ms_after_done: -500, // only frame was 500ms BEFORE reply.done
      first_to_last_audio_ms: 0, // a single frame
    });
  });

  it('emits nothing for a reply that produced no audio at all (nothing to report)', () => {
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newSession(clock, { ...CALL, session_id: 'sess-summary-c' }, aai, sent, diagEvents);
    session.start();

    clock.now = 3000;
    aai.emit({ type: 'reply.started', reply_id: 'r1' }); // no reply.audio at all
    clock.now = 3100;
    aai.emit({ type: 'reply.started', reply_id: 'r2' }); // would finalize r1, but r1 has no audio

    expect(diagEvents.some((d) => d.kind === 'reply.audio.summary')).toBe(false);
  });

  it('never emits the summary twice for the same reply id (finalize is idempotent)', () => {
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newSession(clock, { ...CALL, session_id: 'sess-summary-d' }, aai, sent, diagEvents);
    session.start();

    clock.now = 4000;
    aai.emit({ type: 'reply.started', reply_id: 'r1' });
    aai.emit({ type: 'reply.audio', data: Buffer.alloc(400).toString('base64') });
    clock.now = 4200;
    aai.emit({ type: 'reply.done', reply_id: 'r1', status: 'completed' });
    clock.now = 4300;
    aai.emit({ type: 'reply.started', reply_id: 'r2' }); // finalizes r1 once
    aai.emit({ type: 'reply.audio', data: Buffer.alloc(400).toString('base64') });
    clock.now = 4500;
    aai.emit({ type: 'reply.done', reply_id: 'r2', status: 'completed' });

    session.end('agent_closed'); // currentReplyId is 'r2' here, not 'r1' -- must not re-finalize r1

    const r1Summaries = diagEvents.filter((d) => d.kind === 'reply.audio.summary' && (d.detail as { reply_id: string }).reply_id === 'r1');
    expect(r1Summaries).toHaveLength(1);
  });

  // Reproduces the live defect shape (2026-09-19T12-28-00-barge-in-interrupt.diagnostics.json,
  // 2026-09-19T12-33-07-miller-patient.diagnostics.json): a reply.started for an unrelated
  // reply lands only milliseconds after the CONFIRMED goodbye's own reply.done, immediately
  // getting suppressed (post_goodbye_reply_suppressed) -- and any audio that keeps arriving
  // for the goodbye reply id in the gap between its own reply.done and that next
  // reply.started must still show up in ITS OWN summary, not vanish silently.
  it('captures audio that keeps arriving after the CONFIRMED goodbye reply\'s own reply.done, right up to the next (suppressed) reply.started -- and leaves close_tail_wait\'s payload shape unchanged', () => {
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newSession(clock, { ...CALL, session_id: 'sess-summary-e' }, aai, sent, diagEvents);
    session.start();
    driveToSealedStage(session, aai, clock);
    expect(session.last?.goal.code).toBe('CLOSE');

    clock.now = 7500;
    aai.emit({ type: 'reply.started', reply_id: 'a5' });
    aai.emit({ type: 'reply.audio', data: pcmBase64ForSeconds(1.0) }); // 48000 bytes, first frame t=7500
    clock.now = 8500;
    aai.emit({ type: 'transcript.agent', item_id: 'a5', text: session.last!.goal.hint, reply_id: 'a5', interrupted: false });
    aai.emit({ type: 'reply.done', reply_id: 'a5', status: 'completed' }); // confirms the goodbye; bytesAtDone=48000, doneAt=8500

    // close_tail_wait's own payload shape (audio_seconds, waited_ms) is unaffected by this fix.
    const closeTailWait = diagEvents.find((e) => e.kind === 'close_tail_wait');
    expect(closeTailWait?.detail).toEqual({ audio_seconds: 1, waited_ms: 1500 });

    // More of the SAME reply's audio keeps arriving -- currentReplyId is still 'a5' (nothing
    // else has started yet), so this is (correctly, today) still counted for it.
    clock.now = 8600;
    aai.emit({ type: 'reply.audio', data: pcmBase64ForSeconds(0.2) }); // +9600 bytes, total 57600

    // AssemblyAI's own ambient follow-up reply starts 100ms later -- immediately suppressed
    // (goodbyeConfirmed && this new id !== the goodbye's own id), same live shape as both
    // flagged bundles (6ms and 12ms gaps there).
    clock.now = 8700;
    aai.emit({ type: 'reply.started', reply_id: 'a6' });

    expect(diagEvents.some((d) => d.kind === 'post_goodbye_reply_suppressed' && (d.detail as { reply_id: string }).reply_id === 'a6')).toBe(true);

    const goodbyeSummary = diagEvents.find((d) => d.kind === 'reply.audio.summary' && (d.detail as { reply_id: string }).reply_id === 'a5');
    expect(goodbyeSummary?.detail).toEqual({
      reply_id: 'a5',
      total_bytes: 57_600,
      bytes_after_done: 9_600, // the 0.2s frame that arrived after reply.done
      last_audio_ms_after_done: 100, // last frame at t=8600, reply.done at t=8500
      first_to_last_audio_ms: 1_100, // first frame t=7500, last frame t=8600
    });
  });
});
