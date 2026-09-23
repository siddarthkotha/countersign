# One-brain live path — architecture plan

2026-09-22, night lane (SPIKE-ONE-BRAIN follow-up). Answers the question the founder's
external panel converged on (docs/PANEL-2026-09-22-LIVE-RELIABILITY.md): point AssemblyAI's
Voice Agent API at our own OpenAI-compatible endpoint so there is exactly one writer of
words, instead of today's two (AssemblyAI's managed automatic reply + our own instructed
`reply.create`). This plan is architecture only — no code changes. It does not touch
REPLAY-WITH-AUDIO (packages/web/src/screens/Replay.tsx, the corpus/audio work) — that lane
owns replay, which stays the PRIMARY judged path per the founder's 7:43 PM ruling (option
ii). Live calling stays a labeled experimental bonus, scoped to three cases (one STAGE, one
FREEZE, one ESCALATE; NO_ACTION optional) — never the thing a judge is asked to trust.

Every claim below is labeled PROVEN (source named inline), ESTIMATE (method named), or
UNKNOWN (how to find out named). PROVEN claims about the spike cite
`scripts/spike/out/gate-results-2026-09-23T01-03-20-290Z.json` (the final, full-battery run,
4.9 live minutes) unless another file is named.

## 0. What today's two-writer design actually costs (why this is worth doing)

`packages/server/src/call/session.ts` is 5,015 lines. A structural grep of its own method
list shows roughly 30 timers/counters/watchdogs whose entire job is managing the race
between AssemblyAI's automatic reply and our own instructed one: `CLOSE_GRACE_MS`,
`CLOSE_TOTAL_MS`, `CLOSE_RETRY_MIN_GAP_MS`, `REPLY_CREATE_LOST_MS`, `CLOSE_DONE_WAIT_MS`,
`CLOSE_TRANSCRIPT_WAIT_MS`, `CLOSE_REPLY_STUCK_MS`, `MAX_CLOSE_LOST_STREAK`,
`DEGRADED_MODE_STRIKE_THRESHOLD`, `DEGRADED_STRIKE_WAIT_MS`, `DEGRADED_INFLIGHT_STRIKE_MS`,
`DEGRADED_MAX_AUDIO_ONLY_MS`, `QUESTION_REASK_MAX`, `QUESTION_REASK_MAX_EMPTY`,
`QUESTION_TRANSCRIPT_WAIT_MS`, `QUESTION_ASKED_MAX`, `HOLD_FOLLOWUP_MS`,
`FORCE_SPEAK_SETTLE_MS`, `AUTOMATIC_REPLY_SETTLE_MS`, plus the methods that arm/clear them
(`scheduleCloseIfNeeded`, `armCloseRetryTimer`, `armCloseStuckWatchdog`,
`maybeSendReplyCreateForTick`, `maybeSendReplyCreateAfterReplyDone`,
`maybeSendOwedAfterCallerTurnEnds`, `maybeReaskQuestion`, `armQuestionReaskTimer`,
`recordDegradedStrike`, `mustForceSpeak`...). PROVEN: `grep -n` over that file (this
session). Every defect class in docs/AUTOPILOT_LOG.md's Day 4-13 entries (repeated
question, repeated goodbye, merged-freeze-goodbye, dead-transcript, stale-readback-spoken-
first) is a symptom of two writers, per all six panel seats (PANEL doc, Convergence #1).
One writer removes the race, not just one symptom of it.

## 1. The endpoint

**Revised 2026-09-22, post red-team (verdict SURVIVES-WITH-CHANGES).** The first draft of
this section proposed a SECOND, stateless `evaluate()` run inside the endpoint,
reconstructing conversation/tools/actions purely from AssemblyAI's `messages[]` history.
Red-team's fastest-killing finding: that reconstruction cannot reproduce
`recordGoalCompletionAction`'s own gate (`call/session.ts:3404-3473`, which only logs a
`challenge_issued`/`readback_issued` action when `transcriptAsksQuestion` matches the HEARD
text AND `noteQuestionAsked`'s cap allows it) — after an interruption, G4 already PROVES
request history diverges from heard text (gate-results.json, G4: "neither exact match"), so
a second, independent `evaluate()` could compute a DIFFERENT goal than the WS server's own
and speak a line contradicting the evidence panel. Orchestrator ruling, checked against the
code and adopted here: run the engine ONCE per call — the WS server's — and make the
endpoint a thin, stateless RENDERER of that already-correct, already-gated state, never a
second decision-maker.

**Where it lives, auth.** Unchanged from the first draft: a new route inside the existing
Node server (`packages/server/src/brain/endpoint.ts`, mounted in `http.ts`, path
`POST /api/brain/chat/completions`), guarded by a static bearer token
`COUNTERSIGN_BRAIN_API_KEY` (same constant-time check `http.ts` already uses for admin
routes, `isBearerTokenValid`, http.ts:144) — layered with the per-call token below.

**Per-call correlation, unguessable, no reconstruction needed.** G0B PROVEN: a second
`session.update` after `agent_id` binding can set `system_prompt` (gate-results.json,
"second session.update ... -> session.updated"). G1 PROVEN: our `system_prompt` arrives as
`messages[0]` in every endpoint request, verbatim (g1-last-request.json). So at connect,
`call/session.ts` mints a per-call cryptographically random token (e.g. `randomUUID()`) and
sends it embedded in the post-bind `system_prompt` (`COUNTERSIGN_CALL_TOKEN:<token>\n...`),
registering token → this `CallSession` in a process-wide `Map` (one Render process,
concurrency capped 1-2, caps.ts unchanged) — new module `packages/server/src/brain/
registry.ts`. This resolves G5's correlation question (two concurrent calls sharing one
stored agent, PROVEN indistinguishable by message content alone in the spike,
gate-results.json G5) by construction: two live calls carry two different tokens, no
content heuristic needed.

