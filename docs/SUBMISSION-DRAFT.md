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
AI, decides. The AI asks the questions.

Countersign never claims to detect a fake or cloned voice. It proves things
behaviorally: what the caller knows, whether their story stays consistent, and what
independent checks confirm. A fully verified call never releases money. It only stages
the request for a second, independent human to approve. A failed call freezes the
request, opens an incident, and leaves a hash-chained evidence export behind.
<!-- word count: 150; verified via `wc -w` before commit -->

---

## 3. Long description (400 words, one paragraph per judging criterion)

<!-- Judging criteria per docs/BRIEF.md §1: "1. Presentation · 2. Business value ·
     3. Application of technology · 4. Originality." -->

**Presentation.** Countersign is judged live and built to be understood in under three
minutes on a stranger's machine. The screen is a split view: the live call on one
side, evidence building card by card on the other, so a judge watches the verdict get
earned, not asserted. A no-microphone replay mode drives the same UI through a
recorded call end to end, so the demo needs no mic, no permissions dialog, and no live
credits in play. A live microphone path sits next to it for anyone who wants to talk
past it.

**Business value.** The scenario is a corporate payment desk. A caller claiming to be
the CEO demands an urgent $1.8 million wire to an escrow account, then raises it to
$2.1 million mid-call with no explanation, a live inconsistency Countersign catches and
names aloud, not scripted.
<!-- source: docs/BRIEF.md §4, "Scenario B: THE INTERROGATION" -->
This is the failure mode behind real CEO-fraud and deepfake wire losses: a human
alone, under pressure, with no second check. Countersign's rule is structural, not
optional: "a call can request a privileged action, it can never authorize one."
<!-- source: docs/BRIEF.md §16, ratified 2026-09-01 language -->
A verified request still needs an independent second human before money moves, and a
failed one freezes the rail and opens an incident.

**Application of technology.** Countersign uses the AssemblyAI Voice Agent API
throughout: server-minted, single-use tokens, so the browser never touches the API key
or socket directly; 24 kHz PCM16 mic audio streamed through an AudioWorklet; a
session.update sent at connect and again on every goal change, so voice, tools, and
keyterms shift with the conversation; keyterms that grow live with every name and
dollar amount the caller says; real turn-detection barge-in, where an interruption is
caught and playback flushes client-side within a frame; and tool results returned on
AssemblyAI's exact reply.done timing, never early, never late. This is not a chatbot
wrapped around a microphone; it is built around the realtime primitives themselves.

**Originality.** Countersign is not a deepfake detector. That claim is technically
indefensible on any voice stack, and it never makes it. Instead it verifies
behaviorally: what the caller knows, whether their story stays consistent across
turns, and what independent, out-of-band checks confirm, a layer that holds when a
synthetic voice is perfect. A finite-state policy engine, not the language model, owns
every verdict. The engine's positive ceiling is "stage for second approval," never
"release": that verdict and that tool do not exist in the system.
<!-- source: README.md "How a verdict is decided": STAGE ceiling, no RELEASE verdict -->
<!-- word count: 399 (labels included); verified via `wc -w` before commit -->

---

## 4. Technologies used

- **AssemblyAI Voice Agent API**: realtime speech-to-text, text-to-speech, and tool
  calling, used for server-minted single-use ephemeral tokens; 24 kHz PCM16 mic audio
  via an AudioWorklet; `session.update` at connect and on every goal change; growing
  `keyterms` boosted per call; turn detection and barge-in (`input.speech.started`,
  `reply.done` with `status: 'interrupted'`); `tool.result` returned on `reply.done`
  timing; bounded reconnect with `session.resume` inside the documented resumable
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
4. Then click **Try to break it** and use your own microphone.
5. Interrupt the agent mid-sentence. Watch it stop clean and resume calmly, not
   garbled.
6. Change a dollar amount partway through your call. Watch it catch and name the
   inconsistency out loud, live.
