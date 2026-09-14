// scripts/rehearse/types.ts
// Shared types for the rehearsal harness. This is a TEST HARNESS (BRIEF LAW 5 scope fence),
// never wired into the product -- it imports @countersign/engine's own wire types read-only
// so the harness speaks the exact same BrowserEvent/ServerEvent/ScreenState shapes the real
// browser and server do (packages/engine/src/types.ts), instead of a hand-rolled copy that
// could silently drift from the real protocol.
import type { Verdict } from '@countersign/engine';

/** One rule a reactive turn can carry: if the agent's LAST transcript line contains any of
 *  `if_agent_says_any` (case-insensitive substring match), the caller says `say` instead of
 *  its fixed line. Evaluated in list order, first match wins -- see truthEngine.ts.
 *
 *  Fix (2026-09-11, coordinator review of the barge-in-interrupt.json fix): a plain
 *  `if_agent_says_any` phrase list is not robust to the live model's paraphrase of
 *  ASK_CHALLENGE questions (prompt.ts's ASK_CHALLENGE case says "in your own words" --
 *  `goal.challenge.speak` is not wired live), so a hand-picked phrase list like ["restate
 *  the account", "last four digits", ...] can miss a real paraphrase such as "What account
 *  did you mention earlier?". Two optional additional match groups, both AND'd onto
 *  `if_agent_says_any` (still case-insensitive substring, still OR within each group),
 *  let a rule express "topic AND shape AND NOT this other exact line" without a regex
 *  engine:
 *   - `and_agent_says_any`: at least one of these must ALSO be present (e.g. a
 *     question-shape indicator: "?", "can you", "what", ...).
 *   - `unless_agent_says_any`: if ANY of these IS present, the rule does NOT fire, even if
 *     the groups above matched (e.g. the engine's own verbatim readback opener "Just to
 *     confirm", which is always engine-composed and never paraphrased -- see
 *     packages/engine/src/fsm.ts's `readbackSentence` -- so excluding it here is safe).
 *  Both are optional and default to "no constraint" (absent = always satisfied), so every
 *  existing scenario using only `if_agent_says_any` keeps its exact old behavior. */
