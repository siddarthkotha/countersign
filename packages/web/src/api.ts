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
