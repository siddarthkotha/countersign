# Countersign

**The conversational security checkpoint that stands between social engineering and irreversible actions.**

> Countersign doesn't guess who's calling. It makes them prove it.

When a high-risk request arrives by voice — an urgent wire transfer demanded of a corporate
payment desk, a privileged credential reset, a "grandchild needs bail money" call — Countersign
answers first. It conducts a calm, adaptive spoken interrogation (challenge questions,
cross-turn consistency probes, out-of-band checks) while a deterministic policy engine — never
the LLM — computes the verdict from structured evidence. Verified requests are only ever
**staged** for independent human second approval. Failed requests are frozen, an incident is
opened, and a tamper-evident evidence record seals every claim, check, and decision.

Built solo, AI-assisted, on the AssemblyAI Voice Agent API for the AssemblyAI Voice Agent
Hackathon (lablab.ai, September 1–30, 2026).

## Status

Pre-kickoff scaffold. Product code begins with the event build window.

## How Countersign uses the AssemblyAI Voice Agent API

- **Server-minted, single-use tokens with a session cap.** The browser never talks to
  AssemblyAI at all — it only ever opens Countersign's own `/ws/call/:id` socket
  (`packages/server/src/http.ts`). The server mints the AssemblyAI token itself, calling
  `GET https://agents.assemblyai.com/v1/token` with `expires_in_seconds` (the 60-second window
  the token must be redeemed in) and `max_session_duration_seconds` (the hard cap on how long
  the call itself can run), and uses that token exclusively server-side to open its own
  connection to AssemblyAI. Neither the token nor the API key ever reaches the browser
  (`packages/server/src/token.ts`, `packages/server/src/aai/session.ts`).
- **24 kHz PCM16 mic audio via an AudioWorklet.** The browser captures the mic with
  `getUserMedia`, downsamples whatever the browser's native sample rate is to 24,000 Hz mono
  16-bit PCM inside an `AudioWorkletProcessor` running on the audio-render thread (off the React
  thread), and posts 20 ms base64-encoded frames up to the server one at a time
  (`packages/web/src/audio/capture.worklet.ts`, `packages/web/src/audio/capture.ts`).
- **`session.update` at connect, then again on every goal change.** The first `session.update`,
  sent the instant the socket opens, sets `system_prompt`, `input.format.encoding`,
  `output.voice`, `output.format.encoding`, an optional one-time `greeting`, the tool list (now
  always empty, since the server runs every lookup itself), and
  `keyterms` (`packages/server/src/aai/config.ts`). After that, every time the policy engine's
  goal changes mid-call, the server sends a fresh `session.update` — but that later update only
  ever touches `system_prompt`, `tools`, `input.keyterms`, and `input.turn_detection.min_silence`.
  Voice, output audio encoding, and the greeting are set once, at connect, and never resent,
  because AssemblyAI fixes those three for the rest of the session once it starts
  (`packages/server/src/call/session.ts`, the `applyEvaluate` method).
- **Keyterms grow with the call.** `input.keyterms` starts from the seed's keyterms list (names,
  companies, and domain phrases such as wire transfer, escrow, SSO, out-of-band) and grows per
  state — the server adds every proper noun and dollar amount the caller has actually stated
  (both the caller's spoken form, e.g. "one point eight million", and the normalized display
  form, e.g. "$1,800,000") plus every evidence quote captured so far, so the transcriber is
  boosted toward the exact words this specific call needs, up to the 100-term cap
  (`packages/engine/src/fsm.ts`, the `buildKeyterms` function).
- **Turn detection and barge-in.** The same `session.update` sets `turn_detection`
  (`vad_threshold`, `min_silence`, `max_silence`, `interrupt_response: true`). When the caller
  talks over the agent, AssemblyAI sends `input.speech.started` and, once the turn resolves,
  `reply.done` with `status: 'interrupted'`. The server treats `input.speech.started` as the
  signal to flush playback immediately; on the browser side, the playback queue stops every
  scheduled audio source and clears itself within one frame, so nothing already queued keeps
  playing after the interrupt — the barge-in is won client-side, in the audio buffer
  (`packages/server/src/call/session.ts`, `packages/web/src/audio/playback.ts`).
- **`tool.result` timing.** A tool result is computed and queued as soon as the tool call
  arrives, but only sent back to AssemblyAI once `reply.done` arrives for that turn — never
  earlier, never later, per AssemblyAI's own timing rule. If that `reply.done` instead reports
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
  `session_id` — up to 3 attempts total for the life of the call (not per drop), each backed off
  (500 ms / 1.5 s / 3 s), and only while still inside AssemblyAI's documented 30-second resumable
  window. Exhausting the attempts, missing the window, or having no session id to resume against
  all give up rather than retry forever (`packages/server/src/aai/session.ts`).
- **A fake AssemblyAI mode for tests; a separate path for replay.** `FakeAaiSocket` implements
  the same socket interface the real adapter does, so every test drives the full call-handling
  logic with no network call and no API key; `COUNTERSIGN_FAKE_AAI=1` dev mode hands the same
  stub to a live call session so the server can boot and be exercised locally without an
  AssemblyAI key (`packages/server/src/aai/fake.ts`). The no-mic replay screen is a different
  path entirely: `/ws/replay/:file` re-runs a recorded call through the real policy engine
  (`runReplay`), with no AssemblyAI connection — real or fake — involved at all
  (`packages/server/src/replay.ts`, `packages/server/src/ws/browser.ts`).
- **Measured latency.** The "Measured latency" table below is produced by actually running the
  real socket, not estimated: `packages/server/scripts/smoke-live.ts` mints a token, opens the
  connection, times connect → `session.ready`, then times `session.ready` → the first
  `reply.audio` byte. It's opt-in only (`--live` plus `ASSEMBLYAI_API_KEY`) and never runs in CI.

