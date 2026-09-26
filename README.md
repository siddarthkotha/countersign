# Countersign

**The conversational security checkpoint that stands between social engineering and irreversible actions.**

> Countersign doesn't guess who's calling. It makes them prove it.

When a high-risk request arrives by voice (an urgent wire transfer demanded of a corporate
payment desk, a privileged credential reset, or a "grandchild needs bail money" call), Countersign
answers first. It conducts a calm, adaptive spoken interrogation (challenge questions,
cross-turn consistency probes, independent verification checks outside the current call) while a
deterministic policy engine (never the LLM) computes the verdict from structured evidence. Verified requests are only ever
**staged** for independent human second approval. Failed requests are frozen, an incident is
opened, and a hash-chained evidence export records every claim, check, and decision.

Built solo, AI-assisted, on the AssemblyAI Voice Agent API for the AssemblyAI Voice Agent
Hackathon (lablab.ai, September 1–30, 2026).

## Try it in 30 seconds

Live demo: https://countersign-bf8q.onrender.com. Desktop Chrome with a microphone, laptop
speakers are fine. Pick one of the two role cards, an honest treasury manager or a caller
claiming to be the CEO; each card shows what to say first and the facts you need, and the
same cheat sheet stays on the call screen during the call. Click "Check microphone", then
"Try it live (experimental)", then "Start Call". The agent asks "Who am I speaking with?":
give your name first, then your request. More cases, what to say, and what you should hear:
[docs/PLAY-SHEET.md](docs/PLAY-SHEET.md). No microphone? "Watch a recorded attack" drives the
full screen from a recorded call, including the escalated outcome. Everyone and everything in
the demo is synthetic; see Disclosure below.

**How it is built, in one paragraph.** The browser captures your voice and plays the agent's
replies. A small Node server mints a short-lived token, relays audio to and from a stored
AssemblyAI Voice Agent ("countersign-brain"), and feeds every exact transcript line into a pure,
dependency-free policy engine. The engine is a finite-state rule table that computes the verdict
from structured evidence. For every reply the agent gives, the engine writes the exact words via
a custom LLM endpoint the server provides; the language model inside AssemblyAI never composes
sentences. The server re-runs the same engine before any terminal action and acts only on a
matching verdict. Voice can reach STAGED at most; a human second approval releases anything.

## Business value

In 2025 the FBI logged $3.05 billion in losses to business email compromise, the fraud family
where an impersonator talks a payments desk into sending a wire. PROVEN: FBI IC3 2025 Internet
Crime Report, page 26, https://www.ic3.gov/AnnualReport/Reports/2025_IC3Report.pdf

Of those complaints, $30.3 million came from reports that referenced AI. The report does not
break out voice cloning, so Countersign makes no claim about how much of that was voice. PROVEN:
same report, page 42, table titled AI References by Complaint Loss.

On the deployed demo, socket connect to terminal verdict takes p50 83.1 s and p95 170.8 s
across 282 live rehearsal runs of every scenario (honest caller cases p50 80.3 s over 38 runs,
CEO impostor cases p50 46.7 s over 41 runs). PROVEN: docs/LATENCY.md section 4, computed by
`scripts/rehearse/latencyMath.ts` from the runs' own event timestamps, 2026-09-09 to
2026-09-22.

## Status

Countersign is built and deployed. PROVEN by `GET /health` and `GET /version` on the live demo
at https://countersign-bf8q.onrender.com (2026-09-25): the live site is healthy and serves
the one-voice design with AssemblyAI's Voice Agent API bound to a stored agent. PROVEN by
`npm test` on the current build (2026-09-25, 8:01 PM): 2,689 tests pass across 132 files,
typecheck is clean, the web bundle builds, and all 45 recorded call transcripts in
`packages/engine/corpus/` replay exactly through the real policy engine
(`packages/engine/test/corpus.test.ts` replays every file in that folder). On the current build,
the synthetic-caller harness placed five live calls against the deployed site on 2026-09-25
(an honest caller twice, the CEO impostor twice, and a caller who talks over the agent): every
verdict was right and every call graded clean on experience. The harness grades repeated
questions, merged replies, the agent talking over the caller, holding-line spam, and the delay
from verdict to spoken goodbye. On the earlier two-voice design, all eleven judge cases in
docs/PLAY-SHEET.md passed live through the same harness (2026-09-21).

