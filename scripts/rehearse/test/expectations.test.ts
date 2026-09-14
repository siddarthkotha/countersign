import { describe, expect, it } from 'vitest';
import {
  checkCloseLineExpectation,
  checkScenarioExpectations,
  countInterruptedAgentLines,
  hasAaiLinkRestored,
  isServerInitiatedClose,
  lastAgentLineDisplay,
} from '../expectations.js';
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

describe('isServerInitiatedClose', () => {
  it('is true for agent_closed (the real, successful close path)', () => {
    expect(isServerInitiatedClose('agent_closed')).toBe(true);
  });

  it('is true for close_timeout (the close-line-never-arrived hard cap)', () => {
    expect(isServerInitiatedClose('close_timeout')).toBe(true);
  });

  it('is true for idle_timeout (the server-side idle sweep)', () => {
    expect(isServerInitiatedClose('idle_timeout')).toBe(true);
  });

  it('is false for caller_ended (the browser/harness ended the call itself)', () => {
    expect(isServerInitiatedClose('caller_ended')).toBe(false);
  });

  it('is false for null (no "ended" event was ever observed)', () => {
    expect(isServerInitiatedClose(null)).toBe(false);
  });

  it('is false for an unrecognized reason', () => {
    expect(isServerInitiatedClose('some_future_reason')).toBe(false);
  });
});

describe('lastAgentLineDisplay', () => {
  it('returns null when there is no agent line at all', () => {
    expect(lastAgentLineDisplay([{ speaker: 'caller', text: 'hello', t_ms: 0 }])).toBeNull();
    expect(lastAgentLineDisplay([])).toBeNull();
  });

  it('returns the last agent line verbatim when it was not interrupted', () => {
    const transcript: TranscriptRecord[] = [
      { speaker: 'agent', text: 'first', t_ms: 0 },
      { speaker: 'caller', text: 'reply', t_ms: 100 },
      { speaker: 'agent', text: 'second', t_ms: 200 },
    ];
    expect(lastAgentLineDisplay(transcript)).toBe('second');
  });

  it('prefixes "(interrupted) " when the last agent line was cut off', () => {
    const transcript: TranscriptRecord[] = [{ speaker: 'agent', text: 'Please provide the', t_ms: 0, interrupted: true }];
    expect(lastAgentLineDisplay(transcript)).toBe('(interrupted) Please provide the');
  });

  it('ignores a later caller line when looking for the LAST agent line', () => {
    const transcript: TranscriptRecord[] = [
      { speaker: 'agent', text: 'agent line', t_ms: 0 },
      { speaker: 'caller', text: 'caller line', t_ms: 100 },
    ];
    expect(lastAgentLineDisplay(transcript)).toBe('agent line');
  });
});

