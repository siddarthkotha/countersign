import { describe, expect, it } from 'vitest';
import { classifyTarget, computeRunLatencyMetrics, computeTurnResponseGaps, percentile } from '../latencyMath.js';
import type { RehearseDiagnosticBundle, RehearseDiagnosticEvent } from '../types.js';

function bundle(events: RehearseDiagnosticEvent[]): RehearseDiagnosticBundle {
  return {
    session_id: 'sess-test',
    started_at: 1000,
    ended_at: 2000,
    end_reason: 'agent_closed',
    deployed_commit: null,
    server_events: events,
    client_events: [],
  };
}

describe('classifyTarget', () => {
  it('classifies localhost as local', () => {
    expect(classifyTarget('http://localhost:8787')).toBe('local');
  });
  it('classifies 127.0.0.1 as local', () => {
    expect(classifyTarget('http://127.0.0.1:8787')).toBe('local');
  });
  it('classifies any other host as deployed', () => {
    expect(classifyTarget('https://countersign-bf8q.onrender.com')).toBe('deployed');
  });
  it('classifies null as unknown', () => {
    expect(classifyTarget(null)).toBe('unknown');
  });
});

describe('percentile', () => {
  it('returns null for an empty sample', () => {
    expect(percentile([], 0.5)).toBeNull();
  });
  it('returns the single value for a one-element sample', () => {
    expect(percentile([42], 0.5)).toBe(42);
    expect(percentile([42], 0.95)).toBe(42);
  });
  it('computes p50 (median) by linear interpolation', () => {
    expect(percentile([10, 20, 30, 40], 0.5)).toBe(25);
    expect(percentile([10, 20, 30], 0.5)).toBe(20);
  });
  it('computes p95 by linear interpolation', () => {
    // sorted [1..100], rank = 0.95*99 = 94.05 -> between index 94 (95) and 95 (96)
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 0.95)).toBeCloseTo(95.05, 5);
  });
  it('is order-independent', () => {
    expect(percentile([30, 10, 40, 20], 0.5)).toBe(percentile([10, 20, 30, 40], 0.5));
  });
});

describe('computeTurnResponseGaps', () => {
  it('measures from input.speech.stopped to the next reply.audio.first', () => {
    const events: RehearseDiagnosticEvent[] = [
      { t_ms: 0, kind: 'aai_connect_start', detail: {} },
      { t_ms: 50, kind: 'aai_ready', detail: { ms_since_connect_start: 50, greeting_configured: true } },
      { t_ms: 60, kind: 'reply.audio.first', detail: {} }, // greeting -- no pending stop, ignored
      { t_ms: 1000, kind: 'input.speech.started', detail: {} },
      { t_ms: 2000, kind: 'input.speech.stopped', detail: {} },
      { t_ms: 2500, kind: 'reply.audio.first', detail: {} },
    ];
    const { gaps_ms, source } = computeTurnResponseGaps(events);
    expect(source).toBe('input.speech.stopped');
    expect(gaps_ms).toEqual([500]);
  });

  it('uses the LAST input.speech.stopped before a reply when the caller speaks twice in a row', () => {
    const events: RehearseDiagnosticEvent[] = [
      { t_ms: 1000, kind: 'input.speech.stopped', detail: {} }, // first "No, that's wrong"
      { t_ms: 1200, kind: 'input.speech.stopped', detail: {} }, // second "No, that's wrong"
      { t_ms: 1800, kind: 'reply.audio.first', detail: {} },
    ];
    const { gaps_ms } = computeTurnResponseGaps(events);
    expect(gaps_ms).toEqual([600]); // 1800 - 1200, not 1800 - 1000
  });

  it('does not count a caller turn that never gets a reply', () => {
    const events: RehearseDiagnosticEvent[] = [
      { t_ms: 1000, kind: 'input.speech.stopped', detail: {} },
      { t_ms: 1500, kind: 'reply.audio.first', detail: {} },
      { t_ms: 2000, kind: 'input.speech.stopped', detail: {} }, // call ends before a reply
    ];
    const { gaps_ms } = computeTurnResponseGaps(events);
    expect(gaps_ms).toEqual([500]);
  });

  it('falls back to transcript role=user events when input.speech.stopped is entirely absent', () => {
    const events: RehearseDiagnosticEvent[] = [
      { t_ms: 1000, kind: 'transcript', detail: { role: 'user', length: 12 } },
      { t_ms: 1400, kind: 'reply.audio.first', detail: {} },
    ];
    const { gaps_ms, source } = computeTurnResponseGaps(events);
    expect(source).toBe('transcript.user');
    expect(gaps_ms).toEqual([400]);
  });

  it('reports source "none" and no gaps when neither signal is present', () => {
    const events: RehearseDiagnosticEvent[] = [{ t_ms: 100, kind: 'reply.audio.first', detail: {} }];
    const { gaps_ms, source } = computeTurnResponseGaps(events);
    expect(source).toBe('none');
    expect(gaps_ms).toEqual([]);
  });

  it('is robust to events out of chronological order in the input array', () => {
    const events: RehearseDiagnosticEvent[] = [
      { t_ms: 1800, kind: 'reply.audio.first', detail: {} },
      { t_ms: 1000, kind: 'input.speech.stopped', detail: {} },
    ];
    const { gaps_ms } = computeTurnResponseGaps(events);
    expect(gaps_ms).toEqual([800]);
  });
});

