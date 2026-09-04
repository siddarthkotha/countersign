import { describe, expect, it } from 'vitest';
import { oneLineSummary, renderReport, renderRollup, reportFileName, rollupFileName, timestampForFilename } from '../report.js';
import type { RollupResult, RunResult, Scenario } from '../types.js';

const scenario: Scenario = {
  name: 'test-scenario',
  title: 'Test Scenario',
  description: 'a scenario for report rendering tests',
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
    timings: {
      ready_ms: 250,
      first_audio_ms: 300,
      turn_gaps: [{ turn_id: 'c1', caller_end_ms: 1000, first_reply_audio_ms: 1500, gap_ms: 500 }],
      total_wall_ms: 42000,
    },
    transcript: [
      { speaker: 'caller', text: 'hello', t_ms: 900 },
      { speaker: 'agent', text: 'confirming', t_ms: 1500 },
    ],
    state_history: [{ t_ms: 250, state: 'INTAKE', verdict: 'PENDING', agent_status: 'LISTENING' }],
    diagnostics: { ok: true, event_kind_counts: { evaluate: 3 }, tool_events: [], evaluate_events: [], deployed_commit: null, ended_at_ms: 42000, end_reason: 'caller_ended' },
    warnings: [],
    exit_code: 0,
    minutes_estimate: 0.7,
    resolved_lines: [],
    caller_mode: 'reactive',
    ...overrides,
  };
}

describe('report rendering', () => {
  it('renders a PASS report with the expected top-level facts', () => {
    const md = renderReport(baseResult());
    expect(md).toContain('# Rehearsal report: Test Scenario');
    expect(md).toContain('## Result: PASS');
    expect(md).toContain('Expected verdict: STAGE');
    expect(md).toContain('Actual verdict: STAGE');
    expect(md).toContain('hello');
    expect(md).toContain('confirming');
    expect(md).not.toMatch(/—/); // no em-dashes (CLAUDE.md style rule)
  });

  it('renders a FAIL report with warnings surfaced', () => {
    const md = renderReport(
      baseResult({ pass: false, actual_verdict: 'ESCALATE', exit_code: 1, warnings: ['no terminal verdict within max_wall_ms'] }),
    );
    expect(md).toContain('## Result: FAIL');
    expect(md).toContain('## Warnings');
    expect(md).toContain('no terminal verdict within max_wall_ms');
  });

  it('shows the caller mode and, for a reactive/llm run, how each line was decided', () => {
    const md = renderReport(
      baseResult({
        caller_mode: 'reactive',
        resolved_lines: [
          { turn_id: 'c2', text: "No, that's wrong, it's Meridian Supply.", source: 'generic', reacted_to: 'Confirming Northgate Partners, is that right?' },
        ],
      }),
    );
    expect(md).toContain('Caller mode: reactive');
    expect(md).toContain('## Caller line decisions');
    expect(md).toContain('generic');
    expect(md).toContain("No, that's wrong, it's Meridian Supply.");
    expect(md).toContain('Northgate Partners');
  });

  it('renders diagnostics-unavailable gracefully', () => {
    const md = renderReport(baseResult({ diagnostics: { ok: false, error: 'not_found' } }));
    expect(md).toContain('Diagnostics unavailable: not_found');
  });

  it('one-line summary includes pass/fail, verdicts, and the report path', () => {
    const line = oneLineSummary(baseResult(), '/tmp/report.md');
    expect(line).toContain('[PASS]');
    expect(line).toContain('verdict=STAGE');
    expect(line).toContain('expected STAGE');
    expect(line).toContain('/tmp/report.md');
  });

  it('one-line summary flags FAIL for a mismatched verdict', () => {
    const line = oneLineSummary(baseResult({ pass: false, actual_verdict: 'FREEZE', exit_code: 1 }), '/tmp/report.md');
    expect(line).toContain('[FAIL]');
    expect(line).toContain('verdict=FREEZE');
  });
});

describe('report file naming', () => {
  it('timestampForFilename never contains a colon', () => {
    const ts = timestampForFilename(new Date('2026-09-03T22:41:05'));
    expect(ts).not.toContain(':');
    expect(ts).toBe('2026-09-03T22-41-05');
  });

  it('reportFileName combines the timestamp and scenario name with a .md extension', () => {
    const name = reportFileName('scenario-a-dana-legitimate', new Date('2026-09-03T22:41:05'));
    expect(name).toBe('2026-09-03T22-41-05-scenario-a-dana-legitimate.md');
  });

  it('rollupFileName ends in "-rollup.md"', () => {
    const name = rollupFileName(new Date('2026-09-03T22:41:05'));
    expect(name).toBe('2026-09-03T22-41-05-rollup.md');
  });
});

describe('roll-up rendering', () => {
  function rollup(overrides: Partial<RollupResult> = {}): RollupResult {
    return {
      rows: [
        {
          scenario_name: 'scenario-b-miller-fraud',
          run_index: 1,
          pass: true,
          expected_verdict: 'FREEZE',
          actual_verdict: 'FREEZE',
          total_wall_ms: 41000,
          minutes_estimate: 0.68,
          report_path: '/reports/run1.md',
        },
        {
          scenario_name: 'scenario-b-miller-fraud',
          run_index: 2,
          pass: true,
          expected_verdict: 'FREEZE',
          actual_verdict: 'FREEZE',
          total_wall_ms: 39000,
          minutes_estimate: 0.65,
          report_path: '/reports/run2.md',
        },
      ],
      total_minutes_estimate: 1.33,
      started_at_iso: '2026-09-03T00:00:00.000Z',
      ended_at_iso: '2026-09-03T00:02:00.000Z',
      ...overrides,
    };
  }

  it('renders a pass/fail matrix covering every run', () => {
    const md = renderRollup(rollup());
    expect(md).toContain('# Rehearsal roll-up');
    expect(md).toContain('scenario-b-miller-fraud');
    expect(md).toContain('PASS');
    expect(md).toContain('Total runs: 2');
  });

  it('the G2 check (Scenario B twice in a row, both PASS) is readable straight off the matrix', () => {
    const md = renderRollup(rollup());
    const passLines = md.split('\n').filter((l) => l.includes('scenario-b-miller-fraud') && l.includes('PASS'));
    expect(passLines).toHaveLength(2);
  });

  it('lists a wrong-verdict run with expected vs actual', () => {
    const r = rollup();
    r.rows[1] = { ...r.rows[1]!, pass: false, actual_verdict: 'ESCALATE' };
    const md = renderRollup(r);
    expect(md).toContain('## Wrong-verdict / failed runs');
    expect(md).toContain('expected FREEZE, got ESCALATE');
  });

  it('says "None" when every run passed', () => {
    const md = renderRollup(rollup());
    expect(md).toContain('None -- every run reached its expected verdict.');
  });

  it('computes a per-scenario median wall time', () => {
    const md = renderRollup(rollup());
    expect(md).toContain('## Timing medians');
    expect(md).toMatch(/scenario-b-miller-fraud \| 2 \| 40\.0s/);
  });

  it('reports a credits ESTIMATE label, never a claimed exact figure', () => {
    const md = renderRollup(rollup());
    expect(md).toContain('ESTIMATE');
    expect(md).toContain('1.33 total minutes');
  });
});
