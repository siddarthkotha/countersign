# Six looks — design log (2026-08-30)

Written before any HTML was coded. Each plan traces to specific photo files that were
actually viewed (not guessed) in a design reference archive.
Same `content.json` renders on all six — only the look changes.

---

## 1 · Flight deck (instrument panel)
- **Traces to:** `01-747-panel.jpg` (dense round gauge clusters + a lit caption panel
  strip — "AUTOLAND AUTORISE" — at the top of the stack), `14-aw139-cockpit.jpg` (a dense
  grid of amber/red named caution labels, hierarchy by screen position not colour alone),
  `07-glass-cockpit.jpg` (bright data — green/cyan text and amber labels — on a black
  panel, layered information read at a glance).
- **Ground / working colour:** near-black instrument-panel anthracite `#15171b`; working
  colour amber `#ffb02e` (the annunciator-tile colour common to all three photos) plus a
  cyan-green readout colour `#5fe0c8` for live numeric data (matches the glass-cockpit
  FMS text).
- **Two faces:** `Big Shoulders Display` (condensed industrial stencil, for tile captions
  and the verdict annunciator — reads like panel silkscreen) + `IBM Plex Mono` (for every
  numeric/time/tool-call readout — reads like a digital gauge).
- **State without red vs green:** each check/evidence item is a rectangular caption tile;
  UNVERIFIED/FAILED/FLAGGED tiles are LIT (bright amber fill, black bold text, small white
  glow) exactly like a real annunciator segment; unlit/inactive tiles stay dim outline-only
  grey. The active agent-state pill is the one lit in the strip; the rest are dim. Position
  and brightness carry the state, never hue alone.
- **The one thing a judge remembers:** the verdict is a single oversized backlit
  annunciator tile — "WIRE FROZEN" — sitting above a wall of small dim gauges, exactly like
  a master-caution light going off mid-panel.

## 2 · Broadcast control room
- **Traces to:** `02-c-span_control_room.jpg` (a monitor wall with a red digital
  EST/GMT clock, text labels under every panel, blue desk-accent lighting), `08-modern-mixing-console--3296144.jpg`
  (a fader bank with red LED tally lights glowing above each channel — state read by
  illumination), `07-faders-of-a-mixing-console--46.jpg` (linear vertical faders at
  different heights against a ruled scale — state read by physical position).
- **Ground / working colour:** near-black gallery charcoal `#0b0d10` with the desk's blue
  accent wash `#123249` behind panel groups; working colour a warm tally-lamp amber/white
  `#ffd166` used only for "lit" states, never as a pass/fail red-green pair.
  digital clock/timecode digits render in red `#ff3b30` — matching the C-SPAN clock — but
  that red is used for the running call-timer ONLY, never for a verdict.