## How Countersign uses the AssemblyAI Voice Agent API

- **Server-minted, single-use tokens with a session cap, bound to a stored agent.** The browser never talks to
  AssemblyAI at all. It only ever opens Countersign's own `/ws/call/:id` socket
  (`packages/server/src/http.ts`). The server mints the AssemblyAI token itself, calling
  `GET https://agents.assemblyai.com/v1/token` with `expires_in_seconds` (the 60-second window
  the token must be redeemed in) and `max_session_duration_seconds` (the hard cap on how long
  the call itself can run), and uses that token exclusively server-side to open its own
  connection to AssemblyAI. At connect, the server binds the session to a stored Voice Agent
  named "countersign-brain" and supplies its own LLM endpoint so the deterministic engine writes
  every reply. Neither the token nor the API key ever reaches the browser
  (`packages/server/src/token.ts`, `packages/server/src/aai/session.ts`, `packages/server/src/brain/endpoint.ts`).
- **24 kHz PCM16 mic audio via an AudioWorklet.** The browser captures the mic with
  `getUserMedia`, downsamples whatever the browser's native sample rate is to 24,000 Hz mono
  16-bit PCM inside an `AudioWorkletProcessor` running on the audio-render thread (off the React
  thread), and posts 20 ms base64-encoded frames up to the server one at a time
  (`packages/web/src/audio/capture.worklet.ts`, `packages/web/src/audio/capture.ts`).
- **One voice: a stored agent plus our own LLM endpoint (the live mode since 2026-09-23).** The
  voice, the greeting ("Meridian payments desk, verification line. Who am I speaking with?") and
  the LLM endpoint live on a stored AssemblyAI agent, reconciled on every server boot
  (`packages/server/src/aai/agent.ts`). Each call binds to it with `session.update {agent_id}`,
  then sends one post-bind `session.update` carrying a per-call token in `system_prompt`, a fixed
  list of proper-noun `keyterms`, and `transcription_mode: 'max_accuracy'`
  (`packages/server/src/aai/config.ts`, `buildPostBindSessionUpdate`). Nothing is resent mid-call.
  For every reply, AssemblyAI calls `POST /api/brain/chat/completions` on our server, which checks
  the token and answers with the exact sentence the engine's current goal renders
  (`packages/server/src/brain/endpoint.ts`, `packages/server/src/brain/spokenLines.ts`), so no
  model composes the agent's words. The greeting asks for the caller's name first because, in
  tests that streamed the founder's recorded voice into fresh sessions, one long request spoken
  as the first turn was cut off early 13 times out of 13, and whole 3 times out of 3 after one
  short name line first; a second recorded request was not cut in the same test
  (2026-09-25, `scripts/spike/turn-repro/results/`). If the stored agent cannot be set
  up at boot, every call falls back to the earlier mode described in the next bullets.
- **Earlier mode (still the automatic fallback): `session.update` at connect, then again on every
  goal change.** The first `session.update` sets `system_prompt`, `input.format.encoding`,
  `output.voice`, `output.format.encoding`, a one-time `greeting`, the tool list (always empty,
  since the server runs every lookup itself), and `keyterms`. After that, every goal change sends
  a fresh `session.update` touching only `system_prompt`, `tools`, `input.keyterms`, and the
  closing turn's `turn_detection`. In this mode AssemblyAI's model phrases each line inside the
  goal the engine sets and never decides (`packages/server/src/call/session.ts`, the
  `applyEvaluate` method).
- **Keyterms grow with the call (earlier mode).** `input.keyterms` starts from the seed's keyterms list (names,
  companies, and domain phrases such as wire transfer, escrow, SSO, out-of-band) and grows per
  state. The server adds every proper noun and dollar amount the caller has actually stated
  (both the caller's spoken form, e.g. "one point eight million", and the normalized display
  form, e.g. "$1,800,000") plus every evidence quote captured so far, so the transcriber is
  boosted toward the exact words this specific call needs, up to the 100-term cap
  (`packages/engine/src/fsm.ts`, the `buildKeyterms` function).
