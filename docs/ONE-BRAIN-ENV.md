# One-brain live path — environment variables (Lane D)

2026-09-22, docs/plans/2026-09-22-one-brain-live-path.md §4/§5. This lane (index.ts,
aai/config.ts, aai/session.ts, aai/agent.ts, ws/browser.ts) never touches `.env`,
`.env.example`, or `render.yaml` — everything below is **not set yet** anywhere. Setting it
is a founder/deploy-time decision, listed here so it's a single lookup instead of a repo grep.

## The three variables

| Variable | Read by | Required for endpoint mode | Notes |
|---|---|---|---|
| `COUNTERSIGN_BRAIN` | `packages/server/src/config.ts` (`loadConfig`, committed by Lane B) | Set to `endpoint` to turn any of this on | `legacy` (the default — unset, empty, or any other value) means every line in this lane's code is dead: no token generated, no stored agent ensured, no `/api/brain` route reachable. |
| `COUNTERSIGN_BRAIN_API_KEY` | `packages/server/src/index.ts` (read directly via `process.env`, same pattern `COUNTERSIGN_FAKE_AAI` already uses — **not** in `config.ts`/`ServerConfig` yet) | Yes | The static bearer token `POST /api/brain/chat/completions` checks (`brain/endpoint.ts`'s `isBrainAuthValid`). Also sent to AssemblyAI as the stored agent's `llm[0].api_key`, so AssemblyAI's own outbound call to our endpoint carries it. Generate a fresh random secret for this — it is unrelated to `ASSEMBLYAI_API_KEY` and unrelated to `COUNTERSIGN_ADMIN_TOKEN`. |
| `COUNTERSIGN_PUBLIC_URL` | `packages/server/src/index.ts` (same as above — read directly, not in `config.ts`) | Yes | This process's own externally-reachable base URL, e.g. `https://countersign-xxxx.onrender.com` (see the render.yaml comment: the `countersign` name slug belongs to an unrelated product, so the real deployed URL carries a suffix Render appended — copy it exactly from the live deploy, never guess it). Used to build the stored agent's `llm[0].base_url` as `${COUNTERSIGN_PUBLIC_URL}/api/brain` (AssemblyAI appends `/chat/completions` itself — this codebase never appends it). No trailing slash required (index.ts strips one if present). |

If `COUNTERSIGN_BRAIN=endpoint` is set but either of the other two is missing, `index.ts`
logs a warning at boot and every call falls back to legacy — it never crashes the server and
never half-configures a route (`http.ts`'s own `/api/brain/chat/completions` mount already
404s unless both `brainRegistry` and `brainApiKey` are present).

## What render.yaml / the Render dashboard needs (not set yet)

To actually turn endpoint mode on for the deployed service, three additions belong in
`render.yaml`'s `envVars` list (or the Render dashboard, for the two secrets):

```yaml
- key: COUNTERSIGN_BRAIN
  value: "endpoint"          # currently absent -- absent/legacy is today's live default
- key: COUNTERSIGN_BRAIN_API_KEY
  sync: false                # secret -- set in the Render dashboard, same as ASSEMBLYAI_API_KEY
- key: COUNTERSIGN_PUBLIC_URL
  value: "https://<this service's real deployed URL>"   # or sync: false if treated as a secret-ish value
```

None of these three lines exist in `render.yaml` today. This lane deliberately does not add
them — per this task's own hard rule, env/render changes are listed here, never applied,
until the founder rules go/no-go on flipping the flag live (the plan's own gate: legacy-path
tests 100% green AND Lane G's 3-consecutive-clean bar met AND the hard stop hasn't fired —
see plan §8's merge order and §9).

## Boot-time behavior (what happens with these set)

On every process boot (including every Render free-tier cold start — this service spins down
after 15 minutes idle per `render.yaml`'s own comment, so this runs far more than once a day
in practice), if `COUNTERSIGN_BRAIN=endpoint` and both secrets are present, `index.ts` kicks
off `aai/agent.ts`'s `ensureBrainAgent` **without awaiting it** (never blocks server startup,
never crashes it on failure — plan §4). It finds-or-creates ONE stored agent named
`countersign-brain` (idempotent — a cold start never leaks a duplicate agent) and reconciles
its voice/greeting/`llm[0].base_url` onto whatever this boot's env currently says. Any call
that lands before that resolves falls back to legacy automatically; every call after it
resolves uses the stored agent. If the AssemblyAI API is unreachable or returns an error, the
failure is logged and every call for the rest of that process's life stays on legacy — no
retry loop, no crash.

## Not this lane's scope (parked, not done)

- Moving `COUNTERSIGN_BRAIN_API_KEY`/`COUNTERSIGN_PUBLIC_URL` into `config.ts`'s
  `ServerConfig`/`loadConfig` (a later, small lane — `config.ts` is out of this lane's
  LANE-FILES).
- Actually editing `render.yaml` or the Render dashboard (founder/deploy-time action, per the
  table above).
- Rotating `COUNTERSIGN_BRAIN_API_KEY` — no rotation mechanism exists yet; today it's a
  single static value, same shape as `COUNTERSIGN_ADMIN_TOKEN`.