**Rendering.** The endpoint parses the token out of `messages[0]`, looks it up, and asks
the `CallSession` for its own CURRENT `goal` — the exact `PhrasingGoal`
`applyEvaluate()` (session.ts:4034) already computed from the WS server's own
transcript-derived engine run, the one path already gated by `recordGoalCompletionAction`.
It renders that goal's exact sentence (Lane A) or an empty completion if nothing changed
since the last turn. No `evaluate()` call in the endpoint, no actions-log reconstruction,
no possibility of divergence: exactly one engine run per call — a STRICTER reading of LAW
3's "a finite-state policy engine computes every verdict" (singular) than either the legacy
two-writer design or the abandoned stateless one.

**Unknown/expired token.** Immediate empty completion, never an error — also covers the
bootstrap race (the caller's first utterance could in principle complete before the
post-bind `session.update` carrying the token lands); the session's own idle-nudge
`reply.create` (§2) recovers it on the next tick.

**The ordering race, handled explicitly.** The endpoint's HTTP request and the WS server's
own `transcript.user` event are two independent deliveries from AssemblyAI; nothing
guarantees the HTTP POST arrives after the WS frame is processed. G1 PROVEN the request's
last `user` message is the caller's utterance verbatim (`g1-last-request.json`: "last user
msg matches transcript.user=true") — so the endpoint WAITS, bounded, rather than guessing.
`CallSession` gets a new `awaitCallerUtterance(text, timeoutMs)` hook (same promise-based
pattern `whenIdle()` already uses, session.ts:4997), resolved from inside
`dispatchAaiEvent`'s existing `transcript.user` handling the instant that exact text has
been folded into the conversation log and `applyEvaluate()` has run for it — matched by
"the conversation log now contains this utterance," not "is the latest one" (a second
caller fragment can race ahead of a slow HTTP delivery; its own test case, Lane B). Already
processed → resolves synchronously. Bound: 1500ms, with a role-only heartbeat delta written
to the SSE stream once per second while waiting (same keep-alive shape the BYO demo itself
uses every 2000ms, PROVEN `server.mjs:1382`, PANEL doc citation check; ours is tighter since
G7-delay only proved AssemblyAI tolerates up to 2.5s with NO heartbeat, gate-results.json).
**On timeout: empty completion** — never speak off stale state; the caller hears nothing
extra rather than a wrong line, and the next tick or idle-nudge catches up. Rejected
alternative: handing the caller's text directly into `CallSession`'s own event pipeline
instead of waiting for the real WS frame — rejected because AssemblyAI ALSO delivers that
same `transcript.user` over the WS independently, so this would double-process the same
utterance (no dedup precedent in this codebase) and would make the endpoint a second writer
of conversation state, not just of words, blurring the §2 boundary.