describe('checkCloseLineExpectation', () => {
  const FREEZE_SENTENCE = 'This transfer is frozen and an incident has been opened for review. Nothing has moved. Goodbye.';
  const STAGE_SENTENCE = 'Your request is staged for a second, independent approval. Nothing has been released. The evidence record is complete. Goodbye.';

  it('is n/a when the caller/harness ended the call (caller_ended), regardless of verdict', () => {
    const transcript: TranscriptRecord[] = [{ speaker: 'agent', text: 'something unrelated', t_ms: 0 }];
    const result = checkCloseLineExpectation('caller_ended', 'FREEZE', transcript);
    expect(result).toEqual({ status: 'n/a', failure: null, last_agent_line: null });
  });

  it('is n/a when no "ended" event was ever observed (endedReason null)', () => {
    const result = checkCloseLineExpectation(null, 'FREEZE', []);
    expect(result.status).toBe('n/a');
  });

  it('is n/a when the server ended the call but no terminal verdict was ever reached', () => {
    expect(checkCloseLineExpectation('agent_closed', 'PENDING', []).status).toBe('n/a');
    expect(checkCloseLineExpectation('agent_closed', null, []).status).toBe('n/a');
  });

  // PROVEN gap regression (2026-09-13, scripts/rehearse/reports/2026-09-13T22-23-50-
  // miller-patient.md): this exact shape -- agent_closed, verdict FREEZE, last agent line an
  // interrupted "Please provide the" -- was graded PASS by the old logic. It must FAIL now.
  it('fails a server-initiated close whose transcript never says the closing sentence for the actual verdict (the miller-patient regression)', () => {
    const transcript: TranscriptRecord[] = [
      { speaker: 'agent', text: 'Meridian payments desk, verification line. How can I help you today?', t_ms: 5903 },
      { speaker: 'caller', text: "This is Robert Miller...", t_ms: 19145 },
      { speaker: 'agent', text: 'Authority or urgency is not verification. Which law firm is our counsel of record on the Hartwell deal?', t_ms: 27459 },
      { speaker: 'caller', text: 'Whitmore and Vase...', t_ms: 33845 },
      { speaker: 'agent', text: 'Which institution holds the Hartwell escrow?', t_ms: 40875 },
      { speaker: 'caller', text: 'And make it $2.1 million...', t_ms: 47546 },
      { speaker: 'agent', text: 'Please provide the', t_ms: 49543, interrupted: true },
    ];
    const result = checkCloseLineExpectation('agent_closed', 'FREEZE', transcript);
    expect(result.status).toBe('not_spoken');
    expect(result.failure).toContain('agent_closed');
    expect(result.failure).toContain('FREEZE');
    expect(result.failure).toContain('(interrupted) Please provide the');
    expect(result.last_agent_line).toBe('(interrupted) Please provide the');
  });

  it('passes when the concatenated agent transcript contains the full closing sentence for the actual verdict', () => {
    const transcript: TranscriptRecord[] = [
      { speaker: 'agent', text: 'Which institution holds the Hartwell escrow?', t_ms: 100 },
      { speaker: 'agent', text: FREEZE_SENTENCE, t_ms: 200 },
    ];
    const result = checkCloseLineExpectation('agent_closed', 'FREEZE', transcript);
    expect(result).toEqual({ status: 'spoken', failure: null, last_agent_line: null });
  });

  it('accepts the close sentence split across two agent transcript lines (concatenated)', () => {
    const transcript: TranscriptRecord[] = [
      { speaker: 'agent', text: 'This transfer is frozen and an incident has been opened for review.', t_ms: 100 },
      { speaker: 'agent', text: 'Nothing has moved. Goodbye.', t_ms: 200 },
    ];
    expect(checkCloseLineExpectation('agent_closed', 'FREEZE', transcript).status).toBe('spoken');
  });

  it('fails when the transcript speaks a DIFFERENT verdict\'s closing sentence than the one actually reached', () => {
    const transcript: TranscriptRecord[] = [{ speaker: 'agent', text: STAGE_SENTENCE, t_ms: 100 }];
    const result = checkCloseLineExpectation('agent_closed', 'FREEZE', transcript);
    expect(result.status).toBe('not_spoken');
  });

  it('fails a close_timeout (the close reply.done never arrived at all) with an empty transcript tail', () => {
    const transcript: TranscriptRecord[] = [{ speaker: 'agent', text: 'Which institution holds the Hartwell escrow?', t_ms: 100 }];
    const result = checkCloseLineExpectation('close_timeout', 'FREEZE', transcript);
    expect(result.status).toBe('not_spoken');
  });

  it('applies to idle_timeout too', () => {
    const transcript: TranscriptRecord[] = [{ speaker: 'agent', text: FREEZE_SENTENCE, t_ms: 100 }];
    expect(checkCloseLineExpectation('idle_timeout', 'FREEZE', transcript).status).toBe('spoken');
  });

  it('passes a STAGE verdict call that spoke the STAGE sentence', () => {
    const transcript: TranscriptRecord[] = [{ speaker: 'agent', text: STAGE_SENTENCE, t_ms: 100 }];
    expect(checkCloseLineExpectation('agent_closed', 'STAGE', transcript).status).toBe('spoken');
  });
});
