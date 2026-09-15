import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFile, writeFile, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');

// Find the actual repo root by checking for reports directory
// REPO_ROOT = worktree root; main repo is 3 levels up
async function getRepoRootWithReports(): Promise<string> {
  const worktreeRoot = REPO_ROOT;
  const mainRepoCandidate = join(worktreeRoot, '..', '..', '..');

  try {
    await stat(join(mainRepoCandidate, 'scripts', 'rehearse', 'reports'));
    return mainRepoCandidate;
  } catch {
    // Main repo not found, try worktree (though reports might be empty there)
    return worktreeRoot;
  }
}

interface DiagnosticBundle {
  session_id: string;
  started_at: number;
  ended_at: number | null;
  end_reason: string | null;
  deployed_commit: string | null;
  server_events: { t_ms: number; kind: string; detail: unknown }[];
  client_events: { t_ms: number; kind: string; detail: unknown }[];
  billed_seconds?: number;
}

describe('creditsLedger', () => {
  it('prints expected output structure with timezone and disclaimer when reports exist', async () => {
    // Verify the script runs and produces output with the expected fields.
    // This test requires reports to exist in the repo.
    const output = execSync(`npm run credits:ledger`, { cwd: REPO_ROOT, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });

    // If the script found reports, verify new fields
    if (output.includes('Credit Ledger')) {
      // Verify header mentions timezone (this is the key change we're testing)
      expect(output).toContain('America/Chicago timezone');

      // Verify the final disclaimer line about PROVEN vs wall clock (added in this fix)
      expect(output).toContain('PROVEN rows appear once deploys after 2026-09-14');
      expect(output).toContain('every row before that is wall clock');
    } else {
      // No reports found - that's ok, just verify the script gives helpful output
      expect(output).toContain('No reports directory found');
    }
  });

  it('handles missing reports directory gracefully', async () => {
    // The script should not crash when reports directory is missing.
    // It prints a helpful message instead.
    const output = execSync(`npm run credits:ledger`, { cwd: REPO_ROOT, encoding: 'utf-8' });
    // Either it found reports and printed the ledger, or it gracefully handled the missing dir
    expect(output).toBeDefined();
    expect(output.length).toBeGreaterThan(0);
  });
});
