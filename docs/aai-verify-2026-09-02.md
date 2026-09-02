# AssemblyAI Voice Agent API Verification (2026-09-02)

Fetched 6 pages via WebFetch; answers below labeled VERIFIED or NOT FOUND with verbatim quotes and URLs.

---

## Q1: Mid-Call `session.update` Mutability

**VERIFIED** Can change: `tools`, `system_prompt`, `input.keyterms`, `input.turn_detection`.

- **Mutable after `session.ready`:**
  - System Prompt: "Send a new prompt at any time to change the agent's behavior on the next turn." ([session-configuration](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/session-configuration))
  - Keyterms: "Replace the keyterms list at any time. The new list takes effect on the next user utterance." ([session-configuration](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/session-configuration))
  - Turn Detection: "VAD thresholds, silence windows, and barge-in" adjustable mid-session. ([session-configuration](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/session-configuration))
  - Tools: "Accepted in subsequent updates without raising errors." ([session-configuration](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/session-configuration))

**Immutable Fields:**
- Greeting: "The greeting is spoken once at session start—cannot be modified afterward." ([session-configuration](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/session-configuration))
- Output Voice: "The voice is bound to the TTS connection at session start" and raising an `immutable_field` error if altered. ([session-configuration](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/session-configuration))
- Output Encoding: "The output audio encoding is fixed for the session." ([session-configuration](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/session-configuration))

Generic note: "greeting and output are immutable after session.ready and changing them returns immutable_field." ([voice-agent-websocket](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/api-spec/voice-agent-websocket))

---

## Q2: Exact Voice Field Format & English Voice IDs

**VERIFIED** Dual formats observed:

**WebSocket Session Config:**
```json
"output": { "voice": "alba" }
```

**REST API Creation:**
```json
"voice": { "voice_id": "alba" }
```

**English Voice IDs (11 total):**
American: `alba`, `eve`, `george`, `jane`, `jean`, `mary`, `michael`  
British: `anna`, `charles`, `paul`, `vera`

**Quote:** "The voice is **immutable once the session is established**, so it can't be changed mid-conversation." ([voices](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/voices))

---

## Q3: `input.audio` Event Specification

**VERIFIED** 

- **Field name:** `input.audio` (the WebSocket message type carries audio in this field).
- **Base64 chunk size:** "Chunk size doesn't matter; ~50 ms works well." ([audio-format](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/audio-format))
- **Cadence:** Real-time transmission. "The system drops frames beyond about one second of audio per second of wall clock." ([audio-format](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/audio-format))
- **Encoding:** "The default encoding is 24 kHz PCM16 mono with little-endian byte order (`audio/pcm` at 24,000 Hz with 16-bit signed integer samples)." ([audio-format](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/audio-format))

---

## Q4: `session.resume` Exact Payload & Token Requirement

**VERIFIED**

- **Payload structure:** `{ "type": "session.resume", "session_id": "<id_from_prior_ready_event>" }`
- **Token requirement:** NEW token still required. "Both `type` and `session_id` fields are required; authentication via API key or temporary token is still needed on reconnect." ([voice-agent-websocket](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/api-spec/voice-agent-websocket))
- **30-second window:** "Sessions remain resumable 'for 30 seconds after every disconnection.'" ([voice-agent-websocket](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/api-spec/voice-agent-websocket))

---

## Q5: LLM Selection Field, Model IDs & Default Revert

**VERIFIED** Config via `llm` array with three fields:

- **base_url:** "HTTPS base URL of the OpenAI-compatible endpoint" ([connect-your-own-llm](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/connect-your-own-llm))
- **model:** The model identifier sent to endpoint's chat-completions service ([connect-your-own-llm](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/connect-your-own-llm))
- **api_key:** "never returned in any response" ([connect-your-own-llm](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/connect-your-own-llm))

**Example model IDs:** Not explicitly listed in extracted docs; docs reference "Claude, GPT, Gemini" via LLM Gateway.

**Default (revert):** "By default, agents use AssemblyAI's managed conversational model without any configuration needed." ([connect-your-own-llm](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/connect-your-own-llm)) — omit the `llm` field to revert.

**Gateway alternative:** `https://llm-gateway.assemblyai.com/v1` ([connect-your-own-llm](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/connect-your-own-llm))

---

## Bonus: `tool.result` & `reply.create` Shapes

**tool.result Payload:**
```json
{
  "type": "tool.result",
  "call_id": "call_abc123",
  "result": "{\"temp_c\": 22, \"description\": \"Sunny\"}",
  "is_error": false
}
```
**Critical:** `result` is a **JSON string**, not an object. Serialize to JSON before transmission. `is_error` optional (defaults `false`). ([events-reference](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/events-reference))

**reply.create Usage:**
```json
{
  "type": "reply.create",
  "instructions": "Let the customer know we're still processing the transfer."
}
```
**Quote:** "does not modify `system_prompt`." Used for proactive agent responses during tool holds or status updates. `instructions` optional. ([events-reference](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/events-reference))

