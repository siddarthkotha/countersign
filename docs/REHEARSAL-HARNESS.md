# Rehearsal harness

## What this is

A script that plays a synthetic caller against the real, live Countersign stack, with no
human on a microphone and no browser open. There are two ways it decides what the caller
says (see "Two caller modes" below): a **reactive** scripted caller (no network beyond our
own server) and an **LLM-driven** caller (an external model plays the caller live). Either
way, it:

1. Turns each caller line into speech with the Mac's own built-in text-to-speech (`say`),
   then converts that speech into the exact audio format the real browser sends
   (24,000 Hz, 16-bit, mono, base64-encoded, in 20-millisecond pieces).
2. Streams that audio to the real server over the same WebSocket protocol the browser uses,
   in real time (not all at once) so AssemblyAI's own turn-taking detection sees realistic
   pacing.
3. Watches for the real voice agent's reply (its audio and the screen-state updates the
   server sends back), waits for it to finish, then speaks the next line, matching pauses
   and (for the fraud scenario) interruptions.
4. Once the deterministic verdict engine reaches a decision, ends the call, downloads the
   flight-recorder record for that call, and writes a report.

This is a **test harness**, not part of the product. It is never imported by anything under
`packages/`. It does not detect or claim to detect synthetic voices (that would break LAW 1)
- it is itself a way of generating a synthetic voice for testing, and says so, here, plainly.
The LLM-driven caller is the same thing one level up: an external model role-playing a
caller for the test, never a claim that anything here detects a real one.

## Before you test an engine change live, rebuild the engine

The local dev server does NOT load `packages/engine/src`. It loads the compiled
`packages/engine/dist`, because the engine package points at `dist`. So a change you just
made inside `packages/engine/src` will silently not be there when you run a live call, and
you will spend a call's worth of credits watching the old behaviour.

Run this first, every time, then restart the server:

    npm run build:engine

This cost a real live call on 2026-09-04: a fix was verified green in the tests, then the
first live run reproduced the exact old symptom, because the server was still serving a build
from before the fix. The second run, after rebuilding, behaved correctly. The deployed site is
not affected, because deploying runs the full build.

## Two caller modes

### Reactive (default, `--caller reactive`)

A scripted caller whose lines can react to what the live agent actually said, instead of a
fixed script that has no idea what it is replying to. This matters because the deterministic
engine sometimes deliberately plants a wrong value in its own readback (a "trap") to see if
the caller notices - a caller that blindly says "Yes, that's right" to a trap is confirming a
false fact, which is exactly the failure a real fraud-verification system must never produce.
Each scenario file can carry:

- A `truth` block: the ground facts this caller actually knows (or, for a fraud persona,
  deliberately does NOT know - see `scenario-b-miller-fraud.json`, where every field but the
  caller's claimed name is `null`, so the caller never "helpfully" corrects the fraudster
  toward the real facts).
- Per-turn `respond` rules: `{ "if_agent_says_any": ["Northgate"], "say": "No, that's wrong,
  it's Meridian Supply." }`, checked in order, first match wins, plus an optional `else_say`.
- A generic, `truth`-driven fallback (used when no rule matches and there's no `else_say`):
  if the agent's line quotes a value that isn't in `truth` for that field, the caller
  corrects it with the true value; if it quotes the true value, the caller confirms; if it
  asks for something not in `truth` at all (an id, a code), the caller says it doesn't have
  that and repeats its name.

A turn with none of this (no `respond` block) just speaks its fixed `text` no matter what the
agent says - right for an opening statement or a scripted pressure line that should fire
regardless of the agent's reply.

### LLM-driven (`--caller llm --model <id>`)

An external model plays the caller live, reading the scenario's `persona` field (who they
are, what they want, what they know, how they behave under pressure) and the transcript so
far, and generating its next spoken line turn by turn - up to 30 words, with an optional
barge-in flag it can set when its persona would talk over the agent. Two providers, chosen by
the shape of `--model`:

- Any plain model id (e.g. `--model openai/gpt-4o-mini`) goes to **OpenRouter**'s
  OpenAI-compatible chat completions endpoint. Needs `OPENROUTER_API_KEY` in the environment.
- `--model gemini/<id>` (e.g. `--model gemini/gemini-1.5-flash`) goes to **Gemini**'s own
  `generateContent` endpoint instead. Needs `GEMINI_API_KEY` in the environment.