export interface RespondRule {
  if_agent_says_any: string[];
  and_agent_says_any?: string[];
  unless_agent_says_any?: string[];
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
   *  moment, same mechanism a human barge-in uses.
   *
   *  Timing fix (2026-09-11, PROVEN from scripts/rehearse/reports/2026-09-11T23-28-26-
   *  barge-in-interrupt.md -- 3 earlier runs the same night DID observe a real interruption,
   *  this one did not): the wait is ANCHORED to the reply this turn is meant to interrupt,
   *  not to whenever the harness happens to notice one. Concretely (turnController.ts's
   *  `waitForBargeIn`): wait for the first NEW audio frame after the caller's OWN previous
   *  turn ended (that reply's `reply.audio.first`, bounded to 8s so a reply that never comes
   *  can't wedge the run), then wait `barge_in_after_ms` more from THAT frame's own
   *  timestamp -- never from "now" -- before speaking. If no reply audio shows up inside the
   *  8s bound, this falls back to the pre-fix behaviour (sleep `barge_in_after_ms` from
   *  right now, then speak with no real interruption to reproduce) and records a warning; the
   *  report's per-turn note says which happened. Field name and value are unchanged from
   *  before this fix -- no existing scenario needs to change. */
  barge_in_after_ms?: number;
  /** Makes this turn REACTIVE: instead of always speaking `text`, decide what to say from
   *  what the live agent's last line actually was. See truthEngine.ts's `resolveTurnText`
   *  for the exact precedence. Absent entirely on a turn that must always say its fixed line
   *  regardless of the agent's reply (an opening statement, a scripted pressure escalation). */
  respond?: ScenarioRespond;
  /** Judge-sim finding 2026-09-11 (docs/JUDGE-SIM-2026-09-11.md addendum: "zero AssemblyAI
   *  socket drops occurred -- session.resume never exercised"). When true, the harness POSTs
   *  to the target server's env-guarded debug hook (`/api/session/:id/debug/drop-aai`,
   *  packages/server/src/http.ts -- only live when that server has
   *  COUNTERSIGN_DEBUG_HOOKS=1) BEFORE waiting to speak this turn, forcing a real
   *  AssemblyAI socket drop so the real bounded resume-on-drop path
   *  (packages/server/src/aai/session.ts) actually runs mid-call. Never a throw if the hook
   *  isn't enabled on the target server (a 404) -- a warning is recorded and the scripted
   *  turns continue; `Scenario.expected.require_aai_link_restored` is what actually fails
   *  the run if the drop/resume evidence never shows up. */
  drop_aai_before?: boolean;
  /** PROVEN gap (2026-09-13): the scripted caller always spoke its next line after a fixed
   *  `pause_ms`, so a live agent that said a holding line ("One moment while I verify...")
   *  and then went silent forever (a real hung-call server bug the founder hit) still got a
   *  fresh caller turn and the run passed -- forty green runs masked the bug. When true, this
   *  turn instead waits for a reply that STARTS after the caller's own previous line ended to
   *  fully finish (turnController.ts's `waitForPatientTurn`), judges what it said (a holding
   *  line waits further for a fresh reply and can FAIL the run with `agent_silent_after_hold`;
   *  an engine CLOSE sentence makes the caller stop talking and let the call end), and only
   *  then speaks. `Scenario.caller_style: "patient"` sets this true automatically for every
   *  turn after the first (turn 0 always waits for the greeting, unaffected) -- set here only
   *  to override that default on an individual turn. Absent (the default) preserves the exact
   *  old grace-window-then-speak-regardless behavior -- no existing scenario changes. */
  wait_for_agent?: boolean;
  /** PROVEN gap (2026-09-14, today's reports for miller-patient/structuring-two-wires/
   *  single-wrong-answer/hangup-after-request/judge-out-of-scope/prompt-injection-midcall,
   *  each: "Call ended reason: caller_ended" with "Close line: n/a (caller ended)" and no
   *  goodbye in the agent transcript, graded PASS on verdict alone): the harness used to end
   *  every call itself right after the last scripted turn (or a patient-mode `stop`), racing
   *  the server's own CLOSE hang-up and its goodbye. Now the harness never ends a call itself
   *  after the last turn UNLESS that turn carries `hang_up: true` -- otherwise it waits for
   *  the server's own `ended` event (see turnController.ts's `waitForServerHangup`). Set this
   *  ONLY on a turn whose script deliberately has the caller leave without waiting to hear a
   *  goodbye (e.g. judge-out-of-scope's caller walks away once they've explained they're just
   *  testing) -- never as a workaround for a scenario that is supposed to prove the server's
   *  own close line. Absent (the default, false) on every other scenario. */
  hang_up?: boolean;
}

export interface ScenarioExpected {
  verdict: Verdict;
  /** Wall-clock ceiling (ms), measured from this scenario's WebSocket connect, that the
   *  whole run (every turn plus reaching a terminal verdict) must finish inside. Exceeding
   *  it is a FAIL, not a protocol error -- the stack is reachable and responding, it simply
   *  never reached (or took too long to reach) the expected verdict. */
   max_wall_ms: number;
  /** Judge-sim finding 2026-09-11 (docs/JUDGE-SIM-2026-09-11.md addendum: "zero reply.done
   *  events were interrupted -- barge-in flush never exercised" across three live bundles).
   *  When set, the run FAILS unless at least this many transcript lines carry
   *  `interrupted: true` -- ScreenState's own flag for "agent line cut off by caller
   *  barge-in" (packages/engine/src/types.ts), set from AssemblyAI's real
   *  `transcript.agent`/`reply.done` "interrupted"/"status" fields (packages/server/src/aai/
   *  session.ts's `mapServerEvent`), never invented by this harness. Optional -- omitted by
   *  every scenario that isn't specifically testing barge-in. */
  min_interrupted_agent_lines?: number;
  /** Judge-sim finding 2026-09-11 ("zero AssemblyAI socket drops occurred -- session.resume
   *  never exercised"). When true, the run FAILS unless the flight-recorder bundle shows at
   *  least one AAI-leg `link` event with state "restored" (packages/server/src/call/
   *  session.ts's own `diag('link', {leg:'aai', state, attempt})`, sourced from the real
   *  adapter's bounded resume-on-drop, packages/server/src/aai/session.ts's
   *  `handleUnexpectedClose`) -- proof the real resume path, including a fresh
   *  session.resume send, actually completed, not merely attempted. Optional -- omitted by
   *  every scenario that isn't specifically testing a socket drop. */
  require_aai_link_restored?: boolean;
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
  /** Which demo persona the server should use for this call's simulated telemetry
   *  ("legitimate" or "attacker"). The server owns the mapping; this only names it, exactly
   *  as a visitor picks a role card. A scenario expecting STAGE must set "legitimate",
   *  because the fallback context fails the sign-in check by design. */
  demo_persona?: string;
  /** PROVEN gap (2026-09-13, see ScenarioTurn.wait_for_agent's doc comment for the bug this
   *  exists to catch). "patient" applies `wait_for_agent: true` to every turn after the first
   *  automatically -- the only value this field accepts today. Absent (the default) preserves
   *  the exact old behavior for every existing scenario. */
  caller_style?: 'patient';
  /** Ceiling (ms), used only by patient-mode waits, on how long the caller waits AFTER the
   *  agent finishes a HOLDING line for a fresh reply to start before failing the run with
   *  `agent_silent_after_hold` -- see turnController.ts's `waitForPatientTurn`. Defaults to
   *  12000 when `caller_style`/`wait_for_agent` is used and this is omitted. Meaningless
   *  (never read) on a scenario with no patient-mode turn at all. */
  agent_silence_fail_ms?: number;
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
  /** Fix (2026-09-09, PROVEN live-call regression): what the server actually resolved this
   *  call's persona to, recorded at mint time (http.ts's /api/session/start handler, PROVEN:
   *  packages/server/src/diagnostics.ts's `recordPendingServerEvent`) -- `null` for a bundle
   *  that predates this fix, or a session that was never minted through this route. */
  session_minted_event: RehearseDiagnosticEvent | null;
  /** Fix (2026-09-09, same regression): the simulated telemetry (origin_kind/origin_geo)
   *  this call's persona actually resolved to at WS attach (PROVEN: ws/browser.ts, where
   *  defaultCallContext is built) -- `null` for a bundle that predates this fix. */
  call_context_event: RehearseDiagnosticEvent | null;
  /** Founder ruling 2026-09-11: whether this call's AAI connection requested a greeting
   *  (the agent speaks first). Extracted from the aai_ready event's detail. `null` for a
   *  bundle that predates this field. */
  greeting_configured: boolean | null;
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
  /** The exact bundle GET /api/session/<id>/diagnostics returned for this call (null if the
   *  call never connected far enough to fetch one, or the fetch itself failed) -- kept
   *  verbatim, separate from the summarized `diagnostics` above, so artifacts.ts can write it
   *  to disk unmodified for offline replay/investigation (see docs/REHEARSAL-HARNESS.md). */
  raw_diagnostics: RehearseDiagnosticBundle | null;
  warnings: string[];
  exit_code: 0 | 1 | 2;
  minutes_estimate: number;
  resolved_lines: ResolvedLineRecord[];
  caller_mode: 'reactive' | 'llm';
  /** Set only when a patient-mode wait (turnController.ts's `waitForPatientTurn`) caught the
   *  exact bug this feature exists to catch: a holding line spoken, then silence past
   *  `agent_silence_fail_ms` with no further reply; OR (PROVEN gap, 2026-09-13,
   *  expectations.ts's `checkCloseLineExpectation` doc comment) the server ended the call
   *  itself but the agent transcript never contains the closing sentence matching the actual
   *  verdict -- `close_line_not_spoken`. Either way: a distinct, greppable fail reason
   *  surfaced in the report's one-line result and its Result section, separate from the
   *  generic warnings list. Absent for every ordinary pass or fail. */
  /** PROVEN gap (2026-09-14): the harness waited for the server's own `ended` event after the
   *  last scripted turn (or a patient-mode `stop`) -- see `ScenarioTurn.hang_up`'s doc
   *  comment -- and it never arrived within the wait budget (turnController.ts's
   *  `waitForServerHangup`). The harness then ended the call itself as a last resort so the
   *  run could still be reported, but this is always a bug worth surfacing: the server never
   *  hangs up on its own is either a hung CLOSE state or a genuinely broken close path,
   *  neither of which a judge should ever hit live. */
  fail_reason?: 'agent_silent_after_hold' | 'close_line_not_spoken' | 'server_never_hung_up';
  /** expectations.ts's `checkCloseLineExpectation` result -- `'n/a'` when the check didn't
   *  apply (the caller/harness ended the call first, or no verdict was ever reached),
   *  `'spoken'`/`'not_spoken'` when it did. Rendered near "Call ended reason" in the report
   *  regardless of pass/fail, so every report says plainly whether a judge would have heard
   *  the agent's own goodbye. */
  close_line_status: 'spoken' | 'not_spoken' | 'n/a';
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
