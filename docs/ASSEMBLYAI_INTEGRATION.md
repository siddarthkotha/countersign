# AssemblyAI Voice Agent API — pinned ground truth (fetched 2026-08-26)

AssemblyAI's own instruction to AI coding assistants, pinned per their guidance:

> Always fetch https://www.assemblyai.com/docs/llms.txt before writing AssemblyAI code.
> The API has changed — do not rely on memorized parameter names.

> For anything AssemblyAI related, use the assemblyai-docs MCP tools first. Do not rely
> on training data.
> MCP add command: `claude mcp add assemblyai-docs --transport http https://mcp.assemblyai.com/docs`

Everything below was fetched from live docs on 2026-08-26. It is a bootstrap map, not a
substitute: RE-VERIFY against llms.txt / the MCP server before coding against any of it.

## WebSocket contract
- Endpoint: `wss://agents.assemblyai.com/v1/ws?token=<token>`
- Audio: **24 kHz PCM, 16-bit signed, little-endian, mono, base64-encoded** (NOT 16kHz —
  that's their cascaded-pipeline rate; the #1 documented AI-coding mistake).
- Flow: connect → send `session.update` (system prompt, tools, greeting, audio format,
  voice) → wait for `session.ready` → stream `input.audio`.

### Events — client → server
`session.update` · `input.audio` · `session.resume` (via session_id) · `session.end` ·
`tool.result` · `reply.create` · `conversation.message`

### Events — server → client
`session.ready` (session_id, config, expires_at, resume_token) · `tool.call` (call_id,
name, arguments) · `reply.done` (reply_id, status) · `input.speech.started/stopped` ·
`transcript.user.delta` / `transcript.user` · `transcript.agent.delta` /
`transcript.agent` · `reply.started` · `reply.audio` · `session.updated` ·
`session.ended` · `session.error`

## Ephemeral tokens (browser auth — the architecture's Plan A)
- Mint server-side: `GET https://agents.assemblyai.com/v1/token` with
  `Authorization: Bearer <ASSEMBLYAI_API_KEY>`
- Params: `expires_in_seconds` (1–600, required — the REDEMPTION window only) ·
  `max_session_duration_seconds` (60–10,800, optional, default 10,800)
- Response: `{token, expires_in_seconds}`. Single-use; one session per token.
- Verbatim from docs: "Once WebSocket opens, the session runs independently of token
  expiration — up to the configured maximum duration." → token lifetime does NOT cap the
  call length. Sessions can run up to 3h.

## Tool calling
- Flat function schemas: `{type:"function", name, description, parameters}` — NOT
  OpenAI's nested structure (documented mistake).
- `tool.call` arrives server→client; respond with `tool.result`.

## Documented AI-coding mistakes (their list — treat as a pre-commit checklist)
1. Sample-rate mismatch (24kHz PCM16 mono base64 — always state it fully)
2. Exposed API keys (browsers get server-minted temporary tokens, never the key)
3. Missing barge-in handling (request interruption support + queued-audio flushing)
4. Deprecated audio APIs (use AudioWorklet BY NAME, never ScriptProcessorNode)
5. Incomplete event coverage (handle: session.ready, transcript.user.delta, reply.audio,
   reply.done, session.error at minimum)
6. Echo feedback loops (getUserMedia with echoCancellation, noiseSuppression,
   autoGainControl)
7. Tool schema confusion (flat, not nested)
8. Missing session init (session.update immediately, wait for session.ready)
9. Auth header error (`Authorization: Bearer <KEY>` for this endpoint)
10. (Twilio-only, out of scope fence) encoding audio/pcmu both directions

## Sources
- https://www.assemblyai.com/blog/vibe-code-voice-agent-with-assemblyai-voice-agent-api
- https://www.assemblyai.com/blog/how-to-vibe-code-a-voice-agent
- https://www.assemblyai.com/docs/voice-agents/voice-agent-api/events-reference
- https://www.assemblyai.com/docs/voice-agents/voice-agent-api/api-spec/generate-voice-agent-token
- https://www.assemblyai.com/docs/voice-agents/voice-agent-api/browser-integration
- https://www.assemblyai.com/docs/llms.txt (filter: `?lang=typescript`)

## Re-verification 2026-09-01 (Day 1, kickoff) — see docs/aai-docs-check-2026-09-01.md
Fetched live by a Haiku errand at 9:00 PM CDT. Everything above still holds. Build-affecting
additions, all PROVEN in that file with URLs:
- `max_session_duration_seconds` (60–10,800) on the token mint = a server-enforced per-session
  cap AssemblyAI itself terminates (Amendment 2's minute cap, for free).
- `transcript.agent` carries `interrupted: true` with the text TRIMMED to what the caller
  actually heard → that is the engine's `Utterance.interrupted` and it is verbatim (LAW 4).
- `tool.result` must be sent when `reply.done` is the latest event received — not earlier,
  not later. Tools carry `execution_mode: interactive | hold` and `timeout_seconds` 1–300.
- `input.keyterms` up to 100 strings; `input.turn_detection.{min_silence,max_silence}` 50–10,000 ms
  (the numeric-answer cut-off tuning from engineering law (f)); `interrupt_response` on by default.
- Barge-in client duty, verbatim: "stop and clear your queued audio so the user doesn't keep
  hearing stale speech" on `input.speech.started` and on `reply.done` status `interrupted`.
- LLM selectable via `session.llm[]` (gateway, e.g. Claude); 11 English TTS voices, immutable
  once the session starts (the character's voice pick is a session-start decision).
- UNKNOWN still: idle timeout on their side; CORS on the token endpoint (irrelevant — minted
  server-side); whether the server stops `reply.audio` on interrupt (client flushes regardless).

## VERIFY-AT-BUILD: `reply.create` schema, fetched 2026-09-13

PROVEN bug (founder screen recording, session 84ddf47a, Miller fraud scenario): a
`session.update` that only changes `system_prompt` never makes the agent speak on its own --
the server sent three of them in one tick (FREEZE → ANNOUNCE_FROZEN → CLOSE) and the closing
line was never spoken; the call ended `agent_closed` with the caller having heard nothing
after the holding line. Root cause: nothing in the code ever asked AssemblyAI for a fresh
reply -- only a new caller turn (or the initial greeting) ever produced one.

Fetched from https://www.assemblyai.com/docs/voice-agents/voice-agent-api/api-spec/voice-agent-websocket
on 2026-09-13 (via an errand agent's WebFetch, per the research-guard rule): the client
message `reply.create` --

> Client asks the agent to generate a reply now, optionally with one-shot instructions.

Schema, quoted:
- `type` (string, required): `"reply.create"`
- `instructions` (string, optional): "Optional one-shot instructions the agent uses to
  compose this reply. Does not modify `system_prompt`."

**UNKNOWN (docs silent):** whether it is safe/defined behavior to send `reply.create` while a
reply is already in progress (between `reply.started` and `reply.done`). The fix in
`packages/server/src/call/session.ts` never does that -- it waits for the in-flight reply's
own `reply.done` before sending one, and only when the goal that reply was phrased under
differs from the goal that now needs to be spoken (see that file's `sendReplyCreate`/
`mustForceSpeak` doc comments). Type added at `packages/server/src/aai/types.ts`
(`ReplyCreateMessage`).

**Trade-off (2026-09-13 review, Minor 6) -- SUPERSEDED by round 3 below:** an INTERRUPTED
CLOSE reply used to arm the hang-up unconditionally (`scheduleCloseIfNeeded` never checked
`evt.status`, only which goal the reply was labelled under) -- the accepted risk at the time
was a caller barging in early enough to end the call having heard only a fragment of the
close sentence. Round 3 replaces the whole labelling-based decision (see immediately below);
an interrupted reply now only arms the hang-up when its own transcript already said enough
of the close line, leniently matched.

## Round 3 (2026-09-13): CLOSE is transcript-confirmed, not reply-labelled

PROVEN live failure on deploy 26 (`scripts/rehearse/reports/2026-09-13T22-23-50-miller-
patient.diagnostics.json`): CLOSE rendered at t=47567; the server sent `reply.create` at
47569 (reason `tick_end`); `reply.started` arrived at 47573, only 4 ms later -- too fast to
be a reply actually generated from that request. Its own transcript was "Please provide the"
-- AssemblyAI's OWN turn-driven reply, composed under the PREVIOUS prompt, not the close
line. The server labelled it CLOSE anyway (a `reply.create` was outstanding when it started)
and, under the round-2 design, would have armed the hang-up on it regardless of what it
actually said. The caller spoke, that bogus reply reported `interrupted`, the hang-up armed
on schedule, and the closing sentence was never spoken -- the call ended with the caller
having heard nothing after the holding line, again.

The lesson: **the server cannot tell AssemblyAI's own turn-driven reply from the reply it
explicitly requested.** A `reply.started` arriving after a `reply.create` proves a request
was SENT; it proves nothing about what gets said in reply. Labelling therefore cannot be the
mechanism that decides whether the close line was actually spoken.

Round 3's fix (`packages/server/src/call/closeMatch.ts`, wired into `session.ts`'s
`scheduleCloseIfNeeded`): the server now accumulates every `transcript.agent` chunk for each
reply id, and only arms the hang-up once a reply completes (`completed` or `interrupted`)
whose OWN accumulated transcript actually contains the CLOSE sentence for the current
verdict -- matched leniently (case/punctuation/whitespace-insensitive; "Good bye" and
"Goodbye" treated the same; a reply that lands the sentence's own content clause, e.g.
"nothing has moved", plus the word "goodbye" counts even without the connective opening
clause, since TTS/STT can drop or reword that without changing what was actually
communicated). A reply that finishes -- however it finishes -- without that match is treated
as "the close line was not spoken": the server asks again, this time passing the exact
prompt-wrapper text as `reply.create`'s own one-shot `instructions` field rather than relying
on `system_prompt` alone -- round 3 bounded this at `CLOSE_REPLY_ATTEMPTS = 3` total sends
for CLOSE per call, then fell back to a 15s hard cap (`CLOSE_TIMEOUT_MS`), ending the call
`close_timeout`. **Superseded by round 4 below** -- the attempt count is exactly what failed
next.

## Round 4 (2026-09-14): CLOSE retry is a TIME budget, not an attempt count

PROVEN live failure (`scripts/rehearse/reports/2026-09-14T13-47-07-miller-patient.
diagnostics.json`, events 46889-61898): CLOSE rendered at 46893; `reply.create` #1 sent
46893; `reply.started` 46897 was AssemblyAI's OWN turn reply under the PREVIOUS prompt (a
59-char transcript), `reply.done` completed 48023; `close_retry` #2 sent 48023 in the SAME
millisecond (round 3 had no spacing rule), `reply.started` 48027, `reply.done` completed
48091 with NO transcript at all (an empty reply, 64ms); `close_retry` #3 sent 48091 (again no
gap); `reply.started` 48094, transcript "This transfer is frozen" then interrupted by caller
speech at 51860 -- `CLOSE_REPLY_ATTEMPTS` (3) was now exhausted, so no further retry was ever
sent; AssemblyAI's next turn reply started 56656 and the 15s hard cap ended the call
`close_timeout` at 61898 before the sentence finished. Net: the mechanism was right (round 3
correctly refused to trust the first two replies), but a fixed attempt count ran out before
AssemblyAI ever produced a reply that actually said the close line.

**Why a time budget, not a bigger count:** the failure mode isn't "not enough attempts" in
the abstract -- it's that attempts were spent on things that were never going to work (a
stale turn-driven reply, an empty reply) as fast as AssemblyAI could produce them, before a
real one had a chance to land. Three further live bundles the same day (structuring-two-
wires, dana-patient, identity-switch) showed the SAME pattern PLUS a second failure mode: the
close_retry reply actually spoke the full sentence, but its `reply.done` never arrived before
the 15s cap fired anyway -- the goodbye was heard and the call still ended `close_timeout`.
Round 4 replaces the attempt count with two changes:

