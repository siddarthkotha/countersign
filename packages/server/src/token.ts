import type { ServerConfig } from './config.js';

/** Redemption window for a minted token, in seconds -- unrelated to
 *  `max_session_duration_seconds`, which bounds the call itself, not how long the token is
 *  valid before it's used to open a socket. */
export const TOKEN_REDEEM_SECONDS = 60;

/** Narrowed on purpose (not the full `ServerConfig`) so `src/aai/session.ts`'s
 *  `AaiSessionConfig` -- which has its own `assemblyai_api_key`/`session_cap_seconds` but
 *  isn't a `ServerConfig` -- can share this one mint implementation instead of duplicating
 *  it (both shapes satisfy this structurally). */
export async function mintToken(
  cfg: Pick<ServerConfig, 'assemblyai_api_key' | 'session_cap_seconds'>,
  fetchImpl: typeof fetch
): Promise<{ token: string; expires_in_seconds: number }> {
  if (!cfg.assemblyai_api_key) {
    throw new Error('token mint failed: no api key configured');
  }

  const url = new URL('https://agents.assemblyai.com/v1/token');
  url.searchParams.set('expires_in_seconds', String(TOKEN_REDEEM_SECONDS));
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
