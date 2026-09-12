# Cover image candidates (2026-09-11)

Three 16:9 (1920x1080) candidates for the lablab submission cover image. All three
use only the live UI's tokens (copied verbatim from `packages/web/src/styles.css`:
`--cs-bg #12151c`, `--cs-panel #1c1608`, `--cs-elevated #171a22`, `--cs-fg #e8ebef`,
`--cs-muted #9aa3b2`, `--cs-accent #ffc72c`, `--cs-border #262b36`,
`--cs-row-border #1c2029`) and the live UI's system font stacks (no Google Fonts, no
CDN, no images anywhere). This matches the founder-approved look
(`docs/AUTOPILOT_LOG.md`, "LOOK 6 APPLIED" — Swiss departure board, ground `#12151c`,
accent `#ffc72c`), not the earlier six-looks exploration's own palette variants.

The only text on any of the three images: the wordmark "Countersign", one 8-word
line ("A second approval stands between voice and wire."), and — on candidates 1
and 2 — one of the two allowed banner phrases, set in the UI's own banner style
(`.banner-terminal`: dark panel, top/bottom accent rule, bold uppercase accent
headline). No em-dashes appear anywhere on any image. No detection-claim language
(LAW 1) appears anywhere — the line is about the approval gate, not about spotting
fraud. Colour is never the only carrier of meaning: every accent use sits on bold
text, a rule, or a border, exactly as the live UI already does.

Files: `cover-1.html`, `cover-2.html`, `cover-3.html` (open directly in a browser,
1920x1080 fixed stage, auto-scales to fit the window) and their PNG renders
(`cover-1.png` etc.), rendered via `render.mjs` using the Playwright already
installed in `~/shadepath-app` (this repo has no Playwright dependency and none was
installed to produce these).

| Candidate | What it says | What survives at 320px wide | One risk |
|---|---|---|---|
| **1 — Verdict banner hero** (`cover-1.html`) | "Countersign" · "A second approval stands between voice and wire." · banner "WIRE FROZEN" | The amber banner block and its headline read clearly even shrunk; the wordmark and tagline stay legible because both sit alone on empty ground with nothing competing for attention. | A judge skimming a thumbnail gallery could read "WIRE FROZEN" as a detection/scare graphic before reading the tagline underneath it — the banner alone, out of context, looks like a claim about catching fraud rather than about who is allowed to approve a wire. Needs the surrounding submission text (title/description) to carry the "behavioral, not detection" framing. |
| **2 — Split-screen silhouette** (`cover-2.html`) | "Countersign" · tagline (top right) · banner "STAGED FOR SECOND APPROVAL" | The two-column shape (transcript left, checks right) and the amber banner phrase both read clearly at thumbnail — it unmistakably looks like a screen, not a poster. The wordmark holds up; the tagline, set smaller in the top-right corner to mimic the live masthead, is the first thing to blur. | With no real transcript or evidence text in either column (by design, to stay inside the text allowlist), an unfamiliar viewer could mistake the abstract bars for a broken or half-loaded app rather than a deliberate "silhouette" — it reads best to someone who has already seen the live UI's actual layout. |
| **3 — Typographic + hash-chain motif** (`cover-3.html`) | "Countersign" · tagline only (no banner phrase, per the candidate's own spec) | The giant wordmark dominates and stays sharp at any size; the tagline stays readable as a full sentence. This is the single most thumbnail-durable candidate. | It is the least distinctive of the three and the only one that skips the "verdict banner aesthetic" the brief calls out by name (BRIEF §7) — the hash-chain motif (a row of CSS diamonds) is decorative at full size but reads as a faint dashed line at thumbnail, so its meaning is lost until the viewer opens the image. |

## Recommendation

Candidate 2 (split-screen silhouette) is the strongest single cover: it is the only
one that reads as "a screenshot of a real product" rather than a title card, it
still passes the thumbnail test, and it uses the banner phrase that matches an
honest, non-alarming outcome ("staged," not "frozen") — safer as the very first
thing a judge sees before they have any context. Candidate 1 is the better choice
if the founder wants the single most dramatic frame (matches the video's own money
moment) and is willing to rely on the submission's title/description to pre-empt
the detection-claim misread. Candidate 3 is the safest fallback if either of the
other two needs rework late.

## Could not do

- No accessibility contrast tool was run against these three files specifically;
  the token pairs used here are the same pairs already measured and passed in
  `packages/web/test/contrast.test.ts` against the live UI, so no new pairing was
  introduced.
- PNG renders are single static frames at 1x scale (1920x1080), not retina/2x —
  matches the six-looks precedent (`docs/design/six-looks-2026-08-30/render.mjs`).
