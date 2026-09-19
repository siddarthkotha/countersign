// scripts/rehearse/test/audioEnergy.test.ts
// Proves the energy timeline, caller-speech-interval pairing, reply-span joining, and per-reply
// speech/silence/overlap totals are exact to the window size, on synthetic PCM: a sine-style
// burst (constant-magnitude alternating samples, so RMS is exactly the amplitude), true silence
// (near-zero amplitude, still "audio"), a true silence GAP (no frame at all), and a burst that
// deliberately overlaps a synthetic caller-speech window. No network, no live server, no real
// call.
import { describe, expect, it } from 'vitest';
import type { AgentAudioFrame } from '../agentAudioCapture.js';
import {
  buildCallerSpeechIntervals,
  buildReplySpans,
  computeEnergyTimeline,
  computeReplyAudioRows,
  type EnergyTimeline,
} from '../audioEnergy.js';
import type { RehearseDiagnosticEvent } from '../types.js';

/** Alternating +amplitude/-amplitude per sample -- RMS of this exact signal is `amplitude`
 *  (mean of squares is amplitude^2 every sample, sqrt is amplitude), so expected RMS values in
 *  these tests are exact, not approximate. */
function burst(amplitude: number, sampleCount: number): Buffer {
  const buf = Buffer.alloc(sampleCount * 2);
  for (let i = 0; i < sampleCount; i++) {
    buf.writeInt16LE(i % 2 === 0 ? amplitude : -amplitude, i * 2);
  }
  return buf;
}

function ev(t_ms: number, kind: string, detail: unknown = null): RehearseDiagnosticEvent {
  return { t_ms, kind, detail };
}

describe('computeEnergyTimeline', () => {
  it('classifies a loud burst as speech, a quiet burst as silence, and an empty window as a true gap -- exact RMS/threshold', () => {
    const windowMs = 100;
    // Window 0 [0,100): quiet (amplitude 5). Window 1 [100,200): loud (amplitude 2000),
    // overlapping a synthetic caller-speech interval. Window 2 [200,300): no frame at all
    // (a true silence gap). Window 3 [300,400): quiet again. Window 4 [400,500): loud again,
    // NOT overlapping caller speech.
    const quiet0 = burst(5, 50);
    const loud1 = burst(2000, 50);
    const quiet3 = burst(5, 50);
    const loud4 = burst(2000, 50);
    const pcm = Buffer.concat([quiet0, loud1, quiet3, loud4]);

    const frames: AgentAudioFrame[] = [
      { t_ms: 10, byte_offset: 0, byte_length: quiet0.length },
      { t_ms: 110, byte_offset: quiet0.length, byte_length: loud1.length },
      { t_ms: 310, byte_offset: quiet0.length + loud1.length, byte_length: quiet3.length },
      { t_ms: 410, byte_offset: quiet0.length + loud1.length + quiet3.length, byte_length: loud4.length },
    ];

    const callerIntervals = [{ start_ms: 120, end_ms: 180 }]; // inside window 1 only

    const timeline = computeEnergyTimeline(frames, pcm, callerIntervals, windowMs);

    expect(timeline.window_ms).toBe(100);
    // noise floor: 10th percentile of the 4 windows WITH audio, rms sorted [5,5,2000,2000] ->
    // index floor(4*0.1)=0 -> 5. threshold = max(5*3, 50) = 50.
    expect(timeline.noise_floor_rms).toBe(5);
    expect(timeline.threshold_rms).toBe(50);

    expect(timeline.windows).toEqual([
      { index: 0, t_ms: 0, rms: 5, has_audio: true, is_speech: false, caller_speaking: false },
      { index: 1, t_ms: 100, rms: 2000, has_audio: true, is_speech: true, caller_speaking: true },
      { index: 2, t_ms: 200, rms: 0, has_audio: false, is_speech: false, caller_speaking: false },
      { index: 3, t_ms: 300, rms: 5, has_audio: true, is_speech: false, caller_speaking: false },
      { index: 4, t_ms: 400, rms: 2000, has_audio: true, is_speech: true, caller_speaking: false },
    ]);
  });

  it('returns an empty timeline (never throws) when no frames were captured at all', () => {
    const timeline = computeEnergyTimeline([], Buffer.alloc(0), []);
    expect(timeline.windows).toEqual([]);
    expect(timeline.noise_floor_rms).toBe(0);
    expect(timeline.threshold_rms).toBe(0);
  });
});

