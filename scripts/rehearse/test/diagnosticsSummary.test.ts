import { describe, expect, it } from 'vitest';
import { summarizeDiagnostics } from '../diagnosticsSummary.js';
import type { RehearseDiagnosticBundle } from '../types.js';

describe('summarizeDiagnostics', () => {
  const baseBundle: RehearseDiagnosticBundle = {
    session_id: 'sess-1',
    started_at: 1000,
    ended_at: 2000,
    end_reason: 'caller_ended',
    deployed_commit: null,
    server_events: [],
    client_events: [],
  };

  it('extracts greeting_configured from aai_ready event when true', () => {
    const bundle: RehearseDiagnosticBundle = {
      ...baseBundle,
      server_events: [
        {
          t_ms: 100,
          kind: 'aai_ready',
          detail: { ms_since_connect_start: 50, greeting_configured: true },
        },
      ],
    };

    const summary = summarizeDiagnostics(bundle);
    expect(summary.ok).toBe(true);
    if (summary.ok) {
      expect(summary.greeting_configured).toBe(true);
    }
  });

  it('extracts greeting_configured from aai_ready event when false', () => {
    const bundle: RehearseDiagnosticBundle = {
      ...baseBundle,
      server_events: [
        {
          t_ms: 100,
          kind: 'aai_ready',
          detail: { ms_since_connect_start: 50, greeting_configured: false },
        },
      ],
    };

    const summary = summarizeDiagnostics(bundle);
    expect(summary.ok).toBe(true);
    if (summary.ok) {
      expect(summary.greeting_configured).toBe(false);
    }
  });

  it('sets greeting_configured to null when aai_ready event is absent (older bundle)', () => {
    const bundle: RehearseDiagnosticBundle = {
      ...baseBundle,
      server_events: [
        {
          t_ms: 100,
          kind: 'session_minted',
          detail: { persona_resolved: 'legitimate' },
        },
      ],
    };

    const summary = summarizeDiagnostics(bundle);
    expect(summary.ok).toBe(true);
    if (summary.ok) {
      expect(summary.greeting_configured).toBeNull();
    }
  });

  it('sets greeting_configured to null when aai_ready detail lacks greeting_configured field', () => {
    const bundle: RehearseDiagnosticBundle = {
      ...baseBundle,
      server_events: [
        {
          t_ms: 100,
          kind: 'aai_ready',
          detail: { ms_since_connect_start: 50 },
        },
      ],
    };

    const summary = summarizeDiagnostics(bundle);
    expect(summary.ok).toBe(true);
    if (summary.ok) {
      expect(summary.greeting_configured).toBeNull();
    }
  });

  it('handles null bundle gracefully', () => {
    const summary = summarizeDiagnostics(null);
    expect(summary.ok).toBe(false);
    if (!summary.ok) {
      expect(summary.error).toContain('diagnostics bundle unavailable');
    }
  });

  it('uses only the first aai_ready event if multiple exist', () => {
    const bundle: RehearseDiagnosticBundle = {
      ...baseBundle,
      server_events: [
        {
          t_ms: 100,
          kind: 'aai_ready',
          detail: { ms_since_connect_start: 50, greeting_configured: true },
        },
        {
          t_ms: 200,
          kind: 'aai_ready',
          detail: { ms_since_connect_start: 150, greeting_configured: false },
        },
      ],
    };

    const summary = summarizeDiagnostics(bundle);
    expect(summary.ok).toBe(true);
    if (summary.ok) {
      expect(summary.greeting_configured).toBe(true);
    }
  });
});
