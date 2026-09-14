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
on `system_prompt` alone, bounded at `CLOSE_REPLY_ATTEMPTS = 3` total sends for CLOSE per
call. Once exhausted, the server stops asking and the existing 15s hard cap
(`CLOSE_TIMEOUT_MS`) is the sole remaining backstop, ending the call `close_timeout` -- LAW 2
is unaffected either way (a verdict already reached STAGE/FREEZE/ESCALATE before CLOSE is
ever rendered; failing to say the closing sentence never changes what was decided, only
whether the caller heard it said).

## VERIFY-AT-BUILD note added 2026-09-09 (transcript dedupe)

The server now ignores a final `transcript.user` / `transcript.agent` event whose `item_id` was
already recorded for the session (insurance against redelivery after a `session.resume`), and
records `transcript_duplicate_ignored` on the flight recorder when it does. That relies on
AssemblyAI issuing a distinct `item_id` per final turn. UNKNOWN as of this note: whether the
live docs state that guarantee. Check before relying on it for anything beyond redelivery
insurance; a per-turn collision would silently drop a genuine new utterance.
