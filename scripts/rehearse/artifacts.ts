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
import { diagnosticsFileName, renderReport, reportFileName } from './report.js';
import type { RunResult } from './types.js';

export interface WrittenRunArtifacts {
  reportPath: string;
  diagnosticsPath: string;
}

/** Writes both files for one run into `reportsDir`, using the SAME timestamp (`at`) for both
 *  file names so they share a basename (e.g. `<ts>-<scenario>.md` and
 *  `<ts>-<scenario>.diagnostics.json`). `result.raw_diagnostics` is written verbatim (even
 *  `null`, when no bundle was ever fetched) -- this function never reinterprets or summarizes
 *  it, only persists whatever the caller already holds in memory. */
export async function writeRunArtifacts(result: RunResult, reportsDir: string, at: Date = new Date()): Promise<WrittenRunArtifacts> {
  const reportPath = join(reportsDir, reportFileName(result.scenario.name, at));
  await writeFile(reportPath, renderReport(result), 'utf-8');

  const diagnosticsPath = join(reportsDir, diagnosticsFileName(result.scenario.name, at));
  await writeFile(diagnosticsPath, JSON.stringify(result.raw_diagnostics, null, 2), 'utf-8');

  return { reportPath, diagnosticsPath };
}
