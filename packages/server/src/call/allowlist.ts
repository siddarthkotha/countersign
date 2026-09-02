// packages/server/src/call/allowlist.ts
// Turns the engine's per-state `allowed_tools: ToolName[]` into the flat tool schemas AAI's
// session.update expects. Descriptions describe WHAT each tool checks or does, never HOW
// (LAW 1 -- no detection claims anywhere, including tool copy). `execution_mode: 'hold'`
// means the LLM waits for the result before speaking again; `'interactive'` means it can
// keep talking while the call runs -- reserved for the two fast read-only lookups.
//
// Coordination note (S3 builds `src/aai/session.ts`/`src/aai/config.ts`/`src/aai/schemas.ts`
// in parallel): `../aai/schemas.ts` has since landed with the same schema data this file
// defines below (independently authored, same content) -- this file is kept self-contained
// rather than importing it, because the pre-commit gate snapshots only what THIS task has
// staged in git, and `../aai/schemas.ts` is S3's uncommitted file, not this task's to add.
// Once S3 commits, a follow-up can collapse this to a thin re-export of that file instead.
//
// NOTE ON THE COUNT: the brief for this task (and S3's) says "nine flat tool schemas" /
// "the nine tools", but `ToolName` (packages/engine/src/types.ts) has exactly EIGHT members
// -- `record_answer` was removed by the v2 controller ruling and is correctly absent. This
// file implements schemas for all eight actual `ToolName` members; the "nine" in both briefs
// appears to be a stale count from before that removal, not a ninth tool this file is
// missing. Flagged here rather than silently invented.
import type { ToolName } from '@countersign/engine';

export interface FlatToolSchema {
  type: 'function';
  name: ToolName;
  description: string;
  parameters: object;
  execution_mode: 'hold' | 'interactive';
  timeout_seconds: number;
}

const TOOL_TIMEOUT_SECONDS = 30;

interface ToolDef {
  description: string;
  parameters: object;
  execution_mode: 'hold' | 'interactive';
}

// hold: verify_out_of_band (a real out-of-band round trip) and every terminal action
// (stage/freeze/incident/alert/seal -- the call must not talk over its own terminal move).
// interactive: the two fast read-only lookups (history, SSO context) -- the call can keep
// moving while these resolve.
const TOOL_DEFS: Record<ToolName, ToolDef> = {
  get_request_history: {
    description: 'Look up prior scheduled payments on file for the claimed identity, to check this request against history.',
    parameters: { type: 'object', properties: { identity_id: { type: 'string' } }, required: ['identity_id'] },
    execution_mode: 'interactive',
  },
  check_sso_context: {
    description: "Check the claimed identity's current SSO session context (geo, device).",
    parameters: { type: 'object', properties: { identity_id: { type: 'string' } }, required: ['identity_id'] },
    execution_mode: 'interactive',
  },
  verify_out_of_band: {
    description: "Send an out-of-band verification push to the claimed identity's registered devices.",
    parameters: { type: 'object', properties: { identity_id: { type: 'string' } }, required: ['identity_id'] },
    execution_mode: 'hold',
  },
  stage_payment_for_second_approval: {
    description: 'Stage the request for a required second approval. Never releases funds.',
    parameters: { type: 'object', properties: {} },
    execution_mode: 'hold',
  },
  freeze_transaction_rail: {
    description: 'Freeze the transaction rail this request would have used.',
    parameters: { type: 'object', properties: { rail_id: { type: 'string' } } },
    execution_mode: 'hold',
  },
  open_incident: {
    description: 'Open a security incident record for this call.',
    parameters: { type: 'object', properties: {} },
    execution_mode: 'hold',
  },
  alert_principal: {
    description: 'Alert the claimed identity, out of band, that this call happened.',
    parameters: { type: 'object', properties: { identity_id: { type: 'string' } } },
    execution_mode: 'hold',
  },
  seal_evidence_record: {
    description: 'Produce the hash-chained evidence export for this call.',
    parameters: { type: 'object', properties: {} },
    execution_mode: 'hold',
  },
};

/** Flat tool schemas for exactly the given (per-state) allowlist, in the shape AAI's
 *  session.update `tools` field expects. */
export function toolSchemasFor(allowed: ToolName[]): FlatToolSchema[] {
  return allowed.map((name) => {
    const def = TOOL_DEFS[name];
    return {
      type: 'function',
      name,
      description: def.description,
      parameters: def.parameters,
      execution_mode: def.execution_mode,
      timeout_seconds: TOOL_TIMEOUT_SECONDS,
    };
  });
}
