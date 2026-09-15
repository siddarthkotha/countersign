// Exercises sim:freeplay's planner (argument parsing, the deterministic run plan, output
// parsing, per-case summarization, the pass table) and its orchestration with an INJECTED fake
// executor -- zero network calls, zero spawned processes, per CLAUDE.md's "tests must not need
// the network" rule, same discipline scripts/rehearse/test/simFriday.test.ts already uses.
import { describe, expect, it } from 'vitest';
import {
  buildFreeplayPlan,
  FREEPLAY_JUDGE_CASES,
  parseFailReasonFromOutput,
  parseReportPathFromOutput,
  parseSimFreeplayArgs,
  renderDryRunPlan,
  renderFreeplayRollup,
  renderPassTable,
  runFreeplayPlan,
  runSimFreeplay,
  summarizeByCase,
} from '../simFreeplay.js';
import type { FreeplayCaseExecutor, FreeplayPlannedRun, FreeplayRunRow, SimFreeplayArgs } from '../simFreeplay.js';

describe('FREEPLAY_JUDGE_CASES', () => {
  it('includes eleven cases: the original ten plus case 11 corrected-critical-field (2026-09-14)', () => {
    expect(FREEPLAY_JUDGE_CASES).toHaveLength(11);
    expect(FREEPLAY_JUDGE_CASES).toContain('corrected-critical-field');
  });

  it('corrected-critical-field is the last case in the list', () => {
    expect(FREEPLAY_JUDGE_CASES[FREEPLAY_JUDGE_CASES.length - 1]).toBe('corrected-critical-field');
  });
});

describe('parseSimFreeplayArgs', () => {
  it('requires --url', () => {
    const result = parseSimFreeplayArgs(['--model', 'x', '--runs', '1']);
    expect(result.ok).toBe(false);
  });

  it('requires --model', () => {
    const result = parseSimFreeplayArgs(['--url', 'http://x', '--runs', '1']);
    expect(result.ok).toBe(false);
  });

  it('requires a positive --runs', () => {
    const result = parseSimFreeplayArgs(['--url', 'http://x', '--model', 'y', '--runs', '0']);
    expect(result.ok).toBe(false);
  });

  it('parses a full valid invocation, resolving an explicit seed', () => {
    const result = parseSimFreeplayArgs(['--url', 'http://x', '--model', 'openai/gpt-4o-mini', '--runs', '2', '--seed', '42']);
    expect(result).toEqual({
      ok: true,
      args: { url: 'http://x', model: 'openai/gpt-4o-mini', runsPerCase: 2, seed: 42, dryRun: false },
      seedWasExplicit: true,
    });
  });

  it('derives a seed from the injected clock when --seed is omitted', () => {
    const result = parseSimFreeplayArgs(['--url', 'http://x', '--model', 'y', '--runs', '1'], () => 12345);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.args.seed).toBe(12345);
      expect(result.seedWasExplicit).toBe(false);
    }
  });

  it('recognizes --dry-run', () => {
    const result = parseSimFreeplayArgs(['--url', 'http://x', '--model', 'y', '--runs', '1', '--dry-run']);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.args.dryRun).toBe(true);
  });

  it('rejects an unrecognized flag', () => {
    const result = parseSimFreeplayArgs(['--bogus']);
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/unrecognized/) });
  });
});

function args(overrides: Partial<SimFreeplayArgs> = {}): SimFreeplayArgs {
  return { url: 'http://localhost:8787', model: 'openai/gpt-4o-mini', runsPerCase: 1, seed: 42, dryRun: false, ...overrides };
}

