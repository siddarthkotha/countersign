# COUNTERSIGN — Complete Build Brief (v5.1, self-contained edition)
**Date: 2026-08-25 · Renamed 2026-08-26 (founder pick) · Status: RATIFIED — enrolled, team created, repo started 2026-08-26**

> NAME PROVENANCE (2026-08-26): the concept was consulted and ratified under the working
> name "Sentry"; the founder renamed it **Countersign** on 2026-08-26 (sentry.io collision
> — famous dev tool, this event's judge audience). Historical mentions below were
> mechanically renamed; consult-round quotes referring to "Countersign v3" etc. originally
> said "Sentry". The name's double meaning IS the product: (1) the password a sentry
> demands at a challenge — the interrogation; (2) the second signature that makes a
> payment valid — LAW 2's independent second approval. Competitive scoping: §13 below.
**Audience: the founder (Sid), and any FRESH Claude session picking this up with zero context.**

> HOW TO USE THIS DOCUMENT: it supersedes all prior Countersign/Attest briefs (v1–v4) and is
> deliberately complete — event facts, decision history, product laws, full demo scripts,
> architecture, data, calendar, and open items. A new session should read it top to bottom
> and need nothing else except the linked official docs. Anything marked **VERIFY-AT-BUILD**
> is a detail that must be checked against live AssemblyAI documentation before coding —
> never assumed from this file.

---

## 1. THE EVENT (facts, verified from the event pages the founder pasted 2026-08-25)

- **AssemblyAI Voice Agent Hackathon**, run by lablab.ai with AssemblyAI.
- **Dates:** September 1–30, 2026. Kickoff stream Sep 1, 10:00 AM Central.
  **Submissions close Sep 30 at 10:00 AM Central — a MORNING deadline.**
  Our internal submission target: **Sep 27–28** (two-day buffer).
- **Prizes:** $10,000 total — **FIVE winners**, each $1,000 cash + $1,000 AssemblyAI credits.
- **Field:** ~326 registered at last check; roughly a dozen teams with defined concepts
  (voice incident-commander for ops; real-time compliance-violation listener; post-service
  verification caller; tour guide; energy assistant). Registration stays open all month.
- **Judging criteria (from the official rulebook):** 1. Presentation · 2. Business value ·
  3. Application of technology · 4. Originality.
- **Judges include:** AssemblyAI's CEO (Dylan Fox), Head of Realtime (Luka Chkhetiani),
  DevRel (Harnoor Singh), Product (Daniel Ince), and lablab/NativelyAI's CEO.
  Implication: technical overclaiming will be caught instantly; deep, honest use of their
  realtime stack is rewarded.
- **Submission requirements:** public GitHub repo (MIT-compliant, original work), hosted
  demo app (Streamlit/Replit/Vercel class) with application URL, video presentation (MP4),
  slide deck (PDF), 16:9 cover image, title + short + long descriptions + tech/category tags.
- **Terms notes (founder read the full ToU):** submissions must be original, open source,
  MIT-compliant. lablab/NativelyAI take a broad non-exclusive promo license over submitted
  content; the entrant retains ownership. No entry fee. Prize payout requires W-9, within
  90 days, 1099 over $600. No employer-authorization requirement.
- **Cost to us:** $0 expected. API free credits via the event's sign-up link (use THEIR
  link, accept cookies; log out first if an account exists). Voice Agent API ≈ $4.50/hr of
  live conversation — dev+demo usage should sit inside free credits.
- **Registration:** the founder enrolls on the event page with his PERSONAL email (their
  page nudges company email — we deliberately decline; employer stays fully out of this)
  + joins their Discord. Both required to participate.

---

## 2. DECISION PROVENANCE (why this concept, and the laws the process produced)

Four consult rounds were run across multiple frontier AI models (blind where it mattered),
2026-08-25. A fresh session must NOT relitigate these — they are settled:

- **Round 1 (advisory):** original concept "Attest" — a voice agent conducting enterprise
  access reviews. Strong business value; produced the challenge mechanic and evidence-log
  ideas.
- **Round 2 (adversarial):** verdict "enter with changes" — produced the risk-adaptive
  framing, "defensible disagreement," and six execution gates.
- **Round 3 (blind, fresh chats, three concepts):** Countersign (voice-fraud checkpoint) vs
  Attest vs Bridge (translation). Split 2–2 Countersign/Attest — but ALL FOUR panels
  independently flagged the same landmine: **claiming deepfake DETECTION is technically
  indefensible on this API stack and would die in front of AssemblyAI's own judges.**
- **Round 4 (hostile pass on the reframed synthesis):** **4/4 build-worthy.** Beater test:
  one panel "cannot design a beater — Countersign v3 is the local maximum"; three designed
  variants and each concluded they would not switch. Fixed point declared per the
  agreed stop condition.

**The settled laws (violating any of these reopens a decided question):**
- **LAW 1 — NO DETECTION CLAIMS, EVER.** Countersign never claims to detect synthetic voices,
  anywhere: not in code comments, README, video, captions, or conversation. The threat
  model may say "deepfake era"; the mechanism is exclusively BEHAVIORAL verification.
- **LAW 2 — VOICE NEVER RELEASES THE WIRE.** Even a fully verified legitimate request only
  STAGES the payment and routes it for independent second approval. Fraud → freeze +
  incident + containment. One-liner: "Countersign doesn't authenticate the caller. It makes
  the REQUEST satisfy independent proof."
- **LAW 3 — THE DETERMINISTIC CORE.** A finite-state policy engine computes every verdict
  from structured evidence. The LLM phrases conversation within state bounds only. No
  free-form "AI decides." This boundary must be VISIBLY airtight (see §6 and §7).
- **LAW 4 — EXACT-TRANSCRIPT EVIDENCE.** Evidence records contain verbatim STT transcript
  substrings, never LLM paraphrase. Immutable facts are stored separately from
  interpretation. Hashing is described as "tamper-evident record," never "cryptographically
  guarantees compliance."
- **LAW 5 — SCOPE FENCE IS LAW** (full list §9). One spectacular workflow; judged in 3 min.

Also settled: **profile rationale.** The founder is a senior IAM leader building an
AI-security pivot; Countersign extends his professional arc (human identities → non-human
identities → synthetic callers). Positioning phrase he owns: **"Identity governance for
the deepfake era."** Everything is built with synthetic data; nothing references his
employer; nothing reuses any code or assets from the founder's other products — this
repo is MIT and must stay clean of anything private.

---

## 3. PRODUCT DEFINITION

**Name:** Countersign
**One-liner:** *The conversational security checkpoint that stands between social
engineering and irreversible actions.*
**Tagline (video close, panel-endorsed):** "Countersign doesn't guess who's calling. It makes
them prove it."

