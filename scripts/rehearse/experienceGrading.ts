// scripts/rehearse/experienceGrading.ts
// PROVEN process defect (2026-09-18, founder's records under scripts/rehearse/reports/
// founder-2026-09-18/): the rehearsal harness reported PASS on all four of that morning's
// calls (the four 10-52..10-57 reports) while the founder, replaying the same build live,
// heard "keeps asking the same questions", "does not let me complete my sentence",
// "repeated questions, lame quality", and quit. run.ts's own grading only ever checked
// verdict, wall time, the close line, and a handful of opt-in scenario expectations -- none
// of it could ever fail what he actually heard.
//
// This module computes an EXPERIENCE GRADE straight from a diagnostics bundle (the same
// shape `GET /api/session/<id>/diagnostics` returns, types.ts's `RehearseDiagnosticBundle`)
// -- never from a live call, never from a copy of the engine -- so the exact same function
// grades a fresh harness run's own fetched bundle, a founder's recorded bundle read off
// disk, or an old report's sibling `.diagnostics.json` re-read later (regrade.ts). Every
// check here is pure and takes only `server_events` (each `{t_ms, kind, detail}`, PROVEN
// shape: packages/server/src/diagnostics.ts) -- no CallClient, no network, no filesystem.
//
// Named checks (spec: SONNET-JUSTIFIED build lane, 2026-09-18):
//  1. repeated_question  -- the same readback field or challenge id spoken more than once.
//  2. merged_reply       -- two sentences interleaved/run together in one agent line.
//  3. talk_over          -- the AGENT starts talking over (or immediately after a very short)
//                            caller utterance. Never the reverse (a caller barge-in on the
//                            agent is fine and expected -- see barge-in-interrupt.json).
//  4. holding_spam       -- more than one bare "One moment." per caller turn (always gates),
//                            or one whose gap to the next transcript event exceeds 8s (gates;
//                            a shorter gap is ordinary AssemblyAI latency, not a defect -- see
//                            `holdingSpam`'s own doc comment, founder correction 2026-09-18).
//                            The full gap distribution (`hold_gap_max_s`/`hold_gap_p50_s`) is
//                            reported informationally regardless of whether it gates.
//  5. question_lag       -- SKIPPED (see `questionLag`'s own doc comment): the bundle shape
//                            gives a `transcript` event no `reply_id`, so a spoken line can
//                            only be matched to the goal that most recently logged an
//                            `action_logged` event, never to whichever goal was CURRENT at
//                            the moment the audio actually played. Not detectable from this
//                            bundle shape; this is stated here rather than guessed at.
//  6. goodbye_delay      -- informational only (seconds from `terminal_action` to the close
//                            line actually being spoken, and whether a close_retry fired).
//
// `experienceOk` (repeated_question = 0 AND merged_reply = 0 AND talk_over = 0 AND
// holding_spam = 0) is the new PASS gate every scenario's grading adds on top of (never
// instead of) the base verdict/max_wall_ms/expectations.ts/close-line checks run.ts already
// had -- see run.ts's own `pass` computation. No scenario-level override field exists: tested
// directly against barge-in-interrupt.json's own real bundle and confirmed unnecessary --
// `talk_over` only ever measures the AGENT cutting off the CALLER, never the reverse, so the
// scenario's own designed caller-interrupts-agent mechanic was never at risk of a false
// positive in the first place.
import type { RehearseDiagnosticBundle, RehearseDiagnosticEvent } from './types.js';

export interface TimestampedCount {
  count: number;
  /** Seconds (not ms) since the call's own connect, one decimal place -- matches how every
   *  PROVEN example in the spec that produced this file was itself written ("57.8s"). */
  timestamps_s: number[];
}

export interface QuestionLagResult extends TimestampedCount {
  skipped: boolean;
  skip_reason: string | null;
}

export interface GoodbyeDelayResult {
  seconds: number | null;
  close_retry_needed: boolean;
  note: string;
}

/** Founder correction (2026-09-18, coordinator relay): `count`/`timestamps_s` are now ONLY
 *  the gating violations (a repeated bare holding line within one caller turn, or a
 *  holding-to-substantive gap over `HOLDING_GAP_FAIL_THRESHOLD_MS`) -- `hold_gap_max_s`/
 *  `hold_gap_p50_s` are the full latency distribution across every bare holding line that had
 *  a measurable follow-up, reported for visibility but never gating on their own. `null` when
 *  no bare holding line with a measurable follow-up ever occurred. */
