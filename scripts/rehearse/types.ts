// scripts/rehearse/types.ts
// Shared types for the rehearsal harness. This is a TEST HARNESS (BRIEF LAW 5 scope fence),
// never wired into the product -- it imports @countersign/engine's own wire types read-only
// so the harness speaks the exact same BrowserEvent/ServerEvent/ScreenState shapes the real
// browser and server do (packages/engine/src/types.ts), instead of a hand-rolled copy that
// could silently drift from the real protocol.
import type { Verdict } from '@countersign/engine';

/** One rule a reactive turn can carry: if the agent's LAST transcript line contains any of
 *  `if_agent_says_any` (case-insensitive substring match), the caller says `say` instead of
 *  its fixed line. Evaluated in list order, first match wins -- see truthEngine.ts. */
export interface RespondRule {
  if_agent_says_any: string[];
  say: string;
}

/** A turn's reactive behavior. `rules` are tried first (in order); if none match, `else_say`
 *  is used if given; if not, the generic `truth`-driven engine (truthEngine.ts) is tried;
 *  only then does the turn fall back to its own fixed `text`. */
export interface ScenarioRespond {
  rules: RespondRule[];
  else_say?: string;
}

/** The ground facts this scenario's caller either knows (an honest caller: the real amount,
 *  beneficiary, account, ...) or does NOT know (a fraudster who never learns the real
 *  counsel of record, say) -- `null` means "the caller has no true value for this field", not
 *  "the value is empty". Drives the generic truth engine in truthEngine.ts: a field left
 *  `null`/omitted is never auto-corrected or auto-confirmed by that engine, so a fraudulent
 *  persona's own false claims are never accidentally "corrected" toward the real facts. */
export interface ScenarioTruth {
  /** Who the caller claims to be -- used verbatim when the generic engine has to decline an
   *  unanswerable ask ("I don't have that. This is <identity>."). */
  identity: string | null;
  beneficiary?: string | null;
  amount_usd?: number | null;
  account_last4?: string | null;
  counsel?: string | null;
  escrow_institution?: string | null;
  approver?: string | null;
  deadline?: string | null;
}

/** One line the synthetic caller speaks. `id` is only for the report (matches the source
 *  corpus file's own turn ids where the line was taken from one, e.g. "c1", "c4"). */
export interface ScenarioTurn {
  id: string;
  /** The turn's fixed/default line. Always required, even on a reactive (`respond`-carrying)
   *  turn: it is the last-resort fallback if no rule matches, no `else_say` is given, and the
   *  generic truth engine found nothing to react to -- a scenario is never left mute. */
  text: string;
  /** Silence (ms) to wait AFTER the previous agent reply settles, before speaking this
   *  line. Ignored when `barge_in_after_ms` is set (that field replaces this turn's wait
   *  entirely with the barge-in wait below). Defaults to 400ms when omitted. */
  pause_ms?: number;
  /** Reproduces a live barge-in (BRIEF Scenario B, "the interruption is the money shot"):
   *  instead of waiting for the agent's CURRENT reply to finish, wait for that reply to
   *  START (its first audio frame), then wait this many more ms, then start streaming this
   *  turn's caller audio -- interrupting whatever the live agent is actually saying at that
   *  moment, same mechanism a human barge-in uses. */
  barge_in_after_ms?: number;
  /** Makes this turn REACTIVE: instead of always speaking `text`, decide what to say from
   *  what the live agent's last line actually was. See truthEngine.ts's `resolveTurnText`
   *  for the exact precedence. Absent entirely on a turn that must always say its fixed line
   *  regardless of the agent's reply (an opening statement, a scripted pressure escalation). */
  respond?: ScenarioRespond;
}

export interface ScenarioExpected {
  verdict: Verdict;
  /** Wall-clock ceiling (ms), measured from this scenario's WebSocket connect, that the
   *  whole run (every turn plus reaching a terminal verdict) must finish inside. Exceeding
   *  it is a FAIL, not a protocol error -- the stack is reachable and responding, it simply
   *  never reached (or took too long to reach) the expected verdict. */
   max_wall_ms: number;
}

export interface Scenario {
  /** File-name-safe id, e.g. "scenario-a-dana-legitimate" -- used in report file names and
   *  the `--scenario` CLI flag. */
  name: string;
  title: string;
  description: string;
  /** Where these caller lines came from -- docs/BRIEF.md section and/or a corpus file under
   *  packages/engine/corpus (read-only source, never edited by this harness). */
  source: string;
  turns: ScenarioTurn[];
  expected: ScenarioExpected;
  /** Ground facts for the REACTIVE scripted caller's generic truth engine (truthEngine.ts).
   *  Optional for backward compatibility with a scenario that has no reactive turns at all. */
  truth?: ScenarioTruth;
  /** Free-text character brief for the LLM-DRIVEN caller only (`--caller llm`, llmCaller.ts):
   *  who they are, what they want, what they know, how they behave under pressure. Never
   *  read by the reactive caller. Optional -- required only to use `--caller llm` on this
   *  scenario. */
  persona?: string;
}

export interface TurnGapRecord {
  turn_id: string;
  /** ms since WebSocket connect that this turn finished streaming its caller audio. */
  caller_end_ms: number;
  /** ms since connect of the first agent reply audio frame received after caller_end_ms,
   *  or null if none arrived before the next turn started (or the call ended). */
  first_reply_audio_ms: number | null;
  gap_ms: number | null;
  /** Set for a barge-in turn -- the gap number above is not a real "how long did the agent
   *  take to reply" measurement for that turn, since the caller spoke deliberately WHILE a
   *  reply was already in flight. */
  note?: string;
}