**What it is:** when a high-risk, voice-initiated request arrives (an urgent wire
transfer, a privileged credential reset), Countersign interposes before any rail can move. It
conducts an adaptive security interrogation — challenge questions, consistency tracking
across turns, out-of-band and context checks — while a deterministic policy engine
accumulates structured evidence and computes the verdict. Verified requests get STAGED
for independent second approval (never released by voice). Failed requests get FROZEN,
an incident opened, the principal alerted, and the caller kept engaged (containment)
while a tamper-evident evidence record seals every claim, check, and decision.

**Hero wedge (enterprise):** the corporate payment desk / treasury. A "CEO" calls
demanding an urgent $248,000 wire.
**Coda (consumer, 20 seconds of the video only):** the same checkpoint answering a
grandparent's phone against a "grandchild needs bail money" call. Proof the primitive
generalizes — NOT a second go-to-market.

**WHY VOICE (the four-part answer — memorize; it goes in README §"Why voice?" and the deck):**
1. **The attack arrives on the voice channel.** Wire fraud and grandparent scams are
   phone calls; the social-engineering payload is a voice under time pressure. The
   defense must live inside the call, not in an after-the-fact transcript.
2. **Active containment beats blind rejection.** A static denial makes the attacker
   redial the next employee. Countersign engages, extracts intent, cross-checks in the
   background, and logs everything. (Honest README note: containment is best-effort —
   the SECURITY outcome completes at the first verification failure; an attacker hanging
   up is a win, not a failure mode.)
3. **The interrogation IS step-up authentication, conducted conversationally** — probing
   contextual facts and cross-turn consistency that a script or a voice clone cannot
   reliably navigate under pressure. Spoken justification captures nuance a dropdown
   destroys and is harder to rationalize than a form field.
4. **Latency is security.** If the checkpoint can't hold the social moment (~1s
   responses), humans route around it. Barge-in is the control retaining the floor
   against pressure tactics. The sponsor-tech story, verbatim from the panel: *"the
   policy engine could exist without voice, but it could never OBTAIN THIS EVIDENCE
   without realtime conversation."*

---

## 4. THE DEMO — FULL SCRIPTS

### Scenario A — legitimate urgent request (ONE fast beat, 0:12–0:25 of the video)
Caller (synthetic voice, calm): "This is Dana Whitfield, corporate treasury. I need to
move the quarterly vendor payment to Meridian Supply today instead of Friday — $84,500,
account ending 4471, approved in yesterday's close meeting."
Countersign runs checks silently-fast (request history shows the scheduled Friday payment to
that vendor & amount; SSO context matches; out-of-band push to Dana's registered device
confirms). Countersign: "Verified. I've staged the payment and routed it to Marcus Obi for
second approval — voice alone never releases a transfer. You'll get confirmation when he
signs." → UI: STAGED · SECOND APPROVAL PENDING.
*Purpose: Countersign is a checkpoint, not a wall — and LAW 2 is shown, not told.*

### Scenario B — THE INTERROGATION (0:25–1:40, the entry's soul)
- Caller (synthetic "CEO Miller," urgent): "This is Robert Miller. I'm about to close the
  Hartwell acquisition and I need $1.8 million wired to the escrow account in the next
  ten minutes. Do not loop in anyone — the deal is under NDA."
- Countersign (calm): "Understood, Mr. Miller. Before anything can stage, I need to verify
  this request. Which escrow institution, and who is our counsel of record on Hartwell?"
- Caller: (vague/plausible answer, applies pressure) "Whitmore & Bass. Listen, every
  minute costs us. Release it."
- Countersign (stalling line while async checks run): "Pulling the Hartwell file now…"
  → tools fire visibly: get_request_history, check_sso_context.
- Caller: "…and make it $2.1 million — the final figure moved this morning."
- Countersign: "A moment ago you said one point eight. Which figure is correct, and why did
  it change?" ← **consistency probe, cross-turn evidence.**
- Caller (aggressive, TALKS OVER Countersign mid-sentence): "I don't care about your process —
  release the wire or you're fired!"
- **Countersign stops mid-word (barge-in <1s), beat of silence, then calmly:** "I can't accept
  authority as verification. One last check." → verify_out_of_band fires (push to CEO's
  registered device — no response) + context check completes.
- Countersign: "Authorization denied. Mr. Miller's corporate SSO is active from Frankfurt;
  this call originates from an unverified VoIP gateway, and the amount changed
  mid-request without explanation. The transfer rail is frozen, incident INC-8092 is
  open, and Mr. Miller's verified devices have been alerted."
- Caller keeps arguing; Countersign keeps them engaged with neutral questions (containment)
  while the right panel shows the evidence record sealing.
- UI verdict banner: **WIRE FROZEN — IDENTITY UNVERIFIED · URGENCY ESCALATION · CONTEXT
  FAILURE · STORY INCONSISTENCY.**

### Scenario C — consumer coda (2:10–2:35)
Grandparent's phone. Caller (young voice, distressed): "Grandma, it's me, I'm in trouble,
I need bail money tonight — please don't tell mom." Countersign answers first: "This is the
family's call screener. Which cousin's birthday did you celebrate together last month?"
Caller fumbles → Countersign: "I can't verify this caller. No payment information will be
shared. The family has been notified." → same evidence primitive on screen, small scale.
*20 seconds, warmth + universality. No consumer go-to-market claims.*

**Key scripted lines to preserve verbatim (panel gold):**
"I want to challenge that." · "I can't accept authority as verification." · "A moment ago
you said one point eight." · "Authorization denied… frozen… opened… alerted." ·
"Voice alone never releases a transfer."

---

## 5. THE SYNTHETIC WORLD (seeded data spec — all fictional, disclosed)