export interface HoldingSpamResult extends TimestampedCount {
  hold_gap_max_s: number | null;
  hold_gap_p50_s: number | null;
}

export interface ExperienceGrade {
  repeated_question: TimestampedCount;
  merged_reply: TimestampedCount;
  talk_over: TimestampedCount;
  holding_spam: HoldingSpamResult;
  question_lag: QuestionLagResult;
  goodbye_delay: GoodbyeDelayResult;
  /** repeated_question.count === 0 && merged_reply.count === 0 && talk_over.count === 0 &&
   *  holding_spam.count === 0 -- the four checks the spec names as PASS-gating. `question_lag`
   *  (skipped, see above) and `goodbye_delay` (informational) never affect this. `holding_spam`
   *  itself is now a NARROWER count (see `HoldingSpamResult`'s own doc comment) -- its own
   *  `hold_gap_max_s`/`hold_gap_p50_s` fields never affect `ok`. */
  ok: boolean;
}

function toSec(t_ms: number): number {
  return Math.round(t_ms) / 1000;
}

function detailOf(e: RehearseDiagnosticEvent): Record<string, unknown> | null {
  return typeof e.detail === 'object' && e.detail !== null ? (e.detail as Record<string, unknown>) : null;
}

interface AgentTranscriptEvent {
  t_ms: number;
  text: string;
}

interface UserTranscriptEvent {
  t_ms: number;
  text: string;
}

interface SpeechWindow {
  started_ms: number;
  stopped_ms: number | null;
}

interface ActionLoggedEvent {
  t_ms: number;
  /** 'readback_issued' or 'challenge_issued' -- the two kinds `expectations.ts`/report.ts
   *  already treat as "tool_call"-adjacent action events (PROVEN kinds, see
   *  diagnosticsSummary.ts's `TOOL_KINDS`). Every other `action_logged.kind` (e.g.
   *  `terminal_action`-adjacent ones logged elsewhere) is ignored here. */
  kind: 'readback_issued' | 'challenge_issued';
  /** The grouping key: `field` for a readback, `challenge_id` for a challenge. */
  key: string;
}

function extractAgentTranscript(bundle: RehearseDiagnosticBundle): AgentTranscriptEvent[] {
  const out: AgentTranscriptEvent[] = [];
  for (const e of bundle.server_events) {
    if (e.kind !== 'transcript') continue;
    const d = detailOf(e);
    if (!d || d.role !== 'agent' || typeof d.text !== 'string') continue;
    out.push({ t_ms: e.t_ms, text: d.text });
  }
  return out;
}

function extractUserTranscript(bundle: RehearseDiagnosticBundle): UserTranscriptEvent[] {
  const out: UserTranscriptEvent[] = [];
  for (const e of bundle.server_events) {
    if (e.kind !== 'transcript') continue;
    const d = detailOf(e);
    if (!d || d.role !== 'user' || typeof d.text !== 'string') continue;
    out.push({ t_ms: e.t_ms, text: d.text });
  }
  return out;
}

function extractActionLogged(bundle: RehearseDiagnosticBundle): ActionLoggedEvent[] {
  const out: ActionLoggedEvent[] = [];
  for (const e of bundle.server_events) {
    if (e.kind !== 'action_logged') continue;
    const d = detailOf(e);
    if (!d) continue;
    if (d.kind === 'readback_issued' && typeof d.field === 'string') {
      out.push({ t_ms: e.t_ms, kind: 'readback_issued', key: `readback:${d.field}` });
    } else if (d.kind === 'challenge_issued' && typeof d.challenge_id === 'string') {
      out.push({ t_ms: e.t_ms, kind: 'challenge_issued', key: `challenge:${d.challenge_id}` });
    }
  }
  return out;
}

/** Every caller speech window (`input.speech.started` .. `input.speech.stopped`), in order.
 *  A window missing its own `stopped` (the call ended mid-utterance) is given `stopped_ms:
 *  null` so `talk_over` can still treat "still open" correctly rather than throwing. */
function extractSpeechWindows(bundle: RehearseDiagnosticBundle): SpeechWindow[] {
  const windows: SpeechWindow[] = [];
  let open: SpeechWindow | null = null;
  for (const e of bundle.server_events) {
    if (e.kind === 'input.speech.started') {
      open = { started_ms: e.t_ms, stopped_ms: null };
      windows.push(open);
    } else if (e.kind === 'input.speech.stopped' && open !== null) {
      open.stopped_ms = e.t_ms;
      open = null;
    }
  }
  return windows;
}