describe('computeRunLatencyMetrics', () => {
  it('computes every column on a full synthetic bundle', () => {
    const b = bundle([
      { t_ms: 0, kind: 'aai_connect_start', detail: {} },
      { t_ms: 90, kind: 'aai_ready', detail: { ms_since_connect_start: 90, greeting_configured: true } },
      { t_ms: 150, kind: 'reply.audio.first', detail: {} }, // greeting audio: 150-90=60ms
      { t_ms: 5000, kind: 'input.speech.stopped', detail: {} },
      { t_ms: 5700, kind: 'reply.audio.first', detail: {} }, // turn gap: 700ms
      { t_ms: 8000, kind: 'terminal_action', detail: { verdict: 'STAGE' } },
      { t_ms: 9500, kind: 'session_ended', detail: {} },
    ]);
    const m = computeRunLatencyMetrics(b);
    expect(m.connect_to_ready_ms).toBe(90);
    expect(m.greeting).toBe(true);
    expect(m.ready_to_first_audio_ms).toBe(60);
    expect(m.turn_response_gaps_ms).toEqual([700]);
    expect(m.caller_end_source).toBe('input.speech.stopped');
    expect(m.connect_to_verdict_ms).toBe(8000);
    expect(m.verdict_to_end_ms).toBe(1500);
  });

  it('prefers the aai_ready event\'s own ms_since_connect_start detail over the raw t_ms difference', () => {
    const b = bundle([
      { t_ms: 0, kind: 'aai_connect_start', detail: {} },
      { t_ms: 40, kind: 'aai_ready', detail: { ms_since_connect_start: 90, greeting_configured: false } }, // deliberately diverges from the raw 40ms t_ms gap
    ]);
    const m = computeRunLatencyMetrics(b);
    expect(m.connect_to_ready_ms).toBe(90); // uses the detail field, not the raw 40ms difference
  });

  it('falls back to raw t_ms subtraction when ms_since_connect_start is absent', () => {
    const b = bundle([
      { t_ms: 0, kind: 'aai_connect_start', detail: {} },
      { t_ms: 120, kind: 'aai_ready', detail: {} },
    ]);
    const m = computeRunLatencyMetrics(b);
    expect(m.connect_to_ready_ms).toBe(120);
    expect(m.greeting).toBeNull();
  });

  it('returns null for every column whose event is missing (an older bundle)', () => {
    const b = bundle([{ t_ms: 0, kind: 'session_minted', detail: {} }]);
    const m = computeRunLatencyMetrics(b);
    expect(m.connect_to_ready_ms).toBeNull();
    expect(m.ready_to_first_audio_ms).toBeNull();
    expect(m.greeting).toBeNull();
    expect(m.connect_to_verdict_ms).toBeNull();
    expect(m.verdict_to_end_ms).toBeNull();
    expect(m.turn_response_gaps_ms).toEqual([]);
  });

  it('marks connect_to_verdict_ms UNKNOWN (null) when there is no terminal_action (a FAIL run)', () => {
    const b = bundle([
      { t_ms: 0, kind: 'aai_connect_start', detail: {} },
      { t_ms: 90, kind: 'aai_ready', detail: { ms_since_connect_start: 90 } },
      { t_ms: 9999, kind: 'session_ended', detail: {} },
    ]);
    const m = computeRunLatencyMetrics(b);
    expect(m.connect_to_verdict_ms).toBeNull();
    expect(m.verdict_to_end_ms).toBeNull(); // needs both terminal_action AND session_ended
  });

  it('handles multiple caller turns, matching each reply to the correct preceding stop', () => {
    const b = bundle([
      { t_ms: 0, kind: 'aai_connect_start', detail: {} },
      { t_ms: 50, kind: 'aai_ready', detail: { ms_since_connect_start: 50, greeting_configured: true } },
      { t_ms: 100, kind: 'reply.audio.first', detail: {} }, // greeting
      { t_ms: 1000, kind: 'input.speech.stopped', detail: {} },
      { t_ms: 1300, kind: 'reply.audio.first', detail: {} }, // gap 300
      { t_ms: 2000, kind: 'input.speech.stopped', detail: {} },
      { t_ms: 2900, kind: 'reply.audio.first', detail: {} }, // gap 900
    ]);
    const m = computeRunLatencyMetrics(b);
    expect(m.turn_response_gaps_ms).toEqual([300, 900]);
  });
});
