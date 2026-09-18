// packages/server/src/call/session.ts
// The only authority for a call: owns the server-side conversation/tools/actions logs,
// re-runs the engine after every event (LAW 3 -- the engine is the only verdict owner),
// enforces the per-state tool allowlist and the tool.result timing rule, drives
// session.update when the goal changes, writes challenge_issued/readback_issued actions
// when the agent's reply for that goal completes, executes terminal actions and re-runs the
// engine over the frozen logs (the countersign), and turns the result into the ScreenState
// pushed to the browser. Nothing here trusts the browser for anything (D2, server-
// authoritative): BrowserEvent carries no evidence, only audio/lifecycle signals.
import {
  buildEvidenceExport,
  type AgentAction,
  type CallContext,
  type EngineInput,
  type EngineOutput,
  type GoalCode,
  type PhrasingGoal,
  type SeedConfig,
  type ServerEvent,
  type BrowserEvent,
  type ToolLogEntry,
  type ToolName,
  type Utterance,
  type Verdict,
  type mockToolResult,
  type MockCtx,
} from '@countersign/engine';
import { evaluate } from '@countersign/engine';
import type { AaiEvent, AaiSocket, ReplyCreateMessage } from '../aai/types.js';
import { isToolName, toolLogEntryFromCall, utteranceFromTranscript } from './events.js';
import { renderPrompt, type PromptCtx } from './prompt.js';
import { toolSchemasFor, paramsFor } from './allowlist.js';
import { deriveScreenState } from '../screen/state.js';
import { validateToolArgs } from './validate.js';
import { stallKindFor, stallLineFor, type StallKind } from './stalls.js';
import { argsForTerminalTool } from './terminalActions.js';
import { transcriptMatchesCloseSentence, normalizeForCloseMatch } from './closeMatch.js';
import { QUESTION_GOALS, verbatimQuestionSentence, transcriptAsksQuestion, looksLikeAnswerAttempt } from './questionMatch.js';

export interface CallSessionOpts {
  session_id: string;
  seed: SeedConfig;
  call: CallContext;
  aai: AaiSocket;
  now: () => number;
  onServerEvent: (e: ServerEvent) => void;
  mock: typeof mockToolResult;
  /** The agent's spoken persona name (BRIEF: not yet chosen by the founder). Defaults to
   *  `COUNTERSIGN_AGENT_NAME` env, then "Countersign" -- never hard-coded past that. */
  agent_name?: string;
  /** CRITICAL 1 (final review): called on every AAI transcript event (a new caller or agent
   *  line), so ws/browser.ts can `touch()` the caps idle clock from the AAI side too --
   *  previously only a browser-side message reset it, so a caller who stayed on the line but
   *  wasn't the one generating browser traffic could still be idle-reaped mid-conversation. */
  onActivity?: () => void;
  /** Flight recorder (founder's ask, 2026-09-02): append one server_event to this call's
   *  DiagnosticBundle (diagnostics.ts, via ws/browser.ts). Optional -- a caller that doesn't
   *  wire diagnostics (most existing tests) sees no behavior change at all; `kind`/`detail`
   *  are diagnostics vocabulary only, never Evidence (LAW 4) and never a verdict (LAW 3). */
  onDiagnostic?: (kind: string, detail: unknown) => void;
}

interface PendingToolResult {
  call_id: string;
  result: Record<string, unknown>;
  is_error: boolean;
}

function resolveAgentName(explicit: string | undefined): string {
  if (explicit && explicit.trim().length > 0) return explicit.trim();
  const fromEnv = process.env.COUNTERSIGN_AGENT_NAME;
  return fromEnv && fromEnv.trim().length > 0 ? fromEnv.trim() : 'Countersign';
}

/** Tools whose schema carries `identity_id`. Review finding (fix round 1): the LLM never
 *  overrides the claimed identity -- whatever it sends for `identity_id` on one of these is
 *  replaced with the engine's own `claimed_identity_id` before validation ever sees it, so
 *  a spoofed or altered value can never reach the mock backend. */
const IDENTITY_ARG_TOOLS = new Set<ToolName>(['get_request_history', 'check_sso_context', 'verify_out_of_band', 'alert_principal']);

/** Bug fix (2026-09-03, founder-observed live): the EVIDENCE/CONSISTENCY_CHECK STALL prompt
 *  (call/prompt.ts) only ever tells the model to hold the floor -- it never asks it to call
 *  get_request_history/check_sso_context/verify_out_of_band, and nothing else in this file
 *  ran the mock backend except `handleToolCall`, which only fires from an actual `tool.call`
 *  AAI event. A model that never decides to call one deadlocks the call in EVIDENCE forever
 *  (rules.ts row 7 stays PENDING with nothing to ever change it) until the session cap ends
 *  it with no verdict. `runLookupsIfNeeded` below is these three tools, server-initiated,
 *  same pattern as `runTerminalActionsIfNeeded` -- the deterministic core drives the checks,
 *  not the model's whim (LAW 3). */
const LOOKUP_TOOLS: ToolName[] = ['get_request_history', 'check_sso_context', 'verify_out_of_band'];

/** Founder ruling (flight recorder, 2026-09-09): the small, non-evidence detail an
 *  `evaluate` diagnostic event carries on a transition -- enough to answer "which
 *  assurance item was false / which rule fired / which evidence card flagged" from the
 *  bundle alone, without quoting any transcript text or evidence facts/quotes (LAW 4: this
 *  stays diagnostics, never evidence). `rule_hit` is the engine's own decide() table row
 *  (1-13; passed through EngineOutput unchanged -- see types.ts), read as 0 only for an
 *  EngineOutput that predates that field (defensive; a real evaluate() call always sets it).
 */
function evaluateDiagDetail(output: EngineOutput): {
  verdict: Verdict;
  state: EngineOutput['state'];
  rule_row: number;
  assurance: EngineOutput['assurance'];
  evidence: { id: string; kind: string; status: string }[];
  challenges: { issued: number; passed: number; failed: number };
  readback: Record<string, boolean>;
} {
  const readback: Record<string, boolean> = {};
  for (const card of output.evidence) {
    if (card.kind === 'readback_result' && typeof card.facts.field === 'string') {
      readback[card.facts.field] = Boolean(card.facts.confirmed);
    }
  }
  let passed = 0;
  let failed = 0;
  for (const result of Object.values(output.challenges.results)) {
    if (result === 'PASS') passed++;
    else if (result === 'FAIL') failed++;
  }
  return {
    verdict: output.verdict,
    state: output.state,
    rule_row: output.rule_hit ?? 0,
    assurance: output.assurance,
    evidence: output.evidence.map((card) => ({ id: card.id, kind: card.kind, status: card.status })),
    challenges: { issued: output.challenges.issued.length, passed, failed },
    readback,
  };
}

export class CallSession {
  readonly logs: { conversation: Utterance[]; tools: ToolLogEntry[]; actions: AgentAction[] } = {
    conversation: [],
    tools: [],
    actions: [],
  };
  last: EngineOutput | null = null;

  private readonly opts: CallSessionOpts;
  private readonly startMs: number;
  private started = false;
  private ended = false;
  private speaking = false;
  private previousGoalKey: string | null = null;
  /** Flight recorder flood fix (2026-09-03, founder-observed live): the last `evaluate`
   *  signature actually RECORDED to diagnostics (verdict + state + goal code + which rules
   *  fired) -- `applyEvaluate` below only emits a fresh `evaluate` diag event when this
   *  changes, so a call that sits in one state for minutes (nothing said, nothing decided)
   *  stops producing one diag event per tick. Never affects what tick() computes -- only
   *  whether a duplicate gets written to the bundle. */
  private lastEvaluateSignature: string | null = null;
  /** aai-observability lane (2026-09-16, item 1): every server message
   *  `opts.aai.onUnhandledMessage` reports (everything `aai/session.ts`'s `mapServerEvent`
   *  does not model, except `transcript.agent.delta` -- see `recordAgentDelta` below for
   *  that one), keyed by raw message TYPE, counted per call. Rate-limited so one chatty
   *  unmodelled type can never flood the flight recorder: the first
   *  `UNHANDLED_MESSAGE_LOG_CAP` occurrences of a given type each get their own
   *  `aai_unhandled_message` diagnostic (carrying the truncated JSON `detail`); the instant
   *  the cap is crossed, exactly one `aai_unhandled_message_capped` notice fires for that
   *  type and nothing more is logged live for it. `recordUnhandledMessageSummary` (called
   *  once, from `end()`) walks this map so the bundle's last word on every type -- even one
   *  that stayed under the cap the whole call -- is its TRUE total count, not just however
   *  many individual entries happened to get logged. */
  private static readonly UNHANDLED_MESSAGE_LOG_CAP = 20;
  private readonly unhandledMessageCounts = new Map<string, number>();

  private recordUnhandledMessage(type: string, detail: string): void {
    const count = (this.unhandledMessageCounts.get(type) ?? 0) + 1;
    this.unhandledMessageCounts.set(type, count);
    if (count <= CallSession.UNHANDLED_MESSAGE_LOG_CAP) {
      this.diag('aai_unhandled_message', { type, detail });
    }
    if (count === CallSession.UNHANDLED_MESSAGE_LOG_CAP + 1) {
      this.diag('aai_unhandled_message_capped', { type });
    }
  }

  /** Called once, from `end()`. See `unhandledMessageCounts`'s own doc comment. Also
   *  records known-ignored types (session.updated, transcript.user.delta) with
   *  ignored: true flag. */
  private recordUnhandledMessageSummary(): void {
    for (const [type, total] of this.unhandledMessageCounts) {
      this.diag('aai_unhandled_message_summary', { type, total });
    }
    // aai-observability lane (2026-09-16, finding 2): record known-ignored types with
    // ignored: true so the bundle shows they were seen and recognized, not dropped without
    // signal.
    const ignoredStats = this.opts.aai.ignoredEventStats?.();
    if (ignoredStats) {
      for (const [type, total] of ignoredStats) {
        this.diag('aai_unhandled_message_summary', { type, total, ignored: true });
      }
    }
  }

  /** aai-observability lane (2026-09-16, item 3): per-reply accounting for
   *  `transcript.agent.delta` chunks (`opts.aai.onAgentTranscriptDelta`) -- the unmodelled
   *  event type the dead-transcript investigation's own open question is about: did a
   *  reply's words show up as deltas even though no final `transcript.agent` ever arrived
   *  for it? Reply id -> running {count of delta chunks, summed delta text length, last
   *  <=120 chars of delta text accumulated so far}. Never pruned (same convention as
   *  `replyAudioBytes`/`replyTranscripts` above -- one call's volume is small and bounded by
   *  the session cap). Read once per reply, at `reply.done`, by `checkTranscriptDeltas`. */
  private readonly agentDeltaStats = new Map<string, { count: number; total_length: number; last_chars: string }>();
  private static readonly AGENT_DELTA_TAIL_CHARS = 120;

  private recordAgentDelta(replyId: string, delta: string): void {
    const existing = this.agentDeltaStats.get(replyId) ?? { count: 0, total_length: 0, last_chars: '' };
    existing.count += 1;
    existing.total_length += delta.length;
    const combined = existing.last_chars + delta;
    existing.last_chars =
      combined.length > CallSession.AGENT_DELTA_TAIL_CHARS
        ? combined.slice(combined.length - CallSession.AGENT_DELTA_TAIL_CHARS)
        : combined;
    this.agentDeltaStats.set(replyId, existing);
  }

  /** Called from the `reply.done` case in `dispatchAaiEvent`, after `replyTranscripts` for
   *  this reply is already final (nothing later appends to it for a reply id once its own
   *  `reply.done` has fired). Logs `aai_transcript_deltas` ONLY when this reply ended with
   *  no non-empty final `transcript.agent` recorded AND at least one delta chunk was seen
   *  for it -- the exact shape of the two PROVEN dead-transcript incidents this lane exists
   *  to catch (scripts/rehearse/reports/2026-09-16T17-50-00-miller-patient and
   *  .../19-31-28-dana-patient): if the deltas show real accumulated text, the words were on
   *  the wire and a finalize event was dropped or never sent; if the deltas are also empty
   *  (or none arrived at all), AssemblyAI produced no transcript signal for this reply at
   *  all. A no-op (no diagnostic) for the ordinary case where a final transcript DID arrive,
   *  or where no delta was ever recorded for this reply id either (ordinary empty replies,
   *  e.g. an interrupted reply with nothing spoken yet, are not this finding). */
  private checkTranscriptDeltas(replyId: string): void {
    const finalTranscript = this.replyTranscripts.get(replyId);
    if (finalTranscript !== undefined && finalTranscript.trim().length > 0) return;
    const stats = this.agentDeltaStats.get(replyId);
    if (!stats) return;
    this.diag('aai_transcript_deltas', {
      reply_id: replyId,
      delta_count: stats.count,
      delta_total_length: stats.total_length,
      last_chars: stats.last_chars,
    });
  }

  /** Flight recorder: true once the FIRST `reply.audio` frame of the CURRENT reply has been
   *  recorded -- reset by `reply.started` -- so a 50-frame reply produces exactly one
   *  `reply.audio.first` diag event instead of one per frame. */
  private replyFirstAudioRecorded = false;
  private pendingToolResults: PendingToolResult[] = [];
  private actionCounter = 0;
  private toolCounter = 0;
  private mockCtx: MockCtx = { evidence_count: 0, incident_index: 0 };
  /** Fix round 2 (LAW 2/3 re-review finding, IMPORTANT): replaces the old set-once
   *  `terminalActionsRun` boolean. The old code set that flag TRUE before running the owed
   *  actions, so a mid-loop throw (a broken mock -- fix round 1's own "nested failure" test
   *  proved this reachable) permanently skipped whatever hadn't run yet (e.g. `open_incident`,
   *  `alert_principal` -- the actual containment LAW 2 requires alongside a freeze), with no
   *  retry and nothing visible on the screen (a partial failure renders identically to "still
   *  computing": normal banner, just missing the incident id / export hash sublines).
   *
   *  `terminalActionsOwed` is a ONE-TIME snapshot of `output.required_actions`, captured the
   *  moment a terminal verdict is first observed with owed actions -- deliberately never
   *  re-read from a later `evaluate()`. The engine's own `requiredActions()` (fsm.ts) treats
   *  ANY logged tool result (even an error one, from `t.result !== undefined`) as "done" and
   *  drops it from a freshly recomputed list -- which would silently un-own a genuinely
   *  FAILED action the moment its failed attempt gets logged (see below), exactly defeating
   *  the retry this fix exists to provide. Retry bookkeeping is therefore this class's OWN
   *  state, independent of the engine's: `terminalActionSucceeded` (landed for real),
   *  `terminalActionAttempts` (failure count per name, bounded by
   *  `MAX_TERMINAL_ACTION_ATTEMPTS`), `terminalActionsAbandoned` (permanently gave up on).
   *  `terminalActionsSettled` is true once every owed action is EITHER succeeded or
   *  abandoned -- `runTerminalActionsIfNeeded` becomes a no-op from then on, exactly once,
   *  same lifecycle shape the old boolean had. */
  private static readonly MAX_TERMINAL_ACTION_ATTEMPTS = 3;
  private terminalActionsOwed: ToolName[] | null = null;
  private terminalVerdictSnapshot: Verdict | null = null;
  private terminalActionCounts: { conversation_count: number; actions_count: number } | null = null;
  private readonly terminalActionSucceeded = new Set<ToolName>();
  private readonly terminalActionAttempts = new Map<ToolName, number>();
  private readonly terminalActionsAbandoned = new Set<ToolName>();
  private terminalActionsSettled = false;
  /** Same bounded-retry-then-abandon shape as the terminal-action bookkeeping just above,
   *  scoped per (tool name, request_version) since I3 means a lookup that's already
   *  abandoned for version 1 must still be attempted fresh for version 2. Without this, a
   *  broken mock (a real bug, not a model failing to call anything) would make
   *  `runLookupsIfNeeded` retry it on every single tick forever -- unlike a model-issued
   *  `tool.call`, which only ever throws once per explicit call, this runner fires on every
   *  tick for as long as the state stays EVIDENCE/CONSISTENCY_CHECK, so an uncaught,
   *  unbounded throw here would spam the flight recorder and never let the call proceed to
   *  even a degraded verdict. */
  private static readonly MAX_LOOKUP_ATTEMPTS = 3;
  private readonly lookupAttempts = new Map<string, number>();
  private readonly lookupAbandoned = new Set<string>();
  private exportHash: string | null = null;
  private countersignRecomputed = false;
  /** Finding 5 (final review): the in-flight export-hash promise, if any -- `whenIdle()`
   *  lets a test await it deterministically instead of a real-clock `setTimeout` guess. */
  private pendingExport: Promise<void> | null = null;
  private readonly agentName: string;
  /** Fix round 1, finding 1: owned for the life of the call (not per-render) so consecutive
   *  STALL goals of the same kind actually get different holding lines instead of each
   *  render restarting from an empty `used` set. */
  private readonly usedStalls = new Map<StallKind, Set<string>>();

  /** Bug fix (2026-09-11, PROVEN from scripts/rehearse/reports/2026-09-11T16-35-23-
   *  scenario-a-dana-legitimate.md): SEALED (goal CLOSE) used to render a close line the
   *  model could -- and did -- improvise past, and the server never hung up on its own; only
   *  the caller, idle timer, cap, or an error ever ended the call. Once the caller
   *  disconnected 47 seconds of off-goal turns had already played. `CLOSE_GRACE_MS` lets the
   *  CLOSE line's own audio actually finish flushing to the wire before the socket closes.
   *
   *  Round 4 (2026-09-14, time-budget fix, PROVEN live failure -- scripts/rehearse/reports/
   *  2026-09-14T13-47-07-miller-patient.diagnostics.json): the hard cap used to be
   *  CLOSE_TIMEOUT_MS (15s) paired with a fixed CLOSE_REPLY_ATTEMPTS (3) retry count -- the
   *  attempts ran out (one AssemblyAI turn-driven reply under the stale prompt, one empty
   *  reply, one interrupted partial) before AssemblyAI ever produced a reply that actually
   *  said the close line, and the 15s cap ended the call `close_timeout` mid-sentence. The
   *  fix replaces the attempt count with CLOSE_TOTAL_MS (45s, absolute, from CLOSE render) as
   *  the ONLY thing that can end the call without ever hearing a match -- retries in between
   *  are uncapped, spaced by CLOSE_RETRY_MIN_GAP_MS instead of counted (see
   *  `armCloseRetryTimer`/`sendReplyCreate`). Both timers funnel into the existing `end()`
   *  path -- nothing new about HOW a call ends, only WHEN one more automatic trigger fires
   *  it. See this task's report for why this is wired to `state === 'SEALED'`
   *  (STAGE/FREEZE/ESCALATE, the only verdicts CLOSE is ever rendered for today) and
   *  deliberately NOT to OUT_OF_SCOPE/NO_ACTION here -- a judgment call flagged for the
   *  founder (idle timeout's own separate goodbye path, requirement 9 below, DOES cover
   *  NO_ACTION, but only when the idle reaper itself is what ended the call). */
  private static readonly CLOSE_GRACE_MS = 1500;
  private static readonly CLOSE_TOTAL_MS = 45_000;
  /** Round 4: never send a close_retry synchronously off a reply.done -- wait this long
   *  first (a real timer, cleared on end/match/end-of-call) so a retry is never issued while
   *  AssemblyAI is still mid-turn from the event that just triggered it, and so two
   *  back-to-back mismatches (e.g. a3 then a4 in the same tick, PROVEN reachable -- see
   *  session.test.ts's own round-3/round-4 tests) coalesce into a single pending retry
   *  instead of stacking. */
  private static readonly CLOSE_RETRY_MIN_GAP_MS = 400;
  /** Round 4, requirement 5: a `reply.create` this class sent but never got a `reply.started`
   *  for within this long is treated as lost (AssemblyAI dropped it, or it was superseded by
   *  the service's own turn) and `replyCreateAwaitingStart` is cleared so a fresh one can go
   *  out -- otherwise a single lost request would wedge every later send for the rest of the
   *  call (see `sendReplyCreate`'s own "at most one outstanding" guard). */
  private static readonly REPLY_CREATE_LOST_MS = 1500;
  /** Round 4, requirement 7 (founder correction, 2026-09-14, three further PROVEN live
   *  bundles -- see `maybeArmCloseOnTranscript`'s own doc comment): how long to wait for the
   *  in-flight reply's own `reply.done` after its accumulated transcript ALREADY matches the
   *  close sentence, before giving up on `reply.done` ever arriving and starting the grace
   *  period anyway -- the words were already heard; a missing `reply.done` must not block the
   *  hang-up (or worse, let the 45s/close_timeout cap fire on a call that already said
   *  goodbye). Whichever fires first (`reply.done` or this timeout) wins; the call is never
   *  ended twice. */
  private static readonly CLOSE_DONE_WAIT_MS = 4_000;
  /** Defect B fix (2026-09-15, PROVEN: CLOSE reply.create sent twice on 6 of 8 live founder
   *  calls on 2026-09-14, three times on one): how long `scheduleCloseIfNeeded` waits, after
   *  a reply's own `reply.done` arrives with no matching transcript accumulated YET, before
   *  concluding the close line was not spoken and arming a retry. PROVEN from the same live
   *  sample: the agent's final `transcript.agent` chunk for a reply arrives at the END of
   *  that reply -- within tens of ms of `reply.done`, in either order -- so a decision made
   *  the instant `reply.done` fires can race a transcript that is already on the wire. See
   *  `armCloseTranscriptWait`'s own doc comment for the full mechanism. */
  private static readonly CLOSE_TRANSCRIPT_WAIT_MS = 1_500;
  /** Defect A fix (2026-09-15, PROVEN on all 8 server-ended founder calls 2026-09-14):
   *  output audio is 24 kHz PCM16 mono (docs/ASSEMBLYAI_INTEGRATION.md line 17, matching
   *  `packages/web/src/audio/playback.ts`'s own `SAMPLE_RATE = 24000`) -- 24000 samples/sec *
   *  2 bytes/sample * 1 channel = 48000 bytes/sec of decoded PCM. Used by `beginCloseGrace`
   *  to convert relayed `reply.audio` byte counts into an estimated playback duration. */
  private static readonly OUTPUT_AUDIO_BYTES_PER_SECOND = 48_000;
  /** Defect A fix: extra margin added on top of the estimated goodbye playback length before
   *  hanging up -- covers browser-side queueing/scheduling latency the server has no
   *  visibility into (the mechanism analysis found no `BrowserEvent` exists for "audio
   *  finished playing"). Chosen to match the task's own stated formula; not independently
   *  measured (ESTIMATE, not PROVEN) since no round-trip playback-finished signal exists yet. */
  private static readonly CLOSE_AUDIO_TAIL_BUFFER_MS = 1_000;
  /** CRITICAL 2 fix (2026-09-17 review of e7ba96f): the minimum relayed CLOSE-reply audio
   *  (converted from bytes via `OUTPUT_AUDIO_BYTES_PER_SECOND`, same as `beginCloseGrace`'s own
   *  `audioSeconds`) required before `armCloseTranscriptWait`'s degraded audio-confirm branch
   *  will treat a transcript-less CLOSE reply as spoken. A documented ABSOLUTE FLOOR (the
   *  review's own simpler alternative to computing each close sentence's own expected TTS
   *  length -- this codebase has no measured chars/sec speech rate to derive that from):
   *  every CLOSE sentence (fsm.ts's `closeSentence()`) is at minimum the 32-character default
   *  "Thank you for calling. Goodbye." and every real, non-fragment completion of one takes
   *  several real seconds to speak -- comfortably above this floor. A caller barge-in cutting
   *  a CLOSE reply to a fragment ("This...") produces at most a couple hundred milliseconds of
   *  audio -- comfortably below it. 2,000ms is also well under the smallest FULL live
   *  CLOSE-reply duration this codebase has measured (`CLOSE_REPLY_STUCK_MS`'s own 79-sample
   *  p50 of 3952ms), so a genuine completed goodbye is never mistaken for a fragment. */
  private static readonly DEGRADED_CLOSE_CONFIRM_MIN_AUDIO_MS = 2_000;
  /** PROVEN defect (2026-09-14, scripts/rehearse/reports/2026-09-14T17-58-23-barge-in-
   *  interrupt.md + .diagnostics.json): a CLOSE `reply.create` was sent, `reply.started` and
   *  `reply.audio.first` both arrived, then NOTHING else for the rest of the call (no further
   *  audio, no `transcript.agent` chunk, no `reply.done`). The stuck watchdog (below) is an
   *  audio-INACTIVITY timer (fix round 2, 2026-09-15): it fires only when no reply.audio
   *  frame arrived for this reply within 12 s of the LAST audio frame (or reply.started if
   *  no audio yet). This avoids false positives: live CLOSE replies (PROVEN from 79 samples,
   *  scripts/rehearse/reports/2026-09-1[234]*.diagnostics.json) take p50 3952ms, p95 9070ms,
   *  max 12668ms -- so a transcript-less reply lasting longer than the old 12s-from-start
   *  would wrongly fire (one live max already exceeded 12s). The mechanism: `lastReplyAudioAt`
   *  is updated on each reply.audio frame; when the timer fires, if audio arrived recently
   *  (within CLOSE_REPLY_STUCK_MS), re-arm for remaining time; only declare stuck when the
   *  full window passes without any audio. `scheduleCloseIfNeeded` (reply.done path) and
   *  `maybeArmCloseOnTranscript` still clear it outright (both indicate the reply is healthy).
   *  Left well inside CLOSE_TOTAL_MS (45s) so a stuck reply still gets several retries. */
  private static readonly CLOSE_REPLY_STUCK_MS = 12_000;
  /** Fix (2026-09-16, PROVEN live failure -- deploy 41,
   *  scripts/rehearse/reports/2026-09-16T17-50-00-miller-patient.diagnostics.json): the CLOSE
   *  reply.create sent at 96157ms was never acknowledged (no `reply.started` ever arrived) --
   *  `armReplyCreateLostTimer` logged `reply_create_lost` and `armCloseRetryTimer` re-sent,
   *  spaced CLOSE_RETRY_MIN_GAP_MS apart, and EVERY ONE of the next 24 attempts was lost the
   *  exact same way -- not one single CLOSE reply ever got a `reply.started` for the entire
   *  45s CLOSE_TOTAL_MS budget, all the way to `armClose`'s own hard cap finally ending the
   *  call. That total, unbroken non-responsiveness (AssemblyAI never once acknowledges a CLOSE
   *  reply.create, from the very first attempt to the last) is a different, and much stronger,
   *  signal than an isolated stretch of a few lost sends in the middle of an otherwise-live
   *  exchange (round 4's own tests deliberately drive AssemblyAI through 14+ seconds of
   *  silence between real, started-but-mismatched replies, and rely on the unbounded,
   *  time-budgeted retry to ride that out to a real answer -- see
   *  `CLOSE retry is time-budgeted, not attempt-capped` in session.test.ts). Bailing out on
   *  the FIRST short losing streak, regardless of whether AssemblyAI has ever actually
   *  responded at all this call, would break that tolerance for a channel that is merely slow.
   *
   *  So the bound is two-part: `closeEverStarted` (set the instant ANY CLOSE reply gets a
   *  `reply.started` -- see that case's own comment) records whether AssemblyAI has EVER once
   *  acknowledged a CLOSE reply.create, for the life of the call; `closeLostStreak` counts
   *  CONSECUTIVE `reply_create_lost` events since the last time that happened (reset to 0 on
   *  every real start, not just the first). `abandonClose` (below) only ever fires when NEITHER
   *  a start has EVER happened NOR the streak is still under `MAX_CLOSE_LOST_STREAK` -- i.e.
   *  only for a channel that has been totally unresponsive to CLOSE from the very first attempt
   *  onward, exactly the live incident's own shape. Once even one CLOSE reply has started,
   *  round 4's original unbounded-but-time-budgeted design (the 45s absolute cap is the only
   *  backstop) is preserved unchanged -- this fix adds a circuit breaker for total
   *  non-responsiveness, not a general attempt cap. LAW 2 is unaffected either way (the verdict
   *  and containment already ran at the moment CLOSE was first rendered, long before any of
   *  this) -- this only decides how long the wire stays open with zero chance of the caller
   *  ever hearing the goodbye. Chosen to burn at most roughly
   *  MAX_CLOSE_LOST_STREAK * (REPLY_CREATE_LOST_MS + CLOSE_RETRY_MIN_GAP_MS) =~ 5.7s of retrying
   *  (matching the live cadence, ~1.9s/attempt) before giving up in that total-failure case --
   *  well short of the 45s the live failure actually burned, and still three genuine attempts,
   *  not zero. */
  private static readonly MAX_CLOSE_LOST_STREAK = 3;
  private closeLostStreak = 0;
  private closeEverStarted = false;
  private closeGraceTimer: ReturnType<typeof setTimeout> | null = null;
  private closeHardCapTimer: ReturnType<typeof setTimeout> | null = null;
  private closeRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private replyCreateLostTimer: ReturnType<typeof setTimeout> | null = null;
  private closeDoneWaitTimer: ReturnType<typeof setTimeout> | null = null;
  private closeStuckTimer: ReturnType<typeof setTimeout> | null = null;
  /** Defect B fix: the pending "wait for a late transcript" timer, and which reply id it is
   *  waiting on -- see `armCloseTranscriptWait`'s own doc comment. */
  private closeTranscriptWaitTimer: ReturnType<typeof setTimeout> | null = null;
  private closeTranscriptWaitReplyId: string | null = null;
  /** goodbye-tail lane, review fix (2026-09-15, Important -- FAIL on this lane's own two prior
   *  commits): reply ids whose `reply.done` has already fired, read by
   *  `maybeArmCloseOnTranscript` to tell the routine case (final `transcript.agent` chunk
   *  arrives AFTER its own reply.done, PROVEN 6 of 8 live calls, 2026-09-14 sample) apart from
   *  the rarer reverse order (chunk arrives BEFORE reply.done). In the routine case,
   *  `scheduleCloseIfNeeded` has already run for this reply (no match yet) and armed
   *  `armCloseTranscriptWait`'s 1500ms fallback; when the late chunk then completes the match
   *  here, there is no `reply.done` left to wait for -- arming `closeDoneWaitTimer`
   *  (CLOSE_DONE_WAIT_MS, 4000ms) in that case waits out a full moot timer before
   *  `beginCloseGrace()` ever runs, so the caller hears the goodbye and then four to six
   *  seconds of silence before the line drops. Never pruned -- bounded by the session's own
   *  reply count, same convention as `replyTranscripts` above. */
  private readonly repliesWithDone = new Set<string>();
  /** Defect A fix: bytes of `reply.audio` actually RELAYED to the browser (post-suppression),
   *  and the server clock time the first relayed frame went out, keyed by AAI reply id --
   *  never pruned (same convention `replyTranscripts` above already uses: one call's total
   *  volume is small and bounded by the session cap). Read by `beginCloseGrace` for the
   *  confirmed goodbye reply only. */
  private readonly replyAudioBytes = new Map<string, number>();
  private readonly replyFirstAudioAt = new Map<string, number>();
  /** Round 4: the reply id `maybeArmCloseOnTranscript` has already started the hang-up
   *  sequence for, so a second (or third) `transcript.agent` chunk for the SAME reply that
   *  still matches doesn't re-arm a fresh `CLOSE_DONE_WAIT_MS` timer on top of the one
   *  already running. */
  private closeArmedForReplyId: string | null = null;
  /** Round 5 (2026-09-14, PROVEN live: scripts/rehearse/reports/2026-09-13T22-57-34-miller-
   *  patient.md + its .diagnostics.json): after the agent finished speaking the full close
   *  sentence (confirmed at 46135ms), a NEW reply started ("(interrupted) Checking the
   *  transaction history. Please hold.") -- AssemblyAI's own turn-driven follow-up, or a
   *  queued `reply.create` -- and the server relayed its audio to the browser before the
   *  scheduled hang-up cut it off mid-word. A judge hears the goodbye, then the start of a
   *  holding line. `beginCloseGrace`'s timer only decides WHEN the socket closes -- it never
   *  stopped AssemblyAI from generating (and this class from relaying) more in the meantime.
   *
   *  `goodbyeConfirmed`/`goodbyeConfirmedReplyId` are set together, exactly once per call, by
   *  whichever path confirms the transcript match first (`maybeArmCloseOnTranscript` mid-
   *  stream, or `scheduleCloseIfNeeded` at that reply's own `reply.done`) -- never cleared
   *  once true. Three effects, all keyed off this pair:
   *   1. `sendReplyCreate` refuses every future send once `goodbyeConfirmed` is true: no more
   *      goodbye retry is owed (the words were heard), and no OTHER goal's reply.create can
   *      slip out either -- this is the single choke point every caller (force-speak,
   *      close_retry, the lost-reply-create recovery) already funnels through, so one guard
   *      there closes all of them.
   *   2. `reply.started` for any id OTHER than `goodbyeConfirmedReplyId`, arriving once
   *      `goodbyeConfirmed` is true, marks itself `suppressPostGoodbyeReplyAudio` and logs
   *      `post_goodbye_reply_suppressed` exactly once (at start, not per frame).
   *   3. `reply.audio` frames while that flag is set are dropped instead of relayed to the
   *      browser -- the goodbye reply's OWN remaining frames (same reply id) are never
   *      suppressed, only a reply that STARTS AFTER confirmation is.
   *
   *  No AssemblyAI client message to cancel/stop an in-flight reply is documented (docs/
   *  ASSEMBLYAI_INTEGRATION.md's client-event list has no such type -- session.update,
   *  input.audio, session.resume, session.end, tool.result, reply.create,
   *  conversation.message is the complete set) -- suppression on this server's own relay
   *  path is the only mechanism available, not a substitute for a documented cancel call
   *  that does not exist. */
  private goodbyeConfirmed = false;
  private goodbyeConfirmedReplyId: string | null = null;
  /** The AAI reply id the most recent `reply.started` labelled -- `reply.audio` events carry
   *  no reply id of their own (see aai/types.ts), so this is the only way to know which reply
   *  a given audio frame belongs to. */
  private currentReplyId: string | null = null;
  /** True while `currentReplyId` is a reply that started AFTER `goodbyeConfirmed` went true
   *  and is not the confirmed reply itself -- see the `goodbyeConfirmed` doc comment above. */
  private suppressPostGoodbyeReplyAudio = false;
  /** Fix round 2 (2026-09-15, audio-inactivity watchdog): the server's own clock time when
   *  the most recent reply.audio frame for `currentReplyId` arrived -- used to detect audio
   *  inactivity. Updated on every reply.audio frame, never cleared except when a new reply
   *  starts. `armCloseStuckWatchdog` uses this to implement a deadline-driven watchdog that
   *  re-arms if audio was recent, rather than firing immediately at a fixed offset from
   *  reply.started. See that method's own doc comment for the full semantics. */
  private lastReplyAudioAt: number | null = null;
  /** Round 4, requirement 8: whether the CLOSE reply that most recently completed (matched or
   *  not) carried an empty/whitespace-only accumulated transcript -- read once by the retry
   *  this triggers (`armCloseRetryTimer`/`sendReplyCreate`) so that retry does NOT bump the
   *  diagnostics `attempt` counter (an empty reply "was not really an attempt"), then reset. */
  private closeLastReplyWasEmpty = false;
  /** reply.create fix, round 3 (2026-09-13, PROVEN live failure on deploy 26 -- see
   *  closeMatch.ts's own doc comment for the full incident): every transcript.agent chunk
   *  recorded for a given AAI reply id, concatenated in arrival order -- kept in memory only,
   *  never written to diagnostics (LAW 4: exact-transcript text is evidence-adjacent, not a
   *  fact this class's flight recorder is allowed to carry). `scheduleCloseIfNeeded` is the
   *  only reader: it decides whether the CLOSE sentence was actually spoken from this, never
   *  from which goal a reply was labelled as having been requested for. Entries are never
   *  pruned -- one call's total transcript volume is small and bounded by the session cap. */
  private readonly replyTranscripts = new Map<string, string>();
  /** Round 4: an uncapped running counter of how many times `sendReplyCreate` has actually
   *  asked AssemblyAI to speak the CLOSE goal for this call (the diagnostics `attempt` field)
   *  -- CLOSE_REPLY_ATTEMPTS (a fixed cap of 3) is GONE (that was the bug: it ran out before
   *  a real reply ever landed); this number now exists purely for observability, never to
   *  gate a send. An empty-transcript reply's own retry does not bump it (requirement 8). */
  private closeReplySendCount = 0;
  /** Round 4, requirement 9 (founder correction, 2026-09-14): when the idle reaper's own
   *  `end('idle_timeout')` finds a goodbye still owed (see `end()`'s own doc comment), the
   *  CLOSE hang-up machinery that follows must report the eventual end as `idle_timeout`, not
   *  its own default `agent_closed`/`close_timeout` -- this is the one piece of state that
   *  carries that override across to `beginCloseGrace`/`armClose`'s timeout. Null for every
   *  ordinary (non-idle-deferred) CLOSE. */
  private idleEndReason: string | null = null;
  /** Round 4, requirement 9: set only by `beginIdleNoActionGoodbye` -- a literal close
   *  sentence to speak and match against when the idle reaper ends a call whose verdict is
   *  NO_ACTION. The engine's own `deriveState` (fsm.ts) sends EVERY NO_ACTION verdict to
   *  OUT_OF_SCOPE, never SEALED, so `goal.code` is never really `'CLOSE'` for this case (see
   *  `closeSentence()`'s own doc comment in fsm.ts: NO_ACTION's close line is "kept... for
   *  whichever future lane wires OUT_OF_SCOPE's own close" -- this is that lane, scoped
   *  ONLY to the idle-timeout path, never touching the engine's own state/goal derivation).
   *  `currentCloseSentence()` is the one place this is read; null for every ordinary
   *  (engine-driven) CLOSE. */
  private closeSentenceOverride: string | null = null;
  /** Round 4, requirement 9: `end()` only ever tries the idle-goodbye defer ONCE per call --
   *  guards against re-entering it when the deferred CLOSE machinery itself later calls
   *  `end('idle_timeout')` again to actually finish the job. */
  private idleDeferAttempted = false;
  /** Round 4, requirement 9: the ONE `call_ended` action this class ever logs for a given
   *  `end()` sequence -- `end()`'s idle-defer path and its immediate-end path both need to
   *  log this fact, but only the first one to run should actually push a new entry. Review
   *  fix (2026-09-15, Minor -- FAIL on round 4): kept as a reference to the pushed action
   *  (not just a logged-or-not boolean) so a LATER `end()` call with a DIFFERENT reason (the
   *  idle-deferred goodbye above was still pending when the per-call cap, or a caller
   *  hangup, ended the call for real) can correct the `detail` field in place -- the logged
   *  evidence must read the reason the call ACTUALLY ended under, never a stale, superseded
   *  one, even though only one `call_ended` action is ever recorded (LAW 4 unaffected: this
   *  is a fact about the call's lifecycle, never a verdict). */
  private callEndedAction: AgentAction | null = null;
  /** reply.create fix, round 2 (2026-09-13 review verdict FAIL on round 1, commit 48a0969 --
   *  PROVEN live bug: session 84ddf47a, Miller fraud scenario; see
   *  docs/ASSEMBLYAI_INTEGRATION.md's "VERIFY-AT-BUILD: reply.create schema" section).
   *  Round 1's mistake (Critical 1): it decided whether to force-speak, and what to label a
   *  reply, separately at EVERY individual `applyEvaluate()` call -- of which one `tick()`
   *  can make several (a goal can pass through ANNOUNCE_FROZEN and land on CLOSE in the
   *  same tick, once `runTerminalActionsIfNeeded` settles). Labeling a `reply.started` with
   *  `this.last.goal.code` was then reading whatever the goal had ALREADY become by the
   *  time that reply actually started, not what was requested when the `reply.create` was
   *  sent -- so a reply asked for under ANNOUNCE_FROZEN could get mislabelled CLOSE, which
   *  made `scheduleCloseIfNeeded` arm the hang-up on it and `maybeSendReplyCreateAfterReplyDone`
   *  believe CLOSE had already been spoken, when no `reply.create` for CLOSE had ever gone
   *  out. Round 2's design (simpler, race-proof): decide AT MOST ONCE PER TICK, at the very
   *  end of `tick()` (`maybeSendReplyCreateForTick`), comparing the goal in force at the
   *  START of that tick to the FINAL goal once the whole tick (evaluate + lookups + terminal
   *  actions) has settled -- intermediate goals within one tick are deliberately coalesced
   *  into whatever the tick actually lands on (CLOSE's own verbatim sentence already carries
   *  the outcome; the Friday judge-sim's own passing live runs spoke under CLOSE, never a
   *  separate ANNOUNCE_FROZEN utterance, so this loses nothing a caller would notice).
   *  `pendingRequestedGoal` records exactly what was asked for at send time, and
   *  `reply.started` labels the reply from THAT (not `this.last`) whenever one is
   *  outstanding -- see that case's own comment.
   *
   *  reply.create fix, round 3 (2026-09-13): `scheduleCloseIfNeeded` (the CLOSE hang-up
   *  decision) no longer reads this map at all -- PROVEN live (see closeMatch.ts's own doc
   *  comment), a label only proves a reply.create was SENT, never that AssemblyAI's own reply
   *  actually said what was asked for. This map still backs `maybeSendReplyCreateAfterReplyDone`
   *  (deciding whether a genuinely NEW goal still needs to be spoken at all, e.g. CLOSE was
   *  never yet requested) -- kept for that bookkeeping only. */
  private readonly replyGoalAtStart = new Map<string, GoalCode>();
  /** Set by `sendReplyCreate` to the goal it just asked AssemblyAI to speak, and consumed
   *  (read then cleared) by the very next `reply.started` to label that reply -- see
   *  `replyGoalAtStart`'s own doc comment for why this must NOT be re-derived from
   *  `this.last` at label time. Null whenever no `reply.create` is outstanding. */
  private pendingRequestedGoal: GoalCode | null = null;
  /** True from the moment `sendReplyCreate` actually sends one until the `reply.started`
   *  it asked for arrives. Folded into the same "busy" check both `maybeSendReplyCreateForTick`
   *  and `maybeSendReplyCreateAfterReplyDone` use alongside `this.speaking` -- without this,
   *  a goal change landing before AssemblyAI has even started generating the reply we
   *  already asked for would fire a second, redundant `reply.create` for a reply that has
   *  not begun yet (never two reply.create for the same goal rendering). */
  private replyCreateAwaitingStart = false;

