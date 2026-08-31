# Countersign — three looks, design log (2026-08-30)

Same content.json, same screen (Scenario B climax, verdict FROZEN), three real-world
visual sources. Six-line plan per look, written before CSS, then built to that plan.

## Look A — "Looks like a signed evidence record"
1. Source: chain-of-custody log / ship's deck log / countersigned paper forms.
2. Ground: archival paper #f3efe3 (warm, slightly aged). Working colour: oxblood ink
   #7a2323 (used ONLY for stamps — one colour, not colour-coded per result).
3. Faces: "Courier Prime" (Google Fonts, real typewriter face) for the ledger/records
   side — it reads as struck type; "Source Serif 4" for the transcript — it reads as a
   typed deposition, not a UI.
4. State without red/green: every result is a rotated, bordered rubber-stamp block of
   the SAME ink colour, differentiated by the WORD stamped (FAILED / UNVERIFIED / NO
   RESPONSE) and by weight; the state-machine steps are checked boxes (☑) vs empty
   boxes (☐), never colour; FROZEN is the largest stamp on the page, double-ruled.
5. What a judge remembers: the oversized rotated FROZEN stamp with the sealed-hash
   signature line underneath it — this looks like an artifact from a real
   investigation, not a demo screen.
6. Could not do: true ink-bleed/paper-grain texture (kept flat colour, no image
   assets, to respect the no-network-images / self-contained rule) — a subtle
   background gradient stands in for it.

## Look B — "Looks like a live control desk"
1. Source: broadcast control room vision-mixer wall + flight-deck caption/annunciator
   panels.
2. Ground: near-black #0b0e11. Working colour: amber/phosphor #ffb400 (single accent;
   luminance carries the state, not hue — colour-blind safe by construction per WCAG
   luminance contrast, no red/green pairing used anywhere).
3. Faces: "Oswald" (condensed industrial) for captions/tiles/labels; "IBM Plex Sans"
   for the transcript body — plain enough to read as dialogue against the caption
   grid.
4. State without red/green: agent-state tiles are LIT (bright fill, bold) vs DIM
   (10% opacity, thin outline) — only the current state is lit; tool-call tally lamps
   are filled circles (fired) vs empty rings; the verdict is a physically larger,
   backlit marquee block, not a colour swap.
5. What a judge remembers: the two live level meters going quiet the instant the
   FREEZE RAIL control latches — "you can see it listening and see it stop."
6. Could not do: real animated VU-meter motion (this is a static frame); represented
   as a segmented bar at a fixed live-looking level plus a small "LIVE" tag.

## Look C — "Looks like a departure board"
1. Source: Swiss railway split-flap departure board + air-traffic paper strips.
2. Ground: board-black #14161a. Working colour: signal amber #ffcc33 (one accent
   only, the classic Solari-board colour; everything else is white/grey text on
   black).
3. Face: "Archivo Narrow" throughout (grotesque/condensed, built for signage-density),
   bold weight for the verdict row and stamped/heavier findings, regular weight
   elsewhere — deliberately not Inter or Space Grotesk. Tabular numerals
   (font-variant-numeric: tabular-nums) on every timestamp and figure.
4. State without red/green: status carried by weight + case + a filled (●) vs empty
   (○) marker in a fixed status column — FAILED/UNVERIFIED/NO RESPONSE are bold
   uppercase with a filled marker, everything else is regular weight with an empty
   marker; the verdict is the single heaviest, largest row on the board.
5. What a judge remembers: the calm, perfectly aligned grid of rows — nothing
   decorative, every fact sits in its own column, the way you'd trust a real
   departures board over an dashboard.
6. Could not do: physical split-flap animation (static frame); represented with a
   thin rule under each row to suggest the flap seam.
