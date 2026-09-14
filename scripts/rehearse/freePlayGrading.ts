// scripts/rehearse/freePlayGrading.ts
// Free-play addition (2026-09-14). Grading rules unique to `--free-play` mode, on top of
// (never instead of) the base checks every mode already gets (verdict reached,
// expectations.ts's opt-in checks, checkCloseLineExpectation's close-line check) -- see
// freePlay.ts's `runFreePlayOne`, which combines all of these into one pass/fail.
//
// Every function here is pure -- no CallClient, no network, no filesystem -- so each is
// exercised directly with hand-built TranscriptRecord/TurnGapRecord arrays
// (scripts/rehearse/test/freePlayGrading.test.ts), per CLAUDE.md's "tests must not need the
// network" rule and the founder's own item 5 ("unit tests... for... the unanswered-question
// grader").
import type { Scenario, TranscriptRecord, TurnGapRecord } from './types.js';
import type { Verdict } from '@countersign/engine';

// ---------- verdict acceptance ----------

/** The set of terminal verdicts a free-play run is allowed to land on: `expected.verdicts`
 *  when the scenario lists several (an improvising caller can tip a borderline case either
 *  way -- types.ts's `ScenarioExpected.verdicts` doc comment), else the single `expected.
 *  verdict` every scenario already carries. Never empty. */
export function acceptableVerdicts(scenario: Scenario): Verdict[] {
  return scenario.expected.verdicts ?? [scenario.expected.verdict];
}

export function verdictIsAcceptable(scenario: Scenario, actual: Verdict | 'PENDING' | null): boolean {
  if (actual === null || actual === 'PENDING') return false;
  return acceptableVerdicts(scenario).includes(actual);
}

// ---------- "no agent silence gap over agent_silence_fail_ms while the caller is waiting" ----------

/** Item 2 of the free-play spec: independent of whether a HOLDING line was ever said
 *  (turnController.ts's `waitForPatientTurn` already fails a run on "holding line, then
 *  silence" specifically -- `agent_silent_after_hold`), this asks the more general question
 *  "did the agent ever go silent for longer than the allowed gap after any non-barge-in
 *  caller line, whether or not it said a holding line first". Operates on the SAME
 *  `TurnGapRecord[]` `computeTurnGaps` (turnController.ts, reused unmodified) already
 *  produces for every mode's report -- no new instrumentation needed. A barge-in turn's gap
 *  is always null (computeTurnGaps' own doc comment: "not a meaningful... measurement") and
 *  is never checked here. A turn with `first_reply_audio_ms: null` (no reply audio ever
 *  observed after that turn) is reported as a silence violation too -- "no reply at all" is
 *  at least as bad as "a reply that took too long". */
export function checkNoExcessiveSilence(turnGaps: readonly TurnGapRecord[], maxGapMs: number): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  for (const g of turnGaps) {
    if (g.gap_ms === null) {
      if (g.first_reply_audio_ms === null && !(g.note ?? '').toLowerCase().includes('barge-in')) {
        failures.push(`turn ${g.turn_id}: no agent reply audio was ever observed after this turn (limit ${maxGapMs}ms)`);
      }
      continue;
    }
    if (g.gap_ms > maxGapMs) {
      failures.push(`turn ${g.turn_id}: agent went silent for ${g.gap_ms}ms after the caller finished speaking (limit ${maxGapMs}ms)`);
    }
  }
  return { ok: failures.length === 0, failures };
}

// ---------- "every agent question got an answer" ----------

export interface QuestionAnswerResult {
  answered: number;
  total: number;
  /** The exact text of every agent question (a transcript line, from the agent, whose
   *  trimmed text ends in "?") that was NOT followed by a caller line before the agent spoke
   *  again -- in transcript order. Empty when every question got an answer, or the agent
   *  never asked one. */
  unanswered: string[];
}

/** Item 2's "every agent question got an answer" check: counts agent transcript lines ending
 *  in "?" that were followed by a caller line before the NEXT agent line. Walks the full
 *  interleaved transcript in order (the same `TranscriptRecord[]` shape every mode's report
 *  already carries) rather than needing any live-call state -- pure and independently
 *  testable. A question that is the very last line of the transcript (nothing follows it at
 *  all, e.g. the caller hung up or the recording ends there) counts as unanswered, same as
 *  one immediately followed by a further agent line -- either way, no caller line ever
 *  responded to it.
 *
 *  `silentAfterMs`, when given, excludes any agent question timestamped AFTER it from BOTH
 *  `total` and `unanswered` entirely (neither counted, not merely excused) -- PROVEN gap
 *  (2026-09-14): two of the ten judge cases (hangup-after-request, miller-silent-after-
 *  amount) have the caller deliberately go silent at a defined point, exactly the way the
 *  scripted versions of those same scenarios do (turnController.ts's `scriptedCallerShouldStop`
 *  doc comment: running out of turns is not a bug). The spec itself scopes this check to
 *  "while the caller was supposed to be responsive" -- once the persona has gone silent by
 *  design, any further agent question is expected to go unanswered and must never fail the
 *  run. Absent (the default), every agent question in the whole transcript is counted, same
 *  as before this parameter existed. */
