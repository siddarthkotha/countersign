// scripts/critique/vitest.config.ts
// Standalone vitest config for the critique loop's own unit tests -- root vitest.workspace.ts
// globs only 'packages/*' (PROVEN: vitest.workspace.ts:1), and scripts/critique is outside
// that glob and outside this lane's edit rights, so this harness is tested with its own
// explicit config instead: `npx vitest run --root scripts/critique` (equivalently
// `vitest run --config scripts/critique/vitest.config.ts`). None of these tests touch the
// network -- every provider test mocks global.fetch.
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
