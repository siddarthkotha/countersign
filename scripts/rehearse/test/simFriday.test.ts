import { mkdtemp, mkdir, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_MINUTES,
  DEFAULT_RUNS_PER_SCENARIO,
  DEFAULT_URL,
  JUDGE_SIM_SCENARIOS,
  buildBatchArgv,
  buildBatchTotalRuns,
  listRunReports,
  parseReportFile,
  parseSimArgs,
  renderDryRunPlan,
  renderReportListing,
  runSimFriday,
  type ReportListing,
  type SimFridayArgs,
  type SimFridayDeps,
} from '../simFriday.js';

// ---------- parseSimArgs ----------

describe('parseSimArgs', () => {
  it('applies every default with no flags at all', () => {
    const parsed = parseSimArgs([]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.args).toEqual<SimFridayArgs>({
        url: DEFAULT_URL,
        runsPerScenario: DEFAULT_RUNS_PER_SCENARIO,
        maxMinutes: DEFAULT_MAX_MINUTES,
        dryRun: false,
      });
    }
  });

  it('parses --url, --runs, --max-minutes, and --dry-run together', () => {
    const parsed = parseSimArgs(['--url', 'http://localhost:8787', '--runs', '3', '--max-minutes', '45', '--dry-run']);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.args).toEqual<SimFridayArgs>({
        url: 'http://localhost:8787',
        runsPerScenario: 3,
        maxMinutes: 45,
        dryRun: true,
      });
    }
  });

  it('defaults --dry-run to false when omitted', () => {
    const parsed = parseSimArgs(['--url', 'http://localhost:8787']);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.args.dryRun).toBe(false);
  });

  it('refuses a non-positive --runs', () => {
    const parsed = parseSimArgs(['--runs', '0']);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('--runs');
  });

  it('refuses a non-numeric --max-minutes', () => {
    const parsed = parseSimArgs(['--max-minutes', 'soon']);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('--max-minutes');
  });

  it('refuses --url with no value', () => {
    const parsed = parseSimArgs(['--url']);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('--url');
  });

  it('refuses an unrecognized flag', () => {
    const parsed = parseSimArgs(['--bogus']);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('bogus');
  });

  it('recognizes --help', () => {
    const parsed = parseSimArgs(['--help']);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toBe('help');
  });
});

// ---------- batch invocation shape ----------

describe('JUDGE_SIM_SCENARIOS', () => {
  it('is exactly the five scenarios named in ~/.claude/agents/judge-sim.md walk order step 4', () => {
    expect(JUDGE_SIM_SCENARIOS).toEqual(['scenario-a-dana-legitimate', 'scenario-b-miller-fraud', 'judge-out-of-scope', 'barge-in-interrupt', 'identity-switch']);
  });
});

describe('buildBatchTotalRuns', () => {
  it('multiplies runs-per-scenario by the fixed scenario count', () => {
    expect(buildBatchTotalRuns({ runsPerScenario: 1 })).toBe(5);
    expect(buildBatchTotalRuns({ runsPerScenario: 3 })).toBe(15);
  });
});

describe('buildBatchArgv', () => {
  it('builds the exact flag list rehearse:batch expects, scenarios joined in fixed order', () => {
    const args: SimFridayArgs = { url: 'https://example.test', runsPerScenario: 2, maxMinutes: 20, dryRun: false };
    expect(buildBatchArgv(args)).toEqual([
      '--url',
      'https://example.test',
      '--runs',
      '10',
      '--scenarios',
      'scenario-a-dana-legitimate,scenario-b-miller-fraud,judge-out-of-scope,barge-in-interrupt,identity-switch',
      '--max-minutes',
      '20',
    ]);
  });
});

// ---------- dry-run plan ----------

describe('renderDryRunPlan', () => {
  const args: SimFridayArgs = { url: 'https://countersign-bf8q.onrender.com', runsPerScenario: 1, maxMinutes: 15, dryRun: true };
  const plan = renderDryRunPlan(args);

  it('names itself a dry run that touches nothing', () => {
    expect(plan).toContain('DRY RUN');
    expect(plan).toContain('No network call, no spawned process, no credits spent.');
  });

  it('states the target URL and every scenario', () => {
    expect(plan).toContain('https://countersign-bf8q.onrender.com');
    for (const s of JUDGE_SIM_SCENARIOS) expect(plan).toContain(s);
  });

  it('states the batch total runs and max-minutes cap', () => {
    expect(plan).toContain('Runs per scenario: 1 (batch total --runs: 5)');
    expect(plan).toContain('Max minutes cap: 15');
  });

  it('shows the exact batch command it would spawn', () => {
    expect(plan).toContain('npx tsx scripts/rehearse/rehearseBatch.ts');
    expect(plan).toContain('--runs 5');
  });

  it('names the latency and report-listing steps', () => {
    expect(plan).toContain('docs/LATENCY.md');
    expect(plan).toContain('scripts/rehearse/reports/');
  });
});