  /** Question-reask fix (2026-09-14, PROVEN live failure -- see `maybeReaskQuestion`'s own
   *  doc comment for the incident): at most QUESTION_REASK_MAX reasks per GOAL RENDERING
   *  (not per call, not per goal code) -- `questionReaskGoalKey` is `JSON.stringify` of the
   *  goal object the counter is currently scoped to (same convention `previousGoalKey`
   *  above already uses to detect "this is the same rendering, not a fresh one"); the
   *  counter resets to 0 the moment that key changes. Lazily read/reset from inside
   *  `maybeReaskQuestion` itself rather than from `applyEvaluate` -- only a QUESTION_GOAL
   *  rendering ever needs to be tracked here at all. */
  private questionReaskGoalKey: string | null = null;
  private questionReaskCount = 0;
  private static readonly QUESTION_REASK_MAX = 2;
  /** Fix (2026-09-16, PROVEN live failure -- deploy 41, scripts/rehearse/reports/
   *  2026-09-16T17-50-00-miller-patient.diagnostics.json): four consecutive
   *  `question_reask_sent` events for the SAME ASK_CHALLENGE rendering (44037, 51207, 58489,
   *  63657) every one logged `"attempt": 0` -- `questionReaskCount` never advanced because
   *  every one of those four replies had a completely EMPTY `replyTranscripts` entry (no
   *  `transcript.agent` event ever arrived for them at all, despite each one producing
   *  `reply.started`/`reply.audio`/`reply.done` -- see this file's own incident notes on
   *  `recordGoalCompletionAction`). The empty-reply forgiveness below (`countAttempt`'s CLOSE
   *  analogue) was designed for a reply that genuinely said nothing; it cannot tell that case
   *  apart from "AssemblyAI never delivered a transcript event for whatever it said", and a
   *  question stuck in the latter state is forgiven FOREVER -- the agent re-asks the same
   *  question indefinitely (29s / 4 replies live before the idle timer, not this mechanism,
   *  finally ended the call), holding the floor and never letting the caller's own turn
   *  resolve. `questionReaskEmptyCount` bounds the FORGIVEN attempts separately from the
   *  counted ones (`questionReaskCount`) so a rendering that never produces a transcript still
   *  gives up after a bounded number of tries, same shape as `MAX_CLOSE_LOST_STREAK` bounds
   *  the CLOSE retry loop for the analogous reason. Reset alongside `questionReaskCount`
   *  whenever the goal rendering itself changes (`maybeReaskQuestion`'s own goalKey check). */
  private questionReaskEmptyCount = 0;
  private static readonly QUESTION_REASK_MAX_EMPTY = 2;
  /** Late-transcript race fix (2026-09-16b): sibling of `CLOSE_TRANSCRIPT_WAIT_MS` (same
   *  1500ms value -- PROVEN live lag is "tens of ms" for CLOSE and a single 856ms sample for
   *  the question-reask path, both comfortably inside this window) for the analogous race on
   *  `maybeReaskQuestion` -- see `questionTranscriptWaitTimer`'s own doc comment for the full
   *  mechanism. A separate named constant, not a shared one, so either wait's duration can be
   *  tuned independently later without coupling the two mechanisms. */
  private static readonly QUESTION_TRANSCRIPT_WAIT_MS = 1_500;
  /** Review fix (2026-09-15, Important -- FAIL on the first cut): the reask used to call
   *  `sendReplyCreate` SYNCHRONOUSLY at `reply.done`, with none of the spacing round 4 gave
   *  the CLOSE retry (`CLOSE_RETRY_MIN_GAP_MS`/`armCloseRetryTimer` above) for exactly the
   *  same reason that spacing exists: an instant `reply.create` right after `reply.done` is
   *  PROVEN (the round-4 live bundles `armCloseRetryTimer`'s own doc comment cites) to
   *  sometimes land on AssemblyAI still mid-turn and come back EMPTY -- and unlike CLOSE's
   *  now-uncapped retries, a reask has only QUESTION_REASK_MAX (2) attempts total, so one
   *  burned on an empty reply is a real loss, not just a wasted round-trip. Fix: reuse the
   *  exact same spacing shape as `armCloseRetryTimer` -- one idempotent timer
   *  (`questionReaskTimer`), armed from `maybeReaskQuestion` instead of sending there
   *  directly, that re-checks every precondition at fire time (not just arm time) and never
   *  bumps `questionReaskCount` for a reply whose accumulated transcript was empty/
   *  whitespace-only (`questionReaskLastReplyWasEmpty`, same convention as CLOSE's own
   *  `closeLastReplyWasEmpty`/`countAttempt`) -- an empty reply still gets retried, spaced,
   *  but for free. `questionReaskArmedGoalKey`/`Code`/`Instructions` snapshot exactly what
   *  was decided at arm time (the goal object, as `JSON.stringify`, plus the already-composed
   *  instructions) so the timer callback can (a) detect a goal change in the interim and
   *  cancel outright -- reasking a STALE question once the caller has moved on would only
   *  confuse them further, same reasoning `maybeReaskQuestion`'s own `replyGoalAtStart` check
   *  already uses -- and (b) send the SAME instructions it decided on, not something
   *  re-derived from a `this.last` that may have changed shape by then. Never two timers
   *  armed at once for the reask itself (the same idempotent-guard shape `armCloseRetryTimer`
   *  uses); a second completed reply arriving before the first's timer fires updates the
   *  snapshot in place (latest reply wins) rather than stacking a second timer, mirroring how
   *  `scheduleCloseIfNeeded` unconditionally refreshes `closeLastReplyWasEmpty` even when
   *  `armCloseRetryTimer` itself is a no-op. A CLOSE retry and a question reask can never be
   *  simultaneously pending in practice -- `armCloseRetryTimer` only ever arms for
   *  `goal.code === 'CLOSE'`, `armQuestionReaskTimer` only for a `QUESTION_GOALS` code
   *  (questionMatch.ts), and the two sets are disjoint by construction -- so this is not a
   *  second guard against the SAME timer slot, just the same spacing shape applied to a
   *  goal-code family CLOSE's own timer never touches. */
  private questionReaskTimer: ReturnType<typeof setTimeout> | null = null;
  private questionReaskArmedGoalKey: string | null = null;
  private questionReaskArmedGoalCode: GoalCode | null = null;
  private questionReaskArmedInstructions: string | null = null;
  private questionReaskLastReplyWasEmpty = false;
  /** Late-transcript race fix (2026-09-16b, Sonnet review of bde7814 -- Important): CLOSE's
   *  own `armCloseTranscriptWait`/`CLOSE_TRANSCRIPT_WAIT_MS` exist because a reply's final
   *  `transcript.agent` chunk routinely lands AT OR AFTER that reply's own `reply.done`
   *  (`CLOSE_TRANSCRIPT_WAIT_MS`'s own doc comment, PROVEN live). `maybeReaskQuestion` reads
   *  `replyTranscripts.get(replyId)` synchronously at `reply.done` too, and was making the
   *  exact same unguarded assumption -- a transcript that has not landed YET but is still on
   *  the wire is indistinguishable, at that instant, from one that will never arrive at all.
   *  PROVEN from 90 bundles (2026-09-14 to 16, 721 replies): 684 transcripts landed inside
   *  the reply window, 1 arrived 856ms after `reply.done`, 36 never arrived -- rare, but the
   *  one late arrival is exactly the shape that gets silently misclassified as empty, and
   *  with `QUESTION_REASK_MAX_EMPTY` now bounding the forgiven count, two such
   *  misclassifications on the SAME rendering exhaust the budget and the challenge is never
   *  actually re-asked, with nothing else left to re-issue it. Fix: `maybeReaskQuestion`
   *  arms `armQuestionTranscriptWait` (below) instead of deciding immediately, but ONLY when
   *  the transcript is EMPTY at `reply.done` time -- a reply whose transcript already has
   *  real (non-matching) content, or already matches the question, decides synchronously as
   *  before (this pair of fields stays unused for that path), so the normal/fast case is not
   *  slowed down at all. `questionTranscriptWaitReplyId` follows the same "latest reply wins"
   *  convention `closeTranscriptWaitReplyId` already uses. */
  private questionTranscriptWaitTimer: ReturnType<typeof setTimeout> | null = null;
  private questionTranscriptWaitReplyId: string | null = null;
  /** Idempotency fix (2026-09-16c, Sonnet review of 4c65ead -- Important): `armCloseTranscriptWait`
   *  is CLOSE's ONLY entry point for arming its wait, so a later reply's own call always
   *  supersedes an earlier one's stale timer for free -- there is no second, wait-free branch
   *  that can leave one dangling. `maybeReaskQuestion` is not shaped that way: its EMPTY branch
   *  goes through `armQuestionTranscriptWait` (which already replaces a stale wait for a
   *  DIFFERENT reply id, same "latest wins" convention), but its synchronous NON-empty branch
   *  decides and arms `armQuestionReaskTimer` directly, without ever touching
   *  `questionTranscriptWaitTimer` at all. PROVEN reachable: reply A ends empty (arms a
   *  1500ms wait); 300ms later reply B, for the SAME still-unanswered rendering, ends with
   *  real, non-empty, non-matching content and takes the synchronous branch --
   *  `questionReaskLastReplyWasEmpty` is correctly set false and B's own reask is sent and
   *  counted. Reply A's wait is still pending throughout; when it fires it re-reads A's own
   *  (still empty) transcript, flips the SHARED `questionReaskLastReplyWasEmpty` flag back to
   *  true, and re-arms `armQuestionReaskTimer` -- either a second, duplicate spoken re-ask (if
   *  B's own send already completed) or a mis-booked budget slot (if B's own timer was still
   *  pending, corrupting the flag it reads at ITS fire time). Fix, mirroring CLOSE's own single-
   *  entry-point shape: every `reply.done` reaching this point for the CURRENT rendering --
   *  empty or not -- first clears any pending wait for a DIFFERENT reply id (it is superseded
   *  the instant a newer reply has its own say) and records itself as `questionReaskLatestReplyId`;
   *  the wait's own callback re-checks that its `replyId` is still that latest id at fire time
   *  and returns silently otherwise -- a defensive second guard, since the `clearTimeout` above
   *  already prevents a superseded wait from ever running its callback at all in this same
   *  single-threaded dispatch model, but it costs nothing to also make the callback itself
   *  provably inert against a future call path that stops clearing eagerly. */
  private questionReaskLatestReplyId: string | null = null;

  /** DEGRADED-TRANSCRIPTS mode (2026-09-16, PROVEN four times live -- scripts/rehearse/
   *  reports/2026-09-16T17-50-00-miller-patient, ...19-31-28-dana-patient,
   *  ...20-51-12-barge-in-interrupt, ...21-02-41-single-wrong-answer, all in the main
   *  checkout, gitignored): after one automatic reply with real audio but no agent
   *  transcript, AssemblyAI can stop delivering agent transcripts for the REST OF THE CALL,
   *  while replies keep starting with audio and caller transcripts keep arriving fine. Pure
   *  bookkeeping about the health of the AGENT-side transcript channel -- never touches the
   *  engine, the verdict (LAW 3), or anything that releases money (LAW 2). This only changes
   *  how THIS class behaves around two existing, already non-verdict-bearing mechanisms (the
   *  question re-ask, and the CLOSE hang-up's own transcript confirmation) -- it never
   *  changes what counts as caller-side evidence and never lets a verified request move past
   *  STAGED on its own.
   *
   *  A "strike" is one reply that had real audio relayed (`replyAudioBytes` > 0 -- AssemblyAI
   *  generated something audible) and never produced a non-empty agent transcript, detected
   *  either (a) at that reply's own `reply.done`, after giving a late transcript chunk the
   *  SAME grace window `armCloseTranscriptWait`/`armQuestionTranscriptWait` already give one
   *  (`DEGRADED_STRIKE_WAIT_MS`, the same 1500ms value -- see `armDegradedStrikeCheck`), or
   *  (b) WHILE STILL IN FLIGHT, if AUDIO HAS STOPPED ARRIVING for `DEGRADED_INFLIGHT_STRIKE_MS`
   *  (12s of INACTIVITY, not 12s of total runtime -- CRITICAL 1 fix, 2026-09-17 review: see
   *  `checkDegradedInflightStrike`'s own doc comment; a reply that keeps streaming real audio
   *  past 12s is never struck just for running long) with no transcript at all (see
   *  `armDegradedInflightStrikeCheck`) -- occurrence 4 above was a single automatic reply that
   *  ran 34 SECONDS with audio and no transcript while the verdict sealed and CLOSE was about
   *  to render; detection that only ever fires at `reply.done` is far too late for a reply
   *  that long. Both paths funnel into
   *  `recordDegradedStrike`, which dedupes by reply id (`repliesCountedAsDegradedStrike`) so
   *  one very long dead reply that eventually also fails its own `reply.done` check is never
   *  double-counted as two strikes.
   *
   *  `DEGRADED_MODE_STRIKE_THRESHOLD` (2) CONSECUTIVE strikes turn the mode on, logging ONE
   *  `transcripts_degraded` diag ({reply_ids, since_t_ms}); the FIRST real (non-empty) agent
   *  transcript received for ANY reply while the mode is on turns it off immediately and logs
   *  `transcripts_recovered` (`noteAgentTranscriptSeen`, called from `transcript.agent`) --
   *  also the same signal that resets an in-progress (sub-threshold) streak back to zero, so
   *  a single bad reply surrounded by healthy ones never accumulates toward the threshold.
   *  Interrupted replies are excluded entirely (a caller barge-in cutting a reply short is an
   *  unrelated, legitimate reason for a missing transcript).
   *
   *  Every counted strike also logs its own `degraded_strike` diag (reply id, whether it was
   *  caught in-flight, and `follows_instructed_reply_done_ms` -- occurrence 4's own follow-on
   *  finding: all four PROVEN occurrences began within 10ms of one of OUR instructed replies'
   *  own `reply.done`, tracked via `lastAnyReplyDoneAtMs`/`lastAnyReplyDoneWasInstructed` and
   *  snapshotted per reply id at its own `reply.started`) -- diagnostics only (LAW 4: never
   *  evidence, never a verdict), so a future analysis of this pattern doesn't require
   *  re-deriving it from raw AAI event timestamps by hand again. */
  private static readonly DEGRADED_MODE_STRIKE_THRESHOLD = 2;
  private static readonly DEGRADED_STRIKE_WAIT_MS = 1_500;
  /** See the class-field doc comment above: 12s, same value and evidence basis as
   *  `CLOSE_REPLY_STUCK_MS` (79 live CLOSE-reply samples, p50 3952ms/p95 9070ms/max 12668ms)
   *  -- ESTIMATE for replies generally (no equivalent non-CLOSE sample exists), chosen as the
   *  best documented ceiling in this codebase for "how long a real, healthy reply runs",
   *  comfortably above it so a long-but-healthy reply is never mistaken for a dead one. */
  private static readonly DEGRADED_INFLIGHT_STRIKE_MS = 12_000;
  private degradedTranscriptsMode = false;
  private degradedStrikeCount = 0;
  private degradedStrikeReplyIds: string[] = [];
  private degradedStreakStartTMs: number | null = null;
  /** One strike per reply id, however it was detected (in-flight or at reply.done) -- see the
   *  class-field doc comment above for why this dedup is necessary (a single very-long dead
   *  reply must never count as two strikes just because both detection paths eventually look
   *  at it). Never pruned -- bounded by the session's own reply count. */
  private readonly repliesCountedAsDegradedStrike = new Set<string>();
  /** Pending strike-check timers (both `armDegradedStrikeCheck` and
   *  `armDegradedInflightStrikeCheck`) -- cleared in bulk by `clearDegradedStrikeTimers`,
   *  called from `end()`. Each callback also re-checks `this.ended` at fire time, so this is
   *  belt-and-braces (no dangling timer can act on an ended call either way), matching the
   *  convention `clearCloseTimers` already sets for every other pending send/wait timer. */
  private readonly degradedStrikeTimers = new Set<ReturnType<typeof setTimeout>>();
  /** Reply ids whose `reply.started` fired while `this.replyCreateAwaitingStart` was true --
   *  i.e. a reply THIS CLASS explicitly asked for via `sendReplyCreate`, not one AssemblyAI
   *  generated on its own turn-driven cadence (see `replyGoalAtStart`'s own doc comment: that
   *  map records the goal a reply was labelled under regardless of who prompted it; this set
   *  narrows to the ones we ourselves instructed). Read by `recordGoalCompletionAction`'s
   *  degraded-mode fallback and the CLOSE audio-confirm path (`armCloseTranscriptWait`) --
   *  both require the reply to be OUR OWN instructed one, never an ambient automatic reply,
   *  before assuming its silence means "spoken but unheard" rather than "never asked at
   *  all". Never pruned -- bounded by the session's own reply count. */
  private readonly instructedReplyIds = new Set<string>();
  /** Occurrence-4 follow-on (see the class-field doc comment above): the server clock time of
   *  the most recently observed `reply.done` (any status), and whether that reply was one of
   *  OUR OWN instructed replies -- read once, synchronously, by the very next `reply.started`
   *  to compute that new reply's own gap into `replyFollowsInstructedDoneMs`. */
  private lastAnyReplyDoneAtMs: number | null = null;
  private lastAnyReplyDoneWasInstructed = false;
  /** Per reply id: milliseconds since the previous reply's own `reply.done`, but ONLY when
   *  that previous reply was one of ours (`lastAnyReplyDoneWasInstructed`) -- null otherwise
   *  (no prior reply.done yet, or the previous one was AssemblyAI's own). Snapshotted once,
   *  at this reply's own `reply.started`, and read later (if this reply goes on to strike) by
   *  `recordDegradedStrike` for the `degraded_strike` diag's `follows_instructed_reply_done_ms`
   *  field. Never pruned -- bounded by the session's own reply count. */
  private readonly replyFollowsInstructedDoneMs = new Map<string, number | null>();

