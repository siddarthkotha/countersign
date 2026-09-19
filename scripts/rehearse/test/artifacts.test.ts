// scripts/rehearse/test/artifacts.test.ts
// Proves that a rehearsal run's on-disk artifacts include the RAW flight-recorder diagnostics
// bundle (GET /api/session/<id>/diagnostics), not just the report's summarized table -- see
// docs/REHEARSAL-HARNESS.md and the founder-flagged gap this closes: a failed live run had no
// way to be replayed offline because the raw bundle was fetched, summarized, then discarded.
// Uses a FAKE in-memory bundle only -- no server, no network, no live AssemblyAI call.
import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeRunArtifacts } from '../artifacts.js';
import { readWavFile } from '../wav.js';
import type { AgentAudioCaptureSnapshot } from '../agentAudioCapture.js';
import type { RehearseDiagnosticBundle, RunResult, Scenario } from '../types.js';

function burst(amplitude: number, sampleCount: number): Buffer {
  const buf = Buffer.alloc(sampleCount * 2);
  for (let i = 0; i < sampleCount; i++) buf.writeInt16LE(i % 2 === 0 ? amplitude : -amplitude, i * 2);
  return buf;
}

const scenario: Scenario = {
  name: 'test-scenario',
  title: 'Test Scenario',
  description: 'a scenario for artifact-writing tests',
  source: 'inline test fixture',
  turns: [{ id: 'c1', text: 'hello' }],
  expected: { verdict: 'STAGE', max_wall_ms: 60000 },
};

function baseResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    scenario,
    target_url: 'http://localhost:8787',
    session_id: 'sess-1',
    started_at_iso: '2026-09-03T00:00:00.000Z',
    ended_reason: 'caller_ended',
    verdict_reached: true,
    actual_verdict: 'STAGE',
    pass: true,
    timings: { ready_ms: 250, first_audio_ms: 300, turn_gaps: [], total_wall_ms: 42000 },
    transcript: [],
    state_history: [],
    diagnostics: {
      ok: true,
      event_kind_counts: { evaluate: 1 },
      tool_events: [],
      evaluate_events: [],
      transcript_events: [],
      deployed_commit: null,
      ended_at_ms: 42000,
      end_reason: 'caller_ended',
      session_minted_event: null,
      call_context_event: null,
      greeting_configured: null,
    },
    warnings: [],
    exit_code: 0,
    minutes_estimate: 0.7,
    resolved_lines: [],
    caller_mode: 'reactive',
    raw_diagnostics: null,
    close_line_status: 'n/a',
    ...overrides,
  };
}

const fakeBundle: RehearseDiagnosticBundle = {
  session_id: 'sess-1',
  started_at: 0,
  ended_at: 42000,
  end_reason: 'caller_ended',
  deployed_commit: 'abc123',
  server_events: [{ t_ms: 10, kind: 'evaluate', detail: { verdict: 'STAGE' } }],
  client_events: [{ t_ms: 5, kind: 'client_audio', detail: {} }],
};

describe('writeRunArtifacts', () => {
  it('writes the raw diagnostics bundle as JSON next to the markdown report, same basename', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rehearse-artifacts-'));
    const result = baseResult({ raw_diagnostics: fakeBundle });
    const at = new Date('2026-09-03T22:41:05');

    const { reportPath, diagnosticsPath } = await writeRunArtifacts(result, dir, at);

    expect(reportPath).toBe(join(dir, '2026-09-03T22-41-05-test-scenario.md'));
    expect(diagnosticsPath).toBe(join(dir, '2026-09-03T22-41-05-test-scenario.diagnostics.json'));

    const diagContent = JSON.parse(await readFile(diagnosticsPath, 'utf-8'));
    expect(diagContent).toEqual(fakeBundle);

    const reportContent = await readFile(reportPath, 'utf-8');
    expect(reportContent).toContain('# Rehearsal report: Test Scenario');

    const files = await readdir(dir);
    expect(files.sort()).toEqual([
      '2026-09-03T22-41-05-test-scenario.diagnostics.json',
      '2026-09-03T22-41-05-test-scenario.md',
    ]);
  });

  it('writes a JSON null when no diagnostics bundle was fetched (still produces the file)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rehearse-artifacts-'));
    const result = baseResult({ raw_diagnostics: null });

    const { diagnosticsPath } = await writeRunArtifacts(result, dir);

    const diagContent = await readFile(diagnosticsPath, 'utf-8');
    expect(diagContent.trim()).toBe('null');
  });

  // GAP: THE HARNESS RECORDS TRANSCRIPTS, NOT AUDIO (board item, 2026-09-19).
  it('writes the agent audio as a WAV file plus a frame-index sidecar when raw_agent_audio has captured frames, and the report references the wav path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rehearse-artifacts-'));
    const loud = burst(2000, 50);
    const rawAgentAudio: AgentAudioCaptureSnapshot = {
      pcm: loud,
      frames: [{ t_ms: 10, byte_offset: 0, byte_length: loud.length }],
      truncated: false,
      total_bytes_received: loud.length,
    };
    const result = baseResult({
      raw_diagnostics: bundleWith([{ t_ms: 0, kind: 'reply.started', detail: { reply_id: 'r1' } }]),
      raw_agent_audio: rawAgentAudio,
    });
    const at = new Date('2026-09-19T12:00:00');

    const { reportPath, agentAudioPath, agentAudioFramesPath } = await writeRunArtifacts(result, dir, at);

    expect(agentAudioPath).not.toBeNull();
    expect(agentAudioFramesPath).not.toBeNull();

    const wavOnDisk = await readFile(agentAudioPath!);
    const info = readWavFile(wavOnDisk);
    expect(info.pcm).toEqual(loud);
    expect(info.sampleRate).toBe(24_000);

    const sidecar = JSON.parse(await readFile(agentAudioFramesPath!, 'utf-8'));
    expect(sidecar.frames).toEqual(rawAgentAudio.frames);
    expect(sidecar.truncated).toBe(false);
    expect(sidecar.sample_rate).toBe(24_000);

    const reportContent = await readFile(reportPath, 'utf-8');
    expect(reportContent).toContain('## Audio (captured at the harness)');
    expect(reportContent).toContain('.agent.wav');
    expect(reportContent).toContain('r1');

    const files = await readdir(dir);
    expect(files.length).toBe(4); // .md, .diagnostics.json, .agent.wav, .agent-frames.json
  });

  it('writes only report + diagnostics (no wav/sidecar) when raw_agent_audio has zero frames', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rehearse-artifacts-'));
    const result = baseResult({
      raw_agent_audio: { pcm: Buffer.alloc(0), frames: [], truncated: false, total_bytes_received: 0 },
    });

    const { agentAudioPath, agentAudioFramesPath } = await writeRunArtifacts(result, dir);
    expect(agentAudioPath).toBeNull();
    expect(agentAudioFramesPath).toBeNull();

    const files = await readdir(dir);
    expect(files.length).toBe(2);
  });
});

function bundleWith(events: RehearseDiagnosticBundle['server_events']): RehearseDiagnosticBundle {
  return {
    session_id: 'sess-1',
    started_at: 0,
    ended_at: 1000,
    end_reason: 'caller_ended',
    deployed_commit: null,
    server_events: events,
    client_events: [],
  };
}
