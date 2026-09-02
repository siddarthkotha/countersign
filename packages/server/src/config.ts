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
  /** Task R1: how long a call session keeps running server-side (AAI socket up, engine
   *  evaluating, evidence intact) after its browser WebSocket drops, waiting for the same
   *  session id to reattach before the call is actually ended (`browser_gone`) and the caps
   *  slot freed. */
  browser_grace_ms: number;
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
  // Unset (local dev, .env.example never sets this) keeps the old default: Vite's dev
  // server on :5173 is a genuinely different origin from the backend on :8787, so it needs
  // an explicit extra origin. An env var explicitly set to "" (render.yaml's production
  // value -- the deployed frontend and backend share one origin, see http.ts's same-origin
  // check) means what it says: no extra origins at all, never a fallback to "allow all" or
  // to the dev default.
  const originsRaw = env.COUNTERSIGN_ALLOWED_ORIGINS;
  const allowed_origins = originsRaw === undefined
    ? ['http://localhost:5173']
    : originsRaw
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
    browser_grace_ms: intFromEnv(env.COUNTERSIGN_BROWSER_GRACE_MS, 20000),
  };
}
