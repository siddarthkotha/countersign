# Orchestration tooling — plain English

This page explains the guardrails that watch Claude's work in this repo: what a
"hook" is, what each one currently does, how the backlog file works, and how to
turn any of it off if it gets in your way.

## What a hook is

A hook is a small script that Claude Code runs automatically at a fixed moment —
for example, right before Claude finishes replying to you, or right when you hit
enter on a new message. The script gets to look at what just happened and can
either say nothing (let it through) or refuse ("block") with a message explaining
why. Claude then has to deal with that message before it can actually stop.

Think of it as a checklist bouncer standing at a specific door. It doesn't watch
everything Claude does — only the one moment it's posted at.

## Every hook in `.claude/hooks`, one line each

| Hook | Fires on | What it refuses |
|---|---|---|
| `lane-gate.sh` | Claude finishing a reply | If the reply mentions background/running work but doesn't end with a `Lanes:` line, or the backlog file (below) has an item sitting idle or a "held" item with no reason written down. |
| `worktree-gate.sh` | Claude launching any helper agent | Launching a helper that doesn't say which files it will touch (no `LANE-FILES:` line, no READ-ONLY marker, no worktree isolation), or that declares files already claimed by another currently-running lane without using a separate git worktree. |
| `agent-watchdog.sh` | Claude finishing a reply, and every time you send a new message | If a backlog item marked "running" hasn't produced any output in over 20 minutes — flags it as stalled. Blocks the reply on finish; just leaves a note when you send a new message (it never blocks *you*). |
| `local-time-gate.sh` | Claude finishing a reply | If the reply doesn't include the real local clock time. |
| `autopilot-guard.sh` | Every tool Claude tries to use | Risky or outward actions (pushing code, deleting things, publishing) while "autopilot" mode is on. |
| `autopilot-toggle.sh` | Every message you send | Nothing — it just turns autopilot mode on/off when you type "autopilot start" or "autopilot stop", and reminds Claude it's on. |
| `inline-heavy-tool-guard.sh` | Claude trying to use the browser or search the web directly | Doing that work itself instead of handing it to a helper agent (keeps Claude's main "thinking budget" from getting eaten by browsing). |
| `pre-commit-gate.sh` | Claude trying to run a git commit | Commits that would include secrets, stray scratch files, or edits to the protected test files, or commits made when the tests aren't passing. |
| `merge-ci-guard.sh` | Claude trying to merge a pull request | Merging before all the automated checks (CI) are green. |
| `review-model-guard.sh` | Claude launching a helper agent to review code | Review work being handed to the most expensive AI models. |
| `agent-model-guard.sh` | Claude launching any helper agent | Launching a helper without saying explicitly which (cheaper) model it should use. |
| `external-comms-guard.sh` | Claude trying to publish, post, or send something outward | Anything leaving the building (an artifact, an email, a social post) without you seeing it first. |
| `usage-ledger.sh` | After Claude uses a tool | Nothing — it just quietly keeps a tally of what got used, for your own records. |
| `commit-orphan-guard.sh` | After a git commit | Nothing (can't block after the fact) — it just warns loudly if files got left out of the commit by mistake. |
| `pre-compact-checkpoint.sh` / `post-compact-context.sh` | Claude's memory getting summarized (compacted) | Nothing — they save a snapshot before and re-orient Claude after, so it doesn't lose track of what it was doing. |

(`~/.claude/hooks/ambition-pass-gate.sh` is a similar hook that lives outside this
repo, in your personal settings — it applies to every project, not just this one.)

## How the backlog file works

`.claude/backlog.json` is the single list of everything currently in flight. Each
item looks like:

```json
{
  "id": "S5",
  "title": "S5 flight recorder server",
  "files": ["packages/server/**"],
  "status": "running",
  "held_because": "",
  "agent_id": "",
  "started_at": "2026-09-03T00:52:55Z"
}
```

- **status** is one of: `open` (needs to be picked up), `running` (a helper agent
  is actively working on it), `held` (deliberately paused), or `done`.
- **held_because** is required whenever status is `held` — it's the plain-English
  reason it's paused (e.g. "needs the founder's microphone"). An empty reason
  gets flagged by `lane-gate.sh`.
- **agent_id** is filled in once a helper agent is actually dispatched for a
  `running` item — that's what lets `agent-watchdog.sh` find its output and check
  whether it's stalled.

This file is the source of truth `lane-gate.sh` and `agent-watchdog.sh` both read
from. If it goes stale or wrong, update it directly (it's plain JSON, safe to
hand-edit).

## What "Lanes:" means

At the end of a reply where background work is happening, Claude is required to
write one line like:

```
Lanes: running: S5, W9 · held: judge-sim-preload because founder ruling Sep 12
```

This is the mechanical proof that nothing was left idle without a reason. If
everything currently in flight is already running, it can say `held: none`.

Two lanes touching the same file is not, by itself, a reason to wait: the rule
(founder ruling 2026-09-03) is that a shared file means launch it as its own
git worktree lane, not serialize it behind the other one; `worktree-gate.sh`
enforces this at launch time by checking every new agent's `LANE-FILES:` line
against the files of any lane already marked `running` in the backlog.

## Known gaps (so you're not surprised)

- **Text-based checks.** `lane-gate.sh` looks for keywords like "running" or
  "waiting" in the reply text — it can't truly understand what Claude did, so a
  cleverly worded reply could slip past it (or, more often, an innocent reply
  gets incorrectly flagged).
- **Fail-open, on purpose.** Every hook here is written so that if anything goes
  wrong while it's checking (a file is missing, the input is malformed), it just
  lets things through silently rather than freezing the whole session. That's
  deliberate — a broken guardrail should never be able to jam the work — but it
  also means a bug in a hook can quietly go unnoticed.
- **Only fires at two moments.** These hooks only run when Claude finishes a
  reply (Stop) or when you send a new message (UserPromptSubmit). They do not
  watch continuously — a lane could stall for 19 minutes and 59 seconds and
  nothing would say anything until the next Stop or your next message.
- **The 20-minute stall check is a guess, not proof.** `agent-watchdog.sh` only
  knows a lane is "stalled" if its output file hasn't been touched in 20
  minutes. A slow-but-fine agent and a genuinely stuck agent can look identical
  for that first 20 minutes.

## How to turn any hook off

Open `.claude/settings.json`, find the hook's line under `"hooks"` (it looks like
`"command": "bash \".../hooks/<name>.sh\""`), and delete that block. Save the
file. That hook stops running immediately — nothing else needs to change. To
turn it back on, put the same block back (or ask Claude to re-add it).