describe('buildFreeplayPlan', () => {
  it('plans the fixed judge cases (11 total including case 11 corrected-critical-field), once each, for runsPerCase 1', () => {
    const plan = buildFreeplayPlan(args({ runsPerCase: 1 }));
    expect(plan).toHaveLength(FREEPLAY_JUDGE_CASES.length);
    expect(plan.map((p) => p.case)).toEqual([...FREEPLAY_JUDGE_CASES]);
  });

  it('plans runsPerCase entries per case, each with run_index 1..N', () => {
    const plan = buildFreeplayPlan(args({ runsPerCase: 3 }));
    expect(plan).toHaveLength(FREEPLAY_JUDGE_CASES.length * 3);
    const danaRuns = plan.filter((p) => p.case === 'dana-patient').map((p) => p.run_index);
    expect(danaRuns).toEqual([1, 2, 3]);
  });

  it('gives every planned run a distinct, deterministic seed derived from the base seed', () => {
    const planA = buildFreeplayPlan(args({ seed: 42, runsPerCase: 2 }));
    const planB = buildFreeplayPlan(args({ seed: 42, runsPerCase: 2 }));
    expect(planA.map((p) => p.seed)).toEqual(planB.map((p) => p.seed));
    const uniqueSeeds = new Set(planA.map((p) => p.seed));
    expect(uniqueSeeds.size).toBe(planA.length);
  });

  it('builds the exact run.ts argv, including --free-play and the per-run seed', () => {
    const plan = buildFreeplayPlan(args({ url: 'https://example.test', model: 'gemini/gemini-1.5-flash', runsPerCase: 1, seed: 7 }));
    const first = plan[0]!;
    expect(first.argv).toEqual([
      '--url',
      'https://example.test',
      '--scenario',
      first.case,
      '--free-play',
      '--model',
      'gemini/gemini-1.5-flash',
      '--seed',
      String(first.seed),
      '--max-calls',
      '1',
    ]);
  });
});

describe('renderDryRunPlan', () => {
  it('lists every planned run and never touches the network (pure string rendering)', () => {
    const a = args({ runsPerCase: 1 });
    const plan = buildFreeplayPlan(a);
    const text = renderDryRunPlan(a, plan);
    expect(text).toMatch(/DRY RUN/);
    for (const p of plan) {
      expect(text).toContain(p.case);
    }
  });
});

describe('parseFailReasonFromOutput / parseReportPathFromOutput', () => {
  it('extracts the reason= suffix from a one-line summary', () => {
    const stdout = '[FAIL] miller-silent-after-amount verdict=none (expected FREEZE) wall=12.3s exit=1 reason=close_line_not_spoken report=/x/y.md';
    expect(parseFailReasonFromOutput(stdout)).toBe('close_line_not_spoken');
  });

  it('returns null when no reason= is present', () => {
    expect(parseFailReasonFromOutput('[PASS] dana-patient verdict=STAGE (expected STAGE) wall=10.0s exit=0 report=/x/y.md')).toBeNull();
  });

  it('extracts the report= path', () => {
    const stdout = '[PASS] dana-patient verdict=STAGE (expected STAGE) wall=10.0s exit=0 report=/x/y.md';
    expect(parseReportPathFromOutput(stdout)).toBe('/x/y.md');
  });
});

describe('summarizeByCase', () => {
  it('aggregates runs, passes, unique fail reasons, and report paths per case', () => {
    const rows: FreeplayRunRow[] = [
      { case: 'dana-patient', run_index: 1, pass: true, fail_reason: null, report_path: '/r1.md', minutes_estimate: 1 },
      { case: 'dana-patient', run_index: 2, pass: false, fail_reason: 'unanswered_agent_question', report_path: '/r2.md', minutes_estimate: 1 },
      { case: 'miller-patient', run_index: 1, pass: false, fail_reason: 'unanswered_agent_question', report_path: '/r3.md', minutes_estimate: 1 },
    ];
    const summaries = summarizeByCase(rows);
    expect(summaries).toEqual([
      { case: 'dana-patient', runs: 2, passes: 1, fail_reasons: ['unanswered_agent_question'], report_paths: ['/r1.md', '/r2.md'] },
      { case: 'miller-patient', runs: 1, passes: 0, fail_reasons: ['unanswered_agent_question'], report_paths: ['/r3.md'] },
    ]);
  });

  it('preserves first-seen case order', () => {
    const rows: FreeplayRunRow[] = [
      { case: 'b', run_index: 1, pass: true, fail_reason: null, report_path: null, minutes_estimate: null },
      { case: 'a', run_index: 1, pass: true, fail_reason: null, report_path: null, minutes_estimate: null },
    ];
    expect(summarizeByCase(rows).map((s) => s.case)).toEqual(['b', 'a']);
  });
});

describe('renderPassTable', () => {
  it('renders a markdown table with one row per case', () => {
    const table = renderPassTable([{ case: 'dana-patient', runs: 3, passes: 2, fail_reasons: ['agent_silence_exceeded'], report_paths: ['/x.md'] }]);
    expect(table).toContain('dana-patient');
    expect(table).toContain('| 3 | 2 |');
    expect(table).toContain('agent_silence_exceeded');
  });

  it('shows "_none_" for a case with no fail reasons or reports', () => {
    const table = renderPassTable([{ case: 'dana-patient', runs: 1, passes: 1, fail_reasons: [], report_paths: [] }]);
    expect(table).toContain('_none_');
  });
});