**`reply.create` nudges.** The trailing `system` message (`instructions`, PROVEN as a
literal trailing message in `g3-reply-create-request.json`) is treated purely as a TRIGGER,
never as engine input. On a nudge request there is no new caller utterance to wait for (the
server sent the nudge because its own state already knows what to say) — the endpoint
renders the session's current goal immediately, no wait.

**Duplicates/retries.** The endpoint never mutates anything, so any repeated or retried
request for the same token reads the same `CallSession` state and returns the same line —
idempotent by construction.

**What the endpoint returns, per engine state** (unchanged from the first draft's mapping,
now read off the session's own goal instead of a second `evaluate()`): a question owed
(ELICIT_IDENTITY/ELICIT_REQUEST/ELICIT_MISSING_CRITICAL), a trap question (ASK_CHALLENGE),
a readback (READBACK), a terminal verdict-and-goodbye (ANNOUNCE_*/CLOSE, `closeSentence`,
fsm.ts:278, already exact), the OUT_OF_SCOPE explanation/goodbye, a rotated STALL/CONTAIN
line, or EMPTY when nothing changed. **Engine-side gap this still surfaces, unchanged by
the redesign:** `prompt.ts`'s `nowSection` shows only 5 of 17 `GoalCode`s (`READBACK`,
`RE_ELICIT_AFTER_SWITCH`, `ELICIT_MISSING_CRITICAL`, `ELICIT_REQUEST`, `CLOSE`) already
carry an exact, ready-to-speak sentence in `goal.hint` — PROVEN by reading prompt.ts in
full. The other 12 rely today on LLM paraphrasing a DIRECTION into speech, which one-brain
removes entirely (Lane A, split into A1/A2 in §8). `ASK_CHALLENGE` is the hardest case:
`prompt.ts`'s own comment records a live incident where wrapping the challenge's `ask` in
"say exactly this" made the agent read its own stage directions aloud (prompt.ts:191-207).

## 2. The WS side (server)

`packages/server/src/aai/session.ts` (`RealAaiSocket`, `connectAai`, `mapServerEvent`) is
unchanged — the transport layer does not care who generates the automatic reply.
`call/session.ts`'s conversation/tools/actions bookkeeping and `applyEvaluate()`
(session.ts:4034) are now the ONE and ONLY engine-driving path in the system, shared
identically by legacy and endpoint modes.

**Added, small:** the token registry entry (register on call start, unregister on `end()`
so an expired token can never resurrect a dead session — see §9 risk 3); the
`awaitCallerUtterance` waiter list, resolved from inside the existing `transcript.user`
handling in `dispatchAaiEvent` — no new tick source, one more thing that path notifies.

**Deleted (endpoint mode only, behind the flag in §5) — every method whose job is managing
the two-writer race, listed in §0:** `maybeSendReplyCreateForTick`,
`maybeSendReplyCreateAfterReplyDone`, `maybeSendOwedAfterCallerTurnEnds`, `sendReplyCreate`
(for goal-changes — kept for the nudge case), `armReplyCreateLostTimer`,
`scheduleCloseIfNeeded`, `armCloseRetryTimer`, `armCloseStuckWatchdog`,
`checkCloseReplyStuck`, `armCloseTranscriptWait`, `maybeArmCloseOnTranscript`,
`maybeReaskQuestion`, `armQuestionReaskTimer`, `armQuestionTranscriptWait`,
`recordDegradedStrike` and its arming/checking siblings, `maybeArmHoldFollowup`,
`armHoldFollowupTimer`, `mustForceSpeak`, `bareHoldAfterAlreadyAsked`. Under one-brain,
AssemblyAI calls our endpoint once per completed caller turn (G1 PROVEN) and the words are
already correct by construction (§1) — nothing left to detect, retry, or reconcile.