/** Check 1: `repeated_question`. Groups every `readback_issued`/`challenge_issued`
 *  `action_logged` event by its field/challenge id, across the WHOLE call (not only
 *  consecutively) -- PROVEN (32cbb410, 95b9ad42): the founder's own repeats were not always
 *  adjacent in the action-event stream (other fields' readbacks interleave), and the
 *  approver LIVE_COMMITMENT challenge in 95b9ad42 was re-asked a third and fourth time with a
 *  caller line in between each ("I did not mention anyone.") that never actually answered
 *  it -- exactly what the founder heard as "keeps asking the same questions" regardless of
 *  whether he said anything in between. Every occurrence after a key's first is a repeat;
 *  its own event timestamp is reported. */
export function repeatedQuestion(bundle: RehearseDiagnosticBundle): TimestampedCount {
  const seen = new Map<string, number>();
  const timestamps: number[] = [];
  for (const a of extractActionLogged(bundle)) {
    const n = (seen.get(a.key) ?? 0) + 1;
    seen.set(a.key, n);
    if (n > 1) timestamps.push(toSec(a.t_ms));
  }
  return { count: timestamps.length, timestamps_s: timestamps };
}

/** Check 2: `merged_reply`. Flags an agent transcript line as merged when ANY of:
 *   a) a sentence-ending mark (`.`/`?`/`!`) is immediately followed by an uppercase letter
 *      with NO space between them -- PROVEN (harness 10-54-17 18.1s: "...Is that correct?One
 *      moment...", 10-57-25 21.6s: "...number.Just to confirm..."). Ordinary engine-composed
 *      text always has a space after sentence punctuation; this never fires on it.
 *   b) a lowercase letter is immediately followed by an uppercase letter WITHIN what should
 *      be a single word (no space) -- PROVEN (391e2a37/32cbb410 "NorthOne", 95b9ad42
 *      "toOne"): two replies' audio got word-interleaved without even a word-boundary space,
 *      including "One moment" itself splicing into the middle of another word.
 *   c) the exact phrase "is that correct" appears twice (case-insensitive) in one line --
 *      two readback questions spliced into one utterance.
 *  Any one match is enough; a line is counted once even if more than one heuristic fires. */
export function mergedReply(bundle: RehearseDiagnosticBundle): TimestampedCount {
  const PUNCT_THEN_CAP = /[.?!][A-Z]/;
  const MIDWORD_CAP = /[a-z][A-Z]/;
  const timestamps: number[] = [];
  for (const line of extractAgentTranscript(bundle)) {
    const text = line.text;
    const lower = text.toLowerCase();
    const correctCount = lower.split('is that correct').length - 1;
    const merged = PUNCT_THEN_CAP.test(text) || MIDWORD_CAP.test(text) || correctCount >= 2;
    if (merged) timestamps.push(toSec(line.t_ms));
  }
  return { count: timestamps.length, timestamps_s: timestamps };
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Check 3: `talk_over`. An agent `reply.started` event counts as talking over the caller
 *  when either:
 *   a) it falls strictly inside an open caller speech window (`input.speech.started` has
 *      fired, `input.speech.stopped` has not yet, or the window's own stop is later than this
 *      `reply.started`) -- the agent started composing/speaking a NEW reply while the caller
 *      was still mid-utterance; OR
 *   b) it falls within 300ms after the end of a caller utterance whose spoken text was under
 *      three words, AND the caller resumes speaking (a fresh `input.speech.started`) within
 *      2000ms of the agent's `reply.started` -- proof the short utterance was not actually the
 *      caller's whole thought.
 *
 *  Founder correction (2026-09-18, coordinator relay): the original form of (b) -- "any
 *  reply.started within 300ms of a short caller utterance" -- fired on every healthy fast
 *  turnaround too. PROVEN (391e2a37): 49.299s/60.997s/73.702s are all the agent correctly
 *  answering a FINISHED "Yes." with no caller speech following (the call simply moves on) --
 *  not cutoffs. Only 35.8s is a real one: the caller resumes ("Meridian Supply.") at 36.948s,
 *  1148ms after the agent's 35.800s `reply.started` -- well inside the 2000ms window -- proof
 *  the caller had more to say and got cut off. Requiring that resumption signal is what tells
 *  the two apart; word count and gap alone cannot.
 *  Deliberately one-directional: the CALLER interrupting the AGENT (a real barge-in,
 *  `reply.done: "interrupted"`) is the intended, expected mechanic in scenarios like
 *  barge-in-interrupt.json and is never flagged here. */