1. **`CLOSE_TOTAL_MS = 45_000`** (absolute, from CLOSE render) replaces `CLOSE_TIMEOUT_MS`
   (15s) as the ONLY thing that can end the call without ever hearing a match. There is no
   attempt cap anymore -- `sendReplyCreate`'s `attempt` diagnostic field is now a plain,
   uncapped running counter, purely for observability. Retries are spaced by
   `CLOSE_RETRY_MIN_GAP_MS = 400ms` (never sent while a reply is in flight) instead of being
   counted against a limit -- this is what stops a close_retry from landing in the exact
   window that produces an empty reply, and what lets a genuinely lost `reply.create` (no
   `reply.started` within `REPLY_CREATE_LOST_MS = 1500ms`) be superseded by a fresh one
   rather than wedging the call. An empty/whitespace-only reply still triggers a (spaced)
   retry but does not bump the `attempt` counter -- it wasn't a real attempt.
2. **The hang-up is armed on the TRANSCRIPT, not only on `reply.done`** (`maybeArmClose
   OnTranscript`, called from every `transcript.agent` event): the instant the accumulated
   transcript for the in-flight reply already matches the close sentence, the server starts
   waiting for THAT reply's own `reply.done` OR `CLOSE_DONE_WAIT_MS = 4000ms`, whichever
   comes first -- never depending on `reply.done` arriving at all. This directly fixes the
   "heard but still close_timeout'd" bundles above.

