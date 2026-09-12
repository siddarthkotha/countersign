// scripts/rehearse/expectations.ts
// Judge-sim finding 2026-09-11 (docs/JUDGE-SIM-2026-09-11.md addendum): across all three live
// bundles rehearsed so far, zero `reply.done` events were "interrupted" (barge-in flush never
// exercised) and zero AssemblyAI socket drops occurred (session.resume never exercised) --
// two mechanics judges score "Application of technology" on directly (BRIEF §12 risk 12).
// A scenario can now ask for PROOF of either, via `Scenario.expected.min_interrupted_agent_
// lines` / `.require_aai_link_restored` (types.ts) -- these two pure, independently-testable
// functions are what run.ts calls to check that proof, so a scenario written to exercise one
// of these mechanics actually FAILS (not just "passes with a hopeful warning") if the real
// stack never produced the evidence.
import type { RehearseDiagnosticBundle, Scenario, TranscriptRecord } from './types.js';

/** How many transcript lines carry `interrupted: true` -- ScreenState's own flag for "agent
 *  line cut off by caller barge-in" (packages/engine/src/types.ts), sourced from AssemblyAI's
 *  real `transcript.agent`/`reply.done` "interrupted"/"status" fields
 *  (packages/server/src/aai/session.ts's `mapServerEvent`), never invented by this harness. */
export function countInterruptedAgentLines(transcript: TranscriptRecord[]): number {
  return transcript.filter((line) => line.interrupted === true).length;
}

/** True iff the raw flight-recorder bundle shows at least one AAI-leg `link` event with
 *  state "restored" -- proof the real bounded resume-on-drop path
 *  (packages/server/src/aai/session.ts's `handleUnexpectedClose`, surfaced server-side by
 *  packages/server/src/call/session.ts's `diag('link', {leg:'aai', state, attempt})`)
 *  actually completed a session.resume, not merely attempted one (a lone "lost" with no
 *  matching "restored" means the resume failed or gave up -- not what this checks for). */
export function hasAaiLinkRestored(bundle: RehearseDiagnosticBundle | null): boolean {
  if (!bundle) return false;
  return bundle.server_events.some((e) => {
    if (e.kind !== 'link' || typeof e.detail !== 'object' || e.detail === null) return false;
    const detail = e.detail as Record<string, unknown>;
    return detail.leg === 'aai' && detail.state === 'restored';
  });
}

/** Checks every optional expectation a scenario carries (beyond the base verdict/max_wall_ms
 *  check run.ts already does) against one run's actual transcript and diagnostics bundle.
 *  Returns an empty `failures` array (i.e. `ok: true`) when the scenario carries none of
 *  these optional fields at all -- they are opt-in, not applied retroactively to every
 *  existing scenario. */
export function checkScenarioExpectations(
  scenario: Scenario,
  transcript: TranscriptRecord[],
  bundle: RehearseDiagnosticBundle | null,
): { ok: boolean; failures: string[] } {
  const failures: string[] = [];

  const minInterrupted = scenario.expected.min_interrupted_agent_lines;
  if (minInterrupted !== undefined) {
    const actual = countInterruptedAgentLines(transcript);
    if (actual < minInterrupted) {
      failures.push(
        `expected at least ${minInterrupted} interrupted agent line(s) (a real barge-in flush), got ${actual}`,
      );
    }
  }

  if (scenario.expected.require_aai_link_restored === true) {
    if (!hasAaiLinkRestored(bundle)) {
      failures.push(
        'expected an AAI-leg link:"restored" event in the flight-recorder bundle (proof session.resume completed after a drop); none found',
      );
    }
  }

  return { ok: failures.length === 0, failures };
}
