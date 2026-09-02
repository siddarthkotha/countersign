import type { ServerConfig } from './config.js';

export async function mintToken(
  cfg: ServerConfig,
  fetchImpl: typeof fetch
): Promise<{ token: string; expires_in_seconds: number }> {
  if (!cfg.assemblyai_api_key) {
    throw new Error('token mint failed: no api key configured');
  }

  const url = new URL('https://agents.assemblyai.com/v1/token');
  url.searchParams.set('expires_in_seconds', '60');
  url.searchParams.set('max_session_duration_seconds', String(cfg.session_cap_seconds));

  const res = await fetchImpl(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${cfg.assemblyai_api_key}` },
  });

  if (!res.ok) {
    throw new Error(`token mint failed: ${res.status}`);
  }

  const body = (await res.json()) as { token: string; expires_in_seconds: number };
  return { token: body.token, expires_in_seconds: body.expires_in_seconds };
}
