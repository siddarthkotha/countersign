# Countersign, session snapshot (overwritten at every close; never appended)

Last close: Friday 2026-09-25, ~11:58 PM CDT (Day 16). SUBMITTED to lablab by the founder
(~11:30 PM). Live: 9ba1ced (one-voice endpoint mode, greeting asks for the name, judge cheat sheet).

## The one-paragraph version

The founder's voice check exposed two defects: AssemblyAI cut his first sentence mid-speech, and a
"Right now." answer was ignored so the deadline question repeated. Offline tests streaming his
recorded voice proved no turn setting fixes the first-turn cut (13/13 cut as a first turn, 3/3
whole after a short name line), so the greeting now asks "Who am I speaking with?". Fixed and
live: immediate-time deadline answers, a verbatim re-ask guard, a beneficiary answer window with a
date-word guard, duplicate stored agents on boot, a judge cheat sheet on the role cards and call
screen. He recorded both video calls first try; the 2:52 video, deck, README and submission text
were built, reviewed and published; repo is public; submission done.

## PROVEN at this close

- Live 9ba1ced, /health 200; 7/7 live harness calls PASS with experience 0/0/0/0 at 11:07-11:15 PM
  (judge-dana-move, judge-dana, judge-ceo, dana-patient, scenario-b-miller-fraud,
  single-wrong-answer, barge-in-interrupt). Gate on main: 2734/2734, typecheck clean.
- One stored AssemblyAI agent (countersign-brain, agent_00448cb2...). Credits $41.37 (founder).
- Video https://youtu.be/9koOgcfhYfE on channel Countersign (@Countersign-d8t), unlisted
  (YouTube oEmbed author Countersign). Repo public (logged-out 200).
- Lablab draft filled and saved 11:24 PM; the founder pressed Submit; the public project page
  shows the submission text.
- Everything local-only consolidated into `_local/` (gitignored; see `_local/README.md`), copied
  to the Mac mini at `~/countersign` (verification in the log).

## Lablab form facts (for any later edit)

Short description 235/255 chars, long 1599/2000; categories Security, Finance, Assistant;
technology "Claude Code" (no AssemblyAI option exists); platform "Other" (no Render option).

## Known issues and risks

- The video opens with the old greeting ("How can I help you today?"); founder ruled it fine.
- Recorded replays (Sep 22) carry the old greeting and earlier agent wording; outcomes are the same.
- HARNESS-STALL-AFTER-FIRST-INTERRUPT: a non-patient harness caller that barges into the first
  reply loses its event stream (ESTIMATE harness-only; real Chrome survived interruptions).
- QUESTION_ASKED_MAX=2 stops logging after two identical renders (session.ts ~964, FOUND BUT NOT FIXED).
- Render free plan sleeps: first load after idle ~20-60 s.
- The other product's name remains in 8 old commit messages (founder ruling: no history rewrite).

## Next session

"Resume: nothing is required before judging. Keep Render, the AssemblyAI key, GitHub, the YouTube
video and the lablab submission alive until judging ends; do not push risky changes. The founder
deletes the laptop copies (Desktop folders and recordings, this repo) after Sep 30; the Mac mini
copy at ~/countersign is the keeper."