/** Tolerance (ms) subtracted from a speech window's own end when deciding whether a
 *  `reply.started` genuinely falls "inside" it (case a). Without this, a `reply.started` that
 *  lands 1-10ms before AssemblyAI's own `input.speech.stopped` event -- ordinary event-arrival
 *  jitter between two independent signals, PROVEN harmless (harness 10-54-17T35.334s:
 *  `reply.started` at 35334ms, `input.speech.stopped` at 35338ms, 4ms apart, the caller's own
 *  full "Yes, that's right." transcript had already landed at 35329ms) -- would false-positive
 *  on effectively every fast turnaround. A genuine overlap (the agent starting seconds into a
 *  caller's utterance) clears this easily; a same-instant race between two independent event
 *  sources does not. */
const TALK_OVER_WINDOW_TOLERANCE_MS = 50;

/** How soon after the agent's `reply.started` a fresh caller `input.speech.started` must land
 *  to count as "the caller resumed" for case (b) -- see `talkOver`'s own doc comment for the
 *  PROVEN 391e2a37 timing this was tuned against (1148ms). */
const TALK_OVER_RESUME_WINDOW_MS = 2000;

export function talkOver(bundle: RehearseDiagnosticBundle): TimestampedCount {
  const windows = extractSpeechWindows(bundle);
  const userLines = extractUserTranscript(bundle);
  const timestamps: number[] = [];

  for (const e of bundle.server_events) {
    if (e.kind !== 'reply.started') continue;
    const t = e.t_ms;

    const withinOpenWindow = windows.some(
      (w) => t >= w.started_ms && (w.stopped_ms === null || t < w.stopped_ms - TALK_OVER_WINDOW_TOLERANCE_MS),
    );
    if (withinOpenWindow) {
      timestamps.push(toSec(t));
      continue;
    }

    // Most recent caller utterance that ended at or before this reply.started.
    let nearest: UserTranscriptEvent | null = null;
    for (const u of userLines) {
      if (u.t_ms <= t && (nearest === null || u.t_ms > nearest.t_ms)) nearest = u;
    }
    if (nearest && t - nearest.t_ms <= 300 && wordCount(nearest.text) < 3) {
      // Only a real cutoff if the caller actually had more to say -- proven by a fresh speech
      // window starting soon after the agent began talking.
      const callerResumed = windows.some((w) => w.started_ms > t && w.started_ms <= t + TALK_OVER_RESUME_WINDOW_MS);
      if (callerResumed) {
        timestamps.push(toSec(t));
      }
    }
  }

  return { count: timestamps.length, timestamps_s: timestamps };
}

/** Threshold (ms) above which a bare holding line's gap to the next transcript event gates
 *  FAIL (see `holdingSpam`'s doc comment for why this is 8s, not the original 4s). */
const HOLDING_GAP_FAIL_THRESHOLD_MS = 8000;

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** Check 4: `holding_spam`. A bare holding line is an agent transcript line whose trimmed
 *  text, case-insensitively, is exactly "one moment." (nothing else). Two things are
 *  measured:
 *   a) the gap from every bare holding line to the next transcript event of any kind --
 *      reported as `hold_gap_max_s`/`hold_gap_p50_s` (informational, the full distribution),
 *      and counted as a GATING violation only when that gap exceeds
 *      `HOLDING_GAP_FAIL_THRESHOLD_MS` (8s), or the holding line is never followed by
 *      anything at all before the call ends.
 *
 *      Founder correction (2026-09-18, coordinator relay): the original 4s threshold measured
 *      AssemblyAI's own ordinary latency between the holding beat and our instructed reply,
 *      not a defect -- PROVEN (391e2a37 53.228s to 58.697s, a 5.469s gap) is a HEALTHY call
 *      shape, not the founder's "does not let me complete my sentence" complaint (that's
 *      `talk_over`'s job). 8s is chosen as a generous ceiling above every gap this module was
 *      built and tested against, so ordinary AssemblyAI latency never gates FAIL on its own.
 *   b) a SECOND (or later) bare holding line spoken before the next caller utterance, when
 *      more than one already occurred for that same caller turn -- unchanged, still always
 *      gates. */
