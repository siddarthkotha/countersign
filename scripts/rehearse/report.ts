// scripts/rehearse/report.ts
// Renders one scenario run into a markdown file (scripts/rehearse/reports/, gitignored) plus
// a one-line stdout summary. Plain English, no em-dashes (CLAUDE.md style rule), every number
// labeled where it isn't simply "what the wire carried".
import { lastAgentLineDisplay } from './expectations.js';
import type { RollupResult, RunResult } from './types.js';

/** Point 1 (run.ts's own PASS/FAIL grading) and point 2 (this report's "Close line" line)
 *  share one plain-English description per `fail_reason` so the two never say something
 *  different about the same run. */
function failReasonDescription(reason: NonNullable<RunResult['fail_reason']>): string {
  switch (reason) {
    case 'agent_silent_after_hold':
      return 'patient-mode caller: a holding line, then silence -- see Warnings';
    case 'close_line_not_spoken':
      return "the server ended the call, but the agent's transcript never contains the closing sentence for the actual verdict -- see Warnings";
    case 'server_never_hung_up':
      return 'the harness waited for the server to end the call on its own and it never did -- the harness ended it itself -- see Warnings';
    case 'agent_silence_exceeded':
      return 'free-play: the agent went silent longer than the allowed gap while the caller was waiting on it -- see Warnings';
    case 'unanswered_agent_question':
      return 'free-play: the agent asked at least one question the caller never got a chance to answer -- see Warnings';
  }
}

/** "Close line: spoken | NOT spoken | n/a (caller ended)" -- always printed, pass or fail, so
 *  every report says plainly whether a judge would have heard the agent's own goodbye before
 *  the call ended. `not_spoken` also names the agent's actual last line, so this doesn't
 *  require opening the full transcript table to see what happened instead. */
function closeLineStatusDisplay(r: RunResult): string {
  if (r.close_line_status === 'spoken') return 'spoken';
  if (r.close_line_status === 'not_spoken') {
    const last = lastAgentLineDisplay(r.transcript);
    return `NOT spoken (last agent line: ${last === null ? '(none)' : JSON.stringify(last)})`;
  }
  return 'n/a (caller ended)';
}

