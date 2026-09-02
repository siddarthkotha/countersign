# AssemblyAI Voice Agent API — Contract Verification (2026-09-01)

**Verification Date:** 2026-09-01  
**Pages Fetched:** llms.txt index, events-reference, generate-voice-agent-token, browser-integration, turn-detection-and-interruptions, tools/client-side-tools, session-configuration, audio-format, voices, connect-your-own-llm, voice-agent-websocket, tools/http-tools

---

## a. WebSocket URL and Token Passing

**PROVEN (Browser Integration):**
- **WebSocket URL:** `wss://agents.assemblyai.com/v1/ws`
- **Token Parameter:** Query string `?token=<token>`, not header
- **Quote:** "The WebSocket connects to `wss://agents.assemblyai.com/v1/ws` with the token supplied as a query parameter: `?token=<token>`."

**PROVEN (WebSocket Reference):**
- **Alternate Auth (server-to-server):** Bearer token in Authorization header
- **Quote:** "Pass your API key as a Bearer token in the `Authorization` header on the WebSocket upgrade request. For browser applications, generate a temporary token via `GET /v1/token` and pass it as the `token` query parameter instead."

---

## b. Token Mint Endpoint

**PROVEN (generate-voice-agent-token):**
- **Method & URL:** `GET https://agents.assemblyai.com/v1/token`
- **Authentication:** `Authorization: Bearer YOUR_API_KEY`
- **Request Parameters:**
  - `expires_in_seconds` (required, 1–600): "Token redemption window, in seconds"
  - `max_session_duration_seconds` (optional, 60–10800, default 10800): Session duration cap
- **Response Shape:**
  ```json
  {
    "token": "string",
    "expires_in_seconds": integer
  }
  ```
- **Single-Use:** Yes. "Each token is one-time use and can only be used for a single session."
- **CORS Notes:** Not documented. Endpoint targets server-side token generation; clients receive tokens for subsequent WebSocket connections.

---

## c. Audio Format

**PROVEN (audio-format page):**
- **Input & Output:** Base64-encoded, mono
- **Three Encodings Supported:**
  | Encoding | Sample Rate | Bit Depth | Use Case |
  |----------|------------|-----------|----------|
  | `audio/pcm` | 24,000 Hz | 16-bit signed integer (little-endian) | Default for browsers/apps |
  | `audio/pcmu` | 8,000 Hz | 8-bit μ-law | Telephony (G.711 μ-law) |
  | `audio/pcma` | 8,000 Hz | 8-bit A-law | Telephony (G.711 A-law) |

- **Configuration Fields:**
  - `input.format.encoding` — Incoming audio encoding
  - `output.format.encoding` — Outgoing audio encoding
  - `format.sample_rate` — Optional; auto-determined by encoding if omitted
- **Quote:** "output.format is immutable after session.ready"

---

## d. Full List of Event Names & Key Fields

### Client → Server Events

**PROVEN (events-reference + WebSocket):**
1. `input.audio` — `audio` (base64-encoded PCM16)
2. `session.update` — `session` object with configuration (see schema below)
3. `session.resume` — `session_id`
4. `session.end` — (no fields)
5. `tool.result` — `call_id`, `result`, `is_error`
6. `reply.create` — `instructions` (optional)
7. `conversation.message` — `role`, `content`

### Server → Client Events

**PROVEN (events-reference + WebSocket):**
1. `session.ready` — `session_id`, `config`, `expires_at`, `resume_token`
2. `session.updated` — `config`
3. `session.ended` — `session_duration_seconds`, `audio_duration_seconds`, `timestamp`
4. `input.speech.started` — (no fields)
5. `input.speech.stopped` — (no fields)
6. `transcript.user.delta` — `item_id`, `text`
7. `transcript.user` — `text`, `item_id`
8. `reply.started` — `reply_id`, `item_id`
9. `reply.audio` — `data` (base64 PCM16)
10. `transcript.agent.delta` — `reply_id`, `item_id`, `delta`, `start_ms`, `end_ms`
11. `transcript.agent` — `text`, `reply_id`, `item_id`, `interrupted`
12. `reply.done` — `reply_id`, `status`
13. `tool.call` — `call_id`, `name`, `arguments`
14. `session.error` — `code`, `message`, `timestamp`

