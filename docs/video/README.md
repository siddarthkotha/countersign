# Video pre-production assets

These are video-only production assets for the submission cut (docs/VIDEO-RECORDING-PLAN.md
§4, docs/VIDEO-SHOT-LIST.md). They are plain, self-contained HTML files, not part of the
product — nothing here is imported by any package, and none of this is the shipped app UI.
Each one is built as a fixed 1920x1080 artboard so a screenshot or screen recording of it
drops straight into the 3:00 cut with no cropping.

To capture any of them: open the file in desktop Chrome, size the window (or just the
capture region) to 1920x1080, and either take a full-page screenshot or screen-record it
directly (a few are meant to sit still under narration, so a plain screenshot held in the
edit works fine — no motion is required).

- **title.html** — the title card: the product name "Countersign" and its one-line
  description, taken from README.md's opening line. Use this as a simple open/close card,
  or under the hook narration if a static title beat is wanted before Scenario A.

- **architecture.html** — the architecture beat for 2:35–2:50 in the cut. Shows the real
  finite-state engine states (from packages/engine/src/fsm.ts) as a flow, the real verdict
  set (PENDING, STAGE, FREEZE, ESCALATE, NO_ACTION), and the one governing sentence: the
  engine decides every verdict from structured evidence, the language model only phrases
  the conversation and never emits a verdict. It also shows LAW 2 plainly: a verified
  request only ever reaches STAGE plus an independent second approval, voice never releases
  a transfer. Capture this as a screenshot (or a slow zoom/pan in the edit) under the
  founder's one-sentence voice-over for this beat.

- **business.html** — the business-value slide for 2:50–3:00. Carries the FBI IC3 figure
  exactly as it appears on the Landing screen and in README.md ($3.05 billion in 2025
  business-email-compromise losses, cited to the FBI IC3 2025 Internet Crime Report, page
  26), the tagline "Countersign doesn't guess who's calling. It makes them prove it.", and
  the full live demo URL countersign-bf8q.onrender.com (the -bf8q matters — a plain
  countersign.onrender.com is a different, unrelated product). Capture as a screenshot under
  the founder's closing voice-over.

Note: these are video-only assets. If a number or a state name in the shipped product ever
changes, these files need a manual re-check against the real source (fsm.ts, Landing.tsx,
README.md) before the next recording session — they do not update themselves.