- **Turn detection and barge-in.** The live mode sends no `turn_detection` settings, so
  AssemblyAI's own adaptive turn detection applies (its docs say setting `min_silence` or
  `max_silence` switches that adaptation off; tonight's tests found neither setting stopped the
  first-turn cut-off, which is why the greeting asks for a name). When the caller
  talks over the agent, AssemblyAI sends `input.speech.started` and, once the turn resolves,
  `reply.done` with `status: 'interrupted'`. The server treats `input.speech.started` as the
  signal to flush playback immediately; on the browser side, the playback queue stops every
  scheduled audio source and clears itself within one frame, so nothing already queued keeps
  playing after the interrupt. The barge-in is won client-side, in the audio buffer
  (`packages/server/src/call/session.ts`, `packages/web/src/audio/playback.ts`).
- **`tool.result` timing (earlier mode).** A tool result is computed and queued as soon as the tool call
  arrives, but only sent back to AssemblyAI once `reply.done` arrives for that turn. It is never
  sent earlier or later, per AssemblyAI's own timing rule. If that `reply.done` instead reports
  `status: 'interrupted'`, the queued result is never sent (a new turn has already started); the
  tool call and its result stay in the evidence log regardless, just marked
  `discarded_on_interrupt: true` so the discard itself is visible, not silent
  (`packages/server/src/call/session.ts`, the `flushToolResults`/`discardPendingToolResults`
  methods).
- **The three evidence lookups run server-side, not at the model's discretion.** The moment
  the engine's state needs them (EVIDENCE or CONSISTENCY_CHECK), the server itself runs
  `get_request_history`, `check_sso_context` and `verify_out_of_band` against the simulated
  backend, using the engine's own claimed identity, and re-runs them whenever a critical
  fact changes the request version. These server-initiated calls carry no AssemblyAI
  `call_id`, so no `tool.result` message is ever sent for them; they appear in the evidence
  log like any other tool entry. The voice model is offered no tools at all, so it never
  issues a lookup itself; a stray or malformed tool call is logged as ignored and can never
  shadow the evidence the server already resolved (`runLookupsIfNeeded` in
  `packages/server/src/call/session.ts`; found by the first live rehearsal on 2026-09-03,
  when a call held on "one moment" for five minutes because nobody ran the lookups).
- **Bounded reconnect on a dropped link.** If the AssemblyAI socket drops unexpectedly, the
  server re-mints a token, opens a new socket, and sends `session.resume` with the previous
  `session_id`. It makes up to 3 attempts total for the life of the call (not per drop), each backed off
  (500 ms / 1.5 s / 3 s), and only while still inside AssemblyAI's documented 30-second resumable
  window. Exhausting the attempts, missing the window, or having no session id to resume against
  all give up rather than retry forever (`packages/server/src/aai/session.ts`).
- **A fake AssemblyAI mode for tests; a separate path for replay.** `FakeAaiSocket` implements
  the same socket interface the real adapter does, so every test drives the full call-handling
  logic with no network call and no API key; `COUNTERSIGN_FAKE_AAI=1` dev mode hands the same
  stub to a live call session so the server can boot and be exercised locally without an
  AssemblyAI key (`packages/server/src/aai/fake.ts`). The no-mic replay screen is a different
  path entirely: `/ws/replay/:file` re-runs a recorded call through the real policy engine
  (`runReplay`), with no AssemblyAI connection (real or fake) involved at all
  (`packages/server/src/replay.ts`, `packages/server/src/ws/browser.ts`).
- **Measured latency.** The "Measured latency" table below is produced by actually running the
  real socket, not estimated: `packages/server/scripts/smoke-live.ts` mints a token, opens the
  connection, times connect → `session.ready`, then times `session.ready` → the first
  `reply.audio` byte. It's opt-in only (`--live` plus `ASSEMBLYAI_API_KEY`) and never runs in CI.

