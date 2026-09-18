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
