# AssemblyAI — Coding Agent Instructions (pinned copy)

Source: AssemblyAI's own "AssemblyAI Integration — Coding Agent Instructions" document, as shown in the
AssemblyAI dashboard next to the API key on 2026-09-02 and pasted by the founder at 10:59 AM CDT. Pinned
here per BRIEF §6.2 ("their docs ship an agent-integration prompt meant to be pinned into a CLAUDE.md").
Countersign uses ONLY Section 10 (Voice Agent API). Verbatim text follows; our build notes are at the end.

Build-affecting facts extracted for Countersign (2026-09-02):
- Voice Agent API auth is `Authorization: Bearer <key>` (the one product where Bearer is required).
- Send `session.update` immediately on connect (do not wait for `session.ready`); send `input.audio` ONLY after `session.ready`.
- `input.audio` carries base64 in `audio`; `reply.audio` carries it in `data` (field-name asymmetry).
- `tool.result` goes out after `reply.done`; if `reply.done.status == "interrupted"`, DISCARD pending tool results.
- Voice ids are exact strings; fetch `GET https://agents.assemblyai.com/v1/voices` for the live list; default voice is `anna`.
- Resume within 30 s of a disconnect with a NEW token and `session.resume` carrying the previous `session_id`.
- Docs MCP: `claude mcp add assemblyai-docs --transport http https://mcp.assemblyai.com/docs`; index at https://www.assemblyai.com/docs/llms.txt.

---

# AssemblyAI Integration — Coding Agent Instructions (excerpt: the parts that bind the Voice Agent path)

The full document (Sections 0–15) is AssemblyAI's own text, shown in the dashboard beside the API key and
published at https://www.assemblyai.com/docs/coding-agent-prompts. Countersign builds only on the Voice Agent
API, so the sections below are kept verbatim; the pre-recorded, realtime-STT, LLM-Gateway and framework
sections are referenced by URL rather than copied.

**Official documentation.** Two ways to wire your coding agent up to live docs (both recommended — they layer):

1. **Project instructions** (every prompt): add to `CLAUDE.md`, `.cursorrules`, `AGENTS.md`, or equivalent:

   ```
   Always fetch https://www.assemblyai.com/docs/llms.txt before writing AssemblyAI code.
   The API has changed — do not rely on memorized parameter names.
   ```

2. **Docs MCP server** (on-demand lookups): `https://mcp.assemblyai.com/docs` — Streamable HTTP transport. Provides `search_docs`, `get_pages`, `list_sections`, `get_api_reference`.

   ```bash
   # Claude Code
   claude mcp add assemblyai-docs --transport http https://mcp.assemblyai.com/docs
   ```

## 0. Operating Rules (the ones that apply here)

5. **Never expose the API key in client-side code.** For browser or mobile realtime, always mint a temporary token server-side.
6. **Authorization header is the raw key — no `Bearer` prefix.** **One exception:** the Voice Agent API (Section 10) requires `Authorization: Bearer YOUR_API_KEY`. Don't generalize either rule across products.
8. **Always terminate realtime sessions explicitly.** An abandoned WebSocket keeps accruing charges until the 3-hour cap.
12. **Verify parameters against live docs before recommending.** This file is a snapshot. Primary source: `https://www.assemblyai.com/docs/llms-full.txt`; for LLM Gateway model strings: `/docs/llm-gateway/quickstart` — don't guess short names like `claude-sonnet-4`.

## 10. Voice Agent API (managed speech-in / speech-out)

Use this when the developer wants a complete spoken AI agent — not just transcription. Single WebSocket, audio in and audio out, with STT + LLM + TTS + turn detection + tool calling all managed by AssemblyAI.

**Endpoint:** `wss://agents.assemblyai.com/v1/ws`

**Auth:** `Authorization: Bearer YOUR_API_KEY` — the Bearer prefix is **required** on this product (different from STT and LLM Gateway, which take the raw key). For browsers/mobile, mint a temp token instead and pass it as `?token=<token>`.

**Token endpoint (for browser/mobile clients):**
```bash
curl -s "https://agents.assemblyai.com/v1/token?expires_in_seconds=300&max_session_duration_seconds=8640"   -H "Authorization: Bearer $ASSEMBLYAI_API_KEY"
# { "token": "..." }
```
- `expires_in_seconds`: 1–600 (controls how long the token can be redeemed for)
- `max_session_duration_seconds`: 60–10800 (caps the resulting session; defaults to the 3-hour max)
- Tokens are **single-use** per session — get a fresh one for every reconnect (including `session.resume`).

