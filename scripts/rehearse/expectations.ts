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
import { closeLineSpokenForVerdict } from './turnController.js';
import type { RehearseDiagnosticBundle, Scenario, TranscriptRecord } from './types.js';
import type { Verdict } from '@countersign/engine';

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

/** PROVEN gap (2026-09-13, scripts/rehearse/reports/2026-09-13T22-23-50-miller-patient.md):
 *  that run was graded PASS because it reached the expected verdict (FREEZE) and the server
 *  ended the call itself (`agent_closed`) -- but the agent's transcript never actually
 *  contained the FREEZE close sentence: its last line was "(interrupted) Please provide the",
 *  cut off by the harness's own next scripted turn. A judge listening to that call would hear
 *  a hang-up with no goodbye. The grader must fail that, and must do so for every scenario
 *  (reactive or LLM-driven, patient or ordinary), not only the patient-caller lane that
 *  happened to surface it.
 *
 *  Reasons the SERVER itself ends a call (as opposed to the browser/caller choosing to end
 *  it): `agent_closed` (the real, successful path -- see turnController.ts's
 *  `scheduleCloseIfNeeded` doc comment) and `close_timeout` (packages/server/src/call/
 *  session.ts's `armClose`: the 15s hard cap that fires precisely when the close line's own
 *  `reply.done` never arrived at all -- i.e. exactly a "never got said" case) and
 *  `idle_timeout` (packages/server/src/index.ts's idle sweep -- can in principle fire after a
 *  verdict but before the close reply completes). `caller_ended` is the harness's OWN
 *  `{type:'end'}` browser message (run.ts, sent once verdict + a settle window have already
 *  passed) -- indistinguishable, from this harness's outside view, from a real caller hanging
 *  up first, which is never expected to have heard a close line it hung up before. A `null`
 *  reason (no "ended" event ever observed) is treated the same as `caller_ended`: this
 *  harness cannot tell whether the server was mid-CLOSE or the call simply dropped, so it
 *  does not fail a run on an ambiguous signal it can't corroborate. */
export const SERVER_INITIATED_CLOSE_REASONS: ReadonlySet<string> = new Set(['agent_closed', 'close_timeout', 'idle_timeout']);

export function isServerInitiatedClose(endedReason: string | null): boolean {
  return endedReason !== null && SERVER_INITIATED_CLOSE_REASONS.has(endedReason);
}

/** The terminal `Verdict` values a call can actually close on (mirrors
 *  `CLOSE_SENTENCE_BY_VERDICT`'s keys in turnController.ts) -- `PENDING` is excluded (LAW 2:
 *  it is never a terminal outcome), and this check is meaningless (never applied) when no
 *  verdict was reached at all, since the base verdict-match check already fails that run. */
type TerminalVerdict = 'STAGE' | 'FREEZE' | 'ESCALATE' | 'NO_ACTION';

function isTerminalVerdict(v: Verdict | 'PENDING' | null): v is TerminalVerdict {
  return v === 'STAGE' || v === 'FREEZE' || v === 'ESCALATE' || v === 'NO_ACTION';
}

/** Every agent transcript line's text, in order, exactly as spoken -- what
 *  `closeLineSpokenForVerdict` concatenates and searches. */
function agentLines(transcript: TranscriptRecord[]): string[] {
  return transcript.filter((l) => l.speaker === 'agent').map((l) => l.text);
}

/** The last agent transcript line, formatted the same way report.ts's transcript table shows
 *  it (an `(interrupted)` prefix when the line was cut off) -- surfaced in a FAIL so the
 *  report and the one-line summary show exactly what the agent's last words actually were,
 *  without anyone having to open the full transcript table to see it. */
export function lastAgentLineDisplay(transcript: TranscriptRecord[]): string | null {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const line = transcript[i]!;
    if (line.speaker === 'agent') return `${line.interrupted ? '(interrupted) ' : ''}${line.text}`;
  }
  return null;
}

export type CloseLineStatus = 'spoken' | 'not_spoken' | 'n/a';

export interface CloseLineCheck {
  status: CloseLineStatus;
  /** Set only when `status === 'not_spoken'` -- an unconditional FAIL, same treatment as any
   *  other structural fail condition in run.ts (`fail_reason: 'close_line_not_spoken'`). */
  failure: string | null;
  /** The last agent line as it would render in the transcript table, or null if the agent
   *  never said anything -- always populated when `status === 'not_spoken'`. */
  last_agent_line: string | null;
}

/** run.ts's own close-line grading step: applies ONLY when the server itself ended the call
 *  (`isServerInitiatedClose`) and a real terminal verdict was actually reached -- otherwise
 *  `status: 'n/a'` (nothing to check: either the caller/harness ended the call first, or no
 *  verdict was ever reached, both already covered by other checks). When it does apply,
 *  requires `closeLineSpokenForVerdict` to find the CLOSE sentence matching the call's ACTUAL
 *  verdict somewhere in the concatenated agent transcript -- not just any of the four engine
 *  close sentences, and never satisfied by "goodbye" alone. */
export function checkCloseLineExpectation(
  endedReason: string | null,
  actualVerdict: Verdict | 'PENDING' | null,
  transcript: TranscriptRecord[],
): CloseLineCheck {
  if (!isServerInitiatedClose(endedReason) || !isTerminalVerdict(actualVerdict)) {
    return { status: 'n/a', failure: null, last_agent_line: null };
  }
  const lines = agentLines(transcript);
  if (closeLineSpokenForVerdict(actualVerdict, lines)) {
    return { status: 'spoken', failure: null, last_agent_line: null };
  }
  const lastLine = lastAgentLineDisplay(transcript);
  return {
    status: 'not_spoken',
    failure:
      `the call ended (reason: ${endedReason}) with verdict ${actualVerdict}, but the agent transcript never contains ` +
      `that verdict's closing sentence -- last agent line: ${lastLine === null ? '(none)' : JSON.stringify(lastLine)}`,
    last_agent_line: lastLine,
  };
}
