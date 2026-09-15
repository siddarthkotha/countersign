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
    diagnostics: {
      ok: true,
      event_kind_counts: { evaluate: 3 },
      tool_events: [],
      evaluate_events: [],
      transcript_events: [],
      deployed_commit: null,
      ended_at_ms: 42000,
      end_reason: 'caller_ended',
      session_minted_event: null,
      call_context_event: null,
      greeting_configured: null,
    },
    warnings: [],
    exit_code: 0,
    minutes_estimate: 0.7,
    resolved_lines: [],
    caller_mode: 'reactive',
    close_line_status: 'n/a',
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

  it('shows what the server actually resolved a mint to, near the top of the flight-recorder section (PROVEN live-call regression fix, 2026-09-09)', () => {
    const md = renderReport(
      baseResult({
        diagnostics: {
          ok: true,
          event_kind_counts: { evaluate: 3, session_minted: 1, call_context: 1 },
          tool_events: [],
          evaluate_events: [],
          transcript_events: [],
          deployed_commit: null,
          ended_at_ms: 42000,
          end_reason: 'caller_ended',
          session_minted_event: {
            t_ms: -12,
            kind: 'session_minted',
            detail: { persona_resolved: 'legitimate', persona_input_present: true, body_bytes: 27 },
          },
          call_context_event: {
            t_ms: 5,
            kind: 'call_context',
            detail: { persona: 'legitimate', origin_kind: 'registered_device', origin_geo: 'Austin, TX' },
          },
          greeting_configured: null,
        },
      }),
    );
    expect(md).toContain('Session minted:');
    expect(md).toContain('"persona_resolved":"legitimate"');
    expect(md).toContain('"persona_input_present":true');
    expect(md).toContain('Call context:');
    expect(md).toContain('"origin_kind":"registered_device"');
    const flightIdx = md.indexOf('## Flight recorder bundle');
    const mintedIdx = md.indexOf('Session minted:');
    const countsIdx = md.indexOf('**Event kind counts**');
    expect(flightIdx).toBeGreaterThanOrEqual(0);
    expect(mintedIdx).toBeGreaterThan(flightIdx);
    expect(mintedIdx).toBeLessThan(countsIdx);
  });

  it('shows "not recorded" when a bundle has no session_minted/call_context event (e.g. an older deploy)', () => {
    const md = renderReport(baseResult());
    expect(md).toContain('Session minted: not recorded');
    expect(md).toContain('Call context: not recorded');
  });

  // Founder ruling (flight recorder gap, 2026-09-09): the raw JSON dump of an `evaluate`
  // diagnostic event's detail is unreadable at a glance -- reconstructing "which
  // assurance-checklist item was false, which rule row fired" had to be done by hand twice
  // in one week. The markdown report must summarize both, per transition, on their own line.
  it('summarizes the rule row and the false assurance items for each evaluate transition', () => {
    const md = renderReport(
      baseResult({
        diagnostics: {
          ok: true,
          event_kind_counts: { evaluate: 1 },
          tool_events: [],
          evaluate_events: [
            {
              t_ms: 1500,
              kind: 'evaluate',
              detail: {
                verdict: 'PENDING',
                state: 'CLAIM',
                rule_row: 4,
                assurance: {
                  identity_claimed: true,
                  sso_pass_current: false,
                  oob_confirmed_current: false,
                  context_pass_current: true,
                  no_contradictions: true,
                  critical_fields_confirmed: false,
                  exposure_within_limit: true,
                  challenge_requirement_met: false,
                  no_identity_switch: true,
                  not_new_beneficiary: true,
                },
                evidence: [{ id: 'ev-identity-1', kind: 'identity_claim', status: 'INFO' }],
                challenges: { issued: 1, passed: 0, failed: 0 },
                readback: { amount_usd: false },
              },
            },
          ],
          transcript_events: [],
          deployed_commit: null,
          ended_at_ms: 42000,
          end_reason: 'caller_ended',
          session_minted_event: null,
          call_context_event: null,
          greeting_configured: null,
        },
      }),
    );
    expect(md).toContain('rule_row=4');
    expect(md).toContain('sso_pass_current');
    expect(md).toContain('critical_fields_confirmed');
    expect(md).toContain('challenge_requirement_met');
    // true assurance items must not be listed among the false ones
    expect(md).not.toMatch(/false_assurance=\[[^\]]*\bidentity_claimed\b/);
  });

  it('summarizes a transition with every assurance item true as having none false', () => {
    const md = renderReport(
      baseResult({
        diagnostics: {
          ok: true,
          event_kind_counts: { evaluate: 1 },
          tool_events: [],
          evaluate_events: [
            {
              t_ms: 2000,
              kind: 'evaluate',
              detail: {
                verdict: 'STAGE',
                state: 'ACTION',
                rule_row: 11,
                assurance: {
                  identity_claimed: true,
                  sso_pass_current: true,
                  oob_confirmed_current: true,
                  context_pass_current: true,
                  no_contradictions: true,
                  critical_fields_confirmed: true,
                  exposure_within_limit: true,
                  challenge_requirement_met: true,
                  no_identity_switch: true,
                  not_new_beneficiary: true,
                },
                evidence: [],
                challenges: { issued: 1, passed: 1, failed: 0 },
                readback: { amount_usd: true },
              },
            },
          ],
          transcript_events: [],
          deployed_commit: null,
          ended_at_ms: 42000,
          end_reason: 'caller_ended',
          session_minted_event: null,
          call_context_event: null,
          greeting_configured: null,
        },
      }),
    );
    expect(md).toContain('rule_row=11');
    expect(md).toMatch(/false_assurance=\[\s*(none|)\s*\]/i);
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

  // PROVEN gap (2026-09-13, expectations.ts's checkCloseLineExpectation doc comment): every
  // report must say plainly whether a judge would have heard the agent's own goodbye.
  describe('Close line reporting', () => {
    it('shows "Close line: spoken" near the Call ended reason line', () => {
      const md = renderReport(baseResult({ close_line_status: 'spoken' }));
      expect(md).toContain('- Close line: spoken');
      const endedIdx = md.indexOf('Call ended reason:');
      const closeIdx = md.indexOf('Close line:');
      expect(closeIdx).toBeGreaterThan(endedIdx);
    });

    it('shows "Close line: n/a (caller ended)" when the check did not apply', () => {
      const md = renderReport(baseResult({ close_line_status: 'n/a' }));
      expect(md).toContain('- Close line: n/a (caller ended)');
    });

    it('shows "Close line: NOT spoken" with the actual last agent line, and the one-line summary carries the fail reason, for the miller-patient regression shape', () => {
      const result = baseResult({
        pass: false,
        exit_code: 1,
        actual_verdict: 'FREEZE',
        ended_reason: 'agent_closed',
        fail_reason: 'close_line_not_spoken',
        close_line_status: 'not_spoken',
        transcript: [
          { speaker: 'agent', text: 'Which institution holds the Hartwell escrow?', t_ms: 40875 },
          { speaker: 'agent', text: 'Please provide the', t_ms: 49543, interrupted: true },
        ],
      });
      const md = renderReport(result);
      expect(md).toContain('- Close line: NOT spoken (last agent line: "(interrupted) Please provide the")');
      expect(md).toContain('- Fail reason: close_line_not_spoken');

      const line = oneLineSummary(result, '/tmp/report.md');
      expect(line).toContain('[FAIL]');
      expect(line).toContain('reason=close_line_not_spoken');
    });
  });

  // Founder ruling 2026-09-11: greeting_configured field distinguishes between greeting
  // (agent speaks first) and legacy caller-first audio timing
  it('renders "Ready to greeting audio" when greeting_configured is true', () => {
    const md = renderReport(
      baseResult({
        diagnostics: {
          ok: true,
          event_kind_counts: { evaluate: 3 },
          tool_events: [],
          evaluate_events: [],
          transcript_events: [],
          deployed_commit: null,
          ended_at_ms: 42000,
          end_reason: 'caller_ended',
          session_minted_event: null,
          call_context_event: null,
          greeting_configured: true,
        },
      }),
    );
    expect(md).toContain('Ready to greeting audio');
    expect(md).toContain('Greeting configured: yes');
    expect(md).not.toContain('Ready to first agent audio');
  });

  it('renders "Ready to first agent audio" when greeting_configured is false', () => {
    const md = renderReport(
      baseResult({
        diagnostics: {
          ok: true,
          event_kind_counts: { evaluate: 3 },
          tool_events: [],
          evaluate_events: [],
          transcript_events: [],
          deployed_commit: null,
          ended_at_ms: 42000,
          end_reason: 'caller_ended',
          session_minted_event: null,
          call_context_event: null,
          greeting_configured: false,
        },
      }),
    );
    expect(md).toContain('Ready to first agent audio');
    expect(md).toContain('Greeting configured: no');
    expect(md).not.toContain('Ready to greeting audio');
  });

  it('renders "Greeting configured: unknown" when greeting_configured is null (older bundle)', () => {
    const md = renderReport(baseResult());
    expect(md).toContain('Greeting configured: unknown');
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