export function computeQuestionAnswerRatio(transcript: readonly TranscriptRecord[], silentAfterMs?: number): QuestionAnswerResult {
  let total = 0;
  let answered = 0;
  const unanswered: string[] = [];

  for (let i = 0; i < transcript.length; i++) {
    const line = transcript[i]!;
    if (line.speaker !== 'agent') continue;
    if (!line.text.trim().endsWith('?')) continue;
    if (silentAfterMs !== undefined && line.t_ms > silentAfterMs) continue;
    total++;

    let gotAnswer = false;
    for (let j = i + 1; j < transcript.length; j++) {
      const next = transcript[j]!;
      if (next.speaker === 'agent') break; // the agent spoke again first -- unanswered.
      if (next.speaker === 'caller') {
        gotAnswer = true;
        break;
      }
    }
    if (gotAnswer) answered++;
    else unanswered.push(line.text);
  }

  return { answered, total, unanswered };
}

export function questionAnswerRatioDisplay(r: QuestionAnswerResult): string {
  if (r.total === 0) return '0/0 (the agent asked no questions)';
  return `${r.answered}/${r.total}`;
}

// ---------- combined free-play grade ----------

export interface FreePlayGradeInput {
  scenario: Scenario;
  actualVerdict: Verdict | 'PENDING' | null;
  verdictReached: boolean;
  turnGaps: readonly TurnGapRecord[];
  transcript: readonly TranscriptRecord[];
  /** Ceiling (ms) used by `checkNoExcessiveSilence` -- normally the same
   *  `scenario.agent_silence_fail_ms` (or turnController.ts's `DEFAULT_AGENT_SILENCE_FAIL_MS`
   *  when the scenario doesn't set one) the patient-caller wait already uses, so free play's
   *  silence bar matches whatever the scenario itself already asked for. */
  agentSilenceFailMs: number;
  /** Set only when the turn loop itself already caught "a holding line, then silence" the
   *  same way patient mode does (freePlay.ts reuses `waitForPatientTurn` verbatim) --
   *  propagated straight through as this run's fail reason without re-deriving it here. */
  turnLoopFailReason?: 'agent_silent_after_hold';
  /** Set only when the free-play caller itself deliberately went silent (persona instruction,
   *  `FreePlayCallerTurnResult.silent`) -- the t_ms of that caller's LAST spoken line, used to
   *  exclude every later agent question from `computeQuestionAnswerRatio` (see that
   *  function's own doc comment). Absent for every run where the caller kept responding for
   *  the whole call. */
  silentAfterMs?: number;
}

export type FreePlayFailReason = 'agent_silent_after_hold' | 'close_line_not_spoken' | 'agent_silence_exceeded' | 'unanswered_agent_question';

export interface FreePlayGradeResult {
  pass: boolean;
  fail_reason?: FreePlayFailReason;
  /** Every reason this run failed, in the order checked -- unlike `fail_reason` (the single
   *  reason surfaced in the one-line summary and the report's Result section, first cause
   *  wins so a run is never described by two contradictory reasons at once), this can list
   *  more than one problem so a report's Warnings section shows everything actually wrong. */
  failures: string[];
  question_answer: QuestionAnswerResult;
}

/** Combines every free-play-specific check into one grade. Does NOT include the base
 *  verdict-reached/expectations.ts/close-line checks -- those are shared with every other
 *  mode and stay run.ts/freePlay.ts's own job to apply (so this file only ever answers
 *  questions that are unique to free play). Order of `fail_reason` precedence mirrors
 *  run.ts's own existing precedence for the checks they share: a holding-line-then-silence
 *  catch from the turn loop itself outranks everything else (it already ended the call), then
 *  an excessive silence gap, then an unanswered question. */
export function gradeFreePlay(input: FreePlayGradeInput): FreePlayGradeResult {
  const failures: string[] = [];
  const questionAnswer = computeQuestionAnswerRatio(input.transcript, input.silentAfterMs);

  if (input.turnLoopFailReason) {
    failures.push(`patient-mode caller: a holding line, then silence -- ${input.turnLoopFailReason}`);
  }

  const silenceCheck = checkNoExcessiveSilence(input.turnGaps, input.agentSilenceFailMs);
  failures.push(...silenceCheck.failures);

  if (questionAnswer.unanswered.length > 0) {
    failures.push(
      `the agent asked ${questionAnswer.total} question(s) but only ${questionAnswer.answered} got a caller reply before the agent spoke again -- unanswered: ${questionAnswer.unanswered.map((q) => JSON.stringify(q)).join(', ')}`,
    );
  }

  const verdictOk = input.verdictReached && verdictIsAcceptable(input.scenario, input.actualVerdict);

  let failReason: FreePlayFailReason | undefined;
  if (input.turnLoopFailReason) failReason = input.turnLoopFailReason;
  else if (!silenceCheck.ok) failReason = 'agent_silence_exceeded';
  else if (questionAnswer.unanswered.length > 0) failReason = 'unanswered_agent_question';

  const pass = verdictOk && failReason === undefined;

  return {
    pass,
    ...(failReason !== undefined ? { fail_reason: failReason } : {}),
    failures,
    question_answer: questionAnswer,
  };
}
