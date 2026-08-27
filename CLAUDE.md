# Countersign — Claude Code Rules
# Distilled from docs/BRIEF.md (the constitution — read it in full before any build work).
# A fresh session reads: this file → docs/BRIEF.md → docs/ASSEMBLYAI_INTEGRATION.md.

## What this is
A hackathon entry (AssemblyAI Voice Agent Hackathon, lablab.ai, Sep 1–30 2026): a real-time
conversational security checkpoint against voice fraud. Solo founder (non-developer; plain
English, no jargon) + AI-assisted build. Judged on: Presentation, Business value,
Application of technology, Originality.

## THE LAWS (violating any reopens a decided question — don't)
1. **NO DETECTION CLAIMS, EVER.** Never claim to detect synthetic/deepfake voices — not in
   code, comments, README, video, or conversation. Mechanism is BEHAVIORAL verification only.
2. **VOICE NEVER RELEASES THE WIRE.** A verified request only ever reaches STAGED +
   independent second approval. Fraud → freeze + incident + containment.
3. **THE DETERMINISTIC CORE.** A finite-state policy engine computes every verdict from
   structured evidence. The LLM phrases conversation within state bounds; it NEVER emits a
   verdict. This boundary must be visibly airtight.
4. **EXACT-TRANSCRIPT EVIDENCE.** Evidence records quote verbatim STT substrings, never LLM
   paraphrase. Facts stored separately from interpretation. Say "hash-chained evidence
   export," never "immutable/sealed/cryptographically guaranteed."
5. **SCOPE FENCE.** Build NONE of: acoustic classifiers, real banking/SSO/SIEM integrations,
   carrier telephony, multi-agent architectures, consumer app beyond the demo coda, RAG,
   avatars, dashboards beyond the split screen, autonomous unfreezing, real personal data,
   unmeasured "90% faster"-style claims.

## Stack (ratified — see BRIEF §14/§14b for the reasoning)
TypeScript end-to-end (shared evidence/FSM types engine→server→UI→tests) · Vite + React
split-screen UI · one small Node server · policy engine = pure dependency-free module
imported by tests · seed JSON in-repo, in-memory state, NO database · Vitest + GitHub
Actions · browser connects DIRECT to AssemblyAI's WebSocket via server-minted ephemeral
tokens; engine runs in-browser for tempo, server RE-RUNS the same engine before any
terminal action (stage/freeze) and only acts on a matching verdict.
Excluded: Python services, LangChain-class frameworks, databases, Docker/K8s.

## Engineering laws from the ratified consult (BRIEF §14)
- Barge-in is won in the CLIENT audio buffer: Web Audio, tiny queue, flush + cancel
  in-flight TTS on interrupt. AAI socket + audio management live in a WEB WORKER off the
  React thread; UI updates throttled ~15fps.
- Never write "sub-second" anywhere without measured p50/p95 from the real stack.
- Determinism = ENGINE only: pure (conversation_log, tools_log, seed_config) → verdict.
  Tests replay recorded transcripts through the REAL engine — never call the live API in
  tests, never test a copy of the engine.
- Mocked tools (SSO, out-of-band, payments) carry a visible "simulated" banner.
- FSM has graceful OUT_OF_SCOPE states — a judge WILL say "I'm not the CEO, I'm testing
  this." Never deadlock. Landing page: 30-second script, scenario cheat-sheet, desktop-
  Chrome note, mic-permission check, and a no-mic REPLAY mode that drives the full UI.
- Abuse caps are SUBMISSION REQUIREMENTS: explicit Start-Call click, per-session minute
  cap, concurrency 1-2, idle disconnect, daily cap, mint rate limit, kill switch,
  credits-exhausted replay mode. Reset endpoint scoped to session id.
- Per-state tool allowlists enforced server-side; typed tool payloads validated/repaired
  in code; out-of-state calls ignored.

## Verification discipline
- Nothing is "done" without a green executable test importing the real code. Reviews/
  compiles/"looks right" are not pass signals.
- Every number and claim labeled: PROVEN (source in the same sentence), ESTIMATE (method),
  or UNKNOWN (+ how to find out).
- Anything marked VERIFY-AT-BUILD in the brief must be checked against live AssemblyAI
  docs before coding against it — never assumed.

## Gates (abort criteria — BRIEF §10)
G1 golden path DEPLOYED, stranger-usable (by Sep 7) · G2 Scenario B twice consecutively,
zero resets (Sep 14) · G3 reproducible FSM verdicts (Sep 14) · G4 no action without
structured evidence, approve ceiling = STAGED (always) · G5 50+ rehearsals, tail latency
in target (Sep 21) · G6 video ≥2:20 live agent (Sep 27). Two gates slip → founder
downgrade call.

## Origin (know what you're holding)
This concept was produced by the Origination Protocol (~/.claude/roles/originator.md),
2026-08-25: mined from the founder's IAM career → generated as a rival to its own
predecessor (Attest) against a written judging function → survived four blind hostile
panels → its differentiator (behavioral verification, LAW 1) IS the panels' strongest
objection, redesigned into the product. Any pivot proposal must re-run that protocol,
not swap ideas casually.

## THE RITUALS (founder-ratified 2026-08-26 — enforced at phase boundaries, not per-commit)
1. **Demo-first days:** every build day ends with the full demo RUNNABLE from the deployed
   URL. A day that ends with a broken demo is not done. (Polish compounds for 4 weeks
   instead of being crammed into the last one.)
2. **Weekly judge-simulation (Fridays):** a red-team agent plays a judge against the live
   demo — scores it on the real rubric (Presentation, Business value, Application of
   technology, Originality), asks off-script questions, tries to break it in a stranger's
   hands. Output = a scored card + the top 3 fixes. Sims: Sep 12, Sep 19, Sep 26 (that
   one runs on the full submission package).
   BUILD-ON-FIRST-USE (founder-ratified 2026-08-26, do NOT build earlier): at the FIRST
   sim (Sep 12), first create the named `judge-sim` agent (user-level ~/.claude/agents/,
   Sonnet pin, PERSISTENT MEMORY ON so Friday scores are comparable, preload = the rubric
   + scoring format only). At G1 deploy (~Sep 3), first create `qa-walker` (Sonnet,
   memory ON for regression-spotting, preload = experience-report format) and run it on
   the fresh URL. The `red-team` named agent gets built at its next invocation — memory
   OFF BY DESIGN (fresh eyes every kill; blind panels are the law).
3. **The ambition pass:** before ANY artifact reaches the founder (UI state, video cut,
   README, deck): answer "what would the keynote version of this be?" with one concrete
   upgrade, applied or proposed. Every ritual's output must name a decision or it is
   theater and gets deleted.
4. **Working-backwards + premortem: already satisfied** — the video beat sheet (§8) is
   the ending we build toward; the risk register (§12) is the premortem. Re-read both at
   every week boundary; a new risk discovered mid-build gets ADDED to §12 same day.

## Hygiene
- NO secrets in the repo, ever: API keys via env; .env gitignored from the first commit;
  deploy secrets in the host's secret store. No real personal or corporate data — every
  identity and system is synthetic and disclosed as such.
- This repo is fully self-contained: it never references, reuses, or links to any of the
  founder's other products or private projects.
- Repo is PRIVATE during the build (founder ruling 2026-08-26) and flips public at
  submission — run docs/PREFLIP_CHECKLIST.md before the flip. Commit incrementally with
  clear messages; the history is part of the submission story.
- Founder communication: plain English, one decision at a time with a concrete
  recommendation, questions batched up front.