- **Two faces:** `Oswald` (condensed broadcast-signage sans, for monitor labels and the
  ON-AIR verdict sign) + `IBM Plex Mono` (for the timecode and tool-feed log lines, reads
  like the console's own EST/GMT readout).
- **State without red vs green:** the transcript side carries two vertical bar-graph level
  meters (caller / Countersign) whose HEIGHT and a printed peak number are the signal;
  each check on the right is a fader-style row with a small tally lamp that is either LIT
  (filled, glowing) or OFF (hollow ring) plus its own printed finding word. The verdict is
  an edge-lit rectangular ON-AIR-style sign, illuminated vs dark, with the word "FROZEN"
  printed large regardless of colour.
- **The one thing a judge remembers:** the two big live level meters on the left, one
  pegged and one flat silent at the exact moment of the barge-in, next to the illuminated
  ON-AIR-style FROZEN sign on the right.

## 3 · Chain of custody / signed record
- **Traces to:** `21-fbi-rubber-stamps.jpg` (classification hierarchy carried entirely by
  WORDING — SECRET vs CONFIDENTIAL vs TOP SECRET — stamped in dark ink, no colour coding),
  `23-uss-sanjacinto-decklog.jpg` (a CONFIDENTIAL stamp top-left, dense single-spaced
  typewritten log entries, and four separate handwritten officer signatures closing out
  each watch — the countersign chain made visible on one page), `19-security-bag-tape-voiding.jpg`
  (a tamper-evident seal whose own pattern breaks apart the moment it's opened — the
  physical ancestor of "sealed evidence record").
- **Ground / working colour:** archival parchment cream `#efe6d2`; the one working colour
  is stamp ink, a dark brick-red `#8a2e1f` (matches the FBI stamps' impression colour, kept
  deliberately far from a "green" so it never reads as a pass/fail pair with anything else
  on the page).
- **Two faces:** `Special Elite` (worn typewriter/stamp face, used ONLY for the big rotated
  verdict stamp and the row-status stamps) + `Courier Prime` (clean typewriter monospace,
  for the transcript-as-deposition with line numbers and the ledger body — matches the
  deck log's single-spaced typewritten entries).
- **State without red vs green:** every check on the right is a ruled ledger line ending in
  a hand-stamped WORD (UNVERIFIED / FAILED / FLAGGED / NO RESPONSE), each stamp slightly
  rotated and inked, exactly like the FBI stamp photo — hierarchy is the word itself plus
  stamp weight, never a colour swap.
- **The one thing a judge remembers:** the oversized "FROZEN" stamp punched diagonally over
  the verdict block, ink slightly imperfect, sitting above a line that reads like a real
  notarization: "sealed evidence record #a41f…9c" with a signature rule under it.

## 4 · Oscilloscope
- **Traces to:** `05-oscilloscope-tektronix-456b-img-7953.jpg` (etched cyan graticule grid,
  organized knob rows, red accent selector switches, small etched panel labels),
  `09-lissajous-figure.png` (bright lime-green phosphor trace on a dark screen — proof
  phosphor colour is a named, specific green, not a generic "cyan"), `08-my-friend-oscilloscope.jpg`
  (two live colour-coded traces — yellow and magenta — overlaid on a navy grid, with a
  digital on-screen readout panel of channel data).
- **Ground / working colour:** near-black CRT bezel `#0a0d0b` with an etched grid line grey
  `#294038`; the ONE working colour is phosphor green `#39ff8a` (named: "phosphor green",
  traced directly to the Lissajous photo) used for the Countersign trace and every locked
  readout; the caller's live trace uses a second, clearly distinct amber `#ffb020` (not red,
  not green) so the two live traces are never a red/green pair.
- **Two faces:** `JetBrains Mono` (etched-label and readout monospace, used everywhere —
  matches the stenciled panel typography in all three photos) + `Big Shoulders Display`
  (only for the very large locked verdict readout, so it reads from across a room like a
  scope in HOLD mode).
- **State without red vs green:** state is trace BRIGHTNESS and LINE WEIGHT — the locked
  verdict trace is thick, bright, flat and pinned at the top of its graticule cell; every
  other measurement trace is thin and dim. The barge-in is a visible spike breaking the
  caller's trace, labelled "interrupted at 03:12" directly on the grid.
- **The one thing a judge remembers:** the two live traces racing across the top graticule
  — one amber, one phosphor-green — until the amber trace spikes and dies at the barge-in,
  and the bottom readout locks to a single bright green flatline reading "FROZEN."

## 5 · Air-traffic strips
- **Traces to:** `12-strip-generic.jpg` (a clean machine-printed monospace strip on tan
  card stock, with one small handwritten correction overriding a printed field — the
  baseline grammar), `04-fichas-progreso-vuelo-almeria.jpg` (three strips stacked in a bay
  at consistent spacing, printed monospace fields, and a bold hand-drawn arrow on the right
  margin meaning "moved"), `01-french-flight-strip-2008.jpg` (a single strip with printed
  grid fields and heavier handwritten pen marks crossing several cells, tan paper).
- **Ground / working colour:** dark console-rail grey `#34322c` behind the strip bays; the
  strips themselves are tan card `#ecdfc0`; the one working colour is hand-ink blue-black
  `#22314a` (matches the pen marks in the French strip photo) used for every handwritten
  annotation and correction.
- **Two faces:** `Space Mono` (the printed monospace fields — callsign, tool name, time,
  finding — matches the dot-matrix printed baseline in all three photos) + `Caveat`
  (a real handwriting face, for every annotation, correction, and the hand-drawn move
  arrows, so the printed/handwritten contrast reads exactly like the source strips).
- **State without red vs green:** each tool call and evidence item is one printed strip
  sitting in a numbered bay; a strip's state is shown by (a) a hand-marked word written
  over its printed finding field, (b) a thick hand-drawn arrow when it moves bay, and
  (c) which bay it currently sits in — CHECKS bay lower, VERDICT bay top. No strip uses a
  colour fill to mean pass/fail.
- **The one thing a judge remembers:** the verdict strip physically pulled up and turned
  90° at the top of the board, oversized against the other strips, with "FROZEN" written
  across it in heavy hand ink and a fat arrow pointing up at it from the checks bay.

## 6 · Swiss departure board
- **Traces to:** `02-Winterthur-Departure-Board-1.jpg` (strict column discipline — time |
  destination | platform | remarks — hierarchy carried by position and text weight, a
  small yellow accent label for special sectors, a real railway clock inset), `08-NJT-Solari-Column-Detail.jpg`
  (individual split-flap cards, black text on bright yellow, hairline row dividers, cards
  mid-flip showing the mechanical letterforms), `06-Paris-Nord-Flap-Display.jpg` (a dense
  yellow-on-dark grid of rows read at distance by real commuters — proof of the legibility
  bar this look has to hit).
- **Ground / working colour:** dark signage navy-black `#12151c`; the ONE working colour is
  split-flap yellow `#ffc72c` (present in all three photos) used only for weight/emphasis
  and the verdict row, never mixed with a second "status" colour.
- **Two faces:** `Fira Sans Condensed` (a real condensed signage sans with tabular figures,
  for every column label and row — deliberately NOT Inter or Space Grotesk) + `Fira Mono`
  (tabular numerals only, for the time column and the call clock, matching the boxed digit
  cells on the split-flap cards).
- **State without red vs green:** every row carries a small filled-vs-empty square glyph
  (■ vs □) before the finding word, plus font WEIGHT — normal weight for a routine tool
  call, heavy weight for a failed check — and the verdict is simply the top row, set in the
  heaviest weight the page uses, exactly like a delayed train pushed to the top of a real
  board.
- **The one thing a judge remembers:** the verdict sitting as the single heaviest, largest
  row at the very top of a perfectly ruled table, the way a "CANCELLED" service reads on a
  real departure board — no icon, no colour trick, just weight and position.

---

## What I could not do
- Could not verify how these six pages will look on the founder's actual monitor/colour
  vision — self-check below is Playwright + my own reading of the rendered pixels only.
  WCAG-contrast is not run mechanically per world; I eyeballed each palette for contrast
  against its own ground colour and kept ink/verdict text large and heavy per the brief's
  20px floor, but this is not a machine-verified contrast pass.
- The photo thumbnails embedded on `index.html` are re-encoded to small JPEG data URIs for
  size — they are for recognition only, not archival quality.
