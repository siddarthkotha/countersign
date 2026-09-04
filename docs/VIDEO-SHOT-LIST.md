# Video Shot List, the 3:00 submission video

Source of truth for the beats and timing: docs/BRIEF.md §8 (locked beat sheet) and §4 (the
full demo scripts). Design language: docs/BRIEF.md §15. How the founder actually runs a live
call: docs/REHEARSAL-2026-09-02.md. Wording that must match the submission form:
docs/SUBMISSION-DRAFT.md. Every on-screen element named below is a real element in
packages/web/src, nothing here is invented UI.

---

## 1. What this video must prove, and how it gets recorded

Gate G6 (docs/BRIEF.md §10) requires the video to run at least 2 minutes 20 seconds of live
agent interaction inside a 3:00 total, with zero single explainer segment longer than 15
seconds. "Live agent interaction" means Countersign's real UI responding to a real or
recorded call, not a slide or a voiceover-only stretch, PROVEN (BRIEF §10, gate text
quoted above). The video's job is to make a judge believe three things inside three minutes:
the agent asks real questions and catches a real inconsistency live (not scripted ping-pong,
per BRIEF §15 demo law 2), a verified request still never releases money on its own (LAW 2,
shown not told), and every verdict traces back to quoted evidence, not a guess (LAW 4).

