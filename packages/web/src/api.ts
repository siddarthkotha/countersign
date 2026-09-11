// Bug fix (2026-09-04): the browser may NAME a demo persona (which role card a visitor
// picked); it must never invent or send telemetry values (`origin_kind`/`origin_geo`)
// itself -- the server alone maps a persona name to that simulated call context
// (packages/server/src/personas.ts). Kept in sync with that module's own `DemoPersona`.
export type DemoPersona = 'legitimate' | 'attacker';

export type StartResult =
  | { session_id: string; ws_path: string; cap_seconds: number }
  | { replay_only: true; reason: string };

export async function startSession(
  persona?: DemoPersona | null,
  fetchImpl: typeof fetch = fetch
): Promise<StartResult> {
  try {
    const response = await fetchImpl('/api/session/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(persona ? { persona } : {})
    });
    const body = (await response.json()) as StartResult;
    if (!response.ok) {
      if ('replay_only' in body && body.replay_only) {
        return body;
      }
      return { replay_only: true, reason: 'server unreachable' };
    }
    return body;
  } catch {
    return { replay_only: true, reason: 'server unreachable' };
  }
}

// Reviewer finding (2026-09-11): "credits-exhausted replay mode" is a submission
// requirement (CLAUDE.md abuse caps) with nothing surfacing it on the landing page. The
// server's single source of truth (packages/server/src/caps.ts's `computeLiveCallsStatus`)
// is exposed on GET /health as this shape -- Landing reads it on mount so a stranger sees
// the plain-English banner and the replay-first layout before ever clicking Start Call,
// not only after a failed attempt.
export type LiveCallsReason = 'kill_switch' | 'daily_cap' | 'credits_exhausted' | 'mint_error';

export interface LiveCallsStatus {
  available: boolean;
  reason: LiveCallsReason | null;
}

export interface HealthResult {
  ok: boolean;
  live_calls: LiveCallsStatus;
}

/** Best-effort: a health-check failure (network hiccup, cold-start 502) must never itself
 *  hide Start Call -- it returns null, and callers treat null the same as "available"
 *  (fail open; the button's own click-time error handling already covers a truly broken
 *  server). */
export async function getHealth(fetchImpl: typeof fetch = fetch): Promise<HealthResult | null> {
  try {
    const response = await fetchImpl('/health');
    if (!response.ok) return null;
    return (await response.json()) as HealthResult;
  } catch {
    return null;
  }
}