function fmtMs(ms: number | null): string {
  if (ms === null) return 'n/a';
  return `${Math.round(ms)}ms`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Filesystem/timestamp-safe, e.g. "2026-09-03T22-41-05" -- colons are not safe in file
 *  names on every OS this repo might be inspected on. */
export function timestampForFilename(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

export function reportFileName(scenarioName: string, at: Date = new Date()): string {
  return `${timestampForFilename(at)}-${scenarioName}.md`;
}

/** Same basename as `reportFileName` for the same `(scenarioName, at)` pair -- pass the SAME
 *  `at` to both so a run's report and its raw diagnostics bundle land side by side under one
 *  timestamp, per artifacts.ts's `writeRunArtifacts`. */
export function diagnosticsFileName(scenarioName: string, at: Date = new Date()): string {
  return `${timestampForFilename(at)}-${scenarioName}.diagnostics.json`;
}

export function oneLineSummary(r: RunResult, reportPath: string): string {
  const status = r.pass ? 'PASS' : 'FAIL';
  const wall = (r.timings.total_wall_ms / 1000).toFixed(1);
  const reasonSuffix = r.fail_reason ? ` reason=${r.fail_reason}` : '';
  return `[${status}] ${r.scenario.name} verdict=${r.actual_verdict ?? 'none'} (expected ${r.scenario.expected.verdict}) wall=${wall}s exit=${r.exit_code}${reasonSuffix} report=${reportPath}`;
}

function renderTranscript(r: RunResult): string {
  if (r.transcript.length === 0) return '_No transcript received._';
  const rows = r.transcript.map((line) => `| ${fmtMs(line.t_ms)} | ${line.speaker} | ${line.interrupted ? '(interrupted) ' : ''}${line.text.replace(/\|/g, '\\|')} |`);
  return ['| t | speaker | text |', '| --- | --- | --- |', ...rows].join('\n');
}

function renderStateHistory(r: RunResult): string {
  if (r.state_history.length === 0) return '_No state events received._';
  const rows = r.state_history.map((s) => `| ${fmtMs(s.t_ms)} | ${s.state} | ${s.verdict} | ${s.agent_status} |`);
  return ['| t | engine state | verdict | agent status |', '| --- | --- | --- | --- |', ...rows].join('\n');
}

function renderTurnGaps(r: RunResult): string {
  if (r.timings.turn_gaps.length === 0) return '_No turns recorded._';
  const rows = r.timings.turn_gaps.map(
    (g) => `| ${g.turn_id} | ${fmtMs(g.caller_end_ms)} | ${fmtMs(g.first_reply_audio_ms)} | ${fmtMs(g.gap_ms)} | ${g.note ?? ''} |`,
  );
  return ['| turn | caller ended | first reply audio | gap | note |', '| --- | --- | --- | --- | --- |', ...rows].join('\n');
}

/** Shows how each caller line was actually decided -- "fixed" (the scenario's plain scripted
 *  line), "rule"/"else_say" (an explicit `respond` rule fired), "generic" (the truth-engine
 *  reacted to the agent's own words), "fallback" (nothing reacted, fell back to the fixed
 *  line), or "llm" (the LLM-driven caller). This is what makes a reactive run's behavior
 *  legible without having to cross-reference the raw transcript by hand -- e.g. seeing
 *  `source: generic` next to "No, that's wrong, it's Meridian Supply." on the exact turn
 *  that corrected a planted trap. */
/** Free-play addition (2026-09-14), item 3 of the spec: "Mode: free-play (model X, seed N)",
 *  the pause sequence actually drawn (seededPause.ts -- reproducible from the seed), and the
 *  question-answer ratio (freePlayGrading.ts's `computeQuestionAnswerRatio`, run once per
 *  call by `freePlay.ts`'s `runFreePlayOne` and carried on `RunResult.free_play`). Renders
 *  nothing (empty string) for every non-free-play run -- `renderReport` only calls this when
 *  `r.free_play` is present. */
function renderFreePlaySection(r: RunResult): string {
  const fp = r.free_play;
  if (!fp) return '';
  const qa = fp.question_answer;
  const unanswered = qa.unanswered.length > 0 ? qa.unanswered.map((q) => `  - ${JSON.stringify(q)}`).join('\n') : '  _none_';
  return [
    '## Free play',
    '',
    `- Mode: free-play (model ${fp.model}, seed ${fp.seed})`,
    `- Pause sequence (ms, in draw order): [${fp.pause_sequence_ms.join(', ')}]`,
    `- Agent questions answered: ${qa.answered}/${qa.total}${qa.total === 0 ? ' (the agent asked no questions)' : ''}`,
    '- Unanswered agent questions:',
    unanswered,
    '',
  ].join('\n');
}

function renderResolvedLines(r: RunResult): string {
  if (r.resolved_lines.length === 0) return '_No caller lines recorded._';
  const rows = r.resolved_lines.map(
    (l) =>
      `| ${l.turn_id} | ${l.source} | ${l.text.replace(/\|/g, '\\|')} | ${l.reacted_to ? l.reacted_to.replace(/\|/g, '\\|') : '_none yet_'} |`,
  );
  return ['| turn | source | said | reacting to (agent\'s last line) |', '| --- | --- | --- | --- |', ...rows].join('\n');
}

/** Founder ruling (flight recorder gap, 2026-09-09): the raw JSON dump of an `evaluate`
 *  event's detail (below) is unreadable at a glance -- reconstructing "which
 *  assurance-checklist item was false, which rule row fired" had to be done by hand twice in
 *  one week. This renders that one-line summary ahead of the raw detail, for every recorded
 *  transition. Defensive about shape: an older bundle's `evaluate` events (recorded before
 *  this ruling) only ever carried {verdict, state}, so `rule_row`/`assurance` are read as
 *  "n/a" rather than thrown on. */
function summarizeEvaluateDetail(detail: unknown): string {
  if (typeof detail !== 'object' || detail === null) return 'rule_row=n/a false_assurance=[n/a]';
  const d = detail as Record<string, unknown>;
  const ruleRow = typeof d.rule_row === 'number' ? String(d.rule_row) : 'n/a';
  let falseAssurance = 'n/a';
  if (typeof d.assurance === 'object' && d.assurance !== null) {
    const items = Object.entries(d.assurance as Record<string, unknown>)
      .filter(([, v]) => v === false)
      .map(([k]) => k);
    falseAssurance = items.length ? items.join(', ') : 'none';
  }
  return `rule_row=${ruleRow} false_assurance=[${falseAssurance}]`;
}

function renderDiagnostics(r: RunResult): string {
  const d = r.diagnostics;
  if (!d.ok) return `_Diagnostics unavailable: ${d.error}_`;
  const counts = Object.entries(d.event_kind_counts)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, n]) => `- ${kind}: ${n}`)
    .join('\n');
  const tools = d.tool_events.length
    ? d.tool_events.map((e) => `- t=${fmtMs(e.t_ms)} ${e.kind} ${JSON.stringify(e.detail)}`).join('\n')
    : '_none recorded_';
  const evals = d.evaluate_events.length
    ? d.evaluate_events.map((e) => `- t=${fmtMs(e.t_ms)} ${summarizeEvaluateDetail(e.detail)} ${JSON.stringify(e.detail)}`).join('\n')
    : '_none recorded_';
  const transcript = d.transcript_events.length
    ? d.transcript_events.map((e) => {
        const detail = e.detail as Record<string, unknown> | null;
        if (detail && typeof detail.text === 'string') {
          return `- t=${fmtMs(e.t_ms)} ${detail.role}: ${detail.text}`;
        }
        return `- t=${fmtMs(e.t_ms)} ${detail?.role ?? 'unknown'} (length: ${detail?.length ?? 'unknown'})`;
      }).join('\n')
    : '_none recorded_';
  return [
    `Deployed commit: ${d.deployed_commit ?? 'unknown (local dev, RENDER_GIT_COMMIT not set)'}`,
    `Server-side end reason: ${d.end_reason ?? 'not ended per the bundle'}`,
    // Fix (2026-09-09, PROVEN live-call regression): what the server actually resolved this
    // call's persona/telemetry to, printed near the top so a founder debugging a live call
    // (or reading a rehearsal report) sees it before anything else in this section --
    // exactly the fact that was missing when a legitimate-scenario call behaved as if minted
    // with the attacker persona and nothing in the bundle could say why.
    `Session minted: ${d.session_minted_event ? JSON.stringify(d.session_minted_event.detail) : 'not recorded'}`,
    `Call context: ${d.call_context_event ? JSON.stringify(d.call_context_event.detail) : 'not recorded'}`,
    '',
    '**Transcript (from the flight recorder)**',
    transcript,
    '',
    '**Event kind counts**',
    counts || '_none_',
    '',
    '**Tool / lookup / terminal-action events**',
    tools,
    '',
    '**Evaluate transitions** (verdict/state changed)',
    evals,
  ].join('\n');
}

