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
  /** Origin fix round 1 (IMPORTANT finding, task-origin-review.md): whether `X-Forwarded-
   *  Proto`/`X-Forwarded-Host` (origin.ts's `selfOrigin`) are trusted at all. Default false --
   *  those headers are only meaningful when a trusted proxy in front of this process sets
   *  them (Render's edge does, which is why render.yaml sets `COUNTERSIGN_TRUST_PROXY=1`);
   *  trusting them unconditionally would let any direct caller lie about its own origin.
   *  Local dev never sets this, so `selfOrigin` there always falls back to the plain `Host`
   *  header and this request's own socket scheme. */
  trust_proxy: boolean;
  /** Task R1: how long a call session keeps running server-side (AAI socket up, engine
   *  evaluating, evidence intact) after its browser WebSocket drops, waiting for the same
   *  session id to reattach before the call is actually ended (`browser_gone`) and the caps
   *  slot freed. */
  browser_grace_ms: number;
  /** Founder override (COUNTERSIGN_LIVE_DISABLED=credits): forces `live_calls.reason` to
   *  `credits_exhausted` on /health and /api/session/start without waiting for a real
   *  AssemblyAI mint failure -- lets the founder rehearse the credits-exhausted replay
   *  path on demand. Optional so existing hand-built `ServerConfig` test fixtures that
   *  predate this field keep compiling unchanged; `loadConfig` always sets it. */
  live_disabled?: 'credits' | null;
  /** Review fix (2026-09-11, part c of the credits-exhausted review): gates
   *  POST /api/admin/live-calls/reset (http.ts), the founder's manual way to clear a
   *  latched `live_override` (caps.ts). `null` (unset/empty, the default) disables the
   *  route entirely -- same "opt-in only" shape as `kill_switch`'s own env var: nothing
   *  happens unless an operator explicitly sets one. Optional so existing hand-built
   *  `ServerConfig` test fixtures that predate this field keep compiling unchanged;
   *  `loadConfig` always sets it. */
  admin_token?: string | null;
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
    trust_proxy: env.COUNTERSIGN_TRUST_PROXY === '1',
    browser_grace_ms: intFromEnv(env.COUNTERSIGN_BROWSER_GRACE_MS, 20000),
    live_disabled: env.COUNTERSIGN_LIVE_DISABLED === 'credits' ? 'credits' : null,
    admin_token: env.COUNTERSIGN_ADMIN_TOKEN && env.COUNTERSIGN_ADMIN_TOKEN.length > 0 ? env.COUNTERSIGN_ADMIN_TOKEN : null,
  };
}
