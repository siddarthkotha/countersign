// scripts/rehearse/audioReport.ts
// Assembles the rehearsal report's "Audio (captured at the harness)" section from a captured
// agent-audio snapshot (agentAudioCapture.ts) plus the flight recorder bundle's own
// reply.started/reply.done/input.speech.* server_events (audioEnergy.ts does the actual energy/
// overlap math). Shared by report.ts (a live run) and audioTimeline.ts (the offline
// `npm run audio:timeline` re-analysis command) so both render EXACTLY the same section from
// the same inputs -- see agentAudioCapture.ts's own top-of-file doc comment for the gap this
// closes (GAP: THE HARNESS RECORDS TRANSCRIPTS, NOT AUDIO, 2026-09-19).
import { AGENT_AUDIO_BYTES_PER_SECOND, type AgentAudioFrame } from './agentAudioCapture.js';
import {
  buildCallerSpeechIntervals,
  buildReplySpans,
  computeEnergyTimeline,
  computeReplyAudioRows,
  type EnergyTimeline,
  type ReplyAudioRow,
} from './audioEnergy.js';
import type { RehearseDiagnosticEvent } from './types.js';

export interface AgentAudioReportSection {
  /** Relative filename (not a full path) of the `.agent.wav` file this section describes, or
   *  null when no agent audio frame was ever captured for this call (nothing to report). */
  wav_path: string | null;
  truncated: boolean;
  total_bytes_received: number;
  captured_bytes: number;
  reply_rows: ReplyAudioRow[];
  timeline_lines: string[];
  noise_floor_rms: number;
  threshold_rms: number;
}

/** One line per ~10s of call: `#` speech, `.` silence, `!` speech overlapping caller speech
 *  (what a founder hears as being talked over) -- one character per energy window. */
export function renderTimelineChars(timeline: EnergyTimeline): string[] {
  if (timeline.windows.length === 0) return [];
  const perLine = Math.max(1, Math.round(10_000 / timeline.window_ms));
  const lines: string[] = [];
  for (let i = 0; i < timeline.windows.length; i += perLine) {
    const slice = timeline.windows.slice(i, i + perLine);
    const chars = slice.map((w) => (w.is_speech && w.caller_speaking ? '!' : w.is_speech ? '#' : '.')).join('');
    const startS = Math.floor((i * timeline.window_ms) / 1000);
    lines.push(`${String(startS).padStart(4, ' ')}s ${chars}`);
  }
  return lines;
}

export function buildAgentAudioReportSection(
  frames: AgentAudioFrame[],
  pcm: Buffer,
  truncated: boolean,
  totalBytesReceived: number,
  serverEvents: RehearseDiagnosticEvent[],
  wavPath: string | null,
): AgentAudioReportSection {
  if (frames.length === 0) {
    return {
      wav_path: null,
      truncated,
      total_bytes_received: totalBytesReceived,
      captured_bytes: 0,
      reply_rows: [],
      timeline_lines: [],
      noise_floor_rms: 0,
      threshold_rms: 0,
    };
  }
  const lastMs = frames.reduce((max, f) => Math.max(max, f.t_ms), 0);
  const callerIntervals = buildCallerSpeechIntervals(serverEvents, lastMs);
  const timeline = computeEnergyTimeline(frames, pcm, callerIntervals);
  const spans = buildReplySpans(serverEvents, lastMs);
  const replyRows = computeReplyAudioRows(spans, timeline);
  return {
    wav_path: wavPath,
    truncated,
    total_bytes_received: totalBytesReceived,
    captured_bytes: pcm.length,
    reply_rows: replyRows,
    timeline_lines: renderTimelineChars(timeline),
    noise_floor_rms: timeline.noise_floor_rms,
    threshold_rms: timeline.threshold_rms,
  };
}

export function renderAgentAudioMarkdown(section: AgentAudioReportSection): string {
  const lines: string[] = [];
  lines.push('## Audio (captured at the harness)');
  lines.push('');
  if (section.wav_path === null) {
    lines.push('_No agent audio frames were captured for this call._');
    lines.push('');
    return lines.join('\n');
  }
  const capturedSeconds = section.captured_bytes / AGENT_AUDIO_BYTES_PER_SECOND;
  lines.push(`- Captured file: \`${section.wav_path}\` (24 kHz mono 16-bit PCM, ${capturedSeconds.toFixed(1)}s of audio bytes captured)`);
  if (section.truncated) {
    lines.push(
      `- TRUNCATED: ${section.total_bytes_received} bytes were relayed but only the first ${section.captured_bytes} were captured (20 MB cap) -- the tail of this call's audio is not in the WAV file.`,
    );
  }
  lines.push(
    `- Speech/silence threshold: RMS > ${section.threshold_rms.toFixed(1)} counts as speech (derived: 3x the RMS of the quietest 10% of 250ms windows that had any audio; noise floor ${section.noise_floor_rms.toFixed(1)}).`,
  );
  lines.push('');
  lines.push('| reply_id | span | speech (s) | silence (s) | overlap with caller (s) |');
  lines.push('| --- | --- | --- | --- | --- |');
  if (section.reply_rows.length === 0) {
    lines.push('| _none_ |  |  |  |  |');
  } else {
    for (const row of section.reply_rows) {
      lines.push(
        `| ${row.reply_id} | ${Math.round(row.start_ms)}-${Math.round(row.end_ms)}ms (${row.span_s.toFixed(1)}s) | ${row.speech_s.toFixed(2)} | ${row.silence_s.toFixed(2)} | ${row.overlap_s.toFixed(2)} |`,
      );
    }
  }
  lines.push('');
  lines.push("Timeline (one line per 10s; '#' speech, '.' silence, '!' speech overlapping caller speech):");
  lines.push('');
  lines.push('```');
  for (const l of section.timeline_lines) lines.push(l);
  lines.push('```');
  lines.push('');
  return lines.join('\n');
}
