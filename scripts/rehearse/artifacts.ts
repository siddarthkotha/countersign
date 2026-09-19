// scripts/rehearse/artifacts.ts
// Writes one rehearsal run's on-disk artifacts to the reports directory
// (scripts/rehearse/reports/, gitignored -- see .gitignore and docs/REHEARSAL-HARNESS.md):
// the markdown report (report.ts's renderReport) AND, next to it with the same basename, the
// exact raw flight-recorder bundle GET /api/session/<id>/diagnostics returned for that call
// (RunResult.raw_diagnostics). Before this file existed, the raw bundle was fetched,
// summarized into the report's own "Flight recorder bundle" table, and then discarded --
// leaving no way to replay a failed live run offline, and forcing an investigator to
// reconstruct exact event timestamps by hand from the report's summarized table instead of
// reading the source data directly.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { agentAudioFileName, agentAudioFramesFileName, diagnosticsFileName, renderReport, reportFileName } from './report.js';
import { AGENT_AUDIO_SAMPLE_RATE } from './agentAudioCapture.js';
import { writeWavFile } from './wav.js';
import { buildAgentAudioReportSection, type AgentAudioReportSection } from './audioReport.js';
import type { RunResult } from './types.js';

export interface WrittenRunArtifacts {
  reportPath: string;
  diagnosticsPath: string;
  /** null when `result.raw_agent_audio` had zero captured frames (nothing to write) --
   *  GAP: THE HARNESS RECORDS TRANSCRIPTS, NOT AUDIO, 2026-09-19. */
  agentAudioPath: string | null;
  agentAudioFramesPath: string | null;
}

/** Writes a run's on-disk artifacts into `reportsDir`, using the SAME timestamp (`at`) for every
 *  file name so they share a basename (e.g. `<ts>-<scenario>.md`,
 *  `<ts>-<scenario>.diagnostics.json`, `<ts>-<scenario>.agent.wav`,
 *  `<ts>-<scenario>.agent-frames.json`). `result.raw_diagnostics` is written verbatim (even
 *  `null`, when no bundle was ever fetched) -- this function never reinterprets or summarizes
 *  it, only persists whatever the caller already holds in memory.
 *
 *  GAP: THE HARNESS RECORDS TRANSCRIPTS, NOT AUDIO (board item, 2026-09-19): when
 *  `result.raw_agent_audio` carries at least one captured frame, this also writes the agent's
 *  audio as a WAV file, a small JSON sidecar with the frame index (t_ms -> byte range, needed
 *  because a WAV file alone has no per-frame timing), and computes the report's own "Audio
 *  (captured at the harness)" section (audioReport.ts) BEFORE rendering the markdown report, so
 *  the report can reference the WAV path and show the per-reply speech/silence/overlap table.
 *  A run with no captured audio at all (never connected, or a pre-existing report being
 *  re-rendered by regrade.ts) writes only the report + diagnostics files, exactly as before this
 *  fix -- see the "no extra files" assertion in test/artifacts.test.ts. */
export async function writeRunArtifacts(result: RunResult, reportsDir: string, at: Date = new Date()): Promise<WrittenRunArtifacts> {
  const diagnosticsPath = join(reportsDir, diagnosticsFileName(result.scenario.name, at));
  await writeFile(diagnosticsPath, JSON.stringify(result.raw_diagnostics, null, 2), 'utf-8');

  let agentAudioPath: string | null = null;
  let agentAudioFramesPath: string | null = null;
  let audioSection: AgentAudioReportSection | null = null;

  const raw = result.raw_agent_audio;
  if (raw && raw.frames.length > 0) {
    const wavFileName = agentAudioFileName(result.scenario.name, at);
    const framesFileName = agentAudioFramesFileName(result.scenario.name, at);
    agentAudioPath = join(reportsDir, wavFileName);
    agentAudioFramesPath = join(reportsDir, framesFileName);

    await writeWavFile(agentAudioPath, raw.pcm, AGENT_AUDIO_SAMPLE_RATE);
    await writeFile(
      agentAudioFramesPath,
      JSON.stringify(
        { frames: raw.frames, truncated: raw.truncated, total_bytes_received: raw.total_bytes_received, sample_rate: AGENT_AUDIO_SAMPLE_RATE },
        null,
        2,
      ),
      'utf-8',
    );

    audioSection = buildAgentAudioReportSection(
      raw.frames,
      raw.pcm,
      raw.truncated,
      raw.total_bytes_received,
      result.raw_diagnostics?.server_events ?? [],
      wavFileName,
    );
  }

  const reportPath = join(reportsDir, reportFileName(result.scenario.name, at));
  await writeFile(reportPath, renderReport(result, audioSection), 'utf-8');

  return { reportPath, diagnosticsPath, agentAudioPath, agentAudioFramesPath };
}
