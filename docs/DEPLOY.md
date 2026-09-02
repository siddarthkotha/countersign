# Deploy runbook (Render)

Plain-English steps to get Countersign running on a real URL. Everything here is about the
**hosting container** (one server that answers the API, the WebSocket call, and the web
page). It does not touch AssemblyAI itself — see `docs/SETUP-API-KEY.md` for that.

## 1. Create the Render service from the blueprint

1. Push this repo to GitHub (already done if you're reading this from the repo).
2. In the Render dashboard: **New +** → **Blueprint**.
3. Point it at this GitHub repo. Render reads `render.yaml` at the repo root and proposes one
   web service named `countersign` — Node 24, builds `npm ci && npm run build` (the web app
   and the server), starts with `npm run start:server`, health-checked at `/health`.
4. Click **Apply**. Render builds and deploys automatically from here.

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
  above still needs doing.
- **Terminal:** `curl https://<your-service>.onrender.com/health`

Then open the root URL in a browser — it should load the split-screen app, not a 404 or a
blank page. If it 404s, the build likely didn't produce `packages/web/dist` — check the
Render build logs for `build:web` output.

**Important — match the CORS allowlist to the real URL.** `render.yaml` sets
`COUNTERSIGN_ALLOWED_ORIGINS` to `https://countersign.onrender.com` as a guess. If Render
assigned a different URL (the `countersign` name slug was taken, so it appended a suffix —
check the dashboard), the browser's API/WebSocket calls will be silently rejected by CORS.
Fix: Render dashboard → Environment → edit `COUNTERSIGN_ALLOWED_ORIGINS` to the real URL →
save (redeploys automatically).

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

**PROVEN — $7/month** for Render's Starter web-service instance (512 MB RAM, 0.5 CPU,
always-on/continuous run — no spin-down). Source: render.com/pricing, checked 2026-09-02.
The Free plan (what `render.yaml` uses during the build weeks) costs $0/month but suspends
after inactivity — see step 8. Confirm the current figure in the Render dashboard's own plan
picker before switching (step 8) in case pricing has changed since this was checked.

## 8. Switching from Free to Starter before judging week

`render.yaml` currently sets `plan: free` for the build weeks — free web services suspend
after **15 minutes** of inactivity and take about **one minute** to spin back up on the next
request or WebSocket connection (verified,
`docs/hosting-render-check-2026-09-02.md`, quoting Render's own docs: *"Free web services
automatically suspend after 15 minutes of inactivity. A Free web service spins back up
whenever it next receives an HTTP request or new WebSocket connection. This process takes
about one minute."*). A judge whose first click eats a ~1-minute cold start is a bad first
impression at best.

**The one-line switch, before ~Sep 20:**

- In `render.yaml`, change `plan: free` to `plan: starter`, commit, and push (Render
  redeploys with the new plan on the next blueprint sync) — **or** just change the plan
  directly in the Render dashboard (service → Settings → Instance Type), which takes effect
  immediately without a git change.
- Starter (and every paid plan) stays always-on: no 15-minute suspend, no cold start.

**Free-tier fallback, if the plan switch is missed or delayed:** `.github/workflows/keepalive.yml`
is a GitHub Actions workflow that pings `/health` on a schedule to keep the free instance
awake — it ships **disabled by default** (only a manual `workflow_dispatch` trigger; the
`schedule:` block is commented out) so it costs nothing and does nothing until turned on.
To enable it: uncomment the `schedule:` cron line in that file, set the
`COUNTERSIGN_HEALTH_URL` repository variable (Settings → Secrets and variables → Actions →
Variables) to the deployed `/health` URL, and commit. This is a stopgap, not a substitute for
the Starter switch — it only prevents the 15-minute suspend as long as GitHub Actions keeps
running the schedule, and does nothing about a wake-up that's already mid-flight if traffic
arrives right as the free instance is spinning back up.
