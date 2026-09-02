# Citation Verification Report
**Date:** 2026-09-01  
**Task:** Fetch-verify 10 claims against live URLs

---

## 1. lablab.ai/live — Participant & Team Counts
**Claim:** Seats claimed 1,197/259, 1,390, and ~1,466/330  
**Status:** UNREACHABLE  
**Reason:** HTTP 403 Forbidden (access blocked)

---

## 2. lablab.ai/team-tle — VoiceFirewall Description
**Claim:** Team "VoiceFirewall" detects social engineering, urgency, impersonation, suspicious financial demands  
**Status:** UNREACHABLE  
**Reason:** HTTP 403 Forbidden (access blocked)

---

## 3. lablab.ai Event Page — Fraud/Scam Teams
**Claim:** Search for EverCall, "Jarvis for Grandma," or fraud/scam/voice-fraud teams with URLs  
**Status:** UNREACHABLE  
**Reason:** HTTP 403 Forbidden (access blocked)

---

## 4. AssemblyAI Docs: Session Configuration
**Claim:** System prompt, tools, keyterms, and turn-detection can be updated mid-session while WebSocket stays open  
**Status:** VERIFIED

**Quote (system prompt):**  
"Yes. Send a new prompt at any time to change the agent's behavior on the next turn."

**Quote (keyterms):**  
"Yes. Replace the keyterms list at any time. The new list takes effect on the next user utterance."

**Quote (turn detection):**  
"Yes. Adjust VAD thresholds, silence windows, and barge-in on the fly."

**Note:** Tools are accepted in subsequent `session.update` messages but lack explicit mutable designation in the table.

---

## 5. AssemblyAI Blog: Voice Agent Hackathon Winners (Sept 19)
**Claim:** Voxy overall winner, Podweaver technical (~250ms ad replacement), judge comment on Voxy  
**Status:** VERIFIED

**Quote (overall winner):**  
"Overall Winner: Voxy. Bob Summers' Voxy took the grand prize—a zero-code platform enabling businesses to deploy voice agents without technical expertise."

**Quote (Podweaver):**  
"Most Technically Complex: Podweaver. Anup Ghatage's Dynamic Podcast Ad Insertion project won for technical sophistication. The system replaces podcast advertisements with natural-sounding sponsorships while maintaining precise timing within 250 milliseconds."

**Quote (judge comment on Voxy):**  
"The platform just works. You can see how this could make voice agents accessible to any business, not just those with technical teams."

---

## 6. AssemblyAI Blog: 2024 Hackathon Winners
**Claim:** Dealty (real estate call to structured deal data) named as winner  
**Status:** VERIFIED

**Quote:**  
"The winning project: *Dealty* by Slavik Kaushan and Mario Uribe! Slavik and Mario are developers, entrepreneurs, and AI enthusiasts who used AssemblyAI's streaming speech-to-text and entity detection models to build a Voice AI tool to facilitate real estate investment deals."

---

## 7. arXiv HTML 2603.20953v1 — Policy Engine Defense Paper
**Claim:** APort/Vault CTF paper; social engineering 74.6% vs 0% success; limitations on composability/structuring/aggregate windows  
**Status:** VERIFIED (with note)

**Quote (success rates):**  
"Social engineering succeeded against the model 74.6% of the time under a permissive policy; under a restrictive OAP policy, a comparable population of attackers achieved a 0% success rate" (across 788 and 879 attempts respectively).

**Quote (composability limitation):**  
"A sequence of individually-permitted calls could collectively achieve an unauthorized outcome (e.g., multiple small transfers that exceed an aggregate limit—a 'structuring' attack)."

**Quote (roadmap):**  
"The draft OAP v1.1 includes sliding-window policy packs that maintain per-agent aggregate state to detect and block sequence-based structuring."

**Note:** This is the OAP (Operational Access Policy) paper, not explicitly labeled "APort/Vault CTF" in the fetched content, but matches the technical claims.

---

## 8. AssemblyAI Docs: HTTP Tools
**Claim:** AssemblyAI's servers call developer's HTTPS endpoint directly (not from browser)  
**Status:** VERIFIED

**Quote:**  
"Server-side tools. Give your agent a URL and a parameter list, and AssemblyAI makes the request for you when the model calls the tool. There's **no `tool.call`/`tool.result` round trip in your client**; your app just streams audio."

---

## 9. AssemblyAI Docs: Turn Detection & Interruptions
**Claim:** API distinguishes backchannels from semantic interruption; client must flush queued audio on interrupt  
**Status:** VERIFIED

**Quote (backchannels):**  
"Back-channels like 'uh-huh' or 'makes sense' don't interrupt; 'wait, stop' does."

**Quote (client flush):**  
"On that signal, stop and clear your queued audio so the user doesn't keep hearing stale speech."

---

## 10. AssemblyAI Blog: Voice Agent Features
**Claim:** Page claims ~300 ms turn detection and mid-sentence code-switching  
**Status:** CONTRADICTED

**Actual claim (found):**  
"The goal is end-to-end response time under 700ms" (full pipeline: ASR + LLM + TTS, not turn detection alone).

**Quote (against mid-sentence code-switching):**  
"Language locking means detecting the first language a user speaks, then staying with that language for the entire session" and "continuous multilingual detection causes more errors than it prevents in single-language conversations."

**Note:** Page does mention code-switching in a feature header but provides no performance claims and actively discourages mid-session switching.

---

## Summary
- **3 UNREACHABLE** (lablab.ai URLs return 403)
- **6 VERIFIED** (all AssemblyAI docs and hackathon results match claims)
- **1 CONTRADICTED** (voice-agent-features page contradicts ~300ms turn detection claim; actual spec is 700ms end-to-end)


## Founder-verified from his own browser, 2026-09-01 10:47 PM CDT (screenshots)
- Event page (lablab.ai/ai-hackathons/assemblyai-voice-agent-hackathon): **Approved 1477** participants (green up-arrow), Sep 1–30 2026, submission deadline Sep 30 10:00 AM CDT, $10,000 pool ($5k cash + $5k AAI credits), a "Live Results" button is already visible. VERIFIED. Seats had said 1,197 / 1,390 / ~1,466 — all were low or stale; the brief's Aug 26 figure (485) is three times too small.
- Team TLE page (…/team-tle): TEAM IDEA verbatim: "We are building VoiceFirewall, a real time AI safety layer for live voice conversations. It uses AssemblyAI to analyze speech as it happens and detect risky patterns such as scam…" (truncated on the page). Two members; "Team Leader hasn't made a submission yet." VERIFIED. Classification: a DETECTOR (analyze + detect risky patterns) — adjacent lane; not an interrogation, not a policy engine, not stage-only. Positioning line stands: they alarm; we interrogate, collect evidence, and gate the action.
