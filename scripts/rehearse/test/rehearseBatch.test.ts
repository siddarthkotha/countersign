import { describe, expect, it } from 'vitest';
import {
  buildRoundRobinSchedule,
  nextStopDecision,
  parseBatchArgs,
  parseRunOutput,
  renderBatchRollup,
  runBatch,
  type BatchArgs,
  type RunExecResult,
} from '../rehearseBatch.js';

describe('parseBatchArgs', () => {
  const full = ['--url', 'https://countersign-bf8q.onrender.com', '--runs', '30', '--scenarios', 'a,b,c', '--max-minutes', '60'];

  it('parses a full, valid argument set', () => {
    const parsed = parseBatchArgs(full);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.args).toEqual<BatchArgs>({
        url: 'https://countersign-bf8q.onrender.com',
        runs: 30,
        scenarios: ['a', 'b', 'c'],
        maxMinutes: 60,
      });
    }
  });

  it('trims whitespace and drops empty entries from --scenarios', () => {
    const parsed = parseBatchArgs(['--url', 'http://localhost:8787', '--runs', '3', '--scenarios', ' a , b ,,c ', '--max-minutes', '10']);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.args.scenarios).toEqual(['a', 'b', 'c']);
  });

  it('refuses to run without --url (the required guard)', () => {
    const parsed = parseBatchArgs(['--runs', '30', '--scenarios', 'a,b,c', '--max-minutes', '60']);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('--url');
  });

  it('refuses a non-positive --runs', () => {
    const parsed = parseBatchArgs(['--url', 'http://localhost:8787', '--runs', '0', '--scenarios', 'a', '--max-minutes', '10']);
    expect(parsed.ok).toBe(false);
  });

  it('refuses an empty --scenarios list', () => {
    const parsed = parseBatchArgs(['--url', 'http://localhost:8787', '--runs', '3', '--scenarios', '', '--max-minutes', '10']);
    expect(parsed.ok).toBe(false);
  });

  it('refuses a missing/non-positive --max-minutes', () => {
    const parsed = parseBatchArgs(['--url', 'http://localhost:8787', '--runs', '3', '--scenarios', 'a']);
    expect(parsed.ok).toBe(false);
  });

  it('refuses an unrecognized flag', () => {
    const parsed = parseBatchArgs([...full, '--bogus']);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('bogus');
  });

  it('recognizes --help', () => {
    const parsed = parseBatchArgs(['--help']);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toBe('help');
  });
});

describe('buildRoundRobinSchedule', () => {
  it('cycles through scenarios in order up to the run count', () => {
    expect(buildRoundRobinSchedule(['a', 'b', 'c'], 7)).toEqual(['a', 'b', 'c', 'a', 'b', 'c', 'a']);
  });

  it('handles runs fewer than the scenario count', () => {
    expect(buildRoundRobinSchedule(['a', 'b', 'c'], 2)).toEqual(['a', 'b']);
  });

  it('handles a single scenario', () => {
    expect(buildRoundRobinSchedule(['only'], 4)).toEqual(['only', 'only', 'only', 'only']);
  });

  it('returns an empty schedule for zero runs or zero scenarios', () => {
    expect(buildRoundRobinSchedule(['a'], 0)).toEqual([]);
    expect(buildRoundRobinSchedule([], 5)).toEqual([]);
  });
});

describe('nextStopDecision', () => {
  it('does not stop when under both caps', () => {
    expect(nextStopDecision({ completedRuns: 2, totalMinutes: 5 }, { maxRuns: 10, maxMinutes: 60 })).toEqual({ stop: false, reason: null });
  });

  it('stops on the run cap', () => {
    expect(nextStopDecision({ completedRuns: 10, totalMinutes: 5 }, { maxRuns: 10, maxMinutes: 60 })).toEqual({ stop: true, reason: 'run_cap' });
  });

  it('stops on the minute cap even under the run cap', () => {
    expect(nextStopDecision({ completedRuns: 2, totalMinutes: 60 }, { maxRuns: 10, maxMinutes: 60 })).toEqual({ stop: true, reason: 'minute_cap' });
  });

  it('minute cap is checked as >=, not >, so an exact hit stops', () => {
    expect(nextStopDecision({ completedRuns: 0, totalMinutes: 60 }, { maxRuns: 10, maxMinutes: 60 }).stop).toBe(true);
  });
});

describe('parseRunOutput', () => {
  it('parses a PASS summary line and the total-minutes line', () => {
    const stdout = [
      '[PASS] scenario-a-dana-legitimate verdict=STAGE (expected STAGE) wall=41.2s exit=0 report=scripts/rehearse/reports/x.md',
      '  raw diagnostics bundle: scripts/rehearse/reports/x.diagnostics.json',
      'rehearse: 1 run(s) complete. ESTIMATE: ~1.66 total minutes streamed to AssemblyAI (method: wall-clock call duration; not read from AssemblyAI billing).',
    ].join('\n');
    const parsed = parseRunOutput(stdout);
    expect(parsed.pass).toBe(true);
    expect(parsed.minutes_estimate).toBeCloseTo(1.66);
    expect(parsed.daily_cap_hit).toBe(false);
  });

  it('parses a FAIL summary line', () => {
    const stdout = '[FAIL] scenario-b-miller-fraud verdict=none (expected FREEZE) wall=12.0s exit=1 report=x.md\nrehearse: 1 run(s) complete. ESTIMATE: ~0.20 total minutes streamed to AssemblyAI.';
    const parsed = parseRunOutput(stdout);
    expect(parsed.pass).toBe(false);
    expect(parsed.minutes_estimate).toBeCloseTo(0.2);
  });

  it('detects a daily_cap refusal embedded in a mintSession warning line', () => {
    const stdout = '  warning: could not mint a session: mintSession: server refused a fresh session (HTTP 429): {"replay_only":true,"reason":"daily_cap"}';
    const parsed = parseRunOutput(stdout);
    expect(parsed.daily_cap_hit).toBe(true);
    expect(parsed.pass).toBeNull();
  });

  it('returns null pass and null minutes for output with neither line (a crash)', () => {
    const parsed = parseRunOutput('Error: ECONNREFUSED\n');
    expect(parsed.pass).toBeNull();
    expect(parsed.minutes_estimate).toBeNull();
    expect(parsed.daily_cap_hit).toBe(false);
  });
});

