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

// Origin fix round 1 (task-origin-fix1-brief.md #2): X-Forwarded-Proto/X-Forwarded-Host are
// only ever honoured (origin.ts's selfOrigin) when this is explicitly on -- default off
// everywhere except render.yaml, which sets it to "1" because Render's edge is the one
// process actually setting those headers.
describe('loadConfig — trust_proxy', () => {
  it('defaults to false when COUNTERSIGN_TRUST_PROXY is unset', () => {
    expect(loadConfig({}).trust_proxy).toBe(false);
  });

  it('is true only for the exact value "1"', () => {
    expect(loadConfig({ COUNTERSIGN_TRUST_PROXY: '1' }).trust_proxy).toBe(true);
    expect(loadConfig({ COUNTERSIGN_TRUST_PROXY: 'true' }).trust_proxy).toBe(false);
    expect(loadConfig({ COUNTERSIGN_TRUST_PROXY: '0' }).trust_proxy).toBe(false);
    expect(loadConfig({ COUNTERSIGN_TRUST_PROXY: '' }).trust_proxy).toBe(false);
  });
});

// Reviewer finding (2026-09-11): "credits-exhausted replay mode" is a submission
// requirement (CLAUDE.md abuse caps) with nothing implementing it under that name.
// COUNTERSIGN_LIVE_DISABLED=credits is the founder's manual override, letting a rehearsal
// force the credits-exhausted state without waiting for a real AssemblyAI failure.
describe('loadConfig — live_disabled', () => {
  it('defaults to null when COUNTERSIGN_LIVE_DISABLED is unset', () => {
    expect(loadConfig({}).live_disabled).toBe(null);
  });

  it('is "credits" only for the exact value "credits"', () => {
    expect(loadConfig({ COUNTERSIGN_LIVE_DISABLED: 'credits' }).live_disabled).toBe('credits');
    expect(loadConfig({ COUNTERSIGN_LIVE_DISABLED: 'Credits' }).live_disabled).toBe(null);
    expect(loadConfig({ COUNTERSIGN_LIVE_DISABLED: '1' }).live_disabled).toBe(null);
    expect(loadConfig({ COUNTERSIGN_LIVE_DISABLED: '' }).live_disabled).toBe(null);
  });
});

// Review fix (2026-09-11, part c): the founder needs a runtime way to clear a latched
// live_override -- COUNTERSIGN_ADMIN_TOKEN gates POST /api/admin/live-calls/reset (http.ts)
// the same way the kill switch is gated: nothing happens unless this is explicitly set.
describe('loadConfig — admin_token', () => {
  it('defaults to null when COUNTERSIGN_ADMIN_TOKEN is unset or empty', () => {
    expect(loadConfig({}).admin_token).toBe(null);
    expect(loadConfig({ COUNTERSIGN_ADMIN_TOKEN: '' }).admin_token).toBe(null);
  });

  it('passes a non-empty COUNTERSIGN_ADMIN_TOKEN through verbatim', () => {
    expect(loadConfig({ COUNTERSIGN_ADMIN_TOKEN: 'secret-admin-token' }).admin_token).toBe('secret-admin-token');
  });
});

// Rehearsal-harness debug hook (judge-sim finding 2026-09-11): gates
// POST /api/session/:id/debug/drop-aai (http.ts). Same "opt-in only" shape as kill_switch/
// admin_token above -- nothing happens unless this is explicitly set to exactly "1".
describe('loadConfig — debug_hooks_enabled', () => {
  it('defaults to false when COUNTERSIGN_DEBUG_HOOKS is unset or anything other than "1"', () => {
    expect(loadConfig({}).debug_hooks_enabled).toBe(false);
    expect(loadConfig({ COUNTERSIGN_DEBUG_HOOKS: '' }).debug_hooks_enabled).toBe(false);
    expect(loadConfig({ COUNTERSIGN_DEBUG_HOOKS: 'true' }).debug_hooks_enabled).toBe(false);
    expect(loadConfig({ COUNTERSIGN_DEBUG_HOOKS: '0' }).debug_hooks_enabled).toBe(false);
  });

  it('is true only when COUNTERSIGN_DEBUG_HOOKS is exactly "1"', () => {
    expect(loadConfig({ COUNTERSIGN_DEBUG_HOOKS: '1' }).debug_hooks_enabled).toBe(true);
  });
});
