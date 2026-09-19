#!/usr/bin/env -S npx tsx
// scripts/rehearse/audioTimeline.ts
// Offline `npm run audio:timeline -- <run>.agent.wav <run>.diagnostics.json` re-analysis
// command: recomputes and prints the SAME "Audio (captured at the harness)" section
// (audioReport.ts) a live run's report already includes, from files alone -- no live call, no
// server, no network. Reads the WAV (readWavFile, wav.ts) for the PCM, the frame-index sidecar
// written next to it (same basename, `.agent-frames.json`, per artifacts.ts's
// `writeRunArtifacts`) for the t_ms -> byte-range mapping a WAV file alone cannot carry, and the
// run's `.diagnostics.json` bundle for the reply.started/reply.done/input.speech.* server_events
// the section joins against. Every run recorded from now on (with the new capture wired into
// wsClient.ts) can be re-analyzed this way without spending another live AssemblyAI call.
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWavFile } from './wav.js';
import { buildAgentAudioReportSection, renderAgentAudioMarkdown, type AgentAudioReportSection } from './audioReport.js';
import type { AgentAudioFrame } from './agentAudioCapture.js';
import type { RehearseDiagnosticBundle } from './types.js';

export interface AgentAudioFramesSidecar {
  frames: AgentAudioFrame[];
  truncated: boolean;
  total_bytes_received: number;
  sample_rate: number;
}

/** Derives the frame-index sidecar's path from the `.agent.wav` path, per report.ts's
 *  `agentAudioFileName`/`agentAudioFramesFileName` shared basename convention
 *  (`<ts>-<scenario>.agent.wav` / `<ts>-<scenario>.agent-frames.json`). */
export function framesPathFor(wavPath: string): string {
  const suffix = '.agent.wav';
  if (!wavPath.endsWith(suffix)) {
    throw new Error(`framesPathFor: expected a path ending in "${suffix}", got ${wavPath}`);
  }
  return `${wavPath.slice(0, -suffix.length)}.agent-frames.json`;
}

/** The re-analysis, as a pure function of file CONTENTS (not paths) -- directly unit-testable
 *  without touching disk. `wavPathLabel` is only used as the section's displayed `wav_path` (a
 *  short label, not re-read from here). */
export function recomputeAgentAudioReportSection(
  wavBytes: Buffer,
  framesSidecar: AgentAudioFramesSidecar,
  bundle: RehearseDiagnosticBundle | null,
  wavPathLabel: string,
): AgentAudioReportSection {
  const { pcm } = readWavFile(wavBytes);
  return buildAgentAudioReportSection(
    framesSidecar.frames,
    pcm,
    framesSidecar.truncated,
    framesSidecar.total_bytes_received,
    bundle?.server_events ?? [],
    wavPathLabel,
  );
}

async function main(): Promise<void> {
  const [wavArg, diagnosticsArg] = process.argv.slice(2);
  if (!wavArg || !diagnosticsArg) {
    console.error('usage: npm run audio:timeline -- <run>.agent.wav <run>.diagnostics.json');
    process.exitCode = 2;
    return;
  }

  let framesArg: string;
  try {
    framesArg = framesPathFor(wavArg);
  } catch (err) {
    console.error(`audio:timeline: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
    return;
  }

  let wavBytes: Buffer;
  let framesSidecar: AgentAudioFramesSidecar;
  let bundle: RehearseDiagnosticBundle | null;
  try {
    wavBytes = await readFile(wavArg);
  } catch (err) {
    console.error(`audio:timeline: could not read ${wavArg}: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
    return;
  }
  try {
    framesSidecar = JSON.parse(await readFile(framesArg, 'utf-8')) as AgentAudioFramesSidecar;
  } catch (err) {
    console.error(
      `audio:timeline: could not read the frame-index sidecar ${framesArg} (expected next to the .agent.wav file, same basename): ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 2;
    return;
  }
  try {
    bundle = JSON.parse(await readFile(diagnosticsArg, 'utf-8')) as RehearseDiagnosticBundle | null;
  } catch (err) {
    console.error(`audio:timeline: could not read ${diagnosticsArg}: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
    return;
  }

  const section = recomputeAgentAudioReportSection(wavBytes, framesSidecar, bundle, basename(wavArg));
  console.log(renderAgentAudioMarkdown(section));
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) void main();
