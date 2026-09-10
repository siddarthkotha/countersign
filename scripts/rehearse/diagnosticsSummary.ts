// scripts/rehearse/diagnosticsSummary.ts
// Turns the raw flight-recorder bundle (GET /api/session/<id>/diagnostics, PROVEN:
// packages/server/src/http.ts:195-211) into the compact summary the report renders: event
// kind counts, the tool-related events (server-initiated lookups and terminal actions,
// PROVEN kinds from packages/server/src/call/session.ts -- 'tool_call' L581, 'server_lookup'
// L691, 'server_lookup_error' L697, 'server_lookup_abandoned' L711, 'terminal_action' L819,
// 'terminal_action_result' L832/L850, 'terminal_action_abandoned' L853), and the 'evaluate'
// transition events (L763). This file never treats the bundle as evidence (LAW 4) or a
// verdict (LAW 3) -- same discipline the server's own diagnostics.ts documents itself.
import type { DiagnosticsFailure, DiagnosticsSummary, RehearseDiagnosticBundle, RehearseDiagnosticEvent } from './types.js';

const TOOL_KINDS = new Set([
  'tool_call',
  'server_lookup',
  'server_lookup_error',
  'server_lookup_abandoned',
  'terminal_action',
  'terminal_action_result',
  'terminal_action_abandoned',
]);

export function summarizeDiagnostics(bundle: RehearseDiagnosticBundle | null): DiagnosticsSummary | DiagnosticsFailure {
  if (!bundle) return { ok: false, error: 'diagnostics bundle unavailable (fetch failed or session not found)' };

  const counts: Record<string, number> = {};
  const toolEvents: RehearseDiagnosticEvent[] = [];
  const evaluateEvents: RehearseDiagnosticEvent[] = [];
  let sessionMintedEvent: RehearseDiagnosticEvent | null = null;
  let callContextEvent: RehearseDiagnosticEvent | null = null;

  for (const e of bundle.server_events) {
    counts[e.kind] = (counts[e.kind] ?? 0) + 1;
    if (TOOL_KINDS.has(e.kind)) toolEvents.push(e);
    if (e.kind === 'evaluate') evaluateEvents.push(e);
    // Fix (2026-09-09, PROVEN live-call regression): the first of each -- there's only ever
    // one 'session_minted' (mint time) and one 'call_context' (first WS attach) per bundle.
    if (e.kind === 'session_minted' && sessionMintedEvent === null) sessionMintedEvent = e;
    if (e.kind === 'call_context' && callContextEvent === null) callContextEvent = e;
  }

  return {
    ok: true,
    event_kind_counts: counts,
    tool_events: toolEvents,
    evaluate_events: evaluateEvents,
    deployed_commit: bundle.deployed_commit,
    ended_at_ms: bundle.ended_at,
    end_reason: bundle.end_reason,
    session_minted_event: sessionMintedEvent,
    call_context_event: callContextEvent,
  };
}