describe('renderFreeplayRollup', () => {
  it('is a pure string renderer that never throws on an empty row set', () => {
    const text = renderFreeplayRollup(args(), [], [], '2026-09-14T00:00:00.000Z', '2026-09-14T00:05:00.000Z');
    expect(text).toMatch(/Free-play judge-case roll-up/);
  });
});

describe('runFreeplayPlan', () => {
  function fakeExecutor(byCase: Record<string, { stdout: string; exit_code: number }>): FreeplayCaseExecutor {
    return async (planned: FreeplayPlannedRun) => byCase[planned.case] ?? { stdout: '', exit_code: 2 };
  }

  it('runs every planned entry sequentially and parses pass/fail from stdout', async () => {
    const plan = buildFreeplayPlan(args({ runsPerCase: 1 }));
    const executor = fakeExecutor(
      Object.fromEntries(
        plan.map((p) => [p.case, { stdout: `[PASS] ${p.case} verdict=STAGE (expected STAGE) wall=1.0s exit=0 report=/${p.case}.md`, exit_code: 0 }]),
      ),
    );
    const order: string[] = [];
    const rows = await runFreeplayPlan(plan, executor, (line) => order.push(line));
    expect(rows).toHaveLength(plan.length);
    expect(rows.every((r) => r.pass === true)).toBe(true);
    expect(order.length).toBe(plan.length); // one log line per run -- proves sequential execution, not parallel silence.
  });

  it('captures a fail reason when a run fails', async () => {
    const plan = buildFreeplayPlan(args({ runsPerCase: 1 }));
    const failingCase = plan[0]!.case;
    const executor: FreeplayCaseExecutor = async (planned) =>
      planned.case === failingCase
        ? { stdout: `[FAIL] ${failingCase} verdict=none (expected STAGE) wall=1.0s exit=1 reason=agent_silence_exceeded report=/x.md`, exit_code: 1 }
        : { stdout: `[PASS] ${planned.case} verdict=STAGE (expected STAGE) wall=1.0s exit=0 report=/y.md`, exit_code: 0 };
    const rows = await runFreeplayPlan(plan, executor);
    const failingRow = rows.find((r) => r.case === failingCase)!;
    expect(failingRow.pass).toBe(false);
    expect(failingRow.fail_reason).toBe('agent_silence_exceeded');
  });
});

describe('runSimFreeplay', () => {
  it('dry-run never calls the executor', async () => {
    let called = false;
    const result = await runSimFreeplay(args({ dryRun: true }), { runCase: async () => { called = true; return { stdout: '', exit_code: 0 }; }, log: () => {} });
    expect(called).toBe(false);
    expect(result.exit_code).toBe(0);
    expect(result.rows).toEqual([]);
  });

  it('a real run aggregates per-case summaries and exits non-zero if anything failed', async () => {
    const executor: FreeplayCaseExecutor = async (planned) =>
      planned.case === 'judge-out-of-scope'
        ? { stdout: `[FAIL] judge-out-of-scope verdict=none (expected NO_ACTION) wall=1.0s exit=1 reason=unanswered_agent_question report=/f.md`, exit_code: 1 }
        : { stdout: `[PASS] ${planned.case} verdict=STAGE (expected STAGE) wall=1.0s exit=0 report=/p.md`, exit_code: 0 };
    const result = await runSimFreeplay(args({ runsPerCase: 1 }), { runCase: executor, log: () => {} });
    expect(result.exit_code).toBe(1);
    expect(result.summaries.find((s) => s.case === 'judge-out-of-scope')!.passes).toBe(0);
  });

  it('exits 0 when every case passes every run', async () => {
    const executor: FreeplayCaseExecutor = async (planned) => ({
      stdout: `[PASS] ${planned.case} verdict=STAGE (expected STAGE) wall=1.0s exit=0 report=/p.md`,
      exit_code: 0,
    });
    const result = await runSimFreeplay(args({ runsPerCase: 1 }), { runCase: executor, log: () => {} });
    expect(result.exit_code).toBe(0);
  });
});
