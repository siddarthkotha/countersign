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
import type { AaiEvent, AaiSocket } from '../aai/types.js';
import { isToolName, toolLogEntryFromCall, utteranceFromTranscript } from './events.js';
import { renderPrompt, type PromptCtx } from './prompt.js';
import { toolSchemasFor, paramsFor } from './allowlist.js';
import { deriveScreenState } from '../screen/state.js';
import { validateToolArgs } from './validate.js';
import { stallKindFor, stallLineFor, type StallKind } from './stalls.js';
import { argsForTerminalTool } from './terminalActions.js';

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
   *  disconnected 47 seconds of off-goal turns had already played. Two config values, kept
   *  local to this class (not `config.ts` -- owned by another lane in this worktree split):
   *  `CLOSE_GRACE_MS` lets the CLOSE line's own audio actually finish flushing to the wire
   *  before the socket closes; `CLOSE_TIMEOUT_MS` is the hard cap in case `reply.done` for
   *  the CLOSE goal never arrives at all (a dropped AAI reply, a model that never speaks).
   *  Both timers funnel into the existing `end()` path -- nothing new about HOW a call ends,
   *  only WHEN one more automatic trigger fires it. See this task's report for why this is
   *  wired to `state === 'SEALED'` (STAGE/FREEZE/ESCALATE, the only verdicts CLOSE is ever
   *  rendered for today) and deliberately NOT to OUT_OF_SCOPE/NO_ACTION -- a judgment call
   *  flagged for the founder. */
  private static readonly CLOSE_GRACE_MS = 1500;
  private static readonly CLOSE_TIMEOUT_MS = 15_000;
  private closeGraceTimer: ReturnType<typeof setTimeout> | null = null;
  private closeHardCapTimer: ReturnType<typeof setTimeout> | null = null;
  /** Fix round 2 (review finding, Important, 2026-09-11): the reply_id of whichever reply
   *  was in flight (or the most recent one that already finished, or null if none has ever
   *  started) at the EXACT moment the CLOSE goal was first rendered -- i.e. any reply this
   *  is NOT the phrasing of the close line, no matter what `this.last.goal.code` reads by
   *  the time its own `reply.done` arrives. Root cause this fixes: `handleToolCall` also
   *  calls `tick()`, so a tool.call arriving mid-reply can advance the engine to SEALED/
   *  CLOSE WHILE an earlier, unrelated reply is still speaking. That earlier reply's own
   *  `reply.done` -- for a goal phrased before CLOSE ever existed -- would otherwise be
   *  mistaken for the close line finishing, arming the 1.5s hang-up while the actual close
   *  line has not been said yet (or ever will be, if the grace timer fires first). Recorded
   *  once, from `armClose` (the single call site that also arms the hard cap), and never
   *  updated again -- `scheduleCloseIfNeeded` only ever needs to know the ONE stale id to
   *  reject; every reply_id that starts after CLOSE is sent is, by construction, new. */
  private closeStaleReplyId: string | null = null;
  /** The reply_id of the most recent `reply.started` -- tracked purely so `armClose` can
   *  snapshot it into `closeStaleReplyId` above; never consulted anywhere else. */
  private currentReplyId: string | null = null;

  private clearCloseTimers(): void {
    if (this.closeGraceTimer) {
      clearTimeout(this.closeGraceTimer);
      this.closeGraceTimer = null;
    }
    if (this.closeHardCapTimer) {
      clearTimeout(this.closeHardCapTimer);
      this.closeHardCapTimer = null;
    }
  }

  /** Called once, the first tick the goal becomes CLOSE (from `applyEvaluate`'s goal-changed
   *  branch): snapshots whichever reply_id was current at that instant as "stale" (see
   *  `closeStaleReplyId`'s own doc comment) and arms the 15s hard cap in case `reply.done`
   *  for the real close line never arrives at all (a dropped AAI reply, a model that never
   *  speaks). Idempotent via the hard-cap-timer guard: a second call while one is already
   *  pending is a no-op, so a goal that briefly changes away from CLOSE and back (not
   *  possible today -- SEALED is a one-way state -- but defensive regardless) never
   *  re-snapshots a now-stale `currentReplyId` over the original one. */
  private armClose(): void {
    if (this.closeHardCapTimer || this.ended) return;
    this.closeStaleReplyId = this.currentReplyId;
    this.closeHardCapTimer = setTimeout(() => {
      this.closeHardCapTimer = null;
      if (!this.ended) this.end('close_timeout');
    }, CallSession.CLOSE_TIMEOUT_MS);
    this.closeHardCapTimer.unref?.();
  }

  /** Fired from `reply.done`, while `this.last` is still the goal that reply was phrased
   *  for (see `recordGoalCompletionAction`'s own doc comment on that ordering) -- EXCEPT
   *  that is only true when `replyId` actually started after CLOSE was sent (fix round 2,
   *  review finding: a reply already in flight when CLOSE was rendered still finishes on
   *  its own schedule, and its `reply.done` says nothing about whether the close line has
   *  been spoken). A `reply.done` whose `replyId` matches `closeStaleReplyId` is ignored
   *  for hang-up purposes here -- it is still handled completely normally by every other
   *  branch of the `reply.done` case (flush/discard, `recordGoalCompletionAction`, the
   *  diagnostics event); only the arming of the grace timer is skipped. Any OTHER reply_id
   *  -- completed or interrupted -- schedules the hang-up: once SEALED, there is nothing
   *  left for the model to do, so a caller who talks over the close line does not buy the
   *  call more time. The short grace period lets the close line's own audio frames actually
   *  reach the wire before the socket shuts. */
  private scheduleCloseIfNeeded(replyId: string): void {
    if (!this.last || this.last.goal.code !== 'CLOSE') return;
    if (replyId === this.closeStaleReplyId) return;
    if (this.closeGraceTimer || this.ended) return;
    if (this.closeHardCapTimer) {
      clearTimeout(this.closeHardCapTimer);
      this.closeHardCapTimer = null;
    }
    this.closeGraceTimer = setTimeout(() => {
      this.closeGraceTimer = null;
      if (!this.ended) this.end('agent_closed');
    }, CallSession.CLOSE_GRACE_MS);
    this.closeGraceTimer.unref?.();
  }

  constructor(opts: CallSessionOpts) {
    this.opts = opts;
    this.startMs = opts.now();
    this.agentName = resolveAgentName(opts.agent_name);
    opts.aai.on((evt) => this.handleAaiEvent(evt));
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

  end(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    this.clearCloseTimers();
    // Red team item 4 (founder ruling, 2026-09-09): before anything else about ending the
    // call, record the structured fact that it ended -- LAW 3 forbids the SERVER from
    // deciding what that means (a rejected first attempt at this fix, branch
    // worktree-agent-aa25cb13b49be1675 commit a6c8559, stamped ESCALATE here directly; the
    // founder ruled that out precisely because the engine is the only verdict owner). All
    // this does is append one `call_ended` AgentAction (same shape `link_changed` already
    // uses) and let a normal `tick()` -- the SAME re-evaluate/run-terminal-actions/emit-state
    // sequence every other event in this call already goes through -- react to it. If the
    // engine's own rules.ts row 14 turns that into ESCALATE or NO_ACTION, this is where the
    // containment tools (open_incident, alert_principal, seal_evidence_record) actually run
    // and the hash-chained export gets built, through the EXISTING terminal-action path
    // (`runTerminalActionsIfNeeded`) -- nothing new here at all, just one more fact in the
    // log before the last tick.
    //
    // Every ending route funnels through this one method (idle reaper and the per-call cap
    // timer via ws/browser.ts's `endCall`, a caller hangup via `handleBrowser`'s 'end' case,
    // a dropped AAI/browser socket, session.error/session.ended) -- wiring it here alone
    // covers all of them.
    //
    // `tick()`'s own `emitState()` may push one more 'state' event here (e.g. showing the
    // fresh ESCALATE banner) -- that happens BEFORE the `onServerEvent({type:'ended'})` call
    // below, so 'ended' still stays the last websocket event, same as always. The async
    // export-hash continuation inside `runTerminalActionsIfNeeded` already records
    // `export_computed` unconditionally and checks `this.ended` (true from the line above)
    // before ever calling `emitState()` again, so no websocket event follows 'ended' once
    // the hash resolves.
    this.logs.actions.push({ id: this.nextActionId(), kind: 'call_ended', t_ms: this.nowT(), detail: reason });
    this.tick();
    // Flight recorder: whatever this AAI adapter never modeled (mapServerEvent's `default`
    // branch, aai/session.ts) surfaced once here, at the one point every ended call passes
    // through -- `stats()` is optional (FakeAaiSocket has none, since tests only ever emit
    // shapes it knows), so this is a no-op for every fake-AAI call and every test.
    const stats = this.opts.aai.stats?.();
    if (stats) this.diag('aai_unknown_events', stats);
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
        // Changes `conversation`, part of EngineInput -- must tick.
        this.logs.conversation.push(utteranceFromTranscript(evt, this.nowT()));
        this.opts.onActivity?.();
        // Flight recorder: role + text LENGTH only -- never the transcript text itself
        // (that stays evidence-only, LAW 4; diagnostics is not evidence).
        this.diag('transcript', { role: evt.type === 'transcript.user' ? 'user' : 'agent', length: evt.text.length });
        break;
      }

      case 'reply.started':
        // Doesn't touch EngineInput, but flips `this.speaking`, which `emitState()` (called
        // by `tick()`) pushes to the browser as the speaking indicator -- fires once per
        // agent turn (not per-frame), so ticking here costs nothing like `reply.audio` does.
        // Skipping it would leave the browser showing "not speaking" for the whole reply.
        this.speaking = true;
        this.replyFirstAudioRecorded = false;
        // Fix round 2 (review finding, Important): tracked purely so `armClose` can
        // snapshot "whichever reply is in flight right now" the instant CLOSE is first
        // rendered -- see `closeStaleReplyId`'s own doc comment.
        this.currentReplyId = evt.reply_id;
        this.diag('reply.started', {});
        break;

      case 'reply.audio':
        // THE FIX: fires once per AAI audio frame (~100/sec while the agent talks) and
        // touches none of conversation/tools/actions/seed/speaking -- ticking here was the
        // root cause of the flood (1,998 `evaluate` events in 46s, PROVEN from the
        // 2026-09-03 flight-recorder bundle). Forward the frame to the browser and stop
        // (no tick) -- the one-time first-frame diagnostic below still records normally.
        this.opts.onServerEvent({ type: 'audio', data: evt.data });
        // Flight recorder: only the FIRST audio frame of this reply -- a reply can carry
        // dozens of frames, and recording every one was the bulk of what starved the live
        // bundle's event cap (2026-09-03 finding). This is enough to see when audio actually
        // started going out relative to `reply.started`.
        if (!this.replyFirstAudioRecorded) {
          this.replyFirstAudioRecorded = true;
          this.diag('reply.audio.first', {});
        }
        return;

      case 'reply.done':
        this.speaking = false;
        this.recordGoalCompletionAction(evt.status);
        this.diag('reply.done', { status: evt.status });
        // Bug fix (2026-09-11): `this.last` here is still the goal this reply was phrased
        // for (recordGoalCompletionAction's own doc comment) -- if it was CLOSE, the call
        // is done saying what it needs to say and the server hangs up itself. Checked
        // regardless of `evt.status`: an interrupted close still means nothing more is
        // owed (see `scheduleCloseIfNeeded`'s own doc comment). `evt.reply_id` is what lets
        // it reject a stale reply.done for a reply that was already in flight when CLOSE
        // was sent (fix round 2, review finding).
        this.scheduleCloseIfNeeded(evt.reply_id);
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
        break;

      case 'input.speech.started':
        // Sends its own 'flush' ServerEvent directly (not via tick/emitState) and touches no
        // EngineInput field -- no reason to re-run evaluate too.
        this.opts.onServerEvent({ type: 'flush' });
        this.diag('input.speech.started', {});
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
  }

  /** When the agent's reply for an ASK_CHALLENGE/READBACK goal completes, the server -- not
   *  the LLM -- writes the record of what was issued (v2 ruling: the LLM never writes
   *  evidence). `this.last` is still the goal computed BEFORE this reply.done, i.e. the goal
   *  the reply that just finished was phrased for. */
  private recordGoalCompletionAction(status: string): void {
    if (status !== 'completed' || !this.last) return;
    const goal: PhrasingGoal = this.last.goal;
    if (goal.code === 'ASK_CHALLENGE' && goal.challenge) {
      this.logs.actions.push({
        id: this.nextActionId(),
        kind: 'challenge_issued',
        t_ms: this.nowT(),
        challenge_id: goal.challenge.challenge_id,
        spec: goal.challenge,
      });
    } else if (goal.code === 'READBACK' && goal.readback) {
      this.logs.actions.push({
        id: this.nextActionId(),
        kind: 'readback_issued',
        t_ms: this.nowT(),
        field: goal.readback.field,
        value: goal.readback.value,
      });
    }
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
    this.applyEvaluate();
    this.runLookupsIfNeeded();
    this.runTerminalActionsIfNeeded();
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
      // The hard cap starts, and the stale reply_id gets snapshotted, the moment CLOSE is
      // first rendered (session.update just sent it) -- not from `this.last = output`
      // below, which would fire on every tick, and not from `reply.done`, which is exactly
      // the event this cap exists to cover the absence of. See `armClose`'s own doc comment.
      if (output.goal.code === 'CLOSE') this.armClose();
    }
    this.last = output;
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
      // owed action actually succeeds.
      this.terminalActionsOwed = [...output.required_actions];
      this.terminalVerdictSnapshot = output.verdict;
      this.diag('terminal_action', { verdict: output.verdict, actions: this.terminalActionsOwed });
    }

    const owed = this.terminalActionsOwed;
    const stillOwed = owed.filter((name) => !this.terminalActionSucceeded.has(name) && !this.terminalActionsAbandoned.has(name));

    for (const name of stillOwed) {
      try {
        const args = argsForTerminalTool(name, this.opts.seed, output);
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