// ---------- parseReportFile ----------

describe('parseReportFile', () => {
  it('reads the scenario and actual-verdict lines report.ts writes', () => {
    const md = ['# Rehearsal report: Dana, legitimate wire', '', 'Scenario: `scenario-a-dana-legitimate` (source: file)', 'Target: https://example.test', '', '## Result: PASS', '', '- Expected verdict: STAGE', '- Actual verdict: STAGE'].join('\n');
    expect(parseReportFile(md, '2026-09-18T09-00-00-scenario-a-dana-legitimate.md')).toEqual({ scenario: 'scenario-a-dana-legitimate', verdict: 'STAGE' });
  });

  it('falls back to the ## Result line when no Actual verdict line is present', () => {
    const md = ['Scenario: `barge-in-interrupt` (source: file)', '## Result: FAIL'].join('\n');
    expect(parseReportFile(md, 'x.md')).toEqual({ scenario: 'barge-in-interrupt', verdict: 'FAIL' });
  });

  it('falls back to the scenario name embedded in the filename when no Scenario line is present', () => {
    const md = '## Result: PASS\n- Actual verdict: FREEZE';
    expect(parseReportFile(md, '2026-09-18T09-05-00-identity-switch.md')).toEqual({ scenario: 'identity-switch', verdict: 'FREEZE' });
  });

  it('reports UNKNOWN verdict and unknown-scenario when nothing parses at all', () => {
    expect(parseReportFile('not a report', 'not-a-timestamped-name.md')).toEqual({ scenario: 'unknown-scenario', verdict: 'UNKNOWN (no verdict line parsed)' });
  });
});

// ---------- listRunReports (local filesystem only, no network) ----------

describe('listRunReports', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sim-friday-reports-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns an empty list when the directory does not exist', async () => {
    const result = await listRunReports(join(dir, 'does-not-exist'), 0);
    expect(result).toEqual([]);
  });

  it('lists only .md reports at or after sinceMs, excluding roll-ups and non-.md files', async () => {
    const old = join(dir, '2026-09-01T00-00-00-scenario-a-dana-legitimate.md');
    const fresh = join(dir, '2026-09-18T09-00-00-scenario-b-miller-fraud.md');
    const rollup = join(dir, '2026-09-18T09-10-00-batch-rollup.md');
    const bundle = join(dir, '2026-09-18T09-00-00-scenario-b-miller-fraud.diagnostics.json');

    await writeFile(old, 'Scenario: `scenario-a-dana-legitimate` (source: file)\n## Result: PASS\n- Actual verdict: STAGE', 'utf-8');
    await writeFile(fresh, 'Scenario: `scenario-b-miller-fraud` (source: file)\n## Result: PASS\n- Actual verdict: FREEZE', 'utf-8');
    await writeFile(rollup, '# Batch rehearsal roll-up', 'utf-8');
    await writeFile(bundle, '{}', 'utf-8');

    const oldTime = new Date('2026-09-01T00:00:00.000Z');
    const freshTime = new Date('2026-09-18T09:00:00.000Z');
    await utimes(old, oldTime, oldTime);
    await utimes(fresh, freshTime, freshTime);
    await utimes(rollup, freshTime, freshTime);

    const since = new Date('2026-09-10T00:00:00.000Z').getTime();
    const result = await listRunReports(dir, since);

    expect(result).toEqual<ReportListing[]>([{ file: '2026-09-18T09-00-00-scenario-b-miller-fraud.md', scenario: 'scenario-b-miller-fraud', verdict: 'FREEZE' }]);
  });

  it('includes a report with mtime exactly equal to sinceMs (>=, not >)', async () => {
    const file = join(dir, '2026-09-18T09-00-00-judge-out-of-scope.md');
    await writeFile(file, 'Scenario: `judge-out-of-scope` (source: file)\n## Result: PASS\n- Actual verdict: NO_ACTION', 'utf-8');
    const exact = new Date('2026-09-18T09:00:00.000Z');
    await utimes(file, exact, exact);

    const result = await listRunReports(dir, exact.getTime());
    expect(result).toHaveLength(1);
  });
});

