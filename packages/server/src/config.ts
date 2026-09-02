export interface ServerConfig {
  port: number;
  assemblyai_api_key: string | null;
  session_cap_seconds: number;
  max_concurrent: number;
  idle_timeout_ms: number;
  daily_session_cap: number;
  mint_rate_per_minute: number;
  kill_switch: boolean;
  allowed_origins: string[];
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function intFromEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(env: Record<string, string | undefined>): ServerConfig {
  const sessionCapSeconds = clamp(intFromEnv(env.COUNTERSIGN_SESSION_CAP_SECONDS, 300), 60, 10800);
  const apiKey = env.ASSEMBLYAI_API_KEY;
  const originsRaw = env.COUNTERSIGN_ALLOWED_ORIGINS;
  const allowed_origins = (originsRaw && originsRaw.length > 0 ? originsRaw : 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  return {
    port: intFromEnv(env.PORT, 8787),
    assemblyai_api_key: apiKey && apiKey.length > 0 ? apiKey : null,
    session_cap_seconds: sessionCapSeconds,
    max_concurrent: intFromEnv(env.COUNTERSIGN_MAX_CONCURRENT, 2),
    idle_timeout_ms: intFromEnv(env.COUNTERSIGN_IDLE_MS, 30000),
    daily_session_cap: intFromEnv(env.COUNTERSIGN_DAILY_CAP, 40),
    mint_rate_per_minute: intFromEnv(env.COUNTERSIGN_MINT_RATE, 6),
    kill_switch: env.COUNTERSIGN_KILL_SWITCH === '1',
    allowed_origins,
  };
}
