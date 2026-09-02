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
import { toolSchemasFor } from './allowlist.js';
import { deriveScreenState } from '../screen/state.js';
import { validateToolArgs, type FlatToolSchema } from './validate.js';

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

const TOOL_SCHEMAS: Record<ToolName, { description: string; parameters: FlatToolSchema }> = {
  get_request_history: {
    description: 'Look up prior scheduled payments on file for the claimed identity, to check this request against history.',
    parameters: { type: 'object', properties: { identity_id: { type: 'string' } }, required: ['identity_id'] },
  },
  check_sso_context: {
    description: "Check the claimed identity's current SSO session context (geo, device).",
    parameters: { type: 'object', properties: { identity_id: { type: 'string' } }, required: ['identity_id'] },
  },
  verify_out_of_band: {
    description: "Send an out-of-band verification push to the claimed identity's registered devices.",
    parameters: { type: 'object', properties: { identity_id: { type: 'string' } }, required: ['identity_id'] },
  },
  stage_payment_for_second_approval: {
    description: 'Stage the request for a required second approval. Never releases funds.',
    parameters: { type: 'object', properties: {} },
  },
  freeze_transaction_rail: {
    description: 'Freeze the transaction rail this request would have used.',
    parameters: { type: 'object', properties: { rail_id: { type: 'string' } } },
  },
  open_incident: {
    description: 'Open a security incident record for this call.',
    parameters: { type: 'object', properties: {} },
  },
  alert_principal: {
    description: 'Alert the claimed identity, out of band, that this call happened.',
    parameters: { type: 'object', properties: { identity_id: { type: 'string' } } },
  },
  seal_evidence_record: {
    description: 'Produce the hash-chained evidence export for this call.',
    parameters: { type: 'object', properties: {} },
  },
};

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
  private readonly agentName: string;

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
    try {
      this.opts.aai.close();
    } catch {
      // a socket that's already gone closing again is not an error worth surfacing
    }
    this.opts.onServerEvent({ type: 'ended', reason });
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

  private buildEngineInput(): EngineInput {
    return {
      conversation: this.logs.conversation,
      tools: this.logs.tools,
      actions: this.logs.actions,
      call: this.opts.call,
      seed: this.opts.seed,
    };
  }

  private handleAaiEvent(evt: AaiEvent): void {
    if (this.ended) return;
    switch (evt.type) {
      case 'session.ready':
        break;

      case 'transcript.user':
      case 'transcript.agent':
        this.logs.conversation.push(utteranceFromTranscript(evt, this.nowT()));
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
        this.end(`aai_error:${evt.code}`);
        return;

      case 'session.ended':
        this.end('aai_ended');
        return;
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
    if (!isToolName(evt.name) || !(this.last?.allowed_tools.includes(evt.name) ?? false)) {
      const result = { error: 'not_allowed_in_state' };
      const args = { ...evt.arguments, ignored: true };
      this.logs.tools.push(toolLogEntryFromCall(evt, this.nowT(), args, result));
      this.pendingToolResults.push({ call_id: evt.call_id, result, is_error: true });
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
    const validation = validateToolArgs(name, candidateArgs, TOOL_SCHEMAS[name].parameters);
    const loggedArgs: Record<string, unknown> =
      validation.repaired.length > 0 ? { ...validation.args, _repaired: validation.repaired } : validation.args;

    if (!validation.ok) {
      const result = { error: 'invalid_arguments', rejected: validation.rejected };
      this.logs.tools.push(toolLogEntryFromCall(evt, this.nowT(), loggedArgs, result));
      this.pendingToolResults.push({ call_id: evt.call_id, result, is_error: true });
      return;
    }

    const args = { ...validation.args, request_version: this.last!.request_version };
    const finalLoggedArgs = validation.repaired.length > 0 ? { ...args, _repaired: validation.repaired } : args;
    const result = this.opts.mock(name, args, this.opts.seed, this.mockCtx);
    if (name === 'open_incident') this.mockCtx.incident_index += 1;
    this.logs.tools.push(toolLogEntryFromCall(evt, this.nowT(), finalLoggedArgs, result));
    this.pendingToolResults.push({ call_id: evt.call_id, result, is_error: Boolean(result.error) });
  }

  /** LAW/docs rule (aai-docs-check §e): "Send tool.result when reply.done is the latest
   *  event you've received. Not earlier, not later." -- results are queued in
   *  `pendingToolResults` and only sent here, from the reply.done handler. */
  private flushToolResults(): void {
    if (this.pendingToolResults.length === 0) return;
    for (const p of this.pendingToolResults) {
      this.opts.aai.send({ type: 'tool.result', call_id: p.call_id, result: JSON.stringify(p.result), is_error: p.is_error });
    }
    this.pendingToolResults = [];
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

  private promptCtx(output: EngineOutput): PromptCtx {
    const claimed_identity_name = output.claimed_identity_id
      ? (this.opts.seed.identities.find((i) => i.id === output.claimed_identity_id)?.name ?? null)
      : null;
    return {
      company: this.opts.seed.company,
      agent_name: this.agentName,
      claimed_identity_name,
      state: output.state,
    };
  }

  private applyEvaluate(): void {
    const output = evaluate(this.buildEngineInput());
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

  private argsForTerminalTool(name: ToolName): Record<string, unknown> {
    const request_version = this.last!.request_version;
    switch (name) {
      case 'freeze_transaction_rail':
        return { rail_id: this.opts.seed.rails[0]?.id ?? null, request_version };
      case 'alert_principal':
        return { identity_id: this.last!.claimed_identity_id, request_version };
      default:
        return { request_version };
    }
  }

  /** LAW 2: STAGE is the ceiling this ever reaches on its own. The server runs the owed
   *  tools itself (the LLM never triggers a terminal action -- it only reaches ACTION state
   *  once the engine has already decided the verdict), then re-runs `evaluate` over the now-
   *  frozen logs: `countersign.recomputed` is the proof that adding the record of the
   *  actions taken did not change the verdict that authorized them. */
  private runTerminalActionsIfNeeded(): void {
    if (this.terminalActionsRun || !this.last) return;
    const output = this.last;
    const terminal = output.verdict === 'STAGE' || output.verdict === 'FREEZE' || output.verdict === 'ESCALATE';
    if (!terminal || output.required_actions.length === 0) return;

    this.terminalActionsRun = true;
    const verdictBeforeActions = output.verdict;

    for (const name of output.required_actions) {
      const args = this.argsForTerminalTool(name);
      const result = this.opts.mock(name, args, this.opts.seed, this.mockCtx);
      if (name === 'open_incident') this.mockCtx.incident_index += 1;
      this.logs.tools.push({ id: this.nextToolId(), name, t_ms: this.nowT(), args, result });
    }

    this.applyEvaluate();
    const after = this.last;
    this.countersignRecomputed = after ? after.verdict === verdictBeforeActions : false;

    if (after) {
      buildEvidenceExport(this.opts.session_id, after, new Date(this.opts.now()).toISOString())
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
        });
    }
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