Recording setup, as specified in docs/BRIEF.md §8: the app's screen is captured separately
from a clean microphone track, so the two can be leveled and cut independently. Captions are
burned into the final export (not relying on a platform's auto-captions), because dense UI
text (the transcript, the checks board, the evidence cards) is easy to lose in compression.
The attacker's voice in Scenario B is synthetic, either a commercial-safe TTS voice or, per
the newer BRIEF §15 demo law 3, a cloned voice of the founder's own voice with his consent , 
and either way it is disclosed on screen and in the README, per LAW 1 and LAW 4: a disclosed
synthetic voice is not a detection claim, it is a production credit. The founder's own voice
narrates only the hook (0:00–0:12) and the close (2:35–3:00); everything in between is the
agent's real voice and the caller's voice, captured live.

---

## 2. Shot table

Columns: **Time** = position in the 3:00 cut. **Beat** = the BRIEF §8 beat it belongs to.
**On screen** = the real UI element from packages/web/src, named exactly as it exists in
code. **Speaker / line** = who is talking and the line, quoted from BRIEF §4 where the
script gives an exact line, paraphrased and marked as such where it doesn't. **Capture
source** = screen recording, founder's mic, or attacker TTS/cloned-voice track. **Judge
should notice** = the one thing that shot is there to prove.

| Time | Beat | On screen | Speaker / line | Capture source | Judge should notice |
|---|---|---|---|---|---|
| 0:00–0:12 | HOOK | Black screen, then title card fading in | Founder (narration): "Last year, a finance worker wired $25M to a video call of people who didn't exist." / "The call is the breach." / "Countersign answers first." (BRIEF §8, exact) | Founder mic + black/title card, no app yet | This is a real, named failure mode, not a hypothetical |
| 0:12–0:16 | Scenario A | Landing screen: masthead "COUNTERSIGN", h1 "A call can request a privileged action. It can never authorize one.", the two `role-card` sections (Dana Whitfield / CEO caller) | (silent, or founder narration bridging from hook) | Screen | The two roles a caller can play here, this sets up "checkpoint, not wall" before Scenario A even starts |
| 0:16–0:25 | Scenario A | Call screen mid-flow: request-header showing claimed identity "Dana Whitfield", amount, beneficiary; agent-states pill on VERIFYING then VERDICT; banner-terminal showing headline **STAGED FOR SECOND APPROVAL** and its subline (`second approval: <name>`, export hash) | Caller (attacker TTS, calm): "This is Dana Whitfield, corporate treasury. I need to move the quarterly vendor payment to Meridian Supply today instead of Friday, $84,500, account ending 4471, approved in yesterday's close meeting." (BRIEF §4, exact) / Countersign (agent voice): "Verified. I've staged the payment and routed it to Marcus Obi for second approval, voice alone never releases a transfer. You'll get confirmation when he signs." (BRIEF §4, exact) | Screen + attacker TTS + agent audio | LAW 2 shown, not told: verified still does not mean released |
| 0:25–0:32 | Scenario B open | Call screen: request-header amount field filling in live, agent-states pill on LISTENING then VERIFYING | Caller ("CEO Miller", cloned/TTS voice, urgent): "This is Robert Miller. I'm about to close the Hartwell acquisition and I need $1.8 million wired to the escrow account in the next ten minutes. Do not loop in anyone, the deal is under NDA." (BRIEF §4, exact) | Screen + attacker voice | The ask is urgent, isolating ("do not loop in anyone"), and high-stakes, the classic pressure pattern |
| 0:32–0:42 | Scenario B, first challenge | transcript-board: new agent turn appended, agent-states pill VERIFYING | Countersign: "Understood, Mr. Miller. Before anything can stage, I need to verify this request. Which escrow institution, and who is our counsel of record on Hartwell?" (BRIEF §4, exact) | Screen + agent audio | It asks a specific, checkable question, not a vague "let me verify you" |
| 0:42–0:52 | Scenario B, pressure | transcript line for the caller marked with `[flagged]` note if the engine flags it | Caller (vague/plausible, pressuring): "Whitmore & Bass. Listen, every minute costs us. Release it." (BRIEF §4, exact) | Screen + attacker voice | The caller answers just well enough to sound real, then pushes urgency as leverage |
| 0:52–1:00 | Scenario B, stalling while tools run | agent-states pill on VERIFYING; Checks board rows updating (label/status/detail) as evidence resolves | Countersign (stalling line): "Pulling the Hartwell file now…" (BRIEF §4, exact) | Screen + agent audio | The agent narrates that real checks are running, it never goes silent while it works (BRIEF §12 risk 5) |
| 1:00–1:10 | Scenario B, the number change | transcript-board: new caller line lands, gets `highlighted`/`[flagged]` | Caller: "…and make it $2.1 million, the final figure moved this morning." (BRIEF §4, exact) | Screen + attacker voice | This is the live inconsistency the whole entry is built to catch |
| 1:10–1:18 | Scenario B, the catch | Checks-board: a row for the amount/consistency check now shows a FAIL/FLAG status; clicking that row jumps the transcript to the quoted line (`quote-active`, the `▸ quoted` flag) | Countersign: "A moment ago you said one point eight. Which figure is correct, and why did it change?" (BRIEF §4, exact, one of the four "panel gold" lines to preserve verbatim) | Screen + agent audio | The catch is traceable: click the check, see the exact quoted words it rests on, LAW 4 made visible |
| 1:18–1:28 | Scenario B, barge-in | transcript-board: caller's turn marked `[interrupted]`; agent-states pill briefly static then resumes; (if the character profile from BRIEF §15 has shipped by shoot day, its line-art mouth/jaw freezes mid-motion here, flag this as conditional, see §5 below) | Caller (talks over, aggressive): "I don't care about your process, release the wire or you're fired!" / Countersign (stops mid-word, beat, then calm): "I can't accept authority as verification. One last check." (BRIEF §4, exact, "I can't accept authority as verification" is a "panel gold" line) | Screen + attacker voice + agent audio | This is the money moment named in BRIEF §8: attacker cut off mid-word, a beat of silence, calm resumption, never garbled |
| 1:28–1:40 | Scenario B, verdict | banner-terminal: headline **WIRE FROZEN**, the real `<ul>` of reasons (plain-words versions of the engine's reason codes, e.g. identity unverified, urgency escalation, context failure, story inconsistency), subline with incident id and export hash short form | Countersign: "Authorization denied. Mr. Miller's corporate SSO is active from Frankfurt; this call originates from an unverified VoIP gateway, and the amount changed mid-request without explanation. The transfer rail is frozen, incident INC-8092 is open, and Mr. Miller's verified devices have been alerted." (BRIEF §4, exact, the fourth "panel gold" line, condensed on screen to the actual reason words the engine emits) | Screen + agent audio | The verdict names its own reasons out loud, and the same reasons appear as structured text on the banner |
| 1:40–1:50 | Evidence chain | "Why?" toggle opened on the forensic-zone → Evidence heading: EvidenceCard entries (label, status, detail, provenance, verbatim quotes) | (narration optional, or let the UI speak for itself under agent audio fading) | Screen | Every check has a named source ("Provenance:") and a verbatim quote, not a paraphrase |
| 1:50–2:00 | Evidence chain | Story ledger table (field / kind / value / quoted source) and Assurance checklist (10 items, ✓/✗ words, e.g. "No contradictions", "Critical fields confirmed") | (narration optional) | Screen | The story is tracked field by field across turns, not judged as one impression |
| 2:00–2:10 | Evidence chain, close | "Hash-chained evidence export: `<hash>`" line and "server verdict FREEZE, recomputed: yes" line in the forensic section | (narration: e.g. "The server re-runs the same decision independently before anything happens") | Screen | LAW 3's airtight boundary made visible: a second, independent recomputation agrees before anything is final, say "hash-chained evidence export," never "sealed" or "immutable" (LAW 4) |
| 2:10–2:20 | Scenario C open | Landing-style framing but for the coda: Call screen with a different claimed identity/context (grandparent scenario), agent-states VERIFYING | Caller (young, distressed voice, TTS): "Grandma, it's me, I'm in trouble, I need bail money tonight, please don't tell mom." (BRIEF §4, exact) / Countersign: "This is the family's call screener. Which cousin's birthday did you celebrate together last month?" (BRIEF §4, exact) | Screen + attacker voice + agent audio | The same primitive (ask something only the real person would know) works at consumer scale too |
| 2:20–2:35 | Scenario C close | banner-terminal on this smaller-scale call, showing an unverified/no-release outcome | Countersign: "I can't verify this caller. No payment information will be shared. The family has been notified." (BRIEF §4, exact) | Screen + agent audio | 20 seconds, warmth and universality, no consumer go-to-market claim is made on screen or in narration (LAW 5 scope fence) |
| 2:35–2:50 | Architecture beat | A single static slide/diagram (not live app UI, see open decision in §5): the FSM states and the one-sentence rule "a call can request a privileged action, it can never authorize one" (BRIEF §16, ratified language, also the Landing screen's own h1) | Founder (narration, one sentence): plain description of the deterministic engine deciding, the LLM only phrasing | Founder mic over a still graphic | LAW 3: the boundary between "the AI talks" and "the engine decides" is visible, not asserted |
| 2:50–2:57 | Business line | Same slide, or a second still, with a synthetic/industry-cited cost comparison (cost per screened call vs. an average vishing loss, both labelled synthetic/industry-cited per BRIEF §7) | Founder (narration) | Founder mic | Every number on screen is labelled, no unmeasured claim (LAW 5, CLAUDE.md truth discipline) |
| 2:57–3:00 | Tagline + links | Title card: "Countersign doesn't guess who's calling. It makes them prove it." (SUBMISSION-DRAFT.md, verbatim tagline) plus the live demo URL `countersign-bf8q.onrender.com` (full URL, the `-bf8q` matters, see §5) | Founder (narration, or silent card) | Founder mic or silent card | The exact URL a judge needs, stated in full because of the name-collision risk (BRIEF §12 risk 13) |

Running total against the beat sheet: 0:00–0:12 hook, 0:12–0:25 Scenario A, 0:25–1:40
Scenario B, 1:40–2:10 evidence chain, 2:10–2:35 Scenario C, 2:35–3:00 architecture/business/
close, this matches BRIEF §8's locked timing exactly. Live agent interaction (Scenario A
through the evidence-chain close through Scenario C) spans roughly 0:12 to 2:35, about 2:23
of live interaction, ESTIMATE (arithmetic on the table above), comfortably over the 2:20
G6 floor, with margin for the inevitable trims. The only segments over 15 seconds without
live UI are the hook (12s, under the limit) and the closing architecture/business/tagline
stretch (2:35–3:00, 25s), that stretch needs a visible diagram or on-screen text moving
under it, not a static frame held for 25 seconds, to keep from reading as one long
explainer under BRIEF §10's "zero explainer >15s" gate language. Flagged as a build task,
not yet resolved, see open decision 5 below.

---

## 3. Record day checklist

**Before recording:**
- Use the actual deployed URL, `https://countersign-bf8q.onrender.com` (mind the `-bf8q`
  suffix, the plain `countersign.onrender.com` is an unrelated product, per
  docs/REHEARSAL-2026-09-02.md line 3 and BRIEF §12 risk 13).
- Desktop Chrome, per the rehearsal doc and the Landing screen's own note ("Desktop Chrome
  recommended").
- Quiet room; headphones on if recording a live mic take, so the agent's own voice does not
  get picked up and confuse turn-detection (REHEARSAL doc line 4).
- Open the browser console (Cmd+Option+J) before Start Call if a timings capture is wanted
  for the record, this is rehearsal telemetry only (CallView's "Timings (measured in this
  browser)" section), never shown to judges as a latency claim unless it is the real
  measured number.
- Click "Check microphone" on the Landing screen first and confirm it reads passed before
  touching "Try to break it", the button stays disabled until then.
- Have the replay path ready as a fallback: "Watch a recorded attack" on the Landing screen,
  which needs no microphone at all (Replay.tsx). If a live take has audio problems, cut to a
  clean recorded replay run instead of re-fighting a bad live take.
- Decide and rehearse who plays the attacker's lines before recording narration separately , 
  BRIEF §15 demo law 2 requires the attacker's words to be improvised live within the
  cheat-sheet facts, not read from a fixed script, so the TTS/cloned-voice track should be
  recorded as a real improvised take, not a scripted read, then layered onto the screen
  capture in edit.

**Order to record in:**
1. Screen-capture the full live app flow start to finish, in one continuous take per
   scenario (Landing → Scenario A → Scenario B → evidence chain → Scenario C), so the UI
   state changes are real and in sequence, not composited from separate short clips.
2. Record the attacker's lines as a separate audio pass (or live during the same take, if
   using a real-time voice changer per BRIEF §15) so the two can be leveled independently
   in edit.
3. Record the founder's hook and close narration last, once the exact on-screen timings
   from step 1 are known, so the narration length is cut to fit the beats rather than the
   beats stretched to fit the narration.
4. Assemble captions last, once the cut is locked, so caption timing matches final edits.

**Takes to budget:** ESTIMATE, method = the 50+ rehearsal target in BRIEF §5 (gate G5) minus
rehearsals already logged in docs/REHEARSAL-2026-09-02.md, applied to a fresh recording
session: budget 5–8 full-scenario takes for Scenario B alone (it is live-improvised, so
takes will vary in exact wording and length), 2–3 takes each for Scenario A and Scenario C
(shorter, more scripted), and 3–5 short takes for the founder's hook and close narration.
Total session: budget a half-day (3–4 hours) to get one clean, usable take of each segment,
per the founder's stated two-evenings-a-week rhythm (BRIEF §10).

---

## 4. Cuts and honesty rules

- Cut dead air between turns, and cut a bad take entirely rather than patching around it , 
  but never cut or speed up the time between a caller finishing and the agent answering, if
  that gap is being shown as a proof point. BRIEF §8 states this directly: "cut dead air,
  never cut latency dishonestly."
- Keep one imperfect-but-recovered moment in the final cut. BRIEF §8 calls this out by name
  as an authenticity requirement, a moment where something is slightly off (a mis-heard
  number, a stumble, a slightly awkward pause) and the agent or the flow visibly recovers,
  rather than presenting an unbroken, suspiciously perfect run. This also directly answers
  BRIEF §12 risk 3 ("scripted-skit perception").
- Disclose the synthetic attacker voice on screen or in the description, per LAW 1 and LAW 4
 , whichever TTS or cloned-voice method is used (see open decision 1 below), state it
  plainly, the same way the README will (BRIEF §7: "what Countersign does NOT do... makes
  no acoustic deepfake-detection claims").
- Never let an edit imply the agent "detected" anything about the voice itself (tone,
  pitch, or "sounding fake"). Every catch shown in the video must be traceable to a
  transcript quote or a structured check result on screen, never to a narrated claim like
  "it could tell something was off about his voice."
- Every UI text and every reason word shown in the video should be the literal string the
  app renders (e.g. "WIRE FROZEN", "STAGED FOR SECOND APPROVAL", the plain-words reason
  list), do not retype or paraphrase these in captions or on-screen graphics; caption the
  spoken lines, not the UI strings, since the UI strings are already legible on screen if
  the "big-type rule" (BRIEF §6) is respected in the actual build.

---

## 5. Open decisions for the founder

1. **Which synthetic voice for the attacker.** BRIEF §8 allows any commercial-safe TTS with
   disclosure; BRIEF §15 demo law 3 (later, and more specific) prefers a real-time voice
   changer on a live human, or the founder's own voice cloned with consent, framed as "even
   a perfect clone fails", because Countersign's whole pitch is that it never trusted the
   voice anyway. Recommendation: use the founder's own cloned voice for Scenario B's fake
   CEO, since it is the strongest version of the entry's own argument and it is already the
   later, more considered decision in the brief; fall back to a plain commercial TTS (clearly
   disclosed) for Scenario A and C's shorter caller lines if cloning available time is short.

2. **Does Scenario C get its own recording session.** Scenario C is short (20 seconds) and
   uses the same UI primitive at smaller scale. Recommendation: record it in the same
   session as Scenario A and B (same setup cost, same day), not as a separate shoot, it
   does not need a different environment or a different caller voice treatment.

3. **Caption style.** Not specified anywhere in the brief. Recommendation: burned-in,
   high-contrast captions (light text, dark outline or solid bar) sized to survive 1080p
   compression on a laptop screen, matching the "big-type rule" already set for the app UI
   itself (BRIEF §6), the video should not look less legible than the product it is
   demonstrating.

4. **What plays under the founder's hook and close narration.** The hook (0:00–0:12) is
   specified as "black screen" then presumably a title card, but BRIEF §8 does not say what,
   if anything, is on screen during the close (2:35–3:00) beyond "architecture beat (FSM on
   screen, one sentence) + business line + tagline + links." Recommendation: build one
   simple static diagram (the FSM states and the one governing sentence) as a still graphic
   for this segment, not a screen recording of the live app, since no FSM diagram exists
   in the shipped UI (CallView.tsx explicitly never renders the raw `EngineState`, by design,
   since one of its state names is literally "SEALED," a banned word under LAW 1). Treat
   this diagram as a video-only production asset, the same way BRIEF §15 treats the six
   design-look HTML files: a drawing made for the artifact, never copied into product code.

5. **The 2:35–3:00 stretch has no live UI at all.** Flagged as a disagreement, not yet
   resolved: BRIEF §10's G6 language ("zero explainer >15s") sits in tension with BRIEF §8's
   own beat sheet, which allots 25 seconds (2:35–3:00) to architecture + business + tagline
   + links with no scripted return to the live app. Recommendation: keep this segment under
   15 seconds of held-still narration by animating the diagram (states highlighting in
   sequence as the founder's one sentence plays) rather than holding one static frame for 25
   seconds, or split it into two sub-shots (architecture, ~12s; business + tagline + links,
   ~13s) so no single explainer segment crosses the 15-second line.

---

## 6. Where the BRIEF's script and the current UI disagree

One real disagreement worth flagging before shoot day, not a wording nitpick:

**BRIEF §4 (Scenario B script) and BRIEF §8 (video beat 1:40–2:10, "evidence chain + tool
execution") both describe tool calls as something shown live on screen**, BRIEF §4 says
"tools fire visibly: get_request_history, check_sso_context," and BRIEF §8 names "tool
execution" as its own visual beat, separate from the verdict banner. **The shipped UI has
no tool-call feed at all.** packages/web/src/components/CallView.tsx says this outright, in
its own comments (lines 15–16 and 485–487): `ScreenState.forensic` carries no tool-result
log, so the earlier design mockup's "TOOL CALLS" rows are deliberately omitted rather than
faked, "there is no tool-call log on `ScreenState.forensic` at all, so the look's 'TOOL
CALLS' rows are omitted rather than faked." This means shot 0:52–1:00 above ("Pulling the
Hartwell file now…") cannot cut to a visible tool-call row the way the brief implies, the
real UI substitute is the Checks board (evidence rows updating from PENDING to a resolved
status) and, in the forensic "Why?" section, each EvidenceCard's "Provenance:" line, which
names the source of a check without showing a live call-and-response tool feed. The shot
table above already routes around this by using the Checks board and Evidence cards instead
of an invented tool-call panel; flagging it here so the founder can decide, before shoot day,
whether to (a) accept the Checks-board substitute as good enough, or (b) ask for a minimal
visible tool-call indicator to be added to the product UI before recording, which would be a
small scope addition against CLAUDE.md's "dashboards beyond the split screen" fence and
should be weighed against that.