describe('runBatch (scheduling + cap logic, no network -- executor is a fake)', () => {
  const args: BatchArgs = { url: 'https://example.test', runs: 6, scenarios: ['a', 'b'], maxMinutes: 100 };

  function fakeExecutor(perCallMinutes: number, pass = true): (scenario: string, url: string) => Promise<RunExecResult> {
    return async (scenario) => ({
      stdout: `[${pass ? 'PASS' : 'FAIL'}] ${scenario} verdict=STAGE (expected STAGE) wall=1.0s exit=${pass ? 0 : 1} report=x.md\nrehearse: 1 run(s) complete. ESTIMATE: ~${perCallMinutes} total minutes streamed to AssemblyAI.`,
      exit_code: pass ? 0 : 1,
    });
  }

  it('runs the full round-robin schedule when under every cap', async () => {
    const result = await runBatch(args, fakeExecutor(1));
    expect(result.runs_executed).toBe(6);
    expect(result.rows.map((r) => r.scenario)).toEqual(['a', 'b', 'a', 'b', 'a', 'b']);
    expect(result.stop_reason).toBe('completed');
    expect(result.total_minutes).toBeCloseTo(6);
  });

  it('stops early once the summed minutes reach --max-minutes', async () => {
    const tightArgs: BatchArgs = { ...args, runs: 10, maxMinutes: 3.5 };
    const result = await runBatch(tightArgs, fakeExecutor(1));
    // 3 runs = 3 minutes (< 3.5, allowed to start a 4th); the 4th brings it to 4 (>= 3.5, stop before a 5th)
    expect(result.runs_executed).toBe(4);
    expect(result.stop_reason).toBe('minute_cap');
    expect(result.total_minutes).toBeCloseTo(4);
  });

  it('stops immediately on a daily_cap refusal and does not run further scheduled calls', async () => {
    let calls = 0;
    const executor = async (scenario: string): Promise<RunExecResult> => {
      calls += 1;
      if (calls === 3) {
        return { stdout: 'warning: could not mint a session: ...{"replay_only":true,"reason":"daily_cap"}', exit_code: 2 };
      }
      return { stdout: `[PASS] ${scenario} verdict=STAGE (expected STAGE) wall=1.0s exit=0 report=x.md\nrehearse: 1 run(s) complete. ESTIMATE: ~1 total minutes streamed to AssemblyAI.`, exit_code: 0 };
    };
    const result = await runBatch(args, executor);
    expect(calls).toBe(3);
    expect(result.runs_executed).toBe(2); // the two PASS runs before the daily_cap hit; the 3rd call is never added as a row
    expect(result.stop_reason).toBe('daily_cap');
  });

  it('records a FAIL row but keeps going for an ordinary failed run (not a daily_cap refusal)', async () => {
    const result = await runBatch({ ...args, runs: 3 }, fakeExecutor(1, false));
    expect(result.runs_executed).toBe(3);
    expect(result.rows.every((r) => r.pass === false)).toBe(true);
    expect(result.stop_reason).toBe('completed');
  });

  it('preserves round-robin order across the executor calls, not just the row list', async () => {
    const seen: string[] = [];
    const executor = async (scenario: string): Promise<RunExecResult> => {
      seen.push(scenario);
      return { stdout: `[PASS] ${scenario} verdict=STAGE (expected STAGE) wall=1.0s exit=0 report=x.md\nrehearse: 1 run(s) complete. ESTIMATE: ~0.5 total minutes streamed to AssemblyAI.`, exit_code: 0 };
    };
    await runBatch({ url: 'https://example.test', runs: 5, scenarios: ['x', 'y', 'z'], maxMinutes: 100 }, executor);
    expect(seen).toEqual(['x', 'y', 'z', 'x', 'y']);
  });
});

describe('renderBatchRollup', () => {
  it('renders a markdown table with one row per run and a credits estimate', () => {
    const args: BatchArgs = { url: 'https://countersign-bf8q.onrender.com', runs: 2, scenarios: ['a', 'b'], maxMinutes: 60 };
    const md = renderBatchRollup(
      args,
      {
        rows: [
          { run_index: 1, scenario: 'a', pass: true, minutes_estimate: 1.5 },
          { run_index: 2, scenario: 'b', pass: false, minutes_estimate: 2.25 },
        ],
        total_minutes: 3.75,
        runs_executed: 2,
        runs_scheduled: 2,
        stop_reason: 'completed',
      },
      '2026-09-11T00:00:00.000Z',
      '2026-09-11T00:10:00.000Z',
    );
    expect(md).toContain('| 1 | a | PASS | 1.50 |');
    expect(md).toContain('| 2 | b | FAIL | 2.25 |');
    expect(md).toContain('~3.75 total minutes');
    expect(md).toContain('Stop reason: completed');
  });
});
