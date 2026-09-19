// scripts/rehearse/audioEnergy.ts
// Turns captured agent PCM (agentAudioCapture.ts) into a per-window speech/silence energy
// timeline, joined against the flight recorder's own reply.started/reply.done and
// input.speech.started/stopped server_events -- see agentAudioCapture.ts's own top-of-file doc
// comment for the gap this closes (GAP: THE HARNESS RECORDS TRANSCRIPTS, NOT AUDIO, 2026-09-19).
//
// Windowing is anchored to HARNESS-CLOCK ARRIVAL TIME (`t_ms`), not byte position: window i
// covers [i*ENERGY_WINDOW_MS, (i+1)*ENERGY_WINDOW_MS). A window's RMS is computed over every
// captured PCM byte belonging to a frame whose own `t_ms` falls in that range. A window with no
// captured frames at all is silence by definition (rms 0, has_audio false) -- there is nothing
// in the PCM to be anything else.
//
// t_ms convention: the harness's own audio-frame timestamps and the flight recorder's own
// server_events (reply.started/reply.done/input.speech.*) are already treated as directly
// comparable elsewhere in this harness -- report.ts's `renderCloseTailAudioSummary` joins a
// reply.done server_event's t_ms against harness timings the same way, with no clock-offset
// reconciliation anywhere in this codebase. Both clocks start within milliseconds of each other
// (WebSocket connect on the harness side, bundle creation at WS attach on the server side, the
// same instant in practice). This module follows the same convention, stated here rather than
// assumed silently.
import type { AgentAudioFrame } from './agentAudioCapture.js';
import type { RehearseDiagnosticEvent } from './types.js';

export const ENERGY_WINDOW_MS = 250;

export interface EnergyWindow {
  index: number;
  t_ms: number;
  rms: number;
  has_audio: boolean;
  is_speech: boolean;
  caller_speaking: boolean;
}

export interface EnergyTimeline {
  window_ms: number;
  windows: EnergyWindow[];
  noise_floor_rms: number;
  threshold_rms: number;
}

export interface CallerSpeechInterval {
  start_ms: number;
  end_ms: number;
}

export interface ReplySpan {
  reply_id: string;
  start_ms: number;
  end_ms: number;
}

export interface ReplyAudioRow {
  reply_id: string;
  start_ms: number;
  end_ms: number;
  span_s: number;
  speech_s: number;
  silence_s: number;
  overlap_s: number;
}

function rmsOf(samples: Int16Array): number {
  if (samples.length === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    sumSquares += s * s;
  }
  return Math.sqrt(sumSquares / samples.length);
}

function bytesToInt16(buf: Buffer): Int16Array {
  const sampleCount = Math.floor(buf.length / 2);
  const out = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) out[i] = buf.readInt16LE(i * 2);
  return out;
}

/** Pairs each `input.speech.started` server_event with the next `input.speech.stopped` -- PROVEN
 *  kinds: packages/server/src/call/session.ts's `input.speech.started`/`input.speech.stopped`
 *  diag calls. An unmatched trailing `started` (the call ended mid-caller-turn) is closed at
 *  `callEndMs` rather than silently dropped, so a caller who was still talking when the call
 *  ended still counts as having been talking right up to the end. */
export function buildCallerSpeechIntervals(events: RehearseDiagnosticEvent[], callEndMs: number): CallerSpeechInterval[] {
  const intervals: CallerSpeechInterval[] = [];
  let openStart: number | null = null;
  const sorted = [...events].sort((a, b) => a.t_ms - b.t_ms);
  for (const e of sorted) {
    if (e.kind === 'input.speech.started' && openStart === null) {
      openStart = e.t_ms;
    } else if (e.kind === 'input.speech.stopped' && openStart !== null) {
      intervals.push({ start_ms: openStart, end_ms: e.t_ms });
      openStart = null;
    }
  }
  if (openStart !== null) intervals.push({ start_ms: openStart, end_ms: callEndMs });
  return intervals;
}

function overlapsAny(windowStart: number, windowEnd: number, intervals: CallerSpeechInterval[]): boolean {
  return intervals.some((iv) => windowStart < iv.end_ms && windowEnd > iv.start_ms);
}

/** Reply spans: from `t_ms`-ordered `reply.started` events, each reply's span runs until the
 *  NEXT reply's `reply.started` (or `lastMs` for the final reply) -- NOT until its own
 *  `reply.done`, because relayed audio for a reply routinely continues to arrive after that
 *  reply's own `reply.done` fires (the exact CLOSE-TAIL-AUDIO-SECONDS-UNDERCOUNT gap this module
 *  makes visible at the audio level; packages/server/src/call/session.ts's
 *  `finalizeReplyAudioSummary` attributes bytes to a reply the same way, up to the next
 *  `reply.started`). */
