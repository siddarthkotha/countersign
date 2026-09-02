# Deploy runbook (Render)

Plain-English steps to get Countersign running on a real URL. Everything here is about the
**hosting container** (one server that answers the API, the WebSocket call, and the web
page). It does not touch AssemblyAI itself — see `docs/SETUP-API-KEY.md` for that.

**Hosting is free-tier for the whole hackathon (founder ruling, 2026-09-02, countermanding an
earlier same-day "starter from day one" ruling).** An event judge confirmed in the
hackathon's support chat that a cold start is "totally ok" and to host on the free tier —
`render.yaml` sets `plan: free`. Free web services suspend after 15 minutes of inactivity and
take about a minute to wake back up on the next request
(`docs/hosting-render-check-2026-09-02.md`) — that's the accepted trade-off, not a risk being
managed around. Render's Starter plan ($7/month, always-on, no spin-down) remains available
as a one-line optional upgrade — see "Optional: always-on for $7/month" below — but it is not
the default and nothing here requires it.

## 1. Create the Render service from the blueprint

1. Push this repo to GitHub (already done if you're reading this from the repo).
2. In the Render dashboard: **New +** → **Blueprint**.
3. Point it at this GitHub repo. Render reads `render.yaml` at the repo root and proposes one
   web service named `countersign` — Node 24, builds `npm ci && npm run build` (the web app
   and the server), starts with `npm run start:server`, health-checked at `/health`, on the
   **Free** instance type (`plan: free` in the blueprint — not a separate manual choice, it
   comes straight from the file).
4. **No payment method needed.** The Free plan doesn't require a card on file, so nothing in
   this step should prompt for billing details — if Render asks for a card at this point,
   double-check the blueprint actually read `plan: free` (this file) rather than some other
   plan.
5. Click **Apply**. Render builds and deploys automatically from here.

**Why Render, not Railway or Vercel:** Railway's free tier is $1/month of usage credit plus a
one-time $5 trial credit for 30 days — not a sustainable always-on plan for a multi-week build
(`docs/railway-check-2026-09-02.md`). Vercel's serverless functions cap out at a 5-minute
execution duration on every plan checked and offer no always-on persistent server at all,
which the WebSocket call path needs (`docs/vercel-ws-check-2026-09-02.md`). Render is the one
of the three that can actually hold a persistent WebSocket-serving box, free or paid.

**How it runs, and why:** `build:server` compiles `packages/server/src` to plain JavaScript
(`packages/server/dist`), but `start:server` still runs that compiled output through `tsx`,
not plain `node`. That's required, not a leftover: `@countersign/engine`'s own package.json
points at a TypeScript source file whose internal imports omit file extensions (fine for the
"bundler" resolution this repo's tooling uses, but Node's own module loader can't follow it —
confirmed live, plain `node` throws `ERR_MODULE_NOT_FOUND`). `tsx` resolves it correctly, so
it stays a small production dependency for now. **Week-2 cleanup item:** compile
`packages/engine` the same way and point its `exports` at the compiled output — then
`start:server` can drop back to plain `node` and `tsx` moves back to a dev-only dependency.

## 2. Paste the API key

`render.yaml` deliberately does **not** contain the AssemblyAI key (`sync: false` — secrets
only ever live in the host's own secret store, never in the repo, per this project's hygiene
rule). After the first deploy:

1. Render dashboard → the `countersign` service → **Environment**.
2. Find `ASSEMBLYAI_API_KEY` (Render will have prompted for it during setup, or add it here
   if it's still blank).
3. Paste the real key (see `docs/SETUP-API-KEY.md` for how to get one).
4. Save → Render redeploys automatically with the key in place.

Without a key set, `/api/session/start` returns `503 { replay_only: true, reason:
'no_api_key' }` — the demo's no-mic replay mode still works with no key at all (see the
README), so a missing key degrades gracefully rather than breaking the whole page.

## 3. First health check

Once the deploy finishes, Render shows the service's URL (something like
`https://countersign.onrender.com`). Check it two ways:

- **Browser:** open `https://<your-service>.onrender.com/health` — you should see JSON like
  `{"ok":true,"active":0,"killed":false,"has_key":true}`. `has_key: false` means step 2
  above still needs doing. If the service has been idle, expect this first request to take
  up to about a minute while the free instance wakes up (see the note at the top of this
  file) — that's expected, not a failure.
- **Terminal:** `curl https://<your-service>.onrender.com/health`

Then open the root URL in a browser — it should load the split-screen app, not a 404 or a
blank page (after the same possible wake-up delay on a cold instance). If it 404s, the build
likely didn't produce `packages/web/dist` — check the Render build logs for `build:web`
output.

**CORS works out of the box — no URL to guess or paste in.** The server recognizes its own
origin automatically (it reads the real scheme/host off the incoming request — `Host` and
Render's `X-Forwarded-Proto`/`X-Forwarded-Host` headers — and always allows same-origin
calls), so `render.yaml` leaves `COUNTERSIGN_ALLOWED_ORIGINS` empty (`""`, with a comment:
"same-origin is always allowed; list extra origins here"). Whatever URL Render actually
assigns, the browser's own API/WebSocket calls to that same URL just work.