**Audio format:** PCM16 mono **24 kHz**, **base64-encoded inside JSON events** (not raw binary frames — this is different from realtime STT). ~50 ms chunks (2,400 bytes) is fine; the server buffers continuously, exact chunk size doesn't matter.

### Lifecycle (the events that matter)

1. Client connects, sends `session.update` immediately (don't wait for `session.ready`):
   ```json
   {
     "type": "session.update",
     "session": {
       "system_prompt": "You are a helpful assistant.",
       "greeting": "Hi there! How can I help?",
       "input": {
         "format": { "encoding": "audio/pcm" },
         "keyterms": ["AssemblyAI", "Universal-3-5-Pro"],
         "turn_detection": {
           "vad_threshold": 0.5,
           "min_silence": 200,
           "max_silence": 1000,
           "interrupt_response": true
         }
       },
       "output": {
         "voice": "anna",
         "format": { "encoding": "audio/pcm" }
       },
       "tools": [ /* flat-schema tool defs, see step 5 */ ]
     }
   }
   ```
   Output `encoding` accepts `audio/pcm` (24 kHz, default), `audio/pcmu` (G.711 μ-law, 8 kHz), or `audio/pcma` (G.711 A-law, 8 kHz).
2. Server replies with `session.ready` (capture `session_id` for `session.resume` if you reconnect within 30 s of a disconnect).
3. **Only after `session.ready`**, start realtime mic audio:
   ```json
   { "type": "input.audio", "audio": "<base64 PCM16 24kHz>" }
   ```
4. Server emits, in roughly this order, per turn:
   - `input.speech.started` / `input.speech.stopped` (VAD)
   - `transcript.user.delta` (partials) and `transcript.user` (final)
   - `reply.started`, `reply.audio` (multiple base64 PCM16 chunks — write directly into an output buffer at 24 kHz), `transcript.agent`, `reply.done`
   - **Field-name asymmetry:** `input.audio` carries audio in the `audio` field; `reply.audio` carries it in the `data` field.
5. **Tool calls:** tool definitions in `session.tools` use a **flat** schema — *not* OpenAI's nested `{type: "function", function: {...}}` form:
   ```json
   {
     "type": "function",
     "name": "get_weather",
     "description": "Get the current weather for a city.",
     "parameters": {
       "type": "object",
       "properties": { "location": { "type": "string" } },
       "required": ["location"]
     }
   }
   ```
   Server sends `tool.call` with `{call_id, name, arguments}`. Accumulate the result locally, then send `tool.result` with the matching `call_id` *after* `reply.done` fires. If `reply.done.status == "interrupted"` (user barge-in), discard pending tool results.
6. **Resume after disconnect:** within 30 s, reconnect with a *new* token and send `session.resume` carrying the previous `session_id` to keep conversation context. After 30 s, start a new session.

### Voices

Voice IDs are **exact strings** — invented or remembered values silently fail. **Call `GET https://agents.assemblyai.com/v1/voices` for the authoritative live list** rather than guessing. Default: `anna`. A few current examples: US English `alba`, `jane`, `michael`; UK English `anna`, `charles`, `paul`, `vera`; language-specific `lola` (Spanish), `estelle` (French), `juergen` (German), `giovanni` (Italian), `rafael` (Portuguese). Pre-Voice-Agent-API names like `claire`, `dawn`, `josh`, `grace`, `pete` are **no longer valid**.

### Playback gotcha

Don't sleep-schedule audio chunks. Write each `reply.audio` PCM directly to an OS audio buffer — the OS drains at exactly 24 kHz and absorbs network jitter. On `reply.done.status == "interrupted"`, flush the output buffer so the user doesn't hear stale agent speech.

## 15. Quick-Reference Gotchas (those that bind this path)

- No `Bearer` prefix on the Authorization header — *except* for the Voice Agent API, which requires `Authorization: Bearer ...`.
- Browser code never holds the API key; mint temp tokens.
- Always terminate sessions; an abandoned session stays billable until the 3-hour cap.
- LLM Gateway model IDs are exact and versioned (e.g., `claude-sonnet-4-6`, `gpt-5.2`, `gemini-2.5-pro`); shorthand like `claude-sonnet-4` is invalid.
