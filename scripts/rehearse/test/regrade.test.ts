// scripts/rehearse/test/regrade.test.ts
// Exercises regrade.ts's markdown parser (round-tripped through report.ts's own renderReport,
// so the parser is proven against the exact format it will actually see on disk) and the
// `regrade()` function that re-applies the close-line check to an already-completed run's
// persisted report. No files, no network -- renderReport/parseReportMarkdown are both pure.
import { describe, expect, it } from 'vitest';
import { renderReport } from '../report.js';
import { parseReportMarkdown, parseTranscriptTable, regrade } from '../regrade.js';
import type { RunResult, Scenario } from '../types.js';

const scenario: Scenario = {
  name: 'test-scenario',
  title: 'Test Scenario',
  description: 'a scenario for regrade tests',
  source: 'inline test fixture',
  turns: [{ id: 'c1', text: 'hello' }],
  expected: { verdict: 'FREEZE', max_wall_ms: 60000 },
};

function baseResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    scenario,
    target_url: 'http://localhost:8787',
    session_id: 'sess-1',
    started_at_iso: '2026-09-13T00:00:00.000Z',
    ended_reason: 'agent_closed',
    verdict_reached: true,
    actual_verdict: 'FREEZE',
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
      end_reason: 'agent_closed',
      session_minted_event: null,
      call_context_event: null,
      greeting_configured: true,
    },
    raw_diagnostics: null,
    warnings: [],
    exit_code: 0,
    minutes_estimate: 0.7,
    resolved_lines: [],
    caller_mode: 'reactive',
    close_line_status: 'spoken',
    ...overrides,
  };
}

const FREEZE_SENTENCE = 'This transfer is frozen and an incident has been opened for review. Nothing has moved. Goodbye.';

describe('parseTranscriptTable (round-tripped through renderReport)', () => {
  it('recovers every transcript line, speaker, t_ms and text exactly', () => {
    const result = baseResult({
      transcript: [
        { speaker: 'agent', text: 'Meridian payments desk, verification line. How can I help you today?', t_ms: 5903 },
        { speaker: 'caller', text: 'This is Robert Miller.', t_ms: 19145 },
        { speaker: 'agent', text: FREEZE_SENTENCE, t_ms: 47566 },
      ],
    });
    const md = renderReport(result);
    const parsed = parseTranscriptTable(md);
    expect(parsed).toEqual(result.transcript);
  });

  it('recovers the interrupted flag and strips its display prefix', () => {
    const result = baseResult({
      transcript: [{ speaker: 'agent', text: 'Please provide the', t_ms: 49543, interrupted: true }],
    });
    const md = renderReport(result);
    const parsed = parseTranscriptTable(md);
    expect(parsed).toEqual([{ speaker: 'agent', text: 'Please provide the', t_ms: 49543, interrupted: true }]);
  });

  it('un-escapes a literal "|" in transcript text (renderTranscript escapes it as "\\|")', () => {
    const result = baseResult({ transcript: [{ speaker: 'caller', text: 'Option A | Option B', t_ms: 100 }] });
    const md = renderReport(result);
    expect(md).toContain('Option A \\| Option B');
    expect(parseTranscriptTable(md)).toEqual([{ speaker: 'caller', text: 'Option A | Option B', t_ms: 100 }]);
  });

  it('returns an empty array for "_No transcript received._" (a protocol-error run)', () => {
    const md = renderReport(baseResult({ transcript: [] }));
    expect(parseTranscriptTable(md)).toEqual([]);
  });
});