### session.update Configuration Schema

**PROVEN (WebSocket reference — full JSON schema provided):**

```json
{
  "type": "session.update",
  "session": {
    "agent_id": "string (optional)",
    "system_prompt": "string (optional)",
    "greeting": "string (optional)",
    "input": {
      "format": {
        "encoding": "audio/pcm | audio/pcmu | audio/pcma"
      },
      "keyterms": ["string"],
      "turn_detection": {
        "vad_threshold": 0.0–1.0,
        "min_silence": 50–10000 ms,
        "max_silence": 50–10000 ms,
        "interrupt_response": boolean
      }
    },
    "output": {
      "voice": "string",
      "format": {
        "encoding": "audio/pcm | audio/pcmu | audio/pcma"
      },
      "volume": 0–100
    },
    "tools": [
      {
        "type": "function",
        "name": "string",
        "description": "string",
        "parameters": { /* JSON Schema object */ },
        "execution_mode": "interactive | hold",
        "timeout_seconds": 1–300
      }
    ]
  }
}
```

**Key Fields (from events-reference):**
- **Core Agent:** `system_prompt`, `greeting`, `tools` (array of function definitions)
- **Input Audio:** `input.format.encoding`, `input.transcription_mode` (min_latency, balanced, max_accuracy), `input.turn_detection`, `input.keyterms` (up to 100 strings), `input.language_codes`, `input.voice_focus` (near-field or far-field)
- **Output Audio:** `output.voice`, `output.format.encoding`, `output.volume` (0–100)
- **Agent Binding:** `agent_id` (first update only, mutually exclusive with inline fields)

---

## e. Tool Calling

**PROVEN (client-side-tools + http-tools + WebSocket):**

### Tool Schema (Flat, single object per tool)

```json
{
  "type": "function",
  "name": "tool_name",
  "description": "When to call this tool",
  "parameters": { /* JSON Schema */ },
  "execution_mode": "interactive | hold",
  "timeout_seconds": 1–300
}
```

### tool.call Event (Server → Client)

**PROVEN (events-reference):**
- Fields: `call_id`, `name`, `arguments`
- Quote: "Agent invoked a tool; includes `call_id`, `name`, `arguments`"

### tool.result Event (Client → Server)

**PROVEN (client-side-tools):**
- Structure: `{"type": "tool.result", "call_id": "...", "result": "JSON string"}`
- **Critical Timing:** "Send `tool.result` when `reply.done` is the latest event you've received. Not earlier (agent is still mid-transition-phrase), not later (a new turn has started)."
- Quote: "Send `tool.result` only after receiving `reply.done` event"

### Execution Modes

**PROVEN (WebSocket schema):**
- `"interactive"` — Respond mid-execution
- `"hold"` — Wait for completion

**PROVEN (client-side-tools):**
- `timeout_seconds` range: 1–300; agent apologizes on timeout but continues

### HTTP Tool Specifics

**PROVEN (http-tools):**
- **Request Mapping:**
  - GET, DELETE: Query string (values stringified; null values dropped)
  - POST/PUT/PATCH: JSON request body with native types preserved
- **Response:** Body limited to 8 KiB, feeds back to model as tool result
- **Auth:** Headers remain encrypted at rest, write-only
- **HTTPS-only with public hosts**

---

## f. Barge-in / Interruption

**PROVEN (turn-detection-and-interruptions):**

### Events Fired on User Interrupt
- `reply.done` with `status: "interrupted"`
- `transcript.agent` with `interrupted: true` (text trimmed to what user heard)

### reply.done Status Values
- `"interrupted"` — explicitly documented status value

### Server Audio Behavior
**UNKNOWN** — Documentation does not explicitly state whether server stops sending `reply.audio`. Implied pattern: client must act.

### Client Responsibility

**PROVEN (turn-detection-and-interruptions):**
- Quote: "stop and clear your queued audio so the user doesn't keep hearing stale speech"
- Recommended pattern:
  ```javascript
  if (m.type === "input.speech.started") flushPlayback();
  if (m.type === "reply.done" && m.status === "interrupted") flushPlayback();
  ```