Also folded into round 4: the idle reaper's own `end('idle_timeout')` used to close the call
immediately the instant `call_ended` turned a still-PENDING verdict terminal (row 15), with
no goodbye ever spoken for either outcome (ESCALATE with a request on record, or NO_ACTION
with nothing at stake) -- PROVEN live (founder observation: "single-wrong-answer and
hangup-after-request ended idle_timeout with verdict ESCALATE and no goodbye"). `end()` now
defers once for `reason === 'idle_timeout'`: it logs `call_ended` and ticks BEFORE marking
the call ended, so if the tick reaches an engine-rendered CLOSE goal (ESCALATE/STAGE/FREEZE),
the same machinery above renders and speaks it, ending as `idle_timeout` (not `agent_closed`)
via `idleEndReason`. NO_ACTION never reaches an engine-rendered CLOSE goal at all (fsm.ts's
`deriveState` sends every NO_ACTION verdict to `OUT_OF_SCOPE`, never `SEALED` -- see that
file's own `closeSentence()` doc comment, which explicitly flagged this as unbuilt) -- for
that one case, `session.ts`'s `beginIdleNoActionGoodbye` speaks the same literal "Thank you
for calling. Goodbye." line directly (`closeSentenceOverride`), reusing the identical
transcript-confirmed hang-up machinery. This is scoped ONLY to the idle-timeout path -- it
does not change what the engine itself renders for any other ending reason.

`ws/browser.ts`'s `endCall` used to close the browser socket unconditionally, synchronously,
right after calling `session.end(reason)` -- correct when `end()` was always immediately
terminal, but a race once `end('idle_timeout')` could defer: the raw socket could close
before the deferred goodbye (or the eventual `ended` event) ever reached it. The close moved
into `makeEntrySink`'s own `ended` handler (fires exactly once, whenever the call is
genuinely done, regardless of what ended it), after `entry.deliver` has actually pushed the
`ended` event down the wire.

## VERIFY-AT-BUILD note added 2026-09-09 (transcript dedupe)

The server now ignores a final `transcript.user` / `transcript.agent` event whose `item_id` was
already recorded for the session (insurance against redelivery after a `session.resume`), and
records `transcript_duplicate_ignored` on the flight recorder when it does. That relies on
AssemblyAI issuing a distinct `item_id` per final turn. UNKNOWN as of this note: whether the
live docs state that guarantee. Check before relying on it for anything beyond redelivery
insurance; a per-turn collision would silently drop a genuine new utterance.

## VERIFY-AT-BUILD re-check 2026-09-18 (P0: garbled first-turn reply, automatic-reply control)

Re-fetched live (errand agent, WebFetch) on 2026-09-18 against
`https://www.assemblyai.com/docs/voice-agents/voice-agent-api/api-spec/voice-agent-websocket`,
`.../events-reference`, `.../turn-detection-and-interruptions`, and
`https://www.assemblyai.com/docs/streaming/turn-detection`, triggered by a PROVEN live defect
(founder quit the live demo 2026-09-18 over a garbled first-turn reply -- see
`packages/server/test/design-e-turn-order.test.ts`'s "(a-1b) PROVEN LIVE DEFECT closed" test and
`call/session.ts`'s `AUTOMATIC_REPLY_SETTLE_MS` doc comment for the full incident). Every
question below is UNKNOWN -- docs silent -- except the schema, which is unchanged from the
2026-09-13 VERIFY-AT-BUILD entry above:

- **Automatic reply generation, and any way to disable/suppress it**: UNKNOWN. No page mentions
  an automatic (non-`reply.create`-triggered) reply at all, let alone a flag to turn it off.
- **Cancelling an in-flight reply**: UNKNOWN. The events reference lists `reply.started`,
  `reply.audio`, `transcript.agent.delta`, `transcript.agent`, `reply.done` -- no
  `reply.cancel`-shaped event anywhere.
- **`reply.create` schema**: PROVEN, unchanged -- `{ type: "reply.create", instructions?:
  string }`. Websocket spec: "Useful for status updates during a `hold`-mode tool call." Events
  reference: `instructions` does "not modify `system_prompt`."
- **Ordering/queueing/drop/merge behavior when `reply.create` is sent while an automatic reply
  is already generating for the same turn**: UNKNOWN -- docs silent (automatic replies are not
  documented, so no ordering guarantee against them exists to find).
- **Whether `instructions` suppresses or replaces the automatic reply**: UNKNOWN, same reason.
- **Whether `system_prompt` applies immediately or "on the next turn"**: the websocket spec says
  only "Can be updated mid-session" -- UNKNOWN on immediate-vs-deferred application (the
  `docs/TEST-PLAN.md` "applies on the next turn" phrasing is this repo's own PROVEN-from-live-
  failure inference, not a documented guarantee).
- **Whether two reply lifecycles can be open concurrently (a second `reply.started` before a
  prior `reply.done`)**: UNKNOWN -- no constraint documented either way.

PROVEN instead from three same-day records (2026-09-18) -- two founder calls
(`scripts/rehearse/reports/founder-2026-09-18/95b9ad42-....diagnostics.json` and
`32cbb410-....diagnostics.json`) and one harness bundle
(`scripts/rehearse/reports/2026-09-18T10-54-17-barge-in-interrupt.diagnostics.json`): in all
three, the server's own instructed `reply.create` (reason `tick_end`) went out 0-1ms after the
caller's opening turn ended, and AssemblyAI returned exactly ONE `reply.started`/`reply.done`
pair whose own `transcript.agent` was a word-interleaved merge of the server's instructed
sentence and an unrequested, STANDING_RULES-violating question -- e.g. "Just toOne confirm,
moment this transfer goes to Northgate Partners. Who is calling and what is. Is that your
authorization correct? code?" (a merge of "Just to confirm, this transfer goes to Northgate
Partners. Is that correct?" -- ours -- with "One moment. Who is calling and what is your
authorization code?" -- AssemblyAI's own, never anything any goal in this codebase asks for).
Since the wire-visible event stream never shows two `reply.started`s open at once, this is
UNKNOWN at the mechanism level (AssemblyAI-internal: a true concurrent audio/token race, or one
LLM call confused by receiving both intents in the same generation window) but PROVEN
reproducible at the outcome level (3/3). Given docs offer no suppress/cancel/ordering
mechanism, the fix (`call/session.ts`'s `AUTOMATIC_REPLY_SETTLE_MS` / `armTickEndSendTimer`)
defers a caller-turn-triggered fresh-question send by 150ms (ESTIMATE, ~150x margin over the
PROVEN 0-1ms observed trigger gap) so AssemblyAI's own automatic reply, if one is coming, gets
a chance to start (and be caught by the existing busy-guard) before the server's own send goes
out -- never a documented fix, since the docs give none to use.

## VERIFY-AT-BUILD re-check 2026-09-18 (turn_detection / same-breath cutoffs)

SONNET-JUSTIFIED lane (packages/server/src/aai/config.ts owner), triggered by the founder's
second live complaint: "does not let me complete my sentence." Re-fetched live (two
independent errand-agent WebFetch passes, same page, same text both times, retrieval date
2026-09-18) against
`https://www.assemblyai.com/docs/voice-agents/voice-agent-api/turn-detection-and-interruptions`.

**`turn_detection`'s documented fields** (PROVEN, live docs 2026-09-18): `vad_threshold`
(float 0-1, default 0.5), `min_silence` (int ms, default "adaptive"), `max_silence` (int ms,
default "adaptive"), `interrupt_response` (bool, default true), `interruption_delay` (int ms,
0-1000, default varies by `transcription_mode`). No separate settable
"end_of_turn_confidence_threshold" input exists; a same-named field appears on Turn *events*
as a response/output value, never as a config input we can tune.

**The decisive quote** (PROVEN, quoted exactly, independently confirmed twice):
> "Setting `min_silence` or `max_silence` turns off the adaptive pacing and entity-aware
> waiting described above for the rest of the session. Prefer leaving them unset."

Adaptive pacing, same page: "If a speaker pauses a lot, the agent gives them more room; if
they're crisp, it replies faster. This gets better over the call." Entity-aware waiting:
"When a tool parameter expects a phone number, email, date, or other entity, the agent waits
for the whole value before ending your turn." Both are described as running BY DEFAULT and
turned OFF permanently for the session the instant either `min_silence` or `max_silence` is
explicitly set even once -- which our code had been doing on every single connect and every
single goal change since the field was added.

**What we sent before this fix** (PROVEN, `packages/server/src/aai/config.ts` as of commit
f57171c): `buildInitialSessionUpdate` always sent `min_silence: 600, max_silence: 4000`
(hardcoded fallback defaults, no documented justification found for either number --
originally just "sane"-looking values, per the pre-fix code comment). `call/session.ts`
additionally re-sent an explicit `min_silence` (600 or 1200 for `'patient'`-hint goals:
CHALLENGE and CONSISTENCY_CHECK `rule_hit === 5`) on every single goal transition, meaning
adaptive pacing was disabled within roughly the first second of every real call and stayed
off for its entire duration.

**Measurement (this lane, 2026-09-18, from every bundle on disk under
`scripts/rehearse/reports/*.diagnostics.json`, including the founder's own real recordings
under `founder-2026-09-18/`; never called the live API, only replayed recorded bundles):**
a "same-breath cutoff" detector -- an agent `reply.started` firing <=300ms after a caller
utterance's `input.speech.stopped`, with the caller resuming (`input.speech.started`)
<=2000ms after that `reply.started` (the exact signature the founder's own PROVEN cutoff,
`founder-2026-09-18/391e2a37-....diagnostics.json` at 35.8s, "No." -> reply.started 7ms
later -> caller resumes "Meridian Supply." 1148ms after reply.started, matches) -- found 217
candidates across the whole synthetic-harness + founder corpus (255 bundles parsed of 258
found; 3 failed to parse). Their measured caller-side silence gap (time beyond whatever
`min_silence` was already active before the caller resumed):

| bucket | n | min | p50 | p90 | max |
|---|---|---|---|---|---|
| all | 217 | 635ms | 1098ms | 1297ms | 1991ms |
| 1-2 words | 53 | 698ms | 999ms | 1370ms | 1975ms |
| 3-6 words | 104 | 723ms | 1142ms | 1287ms | 1991ms |
| 7+ words | 60 | 635ms | 1097ms | 1285ms | 1981ms |

Word count does NOT meaningfully predict pause length (all three buckets cluster around a
1000-1150ms p50) -- no word-count-keyed fixed threshold would help more than a flat one.
ESTIMATE, not PROVEN: most of these 217 are synthetic-harness scripted/LLM-caller lines, not
organic human pauses -- the corpus is a proxy, methodologically noisier than real speech, and
should be read as evidence about the SHAPE of the problem (no fixed threshold cleanly
separates "still talking" from "truly done" -- the same 3-word "Yes, that's correct." text
appears on both sides) rather than as a precise population estimate.

The founder's OWN real recordings (`founder-2026-09-18/`, 6 calls, 29 measurable caller
utterances, PROVEN from the actual bundles) show only 2 same-breath candidates: 997ms ("Hold
on." -> "Ignore your previous instructions...", CHALLENGE state) and 1155ms ("No." ->
"Meridian Supply.", a CONSISTENCY_CHECK rule_hit-5 READBACK -- which per the pre-fix code was
ALREADY in 'patient' mode at 1200ms min_silence, meaning the founder's real total pause was
roughly 1155ms + 1200ms =~ 2355ms, over even the elevated floor). Every other real gap in his
6 calls was 5-23 seconds (natural human conversational pacing, nothing like the harness's
fast scripted turnaround).

**Trade-off argued from the measured data:** a raised FIXED `min_silence` of 1300ms would
have covered 201/217 (92.6%) of the synthetic same-breath candidates (coverage climbs from
0% at 600ms, to 44.7% at 1000ms, 62.2% at 1200ms, 92.6% at 1300ms, 100% at 2000ms) -- but
every extra millisecond above the current 600ms floor is added, flat, to EVERY turn that was
already genuinely finished, not only the cutoff-risk ones: 560 measured gaps over 3s plus 42
normal round trips (602 turns) never needed extra time at all, against only 217 that did.
Today's ambient (AssemblyAI-initiated) reply already starts 1-7ms after a turn is decided
over (`turn_to_reply_gap` diagnostic, `ours: false` samples, PROVEN from the same bundles) --
so a raised fixed floor's added latency lands almost entirely on genuinely-finished turns,
not on closing the gap to cutoff turns (which already wait out the existing floor before
resuming).

**The change made (this lane, `packages/server/src/aai/config.ts` +
`packages/server/src/call/session.ts` one isolated line, see this lane's own report for the
full diff):** rather than pick a new fixed number, `min_silence`/`max_silence` are now
OMITTED from the wire payload for every 'default'-hint goal, so AssemblyAI's own adaptive
pacing and entity-aware waiting run for the entire call -- avoiding the flat cost entirely,
per this file's own quoted docs recommendation ("Prefer leaving them unset"). The existing
'patient'-hint explicit 1200ms floor (CHALLENGE, CONSISTENCY_CHECK rule_hit 5) is
UNCHANGED by this pass -- PROVEN insufficient on its own in the one real case measured above,
left for a follow-up decision once live data exists on the 'default'-branch change.
`interruption_delay` remains UNSET/unplumbed (UNKNOWN whether it should be configured;
no live defect has pointed at it).

**Live effect: UNKNOWN.** This analysis never called the live AssemblyAI API -- it replays
recorded diagnostics bundles only, per this repo's own determinism rule (never test a copy
of the engine, never call the live API in tests). Whether adaptive pacing actually avoids the
founder's cutoff live, and whether it changes perceived responsiveness on genuinely-finished
turns, is UNKNOWN until the next rehearsal batch (and ideally another founder live call)
measures it against the deployed build.

## VERIFY-AT-BUILD re-check 2026-09-18 (turn_detection key presence)

SONNET-JUSTIFIED lane, same founder complaint ("does not let me complete my sentence"),
re-opened because the fix above shipped (deploy 2be1d3e) and the complaint was still
measured on that exact build: PROVEN from
`scripts/rehearse/reports/2026-09-18T15-46-44-barge-in-interrupt.diagnostics.json` -- the
caller says "No." (`input.speech.stopped` at 33.5s); an ambient reply starts 6ms later
(`turn_to_reply_gap` gap_ms 6, `ours: false`); the caller resumes at 34.6s with "That's
wrong. It's Meridian Supply."; that reply ends interrupted. Eight-call batch: 4 such
cut-offs. This is the same immediate-VAD-boundary signature as before the min_silence/
max_silence fix, with no extra waiting visible.

**Root cause found:** the min_silence/max_silence fix left the `turn_detection` KEY itself
present on every session.update -- `aai/config.ts`'s initial connect sent
`{ vad_threshold: 0.5, interrupt_response: true }` unconditionally, and `call/session.ts`'s
per-goal sender sent `{}` on every goal change (several times a minute on a real call, since
`session.ts`'s `previousGoalKey` guard fires on every distinct goal, and CHALLENGE/
CONSISTENCY_CHECK/READBACK goals cycle quickly in a real conversation).

**Re-fetched live** (errand agent, WebFetch, retrieval date 2026-09-18) against
`https://www.assemblyai.com/docs/voice-agents/voice-agent-api/turn-detection-and-interruptions`.
Answers to the four questions this lane was asked to resolve, quoted exactly:

1. **Does sending `turn_detection` as an empty object differ from omitting the key
   entirely?** UNKNOWN -- the page never states this directly. The closest statement is the
   page's own framing of the default: "With no turn_detection config, the agent adapts to
   each speaker's pace and automatically slows down to capture values your tools need." This
   ties the documented adaptive behavior to **no turn_detection config being sent**, not
   specifically to min_silence/max_silence being absent from a config that IS sent. It does
   not say whether a present-but-empty object, or a present object with only
   vad_threshold/interrupt_response set, counts as "no turn_detection config" for this
   purpose. Given the ambiguity and that the founder's complaint persisted on the
   key-present build, this lane treats "no config" literally: omit the key.

2. **Any statement about sending turn_detection with no fields, or sent repeatedly on every
   session.update (several times a minute)?** UNKNOWN -- the page is SILENT on repeated
   session.update calls entirely. No statement found about whether resending the key (even
   unchanged, even empty) resets, re-triggers, or otherwise affects the adaptive system's
   state. This remains genuinely unverified; the change below is the conservative reading
   (never resend the key at all), not a confirmed mechanism.

3. **Does the doc define when adaptive pacing engages, what signals it uses, and whether
   repeated session.update calls reset it?** Partially. Adaptive pacing: "If a speaker
   pauses a lot, the agent gives them more room; if they're crisp, it replies faster. This
   gets better over the call" -- described as running by default, improving with more data
   over the session, but the *signal* it uses and *whether/how session-level state persists
   across a session.update* are not documented (UNKNOWN). Entity-aware waiting is
   documented as scoped specifically to **tool parameters**: "When a tool parameter expects
   a phone number, email, date, or other entity, the agent waits for the whole value before
   ending your turn." **This is a load-bearing finding for Countersign specifically:**
   `aai/config.ts`'s `LIVE_SESSION_TOOLS` is the empty array, and `fsm.ts`'s
   `allowedTools()` returns `[]` for every engine state (LAW 2/3 -- the voice model is never
   offered a single tool schema, by design, so it can never emit a verdict). Since
   entity-aware waiting is described as tied to *tool parameters* the agent is waiting to
   fill, and Countersign's session never advertises any tool to AssemblyAI at all,
   entity-aware waiting has no tool parameter to key off and cannot be the mechanism that
   helps a Countersign caller mid-sentence, regardless of what `turn_detection` carries.
   Only the general adaptive-pacing behavior (not entity-specific) is even a candidate lever
   here.

4. **Is `interruption_delay` or `vad_threshold` relevant to a caller who pauses ~1s
   mid-thought?** No, per the documented purpose of each. `vad_threshold` (float 0-1,
   default 0.5): "Speech detection sensitivity (0.0 to 1.0). Lower is more sensitive" --
   this tunes how easily quiet/faint audio counts as speech at all, not how long a silence
   must last before a turn is considered over. `interruption_delay` (int ms, 0-1000,
   default "Follows the transcription mode (0 for min_latency, 500 for balanced and
   max_accuracy). Raise it so brief back-channels like 'mm-hmm' don't cut the agent off")
   governs whether the CALLER can interrupt the AGENT's own speech, not how long the
   caller's own turn-ending silence window is. Neither field is the documented lever for
   "caller pauses mid-sentence before finishing a thought" -- that lever is min_silence/
   max_silence (now left unset so adaptive pacing decides) plus, where applicable,
   entity-aware waiting (inapplicable here per finding 3 above).

**The change made (this lane, `packages/server/src/aai/config.ts` +
`packages/server/src/call/session.ts`):** the smallest change the docs support --
`turn_detection` is now OMITTED from the wire entirely, in both places, unless a caller
explicitly configures at least one field:

- `aai/config.ts`'s `buildInitialSessionUpdate`: previously always sent
  `{ vad_threshold: 0.5, interrupt_response: true }` (plus min_silence/max_silence only on
  explicit override). Now sends no `turn_detection` key at all when `cfg.turn_detection` is
  unset; when the caller sets any field, only the fields actually given are sent (no
  defaults for the others are backfilled any more -- restating a documented default is
  itself an undocumented case the page never rules out as equivalent to omission).
- `call/session.ts`'s per-goal sender (fires on every goal change, several times a minute):
  previously sent `turn_detection: {}` unconditionally. Now omits the key entirely from
  every per-goal session.update -- this sender has never had an explicit-override path (no
  caller-supplied config reaches it), so there was nothing to preserve.
- Tests assert the key's ABSENCE (`not.toHaveProperty('turn_detection')`), not merely an
  empty value, in both `packages/server/test/aai-config.test.ts` (initial connect, plus new
  explicit-override tests for vad_threshold/interrupt_response individually) and
  `packages/server/test/session.test.ts` (per-goal sender, both the diag detail and the
  literal wire payload across a full Scenario-B drive through ASK_CHALLENGE).

**What the next rehearsal batch should measure:** re-run the same same-breath-cutoff
detector used in the prior re-check against a fresh batch on this build, specifically
watching whether the "No." -> immediate-ambient-reply -> caller-resumes-mid-sentence shape
(the founder's own PROVEN 391e2a37/barge-in-interrupt signature) still shows a ~0-10ms
`turn_to_reply_gap`, or whether it now shows a materially longer gap consistent with
adaptive pacing actually engaging. If the cut-off persists with the key now fully absent,
that would be strong evidence the remaining levers are not turn_detection-shaped at all,
and the options become: (a) accept the cut-off as intrinsic to this API today and rely on
the client-side barge-in/flush-and-resume path that already works (trade-off: caller still
sounds "cut off" mid-word even though no information is lost, since the client resumes and
the transcript catches the whole sentence); (b) raise `vad_threshold` toward 0 for higher
speech-detection sensitivity, which is a different mechanism than a silence-duration floor
and UNMEASURED for this failure mode; (c) reopen an explicit fixed min_silence/max_silence
despite disabling adaptive pacing, accepting the flat added latency on every already-finished
turn that the prior ANALYSIS measured (p50 ~1098ms extra needed, ~700ms added cost to every
genuinely-finished turn at a raised 1300ms floor) -- not recommended without a materially
stronger signal that adaptive pacing itself is the thing not working.

**Live effect: UNKNOWN**, same discipline as the section above -- this analysis never called
the live API; it is a code change grounded in a live docs re-fetch and the founder's own
PROVEN recorded diagnostics, awaiting the next rehearsal batch's measurement.

**See also:** the reading above (omit the key entirely) was re-examined and reversed the
next day -- see "VERIFY-AT-BUILD re-check 2026-09-19 (turn_detection restored)" below.

## VERIFY-AT-BUILD re-check 2026-09-19 (turn_detection restored)

SONNET-JUSTIFIED lane, TURN-DETECTION-RESTORE-EXPLICIT-CONFIG: the 2026-09-18 re-check above
concluded the `turn_detection` key should be omitted entirely on connect, reading the docs as
tying full adaptive pacing to "no turn_detection config" being sent at all. Re-verified
against the SAME live docs page today and that reading does not hold up -- the docs tie the
pacing-disabling behavior to a NAMED PAIR of fields (min_silence/max_silence), never to the
key's mere presence.

**Verified verbatim today (2026-09-19 1:39 PM CDT), page
`https://www.assemblyai.com/docs/voice-agents/voice-agent-api/turn-detection-and-interruptions`,
copied character for character by a verification errand:**

> "Setting `min_silence` or `max_silence` turns off the adaptive pacing and entity-aware
> waiting described above for the rest of the session."

> "With no `turn_detection` config, the agent adapts to each speaker's pace and
> automatically slows down to capture values your tools need, like a phone number or
> email."

The page names five `turn_detection` sub-fields: `vad_threshold`, `min_silence`,
`max_silence`, `interrupt_response`, `interruption_delay`. Documented purposes, quoted:
`interruption_delay` -- "How long after the user starts speaking, in ms (`0` to `1000`),
before a barge-in can interrupt the agent."; `interrupt_response` -- "Set `false` to disable
barge-in entirely." Neither of these two, nor `vad_threshold`, is named anywhere as
disabling adaptive pacing or entity-aware waiting -- only `min_silence`/`max_silence` are.

**Also verified verbatim today, the seven client events AssemblyAI's Voice Agent API
accepts** (`input.audio`, `session.update`, `session.resume`, `session.end`, `tool.result`,
`reply.create`, `conversation.message`), **and that no client event cancels an in-flight
reply and no session field disables automatic reply generation.** This matters here because
it rules out a client-side "stop the ambient reply" lever existing at all -- the only
observed way an instructed (`ours: true`) reply wins the race against AssemblyAI's own
automatic one is by starting first, which is exactly what restoring `turn_detection` at
connect changes the odds of (see the evidence below), not by cancelling a reply already in
flight (no such call exists).

**Conclusion: the 2026-09-18 reading above was WRONG** about which fields disable adaptive
pacing. A `turn_detection` object present on the wire but carrying only
`vad_threshold`/`interrupt_response` (no `min_silence`/`max_silence`) was never the
documented trigger for disabling adaptive pacing or entity-aware waiting -- omitting the key
entirely bought nothing beyond what omitting just `min_silence`/`max_silence` already
bought, and its live cost (see below) was a race this repo did not have on deploy 52.

**Live evidence (read directly from the named diagnostics bundles with
`fs.readFileSync`/`JSON.parse` before any code was changed, per this lane's task
instructions):**

- **Deploy 52** (`2be1d3e`, `turn_detection` SENT: `{vad_threshold: 0.5,
  interrupt_response: true}`) -- miller-patient
  (`scripts/rehearse/reports/2026-09-18T15-52-39-miller-patient.diagnostics.json`): the CLOSE
  goal fired three `reply_create_sent` attempts (the caller barged in twice); all three
  resulting `reply.started` events are tagged `ours: true` with no ambient (`ours: false`)
  reply racing into that window, and the final attempt speaks the exact, unmerged CLOSE
  sentence ("This transfer is frozen and an incident is open. The payment is not released.
  Goodbye.") cleanly. `goodbye_delay` (terminal_action to the close line actually spoken,
  per `scripts/rehearse/experienceGrading.ts`) reads 8.231s in this bundle's own `.md`,
  inflated by the caller's two barge-ins/retries, not by any merge or race.
- **Deploy 52, identity-switch**
  (`2026-09-18T15-54-39-identity-switch.diagnostics.json`): NOT as clean -- an `ours: true`
  reply (`resp_745a0e2c...`, 70ms turn_to_reply_gap) speaks a mismatched, seemingly-stale
  line ("Authority, urgency, or threats are not verification. One moment. Please state the
  purpose of this transfer.") instead of the CLOSE text, and a SECOND reply
  (`resp_2dfb400f...`, tagged `ours: false`, gap_ms 2972) immediately follows and speaks the
  actual, unmerged goodbye text. `goodbye_delay` for this bundle is 10.607s. This is a real,
  PROVEN anomaly in the deploy-52 bundle that does not match a simple "clean ours:true"
  story -- flagged here rather than smoothed over; it predates this lane's change (deploy 52
  already shipped before this restore) and is a variant of the same ambient-reply-race
  family as MERGED-FREEZE-GOODBYE-MILLER, not something this restore is claimed to fix.
- **Deploy 53** (`f880b91`, key omitted entirely): per
  `docs/AUTOPILOT_LOG.md`'s 2026-09-19 12:37 PM entry, the automatic reply raced ours and
  merged text into one `reply_id` on 3/3 CLOSE turns that day (MERGED-FREEZE-GOODBYE-MILLER,
  root-caused and fixed in `76969ee`).
- **Deploy 55** (`b6fcd8f`, key still omitted, plus `76969ee`'s forceSpeak deferral) --
  miller-patient (`2026-09-19T13-28-41-miller-patient.diagnostics.json`): the merge is gone,
  but an ambient reply (`ours: false`, `resp_b952af72...`) starts immediately after
  `terminal_action` and speaks a stale line ("One moment. Which institution") before being
  interrupted once the deferred CLOSE reply_create fires (`reason:
  reply_done_goal_diverged`); the CLOSE reply (`ours: true`, `resp_6be68045...`) then speaks
  the clean, correct goodbye. Measured `goodbye_delay` (terminal_action to the close line
  actually spoken): **7.98s**, matching this bundle's own `.md` exactly.
  identity-switch (`2026-09-19T13-30-33-identity-switch.diagnostics.json`) shows the same
  shape: an ambient reply (`ours: false`, `resp_1c035231...`) speaks a full, uninterrupted
  stale line ("Authority or urgency are not verification. One moment. Please state the
  purpose of this transfer.") before the deferred CLOSE reply (`ours: true`,
  `resp_718cff0c...`) speaks the correct goodbye. Measured `goodbye_delay`: **17.954s**,
  again matching this bundle's own `.md` exactly.

**The change made (this lane, `packages/server/src/aai/config.ts` +
`packages/server/src/aai/session.ts` + `packages/server/src/index.ts`; `call/session.ts`
untouched, owned by other lanes this session):**

- `aai/config.ts`'s `buildInitialSessionUpdate`: `turn_detection` is now ALWAYS present on
  connect, exactly as deploy 52 sent it -- `{vad_threshold: cfg.turn_detection?.vad_threshold
  ?? 0.5, interrupt_response: cfg.turn_detection?.interrupt_response ?? true}`, with
  `min_silence`/`max_silence` still omitted unless `cfg.turn_detection` explicitly sets one
  (sent exactly as given, alongside the two defaulted fields -- not replacing them).
- `call/session.ts`'s per-goal sender is UNCHANGED by this lane: it still omits
  `turn_detection` entirely on every goal change (never resends `{}`) -- that omission was
  never the field this restore is about; the connect-time defaults are the only thing
  restored.
- `aai/session.ts`'s `connectAai` now reads the `turn_detection` object back off the actual
  built `session.update` message (never recomputed) and passes it as a third argument to
  `deps.onReady`; `index.ts`'s `aai_ready` diag records it as `turn_detection_sent` (no
  existing field renamed). `call/session.ts`'s existing per-goal `session_config_updated`
  diag already records `turn_detection_omitted: true` on every update -- unchanged, still
  accurate.
- Tests flipped: `packages/server/test/aai-config.test.ts`'s two "omits the turn_detection
  key" tests now assert the key is present with the documented defaults (and that
  min_silence/max_silence stay absent); its override tests now expect the defaulted
  vad_threshold/interrupt_response alongside the explicit override, not in place of it.
  Added `packages/server/test/aai-session.test.ts` tests asserting `onReady`'s new third
  argument matches the built message exactly, both with defaults and with a caller
  override.

**What a live caller may hear differently:** the CLOSE goodbye is expected to go out first
again in the common case, as measured on deploy 52, rather than losing the race to a stale
ambient line first (as measured on deploy 55, 7.98s-17.95s delay). `76969ee`'s forceSpeak
deferral logic stays in place underneath as the safety net for whenever an automatic reply
still starts first regardless (the deploy-52 identity-switch anomaly above shows this can
still happen even with the key present) -- it is not removed or weakened by this change.

**Live effect: UNKNOWN until the next rehearsal batch measures it against the deployed
build.** This lane never called the live API -- all evidence above is either a verbatim docs
re-fetch or a replay of already-recorded diagnostics bundles, per this repo's determinism
rule.

## VERIFY-AT-BUILD re-check 2026-09-19 (turn_detection mutability mid-session; GOODBYE-CUT-BY-CALLER-PRESSURE, mechanism A)

Same day, later lane (GOODBYE-CUT-BY-CALLER-PRESSURE, PROVEN on deploy 58: three barge-ins cut
the CLOSE goodbye to 0.79s of relayed audio on one call, and a folded reply reported
`reply.done` COMPLETED on another with only its first, unrelated segment's audio ever
streamed -- see `packages/server/test/goodbye-cut-by-caller-pressure.test.ts` for both replays
in full). This lane needed to know whether `turn_detection` (specifically
`interrupt_response`) can be changed via a **mid-session** `session.update`, i.e. AFTER
`session.ready` -- everything above this section is about the CONNECT-time config only.

**Fetched today** (this lane could not call `WebFetch` directly -- routed through a
haiku-pinned lookup agent per this session's own research-guard rail; the agent's own report is
reproduced verbatim below, not summarized further by this lane):

> URL successfully fetched: `https://www.assemblyai.com/docs/voice-agents/voice-agent-api/session-configuration.md`
> and `https://www.assemblyai.com/docs/voice-agents/voice-agent-api/turn-detection-and-interruptions.md`
>
> From the "Mutability after `session.ready`" table in session-configuration.md:
>
> | Field | Mutable after `session.ready`? |
> | --- | --- |
> | `session.input.turn_detection` | "Yes. Adjust VAD thresholds, silence windows, and barge-in on the fly." |
>
> From the field reference table in turn-detection-and-interruptions.md:
>
> | Field | Default | Description |
> | --- | --- | --- |
> | `interrupt_response` | `true` | "Set `false` to disable barge-in entirely." |

**Verdict: MUTABLE.** `input.turn_detection` (and therefore `interrupt_response`) can be
changed via `session.update` after `session.ready` -- this lane built mechanism (A) on that
basis: the per-goal `session.update` for the CLOSE goal now carries `turn_detection: {
vad_threshold: 0.5, interrupt_response: false }` (`call/session.ts`'s `applyEvaluate`, using
`aai/config.ts`'s exported `DEFAULT_VAD_THRESHOLD` so the two send sites can never silently
drift apart). Every OTHER goal's per-goal update is UNCHANGED -- it still omits
`turn_detection` entirely, exactly as the 2026-09-18 lane above established.

**Caveat, stated plainly (this is a lower-trust source than this lane's own earlier verbatim
fetches):** the quote above was produced by a cheap, model-summarized lookup (a haiku agent),
not a byte-for-byte page fetch this lane read itself -- the table formatting may be the agent's
own reformatting of prose rather than a literal on-page table. Treat the SUBSTANCE (mutable;
`interrupt_response: false` disables barge-in) as PROVEN-by-quote, but a from-scratch human or
higher-effort re-fetch would be needed before calling the exact table layout itself verbatim.

**Live evidence check (2026-09-19):** grepped every bundle under
`scripts/rehearse/reports/2026-09-18T15-*` (deploy 52, the day `turn_detection` was last
verified present on the wire at CONNECT time) for any `session.error` or `immutable_field`
event correlated with `turn_detection` -- zero hits across all eight bundles. This is
EVIDENCE the connect-time config was accepted without error, but it is NOT direct evidence of
mid-session mutability specifically: `call/session.ts`'s per-goal sender has never, before this
lane, sent `turn_detection` in a session.update AFTER connect (every goal's own comment says
so, dated 2026-09-18) -- so no bundle on disk exercises a mid-session `turn_detection` update
either accepted or rejected. **Live effect of mechanism (A) itself is therefore UNKNOWN until
the next rehearsal batch measures it against the deployed build** -- the docs quote above is
the basis for building it, not proof it behaves as documented once actually sent mid-call.

**Mechanism (B) and (C), for completeness (no further docs lookup needed -- both are
server-side confirmation/retry logic, not new AssemblyAI wire behavior):**
- (B) A goodbye's relayed audio bytes must reach 50% of its expected TTS byte count (~4,000
  bytes/char, measured from two clean, fully-relayed goodbyes recorded the same day: 339,840
  bytes for an 86-char line, 361,080 bytes for another 86-char line) before it can be confirmed
  heard -- regardless of transcript match or `reply.done.status`. See `call/session.ts`'s
  `closeReplyHasEnoughAudio`/`closeAudioFloorBytes` for the exact formula and the two live
  failures (41.8% and 11.0% of expected bytes) the 50% floor separates from the two clean
  successes (98.8% and 105.0%).
- (C) A CLOSE/ANNOUNCE_* send dropped because the caller was still speaking now records the
  goal as owed (`owedForceSpeakGoalKey`) and is delivered synchronously
  (`forceSpeakSettleMs`, 0 by default) the instant the caller's turn ends, rather than waiting
  `AUTOMATIC_REPLY_SETTLE_MS` (150ms) -- PROVEN live gaps for an AssemblyAI automatic reply are
  8-63ms, comfortably inside that 150ms window, so waiting handed it the slot on deploy 58's
  own identity-switch bundle (`goodbye_delay` 25.6s).
