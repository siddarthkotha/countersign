// packages/server/src/aai/schemas.ts
// Flat JSON-Schema tool definitions for AssemblyAI's `tools` field in session.update
// (docs/aai-docs-check-2026-09-01.md §e: {type:'function', name, description, parameters,
// execution_mode, timeout_seconds} -- one flat object per tool, never a nested `function`
// key). Covers every ToolName the engine knows (`@countersign/engine`'s frozen union) --
// 'record_answer' does not exist (v2 ruling: the LLM never writes evidence).
//
// Fix round 1 (finding 3): this file used to keep its own copy of every tool's description/
// parameters/execution_mode ("DEFS"), duplicating `call/allowlist.ts`'s `TOOL_DEFS` (and a
// third copy that lived in `call/session.ts`). `call/allowlist.ts` is now the single source
// of truth for that data; this file is a thin re-export under the names this package's other
// modules (`src/index.ts`, `test/aai-config.test.ts`) already import.
import type { ToolName } from '@countersign/engine';
import { ALL_TOOL_NAMES, toolSchemasFor, type FlatToolSchema } from '../call/allowlist.js';

export type { FlatToolSchema };
export const TOOL_NAMES: ToolName[] = ALL_TOOL_NAMES;

export function toolSchema(name: ToolName): FlatToolSchema {
  return toolSchemasFor([name])[0]!;
}

/** All eight tool schemas, flat. Registered at connect time; the server's per-state
 *  allowlist (call/session.ts) is what actually restricts which ones the agent may call in
 *  a given goal -- AssemblyAI accepts tool updates mid-call too (docs/aai-verify-2026-09-02.md
 *  Q1), so `call/session.ts` also resends a narrowed list on every goal change. */
export function allToolSchemas(): FlatToolSchema[] {
  return toolSchemasFor(ALL_TOOL_NAMES);
}