export function holdingSpam(bundle: RehearseDiagnosticBundle): HoldingSpamResult {
  const agentLines = extractAgentTranscript(bundle);
  const isBareHolding = (text: string) => text.trim().toLowerCase() === 'one moment.';
  const allTranscriptTimes = bundle.server_events
    .filter((e) => e.kind === 'transcript')
    .map((e) => e.t_ms)
    .sort((a, b) => a - b);
  const userStops = extractUserTranscript(bundle).map((u) => u.t_ms);

  const flagged = new Set<number>();

  // (b) more than one bare holding line since the last caller line (i.e. within one caller
  // turn): walk agent lines in order, tracking how many caller lines have landed so far --
  // a bare holding line whose count hasn't advanced since the previous bare holding line is
  // a repeat within the same turn.
  let lastPriorUserCountForHolding: number | null = null;
  for (const line of agentLines) {
    if (!isBareHolding(line.text)) continue;
    const priorUserCount = userStops.filter((t) => t <= line.t_ms).length;
    if (lastPriorUserCountForHolding !== null && priorUserCount === lastPriorUserCountForHolding) {
      flagged.add(line.t_ms);
    }
    lastPriorUserCountForHolding = priorUserCount;
  }

  // (a) gap to the next transcript event -- gates only past HOLDING_GAP_FAIL_THRESHOLD_MS (or
  // no follow-up at all); every MEASURABLE gap (a next event actually arrived) also feeds the
  // informational max/p50 stats below.
  const gapsMs: number[] = [];
  for (const line of agentLines) {
    if (!isBareHolding(line.text)) continue;
    const next = allTranscriptTimes.find((t) => t > line.t_ms);
    if (next === undefined) {
      flagged.add(line.t_ms);
      continue;
    }
    const gapMs = next - line.t_ms;
    gapsMs.push(gapMs);
    if (gapMs > HOLDING_GAP_FAIL_THRESHOLD_MS) {
      flagged.add(line.t_ms);
    }
  }

  const timestamps = Array.from(flagged).sort((a, b) => a - b).map(toSec);
  const maxGapMs = gapsMs.length > 0 ? Math.max(...gapsMs) : null;
  const medianGapMs = median(gapsMs);
  return {
    count: timestamps.length,
    timestamps_s: timestamps,
    hold_gap_max_s: maxGapMs === null ? null : toSec(maxGapMs),
    hold_gap_p50_s: medianGapMs === null ? null : toSec(medianGapMs),
  };
}

/** Check 5: `question_lag` -- SKIPPED. A `transcript` event (the only place spoken words
 *  appear, PROVEN: every bundle read while building this file) carries only
 *  `{role, length, text}` -- no `reply_id`, no `goal_code`. `action_logged` events DO carry a
 *  `reply_id`, but only for the goal that reply was originally generated to serve, not for
 *  whichever goal was CURRENT at the moment that reply's audio actually finished playing.
 *  There is no field anywhere in this bundle shape that says "this spoken line's audio played
 *  after the engine had already moved to a different goal" -- the closest available signal
 *  (two different action_logged keys logged out of the order their own reply cycles started
 *  in) is already exactly what `repeatedQuestion`/`mergedReply` catch from the pipelining
 *  itself. Per the spec's own instruction ("if the reply id bookkeeping makes this
 *  detectable; otherwise skip and say so"): this does not fire. */
export function questionLag(_bundle: RehearseDiagnosticBundle): QuestionLagResult {
  return {
    count: 0,
    timestamps_s: [],
    skipped: true,
    skip_reason:
      'a transcript event carries only {role, length, text} -- no reply_id/goal_code -- so a spoken line cannot be matched to whichever goal was CURRENT when its audio actually played (only to the goal its own reply was originally generated for, via action_logged). Not detectable from this bundle shape.',
  };
}

/** Check 6: `goodbye_delay` -- informational. Seconds from the `terminal_action` event (the
 *  moment the deterministic core committed the terminal verdict, PROVEN:
 *  packages/server/src/call/session.ts) to the first agent transcript line that actually
 *  contains the full close sentence for that verdict (`turnController.ts`'s
 *  `CLOSE_SENTENCE_BY_VERDICT`/`isClosingLine`), plus whether a `close_retry` reply
 *  (`reply_create_sent` with `goal_code: "CLOSE"`, `reason: "close_retry"`, PROVEN:
 *  packages/server/src/call/session.ts:1610) was ever sent. `seconds: null` when either event
 *  is missing (no terminal verdict reached, or the close line was never actually spoken --
 *  the base close-line check in expectations.ts already fails that run on its own). */