**Kept, unchanged:** the heard-text ledger from `transcript.agent` — still the ONLY record
of what was asked, still what `recordGoalCompletionAction` and `challenges.ts`'s grading
read (§3); `transcriptMatchesCloseSentence`/`closeMatch.ts` as a goodbye DETECTOR, not a
sender, closing `aai.close()` after that reply's `reply.done` (G6 PROVEN: exactly-one-
goodbye 3/3, clean close 3/3); idle/minute caps, kill switch, concurrency limits
(unchanged, orthogonal); the silent-caller nudge (idle no-action goodbye, out-of-scope
timed goodbye) via one `reply.create`, words rendered by the endpoint from the session's
own current goal (§1's nudge handling).

**Dead-man's switch, unchanged reasoning:** the endpoint must never throw (always 200, an
empty completion on any internal failure); a single generous timer (~15s) that, if no
`reply.done` ever arrives after a caller turn, ends the call cleanly rather than hanging.
G7-500's one data point ("session accepted a normal turn afterward=false," gate-results.json)
is now a dedicated verification lane (§8, G7-verify), not an assumption.

## 3. The consistency problem — resolved by construction, one race remains

The original consistency concern (two independent `evaluate()` runs disagreeing) no longer
exists: §1's redesign means there is exactly ONE engine run per call, the WS server's, and
the endpoint only ever reads its already-computed, already-gated `goal`. The G4 heard-vs-
generated mismatch ("neither exact match," gate-results.json) that killed the first design
is now irrelevant to word choice too, not just to scoring — the endpoint never
reconstructs anything from `messages[]` beyond the token and (for the wait in §1) the
literal last caller utterance to match against.

**What LAW 4 (exact-transcript evidence) still guarantees, unchanged:** `challenges.ts`'s
`gradeChallenges` and `evidence/fromTools.ts` are fed exclusively by the WS server's own
conversation log, built from `transcript.agent`/`transcript.user` — never touched by
anything in `packages/server/src/brain/`. A structural test (§6, "never-cross-this-line")
asserts this, now trivially true: the brain module has no dependency on `evaluate`,
`gradeChallenges`, or `mockToolResult` at all — it doesn't need them.

**What remains a real risk, named plainly:** the ORDERING RACE in §1 — not a consistency
problem between two engines, but a timing problem in one. Its cost is a bounded per-turn
wait (up to 1500ms, usually far less) that existed in neither prior design, and, on
timeout, a turn where the caller hears nothing rather than something wrong. §9 names this
with its own measurement task (Lane G).

## 4. Stored-agent lifecycle

**How many, created when.** ONE stored agent for the whole process, created idempotently
at server startup inside `index.ts` (mirrors today's synchronous `createAai` factory
pattern): on boot, `GET /v1/agents` (list — UNKNOWN whether this exists; VERIFY-AT-BUILD
against `manage-agents.txt`/`.html` in the saved docs before Lane D starts), look for one
named `countersign-brain`, reuse its `id` if found, else `POST /v1/agents` to create it.
Concurrency stays capped at 1-2 (existing caps.ts, unchanged). The per-call token (§1)
routes each request to its own `CallSession` regardless of what two calls happen to say —
G5's own spike result ("bodies distinguishable purely by their own messages content:
false," gate-results.json) is no longer the mechanism correctness depends on. What still
needs live re-verification is the registry itself (Lane G5-verify, §8/§9 risk 7), not
message-content disambiguation.

**Voice/greeting config.** Move from `index.ts`'s inline `AaiSessionConfig`
(`DEFAULT_VOICE`, `DEFAULT_GREETING`, aai/config.ts) into the stored agent's OWN creation
payload — PROVEN required: binding via `agent_id` "is mutually exclusive with inline
session fields" (PANEL doc, Round 2 citation check, "Stored agents"). Same constants,
same values, just moved from `buildInitialSessionUpdate`'s session-level fields to the
`createAgent` REST payload's `voice`/`greeting` fields (spike's `lib.ts createAgent`,
lines 91-118, is the proven shape to promote into real server code).

**What goes in the post-bind `session.update`.** Two-step connect, PROVEN by G0/G0B: first
`{type:'session.update', session:{agent_id}}`, wait for `session.ready`; then a SECOND
`session.update` (G0B PROVEN: `session.updated` ack) carrying ONLY:
- `system_prompt`: NOW load-bearing (revised, §1) — carries `COUNTERSIGN_CALL_TOKEN:<token>`,
  the per-call correlation token the endpoint parses out of `messages[0]` on every request.
  Not a persona/boilerplate marker any more; the endpoint reads it, doesn't ignore it.
