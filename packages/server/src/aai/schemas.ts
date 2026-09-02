// packages/server/src/aai/schemas.ts
// Flat JSON-Schema tool definitions for AssemblyAI's `tools` field in session.update
// (docs/aai-docs-check-2026-09-01.md §e: {type:'function', name, description, parameters,
// execution_mode, timeout_seconds} -- one flat object per tool, never a nested `function`
// key). Covers every ToolName the engine knows (`@countersign/engine`'s frozen union) --
// 'record_answer' does not exist (v2 ruling: the LLM never writes evidence; it was removed
// from ToolName before this file was written and must never be re-added here).
// `execution_mode`: 'hold' for verify_out_of_band and every terminal action (the caller
// should not talk over a hold tool completing); 'interactive' for the two fast read-only
// lookups (per S3 brief).
import type { ToolName } from '@countersign/engine';

export interface FlatToolSchema {
  type: 'function';
  name: ToolName;
  description: string;
  parameters: object;
  execution_mode: 'interactive' | 'hold';
  timeout_seconds: number;
}

const TIMEOUT_SECONDS = 30;

interface ToolDef {
  description: string;
  parameters: object;
  execution_mode: 'interactive' | 'hold';
}

const DEFS: Record<ToolName, ToolDef> = {
  get_request_history: {
    description:
      'Look up prior scheduled payments on file for the claimed identity, to check this request against history.',
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

export const TOOL_NAMES: ToolName[] = Object.keys(DEFS) as ToolName[];

export function toolSchema(name: ToolName): FlatToolSchema {
  const def = DEFS[name];
  return {
    type: 'function',
    name,
    description: def.description,
    parameters: def.parameters,
    execution_mode: def.execution_mode,
    timeout_seconds: TIMEOUT_SECONDS,
  };
}

/** All eight tool schemas, flat. Registered at connect time; the server's per-state
 *  allowlist (call/session.ts) is what actually restricts which ones the agent may call in
 *  a given goal -- AssemblyAI accepts tool updates mid-call too (docs/aai-verify-2026-09-02.md
 *  Q1), so `call/session.ts` also resends a narrowed list on every goal change. */
export function allToolSchemas(): FlatToolSchema[] {
  return TOOL_NAMES.map(toolSchema);
}
