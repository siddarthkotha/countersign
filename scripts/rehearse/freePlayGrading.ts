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
import { CLOSE_SENTENCE_BY_VERDICT, isClosingLineStart } from './turnController.js';

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

// ---------- question normalization and terminal outcome detection ----------

/** Fillers that appear at the start of agent questions and should be stripped for normalization.
 *  Case-insensitive. */
const QUESTION_FILLER_PREFIXES = [
  'hold on',
  'i understand',
  'understood',
  'authority and urgency are not verification',
];

/** Normalizes a question for comparison: strips leading fillers, lowercases, removes
 *  punctuation/whitespace, and collapses multiple spaces. Used to detect consecutive
 *  identical questions asked with no caller response in between. */
function normalizeQuestion(text: string): string {
  let normalized = text;
  // Strip leading fillers
  for (const filler of QUESTION_FILLER_PREFIXES) {
    const fillerRegex = new RegExp(`^${filler}[.!?]*\\s*`, 'i');
    normalized = normalized.replace(fillerRegex, '');
  }
  // Lowercase, remove punctuation/whitespace, collapse spaces
  return normalized
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Finds the index of the first agent transcript line that is or starts a closing sentence,
 *  or -1 if none found. Uses `isClosingLineStart` to detect even partial/interrupted close
 *  sentences, matching the same logic as patient-mode's `waitForPatientTurn`. */
function findCloseLineIndex(transcript: readonly TranscriptRecord[]): number {
  for (let i = 0; i < transcript.length; i++) {
    const line = transcript[i]!;
    if (line.speaker === 'agent' && isClosingLineStart(line.text)) {
      return i;
    }
  }
  return -1;
}

/** Detects whether the agent gave the caller "no chance" to answer: identifies any pair of
 *  agent transcript lines where the first ends with "?" (is a question) and the second
 *  starts less than 1500ms after the first (no time for caller to respond). Returns an
 *  array of question texts that had no chance. */
export function detectQuestionsWithNoChance(transcript: readonly TranscriptRecord[]): string[] {
  const questions_with_no_chance: string[] = [];
  const questions: Array<{ index: number; text: string }> = [];

  // First pass: find all questions
  for (let i = 0; i < transcript.length; i++) {
    const line = transcript[i]!;
    if (line.speaker === 'agent' && line.text.trim().endsWith('?')) {
      questions.push({ index: i, text: line.text });
    }
  }

  // Second pass: for each question, check if the next agent line (of any kind) comes too soon
  for (let qi = 0; qi < questions.length; qi++) {
    const q = questions[qi]!;
    const question_line = transcript[q.index]!;
    // Find the next agent line after this question
    for (let i = q.index + 1; i < transcript.length; i++) {
      const line = transcript[i]!;
      if (line.speaker === 'agent') {
        // Found the next agent line - check if it's too soon
        if (line.t_ms - question_line.t_ms < 1500) {
          questions_with_no_chance.push(q.text);
        }
        break; // Stop looking after finding the first next agent line
      }
    }
  }

  return questions_with_no_chance;
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
  /** Subset of `unanswered` where the agent gave the caller no chance to answer: two agent
   *  lines back-to-back where the second starts less than 1500ms after the first (using
   *  transcript timestamps as a proxy for line end times). These are product violations
   *  (agent's fault). Other unanswered questions are warnings (caller had a chance but
   *  chose not to respond). Empty if all unanswered questions gave the caller a chance. */
  unanswered_no_chance: string[];
}

/** Item 2's "every agent question got an answer" check: counts agent transcript lines ending
 *  in "?" that were followed by a caller line before the NEXT agent line (or before the close
 *  line). Walks the full interleaved transcript in order (the same `TranscriptRecord[]` shape
 *  every mode's report already carries) rather than needing any live-call state -- pure and
 *  independently testable.
 *
 *  Rules (2026-09-14 refinement):
 *  1. Consecutive agent questions with identical NORMALIZED text (case-insensitive, punctuation/
 *     whitespace collapsed, leading fillers stripped) count as ONE question for the unanswered
 *     check. (E.g. "Hold on. Which institution holds the Hartwell escrow?" and "I understand.
 *     Which institution holds the Hartwell escrow?" both normalize to "which institution holds
 *     the hartwell escrow" and count as a single unanswered question if neither got a caller
 *     response before the next distinct question.)
 *  2. Agent questions asked at or after the first agent transcript line that IS or STARTS a
 *     closing sentence (detected via `isClosingLineStart`) do not count at all -- neither as
 *     total nor unanswered. Once the close line begins, questions are expected to go unanswered.
 *  3. A question counts as answered if ANY later caller line appears before the close line,
 *     not only when the immediately next agent line happens to be one. (E.g. a question at
 *     t=50ms, then two agent lines, then a caller line at t=200ms -- the question still counts
 *     as answered.)
 *
 *  `silentAfterMs`, when given, excludes any agent question timestamped AFTER it from BOTH
 *  `total` and `unanswered` entirely (neither counted, not merely excused) -- PROVEN gap
 *  (2026-09-14): two of the ten judge cases (hangup-after-request, miller-silent-after-
 *  amount) have the caller deliberately go silent at a defined point, exactly the way the
 *  scripted versions of those same scenarios do (turnController.ts's `scriptedCallerShouldStop`
 *  doc comment: running out of turns is not a bug). The spec itself scopes this check to
 *  "while the caller was supposed to be responsive" -- once the persona has gone silent by
 *  design, any further agent question is expected to go unanswered and must never fail the
 *  run. Absent (the default), every agent question in the whole transcript is counted (subject
 *  to the close-line rule above), same as before this parameter existed. */
export function computeQuestionAnswerRatio(transcript: readonly TranscriptRecord[], silentAfterMs?: number): QuestionAnswerResult {
  let total = 0;
  let answered = 0;
  const unanswered: string[] = [];
  const unanswered_no_chance: string[] = [];

  // Find the close line index (first agent line that is or starts a closing sentence)
  const closeLineIdx = findCloseLineIndex(transcript);

  // Build list of questions, collapsing consecutive identical ones
  interface Question {
    index: number;
    text: string;
    normalized: string;
  }
  const questions: Question[] = [];
  let prevNormalized: string | null = null;

  for (let i = 0; i < transcript.length; i++) {
    const line = transcript[i]!;
    if (line.speaker !== 'agent') continue;
    if (!line.text.trim().endsWith('?')) continue;
    if (silentAfterMs !== undefined && line.t_ms > silentAfterMs) continue;
    if (closeLineIdx >= 0 && i >= closeLineIdx) continue; // Skip questions at or after close line

    const normalized = normalizeQuestion(line.text);

    // Only add if it's different from the previous question (collapse consecutive identical ones)
    if (normalized !== prevNormalized) {
      questions.push({ index: i, text: line.text, normalized });
      prevNormalized = normalized;
    }
  }

  total = questions.length;

  // Check each question for an answer and detect "no chance" situations
  for (const q of questions) {
    let gotAnswer = false;
    let nextAgentLineMs: number | null = null;
    // Look for a caller line between this question and either the next question or close line
    const endSearchAt = closeLineIdx >= 0 ? closeLineIdx : transcript.length;
    for (let j = q.index + 1; j < endSearchAt; j++) {
      const next = transcript[j]!;
      if (next.speaker === 'caller') {
        gotAnswer = true;
        break;
      }
      // Track the first agent line after this question for the "no chance" check
      if (next.speaker === 'agent' && nextAgentLineMs === null) {
        nextAgentLineMs = next.t_ms;
      }
    }
    if (gotAnswer) {
      answered++;
    } else {
      unanswered.push(q.text);
      // Check if the agent gave no chance: next agent line starts < 1500ms after this question started
      // This means the caller had less than 1500ms to respond before the agent asked another question
      if (nextAgentLineMs !== null && nextAgentLineMs - q.t_ms < 1500) {
        unanswered_no_chance.push(q.text);
      }
    }
  }

  return { answered, total, unanswered, unanswered_no_chance };
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

  // Detect questions where the agent gave the caller no chance to answer
  // (two agent lines back-to-back with < 1500ms gap)
  const questions_no_chance = detectQuestionsWithNoChance(input.transcript);

  // Only fail on questions where the agent gave no chance (product's fault).
  // Other unanswered questions are warnings (caller had a chance but chose not to respond).
  if (questions_no_chance.length > 0) {
    failures.push(
      `the agent gave the caller no chance to answer: asked ${questions_no_chance.length} question(s) with < 1500ms gaps -- ${questions_no_chance.map((q) => JSON.stringify(q)).join(', ')}`,
    );
  }

  if (questionAnswer.unanswered.length > 0 && questions_no_chance.length === 0) {
    // All unanswered questions gave the caller a chance (warning only)
    failures.push(
      `the agent asked ${questionAnswer.total} question(s) but only ${questionAnswer.answered} got a caller reply (caller had a chance but chose not to respond) -- unanswered: ${questionAnswer.unanswered.map((q) => JSON.stringify(q)).join(', ')}`,
    );
  }

  const verdictOk = input.verdictReached && verdictIsAcceptable(input.scenario, input.actualVerdict);

  let failReason: FreePlayFailReason | undefined;
  if (input.turnLoopFailReason) failReason = input.turnLoopFailReason;
  else if (!silenceCheck.ok) failReason = 'agent_silence_exceeded';
  else if (questions_no_chance.length > 0) failReason = 'unanswered_agent_question';

  const pass = verdictOk && failReason === undefined;

  return {
    pass,
    ...(failReason !== undefined ? { fail_reason: failReason } : {}),
    failures,
    question_answer: questionAnswer,
  };
}
