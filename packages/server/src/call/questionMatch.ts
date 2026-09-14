// packages/server/src/call/questionMatch.ts
// Question-reask fix (2026-09-14, PROVEN live failure -- see
// scripts/rehearse/reports/2026-09-14T15-47-29-miller-patient.diagnostics.json and its .md):
// at 33741 the engine rendered goal ASK_CHALLENGE (the next verification question the FSM
// wanted asked); the model's own reply was "Checking the record." (20 chars, no question at
// all); the same goal re-rendered unchanged at 37041 (nothing new to say, so no fresh
// session.update went out either); a person-like caller then waited for a question that
// never came until the idle timer ended the call 33 seconds later. The engine (fsm.ts/
// challenges.ts) already composes a genuine, speakable question sentence for several goals
// (READBACK/ELICIT_MISSING_CRITICAL/RE_ELICIT_AFTER_SWITCH via `goal.hint` directly, and
// ASK_CHALLENGE via `goal.challenge.speak` -- see fsm.ts's own CHALLENGE-SPEAKABLE comment);
// this module is the small, pure matcher `call/session.ts`'s `maybeReaskQuestion` uses to
// decide whether a completed reply actually delivered that question, never the engine and
// never a verdict (LAW 3 unaffected: this only ever decides whether to ask AssemblyAI to
// speak the SAME already-computed question again, never what the question is).
import type { GoalCode, PhrasingGoal } from '@countersign/engine';
import { normalizeForCloseMatch } from './closeMatch.js';

/** The goal codes whose whole point is to put ONE question to the caller -- see each case's
 *  own comment in fsm.ts/prompt.ts. Deliberately excludes every holding/announcement/close
 *  goal (STALL, CONTAIN, CONTAIN_NO_DISCLOSURE, GREET, ANNOUNCE_*, CLOSE,
 *  EXPLAIN_OUT_OF_SCOPE, EXPLAIN_OPEN_REQUEST, REFUSE_AUTHORITY): none of those are asking
 *  the caller anything the caller must answer for the call to move forward, so a "holding"
 *  reply for one of them is correct behavior, not the bug this module exists to catch. */
export const QUESTION_GOALS: ReadonlySet<GoalCode> = new Set<GoalCode>([
  'ASK_CHALLENGE',
  'READBACK',
  'ELICIT_IDENTITY',
  'ELICIT_REQUEST',
  'ELICIT_MISSING_CRITICAL',
  'PROBE_CONSISTENCY',
  'RE_ELICIT_AFTER_SWITCH',
]);

/** The exact, already-composed sentence the engine wants spoken for `goal`, when one exists --
 *  null for a goal whose `hint` is a paraphrase-instruction to the model (ELICIT_IDENTITY's
 *  "Ask who is calling.", ELICIT_REQUEST's "Ask what the caller needs.", PROBE_CONSISTENCY's
 *  "Ask which is correct and why it changed.") rather than a line a person would actually say.
 *  READBACK/ELICIT_MISSING_CRITICAL/RE_ELICIT_AFTER_SWITCH all have fsm.ts compose the real
 *  sentence straight into `goal.hint` itself (same convention prompt.ts's own verbatim-wrapped
 *  cases already rely on); ASK_CHALLENGE carries it separately on `goal.challenge.speak`
 *  (fsm.ts prefers `nextChallenge.speak` for `goal.hint` too, but reads the field directly here
 *  rather than assuming that convention holds for a hand-built ChallengeSpec, e.g. a test
 *  fixture or a replayed corpus action, that predates it and only set `ask`). */
export function verbatimQuestionSentence(goal: PhrasingGoal): string | null {
  switch (goal.code) {
    case 'READBACK':
    case 'ELICIT_MISSING_CRITICAL':
    case 'RE_ELICIT_AFTER_SWITCH':
      return goal.hint;
    case 'ASK_CHALLENGE':
      return goal.challenge?.speak ?? null;
    default:
      return null;
  }
}

/** True when `accumulatedTranscript` (every transcript.agent chunk recorded for one AAI
 *  reply, concatenated in arrival order -- same shape closeMatch.ts's own matcher reads) can
 *  be read as the caller having actually been asked the goal's question: either the reply
 *  contains a literal question mark (good enough for a goal whose `hint` is only a paraphrase
 *  instruction -- there is no single exact wording to hold it to), or, when `verbatimSentence`
 *  is supplied, the reply's own text contains that sentence leniently normalized (reusing
 *  closeMatch.ts's normalizeForCloseMatch -- absorbs minor TTS/STT punctuation/casing drift
 *  the same way the CLOSE hang-up matcher already does). Never matches an empty/whitespace-
 *  only transcript -- "Checking the record." with the trailing period stripped is still not a
 *  question, and neither is silence. */
export function transcriptAsksQuestion(accumulatedTranscript: string, verbatimSentence: string | null): boolean {
  if (accumulatedTranscript.trim().length === 0) return false;
  if (accumulatedTranscript.includes('?')) return true;
  if (!verbatimSentence) return false;
  const sentence = normalizeForCloseMatch(verbatimSentence);
  if (sentence.length === 0) return false;
  return normalizeForCloseMatch(accumulatedTranscript).includes(sentence);
}