Neither key is read from a `.env` file directly - export it into the shell first, the same
way `ASSEMBLYAI_API_KEY` already has to be (see "Requirements" below). If the right key isn't
in the environment, the harness exits with code 2 and a plain message, and makes no network
call at all. Neither key is ever printed, logged, or included in an error message.

The LLM caller has its own caps, independent of a scenario's `expected.max_wall_ms` (a live
model can meander in a way a fixed script never could): at most 12 turns, a 3-minute wall-
clock ceiling for the whole call, and a 30-word-per-line instruction to the model (a longer
reply is still spoken in full and noted as a warning, never truncated mid-sentence). A
request failure (bad key, rate limit, malformed response) stops the LLM caller for that call
with a warning - the harness still waits to see whatever verdict the call reached before that
point, rather than failing the whole run outright.

## Why this exists

Before this, every rehearsal needed a person on a real microphone, reading the scripts out
loud, for every scenario, every time something changed in the code. That does not scale, and
it uses up a person's time on the exact section of the checklist that a script covers fine.
This script runs the same four core scenarios unattended, as many times as needed, and hands
back a plain report of what happened. A person's time is then spent on what a script cannot
do: judging speech quality, checking real timing under bad wifi, watching the deployed page
in a real browser.

## How to run it

From the repository root:

```
npm run rehearse                                          # every scenario, once, against localhost:8787, reactive caller
npm run rehearse -- --scenario scenario-a-dana-legitimate  # one scenario
npm run rehearse -- --scenario scenario-b-miller-fraud --repeat 2   # the G2 check: twice in a row
npm run rehearse -- --url https://countersign-bf8q.onrender.com --scenario scenario-a-dana-legitimate  # the deployed site
npm run rehearse -- --scenario all --repeat 3 --max-calls 15        # a batch run, with a roll-up report and a hard call-count guard
npm run rehearse -- --scenario scenario-b-miller-fraud --caller llm --model openai/gpt-4o-mini      # LLM-driven caller, via OpenRouter
npm run rehearse -- --scenario scenario-b-miller-fraud --caller llm --model gemini/gemini-1.5-flash # LLM-driven caller, via Gemini
```

Requirements:

- A server must already be running at the target URL (`npm run dev:server` for local; the
  deployed URL is already running). The harness never starts a server itself.
