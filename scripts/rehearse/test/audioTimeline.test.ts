// scripts/rehearse/test/audioTimeline.test.ts
// Proves the offline `npm run audio:timeline` re-analysis path: framesPathFor derives the
// sidecar path from the .agent.wav basename convention, and recomputeAgentAudioReportSection
// reproduces the SAME section a live run would have shown, from a WAV file's bytes + the frame
// index sidecar + a diagnostics bundle -- no live call, no server, no network.
import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildWavFile } from '../wav.js';
import { framesPathFor, recomputeAgentAudioReportSection, type AgentAudioFramesSidecar } from '../audioTimeline.js';
import type { RehearseDiagnosticBundle } from '../types.js';

function burst(amplitude: number, sampleCount: number): Buffer {
  const buf = Buffer.alloc(sampleCount * 2);
  for (let i = 0; i < sampleCount; i++) buf.writeInt16LE(i % 2 === 0 ? amplitude : -amplitude, i * 2);
  return buf;
}

describe('framesPathFor', () => {
  it('derives the .agent-frames.json sidecar path from a .agent.wav path, same basename', () => {
    expect(framesPathFor('/x/2026-09-19T14-00-06-miller-patient.agent.wav')).toBe('/x/2026-09-19T14-00-06-miller-patient.agent-frames.json');
  });

  it('throws on a path that does not end in .agent.wav', () => {
    expect(() => framesPathFor('/x/run.wav')).toThrow();
  });
});

describe('recomputeAgentAudioReportSection', () => {
  it('reproduces the same reply rows a live run would have computed, from WAV bytes + sidecar + bundle', () => {
    // Two 250ms windows so the speech/silence threshold (derived from the data itself) has a
    // real quiet-vs-loud contrast to work with -- window 0 quiet, window 1 loud.
    const quiet = burst(5, 50);
    const loud = burst(2000, 50);
    const pcm = Buffer.concat([quiet, loud]);
    const wav = buildWavFile(pcm, 24_000);
    const sidecar: AgentAudioFramesSidecar = {
      frames: [
        { t_ms: 10, byte_offset: 0, byte_length: quiet.length },
        { t_ms: 260, byte_offset: quiet.length, byte_length: loud.length },
      ],
      truncated: false,
      total_bytes_received: pcm.length,
      sample_rate: 24_000,
    };
    const bundle: RehearseDiagnosticBundle = {
      session_id: 'sess-1',
      started_at: 0,
      ended_at: 1000,
      end_reason: 'caller_ended',
      deployed_commit: null,
      server_events: [{ t_ms: 0, kind: 'reply.started', detail: { reply_id: 'r1' } }],
      client_events: [],
    };

    const section = recomputeAgentAudioReportSection(wav, sidecar, bundle, 'run.agent.wav');

    expect(section.wav_path).toBe('run.agent.wav');
    expect(section.reply_rows).toEqual([{ reply_id: 'r1', start_ms: 0, end_ms: 260, span_s: 0.26, speech_s: 0.25, silence_s: 0.25, overlap_s: 0 }]);
  });

  it('recomputes the same section end-to-end from files written to disk (round trip through readFile)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rehearse-audio-timeline-'));
    const quiet = burst(5, 50);
    const wav = buildWavFile(quiet, 24_000);
    const wavPath = join(dir, 'run.agent.wav');
    const framesPath = framesPathFor(wavPath);
    const diagnosticsPath = join(dir, 'run.diagnostics.json');

    await writeFile(wavPath, wav);
    const sidecar: AgentAudioFramesSidecar = {
      frames: [{ t_ms: 0, byte_offset: 0, byte_length: quiet.length }],
      truncated: false,
      total_bytes_received: quiet.length,
      sample_rate: 24_000,
    };
    await writeFile(framesPath, JSON.stringify(sidecar), 'utf-8');
    const bundle: RehearseDiagnosticBundle = {
      session_id: 'sess-1',
      started_at: 0,
      ended_at: 1000,
      end_reason: 'caller_ended',
      deployed_commit: null,
      server_events: [],
      client_events: [],
    };
    await writeFile(diagnosticsPath, JSON.stringify(bundle), 'utf-8');

    const wavBytes = await readFile(wavPath);
    const framesSidecar = JSON.parse(await readFile(framesPath, 'utf-8')) as AgentAudioFramesSidecar;
    const diagnosticsBundle = JSON.parse(await readFile(diagnosticsPath, 'utf-8')) as RehearseDiagnosticBundle;

    const section = recomputeAgentAudioReportSection(wavBytes, framesSidecar, diagnosticsBundle, 'run.agent.wav');
    expect(section.captured_bytes).toBe(quiet.length);
    expect(section.wav_path).toBe('run.agent.wav');
  });
});