describe('parseReportMarkdown (round-tripped through renderReport)', () => {
  it('recovers scenario name, verdicts, ended reason and PASS', () => {
    const md = renderReport(baseResult());
    const parsed = parseReportMarkdown(md);
    expect(parsed.scenario_name).toBe('test-scenario');
    expect(parsed.expected_verdict).toBe('FREEZE');
    expect(parsed.actual_verdict).toBe('FREEZE');
    expect(parsed.ended_reason).toBe('agent_closed');
    expect(parsed.original_result).toBe('PASS');
    expect(parsed.original_fail_reason).toBeNull();
  });

  it('recovers FAIL and a fail_reason', () => {
    const md = renderReport(
      baseResult({ pass: false, exit_code: 1, fail_reason: 'agent_silent_after_hold', warnings: ['agent went silent'] }),
    );
    const parsed = parseReportMarkdown(md);
    expect(parsed.original_result).toBe('FAIL');
    expect(parsed.original_fail_reason).toBe('agent_silent_after_hold');
  });

  it('maps the "unknown (harness closed..." ended-reason fallback back to null', () => {
    const md = renderReport(baseResult({ ended_reason: null }));
    expect(parseReportMarkdown(md).ended_reason).toBeNull();
  });
});

describe('regrade', () => {
  // PROVEN gap regression (2026-09-13, scripts/rehearse/reports/2026-09-13T22-23-50-
  // miller-patient.md): a run recorded PASS under the old grading, whose agent transcript
  // never actually contains the FREEZE close sentence, must regrade to FAIL.
  it('flips a recorded PASS to FAIL when the close line was never spoken (the miller-patient shape)', () => {
    const original = baseResult({
      pass: true,
      close_line_status: 'spoken', // what the OLD report said (the field did not exist/was never checked)
      transcript: [
        { speaker: 'agent', text: 'Which institution holds the Hartwell escrow?', t_ms: 40875 },
        { speaker: 'agent', text: 'Please provide the', t_ms: 49543, interrupted: true },
      ],
    });
    const md = renderReport(original);
    const result = regrade(md);
    expect(result.parsed.original_result).toBe('PASS');
    expect(result.close_line_status).toBe('not_spoken');
    expect(result.regraded_result).toBe('FAIL');
    expect(result.changed).toBe(true);
    expect(result.close_line_failure).toContain('agent_closed');
  });

  it('keeps a recorded PASS as PASS when the close line was actually spoken', () => {
    const md = renderReport(
      baseResult({ transcript: [{ speaker: 'agent', text: FREEZE_SENTENCE, t_ms: 47566 }] }),
    );
    const result = regrade(md);
    expect(result.close_line_status).toBe('spoken');
    expect(result.regraded_result).toBe('PASS');
    expect(result.changed).toBe(false);
  });

  it('leaves an already-FAIL report as FAIL (this tool only ever adds the close-line check, never removes an existing failure)', () => {
    const md = renderReport(
      baseResult({
        pass: false,
        exit_code: 1,
        actual_verdict: 'ESCALATE',
        transcript: [{ speaker: 'agent', text: 'Please provide the', t_ms: 100, interrupted: true }],
      }),
    );
    const result = regrade(md);
    expect(result.parsed.original_result).toBe('FAIL');
    expect(result.regraded_result).toBe('FAIL');
    expect(result.changed).toBe(false);
  });

  it('is n/a (no check applied) when the caller/harness ended the call, and the original result is unchanged', () => {
    const md = renderReport(
      baseResult({
        ended_reason: 'caller_ended',
        transcript: [{ speaker: 'agent', text: 'Please provide the', t_ms: 100, interrupted: true }],
      }),
    );
    const result = regrade(md);
    expect(result.close_line_status).toBe('n/a');
    expect(result.regraded_result).toBe('PASS');
    expect(result.changed).toBe(false);
  });

  it('handles a protocol-error report with no transcript at all (n/a, no crash)', () => {
    const md = renderReport(
      baseResult({
        ended_reason: null,
        verdict_reached: false,
        actual_verdict: null,
        pass: false,
        exit_code: 2,
        transcript: [],
        close_line_status: 'n/a',
      }),
    );
    const result = regrade(md);
    expect(result.close_line_status).toBe('n/a');
    expect(result.regraded_result).toBe('FAIL');
  });
});
