# Countersign: lablab.ai Submission Draft

<!--
FOR THE FOUNDER, NOT FOR THE FORM (per BRIEF §12, risk 13, founder-visible 2026-09-02):
An unrelated product also named "Countersign" ("the security firewall for LLM
applications," Python/uvicorn) holds https://countersign.onrender.com. Our deploy is
https://countersign-bf8q.onrender.com, one character suffix apart. A judge who googles
"Countersign" or types the plain URL from memory may land on the wrong product. §13's
uniqueness verdict was left OPEN as an integrated product name, unchanged as of this
draft. This still needs a founder decision: keep the name and make every link explicit
(what this draft does: full URL everywhere, never a bare word), or add a short
qualifier to the submission title (e.g. "Countersign, voice checkpoint"). Not resolved
here; flagged for you to decide before the form is actually submitted.
-->

Everything below this line is paste-ready text for the lablab.ai submission form.

---

## 1. Project title + tagline

**Title:** Countersign

**Tagline (10 words):** Countersign doesn't guess who's calling. It makes them prove it.
<!-- source: docs/BRIEF.md §3 "Tagline (video close, panel-endorsed)"; README.md line 5 -->

---

## 2. Short description (150 words)

When a call demands something urgent and irreversible, like a wire transfer or a
credential reset, Countersign answers first. It is a real-time voice agent, built on
the AssemblyAI Voice Agent API, that runs a calm, adaptive security interview before
any request can move, checking what the caller claims to know, asking cross-checking
questions, and tracking whether their story holds up turn to turn. Every claim is
checked against structured evidence, never a guess, and a deterministic engine, not the
AI, decides. The deterministic engine writes every word the agent speaks.

Countersign never claims to detect a fake or cloned voice. It proves things
behaviorally: what the caller knows, whether their story stays consistent, and what
independent checks confirm. A fully verified call never releases money. It only stages
the request for a second, independent human to approve. A failed call freezes the
request, opens an incident, and leaves a hash-chained evidence export (each record carries a fingerprint of the one before it, so any edit shows) behind.
<!-- word count: 150; verified via `wc -w` before commit -->

---

## 3. Long description (400 words, one paragraph per judging criterion)

<!-- Judging criteria per docs/BRIEF.md §1: "1. Presentation · 2. Business value ·
     3. Application of technology · 4. Originality." -->

**Presentation.** Countersign is judged live, understood in under three minutes on a
stranger's machine. The screen is a split view: the call on one side, evidence
building card by card on the other, so a judge watches the verdict get earned, not
asserted. A no-microphone replay mode drives the same UI through a recorded call,
needing no mic, no permissions dialog, and no live credits. A live microphone path
sits alongside it.

**Business value.** The scenario is a corporate payment desk. A caller claiming to be
the CEO demands an urgent $1.8 million wire to an escrow account, then raises it to
$2.1 million mid-call, a live inconsistency Countersign catches and shows with the
caller's exact words.
<!-- source: docs/BRIEF.md §4, "Scenario B: THE INTERROGATION" -->
This mirrors CEO-fraud and deepfake wire losses: a human alone under
pressure, no second check. PROVEN by the FBI's 2025 Internet Crime Report (ic3.gov):
Business Email Compromise cost $3,046,598,558 in 2025; $30,256,592 of that came
from BEC complaints that referenced AI.
<!-- source: FBI IC3, "2025 IC3 Annual Report," https://www.ic3.gov/AnnualReport/Reports/2025_IC3Report.pdf,
     page 26 (three-year BEC loss table) and page 42 ("AI References by Complaint Loss"
     table). Re-verified 2026-09-11: the $30,256,592 figure aggregates all AI-referenced BEC
     complaints; the report does not break out voice cloning, so the earlier phrase
     "including voice cloning" was an overreach and is removed. -->
Countersign's rule is structural: "a call can
request a privileged action, it can never authorize one."
<!-- source: docs/BRIEF.md §16, ratified 2026-09-01 language -->
A verified request needs an independent second human before money moves; a
failed one freezes the rail and opens an incident.

**Application of technology.** Countersign runs on the AssemblyAI Voice Agent API: a stored
agent bound per call, with our own LLM endpoint so the deterministic engine writes every word
the agent speaks; single-use server tokens; max-accuracy transcription with the call's
proper nouns as key terms; adaptive turn detection with real barge-in; and AssemblyAI's own
two-voice session recordings, which power the no-microphone replay of real calls. Realtime
primitives, not a chat wrapper.

**Originality.** Countersign is not a deepfake detector, an indefensible claim it never
makes. Instead it verifies behaviorally: what the caller knows, whether their story
stays consistent across turns, and what independent verification checks outside this call confirm, a
layer that holds when a synthetic voice is perfect. A finite-state policy engine, not
the language model, owns every verdict. Its positive ceiling is "stage for second
approval," never "release": neither exists in the system. This is published prior art,
not ours: PROVEN by the APort Vault CTF (a security capture-the-flag contest where attackers try to social-engineer a system), where social
engineering succeeded 74.6 percent against model-only defenses versus 0 percent
against a policy engine, across 879 attempts. What's new is the application: live
interrogation feeding an engine capped at staging for a second human.
<!-- source: README.md "How a verdict is decided": STAGE ceiling, no RELEASE verdict -->
<!-- source: docs/BRIEF.md §13 "Honesty constraint": APort Vault CTF figures cited verbatim -->
<!-- word count, all four paragraphs combined: 399 (was 524), verified 2026-09-25 by a
     script that strips this heading and every HTML comment before running `wc -w`.
     Trimmed to meet this section's 400-word target per founder ruling 2026-09-09:
     hedging, repetition, and adjectives cut first; every PROVEN claim (FBI IC3 figures,
     APort Vault CTF figures) kept intact with its exact numbers. -->

---

## 4. Technologies used

- **AssemblyAI Voice Agent API**: realtime speech-to-text, text-to-speech, and stored agent
  binding, used with a server-supplied custom LLM endpoint so the deterministic engine writes
  every reply; server-created single-use temporary authentication tokens; 24 kHz PCM16 (16-bit mono audio at 24,000 samples per second) mic audio
  via an AudioWorklet; one post-bind `session.update` carrying a per-call token, proper-noun
  `keyterms` and `transcription_mode: max_accuracy`; session recordings and timelines
  downloaded once from the sessions API for the recorded-call replay
  (packages/engine/corpus/recorded-*.json, packages/server/replay-audio/); turn detection and barge-in (detects when the caller interrupts and stops the agent mid-sentence) (`input.speech.started`,
  `reply.done` with `status: 'interrupted'`); bounded reconnect with `session.resume` inside the documented resumable
  window.
  <!-- source: README.md "How Countersign uses the AssemblyAI Voice Agent API" -->
- **TypeScript**: end to end, shared evidence/FSM types across engine, server, and UI.
  <!-- source: CLAUDE.md "Stack (ratified)"; docs/BRIEF.md §14 -->
- **Vite + React**: the split-screen judge UI.
- **Node.js**: the call-handling server (token minting, policy engine re-run, tool
  execution against a mocked backend).
- **Render**: hosting for the live demo (free tier).
  <!-- source: docs/BRIEF.md §12 risk 11 -->

---

## 5. Links

- **Live demo:** https://countersign-bf8q.onrender.com
- **Repository:** [ADD BEFORE SUBMITTING: repo is private during the build, goes
  public at the pre-flip checklist, docs/PREFLIP_CHECKLIST.md]
- **Video:** [ADD BEFORE SUBMITTING: video not yet recorded; target at least 2:20 of
  live agent interaction per gate G6]
  <!-- source: docs/BRIEF.md §10 gate G6; §8 video production plan -->

---

## 6. What to click first (for judges)

1. Open the live demo link above. No signup, no install.
2. Click **Replay** first. No microphone needed. It runs a full recorded interrogation
   through the real decision engine so you see the whole story in under two minutes.
3. Watch the split screen: the call on the left, the evidence record building card by
   card on the right, in step with what's said.
4. Then click **Try it live (experimental)** and use your own microphone.
5. Interrupt the agent mid-sentence. Watch it stop clean and resume calmly, not
   garbled.
6. Change a dollar amount partway through your call. Watch it catch and name the
   inconsistency out loud, live.
