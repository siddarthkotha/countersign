// packages/server/test/config.test.ts
// Task R1 fix round 1: index.ts now threads `cfg.browser_grace_ms` into
// `attachWebSocketServer` (it used to be parsed by `loadConfig` and then never read
// anywhere), so this asserts `loadConfig` actually parses COUNTERSIGN_BROWSER_GRACE_MS --
// the one piece of that wiring `config.ts` itself is responsible for.
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig — browser_grace_ms', () => {
  it('defaults to 20000ms when COUNTERSIGN_BROWSER_GRACE_MS is unset', () => {
    const cfg = loadConfig({});
    expect(cfg.browser_grace_ms).toBe(20000);
  });

  it('parses COUNTERSIGN_BROWSER_GRACE_MS from the environment', () => {
    const cfg = loadConfig({ COUNTERSIGN_BROWSER_GRACE_MS: '5000' });
    expect(cfg.browser_grace_ms).toBe(5000);
  });

  it('falls back to the default for an empty or non-numeric value', () => {
    expect(loadConfig({ COUNTERSIGN_BROWSER_GRACE_MS: '' }).browser_grace_ms).toBe(20000);
    expect(loadConfig({ COUNTERSIGN_BROWSER_GRACE_MS: 'not-a-number' }).browser_grace_ms).toBe(20000);
  });
});

// Same-origin fix (2026-09-02): render.yaml now ships COUNTERSIGN_ALLOWED_ORIGINS="" in
// production (the server recognizes its own origin automatically -- see http.ts's
// selfOrigin/isAllowedOrigin), so an explicitly empty env var must parse to a genuinely
// empty list, never fall back to "allow all" or to the local-dev default below.
describe('loadConfig — allowed_origins', () => {
  it('defaults to the local dev origin when the env var is unset entirely', () => {
    expect(loadConfig({}).allowed_origins).toEqual(['http://localhost:5173']);
  });

  it('an explicitly empty env var parses to an empty list, not the dev default', () => {
    expect(loadConfig({ COUNTERSIGN_ALLOWED_ORIGINS: '' }).allowed_origins).toEqual([]);
  });

  it('parses a comma-separated list, trimming whitespace and dropping empty entries', () => {
    expect(
      loadConfig({ COUNTERSIGN_ALLOWED_ORIGINS: 'https://a.example, https://b.example,,' }).allowed_origins
    ).toEqual(['https://a.example', 'https://b.example']);
  });
});
