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
import type { RehearseDiagnosticBundle, RunResult, Scenario } from '../types.js';

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
      deployed_commit: null,
      ended_at_ms: 42000,
      end_reason: 'caller_ended',
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
});