export function rollupFileName(at: Date = new Date()): string {
  return `${timestampForFilename(at)}-rollup.md`;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** Renders the `--scenario all --repeat N` roll-up: a pass/fail matrix, the wrong-verdict
 *  list (so a FAIL that reached the WRONG terminal verdict is distinguishable at a glance
 *  from one that never reached a verdict at all), per-scenario wall-time medians, and a
 *  credits ESTIMATE for the whole batch. The founder's G2 check
 *  (`--scenario scenario-b-miller-fraud --repeat 2`, "twice in a row, zero resets") reads
 *  straight off this table: two rows for scenario-b, both PASS, is the whole proof. */
export function renderRollup(r: RollupResult): string {
  const lines: string[] = [];
  lines.push('# Rehearsal roll-up');
  lines.push('');
  lines.push(`Started: ${r.started_at_iso}`);
  lines.push(`Ended: ${r.ended_at_iso}`);
  lines.push(`Total runs: ${r.rows.length}`);
  lines.push('');
  lines.push('## Pass/fail matrix');
  lines.push('');
  lines.push('| scenario | run | result | expected | actual | wall | report |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const row of r.rows) {
    lines.push(
      `| ${row.scenario_name} | ${row.run_index} | ${row.pass ? 'PASS' : 'FAIL'} | ${row.expected_verdict} | ${row.actual_verdict ?? 'none'} | ${(row.total_wall_ms / 1000).toFixed(1)}s | ${row.report_path} |`,
    );
  }
  lines.push('');

  const wrong = r.rows.filter((row) => !row.pass);
  lines.push('## Wrong-verdict / failed runs');
  lines.push('');
  if (wrong.length === 0) {
    lines.push('_None -- every run reached its expected verdict._');
  } else {
    for (const row of wrong) {
      lines.push(`- ${row.scenario_name} run ${row.run_index}: expected ${row.expected_verdict}, got ${row.actual_verdict ?? 'none (no terminal verdict reached)'} -- see ${row.report_path}`);
    }
  }
  lines.push('');

  lines.push('## Timing medians (by scenario)');
  lines.push('');
  lines.push('| scenario | runs | median wall time |');
  lines.push('| --- | --- | --- |');
  const byScenario = new Map<string, number[]>();
  for (const row of r.rows) {
    const list = byScenario.get(row.scenario_name) ?? [];
    list.push(row.total_wall_ms);
    byScenario.set(row.scenario_name, list);
  }
  for (const [name, wallTimes] of byScenario) {
    const med = median(wallTimes);
    lines.push(`| ${name} | ${wallTimes.length} | ${med === null ? 'n/a' : `${(med / 1000).toFixed(1)}s`} |`);
  }
  lines.push('');

  lines.push('## Credits (ESTIMATE, not read from AssemblyAI billing)');
  lines.push('');
  lines.push(
    '- Method: sum of each run\'s own wall-clock duration estimate (see each run\'s report); the actual AssemblyAI billing unit is UNKNOWN to this harness.',
  );
  lines.push(`- ESTIMATE: ~${r.total_minutes_estimate.toFixed(2)} total minutes streamed across this batch.`);
  lines.push('');

  return lines.join('\n');
}

export function renderReport(r: RunResult): string {
  const lines: string[] = [];
  lines.push(`# Rehearsal report: ${r.scenario.title}`);
  lines.push('');
  lines.push(`Scenario: \`${r.scenario.name}\` (source: ${r.scenario.source})`);
  lines.push(`Target: ${r.target_url}`);
  lines.push(`Session id: ${r.session_id}`);
  lines.push(`Started: ${r.started_at_iso}`);
  lines.push(`Caller mode: ${r.caller_mode}`);
  lines.push('');
  lines.push(`## Result: ${r.pass ? 'PASS' : 'FAIL'}`);
  lines.push('');
  lines.push(`- Expected verdict: ${r.scenario.expected.verdict}`);
  lines.push(`- Actual verdict: ${r.actual_verdict ?? 'none reached'}`);
  if (r.fail_reason) lines.push(`- Fail reason: ${r.fail_reason} (${failReasonDescription(r.fail_reason)})`);
  lines.push(`- Reached a terminal verdict: ${r.verdict_reached ? 'yes' : 'no (timed out)'}`);
  lines.push(`- Expected max wall time: ${r.scenario.expected.max_wall_ms}ms`);
  lines.push(`- Actual wall time: ${Math.round(r.timings.total_wall_ms)}ms`);
  lines.push(`- Call ended reason: ${r.ended_reason ?? 'unknown (harness closed the socket without seeing "ended")'}`);
  lines.push(`- Close line: ${closeLineStatusDisplay(r)}`);
  lines.push(`- Exit code: ${r.exit_code}`);
  lines.push('');
  if (r.warnings.length > 0) {
    lines.push('## Warnings');
    for (const w of r.warnings) lines.push(`- ${w}`);
    lines.push('');
  }
  lines.push('## Timings (measured at the harness)');
  lines.push('');
  const diagnostics = r.diagnostics;
  const greetingConfigured = diagnostics.ok ? diagnostics.greeting_configured : null;
  lines.push(`- Connect to ready (first \`state\` event): ${fmtMs(r.timings.ready_ms)}`);
  if (greetingConfigured === true) {
    lines.push(`- Ready to greeting audio: ${fmtMs(r.timings.first_audio_ms)}`);
  } else {
    lines.push(`- Ready to first agent audio: ${fmtMs(r.timings.first_audio_ms)}`);
  }
  lines.push(`- Greeting configured: ${greetingConfigured === true ? 'yes' : greetingConfigured === false ? 'no' : 'unknown'}`);
  lines.push('');
  lines.push('### Per-turn gaps (caller line end -> next agent audio)');
  lines.push('');
  lines.push(renderTurnGaps(r));
  lines.push('');
  lines.push('## Caller line decisions (reactive/LLM caller only)');
  lines.push('');
  lines.push(renderResolvedLines(r));
  lines.push('');
  if (r.free_play) {
    lines.push(renderFreePlaySection(r));
  }
  lines.push('## Full transcript (as received from the server)');
  lines.push('');
  lines.push(renderTranscript(r));
  lines.push('');
  lines.push('## Every state change (engine state / verdict / agent status)');
  lines.push('');
  lines.push(renderStateHistory(r));
  lines.push('');
  lines.push('## Flight recorder bundle (GET /api/session/<id>/diagnostics)');
  lines.push('');
  lines.push(renderDiagnostics(r));
  lines.push('');
  lines.push('## Credits (ESTIMATE, not read from AssemblyAI billing)');
  lines.push('');
  lines.push(
    `- Method: wall-clock duration of this call (WebSocket connect to end), which is the only meter this harness can observe; the actual AssemblyAI billing unit is UNKNOWN to this harness.`,
  );
  lines.push(`- ESTIMATE: ~${r.minutes_estimate.toFixed(2)} minutes streamed for this call.`);
  lines.push('');
  return lines.join('\n');
}
