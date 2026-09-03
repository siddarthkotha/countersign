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
import { runOwedTerminalActions } from './terminalActions.js';

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
  private pendingToolResults: PendingToolResult[] = [];
  private actionCounter = 0;
  private toolCounter = 0;
  private mockCtx: MockCtx = { evidence_count: 0, incident_index: 0 };
  private terminalActionsRun = false;
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
    if (evt.type === 'reply.done') {
      if (evt.status === 'interrupted') this.discardPendingToolResults();
      else this.flushToolResults();
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
      case 'session.ready':
        this.diag('aai_session_ready', { session_id: evt.session_id });
        break;

      case 'transcript.user':
      case 'transcript.agent':
        this.logs.conversation.push(utteranceFromTranscript(evt, this.nowT()));
        this.opts.onActivity?.();
        break;

      case 'reply.started':
        this.speaking = true;
        break;

      case 'reply.audio':
        this.opts.onServerEvent({ type: 'audio', data: evt.data });
        break;

      case 'reply.done':
        this.speaking = false;
        this.recordGoalCompletionAction(evt.status);
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
        this.opts.onServerEvent({ type: 'flush' });
        break;

      case 'input.speech.stopped':
        break;

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
        // through, not a state change). The engine's verdict is untouched either way, so
        // this never goes through applyEvaluate/emitState -- just forward the signal.
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
      this.logs.tools.push(toolLogEntryFromCall(evt, this.nowT(), loggedArgs, result));
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
    this.runTerminalActionsIfNeeded();
    this.emitState();
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
    // Flight recorder: every engine evaluate, compact (verdict + state only -- never the
    // full EngineOutput, which would duplicate Evidence/reasons into a channel that is
    // explicitly NOT evidence).
    this.diag('evaluate', { verdict: output.verdict, state: output.state });
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
    }
    this.last = output;
  }

  /** LAW 2: STAGE is the ceiling this ever reaches on its own. The server runs the owed
   *  tools itself (the LLM never triggers a terminal action -- it only reaches ACTION state
   *  once the engine has already decided the verdict), then re-runs `evaluate` over the now-
   *  frozen logs: `countersign.recomputed` is the proof that adding the record of the
   *  actions taken did not change the verdict that authorized them.
   *  IMPORTANT 3 (final review): the tool-running step itself now lives in
   *  `runOwedTerminalActions` (call/terminalActions.ts), shared verbatim with replay.ts --
   *  previously only a live call ever ran it, so a replay of the same corpus file never
   *  showed the export/countersign a live run always reached. */
  private runTerminalActionsIfNeeded(): void {
    if (this.terminalActionsRun || !this.last) return;
    const output = this.last;
    const terminal = output.verdict === 'STAGE' || output.verdict === 'FREEZE' || output.verdict === 'ESCALATE';
    if (!terminal || output.required_actions.length === 0) return;

    this.terminalActionsRun = true;
    const verdictBeforeActions = output.verdict;
    this.diag('terminal_action', { verdict: verdictBeforeActions, actions: output.required_actions });

    runOwedTerminalActions(
      this.logs.tools,
      output,
      this.opts.seed,
      this.opts.mock,
      this.mockCtx,
      () => this.nextToolId(),
      () => this.nowT(),
    );

    this.applyEvaluate();
    const after = this.last;
    this.countersignRecomputed = after ? after.verdict === verdictBeforeActions : false;
    this.diag('countersign', { recomputed: this.countersignRecomputed, verdict: after?.verdict ?? null });

    if (after) {
      this.pendingExport = buildEvidenceExport(this.opts.session_id, after, new Date(this.opts.now()).toISOString())
        .then((exp) => {
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
