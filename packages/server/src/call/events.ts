// packages/server/src/call/events.ts
// Pure AAI event -> log-entry mapping. No I/O, no clock read, no mutation of anything
// outside its return value -- `call/session.ts` is the only place that decides WHEN to
// call these and what to do with the result (dispatch a tool, queue a tool.result, run the
// engine again). Keeping the mapping pure is what makes it trivially testable and keeps
// session.ts's own logic legible despite the number of event types it reacts to.
import type { ToolLogEntry, ToolName, Utterance } from '@countersign/engine';
import type { AaiEvent } from '../aai/types.js';

const TOOL_NAMES: ReadonlySet<string> = new Set<ToolName>([
  'get_request_history',
  'check_sso_context',
  'verify_out_of_band',
  'stage_payment_for_second_approval',
  'freeze_transaction_rail',
  'open_incident',
  'alert_principal',
  'seal_evidence_record',
]);

/** Whether a raw AAI tool name string is one of ours. An AAI-side tool.call for a name
 *  outside this set can never be dispatched to the mock backend (the engine's ToolName
 *  union has no case for it) -- callers treat that identically to "not on the current
 *  state's allowlist". */
export function isToolName(name: string): name is ToolName {
  return TOOL_NAMES.has(name);
}

/** transcript.user / transcript.agent -> the Utterance appended to the conversation log.
 *  `t_ms` is supplied by the caller (session.ts stamps it from its own clock, `now - start`
 *  -- this function never reads a clock itself). */
export function utteranceFromTranscript(
  evt: Extract<AaiEvent, { type: 'transcript.user' }> | Extract<AaiEvent, { type: 'transcript.agent' }>,
  t_ms: number,
): Utterance {
  if (evt.type === 'transcript.user') {
    return { id: evt.item_id, speaker: 'caller', text: evt.text, t_ms };
  }
  const utterance: Utterance = { id: evt.item_id, speaker: 'agent', text: evt.text, t_ms };
  if (evt.interrupted) utterance.interrupted = true;
  return utterance;
}

/** tool.call -> the ToolLogEntry appended before dispatch is decided. `args` and `result`
 *  are supplied by the caller: `args` because the server merges in `request_version` before
 *  logging (and, for an ignored call, marks it), `result` because computing one means
 *  calling the mock backend (a side effect this module deliberately has none of). */
export function toolLogEntryFromCall(
  evt: Extract<AaiEvent, { type: 'tool.call' }>,
  t_ms: number,
  args: Record<string, unknown>,
  result: Record<string, unknown>,
): ToolLogEntry {
  return { id: evt.call_id, name: evt.name as ToolName, t_ms, args, result };
}