  /** Design E (2026-09-15, turn-order design change -- docs/TEST-PLAN.md "The turn order
   *  design change (E)"): the JSON key (`JSON.stringify(goal)`, same convention
   *  `questionReaskGoalKey`/`previousGoalKey` already use) of the last QUESTION_GOALS
   *  rendering this class has already proactively sent an instructed `reply.create` for.
   *  `mustForceSpeak` alone is CODE-based (correct for CLOSE/ANNOUNCE_*, which only ever
   *  render once) and deliberately does NOT force-speak a same-code re-render (STALL's own
   *  varying holding line, historically left to the caller-turn-driven automatic reply to
   *  pick up). A fresh QUESTION_GOALS rendering under the SAME code (the next challenge, a
   *  new readback field/value) is common -- fsm.ts's own repeated-ASK_CHALLENGE shape -- and,
   *  now that the standing holding-beat rule (prompt.ts's STANDING_RULES) means the automatic
   *  reply can never be relied on to speak the real question any more, this key tracks
   *  "already explicitly asked" per QUESTION_GOALS rendering so `maybeSendReplyCreateForTick`/
   *  `maybeSendReplyCreateAfterReplyDone` send exactly one proactive instructed reply.create
   *  per rendering, not one per tick this same rendering happens to still be current for
   *  (tick() runs on every AAI event, not just caller turns). Null whenever nothing has been
   *  proactively asked yet. */
  private lastAskedQuestionKey: string | null = null;

  /** Design E: the JSON key of a QUESTION_GOALS rendering a CALLER-TURN-TRIGGERED tick found
   *  fresh but could not send proactively because a reply was already in flight
   *  (`this.speaking`/`replyCreateAwaitingStart`) -- the ONLY key
   *  `maybeSendReplyCreateAfterReplyDone` is allowed to catch up on for QUESTION_GOALS. Set by
   *  `maybeSendReplyCreateForTick` the instant it computes a fresh caller-turn-triggered
   *  question, REGARDLESS of whether it goes on to actually send (busy or not); cleared the
   *  moment either method actually sends for that exact key. Without this narrower key (as
   *  opposed to `maybeSendReplyCreateAfterReplyDone` simply re-checking `isFreshQuestionGoal`
   *  unconditionally, which this fix replaces): a fresh QUESTION_GOALS key that emerges from a
   *  NON-caller-turn tick's own internal cascade -- PROVEN reachable, packages/server/test/
   *  design-e-turn-order.test.ts's own "(c)" test, 2026-09-15 -- (fsm.ts can select and render
   *  the engine's own NEXT challenge in the SAME tick a prior reply's `reply.done` logs
   *  `challenge_issued`, before the caller has said anything new; `maybeSendReplyCreateForTick`
   *  correctly defers it, per `tickTriggeredByCallerTurn`'s own doc comment) would otherwise
   *  get caught and sent by a LATER, UNRELATED reply's own `reply.done` -- observed to fire
   *  with STALE `this.last` data (evaluate() has not yet rerun for that event) and, worse, to
   *  set `replyCreateAwaitingStart` right before that SAME event's own trailing `tick()`
   *  discovers CLOSE, silently blocking the real CLOSE `reply.create` behind the busy guard for
   *  the rest of the call. Null whenever nothing caller-turn-triggered is currently owed. */
  private owedQuestionGoalKey: string | null = null;

  /** Design E (2026-09-15): true only for the ONE `tick()` immediately following a
   *  `transcript.user` event -- set by `dispatchAaiEvent`'s own `transcript.user` branch,
   *  consumed and cleared inside `tick()` itself so it can never leak into a LATER, unrelated
   *  tick() call (from a `reply.done`/`tool.call`/etc. event, from `start()`, or from
   *  `recoverFromDispatchError`'s own retry). Scopes `isFreshQuestionGoal`'s force-speak
   *  effect (in `maybeSendReplyCreateForTick` only -- NOT `maybeSendReplyCreateAfterReplyDone`,
   *  whose whole job is catching up a send a caller turn already earned but deferred because a
   *  reply was busy) to genuine caller turns: PROVEN necessary (packages/server/test/
   *  session.test.ts's own debug trace, 2026-09-15) -- without this, an engine tick landing on
   *  a FRESH QUESTION_GOALS key purely because a PRIOR reply's own `reply.done` just logged
   *  `challenge_issued`/`readback_issued` (fsm.ts can select and render the NEXT challenge in
   *  the very same tick, before the caller has said anything new) would fire a second,
   *  back-to-back proactive ask with no caller turn in between -- violating STANDING_RULES's
   *  own "one question at a time" and leaving `replyCreateAwaitingStart` owed against a reply
   *  nothing in the live call is yet generating. Deferring that fresh key to the NEXT tick that
   *  IS caller-turn-triggered (`isFreshQuestionGoal` itself never resets -- the key is simply
   *  still fresh next time this flag is true) asks it exactly once, still without ever losing
   *  it. */
  private tickTriggeredByCallerTurn = false;

  /** BRAKE (2026-09-15, e-followup task, PROVEN live: fragment-analysis.md sections A/C --
   *  see `shouldBrakeFreshQuestion`'s own doc comment for the full incident and design). How
   *  close together (ms) two CONSECUTIVE caller transcript events have to land for the second
   *  to be treated as a likely continuation of the first's own sentence rather than a genuine
   *  new turn. ESTIMATE, labelled: derived from the PROVEN 2.1-2.3s gaps measured across three
   *  live bundles (fragment-analysis.md section A) where AssemblyAI's own endpointer split one
   *  scripted line into two `transcript.user` events -- 2500ms gives real margin above the
   *  measured range without being so wide it would swallow a caller's own genuine fast
   *  two-beat answer (the "6s apart yield two as today" test case is well clear of it). */
  private static readonly QUESTION_FRAGMENT_WINDOW_MS = 2_500;

  /** BRAKE: true once a caller transcript fragment that `looksLikeAnswerAttempt` has arrived
   *  since the CURRENT `lastAskedQuestionKey` was actually sent -- reset to false every time a
   *  fresh instructed question is sent (both `maybeSendReplyCreateForTick`'s immediate branch
   *  and `maybeSendReplyCreateAfterReplyDone`'s catch-up branch, the only two places
   *  `lastAskedQuestionKey` is ever updated). Read only by `shouldBrakeFreshQuestion`: once
   *  true, the brake never re-applies for the CURRENTLY pending instructed question, even if a
   *  later fragment lands close to the one that set this -- see that method's own doc comment
   *  for why content, once seen, always outranks timing (test: "a fragment that IS an answer
   *  ... proceeds as today"). */
  private pendingQuestionAnswerAttemptSeen = false;

  /** BRAKE: the `t_ms` (server clock, `nowT()`) of the most recently logged CALLER
   *  utterance, captured the instant BEFORE the current one is appended in
   *  `dispatchAaiEvent`'s `transcript.user` case -- i.e. always the fragment immediately
   *  PRECEDING whichever one is about to trigger this tick. Null before the call's first
   *  caller utterance, or once nothing is left to compare against. Kept as its own field
   *  (rather than re-deriving from `this.logs.conversation` on every check) so the "previous"
   *  side of the comparison is always exactly the fragment that came before the one currently
   *  being processed, never re-computed after a LATER fragment has already been appended. */
  private previousCallerTranscriptAtMs: number | null = null;

  /** BRAKE (2026-09-15, e-followup task -- see scratchpad/fragment-analysis.md sections A/C
   *  and D(3), the design E follow-up task this closes): PROVEN live (a fresh sample against
   *  deploy 39, six calls, and the 08-56-33-miller-silent-after-amount bundle specifically): a
   *  mid-sentence pause splits ONE caller line into two AssemblyAI `transcript.user` turns
   *  2.1-2.3s apart; each fragment is its own caller-turn tick, and once the engine has moved
   *  the current goal to a DIFFERENT question (fsm.ts's own `selectChallenge` advances the
   *  instant a challenge is confirmed ASKED, independent of whether it was ever answered --
   *  see the analysis doc's section B/C), the SECOND fragment alone was enough for
   *  `maybeSendReplyCreateForTick`'s existing freshQuestion path to proactively ask that new
   *  question immediately -- three questions asked in 17s on one live bundle, an engine-lane
   *  bug (fragment-analysis.md option (1), a DIFFERENT worktree/lane) compounded by this
   *  server sending as fast as the engine hands it something fresh.
   *
   *  This is the independent SERVER-side brake (fragment-analysis.md option (3), recommended
   *  alongside, not instead of, the engine-lane fix): true when ALL of --
   *   1. there IS a previous instructed question already asked (`lastAskedQuestionKey` is not
   *      null) -- nothing to brake against for the call's very first question;
   *   2. it is still UNANSWERED -- no caller fragment since it was sent has looked like an
   *      answer attempt (`pendingQuestionAnswerAttemptSeen` is false; see
   *      `looksLikeAnswerAttempt`'s own doc comment for why content always wins over timing);
   *   3. the fragment that triggered THIS tick landed within `QUESTION_FRAGMENT_WINDOW_MS` of
   *      the one immediately before it (`previousCallerTranscriptAtMs`) -- the fragmentation
   *      signature itself.
   *  Deliberately scoped to `maybeSendReplyCreateForTick`'s IMMEDIATE (caller-turn-triggered)
   *  send only, never `maybeSendReplyCreateAfterReplyDone`'s catch-up path: braking there too
   *  would re-check the SAME now-stale fragment-gap forever once the caller falls silent
   *  waiting for the very question this brake is holding back -- a real deadlock risk (the
   *  gap between two already-logged utterances never shrinks just because time passes with no
   *  THIRD fragment arriving). Suppressing only the immediate send, while leaving
   *  `owedQuestionGoalKey` set exactly as the ordinary busy-deferral case already does,
   *  reuses the EXISTING catch-up mechanism unmodified: the very next reply.done (typically
   *  the fragment's own automatic reply finishing, seconds away, never bounded by this
   *  brake's own window) delivers the owed question once, "on the next genuine turn," per the
   *  task's own framing -- no new timer needed. */
  private shouldBrakeFreshQuestion(): boolean {
    if (this.lastAskedQuestionKey === null) return false;
    if (this.pendingQuestionAnswerAttemptSeen) return false;
    if (this.previousCallerTranscriptAtMs === null) return false;
    const gap = this.nowT() - this.previousCallerTranscriptAtMs;
    return gap <= CallSession.QUESTION_FRAGMENT_WINDOW_MS;
  }

  /** Design E: the one-shot `reply.create.instructions` text for a QUESTION_GOALS `goal` --
   *  the exact sentence the caller must hear, wrapped the same "say exactly this and nothing
   *  else" way prompt.ts's own READBACK / ELICIT_MISSING_CRITICAL / RE_ELICIT_AFTER_SWITCH
   *  cases already render into `system_prompt` (never re-derived independently, so the
   *  instructed reply and the standing prompt can never disagree on wording). For a
   *  QUESTION_GOALS code with no single verbatim sentence (`verbatimQuestionSentence` returns
   *  null for ELICIT_IDENTITY/PROBE_CONSISTENCY/ELICIT_REQUEST -- their `hint` is a
   *  paraphrase instruction, not a line a person would say), falls back to the same
   *  paraphrase-instruction wrapper `maybeReaskQuestion` already used before this fix (now
   *  shared, not duplicated, between the proactive send and the reactive reask).
   *
   *  P0 fix (2026-09-18, PROVEN live from three founder calls the same morning plus a harness
   *  bundle, all under scripts/rehearse/reports/ -- see close-attempt1-instructions.test.ts's
   *  own header comment): CLOSE now ALSO gets a one-shot wrapper here, the exact same "say
   *  exactly this" text `armCloseRetryTimer`'s close_retry already sends
   *  (`currentCloseSentence()`'s CLOSE branch and this one read the identical `goal.hint`, so
   *  they can never disagree). Before this fix, CLOSE's tick_end send (attempt 1, from
   *  `maybeSendReplyCreateForTick`) went out BARE, relying solely on the standing
   *  `system_prompt` from the `session.update` this same tick just sent -- proven live to be
   *  sent in the SAME millisecond as the reply.create that follows it (case 5's own
   *  diagnostics: `session_config_updated` CLOSE and `reply_create_sent` tick_end both at
   *  t=78125), too fast for AssemblyAI to reliably have applied it yet (docs/TEST-PLAN.md:
   *  "system_prompt applies on the next turn"). With no instructions to fall back on,
   *  attempt 1 composed under whatever context it still had and, in every live/harness record
   *  gathered 2026-09-18, never said the close line -- only the WRAPPED close_retry did. This
   *  closes that race by giving attempt 1 the same one-shot override the retry always had;
   *  CLOSE's own tail-wait/transcript-wait/stuck-watchdog machinery is unchanged (it keys off
   *  reply id and transcript content, never off whether `instructions` was sent). Still
   *  undefined for every other non-QUESTION_GOALS code (ANNOUNCE_*, STALL, CONTAIN*, GREET) --
   *  none of those has a single verbatim sentence to wrap. */
  private instructedSentenceFor(goal: PhrasingGoal): string | undefined {
    if (goal.code === 'CLOSE') {
      return `Say exactly this and nothing else: "${goal.hint}"`;
    }
    if (!QUESTION_GOALS.has(goal.code)) return undefined;
    const sentence = verbatimQuestionSentence(goal);
    return sentence
      ? `Say exactly this and nothing else: "${sentence}"`
      : `Ask the caller this question now, in one sentence: ${goal.hint}`;
  }

  /** Design E: true when `goal` is a QUESTION_GOALS rendering this class has not yet
   *  proactively asked (its own JSON key differs from `lastAskedQuestionKey`) -- see that
   *  field's own doc comment for why this is a NECESSARY addition to `mustForceSpeak`'s
   *  CODE-based check, not a replacement for it. Never true for CLOSE, ANNOUNCE_*, STALL, etc:
   *  those stay exactly as `mustForceSpeak` alone already decided before this fix. */
  private isFreshQuestionGoal(goal: PhrasingGoal): boolean {
    if (!QUESTION_GOALS.has(goal.code)) return false;
    return JSON.stringify(goal) !== this.lastAskedQuestionKey;
  }

  /** DEGRADED-TRANSCRIPTS mode: called once, from `transcript.agent`, whenever the chunk just
   *  recorded is non-empty -- proof the agent-transcript channel is (still, or again) alive.
   *  Resets an in-progress (sub-threshold) strike streak back to zero regardless of whether
   *  the mode was ever actually on, and turns the mode off (logging `transcripts_recovered`
   *  exactly once) if it was. */
  private noteAgentTranscriptSeen(replyId: string): void {
    this.degradedStrikeCount = 0;
    this.degradedStrikeReplyIds = [];
    this.degradedStreakStartTMs = null;
    if (this.degradedTranscriptsMode) {
      this.degradedTranscriptsMode = false;
      this.diag('transcripts_recovered', { reply_id: replyId });
    }
  }

  /** DEGRADED-TRANSCRIPTS mode: the single place a strike is actually counted, from either
   *  `armDegradedStrikeCheck` (at reply.done, after the late-transcript wait) or
   *  `armDegradedInflightStrikeCheck` (while still in flight, past
   *  DEGRADED_INFLIGHT_STRIKE_MS) -- see the class-field doc comment above
   *  `DEGRADED_MODE_STRIKE_THRESHOLD` for the dedup guarantee and the diag shapes. */
  private recordDegradedStrike(replyId: string, detail: { in_flight: boolean; reason?: string }): void {
    if (this.repliesCountedAsDegradedStrike.has(replyId)) return; // one strike per reply, however it was caught
    this.repliesCountedAsDegradedStrike.add(replyId);
    if (this.degradedStrikeCount === 0) this.degradedStreakStartTMs = this.nowT();
    this.degradedStrikeCount += 1;
    this.degradedStrikeReplyIds.push(replyId);
    this.diag('degraded_strike', {
      reply_id: replyId,
      in_flight: detail.in_flight,
      // Fix B (2026-09-17, deploy 45 live finding, record 2026-09-17T08-35-38-dana-patient):
      // `reason` distinguishes WHICH detector caught this strike -- undefined for the two
      // pre-existing paths (armDegradedStrikeCheck's reply.done wait, and
      // checkDegradedInflightStrike's audio-inactivity check), 'max_audio_only' for
      // `armDegradedMaxAudioOnlyCheck` below (a reply that never went quiet long enough to
      // trip the inactivity check, but ran with audio and no transcript past an absolute
      // ceiling). Omitted (not `null`) when absent, so the existing tests' `toMatchObject`
      // assertions against this diag's shape are unaffected.
      ...(detail.reason ? { reason: detail.reason } : {}),
      follows_instructed_reply_done_ms: this.replyFollowsInstructedDoneMs.get(replyId) ?? null,
      strike_count: this.degradedStrikeCount,
    });
    if (this.degradedTranscriptsMode) return; // already on -- nothing more to log
    if (this.degradedStrikeCount < CallSession.DEGRADED_MODE_STRIKE_THRESHOLD) return;
    this.degradedTranscriptsMode = true;
    this.diag('transcripts_degraded', {
      reply_ids: [...this.degradedStrikeReplyIds],
      since_t_ms: this.degradedStreakStartTMs,
    });
  }

