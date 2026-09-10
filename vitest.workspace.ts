// Review finding 2026-09-09 (Important): the rehearsal harness and critique runner each carry
// their own vitest config, but neither was in this workspace, so `npm test` and CI never ran
// them. The demo_persona regression test (the root cause of five days of failed honest-caller
// runs) lived only behind `npm run rehearse:test`, which nothing automated invoked. Both suites
// now run under `npm test` and therefore under CI.
export default ['packages/*', 'scripts/rehearse/vitest.config.ts', 'scripts/critique/vitest.config.ts'];
