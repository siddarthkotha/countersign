# Countersign, session snapshot (overwritten at every close; never appended)

Last close: Tuesday 2026-09-22, 3:25 PM CDT (Day 13, which ran 9:14 AM to 3:25 PM in the same
session as Day 12). Autopilot ON throughout. No lanes in flight. No sandboxes on disk.

## The one-paragraph version

Day 13 was fifteen founder calls in five sessions and eight fixes, five of them found by his
voice. Morning: cases 1, 2, 3, 5 all correct; case 3 never said goodbye (the engine has no
CLOSE for OUT_OF_SCOPE; the harness scenario's hang_up flag had hidden it since day one) and
case 2 double-asked the deadline. Both fixed (be63028, 5172a5e, d50450b: the automatic reply
now says the goodbye itself after the explanation, one goodbye, hang-up 3.8 s after his line,
confirmed by his own retry at 2:21 PM). Two more defects from his retries: the idle clock
started at mint, so a slow Start Call got the goodbye before he spoke (a4c1738); and the
first goodbye fix said goodbye three times (d50450b). Afternoon: cases 4 and 8 correct by
verdict, case 6 failed twice because adaptive turn-taking cut his opening at a natural pause
and the agent talked over the rest. Fix live at fb6106c: explicit turn detection with
min_silence 1500 ms, set in render.yaml, PROVEN by the connect event on three harness calls;
the pause-after-name harness case now runs as one turn. Not yet confirmed by his voice. He
closed at 3:20 PM after saying he was angry at the pace; my recommendation was to stop for
the day and do one calm morning session on a settled build.

## PROVEN at this close
- Live: https://countersign-bf8q.onrender.com UP, /health 200, /version fb6106c (3:17 PM).
- Gate on main at fb6106c: typecheck clean, 2433/2433 tests on 122 files, web build clean.
- Founder calls today (records in scripts/rehearse/reports/ are harness only; his records
  live in the session scratchpad and on the server's admin list): case 1 STAGE 8f7fa2f2,
  case 2 FREEZE f01289b6, case 3 NO_ACTION df3f9781 (no goodbye, fixed) then 9f2ae599 (one
  goodbye, 3.8 s), case 5 STAGE a629d046, case 4 FREEZE e4526d7a, case 8 ESCALATE 9ba784c3,
  case 6 STAGE 39dc704a and ff84b7e0 (wrong: approver never registered, turn cut).
- Harness on fb6106c (3:07 to 3:10 PM): dana-patient PASS clean, barge-in-pause-after-name
  PASS clean, barge-in-talk-through-question STAGE with one talk_over at 68 s (trap class).
- Board: 357 items, 301 done, 56 held, none running.

## Switches that exist now (all off unless set)
- COUNTERSIGN_FILLER_MODE = one_moment (default) | direct | none (a9c4897), prompt.ts.
- COUNTERSIGN_TURN_DETECTION = omit (default) | explicit; with explicit:
  COUNTERSIGN_MIN_SILENCE_MS, COUNTERSIGN_MAX_SILENCE_MS, COUNTERSIGN_INTERRUPTION_DELAY_MS
  (e04b2dd + fb6106c). render.yaml currently sets explicit + 1500 for the founder's test.
- Local A/B: start `set -a; . ./.env; set +a; COUNTERSIGN_FILLER_MODE=direct npm run dev:server`
  (port 8787), then `npm run rehearse:batch -- --url http://localhost:8787 ...`; analysis
  script at the session scratchpad ab_analyze.py (baseline 19 calls: 6.3 agent lines/call,
  2.16 fillers/call, s/char auto 0.086 ours 0.079, wall median 80 s).

## Parked for the founder
- .env.example lines for the three turn-detection env vars (15 lines) are saved outside the
  repo; the pre-commit gate blocks any commit while .env.example differs from HEAD.
- The pacing experiment (option 2) has not run yet; the switch is in place.

## Open, in the order to take them
1. MORNING: one 3-run check on dana-patient, single-wrong-answer, identity-switch on the
   current deploy (min_silence 1500). Then the founder's twenty minutes: case 6 first, then
   1 with a pause, 4, 2, 3. If case 6 escalates and nothing cuts him off, freeze.
2. If the 1500 ms wait feels too long to him: try 1200 (render.yaml value), re-prove via the
   connect event, one more case 6 from him.
3. Filler A/B (local, harness) any time the line is free; numbers to him before the freeze
   decision.
4. Wednesday: README final pass (done tonight: numbers, laws, try-it block), preflip dry run
   (done 2026-09-21; the private-reference grep terms stay in local memory), record the video.
5. Thursday Sep 24: judge-sim on the package, submit. Buffer to Sep 30.
6. Residuals held: TALK-OVER-AFTER-TRAP-CORRECTION (now 4 of 20 calls today), ECHO-PHANTOM-
   CALLER-LINE, AMBIENT-REPEATED-READBACK-AFTER-STRAY-CONFIRMATION, AMBIENT-DOUBLE-TURN-END-
   REPEAT (chained duplicate, 1 of 46), OUT-OF-SCOPE-GOODBYE-NEEDS-RETRY (moot on d50450b),
   MIC-TRACK-SETTINGS-NOT-RECORDED, BARGE-IN-FLUSH-LAG, CASE11-GOODBYE-RETRY-FOUNDER.

## Cadence rules in force
Never push while a founder or harness call is in flight; settle 60 s after the version
matches before a live check; remove a lane's sandbox the minute its files land (a resumed
lane can lose its sandbox and edit the main checkout: re-gate on main is the proof); full
batches only before a founder session or after a bundle of fixes.

## Next session
"Day 14 resume: read docs/STATE.md, then the tail of docs/AUTOPILOT_LOG.md from the
2026-09-22 9:50 AM entry. Live is fb6106c (explicit turn detection, min_silence 1500).
First: confirm /health and /version, run a 3-run check on dana-patient, single-wrong-answer,
identity-switch and read turn_detection_sent on each, then hand the founder the case 6
script. Freeze if his five paths are clean. Filler A/B only when the line is free."
