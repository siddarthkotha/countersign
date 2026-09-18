// scripts/rehearse/test/gradeRecord.test.ts
// gradeRecord.ts's `printGrade` (the pure part of `npm run grade:record -- <diagnostics.json>`,
// item (d) of the SONNET-JUSTIFIED build-lane spec, 2026-09-18): grades ANY raw diagnostics
// bundle straight through experienceGrading.ts's computeExperienceGrade, with no scenario, no
// live call, no file I/O of its own (the caller reads/parses the file; this just grades and
// prints). No network, no filesystem in this test -- a hand-built bundle in, a boolean out.
import { describe, expect, it, vi } from 'vitest';
import { printGrade } from '../gradeRecord.js';
import type { RehearseDiagnosticBundle } from '../types.js';

function bundle(overrides: Partial<RehearseDiagnosticBundle> = {}): RehearseDiagnosticBundle {
  return {
    session_id: 'sess-1',
    started_at: 0,
    ended_at: 90000,
    end_reason: 'agent_closed',
    deployed_commit: null,
    server_events: [],
    client_events: [],
    ...overrides,
  };
}

describe('printGrade', () => {
  it('returns true (PASS) for a clean bundle with no experience defects', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const ok = printGrade('fake-path.json', bundle());
      expect(ok).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('returns false (FAIL) for a bundle with a repeated readback question -- the founder-record shape', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const b = bundle({
        server_events: [
          { t_ms: 57841, kind: 'action_logged', detail: { kind: 'readback_issued', t_ms: 57841, field: 'account_last4', spec_kind: 'READBACK', reply_id: 'r1' } },
          { t_ms: 65765, kind: 'action_logged', detail: { kind: 'readback_issued', t_ms: 65765, field: 'account_last4', spec_kind: 'READBACK', reply_id: 'r2' } },
        ],
      });
      const ok = printGrade('fake-path.json', b);
      expect(ok).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});