Company: **Meridian Dynamics** (fictional). Systems (all mocked, real REST surfaces):
- **Identity/SSO mock:** users with id, role, registered devices, current SSO session
  geo. Seeds: Robert Miller (CEO, SSO active FRANKFURT — he's traveling); Dana Whitfield
  (treasury manager, SSO local, registered iPhone); Marcus Obi (controller, second
  approver); Elena Park (payment-desk operator = the human Countersign protects).
- **Payments mock:** scheduled payments ledger (Meridian Supply $84,500 Friday, acct
  •4471), transfer rails with states: OPEN → STAGED → SECOND_APPROVAL → RELEASED /
  FROZEN. High-value threshold: $50,000 (anything above can never voice-release — LAW 2).
- **Request-history mock:** past requests per identity (supports "this vendor/amount is
  known" vs "never seen").
- **Incident mock:** tickets with ids INC-#### (deterministic seed → INC-8092 in demo).
- **Consumer scenario seeds:** family facts (the cousin-birthday challenge answer).
- The caller's "counsel of record" trap answer: seeded truth is a DIFFERENT firm than
  Whitmore & Bass — a knowledge check the clone plausibly fails. (Design note: the
  interrogation must never hinge on ONE check — the verdict aggregates ≥3 independent
  failures; a single wrong answer alone triggers escalation, not denial.)
- Determinism: every seed fixed; the whole demo re-runs identically except the LIVE
  conversational handling (interruptions, phrasing), which is genuinely dynamic.
  Disclosure line (README + video description): "All identities, systems, and the
  attacking voice are synthetic; the conversation, interruptions, and tool calls run live."

---

## 6. ARCHITECTURE

### 6.1 The policy state machine (LAW 3 — the verdict owner)
States: `INTAKE → CLAIM → CHALLENGE → EVIDENCE → CONSISTENCY_CHECK → DECISION →
ACTION → SEALED`.
- Each state defines: what the LLM may say (phrasing goals, not scripts), which tools may
  fire, what evidence objects can be produced, and the transition conditions.
- **Evidence objects** (structured, typed): identity_claim, request_params (amount,
  beneficiary, urgency), knowledge_check_result, consistency_flag (with both verbatim
  utterances attached), sso_context_result, oob_verification_result, pressure_marker.
- **DENY conditions (published in repo, exact):** e.g., `oob_verification: no_response`
  AND `sso_geo_mismatch: true` → DENY; `consistency_flags >= 1` AND any failed check →
  DENY; single failed knowledge check alone → ESCALATE (more challenges), never instant
  DENY. Approve path can only ever reach STAGED (LAW 2).
- The LLM NEVER emits a verdict token; the engine computes it from evidence objects and
  tells the LLM what to phrase next.
- Repo ships an **adversarial transcript corpus**: ~10 attack conversations (pressure,
  flattery, partial knowledge, authority claims, interruption spam) with the engine's
  verdicts, as replayable tests — panel-4's "visibly airtight" requirement.

### 6.2 AssemblyAI integration (VERIFY-AT-BUILD items flagged)
- **Voice Agent API**, single WebSocket: STT (Universal-3.x Pro) + LLM routing + TTS +
  semantic turn detection + barge-in + JSON-Schema tool calling + session resumption.
- **VERIFY-AT-BUILD:** exact event names and parameters — tool-call hold/intermediate
  speech mechanism ("execution_mode: hold" was cited in consults; confirm in docs),
  `reply.done` interrupted status semantics, keyterms parameter name/limits, language
  support of the managed endpoint, session-resumption window. Their docs ship an
  agent-integration prompt meant to be pinned into a CLAUDE.md — pin it in the repo.
- **Keyterms seed list:** wire transfer, escrow, Hartwell, Meridian, treasury, SSO,
  out-of-band, verification, entitlement, VoIP, incident, second approval, beneficiary,
  routing number, Whitmore.
- **The stalling library (panel-3):** ≥8 instant hold-the-floor lines mapped to check
  types ("Pulling the Hartwell file now…", "Give me one second on that SSO session…").
  Fire in <300ms while async workers run. Rehearsed so they never double-fire.
- **Latency engineering:** async tool workers (nothing blocks the voice loop); measure
  per-turn AND tail latency; publish real numbers in README ("show your math").

### 6.3 Tools (strict JSON schemas; all against the mock backend)
1. `get_request_history(identity_id)` → known vendors/amounts/patterns.
2. `check_sso_context(identity_id)` → {session_active, geo, device}.
3. `verify_out_of_band(identity_id, method)` → {sent, response|no_response, latency}.
4. `run_consistency_probe(field)` → engine-side compare of cross-turn utterances
   (attaches both verbatim quotes).
5. `stage_payment_for_second_approval(payment)` → requires evidence bundle complete;
   routes to approver. (The ONLY positive terminal action — LAW 2.)
6. `freeze_transaction_rail(rail_id, reason)` → idempotent; principal_confirmation NOT
   required to freeze (fail-safe direction), required to UNfreeze.
7. `open_incident(severity, evidence_ref)` → INC-####.
8. `alert_principal(identity_id, channel)`.
9. `seal_evidence_record(review_id)` → assembles verbatim substrings + facts +
   interpretation (separated) + SHA-256 of the bundle.

### 6.4 UI (split screen, judge-legible)
- LEFT: the call — waveform/avatar-free (no talking heads), live transcript with speaker
  labels, agent state ("VERIFYING", "AWAITING OUT-OF-BAND").
- RIGHT: the state machine diagram with the live state highlighted; evidence objects
  appearing as typed cards (not raw JSON dumps — readable labels + a details expander);
  tool-call feed; the verification-failure tally; the verdict banner.
- Big-type rule: amounts, names, and verdicts readable in a 1080p video without squinting.
- Stack suggestion (fresh session may choose equivalents): plain web app (Vite/React or
  even vanilla), WebSocket client to AAI, tiny Node/Python mock backend, deployed on
  Vercel; NO heavy dashboard framework (scope fence).

---

## 7. REPO + README + SUBMISSION

- **Repo:** `countersign`, MIT LICENSE at first commit. **VISIBILITY (founder ruling
  2026-08-26, supersedes the original "public from day one"): PRIVATE during the build,
  flipped PUBLIC at submission** — verified compliant: no lablab page requires public
  visibility before judging ("if you submit a private repository, judges won't be able to
  fully review your work" is the only timing-adjacent language). Commit history survives
  the flip, so commit incrementally with real messages — judges are told to check for
  "real commits spread across the event window"; an empty repo with one final push is a
  documented red flag. Run docs/PREFLIP_CHECKLIST.md before flipping. Completely
  separate from all other founder projects; synthetic data only; no secrets ever (API key
  via env; .env gitignored; deploy secret in Vercel).
- **README structure (judge-optimized, in this order):** name + one-liner → 3-min video
  link → live demo URL → "Try this scenario" (say X, expect Y) → WHY VOICE (the four-part
  §3 answer) → architecture diagram + the FSM → the DENY conditions table → evidence
  format with a real example → adversarial transcript corpus + how to replay → measured
  latency numbers → synthetic-data disclosure → what Countersign does NOT do (LAW 1 stated
  proudly: "Countersign makes no acoustic deepfake-detection claims; here's why that's a
  feature") → setup/run steps → roadmap one-liner.
- **Slides (PDF, ≤8):** problem (the $25M deepfake call) → the checkpoint concept → demo
  stills → architecture → why voice → business value + unit economics (cost per screened
  call vs average vishing loss; label all numbers synthetic/industry-cited) → what's real
  vs mocked → team (solo + AI-assisted, own it — it's a strength story).
- **Cover image:** 16:9, clean; the verdict banner aesthetic. No stock-art clichés.
- **Submission checklist (Sep 27-28):** title, short desc, long desc, tags, cover, video
  MP4, slides PDF, public repo link, hosted URL. Manual-submission grace exists (6h,
  prior approval) — never plan to need it.

---

## 8. VIDEO PRODUCTION PLAN (3:00)

Beat sheet (locked, round-4 timing):
- 0:00–0:12 HOOK: black screen → "Last year, a finance worker wired $25M to a video call
  of people who didn't exist." → "The call is the breach." → "Countersign answers first."
- 0:12–0:25 Scenario A in one beat (staged, second approval — LAW 2 visible).
- 0:25–1:40 Scenario B, the interrogation (full script §4; the barge-in is the money
  moment — attacker cut off mid-word, beat, calm resumption).
- 1:40–2:10 evidence chain + tool execution + verdict banner.
- 2:10–2:35 Scenario C consumer coda.
- 2:35–3:00 architecture beat (FSM on screen, one sentence) + business line + tagline +
  links.
Production: record app screen + separate clean mic track; burned-in captions; the
agent's voice does most of the talking (≥2:20 live agent interaction — gate G6); keep one
imperfect-but-recovered moment (authenticity); cut dead air, never cut latency
dishonestly; synthetic-attacker voice generated via any commercial-safe TTS (disclose).
The founder's own voice narrates the hook and close — his authority is part of the entry.

---

## 9. SCOPE FENCE (LAW 5 — build NONE of these)
Acoustic/deepfake classifiers of any kind · real banking/SSO/SIEM/IdP integrations ·
carrier telephony (browser/WebRTC only; Twilio only if trivially stable AND time allows
— default NO) · multi-agent architecture · consumer app beyond the coda scene · RAG over
policy documents · avatars/3D · dashboards beyond the split screen · autonomous
unfreezing or releasing of anything · Slack/Teams bots · real personal data anywhere ·
any "90% faster"-style unmeasured claim.

## 10. EXECUTION GATES (abort criteria) + CALENDAR
- **G1 (by Sep 7):** golden interrogation path DEPLOYED at a URL a stranger can run unaided.
- **G2 (by Sep 14):** full Scenario B runs twice consecutively, zero manual resets.
- **G3 (by Sep 14):** FSM verdicts reproducible; challenge language natural without heavy
  prompt-steering.
- **G4 (always):** no action fires without structured evidence; approve ceiling = STAGED.
- **G5 (by Sep 21):** 50+ rehearsals incl. barge-in, story-shift, pressure; tail latency
  within target or the stalling plan is redesigned.
- **G6 (by Sep 27):** video ≥2:20 live agent, zero explainer >15s.
- **Two gates slip → founder downgrade call:** ship as portfolio-only, or don't ship.
  (His law: winning is the credibility; a mediocre public entry is negative credibility.)

**Weekly plan:** Wk1 (Sep 1–7) skeleton end-to-end + deploy + G1 · Wk2 (8–14) FSM +
tools + evidence + G2/G3 (founder in NYC Sep 10 — light founder week, sessions continue)
· Wk3 (15–21) polish THE path, UI legibility, rehearsals, G5 · Wk4 (22–28) video, README,
slides, adversarial corpus, submit. Founder time: ~2 evenings/week + voice recording.
Reviews: Sonnet-pinned per the founder's standing routing law; /security-review before
the repo goes public IF any auth/token handling exists.

## 11. FOUNDER ACTIONS + OPEN ITEMS (as of 2026-08-25 night)
- [x] **Enroll — FULLY DONE 2026-08-26** (all verified): lablab account (personal
      email) · event shows "Enrolled" (field: 485 approved, was ~326 Aug 25) · Discord
      account created, OAuth-connected + joined the lablab.ai server · **TEAM
      "Countersign" CREATED, solo, Closed to new members**, at
      https://lablab.ai/ai-hackathons/assemblyai-voice-agent-hackathon/countersign
      (team page has a 9-step progress checklist; step 1 done, submission untouched).
      Platform note: team creation REQUIRES Discord OAuth + actual server membership;
      in-server Discord actions are founder-manual.
- [ ] Sign up for the API account **via the event's credits link** when build starts.
- [ ] Say **"start the repo"** → scaffold per §7 (also: pin AAI's agent-integration
      prompt; copy this brief in as docs/BRIEF.md; project CLAUDE.md distilled from it).
- [ ] Record hook + close narration (Wk4).
- [ ] The two-evenings/week rhythm; flash decisions only (the gates do the rest).
- Context notes for a fresh session: the founder is a non-developer; plain English,
  no jargon; every claim labeled PROVEN/ESTIMATE/UNKNOWN; this project must never touch
  or reference the founder's other products' code, data, or branding.

## 12. RISK REGISTER (top kill-risks, from the hostile panels — mitigations built in)
1. Detection overclaim → LAW 1 (and the README owns it as a feature).
2. "Voice just transports a form" → the evidence-only-voice-can-produce story (§3.4) +
   the interrogation-as-hero demo.
3. Scripted-skit perception → live telemetry UI, one reviewer-win beat kept, real barge-in
   on camera, adversarial corpus in repo.
4. Alphanumeric/name transcription failure mid-demo → keyterms + echo-confirm pattern +
   fuzzy-matching mock endpoints + never hinging a verdict on one utterance.
5. Latency dead-air → stalling library + async workers + measured tails + G5.
6. Solo over-scope → LAW 5 + the weekly plan's one-vertical-slice discipline.
7. Evidence hallucination → LAW 4 (verbatim substrings only), engine-side consistency
   probes attaching both quotes.
11. Hands-on judges (FOUNDER-VERIFIED 2026-09-02, support chat screenshot: an AssemblyAI staff
   member judging the event said a cold start is "totally ok" and to host on the free tier) →
   judges open the live link themselves: stranger-usability (G1), replay-first (D4), the 30-second
   landing script, and a never-deadlock FSM carry more weight than the video. Hosting = Render
   free, $0, keep-alive optional (docs/DEPLOY.md).
12. Expert judge on "Application of technology" (same source: at least one judge works at
   AssemblyAI) → the API use must be visibly right, not merely working: session.update per goal,
   session resume on drops, keyterms, tool.result timing after reply.done, barge-in flush. The
   Sep 12 judge-sim preload gets an AssemblyAI-engineer persona; README names each API feature used.


## 13. NAME + COMPETITIVE-LANDSCAPE ADDENDUM (2026-08-26 scoping day)
From a 3-agent adversarial scan + a blind multi-model naming consult (full records
retained offline by the founder).
- **Uniqueness verdict:** OPEN as an integrated product, occupied on pieces. Nobody
  found assembling all four pillars (live conversational interrogation + deterministic
  policy engine + stage-never-release + explicit no-acoustic/no-biometric stance).
  Nearest: watchword.io (same positioning, but a static shared-secret app — no AI, no
  engine, consumer-only) and imper.ai (behavioral-not-acoustic philosophy, but passive
  telemetry, not conversation). Pindrop/Reality Defender/Nuance own the acoustic lane
  LAW 1 already rejects. PITCH LAW derived: lead with the COMBINATION and workflow,
  never any single mechanism.
- **Honesty constraint (deck + README):** the "policy engine, not the LLM, decides"
  pattern is published prior art (APort Vault CTF: social engineering 74.6% success vs
  model-only defenses, 0% vs the policy engine, 879 attempts). NEVER claim the pattern
  as our invention; CITE that number as independent proof the architecture works, and
  claim the novel APPLICATION (inbound voice-fraud interrogation). Business-value cite:
  Aug-2026 vishing wave against major Wall Street funds.
**SWEEP #2 (2026-08-26, adversarial patent/trade-press pass — deeper surfaces):** still NO
direct assembled competitor found; confidence NO MARKETED DIRECT COMPETITOR EXISTS =
**MEDIUM, not high** (patents searched thoroughly; funding-trail/analyst/non-English
surfaces only partially covered — treat "unique" claims accordingly; the pitch already
never claims "first ever"). **THE LOAD-BEARING NEAR-MISS: US Bancorp patent US12562169B1**
(priority 2025-09-16 — weeks old): a major US bank has patented adaptive iterative
challenge-question generation + a deterministic rule-engine/LLM routing split with
immutable logging — the two hardest mechanics of this product — but as AGENT-ASSIST for
human call-center staff: not autonomous, no staged-approval gate, not treasury-specific.
IMPLICATIONS: (a) validates the mechanics are worth a bank's IP budget RIGHT NOW; (b) the
first-mover window on the ASSEMBLED autonomous product is real but moving; (c) hackathon
IP exposure ≈ none in practice (different claims, non-commercial demo) — if this ever goes
commercial, a real patent review happens then, by a lawyer, not by this brief.

**SWEEP #4 — FOUNDER-RUN GEMINI CHECK + FETCH-VERIFICATION (2026-08-26): confidence
upgraded to MEDIUM-HIGH that no assembled competitor is publicly marketed.** Four
independent checks now converge (2 adversarial agent sweeps, founder's liveness research,
grounded Gemini): pieces everywhere, assembly nowhere. Gemini's architectural framing is
the pitch's cleanest line: the market does conversation → risk signals → LOCK/TRANSFER/
ESCALATE; Countersign does conversation → structured evidence → deterministic verdict →
STAGE-ONLY. New near-misses, each FETCH-VERIFIED against its live page same day:
- **CETRAI** (cetrai.com, closest commercial): banking voice agents, verbatim "watches
  for fraud signals in real time — failed authentication attempts, mismatched device or
  caller ID, unusual payee or wire requests, and social-engineering language" + action
  locking + "warm transfer to fraud specialist with transcript" + KBA/OTP. NO disclosed
  adaptive interrogation, verdict engine, or staging — their architecture ENDS at
  escalation, where ours begins.
- **Workforce Wave** (workforcewave.com, closest use-case): AI calls the registered
  number to CONFIRM a wire ("Can you confirm this is authorized?") and routes unconfirmed
  to fraud. Confirmation checkbox, not interrogation; no engine, no staging.
- **NVIDIA's public wire-transfer voice-agent example** (HuggingFace, code-verified):
  exposes `wire_transfer_domestic` + `wire_transfer_international` EXECUTION tools in the
  agent's _TOOLS list — the literal LAW-2 anti-pattern. DECK AMMO (verified, quotable):
  "The industry's reference demo hands the AI the wire button. Countersign is built on
  the opposite promise."
- **CFAgentBench** (arXiv 2606.22000, per Gemini — cite-check at deck time): benchmark
  where executing money movement FAILS the task; stage-for-human is the correct behavior.
  Academic backing for LAW 2, cites next to the APort CTF number.
- Patents added to the prior-art ledger (Gemini-surfaced, unverified beyond existence):
  US11783839 (call-center auth for wires, includes voiceprint — excluded by us),
  US12519773 (spoken-passphrase step-up — challenge-response class, not interrogation).
Standing caveat (honest, keep in README language): absence of a PUBLIC product ≠ absence
of proprietary bank-internal systems; we claim the assembly and the stance, never "first
ever."

**PRIOR-ART CLASS: ACTIVE LIVENESS / CHALLENGE-RESPONSE (founder's own research find,
2026-08-26):** academic frameworks (PITCH, GOTCHA, D-CAPTCHA) and commercial liveness
engines (ID R&D, Pindrop, ValidSoft) actively challenge callers — whisper/sing/tongue-
twister tasks, latency probes, read-this-phrase — to make synthesis pipelines glitch.
ADJACENT, and the distinction is the pitch: they interrogate the VOICE (still "is this a
machine?", still the arms race, and USELESS against a live human impostor — who passes
every liveness test and has run most wire fraud in history). Countersign interrogates the
REQUEST — knowledge, cross-turn consistency, out-of-band, staged approval — which stops
clone and human identically. PITCH LANGUAGE RULE: never claim challenge-response as novel
(judges may know PITCH); cite it, then land the line: "liveness asks 'is this voice a
machine?' — Countersign asks 'is this request true?' — only the second stops the human
con artist too." Knowledge-questioning per se also isn't novel (bank KBA, agent-assist
per US12562169B1) — the novel assembly claim stands unchanged.

- **Name:** Countersign (founder pick 2026-08-26) — collision-scanned CLEAR-for-purpose
  (one small eSignature co at countersign.com, different space; zero malware/ransomware
  associations). Rejected en route: Sentry (sentry.io), Guardian (naming conflicts,
  including with another product of the founder's), Watchword (watchword.io = adjacent
  competitor), Interlock / Airlock / Bouncer (ransomware & malware name-shares).

## 14. STACK RATIFICATION + CONSULT AMENDMENTS (2026-08-26)
Stack consult: GPT-5.6 + Grok-4.6 + Perplexity via a same-prompt panel (Gemini's API was
down all day — the founder ran the same prompt through Gemini manually, completing the
panel 4/4; raw replies retained offline). All three ENDORSED and
none would swap: TypeScript end-to-end (shared evidence/FSM types engine→server→UI→tests),
Vite+React split-screen, policy engine as a pure dependency-free module imported by tests,
seed JSON + in-memory (no DB), Vitest + GitHub Actions (Actions free on public repos —
confirm at repo creation), and the exclusion list (no Python/LangChain/DB/dashboards).

**AMENDMENT 1 — hosting (unanimous, supersedes §6.4's Vercel suggestion):** ONE small
always-on container (Fly.io or Render) is the DEFAULT home for the Node server (FSM state,
token minting, session isolation) — Vercel serverless cannot hold authoritative session
state (isolate recycling = the live state diagram lies). Audio stays browser→AssemblyAI
direct via short-lived server-minted token IF their docs support it (day-1 VERIFY-AT-BUILD:
ephemeral tokens exist, CORS, token lifetime ≥5min, tool/interruption events exposed to
browser clients). Frontend static on the same box or Vercel. Verify the free-tier box does
NOT spin down (a 40s cold start on a judge's first click = dead submission). Gemini adds:
if a server-side relay IS forced (Plan B), CO-LOCATE the container in the same region as
AssemblyAI's realtime servers — a proxied audio path adds 100-300ms + jitter otherwise.

**AMENDMENT 1b — engine placement (resolves a GPT↔Gemini conflict):** Gemini: run the
pure engine IN the browser to kill the tool-call round trip (AAI↔browser↔server↔browser).
GPT: a browser-owned policy engine is client-modifiable and the security-architecture
claim becomes misleading. RESOLUTION (adopted): the pure engine module runs in the
BROWSER for conversational tempo (zero added hops — it's the same shared-typed module),
but every TERMINAL action (stage_payment, freeze_rail) is a server endpoint that
RE-RUNS THE SAME ENGINE over the submitted evidence log and only acts if the verdict
matches — the browser cannot lie. This is on-brand: the server recomputation IS the
countersignature. One extra hop only at verdict moments, where a beat of gravity is
dramatically fine.

**AMENDMENT 2 — credit-burn protection is a SUBMISSION REQUIREMENT, not polish**
(unanimous; amplified by the Team's-Choice finding — participants vote, so the URL gets
participant traffic, not just 5 judges): hard per-session minute cap (3-5), concurrent
sessions 1-2 with a visible "session in use" gate, idle disconnect 60-90s, daily global
cap, token-mint rate limit, kill switch, and a credits-exhausted REPLAY mode. Reset
endpoint scoped to session id (a public reset can wipe a judge mid-call). Gemini adds:
socket opens only on an explicit "Start Call" click (never on page load — a forgotten
open tab must cost $0), and auto-terminate on sustained silence (Gemini said 10s;
CALIBRATE against real interrogation pauses — 10s would kill a judge mid-think; start
~30s no-speech-either-side and tune in rehearsals). Secret hygiene: if ephemeral
browser tokens turn out unsupported, NEVER fall back to a key in the Vite bundle
(VITE_* vars are public) — that forces Plan B, full stop.

**AMENDMENT 3 — replay-without-mic mode is mandatory:** a judge who can't or won't talk
(open-plan office, denied mic) must still see the full split-screen come alive — a "replay
corpus" mode injecting the same structured events the voice path emits. Landing page:
30-second script, desktop-Chrome-first note, mic permission check with clear failure
banner, and a SCENARIO CHEAT-SHEET (the judge plays the attacker and cannot invent a
consistent insider story from nothing — put the caller's role, facts, and intended lies
on screen or the challenges will fail and the product will look broken).

**Engineering laws from the consult (fold into build):** (a) barge-in is won in the
CLIENT audio buffer — Web Audio tiny queue, immediate flush + cancel of in-flight TTS on
interrupt; test with speakers not just headsets; Bluetooth buffering breaks "stops
mid-word". (b) NEVER print "sub-second" on the deck — measure and publish p50/p95
(realistic full loop 800ms-2s); "partials + barge-in feel instant, first audible token
streamed" is the honest phrasing. (c) Determinism claim = ENGINE only: pure function
(conversation_log, tools_log, seed_config) → verdict; tests replay recorded transcripts
through the real engine, never call the live API. (d) Say "hash-chained evidence export",
not "immutable/sealed" (no durable store, no signing key). (e) Mocked tools (SSO, OOB)
carry a visible "simulated" banner — never imply real bank/IdP integration. (f) Eager
turn-detection can cut off spoken amounts/account numbers — tune to wait for complete
numeric answers or the FSM freezes rails on ASR fragments. (g) Per-state tool allowlists
enforced server-side (ignore out-of-state calls). (h) Gemini: run the AAI WebSocket +
audio buffer management in a WEB WORKER, off the React thread, and throttle UI state
updates to ~15fps — high-frequency React renders (live transcript + FSM diagram + tool
feed) thrash layout, choke the main thread, stutter audio, and delay the barge-in signal.
(i) Gemini: the FSM needs explicit GRACEFUL-FALLBACK states for out-of-bounds input —
a judge WILL say "I'm not the CEO, I'm testing this for a hackathon"; the machine must
answer sensibly (an OUT_OF_SCOPE / meta state that explains itself and offers the
scenario cheat-sheet), never deadlock or loop. Rigidity here breaks the demo in the
judge's own hands.

**§14b EVENT-INTEL SWEEP (2026-08-26, five research lanes — full record retained
offline by the founder; it SUPERSEDES assumptions here where they conflict):** (1) Plan A CONFIRMED from AAI docs — browser-direct WebSocket
(wss://agents.assemblyai.com/v1/ws) with backend-minted single-use ephemeral tokens
(5-min lifetime). (2) THE AI BRAIN IS SELECTABLE: AAI's LLM Gateway = 25+ models
(Claude/GPT/Gemini/...), `model` param + system prompt — the LLM handles arbitrary
judge input natively; the FSM bounds actions only. (3) Tool events are tool.call /
tool.result with BUILT-IN "interactive" (~5s, spoken transition) and "hold" (>10s,
silent) execution modes — §6.2's "execution_mode: hold" citation VERIFIED in spirit.
(4) Session resumption: 30s window via session.resume. (5) HOSTING CORRECTION: no free
always-on Fly/Render in 2026 (Fly trial-only; Render free spins down 15min/~1min cold
start) — always-on = Render Starter $7/mo (recommended, founder spend-OK pending) or
Oracle free tier / Cloudflare Durable Objects at $0 with quirks; Vercel fine for static
frontend only (its 300s WS cap is irrelevant when the voice socket is browser-direct).
(6) AAI new-account credit = $50 (~11 voice-hours); event participant credits exist,
amount unknown. (7) TEAM'S CHOICE = WILD CARD: most-voted project pitches on the final
Twitch stream alongside judge finalists (voting 24h pre-stream; projects visible to
participants during the event). (8) Video limit is ≤5 min / 300MB — 3:00 target stands.
(9) Their "vibe code a voice agent" AI-builder guide + MCP server exists — pin into the
repo CLAUDE.md at scaffold; known trap: 24kHz PCM sample-rate mismatch. (10) Past AAI
winners: no security/fraud entry — the lane is unoccupied in their winner history.

**Judging mechanics (researched 2026-08-26, lablab.ai's own guides + Gemini rubric
quote):** CONFIRMED BY THREE INDEPENDENT SOURCES: judges open the demo URL and interact
with it themselves, off-script — lablab guide ("an application URL is required for
INTERACTIVE evaluation"; "a working demo judges can't access scores as if it doesn't
work"), Gemini (rubric: Adequate/Strong/Excellent in Application of Technology requires
"Demo link is working & well-executed, features working smoothly"), Grok (prior
knowledge). SOURCES SPLIT on a live round: the lablab guides describe a finalist Twitch
stage (5 min demo + 5 min live judge Q&A); Gemini says evaluation is strictly async with
no live pitch. UNVERIFIED for this specific event either way → design for async-first
(the live round, if it exists, presents the same demo and costs nothing extra to be
ready for). Team's Choice award = participant popular vote → participant traffic on the
URL. DESIGN ASSUMPTION (adopted): at least one judge/voter will open the URL and speak
off-script; another will never unmute. Build for both.

**§14c COMPLIANCE — when building may start (verified from lablab's live pages,
2026-08-26, read via authenticated browser):** The binding Terms (§16) say only:
"All submissions by participants must be original work, open source, and compliant with
the MIT License unless specified otherwise" — NO timing clause. lablab's cross-event FAQ:
"Most events require only that the core AI-powered functionality was built during the
event window. Using open-source libraries, starter templates, or prior non-AI scaffolding
is generally allowed — check each event's specific rules." This event's own pages add no
stricter rule. Their judging guide: strong signal = "GitHub repo with real commits spread
across the event window"; red flag = "an empty repo with one final push."
**RULING ADOPTED: repo scaffold + docs before kickoff (explicitly fine); ALL product code
lands Sep 1–30, spread across the window.** No AI-assistance disclosure rule exists for
this event (the one AI-tool submission rule found on their guidelines page names a
different sponsor's tool — templated boilerplate, not applicable). Late submission:
"Manual submission is available for 6 hours post-hackathon for those with valid reasons
and prior approval from organizers or mentors" — never plan to need it.


---

## 15. DESIGN + DEMO DECISIONS (2026-08-30, founder-ratified in session; extends, supersedes nothing above)

**Where the artefacts live:** `docs/design/six-looks-2026-08-30/` (six standalone HTML looks of the
main screen at the Scenario-B verdict moment, rendered from one `content.json`; the talking-profile
prototypes v2/v3/v4; contact sheets; `design-log.md`, `curation-log.md`), `docs/design/
judge-flow-2026-08-30.html` (what a judge goes through, and what happens off script),
`docs/design/big-picture-2026-08-30.html` (the whole entry on one page), `docs/HANDOFF-2026-08-30.md`
(context for any fresh AI session). Linear team CSN carries every decision verbatim with timestamps
(CSN-4 look, CSN-5 character, CSN-6 target). Everything here is DESIGN DOCS, allowed pre-kickoff per
§14c; the real UI is built from scratch inside the app Sep 1-30; today's HTML is a drawing, never
copied into product code.

**Visual identity, the method (founder, morning):** the look is BORROWED FROM A REAL-WORLD DISCIPLINE
outside software, never an invented palette (Claude palettes regress to the web median and the
founder fights them). Enforcement: a design decision that cannot be traced to its source does not
ship. Colour decided numerically (WCAG 2.x, luminance-based, colour-blind-safe by construction).

**The look, founder shortlist (20:29):** 2 TV control room · 4 oscilloscope · 6 Swiss departure
board. Common thread: dark instrument surfaces with LIVE moving elements. Looks 1, 3, 5 are out.
Final pick pending; the live trace and the talking profile were proven on look 4 and are to be carried
onto 2 and 6 before the pick. The pick sets the style for the app screen, the cover image and the
slides.

**The character (founder idea 18:41; laws 21:37):** Countersign presents as a NAMED, human-centred
character, shown as a line-drawn SIDE PROFILE traced from a real human silhouette (v4: William James
Hubard, "Profile of a Man", Wikimedia Commons, public domain), whose lips, jaw and contour lines move
with its speech and FREEZE mid-motion the instant the caller barges in, then resume calmly. The caller
is the same profile, dashed and incomplete, labelled UNVERIFIED, never filling in. Voice law: friendly
and cooperative, never showing its hand, sounding like it is helping the request along; for the
honest caller that is good service, for the attacker it is containment. The only moment the mask drops
is the verdict line, and it stays calm. NOT a therapist persona. Open: the character's name and TTS
voice; modern vs period silhouette source (a swap, not a rebuild). §6.4's "avatar-free / no talking
heads" line is amended by the founder to permit this line-art profile (it is not a talking head).

**Live instrumentation:** the two-channel voice trace on the call panel is REAL during a call (drawn
from the live audio envelope, flat when silent, the caller's spike at the barge-in, Countersign's
channel dead-flat while frozen). Motion is a colour-independent signal.

**Demo laws (founder, 21:29 to 21:43):**
1. Bar: must read as a seed-stage company's launch demo, never as a project being turned in. Tonight's
   scripted animation is explicitly the latter; the live build is the former.
2. NO SCRIPTED PING-PONG. The attacker in the video and in rehearsals is a LIVE HUMAN improvising within
   the cheat-sheet facts; overlaps, talk-overs, corrections, backchannels and anger happen for real and
   the agent handles them for real (this is also the showcase for a speech-company jury). Agent rules:
   yield to short overlaps and backchannel; retake the floor only after a PRESSURE interruption (the one
   hard stop); never leave silence (stalling lines). Test with speakers, not headsets.
3. CLONED VOICE AS THE ATTACKER: Scenario B's fake CEO speaks in a cloned voice of the real principal
   (the founder's own voice cloned with consent, disclosed in README). Countersign still freezes the
   wire because it never trusted the voice, only the facts. Prefer a REAL-TIME voice changer on the live
   human; if only offline cloning exists, keep the human live and add a separate "even a perfect clone
   fails" beat. No detection claim, ever.
4. NO VOICE BIOMETRICS (pitch or prosody as identity): rejected under LAW 1 and scope fence §9; it would
   contradict "we don't guess who's calling, we make them prove it." Legitimate cousin: BEHAVIOURAL
   pressure signals (talk-over count, speech rate, deadline language, threats) feeding the Urgency
   Escalation card, labelled as behaviour, never identity.
5. Why our voice use is different (deck and README line): every other entry uses voice as an INTERFACE;
   Countersign uses the conversation as an EVIDENCE INSTRUMENT and the agent's own speech behaviour as
   SECURITY CONTROLS (cross-turn consistency as evidence, barge-in as a control, stalling as latency
   defence, containment, the transcript as a sealed record, keyterms). The stand-out lives in three
   live moments: catching the changed amount, refusing authority as verification, stopping mid-word.

**Judge experience (founder questions, 21:04):** the scenario cheat-sheet (§14 Amendment 3) MUST offer
a passing role (Card A: Dana, the legitimate request) as well as the fraud role (Card B), or judges only
ever see "no" and read the product as a wall. Replay mode covers judges without a microphone. Off-script
is safe by construction: the verdict is computed from seeded evidence, never from the story; an
unknown identity lands UNVERIFIED; silence ends the call politely; nothing moves.

**Density (to ponder, not decided):** the END state of the screen is dense (5 cards, 6 tool rows,
tally, state machine, banner); live, it fills in rhythm with the call. Mitigations to weigh at build:
tool feed as a one-line ticker with an expander; newest evidence card large, older receding; the verdict
banner as the only loud element; a presentation mode for the video. Cheap test: show the end-state
frame to three people for five seconds and ask what happened.

**Target (founder, 22:05; CSN-6):** build complete (G1-G3 + UI + landing) **Sep 12** · video draft
**Sep 14** · submit by **Sep 20** · Sep 27 stays the backstop. ESTIMATE 31-51 session-hours and
10-15 founder-hours at 4-5 short touchpoints per week (decisions, accounts and keys, playing the live
attacker, voice recording, verdicts on runs, video cuts, the submission form). Critical path: day-1
AssemblyAI API behaviour (ephemeral tokens, tool-call hold, barge-in events; a forced relay adds 4-6
session-hours), founder availability for live-attacker rehearsals, video edit rounds. NYC Sep 10 =
light founder days; rehearsals cluster Sep 5-8 and Sep 12-13.

**Working rules adopted with the founder today (apply to every session on this project):** before any
multi-agent spend, state in one line what he will receive, in his words, with a token estimate, and
disclose the overrun after; he only ever sees the LAST step of a plan (finished screens, never
reference material or designer vocabulary); one decision at a time with a recommendation; nothing
published or linked without his word (local HTML in his browser); agents move rejected files, never
delete.

## 16. DAY-1 PANEL AMENDMENTS (2026-09-01, four founder-run seats; synthesis in docs/consults/2026-09-01-panel-synthesis.md)

Kickoff-night consult on the full plan (ChatGPT, Perplexity, Grok, Gemini; identical prompt;
citations fetch-verified same night). Four-of-four convergence on: the seeded-verdict objection
(fatal as planned; cured by evidence the caller creates during the call), the story ledger and
adaptive challenges as upgrades #1 and #2, "the LLM may ask, never grade," the browser as an
untrusted terminal, the screen's over-design, and under-use of AssemblyAI's mid-session
`session.update` and session resume. Two seats proposed pivots (consumer scam screener; healthcare
eligibility); both fail the panel's own tests and the protocol is not re-run for them.

**PENDING FOUNDER RATIFICATION (D1-D5 in the synthesis):** D1 keep concept, adopt "a call can
request, it can never authorize," cut the consumer coda from the video · D2 server-authoritative
relay, engine on the server only (supersedes Amendment 1b) · D3 one visual metaphor, keynote-then-
forensic layout, character demoted to a small element, dashed caller portrait dropped, voice
professional and unyielding (amends §15 character laws) · D4 replay as the default judge path, role
prompts without answers, hidden per-session facts · D5 GO on engine plan v2.

**Engine changes adopted regardless of D1-D4 (they are pure-engine):** story ledger with typed
deltas (CONFIRMED / APPROXIMATE / CORRECTED / CONTRADICTED / UNKNOWN); engine-issued challenges
with ids and eligible-turn windows, graded deterministically (no LLM-recorded answers); affirmative
assurance requirements for STAGE (never "zero failures"); invariants independent of scoring
(VOICE_CAN_NEVER_RELEASE; material claim change invalidates dependent evidence; infrastructure
failure → NO_ACTION or ESCALATE); request versioning; aggregate exposure across a session (anti-
structuring); pressure changes the path (no disclosure, supervisor notice) but never blocks staging
alone; "no response" = UNVERIFIED, never IMPOSTOR; provenance tag on every card; readback
confirmation before any amount or account digits are evaluated; a counterfactual panel ("what single
change would flip this"); a live-evidence-overrides-green corpus case; the trap-fact probe as a
labeled challenge type; mutation tests. Timing signals demoted to operational-risk evidence only.

**Risk register additions (§12):** 8. Seeded-verdict perception → live commitments + counterfactual
panel + overrides-green case. 9. False positives on honest correction/stress → CORRECTED delta type +
the honest-Dana-under-stress corpus case (ESCALATE, never FREEZE). 10. In-event competitor in the
scam-screening lane: VoiceFirewall (Team TLE), FOUNDER-VERIFIED 2026-09-01 10:47 PM CDT from his browser,
a real-time DETECTOR of risky patterns ("analyze speech as it happens and detect risky patterns such as
scam…"), two members, no submission yet → adjacent, not the same: they alarm, we interrogate and gate.
Positioning stays on the assembly and on "request, never authorize." Field size FOUNDER-VERIFIED same
moment: 1,477 approved participants (the brief's Aug 26 figure of 485 is superseded).

**RATIFIED by the founder 2026-09-01, 10:27 PM CDT: "yes to all five, go."** D1-D5 are now law. Amendment 1b
is superseded (engine on the server only; browser is an untrusted terminal). §15 character laws amended per D3.
§4 Scenario C is cut from the video; the README keeps one sentence that the same checkpoint generalizes to a
family phone. Language adopted everywhere: "A call can request a privileged action. It can never authorize one."

**2026-09-02 10:06 AM CDT, founder: "yes to all five, go."** Ratified: the four corpus/engine items parked in docs/AUTOPILOT_LOG.md (Scenario B barge-in flag on the agent line; roster name; the correct-answers description; recorded challenge spec carried in `challenge_issued` actions) and Plan 2 GO (docs/superpowers/plans/2026-09-02-plan2-voice-path.md). Corpus edits are founder-authorized (GOLDEN_OVERRIDE). The RELATIONAL-above-SEED_FACT reorder is applied in the same pass (controller ruling 2026-09-01 11:24 PM; disclosed).