- `keyterms`: proper nouns and domain words only (seat 6's caution, PANEL doc Round 2) —
  the seed's identity names (`Meridian Supply`, `Northgate Partners`, `Marcus Obi`, `Dana
  Whitfield` — already the exact spike list) — symmetric trap pairs or none, never biased
  toward a correct answer.
- `input.transcription_mode: 'max_accuracy'` — PROVEN in G8: 1 request per utterance
  through 1.0-1.2s mid-sentence pauses, 3/3 and 3/3 (gate-results.json, G8).
- NO `min_silence`/`max_silence` — unchanged reasoning from the existing Sep-18/19
  finding already coded into `aai/config.ts`'s long comment block: setting either disables
  adaptive pacing/entity-aware waiting for the rest of the session (PROVEN, docs quote
  already in the codebase).
- `voice`, `output.format.encoding`, `greeting`, `tools`, `llm` are NEVER resent here — all
  five are fixed on the stored agent itself (voice/greeting/tools/llm at creation) or
  immutable-once-set (output encoding), same law `aai/config.ts`'s existing module comment
  already states for the legacy path.

## 5. Feature flag

`COUNTERSIGN_BRAIN` env var, values `endpoint | legacy`, default `legacy` (matches the
existing `COUNTERSIGN_TURN_DETECTION` explicit/omit pattern in `aai/config.ts`). In
`index.ts`'s `createAai`, branch on it: `legacy` runs today's exact code path, byte-for-byte
unchanged (no risk to what already works); `endpoint` runs the new stored-agent bind flow
(§4) and, in `call/session.ts`, either a flag that no-ops the reply.create/timer machinery
(§2) or — the RECOMMENDED approach — a new, smaller `CallSession`-equivalent written from
scratch for endpoint mode rather than threading a flag through a 5,015-line file with a long
history of subtle live-only regressions (per "if the same fix fails twice, stop and change
approach," CLAUDE.md). The two share the transport layer (`aai/session.ts`) and the engine
(`@countersign/engine`) unchanged; they diverge only in how they react to `transcript.*`
events. This keeps the legacy path provably untouched — the safest possible rollback story
for a flag that stays off by default until proven.

**Harness/tests exercise both.** The rehearsal harness (`scripts/rehearse/*`) already runs
against a live/deployed server; parametrize it to accept `COUNTERSIGN_BRAIN` and run the
SAME three scenarios against both modes. Endpoint-mode coverage is intentionally scoped to
the three demo cases (STAGE/FREEZE/ESCALATE) per the founder's option (ii) ruling — not the
full 33-case corpus the legacy path is graded against. The sibling REPLAY-WITH-AUDIO lane
has already staged exactly these three as new corpus files: `packages/engine/corpus/
recorded-{stage,freeze,escalate}.json` (present as untracked files in this session's git
status) — natural fixtures for Lane G below; this plan only reads them, never edits them
(outside this plan's LANE-FILES).

## 6. Tests

1. **Render correctness** — a fake `CallSession` exposing a fixed `goal`; assert the
   endpoint's render function returns Lane A's exact composed sentence (or empty, when the
   goal is unchanged). No corpus replay needed — there is no reconstruction to prove (§1).
2. **Ordering-race behavior** — a fake `CallSession` stub whose `awaitCallerUtterance`
   resolves after an injectable, test-controlled delay (same fast/no-op-sleep-injection
   pattern `aai/session.ts`'s own tests already use for its bounded resume backoff):
   (a) already-processed utterance resolves synchronously, new goal rendered; (b) resolves
   within 1500ms, new goal rendered; (c) never resolves, 1500ms timeout fires, empty
   completion rendered; (d) heartbeat role-only deltas written at the specified interval
   while waiting.
3. **Unknown/expired token** → immediate empty completion, no wait, no error.
4. **`reply.create` nudge** — trailing system message triggers an immediate render of the
   session's current goal, no wait.
5. **Idempotent retries** — the same token + same `messages[]` requested twice returns the
   identical response both times.
6. **Token-routing under concurrency** — two DIFFERENT fake `CallSession`s registered under
   two DIFFERENT tokens, concurrent requests via `Promise.all`; assert no cross-talk. Unit-
   level proof that complements the LIVE re-verification in Lane G5-verify (§8).
7. **SSE framing conformance** — role-only first delta, content chunk(s), a final delta
   with `finish_reason: 'stop'`, then `data: [DONE]` (matching the spike's own proven shape
   and the BYO demo's, `server.mjs` lines ~475-486, ~1374-1464, PANEL doc citation check).
8. **Never-cross-this-line** — a structural test asserting `packages/server/src/brain/**`
   has no import of `evaluate`, `gradeChallenges`, or `mockToolResult` — the design
   invariant from §3, cheap to keep true forever.
9. **Token lifecycle** — registering, then ending a call unregisters its token; a request
   against that now-unregistered token gets the "unknown token" empty-completion path, not
   a stale render of a dead session.
10. **Grader expectations** — the existing harness grader (already scoring goodbye/verdict/
    talk-over per AUTOPILOT_LOG's Day 9-13 entries) runs unchanged against endpoint-mode
    live calls for the three cases; no new grading logic, same bar as today.

## 7. First task: decode the G2 empty-reply audio

The spike deliberately did not log raw `reply.audio` bytes ("Don't log full reply.audio
payloads... record length only," `scripts/spike/wsClient.ts:65-70`), so the ~4s of audio
streamed per empty completion (G2 PROVEN: 10/10 reps leaked audio despite empty content,
gate-results.json) has never been decoded. Task: a short, separate spike script
(`scripts/spike/decode-empty-audio.ts`, ~1 live minute, reusing `wsClient.ts`/`endpoint.ts`
unchanged) that repeats ONE empty-completion turn, this time saving the raw base64 PCM16
`reply.audio` chunks to a local file, then computing RMS per frame
(`sqrt(mean(sample^2))` over the Int16 samples). If RMS stays under a low noise floor
(ESTIMATE placeholder ~50 on the 16-bit scale, calibrated against a KNOWN-silent reference
frame from the same session, not an assumed constant) across the whole ~4s, conclude it is
silence and no fallback is needed. If RMS is meaningfully above that floor, the fallback:
never send a literally-empty completion; send a short deterministic line, or drop audio
here entirely and rely on the UI's own "Listening" indicator (2 of 6 panel seats already
argued for exactly this as the primary design, PANEL doc Round 2 — a proven-acceptable
fallback, not an invented one). No dependency on any other lane; should run FIRST.

## 8. Ordered tasks, sized for parallel lanes

Lane naming follows this repo's `LANE-FILES` convention. Smaller than the first draft's
lane set — the single-engine-run redesign (§1) removes the reconstruction module entirely.

- **Lane F — RMS decode** (§7). Files: `scripts/spike/decode-empty-audio.ts`,
  `scripts/spike/out/g2-audio-rms.json`. No dependency. ESTIMATE 0.5-1 session-hour, ~2
  live minutes.
- **Lane A1 — engine sentence composition, non-challenge goals.** The 11 remaining
  `GoalCode`s besides `ASK_CHALLENGE` still relying on LLM paraphrasing today (`GREET`,
  `ELICIT_IDENTITY`, `STALL`, `PROBE_CONSISTENCY`, `REFUSE_AUTHORITY`, `ANNOUNCE_STAGED/
  FROZEN/ESCALATED`, `CONTAIN`/`CONTAIN_NO_DISCLOSURE`, `EXPLAIN_OUT_OF_SCOPE`,
  `EXPLAIN_OPEN_REQUEST`). Files: `packages/engine/src/fsm.ts`,
  `packages/engine/test/fsm.test.ts`. No dependency. Gate: `npm test` + typecheck in
  `packages/engine`, plus the ambition pass (CLAUDE.md THE RITUALS #3). ESTIMATE 1.5-2
  session-hours.
- **Lane A2 — `ASK_CHALLENGE` field x trap-value templates, scoped separately (red-team
  ranked change #2).** The hardest content-authoring piece, not a small extension of A1:
  every critical field (`amount_usd`/`account_last4`/`beneficiary`) times every trap-pair
  variant in the seed needs a genuinely natural spoken question, with no LLM left to smooth
  a bad template — exactly the failure mode `prompt.ts`'s own comment documents from a live
  incident (prompt.ts:190-207: "say exactly this" made the agent read its own stage
  directions aloud). Files: `packages/engine/src/challenges.ts` (the `ask` string
  composition), `packages/engine/src/seed/meridian.ts` (trap-pair data, read not
  necessarily changed), `packages/engine/test/challenges.test.ts`. No dependency. Gate:
  `npm test` + typecheck, PLUS a listen-back (TTS or read aloud) of every composed question
  before this lane is done — this content IS the trap. ESTIMATE 4-5 session-hours
  (red-team's own estimate, adopted as-is).
- **Lane B — token registry + `awaitCallerUtterance` hook + reply.create-machinery
  removal** (§1, §2). Files: `packages/server/src/call/session.ts` (additive, behind
  `COUNTERSIGN_BRAIN` — §5), new `packages/server/src/brain/registry.ts`, new
  `packages/server/test/session-endpoint-mode.test.ts`. Can start alongside A1/A2 (disjoint
  files); its own wait/timeout/routing tests (§6 items 2, 6, 9) don't need Lane A's exact
  text, but the full "renders the RIGHT words" gate does — sequence that final check after
  A1/A2 merge. Gate: `npm test`, typecheck, AND the full existing `session.test.ts`/
  `design-e-turn-order.test.ts` suite for the LEGACY path stays 100% green (regression
  proof the flag's off-path is untouched). ESTIMATE 3-4 session-hours.
- **Lane C — endpoint HTTP handler** (§1's render/wait/heartbeat/timeout logic, SSE
  framing, static-bearer auth). Files: new `packages/server/src/brain/endpoint.ts`,
  `packages/server/test/brain/endpoint.test.ts`, a new route in `http.ts`. Depends on Lane
  B (needs the registry + hook interfaces; can start against a stub before B merges for
  real). Smaller than the first draft's Lane C — no reconstruction module to write against.
  Gate: `npm test` (§6 items 1, 3, 4, 5, 7, 8), typecheck, a manual `curl` smoke test
  against `npm run dev:server`. ESTIMATE 2-3 session-hours.
- **Lane D — index.ts/aai/config.ts wiring + feature flag + per-call token generation**
  (§4, §5). Files: `packages/server/src/index.ts`, `packages/server/src/aai/config.ts`
  (new `buildAgentBindUpdate`/`buildPostBindSessionUpdate` carrying the token, additive).
  Depends on Lane C (route must exist) and Lane B (token-generation function). Gate: `npm
  test`, typecheck. ESTIMATE 2 session-hours.
- **Lane G5-verify — live token-routing re-verification, hour-budgeted (red-team ranked
  change #3).** Two REAL concurrent calls with genuinely DIFFERENT scripted conversations
  (not the spike's identical lines, gate-results.json G5) against the live endpoint +
  stored agent; assert each call's requests are routed to and answered from its own
  token/session only. Files: an addendum under `scripts/spike/`. Depends on Lane D.
  ESTIMATE 1 session-hour, ~2-3 live minutes.
- **Lane G7-verify — live repeated-500 re-verification, hour-budgeted (red-team ranked
  change #3).** Force the endpoint to HTTP 500 several times in a row (not once, like the
  original spike) against a live session; confirm whether/when the dead-man's switch (§2)
  recovers the call, and that legacy mode is unaffected. Depends on Lane C only (can run
  parallel to D). ESTIMATE 1 session-hour, ~1-2 live minutes.
- **Lane G — harness/grader dual-mode, with a hard stop gate (red-team ranked change #4).**
  Files: `scripts/rehearse/*` (parametrize `COUNTERSIGN_BRAIN`), reads (never edits)
  `packages/engine/corpus/recorded-{stage,freeze,escalate}.json`. Depends on Lane D and
  both G5-verify and G7-verify (a live endpoint re-verified on its two named risks, before
  spending a founder-facing grading run on it). **Hard stop:** if the FIRST live
  endpoint-mode harness run fails its grade twice in a row, STOP — ship legacy + replay for
  any founder or judge session, park endpoint mode with the failure recorded, and do not
  attempt a third live run the same day (this repo's own batch-cadence rule, memory
  "Batch cadence and session budget," applies the same way here). Gate on success: 3
  consecutive clean runs of all three cases, zero resets — the same bar G2 already set for
  the legacy path (docs/AUTOPILOT_LOG.md, G2). ESTIMATE 1-2 session-hours.

**Merge order:** F any time. A1, A2, and B all start together (disjoint files). C after B
(stub-able earlier). D after C. G5-verify after D; G7-verify after C (parallel to D/
G5-verify). G after D + G5-verify + G7-verify (and after A1/A2 have merged into B's final
gate). **Go/no-go before any founder session:** legacy-path test suite still 100% green AND
Lane G's 3-consecutive-clean bar met AND the hard stop above has not fired — only then does
`COUNTERSIGN_BRAIN=endpoint` ever reach a live founder call; otherwise the flag's own
default (`legacy`) is what he hears.

**Critical path:** B(4) + C(3) + D(2) + max(G5-verify, G7-verify)(1) + G(2) ≈ 12
session-hours. A1(2)/A2(5) run alongside B/C/D without extending the path (5h < the 9h
elapsed before G needs them). ESTIMATE — about 3 session-hours less than the abandoned
design's 15h critical path, since single-engine-run is genuinely smaller work, not just
safer.

## 9. Risks and explicit non-scope

**Risks:**
1. G2's leaked ~4s `reply.audio` on empty completions is UNKNOWN silence — Lane F resolves
   this before Lane C ships the speak-or-silence rule; if not silent, the panel-sanctioned
   fallback (no audible nudge, UI-only "Listening") applies (§7).
2. **The ordering-race wait is a new latency source** (§1, §3) that existed in neither the
   legacy two-writer design nor the abandoned stateless one — even the common near-instant
   case adds some per-turn delay, and a timeout costs a full silent turn. Lane G's harness
   must measure actual wait-time p50/p95, not just total round-trip latency, before 1500ms
   is trusted as well-calibrated (CLAUDE.md: never write "sub-second" without measured
   numbers).
3. **The per-call token is a capability, not a secret from the caller's ears** (never
   spoken) but it DOES cross the public HTTPS endpoint boundary in every request body — it
   must be cryptographically random, scoped to one call's lifetime, and removed from the
   registry the instant the call ends (§2), so a captured or replayed old token can never
   resurrect or impersonate a dead session's state.
4. **The bootstrap race**: the caller's first utterance could in principle complete before
   the post-bind `session.update` carrying the token lands (§1) — handled by the
   unknown-token empty-completion fallback, not yet measured live; Lane D's gate should
   include a first-turn-timing check.
5. G7-500's one data point ("session accepted a normal turn afterward=false,"
   gate-results.json) is a real, unresolved concern — now a dedicated lane (G7-verify, §8)
   rather than an assumption the dead-man's switch alone fixes it.
6. Lane A2 (`ASK_CHALLENGE` templates) is the highest content-risk piece of this plan — a
   stiff or template-sounding trap question undermines the mechanism LAW 1 depends on, with
   no LLM left to smooth it live. Scoped and estimated separately (4-5h) per red-team's own
   ranked change #2, not folded into A1's smaller estimate.
7. G5's live re-verification (Lane G5-verify) tests ROUTING correctness, now provable by
   construction (distinct tokens, §1) — but the registry itself (a plain in-process `Map`)
   still needs proving leak-free (risk 3) and collision-free under real concurrent connects,
   not just asserted.

**Explicitly out of scope** (per the founder's option (ii) ruling and CLAUDE.md's existing
scope fence, both unchanged by this plan): only three live cases (STAGE/FREEZE/ESCALATE,
NO_ACTION optional) — no broader live-call production ambition; replay-with-audio stays the
primary judged path, live stays a labeled experimental bonus. No LLM anywhere in the reply
path, live or otherwise — the endpoint is a deterministic relay of the engine's own
composed sentence, a hardening of LAW 3, not an exception. No change to acoustic
classifiers, real banking/SSO/SIEM integrations, carrier telephony, multi-agent
architectures, or any other scope-fence item. No change to abuse caps (idle timeout,
per-session minute cap, concurrency 1-2, kill switch) — reused unchanged. No change to
REPLAY-WITH-AUDIO's own files (packages/web/src/screens/Replay.tsx, the audio corpus,
packages/server/src/replay.ts, http.ts's existing `/api/replay*` routes) beyond the one new
route Lane C adds.
