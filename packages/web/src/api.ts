export type StartResult =
  | { session_id: string; ws_path: string; cap_seconds: number }
  | { replay_only: true; reason: string };

export async function startSession(fetchImpl: typeof fetch = fetch): Promise<StartResult> {
  try {
    const response = await fetchImpl('/api/session/start', { method: 'POST' });
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