export function buildReplySpans(events: RehearseDiagnosticEvent[], lastMs: number): ReplySpan[] {
  const starts = events
    .filter(
      (e): e is RehearseDiagnosticEvent & { detail: { reply_id: string } } =>
        e.kind === 'reply.started' &&
        typeof e.detail === 'object' &&
        e.detail !== null &&
        typeof (e.detail as Record<string, unknown>).reply_id === 'string',
    )
    .map((e) => ({ reply_id: (e.detail as { reply_id: string }).reply_id, t_ms: e.t_ms }))
    .sort((a, b) => a.t_ms - b.t_ms);

  const spans: ReplySpan[] = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i]!;
    const end = i + 1 < starts.length ? starts[i + 1]!.t_ms : lastMs;
    spans.push({ reply_id: start.reply_id, start_ms: start.t_ms, end_ms: Math.max(end, start.t_ms) });
  }
  return spans;
}

/** RMS per `windowMs` window (default 250ms) over every captured agent-audio frame, plus a
 *  speech/silence classification derived from the frames themselves: the noise floor is the
 *  RMS at the 10th percentile of windows that HAVE audio (a window with zero captured frames is
 *  a true silence gap, not "quiet audio", and would otherwise drag the floor to zero and make
 *  the threshold meaningless); the speech threshold is 3x that floor, with a small absolute
 *  floor (50) so a near-silent whole capture doesn't classify its own noise as speech. Both
 *  numbers are carried on the result so a report can state exactly how "speech" was decided,
 *  never a hidden magic constant. */
export function computeEnergyTimeline(
  frames: AgentAudioFrame[],
  pcm: Buffer,
  callerIntervals: CallerSpeechInterval[],
  windowMs: number = ENERGY_WINDOW_MS,
): EnergyTimeline {
  if (frames.length === 0) {
    return { window_ms: windowMs, windows: [], noise_floor_rms: 0, threshold_rms: 0 };
  }
  const lastFrameMs = frames.reduce((max, f) => Math.max(max, f.t_ms), 0);
  const windowCount = Math.floor(lastFrameMs / windowMs) + 1;

  const bucketed: Buffer[][] = Array.from({ length: windowCount }, () => []);
  for (const f of frames) {
    const idx = Math.min(Math.floor(f.t_ms / windowMs), windowCount - 1);
    bucketed[idx]!.push(pcm.subarray(f.byte_offset, f.byte_offset + f.byte_length));
  }

  const rawWindows = bucketed.map((bufs, index) => {
    const hasAudio = bufs.length > 0;
    const windowRms = hasAudio ? rmsOf(bytesToInt16(Buffer.concat(bufs))) : 0;
    return { index, t_ms: index * windowMs, rms: windowRms, has_audio: hasAudio };
  });

  const audioRmsValues = rawWindows
    .filter((w) => w.has_audio)
    .map((w) => w.rms)
    .sort((a, b) => a - b);
  const noiseFloor = audioRmsValues.length > 0 ? (audioRmsValues[Math.floor(audioRmsValues.length * 0.1)] ?? audioRmsValues[0]!) : 0;
  const threshold = Math.max(noiseFloor * 3, 50);

  const windows: EnergyWindow[] = rawWindows.map((w) => {
    const windowEnd = w.t_ms + windowMs;
    return {
      index: w.index,
      t_ms: w.t_ms,
      rms: w.rms,
      has_audio: w.has_audio,
      is_speech: w.has_audio && w.rms > threshold,
      caller_speaking: overlapsAny(w.t_ms, windowEnd, callerIntervals),
    };
  });

  return { window_ms: windowMs, windows, noise_floor_rms: noiseFloor, threshold_rms: threshold };
}

/** Per-reply totals: a window belongs to whichever span its OWN start time falls into (spans
 *  are contiguous -- see `buildReplySpans` -- so every window in range belongs to exactly one
 *  span). Exact to `timeline.window_ms`: a window is never split across two replies. */
export function computeReplyAudioRows(spans: ReplySpan[], timeline: EnergyTimeline): ReplyAudioRow[] {
  const windowS = timeline.window_ms / 1000;
  return spans.map((span) => {
    let speechS = 0;
    let silenceS = 0;
    let overlapS = 0;
    for (const w of timeline.windows) {
      if (w.t_ms < span.start_ms || w.t_ms >= span.end_ms) continue;
      if (w.is_speech) {
        speechS += windowS;
        if (w.caller_speaking) overlapS += windowS;
      } else {
        silenceS += windowS;
      }
    }
    return {
      reply_id: span.reply_id,
      start_ms: span.start_ms,
      end_ms: span.end_ms,
      span_s: (span.end_ms - span.start_ms) / 1000,
      speech_s: Math.round(speechS * 1000) / 1000,
      silence_s: Math.round(silenceS * 1000) / 1000,
      overlap_s: Math.round(overlapS * 1000) / 1000,
    };
  });
}
