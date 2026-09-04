// packages/server/test/session-audio-tick.test.ts
// PROVEN bug (2026-09-03 flight-recorder bundle from a real deployed call): the server ran
// the full engine `evaluate` ~100 times/sec whenever the agent was speaking -- 1,998
// `evaluate` diagnostics events in the first 46 seconds, filling the 2,000-event bundle cap
// so the remaining four minutes of the call were never recorded. Root cause (session.ts,
// `dispatchAaiEvent`): every branch, including `reply.audio` (fired once per AAI audio
// frame -- nothing to do with the engine's inputs), fell through to `this.tick()`, which
// re-runs `evaluate(this.buildEngineInput())` and logs a diagnostics `evaluate` event.
//
// This test feeds a session 200 `reply.audio` frames between two transcript events (the
// same shape as the recorded call: the agent talking while nothing in
// conversation/tools/actions changes) and asserts the number of `evaluate` diagnostics
// events does NOT grow with the audio frame count -- it should fail on the buggy code
// (200+ extra `evaluate` events, one per frame) and pass once `reply.audio` (and the other
// engine-input-inert events) stop calling `tick()`.
import { describe, it, expect } from 'vitest';
import { MERIDIAN, mockToolResult } from '@countersign/engine';
import type { CallContext, ServerEvent } from '@countersign/engine';
import { CallSession } from '../src/call/session.js';
import { FakeAaiSocket } from '../src/aai/fake.js';

const CALL: CallContext = { session_id: 'sess-audio', origin_kind: 'unverified_voip', origin_geo: 'unknown' };

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

describe('CallSession -- reply.audio must not re-run the engine (flight-recorder fix)', () => {
  it('does not grow the evaluate diagnostics count with the number of audio frames', () => {
    const { clock, aai, sent, diagnostics, session } = newSessionWithDiagnostics();

    session.start(); // one tick from start()

    clock.now = 1100;
    aai.emit({ type: 'reply.started', reply_id: 'r1' });

    const evaluateCountBeforeAudio = diagnostics.filter((d) => d.kind === 'evaluate').length;

    // 200 audio frames -- the exact shape of the recorded bug: the agent speaking, nothing
    // in conversation/tools/actions/seed changing between frames.
    const FRAME_COUNT = 200;
    for (let i = 0; i < FRAME_COUNT; i++) {
      clock.now += 10;
      aai.emit({ type: 'reply.audio', data: `frame-${i}` });
    }

    const evaluateCountAfterAudio = diagnostics.filter((d) => d.kind === 'evaluate').length;

    // The load-bearing assertion: audio frames must add ZERO evaluate events, not merely
    // "fewer than one per frame."
    expect(evaluateCountAfterAudio).toBe(evaluateCountBeforeAudio);

    // A subsequent real transcript event still ticks and PROVEN (via zzz-probe against the
    // real engine/MERIDIAN seed) actually moves the FSM state INTAKE -> CLAIM, so the
    // post-fix output-signature dedupe in applyEvaluate (fix3/flood-fix) does not collapse
    // it away -- proves this isn't a case of tick() having been broken/disabled outright,
    // and that this test's baseline isn't an accidental false pass caused by that dedupe.
    clock.now += 10;
    aai.emit({ type: 'transcript.user', item_id: 'u1', text: 'This is Robert Miller.' });
    const evaluateCountAfterTranscript = diagnostics.filter((d) => d.kind === 'evaluate').length;
    expect(evaluateCountAfterTranscript).toBe(evaluateCountAfterAudio + 1);

    // Sanity bound restating the PROVEN bug shape: on the buggy code this would be 200+,
    // one per frame. Fixed code should be a small, frame-count-independent number.
    expect(evaluateCountAfterAudio).toBeLessThan(10);

    // ---- all 200 audio frames must still reach the browser unchanged ----
    const audioEvents = sent.filter((e) => e.type === 'audio') as { type: 'audio'; data: string }[];
    expect(audioEvents).toHaveLength(FRAME_COUNT);
    expect(audioEvents.map((e) => e.data)).toEqual(Array.from({ length: FRAME_COUNT }, (_, i) => `frame-${i}`));
  });
});