**What we tried first, and why the model ended up with zero agency.** The build did not start
with a custom endpoint. The first working version offered the voice model all eight tool schemas
at connect time, including the three evidence lookups (`get_request_history`, `check_sso_context`,
`verify_out_of_band`), each of which requires an `identity_id` parameter so the mock backend
knows which record to check. In a live rehearsal on 2026-09-03
(`scripts/rehearse/reports/2026-09-03T23-04-42-scenario-a-dana-legitimate.md`), the model read
that field name straight off the schema and began asking a legitimate caller, out loud, to state
an "identity id", a value no real caller could ever know, three separate times as the call went
on. The caller never got past it: that recorded run ends with the engine freezing a transfer it
should have staged. The fix was not a better prompt; it was to stop showing the model the schema
at all. Since commit `42d720f`, the voice model is offered zero tools in every state
(`allowedTools` in `packages/engine/src/fsm.ts` always returns `[]`); the server now runs every
lookup and every terminal action itself, from the policy engine's own state machine, and a stray
tool call from the model is rejected and logged as ignored. Since 2026-09-23 the live mode goes
one step further: the engine writes every word the agent speaks through our own LLM endpoint, so
in that mode no model decides, acts, or composes a sentence. If the stored agent cannot be set up
at boot, calls fall back to the earlier mode, where the model phrases lines but still never
decides or acts.

## How a verdict is decided

A pure, dependency-free function (`decide` in `packages/engine/src/rules.ts`) turns structured
evidence into a verdict. No LLM call, no randomness, no clock read. The same evidence in always
produces the same verdict out. There are two possible terminal outcomes, and a positive ceiling that
never moves:

- **STAGE**: the request is queued for a second, independent human approval. Voice alone never
  releases anything; STAGE is as far as a verified call can ever go
  (`packages/engine/src/rules.ts`, rule row 11; `packages/engine/src/fsm.ts`'s `ACTION_ALLOWLIST`
  has no release tool, ever).
- **FREEZE**: the transfer rail is frozen and an incident is opened for a human to work
  (`rules.ts` row 8).

Two more outcomes keep the call moving without staging or freezing anything: **PENDING** holds
the floor for more evidence (identity, a challenge, a readback, a pending check: rows 3–7, 12);
**ESCALATE** hands the case to a human callback with nothing moved by voice (structuring across
amounts, a first-time beneficiary, or the catch-all row 14). An out-of-scope call (a judge
testing the demo, or a dead line with nothing at stake) becomes **NO_ACTION**. Nothing ever
opens (`fsm.ts` state `OUT_OF_SCOPE`).

Four invariants are checked last and override every rule (`rules.ts` lines 300–304, `RULES_DOC`):
1. There is no release verdict, tool, or action anywhere in the engine. STAGE is the ceiling.
2. STAGE fires only when every item on the assurance checklist reads true.
3. A changed critical fact (amount, account, beneficiary) invalidates every check gathered
   before the change. Stale evidence is never treated as a pass.
4. A tool result that errored or is still missing past its timeout makes the evaluation
   incomplete, which can only ever become ESCALATE (or NO_ACTION with nothing open). It never becomes STAGE.

Before STAGE can fire, twelve checklist items must each read **true**: affirmative checks, never
"zero failures" (`AssuranceChecklist` in `packages/engine/src/types.ts`, gated in `rules.ts` row
11): identity claimed; the single sign-on (SSO) / identity verification check passing; the independent verification check outside this call confirmed; the context check currently passing; no unresolved contradiction in what the caller
said; every critical field read back and confirmed; the running total under the exposure limit;
enough challenges passed for the risk level; no unresolved identity switch; and no first-time
beneficiary.

**Challenges** are picked and phrased by the engine (`selectChallenge` in
`packages/engine/src/challenges.ts`), which hands the LLM only a question to ask, never the
expected answer. Grading is the engine's job alone: `gradeChallenges` compares the caller's
transcribed reply against the known fact by plain text matching, deterministically. The model
can ask; it can never decide PASS or FAIL.

Every fact the caller states is committed to a **story ledger** (`packages/engine/src/ledger.ts`)
with a lifecycle: STATED (first said), CONFIRMED (read back and affirmed), APPROXIMATE (hedged,
e.g. "about $1.8 million"), CORRECTED (a later value with a correction cue, or inside the
readback-repair window), CONTRADICTED (a later, different value with no correction signal), or
UNKNOWN (a readback the caller negated). Contradictions and failed/ambiguous challenges feed the
tally that drives FREEZE and ESCALATE (`computeTally` in `rules.ts`).

