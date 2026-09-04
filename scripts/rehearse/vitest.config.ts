// scripts/rehearse/vitest.config.ts
// Standalone vitest config for the rehearsal harness's own unit tests -- root
// vitest.workspace.ts globs only 'packages/*' (PROVEN: vitest.workspace.ts:1), and
// scripts/rehearse is outside that glob and outside this lane's edit rights, so this harness
// is tested with its own explicit config instead: `npm run rehearse:test`
// (== `vitest run --config scripts/rehearse/vitest.config.ts`). None of these tests touch
// the network or a live server -- see docs/REHEARSAL-HARNESS.md for what IS network-only and
// therefore not covered here.
import { defineConfig } from 'vitest/config';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    root: here,
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
