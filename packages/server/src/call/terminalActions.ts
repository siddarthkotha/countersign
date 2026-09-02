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
 *  evidence from an earlier version is never treated as current). */
export function argsForTerminalTool(name: ToolName, seed: SeedConfig, output: EngineOutput): Record<string, unknown> {
  const request_version = output.request_version;
  switch (name) {
    case 'freeze_transaction_rail':
      return { rail_id: seed.rails[0]?.id ?? null, request_version };
    case 'alert_principal':
      return { identity_id: output.claimed_identity_id, request_version };
    default:
      return { request_version };
  }
}

/** Mutates `tools` in place, appending one ToolLogEntry per still-owed action in
 *  `output.required_actions`, in the FSM's own order (freeze/stage first, incident, alert,
 *  seal last). `nextId`/`t_ms` are injected so a live call keeps its own running
 *  counters/clock and a replay can use its corpus timeline's own position instead. */
export function runOwedTerminalActions(
  tools: ToolLogEntry[],
  output: EngineOutput,
  seed: SeedConfig,
  mock: typeof mockToolResult,
  mockCtx: MockCtx,
  nextId: () => string,
  t_ms: () => number,
): void {
  for (const name of output.required_actions) {
    const args = argsForTerminalTool(name, seed, output);
    const result = mock(name, args, seed, mockCtx);
    if (name === 'open_incident') mockCtx.incident_index += 1;
    tools.push({ id: nextId(), name, t_ms: t_ms(), args, result });
  }
}
