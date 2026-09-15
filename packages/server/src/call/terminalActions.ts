// packages/server/src/call/terminalActions.ts
// The terminal-action-running step of "the countersign" (LAW 2/3): once a verdict is
// terminal and still owes actions, run them against the mock backend and append each to the
// tool log, in `required_actions` order. Extracted (IMPORTANT 3, final review) so a live
// call (call/session.ts) and a replay (replay.ts) run the EXACT same step -- previously only
// the live path ever ran it, so a replay of the same corpus file never showed the
// export/countersign a live run of it always reached.
import type { EngineOutput, MockCtx, SeedConfig, ToolLogEntry, ToolName, mockToolResult } from '@countersign/engine';

/** Same per-tool argument shaping call/session.ts always used (moved here verbatim, not
 *  reimplemented): `freeze_transaction_rail` needs the seed's rail id, `alert_principal`
 *  needs the claimed identity, everything else just carries `request_version` (I3: stale
 *  evidence from an earlier version is never treated as current). For `seal_evidence_record`,
 *  also include conversation_count and actions_count if provided, so the engine can use
 *  position-based truncation to prevent the P1 leak (conversation entries at the seal's
 *  exact timestamp but appended after it). */
export function argsForTerminalTool(
  name: ToolName,
  seed: SeedConfig,
  output: EngineOutput,
  counts?: { conversation_count: number; actions_count: number },
): Record<string, unknown> {
  const request_version = output.request_version;
  switch (name) {
    case 'freeze_transaction_rail':
      return { rail_id: seed.rails[0]?.id ?? null, request_version };
    case 'alert_principal':
      return { identity_id: output.claimed_identity_id, request_version };
    case 'seal_evidence_record':
      if (counts) {
        return { request_version, conversation_count: counts.conversation_count, actions_count: counts.actions_count };
      }
      return { request_version };
    default:
      return { request_version };
  }
}

/** Mutates `tools` in place, appending one ToolLogEntry per still-owed action in
 *  `output.required_actions`, in the FSM's own order (freeze/stage first, incident, alert,
 *  seal last). `nextId`/`t_ms` are injected so a live call keeps its own running
 *  counters/clock and a replay can use its corpus timeline's own position instead.
 *  When `counts` is provided, includes conversation_count and actions_count in the
 *  seal_evidence_record args for position-based truncation (P1 leak fix). */
export function runOwedTerminalActions(
  tools: ToolLogEntry[],
  output: EngineOutput,
  seed: SeedConfig,
  mock: typeof mockToolResult,
  mockCtx: MockCtx,
  nextId: () => string,
  t_ms: () => number,
  counts?: { conversation_count: number; actions_count: number },
): void {
  for (const name of output.required_actions) {
    const args = argsForTerminalTool(name, seed, output, counts);
    const result = mock(name, args, seed, mockCtx);
    if (name === 'open_incident') mockCtx.incident_index += 1;
    tools.push({ id: nextId(), name, t_ms: t_ms(), args, result });
  }
}