- Configuration: `"interrupt_response": false` disables barge-in (enabled by default)

---

## g. Session Limits

**PROVEN (generate-voice-agent-token):**
- **Max Session Duration:** Controlled by `max_session_duration_seconds` parameter (60–10800, default 10800)
- Parameter passed to token mint endpoint

**PROVEN (WebSocket reference):**
- **Session Resume Window:** 30 seconds
- Quote: "Sessions remain resumable for 30 seconds after disconnect"

**UNKNOWN:**
- Idle behavior / idle timeout settings
- Detailed session.resume operation semantics (beyond 30-second window)

---

## h. LLM Models and TTS Voices

### TTS Voices

**PROVEN (voices page):**

Parameter Name: `voice_id`, set within `"voice"` object

**English Voices (11 total):**
- American: alba, eve, george, jane, jean, mary, michael
- British: anna, charles, paul, vera

**Language-Specific Voices (5 total):**
- Italian: giovanni
- Spanish: lola
- German: juergen
- Portuguese: rafael
- French: estelle

**Quote:** "the voice is **immutable once the session is established**"

### LLM Models

**PROVEN (connect-your-own-llm):**

**Selectable Models:**
1. **Custom OpenAI-compatible endpoints:** Any model accessible via OpenAI-compatible API
2. **LLM Gateway:** Frontier models including Claude (e.g., "claude-sonnet-4-6"), GPT, Gemini through AssemblyAI's unified endpoint

**Parameter Configuration:**
```json
{
  "llm": [
    {
      "base_url": "HTTPS base URL of the OpenAI-compatible endpoint",
      "model": "model identifier",
      "api_key": "authentication credential"
    }
  ]
}
```

**Quote:** "The endpoint must support streamed chat completions, as real-time voice interactions require token streaming."

**Default:** To revert to AssemblyAI's managed model, send empty array: `"llm": []`

---

## i. JavaScript/TypeScript Browser Example

**PROVEN (browser-integration):**

```javascript
const wsUrl = new URL("wss://agents.assemblyai.com/v1/ws");
wsUrl.searchParams.set("token", token);
const ws = new WebSocket(wsUrl);

ws.addEventListener("open", () => {
  ws.send(JSON.stringify({
    type: "session.update",
    session: { agent_id: AGENT_ID },
  }));
});
```

**Quote:** "The starter repositories ([Python](https://github.com/AssemblyAI/voice-agent-starter-python) and [JavaScript](https://github.com/AssemblyAI/voice-agent-starter-js)) provide complete implementations with audio worklet handling, echo cancellation, and browser compatibility adjustments for Safari's sample rate behavior."

---

## Summary of Sources

| Item | URL | Status |
|------|-----|--------|
| llms.txt index | https://www.assemblyai.com/docs/llms.txt | PROVEN |
| Events Reference | https://www.assemblyai.com/docs/voice-agents/voice-agent-api/events-reference | PROVEN |
| Token Generation | https://www.assemblyai.com/docs/voice-agents/voice-agent-api/api-spec/generate-voice-agent-token | PROVEN |
| Browser Integration | https://www.assemblyai.com/docs/voice-agents/voice-agent-api/browser-integration | PROVEN |
| Turn Detection & Interruptions | https://www.assemblyai.com/docs/voice-agents/voice-agent-api/turn-detection-and-interruptions | PROVEN |
| Client-Side Tools | https://www.assemblyai.com/docs/voice-agents/voice-agent-api/tools/client-side-tools | PROVEN |
| HTTP Tools | https://www.assemblyai.com/docs/voice-agents/voice-agent-api/tools/http-tools | PROVEN |
| Audio Format | https://www.assemblyai.com/docs/voice-agents/voice-agent-api/audio-format | PROVEN |
| Voices | https://www.assemblyai.com/docs/voice-agents/voice-agent-api/voices | PROVEN |
| Custom LLM | https://www.assemblyai.com/docs/voice-agents/voice-agent-api/connect-your-own-llm | PROVEN |
| WebSocket Spec | https://www.assemblyai.com/docs/voice-agents/voice-agent-api/api-spec/voice-agent-websocket | PROVEN |
