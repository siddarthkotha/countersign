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

**Where it lives.** A new route inside the EXISTING Node server
(`packages/server/src/index.ts` → `packages/server/src/http.ts`'s HTTP server), not a
second process — Render already exposes this server's port publicly over HTTPS, which the
`llm.base_url` requirement demands ("HTTPS + public host... rejected" if not — PROVEN,
`connect-your-own-llm.md` "Requirements & behavior"). New module
`packages/server/src/brain/endpoint.ts`, mounted as one more `path ===` branch in
`http.ts`'s `handleRequest` (same pattern every other route there already uses), path
`POST /api/brain/chat/completions`.

**Auth.** A single static bearer token, `COUNTERSIGN_BRAIN_API_KEY` (generated once, stored
as a Render secret, set as the stored agent's `llm.api_key` at creation). Checked with the
same constant-time comparison `http.ts` already has for the admin routes
(`isBearerTokenValid`, http.ts:144). Why one shared token, not per-call: see the
correlation decision below. The AssemblyAI BYO demo's own README says to "Treat your
endpoint as public the moment it's live" (PROVEN, PANEL doc Round 2 citation check) — a
static token is the minimum bar, matching what the demo itself does.

**Mapping (messages, model) → engine inputs — the central design decision.** The spike
proved the endpoint must be a pure function with no reliable call identity: G5 showed no
`session_id`/`call_id` in any header or body (PROVEN, gate-results G5), and the round-2
panel disagreement over correlation (per-call api_key, call id in `base_url`, or none) was
never resolved live. This plan resolves it by NOT needing correlation at all:

- `evaluate()` (packages/engine/src/evaluate.ts) is already a pure function of
  `(conversation, tools, actions, call, seed)` — PROVEN by reading the file; it has no
  clock or random source (its own doc comment says so, line 6).
- There is only one seed in the whole system, `MERIDIAN` — PROVEN,
  `packages/server/src/replay.ts`'s own comment: "there is only one synthetic world,
  MERIDIAN."
- Tool results are pure: `mockToolResult(name, args, seed, ctx)` (packages/engine/src/
  mock/backend.ts) is a plain switch with no I/O, no `Date.now()`, no `Math.random()` —
  PROVEN by reading the file in full (85 lines). `ctx.incident_index` only changes a
  cosmetic `INC-` number, never verdict logic.

So the endpoint needs nothing external per call except the `messages` array AssemblyAI
already sends. It reconstructs engine input as follows:

1. **Conversation.** Drop the leading `system` message (provider boilerplate + our
   persona line — PROVEN present in every spike request body, e.g.
   `scripts/spike/out/g1-last-request.json`) and any trailing `system` message (a
   `reply.create`'s `instructions`, PROVEN as a literal trailing `{role:'system', content:
   'spike G3 probe'}` in `scripts/spike/out/g3-reply-create-request.json`) — that trailing
   message is a TRIGGER only, never engine input (see the silent-caller nudge below). Every
   remaining `user` message → `Utterance{speaker:'caller', text: content}`; every remaining
   non-empty `assistant` message → `Utterance{speaker:'agent', text: content.trim()}`.
   `t_ms` is synthesized as a monotonically increasing index (e.g. `i * 1000`) — ESTIMATE
   safe, since `evaluate()`'s only `t_ms`-sensitive logic is ordering
   (`freezeAtSeal`, evaluate.ts:54) and diagnostics, not real elapsed time; VERIFY-AT-BUILD
   by grepping `t_ms` usage across `packages/engine/src` before Lane B ships.
2. **Tools log — "the replay-to-reconstruct algorithm."** `call/session.ts`'s
   `runLookupsIfNeeded` (session.ts:3959) and `runTerminalActionsIfNeeded` (session.ts:
   4879) already show tool-running is driven ENTIRELY by engine state (EVIDENCE/
   CONSISTENCY_CHECK → run the three lookups; terminal verdict → run the terminal actions),
   never by anything the model says (the model is offered zero tool schemas —
   `allowedTools` always returns `[]`, fsm.ts:67-69, PROVEN by reading it). The endpoint
   replicates this as a synchronous fixed-point loop, reusing the SAME `mockToolResult` +
   `argsForTerminalTool` (packages/server/src/call/terminalActions.ts, already shared with
   replay.ts) the live server uses: `evaluate()` → if state needs a lookup or owes a
   terminal action, run it, append to a local tools array, re-`evaluate()`, repeat (bounded
   to ~5 iterations). Because `mockToolResult` never throws in its current form, this
   never needs the live server's retry/abandon machinery.
3. **Actions log — the one genuinely new piece of engineering.** `evaluate()` needs
   `actions` to know which challenge/readback is already pending
   (`awaitingChallenge`, fsm.ts:358, reads `challenge_issued` actions) — the endpoint has no
   stored actions log. Resolution: REPLAY the conversation prefix-by-prefix. For each
   caller turn in order, run `evaluate()` on the conversation-so-far with the actions
   log built SO FAR, take the resulting `goal`, and if that goal's code implies an action
   (`challenge_issued`/`readback_issued`/`elicit_issued`), synthesize the same
   `AgentAction` `call/session.ts`'s `recordGoalCompletionAction` (session.ts:3404) would
   have written, then continue to the next turn. Because both sides are the same pure
   function fed the same growing transcript, the reconstructed actions log is bit-identical
   to what a live `CallSession` would have logged for that same transcript — this is an
   ESTIMATE (needs the corpus test in Lane B, item 6, to prove it holds for all 128+3
   fixtures), not yet proven. Cost: O(turns-so-far) `evaluate()` calls per request, each a
   pure in-memory computation — ESTIMATE low single-digit ms per turn, needs measuring
   (item 8/9, Lane G).
4. **What the endpoint returns, per engine state:**
   - Nothing changed since the last turn (a fragment like "Meridian." mid-name that didn't
     complete a claim) → EMPTY completion (see the speak-or-silence rule below).
   - A question is now owed (ELICIT_IDENTITY/ELICIT_REQUEST/ELICIT_MISSING_CRITICAL) or a
     trap question (ASK_CHALLENGE) or a readback (READBACK) → the composed sentence,
     verbatim, no paraphrasing.
   - Terminal verdict reached (ANNOUNCE_*/CLOSE) → the composed verdict-and-goodbye
     sentence, verbatim, as ONE reply (today's CLOSE sentence composition,
     `closeSentence`, fsm.ts:278, is already exact and reusable unchanged).
   - OUT_OF_SCOPE → the composed demo explanation, then (once explained) the composed
     goodbye.
   - STALL/CONTAIN → a rotated line from a small deterministic set (STALL already has this
     via `stalls.ts`; CONTAIN needs the same treatment — see Lane A).
   **Engine-side gap this surfaces:** `packages/server/src/call/prompt.ts`'s `nowSection`
   shows only 5 of 17 `GoalCode`s (`READBACK`, `RE_ELICIT_AFTER_SWITCH`,
   `ELICIT_MISSING_CRITICAL`, `ELICIT_REQUEST`, `CLOSE`) already carry an exact,
   ready-to-speak sentence in `goal.hint` today — PROVEN by reading prompt.ts in full. The
   other 12 (`GREET`, `ELICIT_IDENTITY`, `ASK_CHALLENGE`, `STALL`, `PROBE_CONSISTENCY`,
   `REFUSE_AUTHORITY`, `ANNOUNCE_STAGED/FROZEN/ESCALATED`, `CONTAIN`/
   `CONTAIN_NO_DISCLOSURE`, `EXPLAIN_OUT_OF_SCOPE`, `EXPLAIN_OPEN_REQUEST`) rely today on an
   LLM paraphrasing a DIRECTION into natural speech — that LLM freedom is exactly what a
   one-brain design removes (the task brief's own words: "no LLM anywhere in the reply
   path"). This is Lane A below, and it is a genuine content-writing task, not plumbing.
   `ASK_CHALLENGE` is the hardest case: `prompt.ts`'s own comment records a live incident
   where wrapping the challenge's `ask` field in "say exactly this" made the agent read
   its own stage directions aloud (prompt.ts:191-207) — so `challenges.ts`/seed data need
   real natural-language trap questions authored, not just a template wrapper.

## 2. The WS side (server)

**Unchanged.** `packages/server/src/aai/session.ts` (`RealAaiSocket`, `connectAai`,
`mapServerEvent`) is the transport layer — it does not care whether the automatic reply
came from AssemblyAI's managed model or our endpoint. `call/session.ts`'s core
responsibility — re-run `evaluate()` on every `transcript.user`/`transcript.agent`/
`tool.call`/`session.*` event, drive `ScreenState`, own the conversation/tools/actions logs
from the LIVE transcript (never from the endpoint's own internal reconstruction) — is
UNCHANGED and stays the single LAW-3/LAW-4 authority. This is the critical compliance
boundary, stated explicitly: **the endpoint's reconstructed engine run decides WORDS only;
the WS server's own transcript-derived engine run is the ONLY thing that ever fires
`runTerminalActionsIfNeeded` (freeze/stage/escalate/incident/seal) and builds the evidence
export.** LAW 2 ("voice never releases the wire") holds exactly as it does today, because
the wire-releasing code path (`runTerminalActionsIfNeeded`, session.ts:4879) never reads
anything the endpoint computed — it only reads `this.last`, the server's own live
`evaluate()` result.

**What gets deleted (endpoint mode only, behind the flag in §5).** Every method whose job
is managing the two-writer race, listed in §0: `maybeSendReplyCreateForTick`,
`maybeSendReplyCreateAfterReplyDone`, `maybeSendOwedAfterCallerTurnEnds`, `sendReplyCreate`
(for goal-changes — see the one exception below), `armReplyCreateLostTimer`,
`scheduleCloseIfNeeded`, `armCloseRetryTimer`, `armCloseStuckWatchdog`,
`checkCloseReplyStuck`, `armCloseTranscriptWait`, `maybeArmCloseOnTranscript`,
`maybeReaskQuestion`, `armQuestionReaskTimer`, `armQuestionTranscriptWait`,
`recordDegradedStrike`, `armDegradedStrikeCheck`, `armDegradedInflightStrikeCheck`,
`checkDegradedInflightStrike`, `armDegradedMaxAudioOnlyCheck`, `maybeArmHoldFollowup`,
`armHoldFollowupTimer`, `mustForceSpeak`, `bareHoldAfterAlreadyAsked`. Under one-brain,
AssemblyAI calls our endpoint once per completed caller turn (PROVEN, G1: 1 request, exact
words match, gate-results.json) and the words ARE already correct by construction — nothing
to detect, retry, or reconcile.

**What is kept, simplified:**
- The heard-text ledger from `transcript.agent` — UNCHANGED, and now MORE important: it is
  the only authoritative record of what the caller actually heard (see §3).
- `transcriptMatchesCloseSentence`/`closeMatch.ts` — kept as a DETECTOR (did the goodbye
  arrive and get heard?), not a sender. Once detected, call `aai.close()` after that
  reply's `reply.done` (G6 PROVEN: exactly-one-goodbye 3/3, clean close 3/3).
- Idle/minute caps, kill switch, concurrency limits — UNCHANGED (ws/browser.ts, caps.ts),
  orthogonal to which writer speaks.
- **One kept exception: the silent-caller nudge.** When the engine's own state calls for
  speech with no caller turn to trigger it (idle no-action goodbye, the out-of-scope timed
  goodbye), the server still sends ONE `reply.create` — but its WORDS still come from the
  SAME endpoint (G3 PROVEN: `reply.create` routes through our endpoint once, its
  `instructions` arrive as a trailing system message we treat as a trigger flag, never as
  engine input). This directly matches round-2 disagreement item "Silent-caller nudge":
  seats 1/4/5/6 wanted exactly this design.
- **A dead-man's switch, new and small.** G7-500's one data point is concerning: after our
  endpoint returned HTTP 500, "session accepted a normal turn afterward=false" (PROVEN,
  gate-results.json, G7-500). The endpoint itself must never throw (outermost handler
  wraps everything, always returns 200 with a safe fallback — re-send the current goal's
  own composed sentence rather than propagate an error) — belt-and-suspenders in case a
  bug slips through, a single generous timer (e.g. 15s) that, if no `reply.done` ever
  arrives after a caller turn, ends the call cleanly with the degraded-mode framing rather
  than hanging silently. This replaces ~20 timers with 1.

## 3. The consistency problem

Two independent `evaluate()` runs now exist per call: the endpoint's (fed AssemblyAI's own
`messages` history) and the WS server's (fed its own `transcript.user`/`transcript.agent`
events). Both are the SAME pure function; both are ultimately fed by the SAME underlying
source — AssemblyAI's own STT — so on a clean turn they compute the same goal. They can
diverge only in HOW the raw transcript text is turned into `Utterance[]` (trimming,
ordering, whether an interrupted reply's FULL generated text or its ACTUAL heard text is
used). To keep them provably in sync: the endpoint's message→Utterance conversion (§1,
step 1) and the server's own `utteranceFromTranscript` (packages/server/src/call/events.ts,
already used by `call/session.ts`) should be the SAME shared pure function, not two
hand-written copies — a Lane B file-sharing task, not a new algorithm.

**The G4 heard-vs-generated mismatch is already handled — by design, not by this plan.**
G4 PROVEN: after an interruption, the next endpoint request's OWN history held neither the
full generated text nor the exact heard text ("neither exact match," gate-results.json,
G4). This matters for WORD CHOICE (the endpoint might reference something slightly off) but
NOT for scoring: `challenges.ts`'s `gradeChallenges` — the thing that decides whether a trap
was passed or failed — is fed the WS server's OWN conversation log, which is built from
`transcript.agent` (LAW 4: exact-transcript evidence), never from the endpoint's internal
reconstruction. This is UNCHANGED by one-brain. So item 3's scoring risk ("never score a
missing correction unless the trap was heard") is already satisfied by the existing
architecture and needs no new code — only a regression test proving the endpoint's own
reconstruction is never wired into `gradeChallenges`/evidence building (Lane E, a
never-cross-this-line assertion, cheap to write).

## 4. Stored-agent lifecycle

**How many, created when.** ONE stored agent for the whole process, created idempotently
at server startup inside `index.ts` (mirrors today's synchronous `createAai` factory
pattern): on boot, `GET /v1/agents` (list — UNKNOWN whether this exists; VERIFY-AT-BUILD
against `manage-agents.txt`/`.html` in the saved docs before Lane D starts), look for one
named `countersign-brain`, reuse its `id` if found, else `POST /v1/agents` to create it.
Concurrency stays capped at 1-2 (existing caps.ts, unchanged) — G5's own result was
UNKNOWN, not PASS: "bodies distinguishable purely by their own messages content: false"
(gate-results.json, G5) — but that null result is a spike artifact (both sessions in that
test spoke byte-identical scripted lines on purpose); it does not prove real concurrent
calls (which will have different caller speech) collide. Flagged as a risk in §9, to be
re-verified with two genuinely different scripted conversations before trusting it under
concurrency 2.

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
- `system_prompt`: a short marker, unused by our own endpoint (which ignores it entirely,
  matching the spike's own convention, `scripts/spike/run.ts:160`) — kept only because
  AssemblyAI's schema still expects one.
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

1. **Pure endpoint-logic tests**, importing the REAL engine (LAW: never a copy) — new
   `packages/server/test/brain/reconstruct.test.ts` and `.../endpoint.test.ts`. Feed the
   reconstruction function `messages[]` arrays built by converting
   `packages/engine/corpus/*.json` (all 128+, plus the 3 new `recorded-*.json`) conversation
   entries into OpenAI message shape; assert the reconstructed `{conversation, tools,
   actions}` fed back through `evaluate()` reaches the SAME `state`/`verdict`/`goal.code` the
   corpus's own `expected` field already asserts (reusing whatever `corpus.test.ts` already
   checks). This is the single highest-value test in the whole plan — it is what actually
   proves the replay-to-reconstruct algorithm (§1, step 3) is sound, not just plausible.
2. **Concurrency/duplicate-request test** — two simultaneous requests with DIFFERENT
   (not identical, unlike the spike's own G5) message histories hit the endpoint's Node
   handler directly (no live AssemblyAI, no network) via `Promise.all`; assert each response
   matches its OWN request body, never the other's. Closes the real gap the spike's G5 left
   open (§4).
3. **SSE framing conformance test** — role-only first delta, content chunk(s), a final
   delta with `finish_reason: 'stop'`, then `data: [DONE]` — matching both the spike's own
   proven shape and the BYO demo's (`server.mjs` lines ~475-486, ~1374-1464, PROVEN in the
   panel's citation check).
4. **Never-cross-this-line test** (§3) — a static/structural assertion (or a runtime spy in
   a test) that the endpoint's reconstruction module is never imported by
   `evidence/fromTools.ts`, `challenges.ts`'s grading path, or `buildEvidenceExport` — those
   stay fed exclusively by the WS server's own transcript-derived logs.
5. **Grader expectations** — the existing harness grader (already scoring goodbye/verdict/
   talk-over per AUTOPILOT_LOG's Day 9-13 entries) runs unchanged against endpoint-mode live
   calls for the three cases; no new grading logic, same bar as today (a clean run =
   verdict correct, goodbye said once, no repeated question).

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

Lane naming follows this repo's `LANE-FILES` convention.

- **Lane F — RMS decode** (§7). Files: `scripts/spike/decode-empty-audio.ts`,
  `scripts/spike/out/g2-audio-rms.json`. No dependency. Gate: the script's own printed RMS
  numbers + a manual listen-back of the saved audio. ESTIMATE 0.5-1 session-hour, ~2 live
  minutes (~$0.15).
- **Lane A — engine sentence composition** (§1 step 4's gap). Files:
  `packages/engine/src/fsm.ts`, `packages/engine/src/challenges.ts`,
  `packages/engine/test/fsm.test.ts`, `packages/engine/test/challenges.test.ts`. No
  dependency on other lanes (touches engine only, which every lane already treats as a
  fixed dependency). Gate: `npm test` + typecheck in `packages/engine`, PLUS the ambition
  pass named in CLAUDE.md's THE RITUALS #3 (these composed lines are now the entire spoken
  voice of the product with zero LLM polish left — read every one aloud, or through TTS,
  before calling this lane done). ESTIMATE 2-3 session-hours — mechanical per-line but
  there are 12 goal codes plus the challenge-question set.
- **Lane B — reconstruction module** (§1 steps 1-3, §3's shared Utterance builder). Files:
  new `packages/server/src/brain/reconstruct.ts`, `packages/server/test/brain/
  reconstruct.test.ts`; touches `packages/server/src/call/events.ts` only to EXTRACT the
  shared Utterance-builder (no behavior change to the legacy path). Can START in parallel
  with Lane A (disjoint files) but its exact-text assertions (test 1 in §6) are only
  meaningful once Lane A lands — write Lane B's tests against `goal.code`/`verdict` first,
  tighten to exact text after Lane A merges. Gate: `npm test` (must pass against the FULL
  128+3 corpus, not a subset — this is the algorithm's real proof), typecheck. ESTIMATE
  2-3 session-hours.
- **Lane C — endpoint HTTP handler + stored-agent REST helpers**. Files: new
  `packages/server/src/brain/endpoint.ts`, `packages/server/src/brain/agent.ts` (promoting
  `scripts/spike/lib.ts`'s proven REST shapes into real server code), a new route in
  `packages/server/src/http.ts`. Depends on Lane B (needs `reconstruct()`). Gate: `npm
  test` (§6 items 1-3), typecheck, a manual `curl` smoke test against a running `npm run
  dev:server` (no live AssemblyAI call needed for this gate). ESTIMATE 3-4 session-hours.
- **Lane D — index.ts/aai/config.ts wiring + feature flag** (§4, §5). Files:
  `packages/server/src/index.ts`, `packages/server/src/aai/config.ts` (new
  `buildAgentBindUpdate`/`buildPostBindSessionUpdate`, additive — `buildInitialSessionUpdate`
  untouched), `packages/server/test/aai-config.test.ts`. Depends on Lane C (needs the
  endpoint's route to exist to point `base_url` at; can be stubbed with a fake `base_url`
  for unit tests before Lane C's route is live). Gate: `npm test`, typecheck. ESTIMATE 2
  session-hours.
- **Lane E — call/session.ts endpoint-mode simplification** (§2, §5's recommended new
  class). Files: new `packages/server/src/call/sessionEndpointMode.ts` (or a flag inside
  the existing file — the founder/build call, not this plan's), a new
  `packages/server/test/session-endpoint-mode.test.ts`. Depends on Lane D (needs the flag
  to exist) and conceptually on Lane C (the endpoint must already be the sole word source
  for the simplification to be correct). Highest-risk lane — this is where §2's "never
  cross this line" test (§6 item 4) belongs. Gate: `npm test`, typecheck, AND the full
  existing `session.test.ts`/`design-e-turn-order.test.ts` suite for the LEGACY path must
  stay 100% green (regression proof the flag's off-path is untouched). ESTIMATE 3-4
  session-hours.
- **Lane G — harness/grader dual-mode**. Files: `scripts/rehearse/*` (parametrize
  `COUNTERSIGN_BRAIN`), reads (never edits) `packages/engine/corpus/
  recorded-{stage,freeze,escalate}.json`. Depends on Lanes C, D, E all merged (needs a real,
  working endpoint-mode live call to grade). Gate: 3 consecutive clean runs of all three
  cases in endpoint mode, zero resets — the SAME bar G2 already set for the legacy path
  (docs/AUTOPILOT_LOG.md, G2 gate). ESTIMATE 1-2 session-hours.

**Merge order:** F any time, independent. A and B start together; B's exact-text assertions
tighten after A merges. C after B. D after C (stubbed unit tests may start earlier). E after
D. G after C+D+E. **Go/no-go before any founder session:** legacy-path test suite still
100% green (regression check) AND Lane G's 3-consecutive-clean bar met in endpoint mode —
only then does `COUNTERSIGN_BRAIN=endpoint` ever reach a live founder call; otherwise the
flag's own default (`legacy`) is what he hears, unchanged from tonight.

**Critical path total:** B(3) + C(4) + D(2) + E(4) + G(2) ≈ 15 session-hours; F/A run
alongside B without extending it. ESTIMATE (sum of each lane's own ESTIMATE above, not
independently re-measured).

## 9. Risks and explicit non-scope

**Risks:**
1. G2's leaked ~4s `reply.audio` on empty completions is UNKNOWN silence — Lane F resolves
   this before Lane C ships the speak-or-silence rule; if not silent, the panel-sanctioned
   fallback (no audible nudge, UI-only "Listening") applies (§7).
2. G7-500's one data point shows possible non-recovery after our endpoint errors (§2's
   dead-man's switch mitigates, does not prove it can't happen) — needs a repeated-500
   spike (2-3 reps) before Lane C is trusted, not assumed fixed by "never throw" alone.
3. Lane B's replay-to-reconstruct algorithm for the actions log (§1 step 3) is genuinely
   novel, no precedent elsewhere in this repo — must pass the FULL 128+3-fixture corpus
   test, not a hand-picked subset, before Lane C depends on it.
4. G5's "no call identity needed" design (§4) rests on an UNKNOWN spike result, not a
   proven one, under REAL concurrency (both spike sessions spoke identical scripted lines,
   so "bodies distinguishable" was a null result by construction) — Lane C/G must re-run G5
   with two genuinely different conversations before trusting this at concurrency 2.
5. No p50/p95 added-latency measurement exists yet for the extra HTTP hop (session → our
   endpoint → AssemblyAI → back). CLAUDE.md's rule: never write "sub-second" without
   measured numbers from the real stack — Lane G's harness must capture this first.
6. Lane A is real content authoring (12 goal codes of natural spoken lines with zero LLM
   polish left to smooth them), not plumbing — under-scoping risks stiff, repetitive
   dialogue with no paraphrasing safety net; the ambition pass (THE RITUALS #3) is not
   optional here.

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
