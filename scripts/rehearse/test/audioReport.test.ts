// scripts/rehearse/test/audioReport.test.ts
// Proves buildAgentAudioReportSection composes the frame index + reply.started/reply.done +
// input.speech.* server_events into the right reply rows and timeline text, and that
// renderAgentAudioMarkdown renders a readable section (or the explicit "no audio captured"
// line when nothing was ever received). No network, no live server.
import { describe, expect, it } from 'vitest';
import type { AgentAudioFrame } from '../agentAudioCapture.js';
import { buildAgentAudioReportSection, renderAgentAudioMarkdown, renderTimelineChars } from '../audioReport.js';
import type { EnergyTimeline } from '../audioEnergy.js';
import type { RehearseDiagnosticEvent } from '../types.js';

function burst(amplitude: number, sampleCount: number): Buffer {
  const buf = Buffer.alloc(sampleCount * 2);
  for (let i = 0; i < sampleCount; i++) buf.writeInt16LE(i % 2 === 0 ? amplitude : -amplitude, i * 2);
  return buf;
}

describe('buildAgentAudioReportSection', () => {
  it('reports "no audio captured" (wav_path null) when zero frames were captured', () => {
    const section = buildAgentAudioReportSection([], Buffer.alloc(0), false, 0, [], null);
    expect(section.wav_path).toBeNull();
    expect(section.reply_rows).toEqual([]);
    expect(section.timeline_lines).toEqual([]);
  });

  it('joins captured frames against reply.started events into per-reply speech/silence rows, carries truncation and the wav path through', () => {
    const loud = burst(2000, 50); // one reply's audio: loud (speech)
    const quiet = burst(5, 50); // another reply's audio: quiet (silence)
    const pcm = Buffer.concat([loud, quiet]);
    const frames: AgentAudioFrame[] = [
      { t_ms: 10, byte_offset: 0, byte_length: loud.length },
      { t_ms: 260, byte_offset: loud.length, byte_length: quiet.length },
    ];
    const serverEvents: RehearseDiagnosticEvent[] = [
      { t_ms: 0, kind: 'reply.started', detail: { reply_id: 'r1' } },
      { t_ms: 250, kind: 'reply.started', detail: { reply_id: 'r2' } },
    ];

    const section = buildAgentAudioReportSection(frames, pcm, true, 999_999, serverEvents, '2026-09-19T00-00-00-test.agent.wav');

    expect(section.wav_path).toBe('2026-09-19T00-00-00-test.agent.wav');
    expect(section.truncated).toBe(true);
    expect(section.total_bytes_received).toBe(999_999);
    expect(section.captured_bytes).toBe(pcm.length);
    expect(section.reply_rows.map((r) => r.reply_id)).toEqual(['r1', 'r2']);
    // r1's only window (t=0) is loud -> speech; r2's only window (t=250) is quiet -> silence.
    expect(section.reply_rows[0]!.speech_s).toBeGreaterThan(0);
    expect(section.reply_rows[0]!.silence_s).toBe(0);
    expect(section.reply_rows[1]!.speech_s).toBe(0);
    expect(section.reply_rows[1]!.silence_s).toBeGreaterThan(0);
    expect(section.timeline_lines.length).toBeGreaterThan(0);
  });
});

describe('renderTimelineChars', () => {
  it('renders one character per window, grouped into lines of one 10s block, using # . !', () => {
    const timeline: EnergyTimeline = {
      window_ms: 250,
      windows: [
        { index: 0, t_ms: 0, rms: 2000, has_audio: true, is_speech: true, caller_speaking: false },
        { index: 1, t_ms: 250, rms: 0, has_audio: false, is_speech: false, caller_speaking: false },
        { index: 2, t_ms: 500, rms: 2000, has_audio: true, is_speech: true, caller_speaking: true },
      ],
      noise_floor_rms: 5,
      threshold_rms: 50,
    };
    const lines = renderTimelineChars(timeline);
    expect(lines).toEqual(['   0s #.!']);
  });

  it('starts a new line every 40 windows (10s at 250ms/window)', () => {
    const windows: EnergyTimeline['windows'] = Array.from({ length: 41 }, (_, i) => ({
      index: i,
      t_ms: i * 250,
      rms: 0,
      has_audio: false,
      is_speech: false,
      caller_speaking: false,
    }));
    const lines = renderTimelineChars({ window_ms: 250, windows, noise_floor_rms: 0, threshold_rms: 0 });
    expect(lines.length).toBe(2);
    expect(lines[0]!.length - '   0s '.length).toBe(40);
    expect(lines[1]).toBe('  10s .');
  });

  it('returns no lines for an empty timeline', () => {
    expect(renderTimelineChars({ window_ms: 250, windows: [], noise_floor_rms: 0, threshold_rms: 0 })).toEqual([]);
  });
});

describe('renderAgentAudioMarkdown', () => {
  it('renders the explicit "no audio captured" line when wav_path is null', () => {
    const md = renderAgentAudioMarkdown({
      wav_path: null,
      truncated: false,
      total_bytes_received: 0,
      captured_bytes: 0,
      reply_rows: [],
      timeline_lines: [],
      noise_floor_rms: 0,
      threshold_rms: 0,
    });
    expect(md).toContain('## Audio (captured at the harness)');
    expect(md).toContain('No agent audio frames were captured');
    expect(md).not.toMatch(/—/);
  });

  it('renders the wav path, truncation warning, threshold, reply table, and timeline block', () => {
    const md = renderAgentAudioMarkdown({
      wav_path: 'run.agent.wav',
      truncated: true,
      total_bytes_received: 25_000_000,
      captured_bytes: 20_000_000,
      reply_rows: [{ reply_id: 'r1', start_ms: 0, end_ms: 1000, span_s: 1, speech_s: 0.75, silence_s: 0.25, overlap_s: 0 }],
      timeline_lines: ['   0s ####....'],
      noise_floor_rms: 5,
      threshold_rms: 50,
    });
    expect(md).toContain('run.agent.wav');
    expect(md).toContain('TRUNCATED');
    expect(md).toContain('r1');
    expect(md).toContain('####....');
    expect(md).not.toMatch(/—/);
  });
});
