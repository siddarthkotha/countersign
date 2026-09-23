# Countersign, session snapshot (overwritten at every close; never appended)

Last close: Wednesday 2026-09-23, 1:58 PM CDT (Day 14; the session ran from Tuesday 6:28 PM
through the night on autopilot). Live: e2c7bdb, "one voice" (endpoint) mode ON.

## The one-paragraph version

Tuesday evening the founder's three live calls all failed; two rounds of an external AI panel
(docs/PANEL-2026-09-22-LIVE-RELIABILITY.md) converged that two voices per call (AssemblyAI's
automatic reply plus our instructed replies) caused the repeat bugs. He ruled option (ii): the
recorded call is the primary judge path. Overnight: the replay now plays his real recorded
calls with both voices in step (Web Audio), and the "one voice" design was spiked, planned,
red-teamed and built in reviewed pieces: AssemblyAI's "connect your own LLM" calls our
/api/brain/chat/completions for every reply, and our deterministic engine writes every word.
Live trials: the first failed (a per-goal session.update erased the per-call token), the second
failed one case (no speech trigger on the idle-timeout verdict), the third passed 3 consecutive
clean runs of all three demo scenarios. The judge site was switched at 7:37 AM and passed one
run of each case there (zero repeats, zero talk-over, one goodbye). The founder has NOT yet
tried one-voice with his own voice: no AssemblyAI session exists after 7:42 AM (PROVEN at
1:57 PM), so the noon video decision is still open.

## Founder rulings (2026-09-22/23)
- Option (ii): recorded call primary, live labeled "Try it live (experimental)" (landing A).
- His own voice may be public in the replay.
- Keep Thursday Sep 24 as the submit target; decide at noon Wednesday (not yet decided).
- Yes to a third live trial on Wednesday morning (it passed).

## PROVEN at this close
- Live e2c7bdb: /version 200 at 1:57 PM; brain route 401 without auth (mounted); stored agent
  countersign-brain present. render.yaml: COUNTERSIGN_BRAIN=endpoint (+ generated key, public
  URL). ROLLBACK = set COUNTERSIGN_BRAIN to "legacy" in render.yaml and push.
- Gate on main: typecheck clean, 2656/2656 tests on 131 files.
- Real-site check 7:41-7:44 AM: dana-patient STAGE, scenario-b-miller-fraud FREEZE,
  single-wrong-answer ESCALATE, all PASS, zero experience defects, endpoint mode in every bundle.
  It stopped early on a turn-gap rule: the test caller repeated itself every 2-3 s and
  AssemblyAI's max_accuracy turn detection held one caller turn open; reply started 0.1 s after
  that turn ended (not Render buffering).
- Laptop-copy trials: 3 consecutive clean runs per case (reports 2026-09-23T06-46 .. 07-32).

## Known issues and risks
- Only one real-site run per case; no human voice on one-voice yet.
- The escalate case reaches its verdict only after ~30 s of caller silence (idle timer): slow on
  camera; the recorded escalated call in the replay is the safer third outcome for the video.
- Each server restart can leave a duplicate stored agent (two named countersign-brain at 9:23 AM;
  the cold-start list call likely failed). Harmless to calls; do not delete one while the server
  might be using it; fix the bootstrap (longer first-boot timeout or retry) and clean up after.
- Spoken lines are interim plain drafts (brain/spokenLines.ts); founder reacts to real audio.

## Parked for the founder
- WALKER-SELECTED-TAB-CHECK (edit qa-walker/judge-sim definitions); branch deletes for
  worktree-agent-* (hook-blocked); .env.example lines for the turn-detection and brain vars.

## Next session
"Resume: read docs/STATE.md and docs/MORNING-2026-09-23.md. First the founder's 10-minute voice
check of one-voice on the live site (two calls, exact lines in the 9:24 AM message: Dana STAGED,
CEO FROZEN; say each line once and wait). Pull his records from /api/admin/sessions right after.
If both are clean by his ear: record the video on one-voice (escalate from the replay) and keep
Thursday; if not: rollback to legacy with one render.yaml value and record on the recorded calls."