The **counterfactual panel** (`packages/engine/src/counterfactual.ts`) answers "what would flip
this?": for every evidence card, it re-runs the real `evaluate` with just that one card's status
flipped and reports which flips would change the verdict. Nothing here is simulated separately
from the real engine.

**Replay guarantee:** the same inputs always produce the same verdict. `packages/engine/corpus/`
holds 42 recorded transcripts replayed through this real engine on every test run
(`test/corpus.test.ts`). Every rule-table row and invariant is also exercised directly, one
scenario at a time, in `test/rules.test.ts`. On top of that, mutation tests
(`test/mutants.test.ts`) deliberately break four specific rule mechanics: the readback gate
(row 5), the freeze AND-vs-OR logic (row 8a), contradiction-triggered freeze (row 8b), and the
exposure/structuring check (row 9). One at a time, it replays the full corpus
under each break to prove those mechanics are load-bearing, not decorative. See "Replay the
corpus" below.

## Replay the corpus

`packages/engine/corpus/*.json` holds 42 transcripts replayed through the real engine every
test run (`test/corpus.test.ts`), and every rule mutant breaks at least one of them
(`test/mutants.test.ts`). This is G3's evidence that the rulebook is load-bearing, not decorative.
Inspect any file judge-legibly:

`npm run replay -- packages/engine/corpus/scenario-b-miller-fraud.json`

Prints the verdict, every evidence card, and the "what would flip this" counterfactuals; exits
1 if the file no longer matches the engine.

## What Countersign does NOT do

Countersign makes **no acoustic deepfake-detection claims** and uses **no voice biometrics** by
design. The mechanism is exclusively behavioral verification: what the caller knows, how
their story holds together across turns, and what independent verification checks outside this call confirm. That's a
feature: it's the layer that still works when synthetic voices are perfect.

Every quote in the evidence record is AssemblyAI's own transcribed text, verbatim, never a
paraphrase written by the agent. Facts are stored separately from interpretation, so no evidence
card ever depends on how the agent chose to phrase anything mid-call.

**On prior art.** The core architecture pattern here, a deterministic policy engine rather than
the language model owning every verdict, is published prior art, not our invention. That the
pattern works is PROVEN by the APort Vault CTF (a security contest where attackers attempt social engineering), which
measured social engineering succeeding 74.6 percent of the time against model-only defenses and
0 percent against a policy engine, across 879 attempts. Separately, a US Bancorp patent
(US12562169B1, priority 2025-09-16) covers the same two mechanics, adaptive challenge generation
and a deterministic engine paired with what the patent calls "immutable" logging, but built as an assist tool for human
call-center staff, not as autonomous voice interrogation. What's new here is the assembled
application: live conversational interrogation of an inbound caller, feeding a deterministic
engine whose best possible outcome is staging the request for an independent second human, never
releasing it.

## Disclosure

All identities, companies, systems, and the attacking voice in the demo are synthetic; the
conversation, interruptions, and tool calls run live. No real personal data appears anywhere
in this repository.

---

## Measured latency (live AssemblyAI Voice Agent API, deployed site)

All rows are measured on the deployed demo across every scenario, 2026-09-09 to 2026-09-22,
from the runs' own event timestamps, during the earlier two-voice design phase. After 2026-09-23,
the one-voice design with the stored agent and custom LLM endpoint became live. p50 and p95 use
linear interpolation over the sorted sample; `n` is the exact sample size. Source and
per-scenario breakdown: docs/LATENCY.md.

| What is measured | n | p50 | p95 | Label |
|---|---|---|---|---|
| Perceived response: caller stops speaking to agent's first reply audio | 1,565 turns | 631 ms | 1,838 ms | ESTIMATE (harness wall clock; the synthetic caller is not a human) |
| Socket connect to AssemblyAI session ready | 313 runs | 401 ms | 648 ms | PROVEN |
| Session ready to first greeting audio | 316 runs | 175 ms | 200 ms | PROVEN |
| Socket connect to terminal verdict | 282 runs | 83.1 s | 170.8 s | PROVEN |
| Verdict to the call ending on its own | 282 runs | 11.5 s | 34.5 s | PROVEN |

Never rounded into a qualitative claim: this README does not say "sub-second" anywhere,
because the p95 is not.
