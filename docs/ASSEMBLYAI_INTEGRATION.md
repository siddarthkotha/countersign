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

## VERIFY-AT-BUILD note added 2026-09-09 (transcript dedupe)

The server now ignores a final `transcript.user` / `transcript.agent` event whose `item_id` was
already recorded for the session (insurance against redelivery after a `session.resume`), and
records `transcript_duplicate_ignored` on the flight recorder when it does. That relies on
AssemblyAI issuing a distinct `item_id` per final turn. UNKNOWN as of this note: whether the
live docs state that guarantee. Check before relying on it for anything beyond redelivery
insurance; a per-turn collision would silently drop a genuine new utterance.
