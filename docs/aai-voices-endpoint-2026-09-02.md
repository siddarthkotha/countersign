# AssemblyAI Voice Agent API — Voices Endpoint Lookup

**Date:** 2026-09-02  
**Status:** NOT FOUND (dedicated endpoint)  
**Query:** Exact HTTP request to list available voices

## Finding

**No dedicated REST endpoint for listing voices exists in AssemblyAI Voice Agent API documentation.**

### What the Docs Say

**Base URL:** `https://agents.assemblyai.com` (confirmed)

**Voice Selection Mechanism:** Voices are **not** retrieved via a dynamic API endpoint. Per the [Voices documentation](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/voices): "Pick any voice ID from the tables below and set it as `voice` when you create the agent." Available voices are published as **static reference tables** in the documentation.

**Authentication Header Format:** Per [Manage Agents documentation](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/manage-agents):
```
Authorization: <YOUR_API_KEY>
```
(Raw key only; "Bearer " prefix is accepted and stripped by the API.)

**Agent Creation (POST /v1/agents) Request Body:**
```json
{
  "name": "Support Agent",
  "voice": { "voice_id": "alba" }
}
```
Voices are configured **within agent creation**, not discovered via a separate endpoint.

## Why HTTP 426 "Upgrade Required"

Your attempted call to `GET https://agents.assemblyai.com/v1/voices` returned 426 because:
1. **No such endpoint exists** for listing voices dynamically
2. The 426 response likely indicates an attempt to use HTTP on a WebSocket-only protocol path, or the server rejecting an invalid endpoint entirely

## Workaround

Hardcode voice IDs from the [published Voices reference table](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/voices). Example IDs: `alba`, `andy`, `breeze`, etc.

**References:**
- [Voice Agent API - Voices](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/voices)
- [Voice Agent API - Manage Agents (REST)](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/manage-agents)