export function goodbyeDelay(bundle: RehearseDiagnosticBundle): GoodbyeDelayResult {
  const terminalAction = bundle.server_events.find((e) => e.kind === 'terminal_action');
  const closeRetryNeeded = bundle.server_events.some((e) => {
    if (e.kind !== 'reply_create_sent') return false;
    const d = detailOf(e);
    return d !== null && d.goal_code === 'CLOSE' && d.reason === 'close_retry';
  });

  if (!terminalAction) {
    return { seconds: null, close_retry_needed: closeRetryNeeded, note: 'no terminal_action event in this bundle -- no verdict was committed' };
  }

  const CLOSE_SENTENCES = [
    'Your request is staged for independent approval. The payment is not released. Goodbye.',
    'This transfer is frozen and an incident is open. The payment is not released. Goodbye.',
    'This cannot be completed by voice. A callback on the registered number will follow. Goodbye.',
    'Thank you for calling. Goodbye.',
  ];
  const closeLine = extractAgentTranscript(bundle).find(
    (line) => line.t_ms >= terminalAction.t_ms && CLOSE_SENTENCES.some((s) => line.text.includes(s)),
  );

  if (!closeLine) {
    return {
      seconds: null,
      close_retry_needed: closeRetryNeeded,
      note: 'terminal_action was logged, but no later agent transcript line contains a full close sentence',
    };
  }

  const seconds = toSec(closeLine.t_ms - terminalAction.t_ms);
  return {
    seconds,
    close_retry_needed: closeRetryNeeded,
    note: `${seconds}s from terminal_action to the close line actually being spoken${closeRetryNeeded ? ' (a close_retry was needed)' : ''}`,
  };
}

/** Computes every check above from one diagnostics bundle -- the single entry point
 *  run.ts/regrade.ts/gradeRecord.ts all call. `ok` is the new PASS gate (repeated_question =
 *  0 && merged_reply = 0 && talk_over = 0 && holding_spam = 0); `question_lag` and
 *  `goodbye_delay` are reported but never gate PASS on their own (spec item (a) names only
 *  the first four as gating). */
export function computeExperienceGrade(bundle: RehearseDiagnosticBundle): ExperienceGrade {
  const repeated_question = repeatedQuestion(bundle);
  const merged_reply = mergedReply(bundle);
  const talk_over = talkOver(bundle);
  const holding_spam = holdingSpam(bundle);
  const question_lag = questionLag(bundle);
  const goodbye_delay = goodbyeDelay(bundle);
  const ok = repeated_question.count === 0 && merged_reply.count === 0 && talk_over.count === 0 && holding_spam.count === 0;
  return { repeated_question, merged_reply, talk_over, holding_spam, question_lag, goodbye_delay, ok };
}

/** One plain-English warning line per non-zero gating check -- run.ts pushes these onto the
 *  run's own `warnings` list, the same place `expectations.ts`'s opt-in checks and
 *  `checkCloseLineExpectation`'s failure already surface. Empty when `grade.ok` is true. */
export function experienceFailureMessages(grade: ExperienceGrade): string[] {
  const messages: string[] = [];
  if (grade.repeated_question.count > 0) {
    messages.push(
      `experience: the agent asked the same readback/challenge question again ${grade.repeated_question.count} time(s) at ${grade.repeated_question.timestamps_s.join('s, ')}s`,
    );
  }
  if (grade.merged_reply.count > 0) {
    messages.push(
      `experience: ${grade.merged_reply.count} agent line(s) had two sentences interleaved/run together (merged reply) at ${grade.merged_reply.timestamps_s.join('s, ')}s`,
    );
  }
  if (grade.talk_over.count > 0) {
    messages.push(
      `experience: the agent started talking over the caller (or right after a very short caller line) ${grade.talk_over.count} time(s) at ${grade.talk_over.timestamps_s.join('s, ')}s`,
    );
  }
  if (grade.holding_spam.count > 0) {
    messages.push(
      `experience: a bare "One moment." line was repeated or left with dead air ${grade.holding_spam.count} time(s) at ${grade.holding_spam.timestamps_s.join('s, ')}s`,
    );
  }
  return messages;
}
