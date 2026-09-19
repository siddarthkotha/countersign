// scripts/rehearse/test/closeTailAudioSummary.test.ts
// CLOSE-TAIL-AUDIO-SECONDS-UNDERCOUNT diagnostics (board item, 2026-09-19): the harness report
// never showed `close_tail_wait`'s own numbers, or the goodbye reply's actual relayed-audio
// total, anywhere -- both were only visible by opening the raw .diagnostics.json by hand
// (exactly how the 0.87s/1.26s undercounts on the 2026-09-19T12-33-07-miller-patient and
// 2026-09-19T12-28-00-barge-in-interrupt bundles were first noticed). This proves the report
// now surfaces both, correlated by reply id, next to the existing Timings section.
import { describe, expect, it } from 'vitest';
import { renderReport } from '../report.js';
import type { RehearseDiagnosticBundle, RunResult, Scenario } from '../types.js';

const scenario: Scenario = {
  name: 'test-scenario',
  title: 'Test Scenario',
  description: 'a scenario for close-tail-audio-summary report rendering tests',
  source: 'inline test fixture',
  turns: [{ id: 'c1', text: 'hello' }],
  expected: { verdict: 'STAGE', max_wall_ms: 60000 },
};

function bundle(events: RehearseDiagnosticBundle['server_events']): RehearseDiagnosticBundle {
  return {
    session_id: 'sess-1',
    started_at: 0,
    ended_at: 90000,
    end_reason: 'agent_closed',
    deployed_commit: 'abc123',
    server_events: events,
    client_events: [],
  };
}

function baseResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    scenario,
    target_url: 'http://localhost:8787',
    session_id: 'sess-1',
    started_at_iso: '2026-09-19T00:00:00.000Z',
    ended_reason: 'agent_closed',
    verdict_reached: true,
    actual_verdict: 'STAGE',
    pass: true,
    timings: {
      ready_ms: 250,
      first_audio_ms: 300,
      turn_gaps: [],
      total_wall_ms: 71750,
    },
    transcript: [],
    state_history: [],
    diagnostics: {
      ok: true,
      event_kind_counts: {},
      tool_events: [],
      evaluate_events: [],
      transcript_events: [],
      deployed_commit: null,
      ended_at_ms: 71750,
      end_reason: 'agent_closed',
      session_minted_event: null,
      call_context_event: null,
      greeting_configured: null,
    },
    raw_diagnostics: null,
    warnings: [],
    exit_code: 0,
    minutes_estimate: 1.2,
    resolved_lines: [],
    caller_mode: 'reactive',
    close_line_status: 'spoken',
    ...overrides,
  };
}

describe('close-tail audio summary in the harness report', () => {
  it('renders nothing when the bundle has no close_tail_wait event (call never reached a spoken close)', () => {
    const md = renderReport(
      baseResult({
        raw_diagnostics: bundle([{ t_ms: 100, kind: 'reply.started', detail: { reply_id: 'a1' } }]),
      }),
    );
    expect(md).not.toContain('Close-tail wait:');
    expect(md).not.toContain('Goodbye reply');
  });

  it('renders nothing when there is no raw diagnostics bundle at all', () => {
    const md = renderReport(baseResult({ raw_diagnostics: null }));
    expect(md).not.toContain('Close-tail wait:');
  });

  // Shape reproduced from scripts/rehearse/reports/2026-09-19T12-28-00-barge-in-interrupt --
  // the goodbye reply's own reply.done fires at the SAME t_ms as close_tail_wait.
  it('shows the close_tail_wait numbers and the correlated goodbye reply audio summary', () => {
    const md = renderReport(
      baseResult({
        raw_diagnostics: bundle([
          { t_ms: 57975, kind: 'reply.started', detail: { reply_id: 'a-prev' } },
          { t_ms: 65875, kind: 'reply.done', detail: { status: 'completed', reply_id: 'a-prev' } },
          { t_ms: 68981, kind: 'reply.started', detail: { reply_id: 'resp-goodbye' } },
          { t_ms: 69062, kind: 'reply.audio.first', detail: {} },
          {
            t_ms: 70230,
            kind: 'transcript',
            detail: { role: 'agent', text: 'Your request is staged for independent approval. The payment is not released. Goodbye.' },
          },
          { t_ms: 70241, kind: 'reply.done', detail: { status: 'completed', reply_id: 'resp-goodbye' } },
          { t_ms: 70241, kind: 'close_tail_wait', detail: { audio_seconds: 1.26, waited_ms: 1500 } },
          { t_ms: 70253, kind: 'reply.started', detail: { reply_id: 'resp-suppressed' } },
          {
            t_ms: 70253,
            kind: 'reply.audio.summary',
            detail: {
              reply_id: 'resp-goodbye',
              total_bytes: 60480,
              bytes_after_done: 0,
              last_audio_ms_after_done: -181,
              first_to_last_audio_ms: 998,
            },
          },
        ]),
      }),
    );
    expect(md).toContain("Close-tail wait: sized off 1.26s of relayed audio, waited 1500ms after the goodbye's reply.done.");
    expect(md).toContain('Goodbye reply (resp-goodbye) audio: 60480 bytes total, 0 bytes after its own reply.done');
    expect(md).toContain('last audio frame -181ms relative to reply.done');
    expect(md).toContain('first-to-last-audio span 998ms.');
  });

  it('says plainly when no reply.audio.summary event matches (an older bundle predating this diagnostic)', () => {
    const md = renderReport(
      baseResult({
        raw_diagnostics: bundle([
          { t_ms: 42506, kind: 'reply.started', detail: { reply_id: 'resp-goodbye' } },
          { t_ms: 42524, kind: 'reply.audio.first', detail: {} },
          { t_ms: 43371, kind: 'reply.done', detail: { status: 'completed', reply_id: 'resp-goodbye' } },
          { t_ms: 43371, kind: 'close_tail_wait', detail: { audio_seconds: 0.87, waited_ms: 1500 } },
        ]),
      }),
    );
    expect(md).toContain("Close-tail wait: sized off 0.87s of relayed audio, waited 1500ms after the goodbye's reply.done.");
    expect(md).toContain('Goodbye reply audio summary: not available in this bundle');
  });

  it('places the close-tail audio lines inside the Timings section', () => {
    const md = renderReport(
      baseResult({
        raw_diagnostics: bundle([
          { t_ms: 100, kind: 'reply.started', detail: { reply_id: 'resp-goodbye' } },
          { t_ms: 150, kind: 'reply.done', detail: { status: 'completed', reply_id: 'resp-goodbye' } },
          { t_ms: 150, kind: 'close_tail_wait', detail: { audio_seconds: 1, waited_ms: 1500 } },
        ]),
      }),
    );
    const timingsIdx = md.indexOf('## Timings');
    const closeTailIdx = md.indexOf('Close-tail wait:');
    const perTurnIdx = md.indexOf('### Per-turn gaps');
    expect(timingsIdx).toBeGreaterThanOrEqual(0);
    expect(closeTailIdx).toBeGreaterThan(timingsIdx);
    expect(closeTailIdx).toBeLessThan(perTurnIdx);
  });
});