export interface StateHistoryRecord {
  t_ms: number;
  state: string;
  verdict: string;
  agent_status: string;
}

export interface TranscriptRecord {
  speaker: string;
  text: string;
  t_ms: number;
  interrupted?: boolean;
}

/** Mirrors packages/server/src/diagnostics.ts's own `DiagnosticEvent`/`DiagnosticBundle`
 *  shapes (PROVEN: diagnostics.ts:45-70) -- redeclared locally rather than imported, since
 *  @countersign/server's package entry point (src/index.ts) boots the whole live server as
 *  a side effect and is not a safe thing for a test harness to import. This is loose JSON
 *  typing on purpose: the harness only ever reads and summarizes this, it never trusts it
 *  for a verdict (LAW 3 is untouched -- this is diagnostics, not evidence, same as the
 *  server's own doc comment says). */
export interface RehearseDiagnosticEvent {
  t_ms: number;
  kind: string;
  detail: unknown;
}

export interface RehearseDiagnosticBundle {
  session_id: string;
  started_at: number;
  ended_at: number | null;
  end_reason: string | null;
  deployed_commit: string | null;
  server_events: RehearseDiagnosticEvent[];
  client_events: RehearseDiagnosticEvent[];
}

export interface DiagnosticsSummary {
  ok: true;
  event_kind_counts: Record<string, number>;
  tool_events: RehearseDiagnosticEvent[];
  evaluate_events: RehearseDiagnosticEvent[];
  deployed_commit: string | null;
  ended_at_ms: number | null;
  end_reason: string | null;
}

export interface DiagnosticsFailure {
  ok: false;
  error: string;
}

/** One caller turn's resolved line and how it was decided -- see truthEngine.ts's
 *  `ResolvedTurnSource`. Recorded per run so a report can show, in plain sight, whenever the
 *  reactive engine overrode a turn's fixed `text` (and why), rather than that only being
 *  inferable from the raw transcript. */
export interface ResolvedLineRecord {
  turn_id: string;
  text: string;
  source: 'fixed' | 'rule' | 'else_say' | 'generic' | 'fallback' | 'llm';
  /** The agent's last line this turn reacted to, or null (no agent line yet / not reactive). */
  reacted_to: string | null;
}

export interface RunResult {
  scenario: Scenario;
  target_url: string;
  session_id: string;
  started_at_iso: string;
  ended_reason: string | null;
  verdict_reached: boolean;
  actual_verdict: Verdict | 'PENDING' | null;
  pass: boolean;
  timings: {
    ready_ms: number | null;
    first_audio_ms: number | null;
    turn_gaps: TurnGapRecord[];
    total_wall_ms: number;
  };
  transcript: TranscriptRecord[];
  state_history: StateHistoryRecord[];
  diagnostics: DiagnosticsSummary | DiagnosticsFailure;
  warnings: string[];
  exit_code: 0 | 1 | 2;
  minutes_estimate: number;
  resolved_lines: ResolvedLineRecord[];
  caller_mode: 'reactive' | 'llm';
}

// ---------- LLM-driven caller (llmCaller.ts) ----------

export type LlmProvider = 'openrouter' | 'gemini';

export interface LlmCallerConfig {
  provider: LlmProvider;
  /** The model id as passed to the provider's API (e.g. "openai/gpt-4o-mini" for
   *  OpenRouter, "gemini-1.5-flash" for Gemini). */
  model: string;
  /** Hard cap on caller turns for one call -- independent of how many turns a reactive
   *  scenario file would have had; an LLM-driven call has no fixed turn list. */
  max_turns: number;
  /** Hard wall-clock cap (ms) on one LLM-driven call, independent of the scenario's own
   *  `expected.max_wall_ms` (this cap can be tighter, to bound API spend). */
  max_wall_ms: number;
  /** Max words the harness asks the model to keep each line to (a soft instruction in the
   *  prompt, not enforced by truncation -- an over-long reply is still spoken in full and
   *  recorded as a warning). */
  max_words_per_line: number;
}

/** One exchange in the running conversation handed to the LLM caller on every turn, in
 *  order -- mirrors the shape a chat-completions "messages" array needs role/content pairs
 *  built from, but is kept provider-agnostic here (llmCaller.ts adapts it per provider). */
export interface LlmTurnHistoryEntry {
  speaker: 'caller' | 'agent';
  text: string;
}

export interface LlmCallerTurnResult {
  text: string;
  barge_in: boolean;
}

/** The minimal HTTP surface llmCaller.ts needs -- injected so tests can supply a mock
 *  without any network access (BRIEF: "the tests must not need the network"). */
export interface HttpClient {
  fetch(url: string, init: { method: string; headers: Record<string, string>; body: string }): Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
    text(): Promise<string>;
  }>;
}

// ---------- roll-up (repeat runs, "--scenario all --repeat N") ----------

export interface RollupRow {
  scenario_name: string;
  run_index: number;
  pass: boolean;
  expected_verdict: Verdict;
  actual_verdict: Verdict | 'PENDING' | null;
  total_wall_ms: number;
  minutes_estimate: number;
  report_path: string;
}

export interface RollupResult {
  rows: RollupRow[];
  total_minutes_estimate: number;
  started_at_iso: string;
  ended_at_iso: string;
}