describe('renderReportListing', () => {
  it('reports plainly when there are no reports', () => {
    expect(renderReportListing([])).toContain('no report files found');
  });

  it('lists each report with its scenario and verdict', () => {
    const reports: ReportListing[] = [
      { file: 'a.md', scenario: 'scenario-a-dana-legitimate', verdict: 'STAGE' },
      { file: 'b.md', scenario: 'scenario-b-miller-fraud', verdict: 'FREEZE' },
    ];
    const out = renderReportListing(reports);
    expect(out).toContain('a.md -- scenario: scenario-a-dana-legitimate, verdict: STAGE');
    expect(out).toContain('b.md -- scenario: scenario-b-miller-fraud, verdict: FREEZE');
  });
});

// ---------- runSimFriday orchestration (fakes only, no network, no spawned process) ----------

describe('runSimFriday', () => {
  function makeDeps(overrides: Partial<SimFridayDeps> = {}): { deps: SimFridayDeps; log: string[] } {
    const log: string[] = [];
    const deps: SimFridayDeps = {
      runBatchProcess: async () => ({ exit_code: 0 }),
      regenerateLatency: async () => ({ outputPath: 'docs/LATENCY.md' }),
      listReports: async () => [],
      log: (line) => log.push(line),
      ...overrides,
    };
    return { deps, log };
  }

  it('a dry run touches none of the injected deps and exits 0', async () => {
    const args: SimFridayArgs = { url: DEFAULT_URL, runsPerScenario: 1, maxMinutes: 15, dryRun: true };
    let batchCalled = false;
    let latencyCalled = false;
    let listCalled = false;
    const { deps, log } = makeDeps({
      runBatchProcess: async () => {
        batchCalled = true;
        return { exit_code: 0 };
      },
      regenerateLatency: async () => {
        latencyCalled = true;
        return { outputPath: 'docs/LATENCY.md' };
      },
      listReports: async () => {
        listCalled = true;
        return [];
      },
    });

    const result = await runSimFriday(args, deps);

    expect(batchCalled).toBe(false);
    expect(latencyCalled).toBe(false);
    expect(listCalled).toBe(false);
    expect(result).toEqual({ exit_code: 0, reports: [] });
    expect(log.join('\n')).toContain('DRY RUN');
  });

  it('runs all three steps in order for a real (non-dry-run) invocation', async () => {
    const args: SimFridayArgs = { url: DEFAULT_URL, runsPerScenario: 1, maxMinutes: 15, dryRun: false };
    const calls: string[] = [];
    const fakeReports: ReportListing[] = [{ file: 'x.md', scenario: 'scenario-a-dana-legitimate', verdict: 'STAGE' }];
    const { deps, log } = makeDeps({
      runBatchProcess: async (argv) => {
        calls.push('batch');
        expect(argv).toContain('--url');
        return { exit_code: 0 };
      },
      regenerateLatency: async () => {
        calls.push('latency');
        return { outputPath: 'docs/LATENCY.md' };
      },
      listReports: async (_dir, sinceMs) => {
        calls.push('list');
        expect(sinceMs).toBe(1234);
        return fakeReports;
      },
    });

    const result = await runSimFriday(args, deps, 1234);

    expect(calls).toEqual(['batch', 'latency', 'list']);
    expect(result).toEqual({ exit_code: 0, reports: fakeReports });
    expect(log.some((l) => l.includes('scenario-a-dana-legitimate'))).toBe(true);
  });

  it('passes the batch process exit code through as its own result', async () => {
    const args: SimFridayArgs = { url: DEFAULT_URL, runsPerScenario: 1, maxMinutes: 15, dryRun: false };
    const { deps } = makeDeps({ runBatchProcess: async () => ({ exit_code: 1 }) });

    const result = await runSimFriday(args, deps, 0);
    expect(result.exit_code).toBe(1);
  });

  it('still regenerates latency and lists reports even when the batch exits non-zero', async () => {
    const args: SimFridayArgs = { url: DEFAULT_URL, runsPerScenario: 1, maxMinutes: 15, dryRun: false };
    let latencyCalled = false;
    let listCalled = false;
    const { deps } = makeDeps({
      runBatchProcess: async () => ({ exit_code: 1 }),
      regenerateLatency: async () => {
        latencyCalled = true;
        return { outputPath: 'docs/LATENCY.md' };
      },
      listReports: async () => {
        listCalled = true;
        return [];
      },
    });

    await runSimFriday(args, deps, 0);
    expect(latencyCalled).toBe(true);
    expect(listCalled).toBe(true);
  });
});
