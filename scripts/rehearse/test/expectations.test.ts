import { describe, expect, it } from 'vitest';
import { checkScenarioExpectations, countInterruptedAgentLines, hasAaiLinkRestored } from '../expectations.js';
import type { RehearseDiagnosticBundle, Scenario, TranscriptRecord } from '../types.js';

function baseScenario(overrides: Partial<Scenario['expected']> = {}): Scenario {
  return {
    name: 'x',
    title: 'x',
    description: '',
    source: '',
    turns: [{ id: 'c1', text: 'hello' }],
    expected: { verdict: 'STAGE', max_wall_ms: 1000, ...overrides },
  };
}

function bundleWithEvents(events: { kind: string; detail: unknown }[]): RehearseDiagnosticBundle {
  return {
    session_id: 'sess-1',
    started_at: 0,
    ended_at: 1000,
    end_reason: 'caller_ended',
    deployed_commit: null,
    server_events: events.map((e, i) => ({ t_ms: i * 100, kind: e.kind, detail: e.detail })),
    client_events: [],
  };
}

describe('countInterruptedAgentLines', () => {
  it('counts only lines with interrupted: true', () => {
    const transcript: TranscriptRecord[] = [
      { speaker: 'caller', text: 'a', t_ms: 0 },
      { speaker: 'agent', text: 'b', t_ms: 100, interrupted: true },
      { speaker: 'agent', text: 'c', t_ms: 200 },
      { speaker: 'agent', text: 'd', t_ms: 300, interrupted: true },
    ];
    expect(countInterruptedAgentLines(transcript)).toBe(2);
  });

  it('returns 0 for an empty transcript', () => {
    expect(countInterruptedAgentLines([])).toBe(0);
  });
});

describe('hasAaiLinkRestored', () => {
  it('returns false for a null bundle', () => {
    expect(hasAaiLinkRestored(null)).toBe(false);
  });

  it('returns false when there is no link event at all', () => {
    const bundle = bundleWithEvents([{ kind: 'evaluate', detail: { verdict: 'STAGE' } }]);
    expect(hasAaiLinkRestored(bundle)).toBe(false);
  });

  it('returns false for a browser-leg link:restored (only the AAI leg counts)', () => {
    const bundle = bundleWithEvents([{ kind: 'link', detail: { leg: 'browser', state: 'restored', attempt: 1 } }]);
    expect(hasAaiLinkRestored(bundle)).toBe(false);
  });

  it('returns false for an AAI-leg link that is only "lost" (resume never completed)', () => {
    const bundle = bundleWithEvents([{ kind: 'link', detail: { leg: 'aai', state: 'lost', attempt: 1 } }]);
    expect(hasAaiLinkRestored(bundle)).toBe(false);
  });

  it('returns true for an AAI-leg link:restored event', () => {
    const bundle = bundleWithEvents([
      { kind: 'link', detail: { leg: 'aai', state: 'lost', attempt: 1 } },
      { kind: 'link', detail: { leg: 'aai', state: 'restored', attempt: 1 } },
    ]);
    expect(hasAaiLinkRestored(bundle)).toBe(true);
  });
});

describe('checkScenarioExpectations', () => {
  it('passes (empty failures) when the scenario carries neither optional expectation', () => {
    const result = checkScenarioExpectations(baseScenario(), [], null);
    expect(result).toEqual({ ok: true, failures: [] });
  });

  it('fails when min_interrupted_agent_lines is not met', () => {
    const scenario = baseScenario({ min_interrupted_agent_lines: 1 });
    const result = checkScenarioExpectations(scenario, [{ speaker: 'agent', text: 'hi', t_ms: 0 }], null);
    expect(result.ok).toBe(false);
    expect(result.failures[0]).toContain('expected at least 1 interrupted agent line');
  });

  it('passes when min_interrupted_agent_lines is met exactly', () => {
    const scenario = baseScenario({ min_interrupted_agent_lines: 1 });
    const transcript: TranscriptRecord[] = [{ speaker: 'agent', text: 'hi', t_ms: 0, interrupted: true }];
    expect(checkScenarioExpectations(scenario, transcript, null)).toEqual({ ok: true, failures: [] });
  });

  it('fails when require_aai_link_restored is true and no such event is in the bundle', () => {
    const scenario = baseScenario({ require_aai_link_restored: true });
    const result = checkScenarioExpectations(scenario, [], bundleWithEvents([]));
    expect(result.ok).toBe(false);
    expect(result.failures[0]).toContain('link:"restored"');
  });

  it('passes when require_aai_link_restored is true and the bundle has one', () => {
    const scenario = baseScenario({ require_aai_link_restored: true });
    const bundle = bundleWithEvents([{ kind: 'link', detail: { leg: 'aai', state: 'restored', attempt: 1 } }]);
    expect(checkScenarioExpectations(scenario, [], bundle)).toEqual({ ok: true, failures: [] });
  });

  it('accumulates BOTH failures at once when both expectations are set and both are unmet', () => {
    const scenario = baseScenario({ min_interrupted_agent_lines: 1, require_aai_link_restored: true });
    const result = checkScenarioExpectations(scenario, [], bundleWithEvents([]));
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(2);
  });
});
