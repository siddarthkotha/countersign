# Cover image candidates (2026-09-11)

Three 16:9 (1920x1080) candidates for the lablab submission cover image. All three
use only the live UI's tokens (copied verbatim from `packages/web/src/styles.css`:
`--cs-bg #12151c`, `--cs-panel #1c1608`, `--cs-elevated #171a22`, `--cs-fg #e8ebef`,
`--cs-muted #9aa3b2`, `--cs-accent #ffc72c`, `--cs-border #262b36`,
`--cs-row-border #1c2029`) and the live UI's system font stacks (no Google Fonts, no
CDN, no images anywhere). This matches the founder-approved look
(`docs/AUTOPILOT_LOG.md`, "LOOK 6 APPLIED", Swiss departure board, ground `#12151c`,
accent `#ffc72c`), not the earlier six-looks exploration's own palette variants.

The only text on any of the three images: the wordmark "Countersign", one 8-word
line ("A second approval stands between voice and wire."), and, on candidates 1
and 2, one of the two allowed banner phrases, set in the UI's own banner style
(`.banner-terminal`: dark panel, top/bottom accent rule, bold uppercase accent
headline). No em-dashes appear anywhere on any image. No detection-claim language
(LAW 1) appears anywhere, the line is about the approval gate, not about spotting
fraud. Colour is never the only carrier of meaning: every accent use sits on bold
text, a rule, or a border, exactly as the live UI already does.

Files: `cover-1.html`, `cover-2.html`, `cover-3.html` (open directly in a browser,
1920x1080 fixed stage, auto-scales to fit the window) and their PNG renders
(`cover-1.png` etc.), rendered via `render.mjs` using a Playwright install from another
local checkout, passed in through the `PLAYWRIGHT_PKG_JSON` environment variable (this
repo has no Playwright dependency and none was installed to produce these).

| Candidate | What it says | What survives at 320px wide | One risk |
|---|---|---|---|
| **1, Verdict banner hero** (`cover-1.html`) | "Countersign" · "A second approval stands between voice and wire." · banner "WIRE FROZEN" | The amber banner block and its headline read clearly even shrunk; the wordmark and tagline stay legible because both sit alone on empty ground with nothing competing for attention. | A judge skimming a thumbnail gallery could read "WIRE FROZEN" as a detection/scare graphic before reading the tagline underneath it, the banner alone, out of context, looks like a claim about catching fraud rather than about who is allowed to approve a wire. Needs the surrounding submission text (title/description) to carry the "behavioral, not detection" framing. |
| **2, Split-screen silhouette** (`cover-2.html`) | "Countersign" · tagline (top right) · banner "STAGED FOR SECOND APPROVAL" | The two-column shape (transcript left, checks right) and the amber banner phrase both read clearly at thumbnail, it unmistakably looks like a screen, not a poster. The wordmark holds up; the tagline, set smaller in the top-right corner to mimic the live masthead, is the first thing to blur. | With no real transcript or evidence text in either column (by design, to stay inside the text allowlist), an unfamiliar viewer could mistake the abstract bars for a broken or half-loaded app rather than a deliberate "silhouette", it reads best to someone who has already seen the live UI's actual layout. |
| **3, Typographic + hash-chain motif** (`cover-3.html`) | "Countersign" · tagline only (no banner phrase, per the candidate's own spec) | The giant wordmark dominates and stays sharp at any size; the tagline stays readable as a full sentence. This is the single most thumbnail-durable candidate. | It is the least distinctive of the three and the only one that skips the "verdict banner aesthetic" the brief calls out by name (BRIEF §7), the hash-chain motif (a row of CSS diamonds) is decorative at full size but reads as a faint dashed line at thumbnail, so its meaning is lost until the viewer opens the image. |

## Recommendation

Candidate 2 (split-screen silhouette) is the strongest single cover: it is the only
one that reads as "a screenshot of a real product" rather than a title card, it
still passes the thumbnail test, and it uses the banner phrase that matches an
honest, non-alarming outcome ("staged," not "frozen"), safer as the very first
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
- PNG renders are single static frames at 1x scale (1920x1080), not retina/2x -
  matches the six-looks precedent (`docs/design/six-looks-2026-08-30/render.mjs`).

## Candidate 2, finished (2026-09-11)

The founder picked candidate 2 but found it incomplete: the transcript and
evidence columns were grey placeholder bars standing in for content, per this
file's own note above ("no invented dialogue... no invented findings"). Two new
files fill both columns with REAL content, one per outcome, so the cover reads as
an actual screenshot rather than a silhouette of one:

- **`cover-2-final.html`** / **`cover-2-final.png`**, the fraud call. Six
  transcript lines and six evidence cards are the exact strings and real labels
  from `scripts/rehearse/reports/2026-09-11T22-05-48-scenario-b-miller-fraud.md`
  (the live rehearsal that froze the wire), cross-checked against the actual
  evidence labels in `packages/engine/src/evidence/fromTools.ts` and
  `fromTranscript.ts` so nothing on screen is invented. Banner: "WIRE FROZEN".
- **`cover-2-final-staged.html`** / **`cover-2-final-staged.png`**, the honest,
  non-alarming variant: same structure, content from
  `scripts/rehearse/reports/2026-09-11T22-04-38-scenario-a-dana-legitimate.md`
  (the legitimate call staged for second approval), all six evidence cards PASS.
  Banner: "STAGED FOR SECOND APPROVAL" (unchanged from the original candidate 2).

Both keep the row grammar from the live UI exactly: transcript rows are
`CallView.tsx`'s `.turn` shape (mono index, bold uppercase speaker label, muted
for caller, accent for agent, left border in the same colour, never colour
alone), and evidence rows are its `.checks-row` shape (amber square mark, bold
label, bold uppercase status word, muted one-line detail). The status word's
colour is uniformly the one accent regardless of PASS/FAIL/FLAG/INFO, exactly
like the live UI, because the founder is colour blind and the word, not the
colour, is what carries the verdict. Rendered the same way as candidates 1–3
(`PLAYWRIGHT_PKG_JSON` pointed at another local checkout's Playwright install; no
new dependency added to this repo). Text stays legible at 320px wide for the
banner and wordmark; the six transcript/evidence rows blur at thumbnail size,
which is expected, they read as texture at that size and as real content at full
size or on the submission page.

This addresses candidate 2's own listed risk above ("an unfamiliar viewer could
mistake the abstract bars for a broken or half-loaded app"), the mistake is no
longer possible once the columns carry real, readable rows. The fraud variant
(`cover-2-final.html`) is the stronger single cover for the same reason candidate
1 was flagged as the more dramatic frame; the staged variant is the safer default
for a judge's very first impression, per the recommendation above.

## Founder pick (2026-09-12, 9:00 AM CDT)

Submission cover image: `cover-2-final.png` (the fraud call, WIRE FROZEN). The staged variant stays in this folder as the README hero if wanted.