describe('buildCallerSpeechIntervals', () => {
  it('pairs each input.speech.started with the next input.speech.stopped, in t_ms order', () => {
    const events = [ev(500, 'input.speech.stopped'), ev(100, 'input.speech.started'), ev(1000, 'input.speech.started'), ev(1300, 'input.speech.stopped')];
    const intervals = buildCallerSpeechIntervals(events, 5000);
    expect(intervals).toEqual([
      { start_ms: 100, end_ms: 500 },
      { start_ms: 1000, end_ms: 1300 },
    ]);
  });

  it('closes an unmatched trailing started at callEndMs instead of dropping it', () => {
    const events = [ev(100, 'input.speech.started')];
    const intervals = buildCallerSpeechIntervals(events, 4200);
    expect(intervals).toEqual([{ start_ms: 100, end_ms: 4200 }]);
  });

  it('ignores unrelated event kinds', () => {
    const events = [ev(10, 'reply.started', { reply_id: 'r1' }), ev(100, 'input.speech.started'), ev(200, 'input.speech.stopped')];
    expect(buildCallerSpeechIntervals(events, 1000)).toEqual([{ start_ms: 100, end_ms: 200 }]);
  });
});

describe('buildReplySpans', () => {
  it('runs each reply span until the NEXT reply.started, not its own reply.done', () => {
    const events = [
      ev(0, 'reply.started', { reply_id: 'r1' }),
      ev(50, 'reply.done', { reply_id: 'r1', status: 'completed' }),
      ev(500, 'reply.started', { reply_id: 'r2' }),
    ];
    const spans = buildReplySpans(events, 800);
    expect(spans).toEqual([
      { reply_id: 'r1', start_ms: 0, end_ms: 500 },
      { reply_id: 'r2', start_ms: 500, end_ms: 800 },
    ]);
  });

  it('returns an empty list when no reply.started events exist', () => {
    expect(buildReplySpans([ev(0, 'evaluate', {})], 1000)).toEqual([]);
  });
});

describe('computeReplyAudioRows', () => {
  it('sums speech/silence/overlap seconds per reply, exact to the window size', () => {
    const windowMs = 100;
    const windows: EnergyTimeline['windows'] = [
      { index: 0, t_ms: 0, rms: 2000, has_audio: true, is_speech: true, caller_speaking: false },
      { index: 1, t_ms: 100, rms: 2000, has_audio: true, is_speech: true, caller_speaking: true },
      { index: 2, t_ms: 200, rms: 5, has_audio: true, is_speech: false, caller_speaking: false },
      { index: 3, t_ms: 300, rms: 0, has_audio: false, is_speech: false, caller_speaking: false },
      { index: 4, t_ms: 400, rms: 2000, has_audio: true, is_speech: true, caller_speaking: false },
      { index: 5, t_ms: 500, rms: 2000, has_audio: true, is_speech: true, caller_speaking: true },
      { index: 6, t_ms: 600, rms: 5, has_audio: true, is_speech: false, caller_speaking: false },
      { index: 7, t_ms: 700, rms: 2000, has_audio: true, is_speech: true, caller_speaking: false },
    ];
    const timeline: EnergyTimeline = { window_ms: windowMs, windows, noise_floor_rms: 5, threshold_rms: 50 };
    const spans = [
      { reply_id: 'r1', start_ms: 0, end_ms: 400 },
      { reply_id: 'r2', start_ms: 400, end_ms: 800 },
    ];

    const rows = computeReplyAudioRows(spans, timeline);

    expect(rows).toEqual([
      { reply_id: 'r1', start_ms: 0, end_ms: 400, span_s: 0.4, speech_s: 0.2, silence_s: 0.2, overlap_s: 0.1 },
      { reply_id: 'r2', start_ms: 400, end_ms: 800, span_s: 0.4, speech_s: 0.3, silence_s: 0.1, overlap_s: 0.1 },
    ]);
  });

  it('returns an empty row for a span with no windows in range', () => {
    const timeline: EnergyTimeline = { window_ms: 100, windows: [], noise_floor_rms: 0, threshold_rms: 0 };
    const rows = computeReplyAudioRows([{ reply_id: 'r1', start_ms: 0, end_ms: 100 }], timeline);
    expect(rows).toEqual([{ reply_id: 'r1', start_ms: 0, end_ms: 100, span_s: 0.1, speech_s: 0, silence_s: 0, overlap_s: 0 }]);
  });
});