  /** DEGRADED-TRANSCRIPTS mode, path (a): armed from `reply.done` for every COMPLETED reply
   *  that had real audio relayed -- gives a late transcript chunk the SAME grace window
   *  `armCloseTranscriptWait`/`armQuestionTranscriptWait` already give one
   *  (`DEGRADED_STRIKE_WAIT_MS`, 1500ms) before concluding this reply really produced none.
   *  Deliberately reads live state at fire time (never a snapshot): if this same reply's
   *  transcript arrived (via `noteAgentTranscriptSeen`) or `repliesWithDone`/`ended` says
   *  there's nothing left to check, this is a no-op. Runs independently of, and never blocks
   *  or delays, the CLOSE/QUESTION_GOALS-specific wait mechanisms already checking the exact
   *  same transcript for their own, unrelated reasons. */
  private armDegradedStrikeCheck(replyId: string): void {
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      this.degradedStrikeTimers.delete(timer);
      if (this.ended) return;
      const transcript = this.replyTranscripts.get(replyId) ?? '';
      if (transcript.trim().length > 0) return; // arrived within the wait -- healthy, no strike
      this.recordDegradedStrike(replyId, { in_flight: false });
    }, CallSession.DEGRADED_STRIKE_WAIT_MS);
    timer.unref?.();
    this.degradedStrikeTimers.add(timer);
  }

  /** DEGRADED-TRANSCRIPTS mode, path (b) (occurrence 4, 2026-09-16T21-02-41-single-wrong-
   *  answer, PROVEN: a single automatic reply ran 34 SECONDS with audio and no transcript
   *  while the verdict sealed and CLOSE rendered): armed from the FIRST relayed audio frame
   *  of every reply (`reply.audio`'s own `reply.audio.first` bookkeeping) -- catches a reply
   *  that is still running, well before its own (possibly very distant) `reply.done` would
   *  ever let `armDegradedStrikeCheck` see it.
   *
   *  CRITICAL 1 fix (2026-09-17 review of e7ba96f): this used to fire ONCE, unconditionally,
   *  DEGRADED_INFLIGHT_STRIKE_MS after the reply's own FIRST audio frame -- so a real, healthy
   *  reply that keeps streaming audio well past that point (the observed live max CLOSE-reply
   *  duration is 12,668ms, per `CLOSE_REPLY_STUCK_MS`'s own 79-sample doc comment; nothing
   *  stops an ordinary non-CLOSE reply from running that long too) would strike on continued,
   *  healthy audio alone -- exactly backwards from this mode's whole purpose (catching DEAD
   *  air, not long replies). Fixed to measure audio INACTIVITY instead, mirroring
   *  `checkCloseReplyStuck`/`CLOSE_REPLY_STUCK_MS` (below) exactly: `armDegradedInflightStrikeCheck`
   *  now only ever arms the FIRST check, at `DEGRADED_INFLIGHT_STRIKE_MS` from the first frame;
   *  `checkDegradedInflightStrike` is the idempotent check itself, re-arming for the REMAINING
   *  time whenever `lastReplyAudioAt` (updated on every `reply.audio` frame, for ANY reply --
   *  see that field's own doc comment) shows audio arrived more recently than the full window,
   *  and only striking once the full window has passed with no new frame at all. */
  private armDegradedInflightStrikeCheck(replyId: string): void {
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      this.degradedStrikeTimers.delete(timer);
      this.checkDegradedInflightStrike(replyId);
    }, CallSession.DEGRADED_INFLIGHT_STRIKE_MS);
    timer.unref?.();
    this.degradedStrikeTimers.add(timer);
  }

  /** CRITICAL 1 fix: the idempotent in-flight check itself -- see
   *  `armDegradedInflightStrikeCheck`'s own doc comment for the full incident and design.
   *  Guards, in order: call ended; this reply already reached its own `reply.done`
   *  (`armDegradedStrikeCheck` alone owns it from there -- `recordDegradedStrike`'s own dedup
   *  makes this belt-and-braces, not load-bearing); superseded by a newer reply
   *  (`currentReplyId`); already has a real transcript (healthy, nothing to check further).
   *  Only then does it look at audio inactivity: `lastAudioAge` under the full window
   *  re-arms for the remaining time (exactly `checkCloseReplyStuck`'s own shape); the full
   *  window elapsed with no new frame is what actually strikes. */
  private checkDegradedInflightStrike(replyId: string): void {
    if (this.ended) return;
    if (this.repliesWithDone.has(replyId)) return; // finished already -- the reply.done path owns it
    if (this.currentReplyId !== replyId) return; // superseded by a newer reply -- stale check
    const transcript = this.replyTranscripts.get(replyId) ?? '';
    if (transcript.trim().length > 0) return; // healthy

    const now = this.opts.now();
    const lastAudioAge = this.lastReplyAudioAt !== null ? now - this.lastReplyAudioAt : Infinity;
    if (lastAudioAge < CallSession.DEGRADED_INFLIGHT_STRIKE_MS) {
      const remainingMs = CallSession.DEGRADED_INFLIGHT_STRIKE_MS - lastAudioAge;
      const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
        this.degradedStrikeTimers.delete(timer);
        this.checkDegradedInflightStrike(replyId);
      }, remainingMs);
      timer.unref?.();
      this.degradedStrikeTimers.add(timer);
      return;
    }

    this.recordDegradedStrike(replyId, { in_flight: true });
  }

  /** DEGRADED-TRANSCRIPTS mode, path (c) (Fix B, 2026-09-17, PROVEN live -- deploy 45, record
   *  scripts/rehearse/reports/2026-09-17T08-35-38-dana-patient, main checkout, gitignored): an
   *  automatic reply streamed audio CONTINUOUSLY from 111.3s to 179.1s (68s), never once going
   *  quiet for `DEGRADED_INFLIGHT_STRIKE_MS` (12s) at a stretch, and produced no transcript at
   *  all -- `checkDegradedInflightStrike`'s own audio-INACTIVITY design (by construction) never
   *  fires for a reply that keeps streaming real frames on schedule; inactivity alone cannot
   *  catch a reply that is unhealthy in a DIFFERENT way (real audio, forever, no transcript).
   *
   *  `DEGRADED_MAX_AUDIO_ONLY_MS` is a second, independent, ABSOLUTE ceiling measured from the
   *  reply's own FIRST relayed audio frame (`reply.audio.first`) -- unlike the inactivity
   *  check, this timer is armed exactly ONCE per reply and never re-armed/reset by further
   *  audio frames arriving on schedule. 20s, chosen with real margin above the longest
   *  legitimate TRANSCRIBED reply this codebase has measured (`CLOSE_REPLY_STUCK_MS`'s own
   *  79-sample max of 12,668ms) -- a real, healthy, fully-transcribed reply is never this long
   *  with nothing to show for it.
   *
   *  Armed alongside `armDegradedInflightStrikeCheck`, from the exact same `reply.audio.first`
   *  call site. Guards mirror `checkDegradedInflightStrike`'s own (already finished via
   *  `repliesWithDone`, superseded by a newer reply via `currentReplyId`, already has a real
   *  transcript): only when NONE of those apply does this record a strike
   *  (`recordDegradedStrike`, `in_flight: true`, `reason: 'max_audio_only'`) -- deduped by the
   *  same per-reply set every other strike path already shares, so a reply already struck by
   *  the inactivity path (or one that finishes normally and strikes at its own reply.done) is
   *  never double-counted. Cleared explicitly (never left to fire against a reply that has
   *  moved on) at that SAME reply's own `reply.done`, at the first real (non-empty) transcript
   *  chunk for it, and at `end()` -- see `clearDegradedMaxAudioOnlyTimer`'s own call sites. */
  private static readonly DEGRADED_MAX_AUDIO_ONLY_MS = 20_000;
  private degradedMaxAudioOnlyTimer: ReturnType<typeof setTimeout> | null = null;
  private degradedMaxAudioOnlyReplyId: string | null = null;

  private armDegradedMaxAudioOnlyCheck(replyId: string): void {
    this.clearDegradedMaxAudioOnlyTimer();
    this.degradedMaxAudioOnlyReplyId = replyId;
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      this.degradedStrikeTimers.delete(timer);
      this.degradedMaxAudioOnlyTimer = null;
      this.degradedMaxAudioOnlyReplyId = null;
      if (this.ended) return;
      if (this.repliesWithDone.has(replyId)) return; // finished already -- the reply.done path owns it
      if (this.currentReplyId !== replyId) return; // superseded by a newer reply -- stale check
      const transcript = this.replyTranscripts.get(replyId) ?? '';
      if (transcript.trim().length > 0) return; // healthy
      this.recordDegradedStrike(replyId, { in_flight: true, reason: 'max_audio_only' });
    }, CallSession.DEGRADED_MAX_AUDIO_ONLY_MS);
    timer.unref?.();
    this.degradedStrikeTimers.add(timer);
    this.degradedMaxAudioOnlyTimer = timer;
  }

  /** Cancels the pending max-audio-only check for whichever reply it is currently watching, if
   *  any -- called from that reply's own `reply.done`, from the first real transcript chunk
   *  recorded for it, and from `end()` (via `clearDegradedStrikeTimers`, below). A no-op when
   *  nothing is pending, or when a DIFFERENT reply's own transcript/reply.done fires (only the
   *  reply this timer is currently watching can clear it -- matches `armDegradedMaxAudioOnlyCheck`'s
   *  own "one at a time" shape, since only one reply is ever in flight). */
  private clearDegradedMaxAudioOnlyTimer(replyId?: string): void {
    if (!this.degradedMaxAudioOnlyTimer) return;
    if (replyId !== undefined && this.degradedMaxAudioOnlyReplyId !== replyId) return;
    clearTimeout(this.degradedMaxAudioOnlyTimer);
    this.degradedStrikeTimers.delete(this.degradedMaxAudioOnlyTimer);
    this.degradedMaxAudioOnlyTimer = null;
    this.degradedMaxAudioOnlyReplyId = null;
  }

  /** Cancels every pending strike-check timer (both paths) -- called once, from `end()`.
   *  Belt-and-braces only: each callback already re-checks `this.ended` at fire time, so a
   *  timer left uncleared could never act on a call that has already ended either way. */
  private clearDegradedStrikeTimers(): void {
    for (const timer of this.degradedStrikeTimers) clearTimeout(timer);
    this.degradedStrikeTimers.clear();
    this.degradedMaxAudioOnlyTimer = null;
    this.degradedMaxAudioOnlyReplyId = null;
  }

  private clearCloseTimers(): void {
    if (this.closeGraceTimer) {
      clearTimeout(this.closeGraceTimer);
      this.closeGraceTimer = null;
    }
    if (this.closeHardCapTimer) {
      clearTimeout(this.closeHardCapTimer);
      this.closeHardCapTimer = null;
    }
    if (this.closeRetryTimer) {
      clearTimeout(this.closeRetryTimer);
      this.closeRetryTimer = null;
    }
    if (this.replyCreateLostTimer) {
      clearTimeout(this.replyCreateLostTimer);
      this.replyCreateLostTimer = null;
    }
    if (this.closeDoneWaitTimer) {
      clearTimeout(this.closeDoneWaitTimer);
      this.closeDoneWaitTimer = null;
    }
    if (this.closeStuckTimer) {
      clearTimeout(this.closeStuckTimer);
      this.closeStuckTimer = null;
    }
    if (this.closeTranscriptWaitTimer) {
      clearTimeout(this.closeTranscriptWaitTimer);
      this.closeTranscriptWaitTimer = null;
      this.closeTranscriptWaitReplyId = null;
    }
    // Review fix (2026-09-15): the question-reask spacing timer is not CLOSE-specific, but
    // this is the one method every ending path (`end()`) already funnels through to clear
    // every other pending send timer -- same reasoning as `replyCreateLostTimer` above.
    if (this.questionReaskTimer) {
      clearTimeout(this.questionReaskTimer);
      this.questionReaskTimer = null;
    }
    // Late-transcript race fix (2026-09-16b): same reasoning as `questionReaskTimer` just
    // above -- this is not CLOSE-specific either, but `end()` already funnels every pending
    // send/wait timer through here.
    if (this.questionTranscriptWaitTimer) {
      clearTimeout(this.questionTranscriptWaitTimer);
      this.questionTranscriptWaitTimer = null;
      this.questionTranscriptWaitReplyId = null;
    }
  }

  /** The close sentence currently owed, if any. Review fix (2026-09-15, Critical -- FAIL on
   *  round 4): the ENGINE's own rendered CLOSE goal ALWAYS wins over `closeSentenceOverride`
   *  (idle+NO_ACTION, requirement 9) -- checking the override first meant a caller who
   *  resumed with a real request after the idle-goodbye was already armed, but before it was
   *  ever confirmed, kept getting matched against the stale "Thank you for calling.
   *  Goodbye." line instead of the engine's fresh ESCALATE/STAGE/FREEZE sentence, burning the
   *  whole 45s budget even though the correct line was actually spoken. `applyEvaluate`
   *  clears `closeSentenceOverride` (and `idleEndReason`) the moment the engine renders a
   *  genuinely fresh CLOSE while an override was pending, so in practice the two are never
   *  simultaneously relevant for long -- this ordering is what's actually authoritative
   *  between the tick that renders a fresh CLOSE and the (synchronous, same-tick) clearing.
   *  The one thing every CLOSE-hang-up method (`scheduleCloseIfNeeded`,
   *  `maybeArmCloseOnTranscript`, `armCloseRetryTimer`) checks before doing anything, so
   *  neither path needs its own copy of "is a goodbye owed right now, and what does it say." */
  private currentCloseSentence(): string | null {
    if (this.last?.goal.code === 'CLOSE') return this.last.goal.hint;
    // Guard (P1 fix, 2026-09-14, structuring-two-wires bundle): `closeSentenceOverride` is
    // ONLY ever the generic NO_ACTION line ("Thank you for calling. Goodbye.",
    // `beginIdleNoActionGoodbye`'s own doc comment) -- it must never stand in for a REAL
    // goodbye once a STAGE/FREEZE/ESCALATE verdict has been sealed. In practice this branch
    // is unreachable for a sealed terminal verdict now that `evaluate` itself holds the
    // sealed verdict/state/goal forever (packages/engine/src/evaluate.ts's `freezeAtSeal`):
    // `deriveState` (fsm.ts) locks state to SEALED and `phrasingGoal`'s SEALED branch always
    // renders goal.code 'CLOSE', so the branch above always wins for the whole rest of the
    // call. Kept as an explicit assertion rather than silent trust in that invariant holding
    // everywhere this method is ever called from.
    if (this.last && this.last.verdict !== 'NO_ACTION' && this.last.state === 'SEALED') return null;
    return this.closeSentenceOverride;
  }

  /** Round 4, requirement 9 (founder correction, 2026-09-14): the idle reaper's own
   *  `end('idle_timeout')` found the verdict is NO_ACTION once `call_ended` was logged --
   *  the engine's `deriveState` (fsm.ts) always sends NO_ACTION to OUT_OF_SCOPE, never
   *  SEALED, so there is no engine-rendered CLOSE goal to piggyback on here (see
   *  `closeSentenceOverride`'s own doc comment). Speaks the exact same "Thank you for
   *  calling. Goodbye." line `fsm.ts`'s own `closeSentence()` default case defines for
   *  NO_ACTION (copied verbatim, grepped 2026-09-14 -- same convention closeMatch.ts's
   *  `ENGINE_CLOSE_SENTENCES.NO_ACTION` already uses), via the exact same one-shot
   *  "say exactly this" wrapper every other close_retry uses, then reuses the SAME
   *  transcript-confirmed hang-up machinery (`scheduleCloseIfNeeded`/
   *  `maybeArmCloseOnTranscript`/`armCloseRetryTimer`/`beginCloseGrace`) and the SAME
   *  CLOSE_TOTAL_MS absolute backstop (`armClose`) -- nothing new about HOW the goodbye is
   *  confirmed or the call ends, only that `closeSentenceOverride` (not an engine-rendered
   *  CLOSE goal) is what supplies the sentence to match against. */
  private beginIdleNoActionGoodbye(): void {
    if (this.ended) return;
    this.closeSentenceOverride = 'Thank you for calling. Goodbye.';
    this.armClose();
    if (this.speaking || this.replyCreateAwaitingStart) return; // the in-flight reply's own reply.done/transcript will pick this up
    const wrapper = `Say exactly this and nothing else: "${this.closeSentenceOverride}"`;
    this.sendReplyCreate('CLOSE', 'idle_no_action_close', wrapper);
  }

  /** Called once, the first tick the goal becomes CLOSE (from `applyEvaluate`'s goal-changed
   *  branch): arms the CLOSE_TOTAL_MS (45s, round 4) hard cap in case no reply.done for the
   *  real close line ever arrives AND no transcript match is ever heard either (a dropped AAI
   *  reply, a model that never speaks at all). Idempotent via the hard-cap-timer guard: a
   *  second call while one is already pending is a no-op, so a goal that briefly changes away
   *  from CLOSE and back (not possible today -- SEALED is a one-way state -- but defensive
   *  regardless) is harmless. Round 4, requirement 9: the eventual end reason reads
   *  `idleEndReason` when the idle reaper is what set this whole CLOSE sequence in motion. */
  private armClose(): void {
    if (this.closeHardCapTimer || this.ended) return;
    this.closeHardCapTimer = setTimeout(() => {
      this.closeHardCapTimer = null;
      if (!this.ended) this.end(this.idleEndReason ?? 'close_timeout');
    }, CallSession.CLOSE_TOTAL_MS);
    this.closeHardCapTimer.unref?.();
  }

  /** Starts (or no-ops if already started) the final CLOSE_GRACE_MS countdown to actually
   *  hanging up -- the one place that decides the call is DONE talking, whether that
   *  conclusion came from a matching `reply.done` (`scheduleCloseIfNeeded`) or from the close
   *  sentence already being heard mid-reply (`maybeArmCloseOnTranscript`'s
   *  CLOSE_DONE_WAIT_MS timeout, round 4 requirement 7). Cancels the hard cap (nothing left
   *  to time out) and any still-pending `closeDoneWaitTimer` (whichever path got here first
   *  wins; the other's own pending timer, if any, is now moot). The grace-timer guard itself
   *  makes this safe to call more than once for the same reply. */
  private beginCloseGrace(): void {
    if (this.ended) return;
    if (this.closeGraceTimer) return;
    // Defect A fix (2026-09-15): the hard cap is deliberately left running here (it used to
    // be cleared the instant grace began) -- the audio-aware delay computed below can now be
    // LONGER than the old fixed CLOSE_GRACE_MS, and CLOSE_TOTAL_MS must still be the one
    // absolute backstop that wins if that stretches the call past the 45s budget (requirement
    // "still capped by CLOSE_TOTAL_MS"). Whichever timer's callback runs first calls `end()`,
    // which clears the other one via `clearCloseTimers()` -- never a double end.
    if (this.closeDoneWaitTimer) {
      clearTimeout(this.closeDoneWaitTimer);
      this.closeDoneWaitTimer = null;
    }
    if (this.closeRetryTimer) {
      clearTimeout(this.closeRetryTimer);
      this.closeRetryTimer = null;
    }
    if (this.closeTranscriptWaitTimer) {
      clearTimeout(this.closeTranscriptWaitTimer);
      this.closeTranscriptWaitTimer = null;
      this.closeTranscriptWaitReplyId = null;
    }

    // Defect A fix: size the wait to the goodbye's own estimated playback length instead of a
    // flat CLOSE_GRACE_MS regardless of how much audio there was to play. `replyId` is the
    // CONFIRMED goodbye reply (`goodbyeConfirmedReplyId`, always set before this method is
    // ever called from `scheduleCloseIfNeeded`/`maybeArmCloseOnTranscript`/
    // `armCloseTranscriptWait`) -- its own relayed byte count and first-relayed-frame
    // timestamp are what `dispatchAaiEvent`'s `reply.audio` case records. No audio recorded
    // at all (bytes === 0, e.g. every existing transcript-only test fixture, or a genuinely
    // silent reply) falls back to the unchanged flat CLOSE_GRACE_MS -- today's timing exactly.
    const replyId = this.goodbyeConfirmedReplyId;
    const bytes = replyId ? (this.replyAudioBytes.get(replyId) ?? 0) : 0;
    const firstAudioAt = replyId ? (this.replyFirstAudioAt.get(replyId) ?? null) : null;
    const now = this.opts.now();
    const audioSeconds = bytes / CallSession.OUTPUT_AUDIO_BYTES_PER_SECOND;
    let delayMs = CallSession.CLOSE_GRACE_MS;
    if (firstAudioAt !== null && bytes > 0) {
      // max(reply.done/confirmation-time + CLOSE_GRACE_MS, first_audio_relayed_at +
      // audio_seconds + CLOSE_AUDIO_TAIL_BUFFER_MS) -- `now` stands in for "reply.done" (this
      // method runs synchronously from that event in the normal case; in the
      // transcript-confirmed-before-reply.done fallback it is the confirming event's own
      // time, which is the closest available proxy).
      const graceBasedDeadline = now + CallSession.CLOSE_GRACE_MS;
      const audioBasedDeadline = firstAudioAt + audioSeconds * 1000 + CallSession.CLOSE_AUDIO_TAIL_BUFFER_MS;
      delayMs = Math.max(0, Math.max(graceBasedDeadline, audioBasedDeadline) - now);
    }
    this.diag('close_tail_wait', { audio_seconds: audioSeconds, waited_ms: delayMs });

    this.closeGraceTimer = setTimeout(() => {
      this.closeGraceTimer = null;
      if (!this.ended) this.end(this.idleEndReason ?? 'agent_closed');
    }, delayMs);
    this.closeGraceTimer.unref?.();
  }

  /** Round 4, requirement 7 (founder correction, 2026-09-14, three further PROVEN live
   *  bundles -- scripts/rehearse/reports/2026-09-14T13-45-58-dana-patient,
   *  T13-58-08-structuring-two-wires, T13-49-05-identity-switch .diagnostics.json): in all
   *  three, the close_retry reply actually SPOKE the full close sentence (Dana: a 127-char
   *  transcript.agent matching the whole STAGE sentence) but no `reply.done` ever arrived for
   *  it before the (then-15s) hard cap ended the call `close_timeout` -- the goodbye was
   *  heard, but the hang-up never armed because the old design only ever armed it from
   *  `reply.done`. Called from every `transcript.agent` event (see `dispatchAaiEvent`): the
   *  instant the accumulated transcript for the CURRENTLY in-flight reply already matches the
   *  close sentence, starts waiting for THAT reply's own `reply.done` OR CLOSE_DONE_WAIT_MS
   *  (4s), whichever comes first (`beginCloseGrace` is idempotent, so whichever fires first
   *  wins and the other is a no-op) -- never depends on `reply.done` arriving at all.
   *  `closeArmedForReplyId` guards against re-arming a second `CLOSE_DONE_WAIT_MS` timer on
   *  top of one already running for the same reply id as more transcript chunks stream in. */
  private maybeArmCloseOnTranscript(replyId: string): void {
    if (this.goodbyeConfirmed) return; // round 5: nothing left to arm -- already confirmed
    const sentence = this.currentCloseSentence();
    if (!sentence) return;
    if (this.ended || this.closeGraceTimer) return;
    if (this.closeArmedForReplyId === replyId) return;

    const transcript = this.replyTranscripts.get(replyId) ?? '';
    if (!transcriptMatchesCloseSentence(transcript, sentence)) return;

    this.closeArmedForReplyId = replyId;
    // Round 5: this IS the transcript confirmation -- see the class-field doc comment on
    // `goodbyeConfirmed` above for what this triggers.
    this.goodbyeConfirmed = true;
    this.goodbyeConfirmedReplyId = replyId;
    // The words are already heard -- no further retry is owed for this rendering of CLOSE,
    // and the stuck watchdog (armed at this same reply's own reply.started) has nothing left
    // to watch for either.
    if (this.closeRetryTimer) {
      clearTimeout(this.closeRetryTimer);
      this.closeRetryTimer = null;
    }
    if (this.closeStuckTimer) {
      clearTimeout(this.closeStuckTimer);
      this.closeStuckTimer = null;
    }
    // Defect B fix (2026-09-15): a matching chunk landing here means whatever
    // `armCloseTranscriptWait` may have pending for this reply (waiting to decide whether a
    // retry is owed) has its answer already -- nothing left to wait for.
    if (this.closeTranscriptWaitTimer) {
      clearTimeout(this.closeTranscriptWaitTimer);
      this.closeTranscriptWaitTimer = null;
      this.closeTranscriptWaitReplyId = null;
    }
    // goodbye-tail lane, review fix (2026-09-15, Important): if `reply.done` for THIS reply
    // already fired (the routine live case -- see `repliesWithDone`'s own doc comment), there
    // is nothing left to wait for: `beginCloseGrace` directly instead of arming a
    // `CLOSE_DONE_WAIT_MS` timer that can only ever expire, never be pre-empted by a
    // `reply.done` that has already happened.
    if (this.repliesWithDone.has(replyId)) {
      this.beginCloseGrace();
      return;
    }
    this.closeDoneWaitTimer = setTimeout(() => {
      this.closeDoneWaitTimer = null;
      this.beginCloseGrace();
    }, CallSession.CLOSE_DONE_WAIT_MS);
    this.closeDoneWaitTimer.unref?.();
  }

  /** Defect B fix (2026-09-15, PROVEN: CLOSE reply.create sent twice on 6 of 8 live founder
   *  calls 2026-09-14, three times on one): `scheduleCloseIfNeeded`'s non-match branch used
   *  to arm a retry (`armCloseRetryTimer`, spaced only CLOSE_RETRY_MIN_GAP_MS=400ms) the
   *  instant a reply's own `reply.done` arrived with no matching transcript accumulated YET
   *  -- but the final `transcript.agent` chunk for a reply routinely arrives at (or just
   *  after) that SAME reply's `reply.done`, sometimes after the 400ms gap had already sent a
   *  redundant `reply.create` (underrun bursts inside those retries were PROVEN in the same
   *  live sample). This method is what `scheduleCloseIfNeeded` arms instead: gives a late
   *  transcript chunk CLOSE_TRANSCRIPT_WAIT_MS (1500ms -- well over the "tens of ms" lag
   *  actually measured live) to still land and complete the match before concluding the
   *  close line was not spoken. `maybeArmCloseOnTranscript` (fired on every transcript.agent
   *  chunk, including one arriving inside this window) is what actually confirms a match if
   *  one lands, and clears this timer when it does; this timer's own callback re-checks
   *  `ended`/`goodbyeConfirmed` at fire time, so it is a pure no-op if a match already landed
   *  by then -- it can never race or duplicate that confirmation. Only when the window closes
   *  with STILL no match does it fall through to the unchanged, still-spaced
   *  `armCloseRetryTimer`. A defensive match check is also run here (rather than trusting
   *  `maybeArmCloseOnTranscript` alone) in case a chunk lands without re-triggering that path.
   *  Idempotent per reply id: a repeat call for the SAME id already being waited on is a
   *  no-op; a call for a DIFFERENT id (should not happen in practice -- only one CLOSE reply
   *  is ever in flight at a time -- but defensive) replaces the pending wait, the same "latest
   *  wins" convention `armCloseRetryTimer`/`maybeArmCloseOnTranscript` already use elsewhere
   *  in this file. */
  /** `degradedAtReplyDone`: a SNAPSHOT of `degradedTranscriptsMode`, taken by
   *  `scheduleCloseIfNeeded` synchronously at this reply's own `reply.done` (never the LIVE
   *  value re-read when this timer's callback fires, CLOSE_TRANSCRIPT_WAIT_MS later) -- see
   *  the DEGRADED-TRANSCRIPTS class-field doc comment: this avoids a self-referential edge
   *  case where THIS very reply's own strike (which can only resolve after this same wait)
   *  would otherwise be able to flip the mode on just in time to change its own outcome.
   *  `replyStatus`: this reply's own `reply.done.status`, also threaded through by
   *  `scheduleCloseIfNeeded` (CRITICAL 2 fix, 2026-09-17 review of e7ba96f) -- see the
   *  audio-confirm branch below for why an `interrupted` reply can never be confirmed from
   *  audio alone. */
  private armCloseTranscriptWait(replyId: string, degradedAtReplyDone: boolean, replyStatus: string): void {
    if (this.closeTranscriptWaitTimer && this.closeTranscriptWaitReplyId === replyId) return;
    if (this.closeTranscriptWaitTimer) {
      clearTimeout(this.closeTranscriptWaitTimer);
      this.closeTranscriptWaitTimer = null;
    }
    this.closeTranscriptWaitReplyId = replyId;
    this.closeTranscriptWaitTimer = setTimeout(() => {
      this.closeTranscriptWaitTimer = null;
      this.closeTranscriptWaitReplyId = null;
      if (this.ended || this.goodbyeConfirmed) return;
      const sentence = this.currentCloseSentence();
      if (!sentence) return;
      const transcript = this.replyTranscripts.get(replyId) ?? '';
      if (transcriptMatchesCloseSentence(transcript, sentence)) {
        this.goodbyeConfirmed = true;
        this.goodbyeConfirmedReplyId = replyId;
        this.beginCloseGrace();
        return;
      }
      // DEGRADED-TRANSCRIPTS mode (2026-09-16, PROVEN live: a CLOSE reply started with
      // audio, reached reply.done with no transcript, so `transcriptMatchesCloseSentence`
      // never confirmed it, CLOSE was re-sent, and the caller heard duplicate goodbyes): once
      // the channel is already known degraded, a CLOSE reply we ourselves instructed, that
      // started and produced real audio but still has no transcript even after this full
      // wait, is a channel outage -- not evidence the goodbye was never spoken. Confirms from
      // audio alone (`close_confirmed_by_audio`) instead of re-sending an already-spoken
      // goodbye. LAW 2 is unaffected: the verdict and containment already ran the instant
      // CLOSE first rendered, long before this -- this only decides how long the wire stays
      // open trying to confirm a goodbye that was, in all likelihood, already heard.
      //
      // CRITICAL 2 fix (2026-09-17 review of e7ba96f): this used to accept ANY nonzero audio,
      // so a CLOSE reply cut to a fragment by a caller barge-in (e.g. "This...",
      // `reply.done.status === 'interrupted'`) would falsely confirm the goodbye and hang up
      // on the caller mid-sentence. Fixed with two added guards: (a) `replyStatus ===
      // 'completed'` -- an interrupted reply was, by definition, cut short; that is never
      // evidence the full line was heard, however much audio it relayed before being cut off.
      // (b) a minimum-audio floor (`DEGRADED_CLOSE_CONFIRM_MIN_AUDIO_MS`) -- see that
      // constant's own doc comment for the reasoning (a documented absolute floor, the
      // simpler of the two options the review offered, since this codebase has no measured
      // chars/sec TTS rate to compute each close sentence's own expected length from).
      const audioMs = ((this.replyAudioBytes.get(replyId) ?? 0) / CallSession.OUTPUT_AUDIO_BYTES_PER_SECOND) * 1000;
      if (
        degradedAtReplyDone &&
        replyStatus === 'completed' &&
        audioMs >= CallSession.DEGRADED_CLOSE_CONFIRM_MIN_AUDIO_MS &&
        this.instructedReplyIds.has(replyId) &&
        this.replyGoalAtStart.get(replyId) === 'CLOSE'
      ) {
        this.diag('close_confirmed_by_audio', { reply_id: replyId });
        this.goodbyeConfirmed = true;
        this.goodbyeConfirmedReplyId = replyId;
        if (this.closeRetryTimer) {
          clearTimeout(this.closeRetryTimer);
          this.closeRetryTimer = null;
        }
        this.beginCloseGrace();
        return;
      }
      this.closeLastReplyWasEmpty = transcript.trim().length === 0;
      this.armCloseRetryTimer();
    }, CallSession.CLOSE_TRANSCRIPT_WAIT_MS);
    this.closeTranscriptWaitTimer.unref?.();
  }

  /** Round 4, requirement 1: arms the CLOSE_RETRY_MIN_GAP_MS spacing timer before the next
   *  close_retry `reply.create` goes out -- never synchronously off a `reply.done`
   *  (`scheduleCloseIfNeeded`'s own caller). Idempotent via the timer guard: a second
   *  mismatch arriving before the first's timer has fired (e.g. two scripted turns in the
   *  same synchronous tick cascade, PROVEN reachable -- see session.test.ts) coalesces into
   *  the SAME pending retry rather than stacking a second one. Re-checks every precondition
   *  at fire time, not just at arm time, since the world can change in the intervening
   *  400ms: still CLOSE, not ended, and -- requirement 1's "never send while a reply is in
   *  flight" -- neither speaking nor another `reply.create` already outstanding. If any of
   *  those fail, this attempt is simply dropped (never rescheduled): whatever reply is
   *  in flight will produce its own `reply.done`/transcript-match check when it finishes,
   *  which re-triggers this same mechanism if still needed. */
  private armCloseRetryTimer(): void {
    if (this.closeRetryTimer) return;
    this.closeRetryTimer = setTimeout(() => {
      this.closeRetryTimer = null;
      if (this.ended) return;
      const sentence = this.currentCloseSentence();
      if (!sentence) return;
      if (this.speaking || this.replyCreateAwaitingStart) return;
      const wrapper = `Say exactly this and nothing else: "${sentence}"`;
      this.sendReplyCreate('CLOSE', 'close_retry', wrapper, { countAttempt: !this.closeLastReplyWasEmpty });
    }, CallSession.CLOSE_RETRY_MIN_GAP_MS);
    this.closeRetryTimer.unref?.();
  }

  /** Audio-inactivity watchdog (fix round 2, 2026-09-15, PROVEN defect from 2026-09-14
   *  barge-in-interrupt bundle): fires only when CLOSE reply's `reply.started` arrived but
   *  no reply.audio frame for this reply has arrived in the past 12s, AND neither a transcript
   *  match (`maybeArmCloseOnTranscript`) NOR its `reply.done` (`scheduleCloseIfNeeded`) have
   *  cleared the timer. Live CLOSE replies are p50 3952ms, p95 9070ms, max 12668ms (PROVEN
   *  from 79 samples, scripts/rehearse/reports/2026-09-1[234]*.diagnostics.json), so this
   *  inactivity approach avoids false positives from healthy replies that last >12s.
   *
   *  This method arms the initial check at CLOSE_REPLY_STUCK_MS. The check itself is
   *  implemented in `checkCloseReplyStuck` (below) and is idempotent: when it runs, if audio
   *  was recent, it reschedules itself for the remaining time; only when the full window
   *  passes without any audio does it declare stuck. Both clear-paths (transcript match and
   *  reply.done) outright clear the timer, so no re-check is needed there. Treats confirmed
   *  stuck as dead reply: `this.speaking` is given up (same as reply.done would), and a
   *  fresh CLOSE reply is asked for via the spaced retry (`armCloseRetryTimer`) that every
   *  other CLOSE mismatch already uses. */
  private armCloseStuckWatchdog(replyId: string): void {
    if (this.closeStuckTimer) {
      clearTimeout(this.closeStuckTimer);
      this.closeStuckTimer = null;
    }
    this.closeStuckTimer = setTimeout(() => {
      this.checkCloseReplyStuck(replyId);
    }, CallSession.CLOSE_REPLY_STUCK_MS);
    this.closeStuckTimer.unref?.();
  }

  /** Checks whether the CLOSE reply is stuck (no audio for the full CLOSE_REPLY_STUCK_MS
   *  window). Called initially by `armCloseStuckWatchdog` after CLOSE_REPLY_STUCK_MS, and
   *  then reschedules itself for any remaining time if audio was recent. On the final check
   *  (when the full window has passed without audio), declares stuck and arms a retry.
   *  Idle-check guards (`currentReplyId`, `speaking`) and state guards (`ended`,
   *  `goodbyeConfirmed`, close sentence) are checked first and make this a no-op if any
   *  fail (a newer reply started, reply.done already ran, call ended, goodbye confirmed,
   *  or CLOSE is no longer owed). */
  private checkCloseReplyStuck(replyId: string): void {
    if (this.closeStuckTimer) {
      clearTimeout(this.closeStuckTimer);
      this.closeStuckTimer = null;
    }

    if (this.ended || this.goodbyeConfirmed) return;
    if (this.currentReplyId !== replyId) return;
    if (!this.speaking) return;
    const sentence = this.currentCloseSentence();
    if (!sentence) return;

    // Audio-inactivity check: if audio arrived recently, reschedule for remaining time.
    const now = this.opts.now();
    const lastAudioAge = this.lastReplyAudioAt !== null ? now - this.lastReplyAudioAt : Infinity;
    if (lastAudioAge < CallSession.CLOSE_REPLY_STUCK_MS) {
      // Audio was recent; reschedule this check for remaining time, then return.
      const remainingMs = CallSession.CLOSE_REPLY_STUCK_MS - lastAudioAge;
      this.closeStuckTimer = setTimeout(() => {
        this.checkCloseReplyStuck(replyId);
      }, remainingMs);
      this.closeStuckTimer.unref?.();
      return;
    }

    // No audio in the full window -- reply is stuck.
    this.diag('close_reply_stuck', { reply_id: replyId });
    this.speaking = false;
    this.closeLastReplyWasEmpty = (this.replyTranscripts.get(replyId) ?? '').trim().length === 0;
    this.armCloseRetryTimer();
  }

  /** Fired from `reply.done`, and ONLY when the generic force-speak machinery
   *  (`maybeSendReplyCreateAfterReplyDone`) did NOT itself just send a fresh `reply.create`
   *  for this same event -- see that case's own comment for why. reply.create fix, round 3
   *  (2026-09-13, PROVEN live failure -- see closeMatch.ts's own doc comment for the full
   *  incident): reply LABELLING (`replyGoalAtStart`/`pendingRequestedGoal`) is deliberately
   *  no longer consulted here for the hang-up decision -- the PROVEN bug is exactly a
   *  reply.started arriving right after our own `reply.create` yet carrying AssemblyAI's own
   *  turn-driven text, never our close line. A label proves a request was SENT, never that it
   *  was HONOURED. The only thing that can prove the close line was actually spoken is what
   *  the transcript says was spoken.
   *
   *  Matched (`transcriptMatchesCloseSentence`, leniently -- see that function's own doc
   *  comment): begins the grace-period hang-up (`beginCloseGrace`, idempotent -- a match
   *  already found mid-reply via `maybeArmCloseOnTranscript` may have started this already),
   *  regardless of `completed` vs `interrupted` (rule 3: a close line mostly said before a
   *  barge-in still counts -- once SEALED there is nothing left for the model to do, so a
   *  caller who talks over the close line does not buy the call more time).
   *
   *  Not matched (rule 2/3): the close line was NOT heard in THIS reply's transcript so far,
   *  whether it finished cleanly or was interrupted. Defect B fix (2026-09-15): no longer
   *  concludes "not spoken" and arms a retry immediately here -- the reply's own final
   *  transcript chunk routinely arrives at (or just after) `reply.done` itself (PROVEN live),
   *  so this instead arms `armCloseTranscriptWait`, which gives that chunk
   *  CLOSE_TRANSCRIPT_WAIT_MS to still land before falling through to the spaced retry
   *  (`armCloseRetryTimer`, with a one-shot `instructions` payload carrying the exact wrapper
   *  prompt.ts's own CLOSE case uses -- `Say exactly this and nothing else: "..."` -- rather
   *  than relying on the standing `system_prompt` alone; round 4, requirement 8's
   *  empty-transcript bookkeeping is now read at THAT wait's own fire time, off the latest
   *  transcript, not the snapshot taken here). There is no attempt cap anymore
   *  (CLOSE_REPLY_ATTEMPTS is gone) -- retries continue, spaced, until either a match is
   *  heard or the CLOSE_TOTAL_MS (45s) hard cap (`armClose`) ends the call `close_timeout`. */
  private scheduleCloseIfNeeded(replyId: string, status: string): void {
    // Round 5: once confirmed, nothing is owed for any OTHER reply -- but the confirmed
    // reply's own `reply.done` must still fall through below (test (e)'s own PROVEN
    // "reply.done wins the race" behaviour: `beginCloseGrace` is idempotent, so letting this
    // one final call through here costs nothing and starts the grace period immediately
    // instead of waiting for CLOSE_DONE_WAIT_MS's own timer to do it later).
    if (this.goodbyeConfirmed && replyId !== this.goodbyeConfirmedReplyId) return;
    const sentence = this.currentCloseSentence();
    if (!sentence) return;
    if (this.ended) return;

    const transcript = this.replyTranscripts.get(replyId) ?? '';

    if (transcriptMatchesCloseSentence(transcript, sentence)) {
      // Round 5: this IS the transcript confirmation (when `maybeArmCloseOnTranscript` did
      // not already catch it mid-stream) -- see the class-field doc comment on
      // `goodbyeConfirmed` above for what this triggers.
      this.goodbyeConfirmed = true;
      this.goodbyeConfirmedReplyId = replyId;
      this.beginCloseGrace();
      return;
    }

    // DEGRADED-TRANSCRIPTS mode: snapshotted here, synchronously, at THIS reply's own
    // reply.done -- see `armCloseTranscriptWait`'s own doc comment on `degradedAtReplyDone`
    // for why this must be a snapshot, never re-read live inside that later callback. `status`
    // is threaded through too (CRITICAL 2 fix, 2026-09-17 review): an INTERRUPTED reply --
    // cut short by a caller barge-in -- must never be confirmed from audio alone, however
    // much audio it relayed before being cut off. See that method's own doc comment.
    this.armCloseTranscriptWait(replyId, this.degradedTranscriptsMode, status);
  }

  /** HOLD-WITHOUT-FOLLOW-UP fix (2026-09-17, PROVEN live -- deploy 45, record
   *  scripts/rehearse/reports/2026-09-17T08-46-58-judge-out-of-scope, main checkout,
   *  gitignored): the standing rule (prompt.ts's `STANDING_RULES`) makes AssemblyAI's own
   *  automatic reply say exactly "One moment." whenever it must speak with nothing new to say.
   *  Normally harmless -- the server's own instructed `reply.create`
   *  (`mustForceSpeak`/`isFreshQuestionGoal`) follows right behind with the real content the
   *  instant the goal actually changes because of the caller's turn. PROVEN live: when the
   *  caller's turn does NOT change the goal (chatter, an already-answered point, an
   *  off-script remark that keeps the state in OUT_OF_SCOPE) nothing else fires -- the
   *  automatic "One moment." plays, and then nothing, for the whole 31s idle window, until the
   *  idle reaper ends the call.
   *
   *  `maybeArmHoldFollowup`, called from `reply.done` ONLY when nothing else already sent a
   *  `reply.create` for this same event (`!this.replyCreateAwaitingStart` at the call site,
   *  the same guard `scheduleCloseIfNeeded` is already gated behind), arms a SHORT one-shot
   *  timer (`HOLD_FOLLOWUP_MS`) the instant a COMPLETED reply's own accumulated transcript is
   *  the BARE standing holding line and NOTHING else (`normalizeForCloseMatch`, the same
   *  normalization closeMatch.ts already uses for CLOSE, folding casing/punctuation/whitespace
   *  -- an EXACT equality check against `"one moment"`, not a substring: "One moment." survives
   *  minor STT drift the same way a close sentence does, but a reply that says anything MORE
   *  than that is never mistaken for the bare standing line -- see the review-fix note below).
   *  When the timer fires, it re-sends the CURRENT goal's own line through the EXACT SAME
   *  instructed-send path a goal CHANGE already uses (`instructedSentenceFor`/`sendReplyCreate`)
   *  -- restating what the caller is actually being asked/told, instead of leaving them in
   *  silence.
   *
   *  Review fix (2026-09-17, Critical -- FAIL on the first cut): the bare-substring match
   *  above used to be `.includes('one moment')`, which also matched every one of
   *  `stalls.ts`'s own eight legitimate STALL holding lines that happen to CONTAIN the phrase
   *  ("One moment, verifying the sign-in session.", "One moment, checking the file on this
   *  request.", "One moment, confirming with the registered device.", "One moment while that
   *  check completes.", "One moment longer, verifying a detail.", "One moment, I don't want
   *  to rush this.") -- a caller simply waiting on a real SSO/history/OOB lookup would hear
   *  their own stall line restated 2.5s later, as if it were a silent hold. Fixed two ways,
   *  both required (either alone still lets the other shape through): (1) the match is now an
   *  EXACT equality against the normalized bare line, never a substring, so any stall line
   *  with further content words never matches; (2) the STALL goal is excluded outright
   *  (below), belt-and-braces against a FUTURE stall line that happened to normalize to
   *  exactly "one moment" with nothing else -- STALL's own varying holding lines are already a
   *  legitimate, intentional "still working" signal (`pickStallLine`/`usedStalls`), never a
   *  silent dead end the way an UNCHANGED goal with nothing else to say is.
   *
   *  Guards, deliberately mirroring every other force-speak mechanism in this file:
   *   - never once `this.ended` or the goodbye is already confirmed (nothing is ever owed
   *     after that);
   *   - never for the CLOSE goal (checked both at arm time and again at fire time) -- CLOSE's
   *     own hang-up machinery (`scheduleCloseIfNeeded`/`armCloseRetryTimer`) already owns that
   *     goal's retries end-to-end; a follow-up here would race or duplicate a goodbye;
   *   - never for the STALL goal (review fix above) -- a real check is genuinely still
   *     running, and STALL's own library already keeps the caller informed of that;
   *   - never while DEGRADED-TRANSCRIPTS mode is on -- a reply with real audio but a LOST
   *     transcript in degraded mode cannot be trusted to have actually said "One moment." at
   *     all (the same reasoning `maybeReaskQuestion`/`armCloseTranscriptWait` already apply to
   *     their own paths);
   *   - only a `status === 'completed'` reply counts -- an interrupted "One moment." means the
   *     caller is ALREADY talking over it, and their own incoming `transcript.user` clears
   *     this mechanism anyway (see below);
   *   - at most one armed follow-up per caller turn (`holdFollowupArmedForTurn`, reset the
   *     next time the caller speaks) so a caller who keeps chattering without ever making a
   *     request is not spammed with repeated restatements;
   *   - re-checked at FIRE time, not just arm time: `this.speaking`/`this.replyCreateAwaitingStart`
   *     (something else is already speaking or about to -- the exact two guards every other
   *     timer-driven send in this file already reuses, e.g. `armCloseRetryTimer`) and the
   *     goal must still be the SAME rendering that was armed against (`JSON.stringify`, same
   *     convention `questionReaskArmedGoalKey` already uses) -- a caller who spoke and moved
   *     the engine to a genuinely different goal in the meantime must never get a stale
   *     restatement of the OLD one.
   *
   *  Review fix (2026-09-17, Important -- FAIL on the first cut, defect 2): for a QUESTION_GOALS
   *  code, a bare "One moment." reply arms BOTH this follow-up (2500ms) AND the pre-existing
   *  question re-ask (`maybeReaskQuestion`/`armQuestionReaskTimer`, 400ms) independently -- the
   *  re-ask is faster and asks the real question first, but nothing used to stop this
   *  follow-up from ALSO firing 2.1s later and re-sending (a second instructed reply.create, a
   *  second `challenge_issued`/`readback_issued`/`elicit_issued` action for the very same
   *  rendering). Fixed at the single choke point every instructed send in this class already
   *  funnels through: `sendReplyCreate` itself now clears any pending hold-followup timer and
   *  marks the turn as already followed-up the instant ANY instructed reply.create actually
   *  goes out, whichever mechanism sent it -- see that method's own doc comment. The re-ask
   *  wins for question goals (it is faster and budgeted, `QUESTION_REASK_MAX`); this follow-up
   *  is simply the mechanism that yields.
   *
   *  Cleared (never fires) the instant the caller speaks again (any `transcript.user` --
   *  `dispatchAaiEvent`'s own case resets `holdFollowupArmedForTurn` and cancels the pending
   *  timer, the same "a genuine new turn supersedes whatever was pending" rule
   *  `previousCallerTranscriptAtMs` already follows), the instant ANY instructed reply.create
   *  actually sends (`sendReplyCreate`, defect 2 fix above), and at `end()`. */
  private static readonly HOLD_FOLLOWUP_MS = 2_500;
  private holdFollowupTimer: ReturnType<typeof setTimeout> | null = null;
  private holdFollowupArmedForTurn = false;

  private maybeArmHoldFollowup(replyId: string, status: string): void {
    if (this.ended || this.goodbyeConfirmed) return;
    if (!this.last) return;
    if (this.degradedTranscriptsMode) return;
    const goal = this.last.goal;
    if (goal.code === 'CLOSE') return;
    if (goal.code === 'STALL') return; // review fix: STALL's own varying holding lines are legitimate, never a silent dead end
    if (this.holdFollowupArmedForTurn) return; // at most one per caller turn
    if (status !== 'completed') return; // interrupted -- the caller is already talking over it
    const transcript = this.replyTranscripts.get(replyId) ?? '';
    // Review fix: EXACT match against the bare normalized line, never a substring -- a stall
    // line ("One moment, verifying the sign-in session.") also CONTAINS "one moment" but is
    // never the bare standing line this mechanism exists to catch.
    if (normalizeForCloseMatch(transcript) !== 'one moment') return;

    this.holdFollowupArmedForTurn = true;
    this.armHoldFollowupTimer(goal);
  }

  private armHoldFollowupTimer(goalAtArmTime: PhrasingGoal): void {
    this.clearHoldFollowupTimer();
    const goalKeyAtArmTime = JSON.stringify(goalAtArmTime);
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      this.holdFollowupTimer = null;
      if (this.ended || this.goodbyeConfirmed) return;
      if (this.speaking || this.replyCreateAwaitingStart) return;
      if (!this.last) return;
      const goal = this.last.goal;
      if (goal.code === 'CLOSE') return;
      if (JSON.stringify(goal) !== goalKeyAtArmTime) return; // the caller/engine already moved on
      this.diag('hold_followup_sent', { goal_code: goal.code });
      this.sendReplyCreate(goal.code, 'hold_followup', this.instructedSentenceFor(goal));
    }, CallSession.HOLD_FOLLOWUP_MS);
    timer.unref?.();
    this.holdFollowupTimer = timer;
  }

  private clearHoldFollowupTimer(): void {
    if (this.holdFollowupTimer) {
      clearTimeout(this.holdFollowupTimer);
      this.holdFollowupTimer = null;
    }
  }

  constructor(opts: CallSessionOpts) {
    this.opts = opts;
    this.startMs = opts.now();
    this.agentName = resolveAgentName(opts.agent_name);
    opts.aai.on((evt) => this.handleAaiEvent(evt));
    // aai-observability lane (2026-09-16, items 1 and 3): registers this session's own
    // `aai_unhandled_message` / delta-accounting handlers on whatever `AaiSocket` this call
    // holds -- a no-op for any `AaiSocket` that doesn't implement these optional methods
    // (today: `FakeAaiSocket` implements both for tests; `index.ts`'s `PendingAaiSocket`
    // relays both to the real adapter once connected). See `recordUnhandledMessage` and
    // `recordAgentDelta` below for what each one does.
    // Review finding (2026-09-16): these run synchronously inside the AssemblyAI socket's
    // message loop, like `handleAaiEvent`, so a throw here must never escape uncaught either.
    // Observation can fail; the call must not.
    opts.aai.onUnhandledMessage?.((type, detail) => {
      try {
        this.recordUnhandledMessage(type, detail);
      } catch (err) {
        this.diag('error', { message: err instanceof Error ? err.message : String(err), where: 'recordUnhandledMessage' });
      }
    });
    opts.aai.onAgentTranscriptDelta?.((replyId, delta) => {
      try {
        this.recordAgentDelta(replyId, delta);
      } catch (err) {
        this.diag('error', { message: err instanceof Error ? err.message : String(err), where: 'recordAgentDelta' });
      }
    });
  }

  start(): void {
    if (this.started || this.ended) return;
    this.started = true;
    this.tick();
  }

  handleBrowser(e: BrowserEvent): void {
    if (this.ended) return;
    switch (e.type) {
      case 'start':
        this.start();
        break;
      case 'audio':
        this.opts.aai.send({ type: 'input.audio', audio: e.data });
        break;
      case 'end':
        this.end('caller_ended');
        break;
      case 'ping':
        break;
    }
  }

  /** Round 4, requirement 9 (founder correction, 2026-09-14): today, `end('idle_timeout')`
   *  could silently hang up on a call whose logged `call_ended` fact had JUST turned a
   *  still-PENDING verdict terminal (row 15/I4: ESCALATE with a request on record, NO_ACTION
   *  with nothing at stake) -- the goodbye machinery below was never reached because
   *  `this.ended` was already `true` by the time `tick()` ran, and every CLOSE-related method
   *  (`armClose`, `maybeSendReplyCreateForTick`, ...) guards on exactly that flag. PROVEN live
   *  (founder observation, 2026-09-14): single-wrong-answer and hangup-after-request calls
   *  both ended `idle_timeout` with verdict ESCALATE and no goodbye ever spoken.
   *
   *  Fix: for `reason === 'idle_timeout'` specifically (never any other reason -- a caller
   *  hangup, an AAI error, the session cap, all still end immediately, same as always), try
   *  ONCE (`idleDeferAttempted`) to defer: log the `call_ended` fact and run a normal `tick()`
   *  with `this.ended` still false, so row 15 gets to convert the verdict and, if the
   *  resulting goal is CLOSE, the SAME `applyEvaluate`/`armClose`/`maybeSendReplyCreateForTick`
   *  machinery any other terminal verdict uses renders it and asks AssemblyAI to speak it.
   *  `idleEndReason` then overrides `beginCloseGrace`/`armClose`'s own default end reason so
   *  the call still finishes as `idle_timeout` (not `agent_closed`/`close_timeout`) once the
   *  goodbye is confirmed or the close budget expires -- the CLOSE hang-up machinery calls
   *  back into THIS method to actually finish, at which point `idleDeferAttempted` is already
   *  true and this whole branch is skipped, falling straight through to the immediate-end
   *  path below. If the tick above does NOT reach a CLOSE goal (nothing was ever at stake AND
   *  somehow still not terminal -- should not happen given row 15, but defensive), falls
   *  through to ending immediately, same as before this fix. */
  end(reason: string): void {
    if (this.ended) return;
    if (reason === 'idle_timeout' && !this.idleDeferAttempted) {
      this.idleDeferAttempted = true;
      this.logCallEnded('idle_timeout');
      this.tick();
      if (this.ended) return;
      if (this.last?.goal.code === 'CLOSE') {
        this.idleEndReason = 'idle_timeout';
        return;
      }
      // Requirement 9: NO_ACTION never reaches an engine-rendered CLOSE goal (fsm.ts's
      // deriveState always sends it to OUT_OF_SCOPE) -- speak the goodbye ourselves.
      if (this.last?.verdict === 'NO_ACTION') {
        this.idleEndReason = 'idle_timeout';
        this.beginIdleNoActionGoodbye();
        return;
      }
      // Nothing to say -- fall through to the immediate end below.
    }
    this.ended = true;
    this.clearCloseTimers();
    this.clearDegradedStrikeTimers();
    this.clearHoldFollowupTimer();
    // Red team item 4 (founder ruling, 2026-09-09): before anything else about ending the
    // call, record the structured fact that it ended -- LAW 3 forbids the SERVER from
    // deciding what that means (a rejected first attempt at this fix, branch
    // worktree-agent-aa25cb13b49be1675 commit a6c8559, stamped ESCALATE here directly; the
    // founder ruled that out precisely because the engine is the only verdict owner). All
    // this does is append one `call_ended` AgentAction (same shape `link_changed` already
    // uses) and let a normal `tick()` -- the SAME re-evaluate/run-terminal-actions/emit-state
    // sequence every other event in this call already goes through -- react to it. If the
    // engine's own rules.ts row 15 turns that into ESCALATE or NO_ACTION, this is where the
    // containment tools (open_incident, alert_principal, seal_evidence_record) actually run
    // and the hash-chained export gets built, through the EXISTING terminal-action path
    // (`runTerminalActionsIfNeeded`) -- nothing new here at all, just one more fact in the
    // log before the last tick.
    //
    // Every ending route funnels through this one method (idle reaper and the per-call cap
    // timer via ws/browser.ts's `endCall`, a caller hangup via `handleBrowser`'s 'end' case,
    // a dropped AAI/browser socket, session.error/session.ended) -- wiring it here alone
    // covers all of them. Round 4: for a deferred idle end (above), the `call_ended` fact was
    // already logged by `logCallEnded` before that tick ran -- `logCallEnded` here is then a
    // guarded no-op, never a second log entry.
    //
    // `tick()`'s own `emitState()` may push one more 'state' event here (e.g. showing the
    // fresh ESCALATE banner) -- that happens BEFORE the `onServerEvent({type:'ended'})` call
    // below, so 'ended' still stays the last websocket event, same as always. The async
    // export-hash continuation inside `runTerminalActionsIfNeeded` already records
    // `export_computed` unconditionally and checks `this.ended` (true from the line above)
    // before ever calling `emitState()` again, so no websocket event follows 'ended' once
    // the hash resolves.
    this.logCallEnded(reason);
    this.tick();
    // aai-observability lane (2026-09-16, item 1): the ONE point every unhandled-message
    // type's TRUE total is guaranteed to be recorded, even a type that never crossed
    // `UNHANDLED_MESSAGE_LOG_CAP` and so never got its own `_capped` notice. Also records
    // known-ignored types (session.updated, transcript.user.delta) with ignored: true flag.
    this.recordUnhandledMessageSummary();
    this.diag('session_ended', { reason });
    try {
      this.opts.aai.close();
    } catch {
      // a socket that's already gone closing again is not an error worth surfacing
    }
    this.opts.onServerEvent({ type: 'ended', reason });
  }

  /** Rehearsal-harness debug hook (aai/types.ts's `debugForceDrop` doc comment has the full
   *  reasoning: judge-sim finding 2026-09-11, "zero AssemblyAI socket drops occurred" --
   *  session.resume was never exercised on a live call). Forwards to the live AAI socket's
   *  own `debugForceDrop`, which is a no-op-returning-false for anything other than a real
   *  connection (`FakeAaiSocket` records it for tests; a plain `AaiSocket` with neither
   *  implements it at all, hence the `?.()`). Never touches the engine, the verdict, or any
   *  evidence -- only the transport leg drops; the resume (or give-up) that follows is
   *  exactly the same code path a real network blip takes. Only reachable server-side via
   *  the env-guarded debug route (`COUNTERSIGN_DEBUG_HOOKS=1`, http.ts). */
  debugDropAai(): boolean {
    if (this.ended) return false;
    return this.opts.aai.debugForceDrop?.() ?? false;
  }

  /** IMPORTANT 2 (final review): ws/browser.ts calls this for the browser<->server leg's own
   *  link events (lost on close, restored on reattach) -- the AAI-leg counterpart is logged
   *  internally by `handleAaiEvent`'s own `link` case. Kept as a public method rather than
   *  exposing `logs.actions`/`nextActionId`/`nowT` directly: the transport layer records
   *  WHAT happened, this class still owns HOW it's recorded (evidence, never a verdict). */
  noteBrowserLinkChange(state: 'lost' | 'restored'): void {
    if (this.ended) return;
    this.logs.actions.push({
      id: this.nextActionId(),
      kind: 'link_changed',
      t_ms: this.nowT(),
      detail: `browser:${state}`,
    });
    this.diag('link', { leg: 'browser', state });
  }

  /** Task R1: lets the transport layer (ws/browser.ts) tell an ended call apart from a call
   *  that's merely between browser sockets during its grace window -- a browser reattach is
   *  offered only for the latter; a call the engine already finished never gets a second
   *  life just because a new socket showed up for its id. */
  hasEnded(): boolean {
    return this.ended;
  }

  // ---------- internals ----------

  private nowT(): number {
    return this.opts.now() - this.startMs;
  }

  private nextActionId(): string {
    this.actionCounter += 1;
    return `${this.opts.session_id}-action-${this.actionCounter}`;
  }

  /** Round 4, requirement 9: logs the ONE `call_ended` action this class ever writes for a
   *  given `end()` sequence -- `end()`'s idle-defer path may log it (with 'idle_timeout')
   *  well before the call actually finishes, so the later immediate-end path must not push a
   *  second one. Review fix (2026-09-15, Minor): if that later call carries a DIFFERENT
   *  reason -- the idle-deferred goodbye was still pending when something else (the per-call
   *  cap, a caller hangup) ended the call for real -- the already-logged action's `detail` is
   *  corrected in place, so the evidence record reads the reason the call actually ended
   *  under, not the earlier, superseded one. */
  private logCallEnded(reason: string): void {
    if (this.callEndedAction) {
      if (this.callEndedAction.detail !== reason) this.callEndedAction.detail = reason;
      return;
    }
    this.callEndedAction = { id: this.nextActionId(), kind: 'call_ended', t_ms: this.nowT(), detail: reason };
    this.logs.actions.push(this.callEndedAction);
  }

  private nextToolId(): string {
    this.toolCounter += 1;
    return `${this.opts.session_id}-tool-${this.toolCounter}`;
  }

  /** Flight recorder: forwards one server_event to `opts.onDiagnostic`, if wired. Never
   *  throws, never touches `logs`/`last` -- diagnostics is a side channel, not evidence. */
  private diag(kind: string, detail: unknown): void {
    this.opts.onDiagnostic?.(kind, detail);
  }

  private buildEngineInput(): EngineInput {
    return {
      conversation: this.logs.conversation,
      tools: this.logs.tools,
      actions: this.logs.actions,
      call: this.opts.call,
      seed: this.opts.seed,
    };
  }

  /** Flight recorder: every per-event handler below can throw (a malformed AAI event, a
   *  bug in the engine, anything) -- this is the one place that can never let such a throw
   *  escape uncaught (it's invoked synchronously from `aai.on`'s emit loop, which would
   *  otherwise crash the process or the whole call). Caught, logged as an `error`
   *  server_event with `where` naming the event type, then swallowed: the founder's ask was
   *  "tell you where it went wrong", not "take the call down with it".
   *
   *  Fix round 1 (review finding, IMPORTANT): a throw partway through `dispatchAaiEvent`
   *  used to exit it entirely -- skipping its trailing `tick()` (so the engine never
   *  re-evaluated the event that just happened, and the call just sat on stale state until
   *  the next unrelated AAI event or the cap/idle timer forced it closed) and, for a throw
   *  during `reply.done` specifically, skipping `flushToolResults`/
   *  `discardPendingToolResults` too (any `tool.result` already queued from an earlier
   *  `tool.call` would never reach AAI on schedule). `recoverFromDispatchError` below runs
   *  whatever the throw preempted, so a caught fault degrades gracefully instead of stalling
   *  the call. No new `ServerEvent` kind is added to surface this to the browser -- none of
   *  the existing kinds (`state`/`audio`/`flush`/`ended`/`link`) fit a generic internal
   *  fault, and the protocol is out of this task's scope; `GET .../diagnostics` remains the
   *  way to see it, same as before this fix. */
  private handleAaiEvent(evt: AaiEvent): void {
    if (this.ended) return;
    try {
      this.dispatchAaiEvent(evt);
    } catch (err) {
      this.recoverFromDispatchError(evt, err);
    }
  }

  private recoverFromDispatchError(evt: AaiEvent, err: unknown): void {
    this.diag('error', { message: err instanceof Error ? err.message : String(err), where: `handleAaiEvent:${evt.type}` });

    // If the throw happened while handling a `tool.call` (e.g. the mock backend itself threw,
    // or a bug in validation), the `ToolLogEntry` may never have been logged and no
    // `tool.result` was ever queued for `evt.call_id` -- AAI would then wait forever for a
    // reply that's never coming, and the engine's own I4 rule (rules.ts: "any tool result
    // carrying an error... makes the evaluation incomplete: ESCALATE/NO_ACTION, never STAGE")
    // never gets a chance to fire, because there's no failed result for it to see. Backfill
    // one now -- idempotent (only if this call_id truly never got logged), so a throw AFTER
    // the entry was already pushed (e.g. inside `this.diag` itself, which can't actually
    // throw, but defensively) never double-logs it.
    if (evt.type === 'tool.call' && !this.logs.tools.some((t) => t.id === evt.call_id)) {
      const result = { error: 'internal_error' };
      this.logs.tools.push(toolLogEntryFromCall(evt, this.nowT(), { ...evt.arguments, dispatch_failed: true }, result));
      this.pendingToolResults.push({ call_id: evt.call_id, result, is_error: true });
    }

    // A throw inside `reply.done`'s own handling (e.g. `recordGoalCompletionAction`, which
    // runs BEFORE the flush/discard branch) means neither `flushToolResults` nor
    // `discardPendingToolResults` ran for this turn. Run whichever this event would have run,
    // so any `tool.result` already queued (from this event or an earlier `tool.call`) still
    // goes out on schedule rather than stalling until some later, unrelated `reply.done`.
    //
    // Fix round 2 (re-review finding, IMPORTANT): this retry call can ITSELF throw --
    // `flushToolResults` calls `this.opts.aai.send(...)`, which is exactly what a real,
    // closing/closed WebSocket can throw from (not just a synthetic test double). If the
    // ORIGINAL `flushToolResults` (from the normal `reply.done` case in `dispatchAaiEvent`)
    // already failed because of that, this retry hits the SAME failing socket and throws
    // again -- and until this fix, nothing here caught it: it would propagate straight out of
    // `recoverFromDispatchError`, past `handleAaiEvent`'s own try/catch (which only wraps the
    // call to `dispatchAaiEvent`, not this method), right back into `aai.on()`'s synchronous
    // emit loop. That is precisely the "never let a throw escape uncaught" guarantee this
    // whole method exists to provide -- one more try/catch closes it, same pattern as the
    // `tick()` guard below: log it (`where: 'recover_flush'`) and continue to `tick()`
    // regardless, rather than leaving whatever's left in `pendingToolResults` to be retried
    // (or not) some other way.
    if (evt.type === 'reply.done') {
      try {
        if (evt.status === 'interrupted') this.discardPendingToolResults();
        else this.flushToolResults();
      } catch (flushErr) {
        this.diag('error', {
          message: flushErr instanceof Error ? flushErr.message : String(flushErr),
          where: 'recover_flush',
        });
      }
    }

    // Keep the call moving: re-run the engine over whatever DID make it into the logs before
    // the throw (including the backfilled failed tool result above, if any) and push the
    // resulting ScreenState. A caught internal error must never leave the call sitting on
    // stale state until cap/idle forcibly ends it -- this is the fix for exactly that.
    //
    // `tick()` itself can throw again here -- e.g. a broken mock backend that fails EVERY
    // tool, including a terminal action `runTerminalActionsIfNeeded` now tries to run because
    // the backfilled failed result above just made the verdict terminal. Uncaught, that
    // throw would escape this catch block entirely (this method is itself only ever called
    // FROM a catch), taking the whole call down -- the exact failure mode this fix exists to
    // close. One more try/catch, never recursing back into `recoverFromDispatchError`: just
    // log it and give up on ticking for THIS event. The next real AAI event still gets a
    // normal (non-recovery) `tick()`.
    try {
      this.tick();
    } catch (tickErr) {
      this.diag('error', {
        message: tickErr instanceof Error ? tickErr.message : String(tickErr),
        where: 'recoverFromDispatchError:tick',
      });
    }
  }

  private dispatchAaiEvent(evt: AaiEvent): void {
    // BRAKE (2026-09-15): captured here, read only after `tick()` (below) has already run and
    // consulted `previousCallerTranscriptAtMs` for whatever it was BEFORE this event -- see
    // that field's own doc comment for why the update must happen strictly after the tick that
    // processes this fragment, never before or during it (comparing a fragment against itself
    // would always read a zero gap).
    let newCallerTranscriptAtMs: number | null = null;
    switch (evt.type) {
      // PROVEN flight-recorder bug fix (2026-09-03): `tick()` re-runs the full engine
      // `evaluate(this.buildEngineInput())` and logs a diagnostics `evaluate` event -- worth
      // paying for only when something `buildEngineInput()` reads (conversation, tools,
      // actions, call, seed) actually changed. Below, each case that does NOT touch any of
      // those `return`s without ticking instead of falling through to the shared `tick()`
      // at the bottom; every case that DOES (or otherwise needs the emitState() a tick
      // produces) still falls through to it, unchanged.

      case 'session.ready':
        // Diagnostics only -- doesn't touch conversation/tools/actions, doesn't set
        // `speaking`. `start()` already ticks once on its own, so this would be a pure
        // no-op re-evaluation even in the one-time (non-flood) case.
        // Real-call note (2026-09-03, softened per review): this does not fire on the
        // initial connect, because `connectAai` (packages/server/src/aai/session.ts)
        // consumes the `session.ready` message itself while resolving its connect
        // promise, before the `RealAaiSocket` (and therefore this dispatch) exists. It
        // might still fire after a resume, if the service re-sends one then (UNVERIFIED).
        // The "AAI connected/ready" diagnostic for the initial connect is recorded from
        // `connectAai`'s own `onReady` hook instead (wired in index.ts).
        this.diag('aai_session_ready', { session_id: evt.session_id });
        return;

      case 'transcript.user':
      case 'transcript.agent': {
        // Insurance (2026-09-09 flight-recorder finding): the AAI leg has a bounded
        // resume-on-drop path (aai/session.ts, three attempts in 30s, session.resume with
        // the prior session id). UNKNOWN whether AssemblyAI ever redelivers a transcript
        // after a resume, but if it redelivers an item_id already recorded here, a plain
        // repeat of the CURRENT value is a harmless ledger no-op -- while a redelivered
        // STALE value (an earlier statement re-sent after a later correction) would land
        // with a fresh server timestamp, sort AFTER the correction, and could be
        // misclassified CONTRADICTED with a spurious request_version bump. Only FINAL
        // transcripts carry an item_id that matters here; this event type has no
        // partial/interim variant to preserve (AaiEvent's own `transcript.*.delta` is
        // deliberately unmodeled -- see aai/types.ts).
        if (this.logs.conversation.some((u) => u.id === evt.item_id)) {
          this.diag('transcript_duplicate_ignored', {
            item_id: evt.item_id,
            speaker: evt.type === 'transcript.user' ? 'caller' : 'agent',
          });
          return;
        }
        // Round 5 review fix (2026-09-14, Important): a reply whose audio was already
        // dropped (`suppressPostGoodbyeReplyAudio` -- see the `goodbyeConfirmed` class-field
        // doc comment) must not have its transcript logged as a spoken agent utterance
        // either -- the caller never heard it, so the evidence record must not say it was
        // said. Checked BEFORE the push below (never after): nothing from this text may reach
        // `logs.conversation` (evidence, export, screen state, engine input all read from
        // there), `replyTranscripts` (dead data for an id `scheduleCloseIfNeeded`/
        // `maybeArmCloseOnTranscript` already refuse to act on once `goodbyeConfirmed` is set
        // for a DIFFERENT reply id -- see their own guards), or the ordinary `transcript` diag
        // (which would otherwise record this text's length as agent speech). One diag event
        // instead, length only (LAW 4: never the text itself), and no `tick()` -- nothing in
        // EngineInput changed, same reasoning as the `transcript_duplicate_ignored` case above.
        if (evt.type === 'transcript.agent' && this.goodbyeConfirmed && evt.reply_id !== this.goodbyeConfirmedReplyId) {
          this.diag('post_goodbye_transcript_dropped', { reply_id: evt.reply_id, length: evt.text.length, text: evt.text });
          return;
        }
        // Changes `conversation`, part of EngineInput -- must tick.
        this.logs.conversation.push(utteranceFromTranscript(evt, this.nowT()));
        // Idle-timing fix (timing-analysis.md §C): only the CALLER's own final transcript
        // counts as conversational activity here -- `transcript.agent` does not touch the
        // idle clock (the agent finishing its reply, `reply.done` below, is what starts the
        // caller's own silence window; the agent's transcript can land before or after that
        // and would otherwise let a stalled reply mask real caller silence).
        if (evt.type === 'transcript.user') {
          this.opts.onActivity?.();
          // HOLD-WITHOUT-FOLLOW-UP fix: a genuine new caller turn supersedes whatever
          // hold-followup was pending -- the caller is talking again, so whatever restatement
          // was armed is no longer needed (and `holdFollowupArmedForTurn` resets so the NEXT
          // silence-after-a-holding-line gets its own one-shot chance to arm). See
          // `maybeArmHoldFollowup`'s own doc comment.
          this.holdFollowupArmedForTurn = false;
          this.clearHoldFollowupTimer();
          // Design E (2026-09-15): marks the tick this event's trailing `this.tick()` (below)
          // runs as caller-turn-triggered -- see `tickTriggeredByCallerTurn`'s own doc
          // comment for why the proactive QUESTION_GOALS send is scoped to this, not to
          // every tick.
          this.tickTriggeredByCallerTurn = true;
          // BRAKE (2026-09-15): recorded BEFORE the trailing `tick()` runs, so
          // `shouldBrakeFreshQuestion` (called from inside that tick) sees whether THIS
          // fragment itself already looks like an answer attempt. Never cleared once true for
          // the currently pending instructed question -- see the field's own doc comment.
          if (looksLikeAnswerAttempt(evt.text)) this.pendingQuestionAnswerAttemptSeen = true;
          // The field itself is only advanced to THIS fragment's own timestamp once this
          // event's tick has finished consulting the PRIOR value -- see the local variable's
          // own doc comment just above the switch statement.
          newCallerTranscriptAtMs = this.nowT();
        }
        // reply.create fix, round 3 (2026-09-13): accumulate this AAI reply's own spoken
        // text, in memory only (never diagnostics -- LAW 4) -- `scheduleCloseIfNeeded` reads
        // this at the reply's own `reply.done` to decide whether the CLOSE sentence was
        // actually heard. See `replyTranscripts`'s own doc comment.
        if (evt.type === 'transcript.agent') {
          const existing = this.replyTranscripts.get(evt.reply_id) ?? '';
          this.replyTranscripts.set(evt.reply_id, existing.length > 0 ? `${existing} ${evt.text}` : evt.text);
          // Round 4, requirement 7: check the instant this chunk arrives, not only at
          // reply.done -- see `maybeArmCloseOnTranscript`'s own doc comment.
          this.maybeArmCloseOnTranscript(evt.reply_id);
          // DEGRADED-TRANSCRIPTS mode: a non-empty chunk is proof the agent-transcript
          // channel is (still, or again) alive -- see `noteAgentTranscriptSeen`'s own doc
          // comment.
          if (evt.text.trim().length > 0) {
            this.noteAgentTranscriptSeen(evt.reply_id);
            // Fix B: a real transcript chunk for the reply the max-audio-only timer is
            // watching means it is healthy -- nothing left to check for it.
            this.clearDegradedMaxAudioOnlyTimer(evt.reply_id);
          }
        }
        // Flight recorder: role, length, and text all recorded. This is diagnostics (not
        // evidence per LAW 4) -- the text is recorded so live calls can be analyzed post-hoc
        // without re-reading server logs. Evidence exports stay the only artefact that proves
        // what was said; this is a debugging-aid copy with the same text, verbatim.
        this.diag('transcript', { role: evt.type === 'transcript.user' ? 'user' : 'agent', length: evt.text.length, text: evt.text });
        break;
      }

      case 'reply.started':
        // Doesn't touch EngineInput, but flips `this.speaking`, which `emitState()` (called
        // by `tick()`) pushes to the browser as the speaking indicator -- fires once per
        // agent turn (not per-frame), so ticking here costs nothing like `reply.audio` does.
        // Skipping it would leave the browser showing "not speaking" for the whole reply.
        this.speaking = true;
        this.replyFirstAudioRecorded = false;
        // Fix round 2 (2026-09-15, audio-inactivity watchdog): reset audio timestamp for the
        // new reply so that `armCloseStuckWatchdog` starts fresh (no audio yet for this one).
        this.lastReplyAudioAt = null;
        // reply.create fix, round 2 (Critical 1, 2026-09-13 review): label this reply with
        // what was actually REQUESTED, never with whatever `this.last` happens to read by
        // now. If a `reply.create` is outstanding, `pendingRequestedGoal` is the goal it
        // asked for -- that is this reply's true phrasing intent even if a LATER, separate
        // tick has since advanced `this.last.goal.code` further (the exact bug round 1 had:
        // it labelled from `this.last` unconditionally). Only when nothing is outstanding
        // (this reply arose from ordinary caller-turn-driven flow, not our own ask) does
        // `this.last.goal.code` -- the goal in force at this exact instant, before this
        // event's own `tick()` runs -- correctly describe what it was phrased under.
        // DEGRADED-TRANSCRIPTS mode: captured before `replyCreateAwaitingStart` is cleared
        // below -- true exactly when THIS reply is the one we ourselves asked AssemblyAI to
        // speak (see `instructedReplyIds`'s own doc comment), never an ambient automatic
        // reply that merely happens to render under the current goal.
        const wasInstructedReply = this.replyCreateAwaitingStart;
        const requestedGoal = wasInstructedReply ? this.pendingRequestedGoal : (this.last?.goal?.code ?? null);
        if (requestedGoal) this.replyGoalAtStart.set(evt.reply_id, requestedGoal);
        if (wasInstructedReply) this.instructedReplyIds.add(evt.reply_id);
        // Occurrence-4 follow-on (see the DEGRADED-TRANSCRIPTS class-field doc comment):
        // records, for THIS reply, how long it started after the previous reply's own
        // reply.done -- but only when that previous reply was one of ours (an ambient
        // automatic reply following AssemblyAI's own turn-taking is not the signal this
        // tracks). Read later, only if this reply goes on to strike, by `recordDegradedStrike`.
        this.replyFollowsInstructedDoneMs.set(
          evt.reply_id,
          this.lastAnyReplyDoneWasInstructed && this.lastAnyReplyDoneAtMs !== null
            ? this.nowT() - this.lastAnyReplyDoneAtMs
            : null
        );
        this.replyCreateAwaitingStart = false;
        this.pendingRequestedGoal = null;
        // Round 4, requirement 5: this reply.create (if any was outstanding) is no longer at
        // risk of being "lost" -- something started.
        this.clearReplyCreateLostTimer();
        // Fix (2026-09-16): a CLOSE reply that actually starts is definitionally not "lost",
        // regardless of what it goes on to say -- reset the consecutive-loss streak AND record
        // that AssemblyAI has responded to CLOSE at least once this call (see
        // `MAX_CLOSE_LOST_STREAK`'s own doc comment for why both matter: `abandonClose` only
        // ever fires for total, unbroken non-responsiveness). Never touches
        // `closeReplySendCount` (observability only) or any mismatch/empty-transcript
        // bookkeeping -- those still run their own unchanged course once this reply completes.
        if (requestedGoal === 'CLOSE') {
          this.closeLostStreak = 0;
          this.closeEverStarted = true;
        }
        // Round 5: `reply.audio` events carry no reply id of their own (aai/types.ts) -- this
        // is the only record of which reply subsequent frames belong to. A reply that starts
        // AFTER the goodbye is already transcript-confirmed, and is not the confirmed reply
        // itself, is AssemblyAI generating something nobody asked for (its own turn-driven
        // follow-up, or a queued reply.create) -- see the class-field doc comment on
        // `goodbyeConfirmed`. Logged once, here, rather than per-frame.
        this.currentReplyId = evt.reply_id;
        this.suppressPostGoodbyeReplyAudio = this.goodbyeConfirmed && evt.reply_id !== this.goodbyeConfirmedReplyId;
        if (this.suppressPostGoodbyeReplyAudio) this.diag('post_goodbye_reply_suppressed', { reply_id: evt.reply_id });
        // PROVEN defect fix (2026-09-14, barge-in-interrupt bundle): a close owed right now
        // means whatever reply just started could BE the close line -- arm the stuck watchdog
        // so a reply that never produces a transcript chunk or a reply.done (see
        // `armCloseStuckWatchdog`'s own doc comment) still gets retried well before the 45s
        // hard cap. A no-op the instant this reply's own transcript/reply.done arrives (both
        // clear it), and superseded automatically if a newer reply starts first.
        if (this.currentCloseSentence()) this.armCloseStuckWatchdog(evt.reply_id);
        this.diag('reply.started', {});
        break;

      case 'reply.audio':
        // THE FIX: fires once per AAI audio frame (~100/sec while the agent talks) and
        // touches none of conversation/tools/actions/seed/speaking -- ticking here was the
        // root cause of the flood (1,998 `evaluate` events in 46s, PROVEN from the
        // 2026-09-03 flight-recorder bundle). Forward the frame to the browser and stop
        // (no tick) -- the one-time first-frame diagnostic below still records normally.
        // Round 5: a frame belonging to a reply that started after the goodbye was already
        // confirmed is dropped instead of relayed -- the suppression diagnostic was already
        // logged once, at that reply's own `reply.started`, above.
        // Fix round 2 (2026-09-15, audio-inactivity watchdog): record when this reply's
        // audio frame arrived BEFORE the post-goodbye suppression guard, so the watchdog's
        // re-check logic has the current audio time even for frames that don't get relayed.
        this.lastReplyAudioAt = this.opts.now();
        if (this.suppressPostGoodbyeReplyAudio) return;
        this.opts.onServerEvent({ type: 'audio', data: evt.data });
        // Defect A fix (2026-09-15): track bytes of THIS reply's audio actually relayed to
        // the browser, and when the first relayed frame went out -- `beginCloseGrace` reads
        // this (for the confirmed goodbye reply only) to size the hang-up wait to the
        // reply's own estimated playback length. `evt.data` is base64 (docs/
        // ASSEMBLYAI_INTEGRATION.md line 17); `Buffer.byteLength(str, 'base64')` gives the
        // DECODED byte count without allocating a full Buffer per frame.
        if (this.currentReplyId) {
          const bytes = Buffer.byteLength(evt.data, 'base64');
          this.replyAudioBytes.set(this.currentReplyId, (this.replyAudioBytes.get(this.currentReplyId) ?? 0) + bytes);
          if (!this.replyFirstAudioAt.has(this.currentReplyId)) {
            this.replyFirstAudioAt.set(this.currentReplyId, this.opts.now());
          }
        }
        // Flight recorder: only the FIRST audio frame of this reply -- a reply can carry
        // dozens of frames, and recording every one was the bulk of what starved the live
        // bundle's event cap (2026-09-03 finding). This is enough to see when audio actually
        // started going out relative to `reply.started`.
        if (!this.replyFirstAudioRecorded) {
          this.replyFirstAudioRecorded = true;
          this.diag('reply.audio.first', {});
          // DEGRADED-TRANSCRIPTS mode, path (b): a reply that is still running well past
          // DEGRADED_INFLIGHT_STRIKE_MS with no transcript at all is caught here, rather than
          // waiting for its own (possibly very distant) reply.done -- see
          // `armDegradedInflightStrikeCheck`'s own doc comment.
          if (this.currentReplyId) {
            this.armDegradedInflightStrikeCheck(this.currentReplyId);
            // Fix B: the absolute audio-only ceiling, armed alongside the inactivity check
            // from this same first-frame point -- see `armDegradedMaxAudioOnlyCheck`'s own
            // doc comment for why this is a NECESSARY addition, not a duplicate, of the
            // inactivity check just above.
            this.armDegradedMaxAudioOnlyCheck(this.currentReplyId);
          }
        }
        return;

      case 'reply.done':
        this.speaking = false;
        // goodbye-tail lane, review fix (2026-09-15, Important): record that THIS reply's
        // `reply.done` has now fired, before anything below can call
        // `maybeArmCloseOnTranscript` (indirectly, via a later `transcript.agent` event) for
        // it -- see `repliesWithDone`'s own doc comment.
        this.repliesWithDone.add(evt.reply_id);
        // Fix B: this reply is finished (whether it struck or not) -- nothing left for the
        // max-audio-only ceiling to watch for it.
        this.clearDegradedMaxAudioOnlyTimer(evt.reply_id);
        // DEGRADED-TRANSCRIPTS mode, path (a): a completed reply that had real audio relayed
        // and (after the existing late-transcript wait) still has no transcript counts one
        // strike -- see `armDegradedStrikeCheck`'s own doc comment. Interrupted replies are
        // excluded: a caller barge-in cutting a reply short is an unrelated, legitimate
        // reason for a missing transcript, not a channel-health signal.
        if (evt.status === 'completed' && (this.replyAudioBytes.get(evt.reply_id) ?? 0) > 0) {
          this.armDegradedStrikeCheck(evt.reply_id);
        }
        // Occurrence-4 follow-on: records this reply's own completion for the NEXT reply's
        // `reply.started` to compute its gap from -- see `replyFollowsInstructedDoneMs`'s own
        // doc comment. Read `instructedReplyIds` (never `wasInstructedReply`, a `reply.started`-
        // scoped local from a different case) so this is correct regardless of which case set
        // it.
        this.lastAnyReplyDoneAtMs = this.nowT();
        this.lastAnyReplyDoneWasInstructed = this.instructedReplyIds.has(evt.reply_id);
        // Idle-timing fix (timing-analysis.md §C): the agent finishing a reply is
        // conversational activity too -- this is what lets the 30s idle window start
        // counting from the moment the agent stops talking (asking a question, saying the
        // goodbye, whatever), rather than never starting at all because raw audio frames
        // (removed, ws/browser.ts) or a mid-reply event kept resetting it early.
        this.opts.onActivity?.();
        // A reply.done for this reply means it is no longer at risk of being "stuck" --
        // `scheduleCloseIfNeeded` (below) is the authoritative next step for a CLOSE reply,
        // whether it matched or not; the watchdog's own job (catching a reply that ends
        // WITHOUT ever producing a reply.done) is moot the instant one actually arrives.
        if (this.closeStuckTimer) {
          clearTimeout(this.closeStuckTimer);
          this.closeStuckTimer = null;
        }
        // reply.create fix, round 3 (2026-09-13, requirement 4): a reply.done always means
        // AssemblyAI is not currently generating anything for us -- if `replyCreateAwaitingStart`
        // is somehow still true here (its own `reply.started` never fired, or fired for a
        // different id than expected), clear it now rather than let it wedge every later
        // `reply.create` send closed for the rest of the call.
        this.replyCreateAwaitingStart = false;
        this.clearReplyCreateLostTimer();
        this.recordGoalCompletionAction(evt.reply_id, evt.status);
        this.diag('reply.done', { status: evt.status });
        // aai-observability lane (2026-09-16, item 3): `replyTranscripts` for this reply is
        // final now (nothing later appends to it for this reply id) -- checked here, once
        // per reply, regardless of `evt.status` (an interrupted reply with a dropped
        // finalize is exactly as interesting as a completed one).
        this.checkTranscriptDeltas(evt.reply_id);
        if (evt.status === 'interrupted') {
          this.opts.onServerEvent({ type: 'flush' });
          // docs/ASSEMBLYAI_AGENT_INSTRUCTIONS.md: "If reply.done.status == 'interrupted'
          // (user barge-in), discard pending tool results." The evidence stands -- the
          // ToolLogEntry and its mock result stay in the logs untouched -- only the
          // tool.result message to AAI is dropped (a new turn already started; AAI is no
          // longer expecting a reply to the old one).
          this.discardPendingToolResults();
        } else {
          this.flushToolResults();
        }
        // reply.create fix, round 2 -- requirement 3 unchanged: the tool.result flush rule
        // stays first (immediately above); this only ever sends AFTER that.
        this.maybeSendReplyCreateAfterReplyDone(evt.reply_id);
        // Question-reask fix (2026-09-14): only when NOTHING was just sent above does this
        // get a chance to fire -- see `maybeReaskQuestion`'s own doc comment for the guard
        // it makes of `replyCreateAwaitingStart` itself; QUESTION_GOALS and
        // FORCE_SPEAK_GOALS/HOLDING_GOALS are disjoint by construction, so this and the
        // generic force-speak machinery above never both want to send for the same event.
        this.maybeReaskQuestion(evt.reply_id, evt.status);
        // reply.create fix, round 3: only when NOTHING was just sent above (the generic
        // force-speak machinery found no new goal to speak at all) does the CLOSE-specific,
        // transcript-confirmed check get to decide whether to arm the hang-up or retry --
        // otherwise a reply.create the line above just sent (e.g. a stale in-flight reply
        // whose OWN recorded goal differs from the now-current CLOSE) would race a second,
        // redundant one from `scheduleCloseIfNeeded`'s own retry path. Checked regardless of
        // `evt.status`: an interrupted close still means nothing more is owed if the close
        // line was already heard (see `scheduleCloseIfNeeded`'s own doc comment).
        if (!this.replyCreateAwaitingStart) this.scheduleCloseIfNeeded(evt.reply_id, evt.status);
        // HOLD-WITHOUT-FOLLOW-UP fix: only when NOTHING else already sent (or is about to
        // send) a `reply.create` for this same event -- same `!this.replyCreateAwaitingStart`
        // guard `scheduleCloseIfNeeded` is already gated behind, just above -- does a
        // completed reply whose transcript was only the standing holding line get a chance to
        // arm the short restatement follow-up. See `maybeArmHoldFollowup`'s own doc comment.
        if (!this.replyCreateAwaitingStart) this.maybeArmHoldFollowup(evt.reply_id, evt.status);
        break;

      case 'input.speech.started':
        // Sends its own 'flush' ServerEvent directly (not via tick/emitState) and touches no
        // EngineInput field -- no reason to re-run evaluate too.
        this.opts.onServerEvent({ type: 'flush' });
        this.diag('input.speech.started', {});
        // Idle-timing fix (timing-analysis.md §C): the caller starting to speak is real
        // conversational activity even before AssemblyAI finalizes a transcript for it --
        // touching here (not just at `transcript.user`) matters for a caller mid-utterance
        // when the idle reaper's own tick lands.
        this.opts.onActivity?.();
        return;

      case 'input.speech.stopped':
        // No-op today; touches nothing evaluate reads.
        this.diag('input.speech.stopped', {});
        return;

      case 'tool.call':
        this.handleToolCall(evt);
        break;

      case 'session.error':
        this.diag('aai_session_error', { code: evt.code, message: evt.message });
        this.end(`aai_error:${evt.code}`);
        return;

      case 'session.ended':
        // Round 3 (S3 re-review): the real adapter sets `reason: 'link_lost'` when its own
        // bounded resume-on-drop gives up; a genuine AssemblyAI-originated session.ended
        // never carries one, so this still falls back to the existing 'aai_ended' reason.
        // The Termination event carries session_duration_seconds and audio_duration_seconds for billing.
        // Only record aai_session_terminated if session_duration_seconds is present and numeric.
        if (typeof evt.session_duration_seconds === 'number') {
          this.diag('aai_session_terminated', {
            session_duration_seconds: evt.session_duration_seconds,
            audio_duration_seconds: evt.audio_duration_seconds,
          });
        }
        this.diag('aai_session_ended', { reason: evt.reason ?? 'aai_ended' });
        this.end(evt.reason ?? 'aai_ended');
        return;

      case 'link':
        // S3's AAI-transport reconnect (server<->AssemblyAI dropped and resumed) surfaced
        // to whichever browser is currently attached -- distinct from Task R1's own
        // browser<->server link (ws/browser.ts owns that one entirely; this is a pass-
        // through, not a state change).
        // 2026-09-03 correction: this DOES still fall through to the shared `tick()` below
        // (unlike the flood-prone cases skipped above) -- it appends a `link_changed` entry
        // to `logs.actions`, which IS part of EngineInput, so `evaluate` must re-run to keep
        // `this.last`/the evidence export consistent with the logs, even though no rule
        // keys off this particular action kind (LAW 3 unaffected either way: no
        // verdict-bearing `AgentActionKind` here).
        // IMPORTANT 2 (final review): tagged `leg: 'aai'` (browser-leg drops are ws/
        // browser.ts's own, tagged 'browser') so the UI can tell the two apart, and logged as
        // a `link_changed` action -- evidence of what happened to the call's transport,
        // never a verdict-bearing one (LAW 3 unaffected: no `AgentActionKind` here feeds a
        // rule).
        this.logs.actions.push({
          id: this.nextActionId(),
          kind: 'link_changed',
          t_ms: this.nowT(),
          detail: `aai:${evt.state}:${evt.attempt}`,
        });
        this.diag('link', { leg: 'aai', state: evt.state, attempt: evt.attempt });
        this.opts.onServerEvent({ type: 'link', state: evt.state, leg: 'aai' });
        break;
    }
    this.tick();
    // BRAKE (2026-09-15): only now -- after this event's own tick has already consulted
    // `previousCallerTranscriptAtMs` for whatever it was BEFORE this fragment -- does the
    // field advance to this fragment's own timestamp, ready for the NEXT one to compare
    // against. A no-op for every event type other than transcript.user.
    if (newCallerTranscriptAtMs !== null) this.previousCallerTranscriptAtMs = newCallerTranscriptAtMs;
  }

  /** When the agent's reply for an ASK_CHALLENGE/READBACK/ELICIT_MISSING_CRITICAL goal
   *  completes, the server -- not the LLM -- writes the record of what was issued (v2
   *  ruling: the LLM never writes evidence). `this.last` is still the goal computed BEFORE
   *  this reply.done, i.e. the goal the reply that just finished was phrased for.
   *  Important 2 (review of commit 5930450, 2026-09-13): ELICIT_MISSING_CRITICAL used to
   *  fall through unlogged, so compose.ts's computeReadbackReaskExhausted had nothing to
   *  count for a caller who never states a critical field at all -- re-asked forever, no
   *  escalation. Now logs an `elicit_issued` action naming the field (no `value`: nothing
   *  has been stated yet), which computeReadbackReaskExhausted folds into the same
   *  per-field cap it already enforces for readback_issued.
   *
   *  Review fix (2026-09-15, Critical -- proven through the REAL reply.done dispatch, not
   *  internals): this used to log the issued action UNCONDITIONALLY on any `status ===
   *  'completed'` reply, regardless of whether that reply's own transcript actually asked
   *  the question. For ASK_CHALLENGE specifically, `challenge_issued` is exactly what
   *  `selectChallenge` (engine/challenges.ts, via `reconstructIssued`) reads to decide the
   *  challenge has been put to the caller and it is time to select the NEXT one -- so a
   *  "Checking the record." reply (no question asked at all) still logged `challenge_issued`
   *  and this SAME event's own trailing `tick()` (called after this method returns, at the
   *  bottom of `dispatchAaiEvent`) immediately re-evaluated and advanced the engine to a
   *  FRESH challenge (same code ASK_CHALLENGE, different challenge_id -- PROVEN reproduction:
   *  sess-b-1 -> sess-b-2). By the time `maybeReaskQuestion`'s own spaced timer fired 400ms
   *  later, `armQuestionReaskTimer`'s goal-key snapshot no longer matched (a real, and
   *  correct, cancellation of what LOOKED like a stale reask) -- but `mustForceSpeak` ignores
   *  a same-CODE re-render, so nothing else ever prompted the model to ask sess-b-1's
   *  question either. Net effect: the caller was never actually asked anything, and the
   *  question-reask fix silently did nothing on exactly the live shape it exists to catch.
   *
   *  Fix: reuse `transcriptAsksQuestion` (questionMatch.ts) with the goal's own composed
   *  verbatim sentence (`verbatimQuestionSentence`) to decide whether THIS reply actually
   *  asked the question before logging anything at all. If it did not, log NOTHING for this
   *  goal (LAW 4 spirit: the record must never claim a question was put to the caller that
   *  never was) -- the goal then does not advance, `maybeReaskQuestion`'s own spaced timer
   *  (armed right after this method returns, from the same `reply.done` case) finds the SAME
   *  goal still current at fire time, and the reask actually reaches the model. Interrupted
   *  replies are unaffected either way -- the `status !== 'completed'` guard above already
   *  short-circuits before this check is ever reached, exactly as before this fix.
   *
   *  READBACK's own field-advancement is driven by the CALLER's confirmation (the ledger),
   *  never by `readback_issued` itself, so this fix does not change WHEN a READBACK moves on
   *  -- only (a) that `readback_issued`/`elicit_issued` never again claims a question that
   *  was never asked, and (b) that an un-asked readback/elicit no longer inflates
   *  `computeReadbackReaskExhausted`'s own per-field cap (compose.ts) with a "re-ask" that
   *  was not actually one. */
  private recordGoalCompletionAction(replyId: string, status: string): void {
    if (status !== 'completed' || !this.last) return;
    const goal: PhrasingGoal = this.last.goal;
    const transcript = this.replyTranscripts.get(replyId) ?? '';
    let asked = transcriptAsksQuestion(transcript, verbatimQuestionSentence(goal));
    // DEGRADED-TRANSCRIPTS mode: reads the mode value as of THIS reply's own reply.done
    // (synchronous, before this same reply could ever contribute a strike of its own -- a
    // strike only resolves DEGRADED_STRIKE_WAIT_MS/DEGRADED_INFLIGHT_STRIKE_MS later, so this
    // reply's own outcome can never retroactively flip the value read right here). A reply
    // with real audio and an EMPTY transcript, while the channel is already known degraded,
    // is very likely a question that WAS spoken but that AssemblyAI simply never transcribed
    // -- but ONLY if it was OUR OWN instructed reply for THIS exact goal (`instructedReplyIds`
    // + `replyGoalAtStart` match): an ambient automatic reply we never asked for proves
    // nothing about whether the question was ever put to the caller at all. Safe under LAW 3:
    // grading (challenge PASS/FAIL/AMBIGUOUS) still comes exclusively from the CALLER's own
    // transcript, never from this action -- all `assumed_asked` does is let the engine treat
    // the question as issued so its own readback/challenge-selection logic advances normally;
    // an assumed ask that was never actually spoken can only ever lead to an unanswered
    // challenge later (never a false PASS, never STAGE on its own).
    //
    // ONE-TIME benefit of the doubt per rendering: `alreadyReaskedThisRendering` refuses the
    // assumption once this exact goal rendering has ALREADY needed at least one counted-or-
    // forgiven re-ask (`questionReaskGoalKey`/`questionReaskCount`/`questionReaskEmptyCount`,
    // `maybeReaskQuestion`'s own bookkeeping). Two or more CONSECUTIVE silent instructed
    // replies for the very same still-unresolved rendering is exactly the shape
    // `QUESTION_REASK_MAX_EMPTY` already exists to bound and give up on -- repeated silence is
    // a materially weaker signal than a single occurrence, and assuming every one of them was
    // "spoken but untranscribed" would let a rendering nobody ever actually asked advance
    // regardless. Only the FIRST completed reply for a rendering (nothing re-asked yet) gets
    // this assumption; every later one, once degraded, falls through to `maybeReaskQuestion`'s
    // own (also degraded-suppressed) re-ask bookkeeping instead, which stays PENDING rather
    // than silently claiming an ask that a repeating pattern of silence makes hard to credit.
    const alreadyReaskedThisRendering =
      this.questionReaskGoalKey === JSON.stringify(goal) && (this.questionReaskCount > 0 || this.questionReaskEmptyCount > 0);
    if (!asked && this.degradedTranscriptsMode && !alreadyReaskedThisRendering && transcript.trim().length === 0) {
      const hadAudio = (this.replyAudioBytes.get(replyId) ?? 0) > 0;
      const wasOurInstructedReplyForThisGoal =
        this.instructedReplyIds.has(replyId) && this.replyGoalAtStart.get(replyId) === goal.code;
      // LAW 3 fix (2026-09-17 review of e7ba96f, Important): this assumption used to apply to
      // EVERY goal code here, including READBACK -- but `readback_issued` is not just internal
      // bookkeeping the way `challenge_issued`/`elicit_issued` are (those only ever let the
      // engine pick its OWN next challenge/field, still graded exclusively from the caller's
      // own words). `readback_issued` is what the LEDGER (engine/ledger.ts) reads to treat the
      // caller's VERY NEXT turn as CONFIRMING a critical field -- so assuming one was spoken
      // when it may never have reached the caller's ears (this reply's real failure mode: audio
      // relayed, transcript lost) would let a "yes" the caller never actually meant confirm a
      // field they never heard read back. Restricted to CHALLENGE/ELICIT only; a READBACK this
      // reply may or may not have actually spoken is left UNCONFIRMED instead -- no re-ask is
      // ever armed for it either (the degraded mode suppresses `maybeReaskQuestion` for every
      // QUESTION_GOALS code, READBACK included), so the call simply has no forward path for
      // this rendering and falls to the idle timer, ending ESCALATE-side -- the safe side per
      // LAW 3 (never STAGE on evidence this uncertain).
      if (hadAudio && wasOurInstructedReplyForThisGoal && goal.code !== 'READBACK') {
        asked = true;
        this.diag('assumed_asked', { reply_id: replyId, goal_code: goal.code });
      } else if (hadAudio && wasOurInstructedReplyForThisGoal && goal.code === 'READBACK' && goal.readback) {
        this.diag('readback_not_assumed', { reply_id: replyId, field: goal.readback.field });
      }
    }
    if (goal.code === 'ASK_CHALLENGE' && goal.challenge) {
      if (!asked) return;
      const t_ms = this.nowT();
      this.logs.actions.push({
        id: this.nextActionId(),
        kind: 'challenge_issued',
        t_ms,
        challenge_id: goal.challenge.challenge_id,
        spec: goal.challenge,
      });
      // LAW 4: record a diagnostic event with verbatim ids, never paraphrase
      this.diag('action_logged', {
        kind: 'challenge_issued',
        t_ms,
        challenge_id: goal.challenge.challenge_id,
        fact_id: goal.challenge.fact_id ?? null,
        spec_kind: goal.challenge.kind,
        reply_id: replyId,
      });
    } else if (goal.code === 'READBACK' && goal.readback) {
      if (!asked) return;
      const t_ms = this.nowT();
      this.logs.actions.push({
        id: this.nextActionId(),
        kind: 'readback_issued',
        t_ms,
        field: goal.readback.field,
        value: goal.readback.value,
      });
      // LAW 4: record a diagnostic event with verbatim ids, never paraphrase
      this.diag('action_logged', {
        kind: 'readback_issued',
        t_ms,
        field: goal.readback.field,
        spec_kind: 'READBACK',
        reply_id: replyId,
      });
    } else if (goal.code === 'ELICIT_MISSING_CRITICAL' && goal.elicit) {
      if (!asked) return;
      const t_ms = this.nowT();
      this.logs.actions.push({
        id: this.nextActionId(),
        kind: 'elicit_issued',
        t_ms,
        field: goal.elicit.field,
      });
      // LAW 4: record a diagnostic event with verbatim ids, never paraphrase
      this.diag('action_logged', {
        kind: 'elicit_issued',
        t_ms,
        field: goal.elicit.field,
        spec_kind: 'ELICIT',
        reply_id: replyId,
      });
    }
  }

  /** Question-reask fix (2026-09-14, PROVEN live failure -- see
   *  scripts/rehearse/reports/2026-09-14T15-47-29-miller-patient.diagnostics.json and its own
   *  .md): at 33741 the engine rendered goal ASK_CHALLENGE (the next verification question);
   *  the model's own reply was "Checking the record." (20 chars, no question at all); the SAME
   *  goal re-rendered unchanged at 37041 (nothing new to say, so no fresh session.update went
   *  out either, and nothing else in this class ever asks the model to try again); a
   *  person-like caller then waited for a question that never came until the idle timer ended
   *  the call 33 seconds later. LAW 3 is unaffected either way -- the engine already composed
   *  the question (fsm.ts/challenges.ts); this only ever asks AssemblyAI to actually speak the
   *  SAME already-computed goal again, never a new one and never a verdict.
   *
   *  Called once per completed reply, from `dispatchAaiEvent`'s 'reply.done' case, reading
   *  `this.last` from BEFORE that event's own trailing `tick()` runs -- same timing
   *  `recordGoalCompletionAction`/`scheduleCloseIfNeeded` already rely on, for the same
   *  reason: this is the goal the reply that just finished was actually phrased under.
   *
   *  Guards, in order: only a `status === 'completed'` reply is even eligible (an interrupted
   *  reply was cut off by the caller, not abandoned by the model -- nothing to reask yet, the
   *  next turn will re-render the same unmet goal on its own). Never while the call has ended,
   *  the goodbye is already transcript-confirmed (closeMatch.ts's `goodbyeConfirmed` --
   *  nothing is ever owed again once that's true, same rule `sendReplyCreate` itself already
   *  enforces), or something else already sent a `reply.create` this same event
   *  (`maybeSendReplyCreateAfterReplyDone`, immediately above this call at the call site).
   *  Only fires for a QUESTION_GOAL (questionMatch.ts) -- every holding/announcement/close
   *  goal is excluded by construction, never checked here at all.
   *
   *  `replyGoalAtStart.get(replyId)` (set at THIS reply's own `reply.started`, same map
   *  `maybeSendReplyCreateAfterReplyDone` already reads) must still equal the CURRENT goal
   *  code, or the caller has already moved on to a different question by the time this reply
   *  finished -- reasking the STALE one now would only confuse them further.
   *
   *  The per-rendering cap (`questionReaskGoalKey`/`questionReaskCount`) resets the moment the
   *  goal object itself changes (a fresh challenge, a fresh readback field, ...); a rendering
   *  gets at most QUESTION_REASK_MAX (2) counted reasks before this gives up on it silently
   *  (the next goal change, or the call's own idle/cap timers, take over from there -- no new
   *  escalation path is added here). Review fix (2026-09-15): does not send here at all any
   *  more -- decides WHETHER a reask is owed and, if so, snapshots what to say and hands off
   *  to `armQuestionReaskTimer` for the actual (spaced) send. See that method's own doc
   *  comment, and the class-field doc comment on `questionReaskTimer`, for why. */
  private maybeReaskQuestion(replyId: string, status: string): void {
    if (status !== 'completed') return;
    if (this.ended || this.goodbyeConfirmed) return;
    if (this.replyCreateAwaitingStart) return; // something else already sent one this turn
    if (!this.last) return;
    // DEGRADED-TRANSCRIPTS mode: while the agent-transcript channel is known degraded, a
    // completed reply with no transcript is very likely a spoken-but-untranscribed question,
    // not evidence the model said nothing -- re-asking on that signal would very plausibly
    // talk over a caller who already heard (and may already be answering) the real question.
    // This is checked ONCE, here, at the top -- the entry point EVERY reask decision for this
    // reply funnels through -- and deliberately reads the CURRENT mode value at this exact,
    // synchronous instant (before this same reply's own outcome could ever contribute a
    // strike: a strike only resolves DEGRADED_STRIKE_WAIT_MS/DEGRADED_INFLIGHT_STRIKE_MS
    // later). Deliberately NOT re-checked again inside `armQuestionReaskTimer`'s own later
    // callback: a reask already armed here, before the mode flipped, must still be allowed to
    // fire on schedule -- the mode turning on is itself informed by this exact reply
    // (whichever one is the CURRENT/2nd consecutive strike), and re-checking live inside the
    // spaced timer would retroactively cancel a send this same reply had already earned.
    if (this.degradedTranscriptsMode) return;

    const goal = this.last.goal;
    if (!QUESTION_GOALS.has(goal.code)) return;

    const label = this.replyGoalAtStart.get(replyId) ?? null;
    if (label !== goal.code) return; // the goal moved on before this reply even finished

    // Idempotency fix (2026-09-16c): THIS reply.done is now the newest word on the current
    // rendering, whatever it turns out to decide below -- clear any wait `armQuestionTranscriptWait`
    // left pending from an EARLIER reply of the same rendering (see `questionReaskLatestReplyId`'s
    // own doc comment for the full incident) before deciding anything else, exactly the "latest
    // reply wins" guarantee `armCloseTranscriptWait` already gives CLOSE for free by being its
    // only entry point.
    this.questionReaskLatestReplyId = replyId;
    if (this.questionTranscriptWaitTimer && this.questionTranscriptWaitReplyId !== replyId) {
      clearTimeout(this.questionTranscriptWaitTimer);
      this.questionTranscriptWaitTimer = null;
      this.questionTranscriptWaitReplyId = null;
    }

    const goalKey = JSON.stringify(goal);
    if (goalKey !== this.questionReaskGoalKey) {
      this.questionReaskGoalKey = goalKey;
      this.questionReaskCount = 0;
      this.questionReaskEmptyCount = 0;
    }
    if (this.questionReaskCount >= CallSession.QUESTION_REASK_MAX) return;
    // Fix (2026-09-16): a rendering whose replies never produce a transcript at all (see
    // `QUESTION_REASK_MAX_EMPTY`'s own doc comment) is bounded separately from the counted
    // cap above -- without this, `questionReaskCount` never advances (every one of those
    // replies is "forgiven" as empty) and this method reasks forever.
    if (this.questionReaskEmptyCount >= CallSession.QUESTION_REASK_MAX_EMPTY) return;

    const transcript = this.replyTranscripts.get(replyId) ?? '';
    const sentence = verbatimQuestionSentence(goal);
    if (transcriptAsksQuestion(transcript, sentence)) return;

    // Design E (2026-09-15): reuses `instructedSentenceFor` (shared with the proactive
    // tick-end/after-reply-done sends) instead of re-deriving the same "say exactly this" /
    // paraphrase-instruction wrapper independently -- the reask and the original ask can
    // never drift apart in wording. Non-null here: `goal.code` is already confirmed a
    // QUESTION_GOALS member above.
    const instructions = this.instructedSentenceFor(goal)!;

    // Late-transcript race fix (2026-09-16b, Sonnet review of bde7814): a transcript that is
    // EMPTY right here, at `reply.done` time, is exactly the shape PROVEN to race a
    // `transcript.agent` chunk still on the wire (see `questionTranscriptWaitTimer`'s own
    // class-field doc comment) -- give it `QUESTION_TRANSCRIPT_WAIT_MS` to still land before
    // concluding this reply said nothing at all. A reply whose transcript already has real
    // (non-matching) content is not this race -- it decides synchronously below, exactly as
    // before this fix, so the normal path is not slowed down at all.
    if (transcript.trim().length === 0) {
      this.armQuestionTranscriptWait(replyId, goalKey, goal.code, sentence, instructions);
      return;
    }

    // Unconditionally refreshed even when `armQuestionReaskTimer` below turns out to be a
    // no-op (a timer from an earlier reply of this SAME rendering is already pending) -- the
    // latest reply's own emptiness/instructions are what should fire, same convention
    // `scheduleCloseIfNeeded` already uses for `closeLastReplyWasEmpty`.
    this.questionReaskLastReplyWasEmpty = false;
    this.questionReaskArmedGoalKey = goalKey;
    this.questionReaskArmedGoalCode = goal.code;
    this.questionReaskArmedInstructions = instructions;
    this.armQuestionReaskTimer();
  }

  /** Late-transcript race fix (2026-09-16b, Sonnet review of bde7814 -- Important): the
   *  question-reask counterpart to `armCloseTranscriptWait` above. Called from
   *  `maybeReaskQuestion` only when THIS reply's accumulated transcript is still empty at
   *  `reply.done` time -- see `questionTranscriptWaitTimer`'s own class-field doc comment for
   *  the full incident this guards against (a `transcript.agent` chunk landing AFTER
   *  `reply.done`, misclassified as "said nothing" and silently exhausting
   *  `QUESTION_REASK_MAX_EMPTY`). Idempotent per reply id, same "latest reply wins"
   *  convention `armCloseTranscriptWait` already uses: a repeat call for the SAME id is a
   *  no-op; a call for a DIFFERENT id (a newer reply finished before this one's wait fired)
   *  replaces the pending wait.
   *
   *  At fire time, re-reads `replyTranscripts.get(replyId)` (never a snapshot taken at arm
   *  time) and re-checks `transcriptAsksQuestion` against it: if a chunk landed during the
   *  wait and now completes the match, the question WAS actually asked -- nothing is
   *  reasked, and neither `questionReaskCount` nor `questionReaskEmptyCount` is touched, the
   *  same outcome `maybeReaskQuestion`'s own synchronous match-and-return branch already
   *  gives an immediate match. Only when the window closes with the transcript STILL empty
   *  does this fall through to `armQuestionReaskTimer`, exactly as `maybeReaskQuestion`
   *  itself would have decided immediately before this fix -- `questionReaskLastReplyWasEmpty`
   *  is set true there so the empty-forgiveness accounting downstream is unaffected by this
   *  extra wait. Re-checks `ended`/`goodbyeConfirmed`/the goal key at fire time too, same
   *  "the world can change while this was pending" philosophy every other timer in this file
   *  already follows. */
  private armQuestionTranscriptWait(
    replyId: string,
    goalKey: string,
    goalCode: GoalCode,
    sentence: string | null,
    instructions: string
  ): void {
    if (this.questionTranscriptWaitTimer && this.questionTranscriptWaitReplyId === replyId) return;
    if (this.questionTranscriptWaitTimer) {
      clearTimeout(this.questionTranscriptWaitTimer);
      this.questionTranscriptWaitTimer = null;
    }
    this.questionTranscriptWaitReplyId = replyId;
    this.questionTranscriptWaitTimer = setTimeout(() => {
      this.questionTranscriptWaitTimer = null;
      this.questionTranscriptWaitReplyId = null;
      if (this.ended || this.goodbyeConfirmed) return;
      // Idempotency fix (2026-09-16c, defensive second guard -- see `questionReaskLatestReplyId`'s
      // own doc comment): a newer reply.done for this same rendering already clears this timer
      // outright via `clearTimeout`, so this branch should be unreachable in practice, but a
      // stale wait must never be allowed to decide anything once a newer reply already has.
      if (this.questionReaskLatestReplyId !== replyId) return;
      if (!this.last || JSON.stringify(this.last.goal) !== goalKey) return; // goal moved on -- cancel

      const transcript = this.replyTranscripts.get(replyId) ?? '';
      if (transcriptAsksQuestion(transcript, sentence)) {
        // The late chunk proves the question WAS asked -- nothing to reask, nothing consumed.
        this.diag('question_transcript_wait_resolved', { goal_code: goalCode, asked: true });
        return;
      }

      this.questionReaskLastReplyWasEmpty = transcript.trim().length === 0;
      this.questionReaskArmedGoalKey = goalKey;
      this.questionReaskArmedGoalCode = goalCode;
      this.questionReaskArmedInstructions = instructions;
      this.armQuestionReaskTimer();
    }, CallSession.QUESTION_TRANSCRIPT_WAIT_MS);
    this.questionTranscriptWaitTimer.unref?.();
  }

  /** Review fix (2026-09-15): the spaced-send counterpart to `armCloseRetryTimer` above, same
   *  CLOSE_RETRY_MIN_GAP_MS (400ms) gap, same idempotent single-timer shape, same
   *  "re-check everything at fire time, not just arm time" philosophy -- the world (a goal
   *  change, the call ending, another reply.create landing) can change in the 400ms between
   *  `maybeReaskQuestion` deciding a reask is owed and this actually sending it. Fires at
   *  most once per arm; a second `maybeReaskQuestion` call before this fires updates the
   *  snapshot fields in place (read here) and reuses this SAME pending timer.
   *
   *  Goal-change cancellation (review requirement (d)): compares the CURRENT
   *  `this.last.goal`, freshly stringified, against `questionReaskArmedGoalKey` (the snapshot
   *  taken at arm time) -- any difference at all (a different code, a different challenge, a
   *  fresh readback value, ...) means the caller has moved on and this reask is stale; it is
   *  silently dropped, never sent. `maybeReaskQuestion` itself will already have started a
   *  fresh cycle for whatever the new goal is, if that new goal also needs one.
   *
   *  Empty-reply forgiveness (review requirement (b)): `questionReaskLastReplyWasEmpty`,
   *  snapshotted at arm time, decides whether THIS send bumps `questionReaskCount` -- an
   *  empty/whitespace-only reply still gets retried (the words were plausibly never even
   *  generated, not refused), but for free, exactly as `armCloseRetryTimer`'s own
   *  `countAttempt`/`closeLastReplyWasEmpty` already treat an empty CLOSE reply. */
  private armQuestionReaskTimer(): void {
    if (this.questionReaskTimer) return;
    this.questionReaskTimer = setTimeout(() => {
      this.questionReaskTimer = null;
      if (this.ended || this.goodbyeConfirmed) return;
      if (!this.last) return;
      if (JSON.stringify(this.last.goal) !== this.questionReaskArmedGoalKey) return; // goal moved on -- cancel
      if (this.speaking || this.replyCreateAwaitingStart) return;
      if (this.questionReaskCount >= CallSession.QUESTION_REASK_MAX) return;
      // Fix (2026-09-16): the empty/no-transcript budget is checked again at fire time, same
      // "re-check everything, not just at arm time" philosophy as every other guard here --
      // see `QUESTION_REASK_MAX_EMPTY`'s own doc comment for why this is a NECESSARY second
      // cap, not a duplicate of the one just above.
      if (this.questionReaskLastReplyWasEmpty && this.questionReaskEmptyCount >= CallSession.QUESTION_REASK_MAX_EMPTY) return;

      const goalCode = this.questionReaskArmedGoalCode!;
      const instructions = this.questionReaskArmedInstructions!;
      if (this.questionReaskLastReplyWasEmpty) this.questionReaskEmptyCount += 1;
      else this.questionReaskCount += 1;
      this.sendReplyCreate(goalCode, 'question_not_asked', instructions);
      // Diag shape unchanged (existing tests assert an exact `{goal_code, attempt}` shape) --
      // `questionReaskEmptyCount` is internal bookkeeping only, not surfaced here.
      this.diag('question_reask_sent', { goal_code: goalCode, attempt: this.questionReaskCount });
    }, CallSession.CLOSE_RETRY_MIN_GAP_MS);
    this.questionReaskTimer.unref?.();
  }

  private handleToolCall(evt: Extract<AaiEvent, { type: 'tool.call' }>): void {
    // Flight recorder: wall-clock duration of this tool.call's handling (validation +
    // dispatch to the mock backend) -- the mock backend is a synchronous pure function
    // (LAW: no real integrations), so this is normally sub-millisecond; it's still recorded
    // so a genuinely slow validation/repair step would show up.
    const startedAt = performance.now();

    if (!isToolName(evt.name) || !(this.last?.allowed_tools.includes(evt.name) ?? false)) {
      const result = { error: 'not_allowed_in_state' };
      const args = { ...evt.arguments, ignored: true };
      this.logs.tools.push(toolLogEntryFromCall(evt, this.nowT(), args, result));
      this.pendingToolResults.push({ call_id: evt.call_id, result, is_error: true });
      this.diag('tool_call', { name: evt.name, duration_ms: performance.now() - startedAt, status: 'not_allowed_in_state' });
      return;
    }

    const name = evt.name;

    // The LLM never overrides the claimed identity (see IDENTITY_ARG_TOOLS above): whatever
    // it sent for identity_id is replaced before it ever reaches the validator.
    const candidateArgs: Record<string, unknown> = { ...evt.arguments };
    if (IDENTITY_ARG_TOOLS.has(name) && this.last!.claimed_identity_id) {
      candidateArgs.identity_id = this.last!.claimed_identity_id;
    }

    // CLAUDE.md law: "typed tool payloads validated/repaired in code." A tool.call's
    // `arguments` is LLM-generated (untrusted shape, even though it's not evidence) --
    // validate/repair it against the schema we advertised before it can reach the mock.
    const validation = validateToolArgs(name, candidateArgs, paramsFor(name));
    const loggedArgs: Record<string, unknown> =
      validation.repaired.length > 0 ? { ...validation.args, _repaired: validation.repaired } : validation.args;

    if (!validation.ok) {
      const result = { error: 'invalid_arguments', rejected: validation.rejected };
      // Landing review 2026-09-03 (Important): like `not_allowed_in_state` above, this call
      // never reached the mock backend, so it is no real attempt at the check. Tag it
      // `ignored` so evidence/fromTools.ts's `latest()` cannot let a late, malformed model
      // call shadow evidence the server-initiated lookup already resolved.
      const rejectedArgs = { ...loggedArgs, ignored: true };
      this.logs.tools.push(toolLogEntryFromCall(evt, this.nowT(), rejectedArgs, result));
      this.pendingToolResults.push({ call_id: evt.call_id, result, is_error: true });
      this.diag('tool_call', { name, duration_ms: performance.now() - startedAt, status: 'invalid_arguments' });
      return;
    }

    const args = { ...validation.args, request_version: this.last!.request_version };
    const finalLoggedArgs = validation.repaired.length > 0 ? { ...args, _repaired: validation.repaired } : args;
    const result = this.opts.mock(name, args, this.opts.seed, this.mockCtx);
    if (name === 'open_incident') this.mockCtx.incident_index += 1;
    this.logs.tools.push(toolLogEntryFromCall(evt, this.nowT(), finalLoggedArgs, result));
    this.pendingToolResults.push({ call_id: evt.call_id, result, is_error: Boolean(result.error) });
    this.diag('tool_call', {
      name,
      duration_ms: performance.now() - startedAt,
      status: result.error ? 'error' : 'ok',
    });
  }

  /** LAW/docs rule (aai-docs-check §e): "Send tool.result when reply.done is the latest
   *  event you've received. Not earlier, not later." -- results are queued in
   *  `pendingToolResults` and only sent here, from the reply.done handler. */
  /** Fix round 1: removes each entry from `pendingToolResults` BEFORE sending it (rather than
   *  clearing the whole array only after the loop completes) -- makes this safely re-callable
   *  after a partial failure (e.g. `aai.send` itself throwing mid-loop, which
   *  `recoverFromDispatchError` above may end up doing exactly that: calling this again for
   *  the SAME `reply.done` a throw already interrupted). Without this, a retry would re-send
   *  whatever the first attempt already got out before it died. */
  private flushToolResults(): void {
    while (this.pendingToolResults.length > 0) {
      const p = this.pendingToolResults.shift()!;
      this.opts.aai.send({ type: 'tool.result', call_id: p.call_id, result: JSON.stringify(p.result), is_error: p.is_error });
    }
  }

  /** The interrupted-reply.done counterpart to `flushToolResults`: never sends the queued
   *  tool.result messages (a new turn has already started -- AAI is no longer expecting
   *  answers to the old one), but marks each already-logged ToolLogEntry with
   *  `discarded_on_interrupt: true` in its `args` so the discard itself is visible evidence,
   *  not a silent drop -- the entry's `result` (the mock's actual answer) is left untouched. */
  private discardPendingToolResults(): void {
    if (this.pendingToolResults.length === 0) return;
    for (const p of this.pendingToolResults) {
      const entry = this.logs.tools.find((t) => t.id === p.call_id);
      if (entry) entry.args = { ...entry.args, discarded_on_interrupt: true };
    }
    this.pendingToolResults = [];
  }

  /** Re-run the engine, react to a goal change, run terminal actions if newly owed, then
   *  push the resulting ScreenState. Called once per AAI event and once from start(). */
  private tick(): void {
    // reply.create fix, round 2 (Critical 1): captured BEFORE any of this tick's own
    // evaluate() calls run -- the goal that was in force when this tick began, i.e. the
    // "from" side `maybeSendReplyCreateForTick` compares against the goal this tick
    // actually lands on, once evaluate/lookups/terminal-actions have all settled.
    // Defensive `?.` on `goal` too (not just `this.last`): a caught mid-dispatch error can
    // leave `this.last.goal` transiently undefined (see diagnostics.test.ts's own "poison
    // last.goal, then check it gets restored" recovery tests) -- this must never itself
    // throw, or `recoverFromDispatchError`'s own retry of `tick()` gives up before
    // `applyEvaluate()` ever gets a chance to restore a real goal.
    const goalAtTickStart: GoalCode | null = this.last?.goal?.code ?? null;
    // Design E: consumed (read then cleared) here, before any of this tick's own work runs,
    // so it reflects only whether THIS tick was triggered by a `transcript.user` event -- see
    // `tickTriggeredByCallerTurn`'s own doc comment.
    const callerTurnTick = this.tickTriggeredByCallerTurn;
    this.tickTriggeredByCallerTurn = false;
    this.applyEvaluate();
    this.runLookupsIfNeeded();
    this.runTerminalActionsIfNeeded();
    this.maybeSendReplyCreateForTick(goalAtTickStart, callerTurnTick);
    this.emitState();
  }

  /** The latest logged entry for `name` (last one wins, same convention as the engine's own
   *  `evidence/fromTools.ts`), or undefined if the model has never called it this session. */
  private latestToolEntry(name: ToolName): ToolLogEntry | undefined {
    let found: ToolLogEntry | undefined;
    for (const t of this.logs.tools) if (t.name === name) found = t;
    return found;
  }

  /** True when `name`'s latest logged entry is missing, errored, or was obtained for a
   *  different request_version than `requestVersion` -- exactly the same staleness test
   *  `evidence/fromTools.ts`'s `pendingCard` uses to grade it PENDING, mirrored here so the
   *  runner and the engine agree on what "still needs an answer" means. Checked against the
   *  RESULT's own echoed `request_version` (every mock result carries one), not the logged
   *  `args`, for the same reason: a model-issued call that raced ahead with a stale version
   *  in its arguments would still get a stale-tagged result back from the mock. */
  private lookupNeedsRun(name: ToolName, requestVersion: number): boolean {
    const entry = this.latestToolEntry(name);
    if (!entry || !entry.result) return true;
    if (entry.result.error !== undefined && entry.result.error !== null) return true;
    return Number(entry.result.request_version) !== requestVersion;
  }

  /** Server-initiated lookup runner (bug fix above): whenever the current state is EVIDENCE
   *  or CONSISTENCY_CHECK (the only two states `allowedTools` offers these three tools in),
   *  run whichever of get_request_history/check_sso_context/verify_out_of_band is still
   *  missing/errored/stale for the CURRENT request_version, using the identity the ENGINE
   *  claims (never anything from the model -- same rule `handleToolCall`'s IDENTITY_ARG_TOOLS
   *  guard already enforces for a model-issued call), then re-evaluate so the state can
   *  advance within this same tick.
   *
   *  These are synthetic, server-originated calls: no AAI `call_id` ever asked for them, so
   *  nothing here touches `pendingToolResults` -- there is no tool.result to send back over
   *  the wire, only a ToolLogEntry (evidence of what was checked, same shape a model-issued
   *  call would produce) and a diagnostics event (flight recorder visibility).
   *
   *  If the model DOES call one of these itself first, `lookupNeedsRun` sees a fresh result
   *  already logged for the current version and skips it -- no double-run, and I3 (a version
   *  bump makes the prior version's evidence stale) still re-triggers every one of the three,
   *  model-issued or not, exactly as it did before this fix for a model-issued call.
   *
   *  Never touches a terminal/ACTION tool -- that stays `runTerminalActionsIfNeeded`'s job
   *  alone, and this method only ever fires in EVIDENCE/CONSISTENCY_CHECK, states no terminal
   *  tool is ever offered in. LAW 2 is unaffected: this can only ever produce more
   *  PENDING-state evidence, never a verdict, and the ceiling this call can reach on its own
   *  is still whatever the engine computes -- STAGE at most. */
  private runLookupsIfNeeded(): void {
    if (!this.last) return;
    const output = this.last;
    if (output.state !== 'EVIDENCE' && output.state !== 'CONSISTENCY_CHECK') return;
    if (!output.claimed_identity_id) return;

    let ran = false;
    for (const name of LOOKUP_TOOLS) {
      if (!this.lookupNeedsRun(name, output.request_version)) continue;
      const key = `${name}@${output.request_version}`;
      if (this.lookupAbandoned.has(key)) continue; // a real backend bug, not a model that never called it -- see the field doc comment

      const args = { identity_id: output.claimed_identity_id, request_version: output.request_version };
      try {
        const result = this.opts.mock(name, args, this.opts.seed, this.mockCtx);
        this.logs.tools.push({ id: this.nextToolId(), name, t_ms: this.nowT(), args, result });
        // Deliberately its own diag kind, never 'error' -- 'error' is `recoverFromDispatchError`'s
        // channel for a caught THROW during real AAI event dispatch; a lookup the mock
        // simply answered (even with `{error: ...}` inside the result) is not that.
        this.diag('server_lookup', { name, request_version: output.request_version, status: result.error ? 'error' : 'ok' });
        ran = true;
      } catch (err) {
        const attempts = (this.lookupAttempts.get(key) ?? 0) + 1;
        this.lookupAttempts.set(key, attempts);
        const message = err instanceof Error ? err.message : String(err);
        this.diag('server_lookup_error', { name, request_version: output.request_version, attempt: attempts, message });
        if (attempts >= CallSession.MAX_LOOKUP_ATTEMPTS) {
          this.lookupAbandoned.add(key);
          // One logged failed entry -- evidence of what was tried (`pendingCard` in
          // evidence/fromTools.ts grades an errored result PENDING, same as "never ran") --
          // so the flight recorder and the tools log both show this lookup was genuinely
          // attempted and genuinely failed, not silently skipped.
          this.logs.tools.push({
            id: this.nextToolId(),
            name,
            t_ms: this.nowT(),
            args: { ...args, attempt: attempts },
            result: { error: 'internal_error', message },
          });
          this.diag('server_lookup_abandoned', { name, request_version: output.request_version, attempts });
        }
      }
    }
    if (ran) this.applyEvaluate();
  }

  /** Fix round 1, finding 1: picks (and remembers) the next stall line for `kind`, scoped to
   *  THIS call for its whole lifetime -- `stallLineFor` itself is pure and never mutates
   *  `used`, so the mutation (recording that a line was said) happens here, the one place
   *  that's actually allowed to have state. */
  private pickStallLine(kind: StallKind): string {
    const used = this.usedStalls.get(kind) ?? new Set<string>();
    const line = stallLineFor(kind, used);
    used.add(line);
    this.usedStalls.set(kind, used);
    return line;
  }

  private promptCtx(output: EngineOutput): PromptCtx {
    const claimed_identity_name = output.claimed_identity_id
      ? (this.opts.seed.identities.find((i) => i.id === output.claimed_identity_id)?.name ?? null)
      : null;
    return {
      company: this.opts.seed.company,
      agent_name: this.agentName,
      claimed_identity_name,
      state: output.state,
      stall_kind: stallKindFor(output),
      stalls: { pick: (kind: StallKind) => this.pickStallLine(kind) },
    };
  }

  private applyEvaluate(): void {
    const output = evaluate(this.buildEngineInput());
    // Flight recorder flood fix (2026-09-03, founder-observed live): a five-minute live call
    // produced 1,998 `evaluate` diag events -- one per tick() -- and hit the bundle's
    // MAX_SERVER_EVENTS_PER_BUNDLE cap at 46 seconds, crowding out everything else. Only
    // record a fresh `evaluate` event when the verdict, state, goal code, or which rules
    // fired (`reasons`) actually changed from the last one RECORDED (the first is always
    // kept) -- this changes only whether a diag event is written, never what tick() itself
    // computes (`output`/`this.last` are unaffected).
    //
    // Detail payload (founder ruling, 2026-09-09, PROVEN gap): a bundle that only recorded
    // {verdict, state} on a transition couldn't say WHY -- which assurance-checklist item
    // was false, which rule row fired, or which evidence card flagged -- and it had to be
    // reconstructed by hand twice in one week. `evaluateDiagDetail` below adds rule_hit,
    // the assurance checklist, evidence cards trimmed to {id, kind, status} (no quotes, no
    // facts, no transcript text -- LAW 4: this stays diagnostics, never evidence), the
    // challenge counters, and per-field readback confirmation. Still not the full
    // EngineOutput (ledger, goal, ChallengeSpec detail, quotes are all left out).
    const evaluateSignature = JSON.stringify({
      verdict: output.verdict,
      state: output.state,
      goal: output.goal.code,
      reasons: output.reasons,
    });
    if (evaluateSignature !== this.lastEvaluateSignature) {
      this.lastEvaluateSignature = evaluateSignature;
      this.diag('evaluate', evaluateDiagDetail(output));
    }
    const goalKey = JSON.stringify(output.goal);
    if (goalKey !== this.previousGoalKey) {
      this.previousGoalKey = goalKey;
      this.opts.aai.send({
        type: 'session.update',
        session: {
          system_prompt: renderPrompt(output.goal, this.promptCtx(output)),
          tools: toolSchemasFor(output.allowed_tools),
          input: {
            keyterms: output.goal.keyterms.slice(0, 100),
            turn_detection: { min_silence: output.goal.turn_detection_hint === 'patient' ? 1200 : 600 },
          },
        },
      });
      this.logs.actions.push({
        id: this.nextActionId(),
        kind: 'session_config_updated',
        t_ms: this.nowT(),
        detail: `goal=${output.goal.code}`,
      });
      this.diag('session_config_updated', {
        goal_code: output.goal.code,
        keyterms_count: output.goal.keyterms.length,
        tools_count: output.allowed_tools.length,
        has_turn_detection: !!output.goal.turn_detection_hint,
      });
      // The hard cap starts the moment CLOSE is first rendered (session.update just sent
      // it) -- not from `this.last = output` below, which would fire on every tick, and not
      // from `reply.done`, which is exactly the event this cap exists to cover the absence
      // of. See `armClose`'s own doc comment.
      if (output.goal.code === 'CLOSE') {
        // Review fix (2026-09-15, Critical): the engine has just rendered a genuinely FRESH
        // CLOSE (this branch only runs on a goalKey change) -- if an idle+NO_ACTION override
        // was still pending (the caller resumed with a real request before that earlier
        // goodbye was ever confirmed -- see `currentCloseSentence`'s own doc comment), this
        // rendering supersedes it entirely: a live, engine-driven close, not a continuation
        // of the earlier idle event. Clear both the stale sentence AND its `idle_timeout`
        // attribution -- this fresh CLOSE ends `agent_closed`/`close_timeout` like any other
        // organic one, never `idle_timeout`.
        if (this.closeSentenceOverride) {
          this.closeSentenceOverride = null;
          this.idleEndReason = null;
        }
        this.armClose();
      }
    }
    this.last = output;
  }

  /** reply.create fix, round 2 (2026-09-13): true when a transition from `fromCode` to
   *  `toCode` leaves the agent with something it must say that nothing else will prompt it
   *  to say -- ANNOUNCE_FROZEN/ANNOUNCE_STAGED/ANNOUNCE_ESCALATED/CLOSE always (their whole
   *  point is to state an outcome the instant the engine reaches it), or leaving a holding
   *  pattern (STALL/CONTAIN/CONTAIN_NO_DISCLOSURE -- Important 4, 2026-09-13 review: fsm.ts
   *  returns CONTAIN_NO_DISCLOSURE, not CONTAIN, for EVIDENCE under pressure, so it needs
   *  the same treatment) for a genuinely different goal (STALL/CONTAIN* -> STALL is excluded
   *  on purpose: consecutive holding-line variants are always caller-turn-driven in
   *  practice, same as every other in-conversation goal change -- AssemblyAI's own automatic
   *  turn-taking already covers that case). Never GREET (the initial greeting is the AAI
   *  session's own `greeting` field from the FIRST session.update, built in aai/config.ts --
   *  not this per-goal one at all). `fromCode === toCode` is deliberately excluded even
   *  when both are holding goals: that is not a "change", it's the same STALL/CONTAIN*
   *  pattern with a fresh line, which is the caller-turn-driven case this function exists to
   *  NOT force. Called from exactly two places: `maybeSendReplyCreateForTick` (once per
   *  tick, comparing the goal at tick-start to the goal the tick settled on -- this is what
   *  coalesces an intermediate ANNOUNCE_* into the CLOSE it lands on in the same tick) and
   *  `maybeSendReplyCreateAfterReplyDone` (comparing a just-finished reply's own recorded
   *  label to the current goal, to catch up on whatever was owed while that reply was busy
   *  speaking). */
  private mustForceSpeak(fromCode: GoalCode | null, toCode: GoalCode): boolean {
    if (toCode === 'GREET') return false;
    // Same CODE re-rendering (e.g. a fresh evidence quote changing the keyterms list, or a
    // new stall/challenge/readback line for the SAME code) is not a "change" -- only a
    // different code is something new the caller hasn't been told yet.
    if (fromCode === toCode) return false;
    if (CallSession.FORCE_SPEAK_GOALS.has(toCode)) return true;
    if (fromCode && CallSession.HOLDING_GOALS.has(fromCode) && toCode !== 'STALL') return true;
    return false;
  }

  private static readonly FORCE_SPEAK_GOALS: ReadonlySet<GoalCode> = new Set<GoalCode>([
    'ANNOUNCE_FROZEN',
    'ANNOUNCE_STAGED',
    'ANNOUNCE_ESCALATED',
    'CLOSE',
  ]);
  // Important 4 (2026-09-13 review): CONTAIN_NO_DISCLOSURE added -- fsm.ts's own EVIDENCE
  // pressure-response returns THIS code, not plain CONTAIN; both are holding patterns whose
  // consecutive same-code variants are caller-turn-driven, but whose exit to a genuinely
  // different goal is not.
  private static readonly HOLDING_GOALS: ReadonlySet<GoalCode> = new Set<GoalCode>(['STALL', 'CONTAIN', 'CONTAIN_NO_DISCLOSURE']);

  /** reply.create fix, round 2: at most one send per tick, decided once `tick()`'s own
   *  evaluate/lookups/terminal-actions cascade has fully settled -- `goalAtTickStart` is
   *  what `tick()` captured before any of that ran; `this.last.goal.code` here is the
   *  FINAL, settled goal. Coalesces any intermediate goal the tick passed through (e.g.
   *  ANNOUNCE_FROZEN on the way to CLOSE) into whichever goal the tick actually landed on --
   *  see the class-field doc comment above `replyGoalAtStart` for why this is the correct,
   *  race-proof design and not merely a simplification. Never sends while a reply
   *  is in flight or our own prior `reply.create` is still awaiting its `reply.started`
   *  -- `maybeSendReplyCreateAfterReplyDone` is what catches up once that clears.
   *
   *  Design E (2026-09-15, turn-order design change): also fires for a FRESH QUESTION_GOALS
   *  rendering (`isFreshQuestionGoal`) discovered on a CALLER-TURN-TRIGGERED tick
   *  (`callerTurnTick`, see `tickTriggeredByCallerTurn`'s own doc comment for exactly why this
   *  guard is necessary -- without it, a challenge/readback the engine advances to WITHIN the
   *  same tick as a prior reply's own `reply.done` -- before the caller has said anything new
   *  -- would fire a second, back-to-back ask), on top of the original `mustForceSpeak`
   *  (CODE-change) check -- see that method's own doc comment. Every send now also carries
   *  `instructedSentenceFor`'s one-shot instructions (CLOSE included, not just
   *  QUESTION_GOALS): the standing `system_prompt` alone is not enough any more, now that the
   *  automatic reply this same caller turn triggers is standing-rule-bound to a holding beat
   *  and may still be composing under a stale prompt either way (docs/TEST-PLAN.md:
   *  "system_prompt applies on the next turn"). `lastAskedQuestionKey` is updated here,
   *  before the send, so a reply.done for whichever reply happens to answer first (ours or
   *  AssemblyAI's own automatic one -- see `sendReplyCreate`'s own doc comment on why the two
   *  cannot be told apart from labelling alone) does not re-trigger a second proactive send
   *  for the SAME rendering from `maybeSendReplyCreateAfterReplyDone` below;
   *  `maybeReaskQuestion` (verified against the reply's own transcript) is what covers a
   *  rendering the first send did not land. A fresh QUESTION_GOALS key discovered on a
   *  NON-caller-turn tick is simply left for the next caller-turn tick to pick up (the key
   *  itself never expires -- `isFreshQuestionGoal` stays true until something actually asks
   *  it), never lost.
   *
   *  `owedQuestionGoalKey` is recorded (or cleared) BEFORE the busy guard, on every
   *  caller-turn-triggered fresh question, whether or not this call actually gets to send --
   *  see that field's own doc comment for exactly why `maybeSendReplyCreateAfterReplyDone`
   *  needs this narrower signal rather than re-deriving `isFreshQuestionGoal` on its own. */
  private maybeSendReplyCreateForTick(goalAtTickStart: GoalCode | null, callerTurnTick: boolean): void {
    if (this.ended || !this.last) return;
    const goal = this.last.goal;
    const finalGoal = goal.code;
    const freshQuestion = callerTurnTick && this.isFreshQuestionGoal(goal);
    if (freshQuestion) this.owedQuestionGoalKey = JSON.stringify(goal);
    if (this.speaking || this.replyCreateAwaitingStart) return;
    const forceSpeak = this.mustForceSpeak(goalAtTickStart, finalGoal);
    // BRAKE (2026-09-15): only ever holds back the freshQuestion path itself -- a `forceSpeak`
    // transition (leaving a holding pattern for a genuinely new goal) is a different mechanism
    // than the fragmentation problem this brake exists for, and is never suppressed by it. See
    // `shouldBrakeFreshQuestion`'s own doc comment for the full incident and why this is
    // deliberately scoped to THIS method only, never the reply-done catch-up path.
    if (freshQuestion && !forceSpeak && this.shouldBrakeFreshQuestion()) {
      this.diag('question_fragment_brake_applied', { goal_code: finalGoal });
      return;
    }
    if (!forceSpeak && !freshQuestion) return;
    if (freshQuestion) {
      this.lastAskedQuestionKey = JSON.stringify(goal);
      this.pendingQuestionAnswerAttemptSeen = false;
      this.owedQuestionGoalKey = null;
    }
    this.sendReplyCreate(finalGoal, 'tick_end', this.instructedSentenceFor(goal));
  }

  /** Sends the actual `reply.create` (never here without going through this one method --
   *  requirement 5: every send gets the same diag event + action-log entry). Guarded by
   *  `this.ended` for the same reason every other outbound send in this class is: a call
   *  that has already ended must never produce one more websocket message. Records
   *  `pendingRequestedGoal` so the very next `reply.started` labels itself correctly (see
   *  that case's own comment and the class-field doc comment on `replyGoalAtStart`).
   *
   *  `instructions` (reply.create fix, round 3; Design E, 2026-09-15, extends every caller
   *  site to supply one, not just `scheduleCloseIfNeeded`'s close_retry path -- see
   *  `instructedSentenceFor`): a one-shot payload passed straight through to AssemblyAI's own
   *  `reply.create.instructions` field (VERIFY-AT-BUILD, docs/ASSEMBLYAI_INTEGRATION.md --
   *  "does not modify system_prompt"). A caller that has no exact sentence for the current
   *  goal (ANNOUNCE_*, STALL, CONTAIN*, GREET) omits it and relies on the standing
   *  `system_prompt` alone, unchanged from before this fix.
   *
   *  CLOSE is no longer bounded by an attempt count (round 4: CLOSE_REPLY_ATTEMPTS is gone --
   *  see the class-field doc comment on `closeReplySendCount`/CLOSE_TOTAL_MS for why). Every
   *  send still records an uncapped, purely-observational `attempt` number in the diag event
   *  -- `countAttempt` (round 4, requirement 8) lets a caller (only `armCloseRetryTimer`'s
   *  retry after an empty-transcript reply) suppress bumping it for a send that isn't really
   *  a fresh attempt. Also arms `armReplyCreateLostTimer` (requirement 5): every send starts
   *  a fresh watch for its own `reply.started` never showing up. */
  private sendReplyCreate(goalCode: GoalCode, reason: string, instructions?: string, opts?: { countAttempt?: boolean }): void {
    if (this.ended) return;
    // Round 5: once the goodbye is transcript-confirmed, nothing more is ever owed -- not
    // another CLOSE retry (the words were heard) and not any other goal's reply.create
    // either. See the class-field doc comment on `goodbyeConfirmed` above.
    if (this.goodbyeConfirmed) return;
    // HOLD-WITHOUT-FOLLOW-UP fix, defect 2 (2026-09-17 review): ANY instructed send that
    // actually goes out from here -- a goal change, a question re-ask, a CLOSE retry, the
    // idle-goodbye override, or the hold-followup's own restatement -- means the caller is
    // about to hear something real. Clear whatever hold-followup timer is pending (it is now
    // redundant: for a QUESTION_GOALS code the re-ask is faster, 400ms vs 2500ms, and always
    // wins the race) and mark the turn as already followed-up so `maybeArmHoldFollowup` cannot
    // arm a FRESH one later in this same caller turn either -- at most one instructed send
    // ever follows a single hold, regardless of which mechanism sent it. A no-op the vast
    // majority of the time (no hold-followup timer is ever pending), and harmless even then:
    // `holdFollowupArmedForTurn` resets on the caller's own next turn either way.
    this.clearHoldFollowupTimer();
    this.holdFollowupArmedForTurn = true;
    if (goalCode === 'CLOSE' && (opts?.countAttempt ?? true)) {
      this.closeReplySendCount += 1;
    }
    const msg: ReplyCreateMessage = instructions ? { type: 'reply.create', instructions } : { type: 'reply.create' };
    this.opts.aai.send(msg);
    this.replyCreateAwaitingStart = true;
    this.pendingRequestedGoal = goalCode;
    this.armReplyCreateLostTimer();
    this.logs.actions.push({
      id: this.nextActionId(),
      kind: 'session_config_updated',
      t_ms: this.nowT(),
      detail: `reply_create:${goalCode}:${reason}`,
    });
    this.diag('reply_create_sent', {
      goal_code: goalCode,
      reason,
      ...(goalCode === 'CLOSE' ? { attempt: this.closeReplySendCount } : {}),
    });
  }

  /** Round 4, requirement 5: watches the `reply.create` just sent for its own `reply.started`
   *  -- if REPLY_CREATE_LOST_MS elapses with none, treats it as lost (dropped by AssemblyAI,
   *  or superseded by the service's own turn-driven reply that never labels itself as a
   *  response to ours) and clears `replyCreateAwaitingStart` so a fresh send is allowed.
   *  Cleared (never fires) whenever a `reply.started`/`reply.done` actually arrives for the
   *  outstanding request, or the call ends. If the current goal is still CLOSE once a loss is
   *  detected, arms a fresh retry via the same spaced path a mismatched reply would (this is
   *  the ONLY way `CallSession` proactively recovers from a request AssemblyAI never
   *  acknowledged at all -- reply.done-driven retries can't fire for a reply.started that
   *  never happened). */
  private armReplyCreateLostTimer(): void {
    this.clearReplyCreateLostTimer();
    this.replyCreateLostTimer = setTimeout(() => {
      this.replyCreateLostTimer = null;
      if (this.ended || !this.replyCreateAwaitingStart) return;
      this.diag('reply_create_lost', {});
      this.replyCreateAwaitingStart = false;
      this.pendingRequestedGoal = null;
      if (this.last?.goal.code === 'CLOSE') {
        this.closeLastReplyWasEmpty = false;
        this.closeLostStreak += 1;
        // Fix (2026-09-16): only a channel that has NEVER once acknowledged a CLOSE reply
        // (see `closeEverStarted`'s own doc comment) is a candidate for early abandonment --
        // once at least one CLOSE reply has actually started, round 4's original design
        // (unbounded, time-budgeted retries, backstopped only by the 45s absolute cap) is
        // preserved unchanged, so an isolated stretch of a few lost sends in an otherwise-live
        // exchange is ridden out exactly as it always was.
        if (!this.closeEverStarted && this.closeLostStreak >= CallSession.MAX_CLOSE_LOST_STREAK) {
          this.abandonClose('reply_create_lost_streak');
          return;
        }
        this.armCloseRetryTimer();
      }
    }, CallSession.REPLY_CREATE_LOST_MS);
    this.replyCreateLostTimer.unref?.();
  }

  /** Fix (2026-09-16): gives up on ever hearing the goodbye spoken, instead of burning the
   *  rest of CLOSE_TOTAL_MS on retries that have already failed `MAX_CLOSE_LOST_STREAK` times
   *  in a row the exact same way (see that constant's own doc comment for the live incident).
   *  LAW 2 holds regardless: the verdict was already sealed and containment already ran the
   *  moment CLOSE was first rendered (`applyEvaluate`'s goal-changed branch) -- this only ends
   *  the call sooner once it's clear no more reply.create is going to land. `close_abandoned`
   *  is a distinct diagnostics/end-reason value from `close_timeout` (the unchanged 45s
   *  backstop for the OTHER failure shape: replies that DO start but never match) so the two
   *  causes stay tellable apart in the flight recorder -- never a verdict, never evidence (LAW
   *  4), just a fact about how the call ended. Round 4's idle-deferred-goodbye override
   *  (`idleEndReason`) still wins here exactly as it does for `armClose`'s own hard cap, so an
   *  idle-triggered close that then gets abandoned still reports `idle_timeout`, not
   *  `close_abandoned`. */
  private abandonClose(reason: string): void {
    if (this.ended) return;
    this.diag('close_abandoned', { reason, streak: this.closeLostStreak });
    this.end(this.idleEndReason ?? 'close_abandoned');
  }

  private clearReplyCreateLostTimer(): void {
    if (this.replyCreateLostTimer) {
      clearTimeout(this.replyCreateLostTimer);
      this.replyCreateLostTimer = null;
    }
  }

  /** Fired from `reply.done`, after the tool.result flush/discard rule has already run
   *  (requirement 3) -- catches up on whatever `maybeSendReplyCreateForTick` could not send
   *  while this reply was busy speaking. `replyId`'s own recorded label (`replyGoalAtStart`,
   *  set at ITS `reply.started` -- see that case's own comment) is compared against the
   *  CURRENT goal (`this.last.goal.code`, still the goal from BEFORE this event's own
   *  `tick()` runs): if they differ and `mustForceSpeak` says the current goal must still be
   *  spoken, send one `reply.create` for it and label the reply that follows with it
   *  (`sendReplyCreate` sets `pendingRequestedGoal`). If they match, the reply that just
   *  finished already said what was owed -- nothing left to force. Defensive `this.speaking
   *  || this.replyCreateAwaitingStart` guard: `this.speaking` was just set false by the
   *  caller and nothing else in this handler can set `replyCreateAwaitingStart`, so this
   *  should never actually be true here, but "never send while busy" is cheap to keep
   *  airtight at every call site.
   *
   *  Design E (2026-09-15): also catches up a FRESH QUESTION_GOALS rendering, but ONLY when
   *  it is the SPECIFIC key `owedQuestionGoalKey` records (a caller-turn-triggered tick found
   *  it fresh but could not send because a reply was in flight) -- deliberately NOT a bare
   *  `isFreshQuestionGoal(goal)` re-check. See `owedQuestionGoalKey`'s own doc comment for the
   *  PROVEN failure mode a bare re-check has: a fresh key that emerged from a NON-caller-turn
   *  tick's own internal cascade (e.g. this SAME reply's own `reply.done`, just above, logging
   *  `challenge_issued` and letting the engine render its own next challenge before the caller
   *  has said anything) would otherwise be caught here too, using `this.last` that is STILL
   *  STALE relative to that just-logged action (evaluate() has not rerun for this event yet),
   *  asking a question the caller was never actually owed yet -- and setting
   *  `replyCreateAwaitingStart` right before this SAME event's own trailing `tick()` might
   *  discover CLOSE, silently blocking the real CLOSE `reply.create` behind the busy guard. */
  private maybeSendReplyCreateAfterReplyDone(replyId: string): void {
    if (this.ended || !this.last) return;
    if (this.speaking || this.replyCreateAwaitingStart) return;
    const goal = this.last.goal;
    const label = this.replyGoalAtStart.get(replyId) ?? null;
    const current = goal.code;
    const owedQuestion = this.owedQuestionGoalKey !== null && this.owedQuestionGoalKey === JSON.stringify(goal);
    if (!this.mustForceSpeak(label, current) && !owedQuestion) return;
    if (owedQuestion) {
      this.lastAskedQuestionKey = JSON.stringify(goal);
      // BRAKE (2026-09-15): deliberately NOT re-checked here -- see
      // `shouldBrakeFreshQuestion`'s own doc comment for why re-applying the timing brake in
      // this catch-up path risks a real deadlock (the fragment-gap it would compare against
      // never shrinks once the caller falls silent waiting for exactly this question). This
      // IS "the next genuine turn" the brake defers to -- always allowed to deliver the owed
      // question, unconditionally, once reached.
      this.pendingQuestionAnswerAttemptSeen = false;
      this.owedQuestionGoalKey = null;
    }
    this.sendReplyCreate(current, 'reply_done_goal_diverged', this.instructedSentenceFor(goal));
  }

  /** LAW 2: STAGE is the ceiling this ever reaches on its own. The server runs the owed
   *  tools itself (the LLM never triggers a terminal action -- it only reaches ACTION state
   *  once the engine has already decided the verdict), then re-runs `evaluate` over the now-
   *  frozen logs: `countersign.recomputed` is the proof that adding the record of the
   *  actions taken did not change the verdict that authorized them.
   *  IMPORTANT 3 (final review): the tool-running step itself used to live in
   *  `runOwedTerminalActions` (call/terminalActions.ts), shared verbatim with replay.ts.
   *  Fix round 2 (LAW 2/3 re-review finding, IMPORTANT): the live-call path now runs its own
   *  per-action, try/catch, retry-and-abandon-bounded loop below instead -- `terminalActions
   *  .ts`'s `runOwedTerminalActions` is UNCHANGED and still used verbatim by replay.ts (a
   *  single-pass corpus replay against the deterministic mock has no live "next tick" to
   *  retry on, and no history of ever needing to -- see replay.test.ts's own unchanged
   *  18-corpus-result assertion). `argsForTerminalTool` (still exported from
   *  terminalActions.ts) is reused here, not reimplemented. Called from every `tick()` until
   *  it settles (see `terminalActionsSettled`'s own doc comment on the class fields above),
   *  not just once. */
  private runTerminalActionsIfNeeded(): void {
    if (this.terminalActionsSettled || !this.last) return;
    const output = this.last;

    if (this.terminalActionsOwed === null) {
      const terminal = output.verdict === 'STAGE' || output.verdict === 'FREEZE' || output.verdict === 'ESCALATE';
      if (!terminal || output.required_actions.length === 0) return;
      // First tick a terminal verdict with owed actions is observed: freeze the snapshot
      // this whole retry loop works from (see the class-field doc comment on why this is
      // never re-read from a later `evaluate()`), and freeze which verdict "recomputed"
      // means matching -- `this.last` itself is not reassigned again until (if ever) every
      // owed action actually succeeds. Also capture conversation and actions counts at this
      // instant for position-based truncation in the seal entry (P1 leak fix).
      this.terminalActionsOwed = [...output.required_actions];
      this.terminalVerdictSnapshot = output.verdict;
      this.terminalActionCounts = {
        conversation_count: this.logs.conversation.length,
        actions_count: this.logs.actions.length,
      };
      this.diag('terminal_action', { verdict: output.verdict, actions: this.terminalActionsOwed });
    }

    const owed = this.terminalActionsOwed;
    const stillOwed = owed.filter((name) => !this.terminalActionSucceeded.has(name) && !this.terminalActionsAbandoned.has(name));

    for (const name of stillOwed) {
      try {
        const args = argsForTerminalTool(name, this.opts.seed, output, this.terminalActionCounts ?? undefined);
        const result = this.opts.mock(name, args, this.opts.seed, this.mockCtx);
        if (name === 'open_incident') this.mockCtx.incident_index += 1;
        this.logs.tools.push({ id: this.nextToolId(), name, t_ms: this.nowT(), args, result });
        this.terminalActionSucceeded.add(name);
        this.diag('terminal_action_result', { name, status: 'ok' });
      } catch (err) {
        const attempts = (this.terminalActionAttempts.get(name) ?? 0) + 1;
        this.terminalActionAttempts.set(name, attempts);
        const message = err instanceof Error ? err.message : String(err);
        // Record the failed attempt as a real (failed) tool call -- evidence of what was
        // actually tried, same shape a live tool.call's own backfill uses
        // (recoverFromDispatchError above). LAW 3/I4 note: this does NOT retroactively
        // change `output`/`this.last` (already computed and frozen for this pass) -- it only
        // affects a FUTURE `evaluate()`, which this method deliberately does not call again
        // until every owed action has actually succeeded (see below).
        this.logs.tools.push({
          id: this.nextToolId(),
          name,
          t_ms: this.nowT(),
          args: { request_version: output.request_version, attempt: attempts },
          result: { error: 'internal_error', message },
        });
        this.diag('terminal_action_result', { name, status: 'error', attempt: attempts, message });
        if (attempts >= CallSession.MAX_TERMINAL_ACTION_ATTEMPTS) {
          this.terminalActionsAbandoned.add(name);
          this.diag('terminal_action_abandoned', { name, attempts });
        }
      }
    }

    const remaining = owed.filter((name) => !this.terminalActionSucceeded.has(name) && !this.terminalActionsAbandoned.has(name));
    if (remaining.length > 0) return; // still retryable actions left -- try again on the next tick

    this.terminalActionsSettled = true;
    if (this.terminalActionsAbandoned.size > 0) {
      // At least one required action was abandoned after MAX_TERMINAL_ACTION_ATTEMPTS: per
      // the ruling, the export/countersign line must NEVER be produced in this case (no new
      // ScreenState/protocol field exists for "a terminal action failed", and adding one is
      // out of this fix's scope) -- the screen simply, visibly lacks the export hash instead
      // of looking complete, exactly as it would mid-call. `exportHash`/`countersignRecomputed`
      // are left exactly as they already were (null/false) -- THIS method never calls
      // `applyEvaluate()` again once settled-with-abandonment. `this.last` itself is NOT
      // frozen (every `tick()` still re-derives it at the top, before this method even runs,
      // independent of terminal-action status) -- but I4 (rules.ts) only ever downgrades a
      // STAGE/PENDING verdict for an incomplete evaluation, never FREEZE/ESCALATE, so a
      // failed terminal action's own logged error never perturbs a verdict that's already
      // terminal; the screen's verdict stays what it was, the export hash simply never
      // appears.
      return;
    }

    // Every owed action landed for real: NOW (and only now) re-run the engine over the
    // frozen logs (the countersign) and build the export.
    const verdictBeforeActions = this.terminalVerdictSnapshot;
    this.applyEvaluate();
    const after = this.last;
    this.countersignRecomputed = after ? after.verdict === verdictBeforeActions : false;
    this.diag('countersign', { recomputed: this.countersignRecomputed, verdict: after?.verdict ?? null });

    if (after) {
      this.pendingExport = buildEvidenceExport(this.opts.session_id, after, new Date(this.opts.now()).toISOString())
        .then((exp) => {
          // RT-8-export-race fix: record the computed hash on the diagnostics stream FIRST,
          // unconditionally -- otherwise a fast hang-up (this.ended already true by the time
          // this resolves) meant the root hash was never recorded anywhere at all: no
          // `exportHash` getter exists, and the end-guard below deliberately skips the state
          // push that would otherwise have carried it. This is diagnostics only (LAW 4: not
          // Evidence, not a verdict) -- it does not change what the browser/ws leg receives.
          this.diag('export_computed', { root_hash: exp.root_hash });
          // End-guard (fix round 1 minor): the session may have ended (browser closed,
          // aai error/ended) while this hash was still computing -- don't resurrect a
          // closed session with a late state push.
          if (this.ended) return;
          this.exportHash = exp.root_hash;
          this.emitState();
        })
        .catch(() => {
          // A failed hash computation must never block or crash the call; the ScreenState
          // simply keeps export_hash null until (if ever) it succeeds.
        })
        .then(() => {
          this.pendingExport = null;
        });
    }
  }

  /** Finding 5 (final review): lets a test await the export hash deterministically instead
   *  of a real-clock `setTimeout` guess -- resolves once the terminal-action countersign's
   *  hash computation (if one is in flight) has settled, one way or another. Resolves
   *  immediately when nothing is pending. */
  whenIdle(): Promise<void> {
    return this.pendingExport ?? Promise.resolve();
  }

  private emitState(): void {
    if (!this.last) return;
    const state = deriveScreenState({
      session_id: this.opts.session_id,
      t_ms: this.nowT(),
      engineInput: this.buildEngineInput(),
      output: this.last,
      speaking: this.speaking,
      export_hash: this.exportHash,
      recomputed: this.countersignRecomputed,
      link: 'live',
    });
    this.opts.onServerEvent({ type: 'state', state });
  }
}