## How a verdict is decided

A pure, dependency-free function (`decide` in `packages/engine/src/rules.ts`) turns structured
evidence into a verdict. No LLM call, no randomness, no clock read — same evidence in, same
verdict out, always. There are two possible terminal outcomes, and a positive ceiling that
never moves:

- **STAGE** — the request is queued for a second, independent human approval. Voice alone never
  releases anything; STAGE is as far as a verified call can ever go
  (`packages/engine/src/rules.ts`, rule row 11; `packages/engine/src/fsm.ts`'s `ACTION_ALLOWLIST`
  has no release tool, ever).
- **FREEZE** — the transfer rail is frozen and an incident is opened for a human to work
  (`rules.ts` row 8).

Two more outcomes keep the call moving without staging or freezing anything: **PENDING** holds
the floor for more evidence (identity, a challenge, a readback, a pending check — rows 3–7, 12);
**ESCALATE** hands the case to a human callback with nothing moved by voice (structuring across
amounts, a first-time beneficiary, or the catch-all row 13). An out-of-scope call (a judge
testing the demo, or a dead line with nothing at stake) becomes **NO_ACTION** — nothing ever
opens (`fsm.ts` state `OUT_OF_SCOPE`).

Four invariants are checked last and override every rule (`rules.ts` lines 300–304, `RULES_DOC`):
1. There is no release verdict, tool, or action anywhere in the engine — STAGE is the ceiling.
2. STAGE fires only when every item on the assurance checklist reads true.
3. A changed critical fact (amount, account, beneficiary) invalidates every check gathered
   before the change — stale evidence is never treated as a pass.
4. A tool result that errored or is still missing past its timeout makes the evaluation
   incomplete, which can only ever become ESCALATE (or NO_ACTION with nothing open) — never STAGE.

Before STAGE can fire, ten checklist items must each read **true** — affirmative checks, never
"zero failures" (`AssuranceChecklist` in `packages/engine/src/types.ts`, gated in `rules.ts` row
11): identity claimed; the SSO/identity check currently passing; the out-of-band check currently
confirmed; the context check currently passing; no unresolved contradiction in what the caller
said; every critical field read back and confirmed; the running total under the exposure limit;
enough challenges passed for the risk level; no unresolved identity switch; and no first-time
beneficiary.

**Challenges** are picked and phrased by the engine (`selectChallenge` in
`packages/engine/src/challenges.ts`), which hands the LLM only a question to ask — never the
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
flipped and reports which flips would change the verdict — nothing here is simulated separately
from the real engine.

**Replay guarantee:** the same inputs always produce the same verdict. `packages/engine/corpus/`
holds 18 recorded transcripts replayed through this real engine on every test run
(`test/corpus.test.ts`). Every rule-table row and invariant is also exercised directly, one
scenario at a time, in `test/rules.test.ts`; on top of that, mutation tests
(`test/mutants.test.ts`) deliberately break four specific rule mechanics — the readback gate
(row 5), the freeze AND-vs-OR logic (row 8a), contradiction-triggered freeze (row 8b), and the
exposure/structuring check (row 9) — one at a time, replaying the full 18-transcript corpus
under each break to prove those mechanics are load-bearing, not decorative — see "Replay the
corpus" below.

## Replay the corpus

`packages/engine/corpus/*.json` holds 18 transcripts replayed through the real engine every
test run (`test/corpus.test.ts`), and every rule mutant breaks at least one of them
(`test/mutants.test.ts`) — G3's evidence that the rulebook is load-bearing, not decorative.
Inspect any file judge-legibly:

`npm run replay -- packages/engine/corpus/scenario-b-miller-fraud.json`

Prints the verdict, every evidence card, and the "what would flip this" counterfactuals; exits
1 if the file no longer matches the engine.

## What Countersign does NOT do

Countersign makes **no acoustic deepfake-detection claims** and uses **no voice biometrics** —
by design. The mechanism is exclusively behavioral verification: what the caller knows, how
their story holds together across turns, and what independent out-of-band checks say. That's a
feature: it's the layer that still works when synthetic voices are perfect.

Every quote in the evidence record is AssemblyAI's own transcribed text, verbatim — never a
paraphrase written by the agent. Facts are stored separately from interpretation, so no evidence
card ever depends on how the agent chose to phrase anything mid-call.

## Disclosure

All identities, companies, systems, and the attacking voice in the demo are synthetic; the
conversation, interruptions, and tool calls run live. No real personal data appears anywhere
in this repository.

---

*README structure (video, live demo, "why voice", architecture, deny conditions, evidence
format, adversarial corpus, measured latency, setup) fills in as the build progresses.*

## Measured latency (live AssemblyAI Voice Agent API, from the real stack)

| Date (CDT) | Runs | Connect → session.ready | session.ready → first reply audio | Notes |
|---|---|---|---|---|
| 2026-09-02 11:13 AM | 1 | 995 ms | 221 ms | `npm run smoke:live` from the founder's Mac in Austin; single run, no percentiles yet. p50/p95 over 50+ rehearsals land in week 3 (gate G5). |
| 2026-09-02 11:49 AM | 1 | 1740 ms | 76 ms | Same script, second run; voices endpoint returned 426 (fallback to `anna` worked). |

Method: `packages/server/scripts/smoke-live.ts` mints a token, opens the socket, sends `session.update`, times `session.ready`, then times the first `reply.audio` after the greeting. Opt-in only (`--live` + `ASSEMBLYAI_API_KEY`); never runs in CI.