Note: the `countersign` name slug on Render was already taken by an unrelated product, so
this service's real URL is `https://countersign-<suffix>.onrender.com`, not the bare
`https://countersign.onrender.com` you might expect — check the Render dashboard for the
exact hostname. That mismatch used to break CORS (the old setup hard-coded a guessed URL
into `COUNTERSIGN_ALLOWED_ORIGINS`); it doesn't anymore, since same-origin needs no
configured value at all.

Only set `COUNTERSIGN_ALLOWED_ORIGINS` (comma-separated) if you add a custom domain in front
of this service, or a second front end (e.g. a staging site) that needs to call this same
backend from a different origin — same-origin coverage for this service's own URL stays on
either way.

## 4. The kill switch

`COUNTERSIGN_KILL_SWITCH` is a Render environment variable, not a live in-app toggle (there
is no admin endpoint that flips it at runtime today — the only thing `state.killed` in
`packages/server/src/caps.ts` would represent, and nothing currently sets it). To stop new
sessions from starting (existing calls in progress finish or are ended separately):

1. Render dashboard → Environment → set `COUNTERSIGN_KILL_SWITCH` to `1`.
2. Save. Render restarts the service with the new value.
3. `/api/session/start` now returns `503 { replay_only: true, reason: 'kill_switch' }` for
   everyone — the demo's replay mode (no live call) still works, so the page never goes
   fully dark.
4. To resume, set it back to `0` and save.

`/health`'s `killed` field reflects this (`cfg.kill_switch || state.killed`), so a quick
`curl .../health` confirms the switch actually took effect after the restart.

## 5. How to reset a stuck session

If a call session gets stuck (a browser tab closed without a clean end, a demo that needs a
fresh slot right now instead of waiting for the idle timeout), reset it by session id:

```
curl -X POST https://<your-service>.onrender.com/api/session/<session_id>/reset
```

This is the same route the operator/demo "get me a fresh slot" action uses server-side
(`packages/server/src/http.ts`) — it ends the live call (AssemblyAI socket + browser socket)
and frees the concurrency slot, scoped to that one session id only; it never touches any
other session. A `404 { error: 'not_found' }` means that id isn't an active session (already
ended, or never existed) — nothing to reset.

If you don't have the session id, `/health`'s `active` count tells you how many sessions are
currently occupying the concurrency slots (`COUNTERSIGN_MAX_CONCURRENT`, default 2) even
without naming which ones.

## 6. How to read the daily cap

`COUNTERSIGN_DAILY_CAP` (default 40, set in `render.yaml`) limits how many new sessions can
start per UTC calendar day. There is currently no dashboard or endpoint that shows the
running count directly — the observable signal is: a `POST /api/session/start` call starts
returning `429 { replay_only: true, reason: 'daily_cap' }` instead of `200` once the cap is
hit for the day. The demo's replay mode keeps working when this happens (nothing breaks for
a visitor, they just can't start a new live call until the cap resets). The cap resets
automatically at UTC midnight — no manual action needed. To raise or lower it, edit
`COUNTERSIGN_DAILY_CAP` in the Render dashboard and save.

## 7. Cost expectation

**Free tier: $0/month.** No payment method required (see step 1.4). The only cost this
project incurs on Render is if/when it upgrades to Starter — see below.

---

## Optional: always-on for $7/month

If a cold start ever turns out to actually be a problem in practice (despite the judge
confirmation that motivated the free-tier ruling), Render's Starter plan removes it: an
always-on instance, no 15-minute suspend, no wake-up delay on the first request.

**The one-line switch:** in `render.yaml`, change `plan: free` to `plan: starter`, commit,
and push — **or** change the plan directly in the Render dashboard (service → Settings →
Instance Type), which takes effect immediately without a git change and will prompt for a
payment method at that point if one isn't already on file.

**Cost:** **$7/month** for Render's Starter web-service instance (512 MB RAM, 0.5 CPU,
always-on/continuous run). Label: **ESTIMATE-by-search** — this figure came from a routed web
search against render.com/pricing (2026-09-02), not a direct read of the live pricing page in
a browser (the page renders its plan table client-side and returned nothing useful to a plain
fetch). Confirm the current figure in the Render dashboard's own plan picker before switching
— it shows the live price at the moment of the actual change.

---

## Fallback: keep-alive ping

An alternative to upgrading to Starter, if the free-tier cold start becomes an occasional
annoyance rather than a real problem: `.github/workflows/keepalive.yml` is a GitHub Actions
workflow that pings `/health` on a schedule to keep the free instance from suspending in the
first place. It ships **disabled by default** (only a manual `workflow_dispatch` trigger; the
`schedule:` block is commented out) so it costs nothing and does nothing until turned on.

**To enable it:** uncomment the `schedule:` cron line in that file, set the
`COUNTERSIGN_HEALTH_URL` repository variable (Settings → Secrets and variables → Actions →
Variables) to the deployed `/health` URL, and commit. This only prevents the 15-minute
suspend as long as GitHub Actions keeps running the schedule, and does nothing about a
wake-up that's already mid-flight if traffic arrives right as the free instance is spinning
back up — it's a partial mitigation, not a guarantee, which is exactly why the current ruling
is to accept the cold start rather than lean on this by default.