- The server needs a real `ASSEMBLYAI_API_KEY`. `npm run dev:server` does not read `.env` by
  itself (checked live: it does not use `dotenv` or Node's `--env-file`), so export the key
  into the shell first, for example:
  ```
  set -a; source .env; set +a; npm run dev:server
  ```
- For `--caller llm`: one of `OPENROUTER_API_KEY` or `GEMINI_API_KEY` (whichever the chosen
  model needs) exported into the shell the same way - this harness never parses `.env`
  itself, it only reads `process.env`. Missing the right key exits with code 2 and a plain
  message before any network call is made; the key itself is never printed anywhere.
- macOS with `say` and `ffmpeg` on the PATH (both were confirmed present when this was
  built). This harness only runs on a Mac.

Flags:

- `--url URL` - which server to test. Defaults to `http://localhost:8787`. Hitting the
  deployed site requires spelling out `--url https://countersign-bf8q.onrender.com`
  explicitly - it is never the default and never inferred, so a run can't accidentally spend
  live credits against the deployed site by mistake.
- `--scenario NAME|all` - which scenario to run (see below), or `all` (default).
- `--repeat N` - run the chosen scenario(s) N times, one after another (never at the same
  time - the server only allows one live call at a time). Use this for the G2 requirement
  (Scenario B must pass twice in a row with zero manual resets).
- `--voice NAME` - which macOS voice reads the caller's lines (default: Samantha).
- `--caller reactive|llm` - which caller mode to use (default: `reactive`). See "Two caller
  modes" above.
- `--model ID` - required with `--caller llm`. An OpenRouter model id, or `gemini/<id>` for
  Gemini.
- `--max-calls N` - refuses to start ANY call if the scenarios/repeat combination you typed
  would make more than `N` live calls. A safety rail for `--scenario all --repeat N`, where
  it is easy to type a repeat count that spends far more credits than intended.

The one thing this script refuses to do on its own is guess that you meant the deployed site.
Everything else about a run is visible up front in the command you typed.

## What it costs

Every run is a real phone-call-shaped connection to AssemblyAI, and it is billed the same as
a real call for however long it's connected - there is no free/simulated mode for the AAI
half of this. After every run, the harness prints an ESTIMATE of the minutes used, computed
from how long the call was actually open (connect to end). This is the harness's own
estimate, not a number read from AssemblyAI's billing dashboard - the real billed amount is
unknown to this script. As a rough guide, a full scenario run today is well under three
minutes (PROVEN: a real scenario-a-dana-legitimate run on 2026-09-04 measured ~2.5 minutes
of AssemblyAI connection time end to end).

With `--caller llm`, each turn ALSO makes one request to OpenRouter or Gemini, on top of the
AssemblyAI minutes above. Those are billed by the model provider, separately, per their own
pricing - this harness has no visibility into that cost at all (UNKNOWN to this script; check
the provider's own dashboard). The turn cap (12) and wall-clock cap (3 minutes) on the LLM
caller bound how many of those requests one call can make, but do not tell you their price.

## The four scenarios

All live under `scripts/rehearse/scenarios/` as JSON files. Each one lists only the caller's
lines - there is no scripted agent reply anywhere, because the live voice agent generates its
own replies. The harness decides *when* the caller speaks; the real stack decides what the
agent says back.

| scenario | what it proves | expected verdict |
| --- | --- | --- |
| `scenario-a-dana-legitimate` | the golden path: every field the agent reads back is confirmed, every check passes | STAGE |
| `scenario-b-miller-fraud` | the fraud attempt, including a real interruption (barge-in) partway through the agent's challenge about the amount changing | FREEZE |
| `judge-out-of-scope` | a judge or stranger says "I'm not the CEO, I'm testing this" before making any request | NO_ACTION |
| `single-wrong-answer` | an otherwise-normal caller gives one wrong answer to a verification question | ESCALATE |

Caller lines are taken verbatim from `docs/BRIEF.md` section 4 and the matching files under
`packages/engine/corpus/` (read-only source material for this harness - never edited by it).
Scenario A and `single-wrong-answer` each carry two or three extra buffer turns beyond what
the corpus scripted, disclosed in each file's own `description` - room for the reactive
caller to answer further live-agent follow-up questions a fixed four- or eight-line script
did not originally anticipate.

A scenario turn can carry:
- `pause_ms` - how long to wait, after the agent's reply settles, before speaking this line
  (small silences, same as a real caller taking a breath).
- `barge_in_after_ms` - instead of waiting for the agent to finish, wait for its reply to
  *start*, then wait this many more milliseconds, then speak over it. This is how Scenario
  B's interruption is reproduced against whatever the live agent actually happens to be
  saying at that moment, not a scripted line.
- `respond` - makes the turn REACTIVE (reactive caller mode only; see "Two caller modes"
  above): `{ "rules": [{ "if_agent_says_any": [...], "say": "..." }], "else_say": "..." }`.
  Checked in order (first matching rule wins), then `else_say`, then the scenario's `truth`-
  driven generic engine, then the turn's own fixed `text` as a last resort - a turn is never
  left with nothing to say.

Each scenario file can also carry a top-level `truth` block (the reactive engine's ground
facts for that caller) and a `persona` field (the LLM-driven caller's character brief) - see
"Two caller modes" above for what each one does.

## How the harness knows when to speak

There is no fixed script for the agent's side of the conversation, so the harness has to
notice for itself when the agent's reply has finished (or started, for a barge-in) using
only the WebSocket messages the real server sends:

- Audio frames (the agent's spoken reply) come down immediately, never delayed or batched by
  the server. A stretch of about 700 milliseconds with no new audio frame is treated as "the
  reply has stopped."
- The server also sends a status field (LISTENING / SPEAKING / VERIFYING / ...) with every
  screen update, but those updates are only sent a few times a second at most, so they are
  used as a second check, not the primary signal - relying on them alone could make the
  harness think a reply ended slightly before it actually did.

If the harness waits too long for a reply that never seems to finish (a stuck connection, or
an agent that never called the checks it needed), it gives up after a set time, says so as a
warning in the report, and speaks the next line anyway rather than hanging forever.

## What each run produces

- One markdown report per run, written to `scripts/rehearse/reports/` (not committed to git -
  see "what is not committed" below), containing: pass or fail against the expected verdict,
  the complete transcript as the server actually reported it, every state/verdict change with
  its timestamp, the measured timings (how long until the call was "ready", how long from
  ready to the agent's first audio, and the gap after each caller line to the agent's next
  reply), a table of how each caller line was actually decided (fixed / an explicit rule /
  `else_say` / the generic truth engine / the LLM caller - and what agent line, if any, it was
  reacting to), and a summary of the flight-recorder record fetched from the server afterward
  (`GET /api/session/<id>/diagnostics`).
- One line printed to the terminal per run, e.g.:
  `[PASS] scenario-a-dana-legitimate verdict=STAGE (expected STAGE) wall=41.2s exit=0 report=...`
- An exit code: `0` if every run passed, `1` if a run's verdict didn't match what was
  expected (or it timed out before reaching one), `2` if the harness couldn't even connect
  (the server was unreachable, refused the connection, or minting a session failed), or a
  precondition failed before any call started (a missing `--model`, a missing API key for
  `--caller llm`, or a `--max-calls` guard tripping).
- For a batch run (more than one scenario, or `--repeat` greater than 1): ALSO one roll-up
  markdown file (`scripts/rehearse/reports/<timestamp>-rollup.md`) with a pass/fail matrix
  across every run, a list of any wrong-verdict/failed runs, a per-scenario median wall time,
  and a total credits ESTIMATE for the whole batch. This is what the G2 check
  (`--scenario scenario-b-miller-fraud --repeat 2`, "twice in a row, zero resets") reads off
  directly - two PASS rows for scenario-b is the whole proof.

## What is not committed

`scripts/rehearse/.cache/` (the synthesized audio clips, reused across runs so the same line
is never re-spoken by `say` twice) and `scripts/rehearse/reports/` (the per-run reports) are
both meant to stay out of git - **the root `.gitignore` does not yet have entries for
either one**, because editing `.gitignore` is outside this work's file lane. Whoever owns
`.gitignore` should add:

```
scripts/rehearse/.cache/
scripts/rehearse/reports/
```

## What it cannot test

- **A real human microphone.** The caller's voice is entirely synthesized by macOS
  text-to-speech (`say`), not a recording of a person. This is disclosed here and in every
  generated report - it is not, and must never be presented as, a real caller.
- **A real browser.** The harness talks to the server's WebSocket protocol directly; it never
  opens a browser tab, never touches the Web Audio pipeline, the audio worklet, the barge-in
  playback-flush logic, or anything about what a person actually sees or hears. A pass here
  says the server and the deterministic verdict engine behaved correctly against real audio -
  it says nothing about what the on-screen experience looks or sounds like. Use the browser,
  by hand, for that.
- **The deployed site's cold start.** Render's free tier puts the server to sleep after
  15 minutes of no traffic and takes roughly a minute to wake up on the next request. This
  harness does not measure or account for that wake-up time; running it against the deployed
  URL right after it has been idle will include that delay in the timings without labeling it
  as such.
- **A repeatable script, once `--caller llm` is used.** The reactive caller is deterministic
  given the same live-agent replies; an LLM-driven caller is not - the same scenario run twice
  can produce a differently-worded (or differently-behaved) caller each time, since it is a
  live model, not a fixed script. Good for stress-testing with a persona instead of an exact
  line, bad for a byte-for-byte reproducible regression test - use the reactive caller for
  that.
- **Guaranteed persona fidelity.** The LLM caller's system prompt asks the model to stay in
  character and reply as strict JSON, but nothing here enforces it; a model that ignores the
  instruction is recorded (best-effort raw-text fallback, or a warning on a hard failure), not
  silently corrected.

## How this was verified before the founder ever sees it

- `npm run rehearse:test` (`vitest run --config scripts/rehearse/vitest.config.ts`) runs unit
  tests covering scenario loading and validation (including the `truth`/`respond`/`persona`
  fields), the reactive rule engine and its generic truth-driven fallback (the trap-correction
  fix itself), the LLM caller's request building and response parsing against a MOCKED HTTP
  client (never the real network), the audio frame math (frame size, padding, cadence), one
  real `say` + `ffmpeg` conversion of a short line (no network), report rendering, and roll-up
  rendering - all with no server and no AssemblyAI connection, so this suite costs nothing to
  run as often as needed.
- Real local runs against a real server and a real AssemblyAI connection are recorded in
  `scripts/rehearse/reports/` from the days this was built and extended; see those reports for
  what actually happened, including anywhere a run stalled or the live agent asked for
  something a scenario's `truth` block didn't yet cover (that is itself a finding worth
  recording, not a reason to hide the report).

Root `vitest.workspace.ts` only globs `packages/*`, so `scripts/rehearse/test/` is not picked
up by the root `npm test`. It has its own config (`scripts/rehearse/vitest.config.ts`) and its
own script (`npm run rehearse:test`) instead. Whoever owns `vitest.workspace.ts` could add
`'scripts/rehearse'` to that glob if they want it folded into the root `npm test` run; that
file is outside this work's file lane too.
