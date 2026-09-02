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
