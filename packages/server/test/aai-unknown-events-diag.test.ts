// packages/server/test/aai-unknown-events-diag.test.ts
// This test file has been removed as part of aai-observability lane (2026-09-16, finding 2):
// the per-change `aai_unknown_events` diag has been removed in favor of per-type summary
// diagnostics that track known-ignored types (session.updated, transcript.user.delta) with
// `ignored: true` flag. See aai-observability-diag.test.ts for updated test coverage.
// The `stats()` method continues to work and is tested in aai-session.test.ts.
import { describe, it, expect } from 'vitest';

describe('aai_unknown_events_diag (removed - aai-observability lane, finding 2)', () => {
  it('this test file is kept as a placeholder to document that aai_unknown_events diag has been removed', () => {
    expect(true).toBe(true);
  });
});
