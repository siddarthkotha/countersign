// packages/server/src/call/allowlist.ts
// SINGLE SOURCE OF TRUTH (fix round 1, finding 3) for the nine-tools-in-brief/eight-in-
// `ToolName` per-tool schema data: description, JSON-Schema parameters, and execution_mode.
// Two other copies of this data used to exist -- `src/aai/schemas.ts`'s own `DEFS` (now a
// thin re-export of `toolSchemasFor`/`ALL_TOOL_NAMES` below) and `call/session.ts`'s
// `TOOL_SCHEMAS` (now derives its validation table from `paramsFor` below) -- both deleted
// so there is exactly one place a tool's description or parameters can be edited.
//
// Turns the engine's per-state `allowed_tools: ToolName[]` into the flat tool schemas AAI's
// session.update expects. Descriptions describe WHAT each tool checks or does, never HOW
// (LAW 1 -- no detection claims anywhere, including tool copy). `execution_mode: 'hold'`
// means the LLM waits for the result before speaking again; `'interactive'` means it can
// keep talking while the call runs -- reserved for the two fast read-only lookups.
//
// NOTE ON THE COUNT: the brief for this task (and S3's) says "nine flat tool schemas" /
// "the nine tools", but `ToolName` (packages/engine/src/types.ts) has exactly EIGHT members
// -- `record_answer` was removed by the v2 controller ruling and is correctly absent. This
// file implements schemas for all eight actual `ToolName` members; the "nine" in both briefs
// appears to be a stale count from before that removal, not a ninth tool this file is
// missing. Flagged here rather than silently invented.
import type { ToolName } from '@countersign/engine';
import type { ParamsSchema } from './validate.js';

export interface FlatToolSchema {
  type: 'function';
  name: ToolName;
  description: string;
  parameters: ParamsSchema;
  execution_mode: 'hold' | 'interactive';
  timeout_seconds: number;
}

const TOOL_TIMEOUT_SECONDS = 30;

interface ToolDef {
  description: string;
  parameters: ParamsSchema;
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

/** Every `ToolName` this file has a definition for, in declaration order -- what
 *  `src/aai/schemas.ts`'s `allToolSchemas()` registers at connect time (all eight; the
 *  per-state allowlist is what actually restricts what the agent may call). */
export const ALL_TOOL_NAMES: ToolName[] = Object.keys(TOOL_DEFS) as ToolName[];

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

/** The validation-only view of a tool's schema: just its JSON-Schema-subset `parameters`
 *  object, for `call/session.ts`'s `validateToolArgs` call -- so that file no longer keeps
 *  its own copy of every tool's parameters purely to validate against them. */
export function paramsFor(name: ToolName): ParamsSchema {
  return TOOL_DEFS[name].parameters;
}
