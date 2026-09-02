# Plan 2: The Voice Path — server relay, browser terminal, replay-first landing, deploy

**Status: PARKED FOR FOUNDER GO (written on autopilot 2026-09-01 ~11:30 PM CDT; no code from this plan exists).**
Founder law: he sees the plan before code. Visual identity decisions are NOT made here (the look pick among six-looks 2/4/6, the character's name and TTS voice, and the exact keynote layout are his; this plan builds the structure they will be applied to).

**Spec:** docs/BRIEF.md §6, §14, §15, §16 (D2 server-authoritative, D3 keynote-then-forensic, D4 replay-first), docs/ASSEMBLYAI_INTEGRATION.md (re-verified 2026-09-01), docs/consults/2026-09-01-panel-synthesis.md, docs/aai-docs-check-2026-09-01.md.

## Plain English (what the founder gets)
1. **A server that holds the phone.** Our Node server opens the AssemblyAI voice connection itself. The browser only sends microphone audio up and plays audio down, over one connection to our server. The server keeps the authoritative transcript, runs the engine (the brain built tonight), issues the questions, executes the simulated tool checks, and pushes screen states down. The browser computes nothing and cannot lie.
2. **A judge's wifi blip does not end the call.** Because the AssemblyAI session lives on the server, a browser disconnect just reconnects to our server; the call and the evidence survive. On screen: "voice link lost, security state preserved".
3. **Replay first.** The landing page offers "Watch a live attack" (the recorded corpus driving the full screen, no microphone) before "Try to break it" (live mic, Chrome, explicit Start Call click). Two role cards without answers.
4. **The keynote screen, then the forensic screen.** During the call: the request at the top, the conversation in the middle with the disputed claim highlighted, three gates on the right (request context, verified device, story consistency), one line at the bottom: no funds move by voice alone. After the verdict: the forensic drill-down (every evidence card with provenance, the ledger, the questions asked and graded, the counterfactual "what single change would have flipped this", the hash-chained export, the server/browser countersign line).
5. **Abuse caps as submission requirements.** Explicit Start Call, per-session cap enforced by AssemblyAI's own token parameter plus ours, one to two concurrent sessions with a "session in use" gate, idle disconnect ~30 s of silence both sides, daily cap, mint rate limit, kill switch, credits-exhausted replay mode, reset scoped to session id.
6. **Deployed on one always-on container** (Render Starter class, founder spend-OK pending), static frontend served by the same box, secrets in the host's store, `.env` local only.

## Architecture (D2, server-authoritative)
```
Browser (untrusted terminal)                  Our server (authority)                     AssemblyAI
 mic → AudioWorklet 24k PCM16 → ws:/call ──▶  session mgr ──▶ wss://agents.assemblyai.com/v1/ws (token minted here)
 ◀── playback audio chunks + screen state ◀── engine.evaluate() on every event ◀── transcript.user / transcript.agent / tool.call / reply.*
 flush queue on input.speech.started / reply.done(interrupted)   tool.call → mock backend (server) → tool.result (after reply.done)
                                              session.update per state (system prompt = goal.hint, keyterms, turn_detection patient/default)
                                              terminal actions only when decide() says so; countersign line = engine re-run on the frozen logs
```
- Packages: `packages/server` (Node 24, `ws`, no framework beyond `node:http`; imports `@countersign/engine`), `packages/web` (Vite + React; imports engine TYPES only for rendering; never runs `evaluate`).
- Server modules: `token.ts` (mint with `max_session_duration_seconds` = session cap), `aai/session.ts` (the AAI socket: connect, `session.update`, event fan-in), `call/session.ts` (per-call state: conversation/tools/actions logs, engine outputs, timers), `call/llmBridge.ts` (turns `goal` into the system prompt + tool allowlist + keyterms; writes `challenge_issued`/`readback_issued` actions on the matching `reply.done`), `tools/dispatch.ts` (tool.call → per-state allowlist check → mock backend → tool.result timing rule), `actions/terminal.ts` (stage/freeze/incident/alert/export with the countersign re-run), `caps.ts` (all abuse caps, in-memory), `replay.ts` (serves corpus files as event streams), `ws/browser.ts` (browser protocol: audio up, audio + `ScreenState` down), `screen/state.ts` (EngineOutput → judge-legible `ScreenState`: request, gates, transcript, banner, forensic payload).
- Browser modules: `audio/capture.worklet.ts`, `audio/playback.ts` (tiny queue, flush), `ws/client.ts` (in a Web Worker; ~15 fps state throttle), `screens/Landing.tsx` (script, mic check, role cards, replay vs live), `screens/Call.tsx` (keynote layout), `screens/Forensic.tsx` (drill-down), `screens/Replay.tsx` (same components, event-driven).
- Shared: `packages/engine/src/types.ts` gains `ScreenState` (server → browser) and `BrowserEvent` (browser → server) types.

## Verified contract points this plan relies on (docs/aai-docs-check-2026-09-01.md, PROVEN)
Token mint `GET /v1/token` with `expires_in_seconds` (1–600) and `max_session_duration_seconds` (60–10,800); WebSocket `?token=`; 24 kHz PCM16 mono base64; `session.update` fields incl. `system_prompt`, `tools[]` with `execution_mode` and `timeout_seconds`, `input.keyterms` (≤100), `input.turn_detection.{min_silence,max_silence,interrupt_response}`, `output.voice`; `tool.result` only when `reply.done` is the latest event; `reply.done.status === 'interrupted'` and `transcript.agent.interrupted` with trimmed text; client flushes queued audio on `input.speech.started`; session resume within 30 s. UNKNOWN: idle timeout server-side; whether `session.update` mid-call may change `tools` (VERIFY-AT-BUILD, task S3).

## Tasks (each ends with a green test; server tasks are testable without an API key by faking the AAI socket)
- **S1 Server scaffold + caps + token mint** (Vitest with a fake fetch; caps unit-tested: concurrency gate, daily cap, mint rate limit, kill switch, idle timer). Interfaces: `POST /api/session/start` → `{session_id, ws_url}` or `{replay_only: true, reason}`; `POST /api/session/:id/reset`; `GET /health`.
- **S2 Call session + browser protocol** (fake AAI socket emitting recorded events; assert the server's conversation/tools/actions logs equal the corpus files byte-for-byte and `evaluate` output matches `expected`). This is the proof that the live path and the replay path share one truth.
- **S3 AAI session adapter** (connect, session.update per state, event mapping, tool.result timing, interrupt flush signal; unit-tested against a scripted fake; ONE live smoke test script gated on `ASSEMBLYAI_API_KEY`, never in CI). VERIFY-AT-BUILD: mid-call `tools` update; keyterm limits; voice ids.
- **S4 LLM bridge** (goal → system prompt template + tool allowlist + keyterms; `challenge_issued`/`readback_issued` actions written on `reply.done`; stalling lines library ≥8 mapped to check types; tested with recorded goals).
- **S5 Terminal actions + countersign** (re-run `evaluate` over the frozen logs; act only on a match; export via `buildEvidenceExport`; incident ids deterministic; tested).
- **S6 Replay server** (serves corpus files as timed event streams identical in shape to live; tested).
- **W1 Web scaffold + Landing** (script, mic check with failure banner, desktop-Chrome note, two role cards WITHOUT answers, Watch/Try buttons).
- **W2 Audio + worker client** (AudioWorklet capture, playback queue with flush, worker socket, 15 fps throttle; tested with a fake server).
- **W3 Call screen** (keynote layout, structure only; the founder's look applied in W5).
- **W4 Forensic screen** (cards with provenance, ledger, challenges, counterfactuals, export hash, countersign line).
- **W5 Look application** (founder's pick among 2/4/6 + character decision; the two-channel live trace; colour by numeric contrast; never invented on autopilot).
- **D1 Deploy** (Render service + static; secrets in the host store; health check; cold-start check; measured p50/p95 latency table in README from the real stack).
- **Q1 qa-walker first run at G1** (per THE RITUALS: build the named agent at G1 deploy; memory ON).

## Estimates (ESTIMATE, method: tonight's engine build ran ~9 Sonnet implementer/reviewer tasks in ~1.5 session-hours of wall clock at ~100–280k tokens each)
Server S1–S6: 3–4 session-hours, ~1.2–1.8M Sonnet tokens. Web W1–W4: 3–4 session-hours, ~1.2–1.8M. W5 + D1 + Q1: 2 session-hours + founder decisions. Founder time: API key signup (10 min), Render account + $7/mo decision (10 min), look pick (5 min), character name/voice (5 min), one live rehearsal as the attacker (20 min).

## Founder inputs that gate this plan
1. GO on this plan. 2. AssemblyAI API key via the event credits link → `.env` locally (`ASSEMBLYAI_API_KEY=`), never committed. 3. Hosting spend YES/NO (Render Starter). 4. Look pick 2/4/6. 5. Character name + TTS voice from the 11 English voices (immutable per session). 6. Sep 3–4 evening slot for the first live rehearsal.
