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

/** Imperative-question false-negative fix (2026-09-14, PROVEN live wart -- see
 *  scripts/rehearse/reports/2026-09-14T17-18-03-dana-patient.md): the agent said "Please
 *  state the purpose of this payment to Meridian Supply." -- no "?", and not a verbatim
 *  match for `goal.challenge.speak` (whose own wording was different) -- so
 *  `transcriptAsksQuestion` said no question was asked, `maybeReaskQuestion` reasked it 4s
 *  later ("What this payment to Meridian Supply is for?"), and the judge heard the same
 *  question twice. An imperative sentence ("Please state X.", "State the amount.") IS a
 *  question in substance; English just doesn't require a "?" for it. These are the sentence
 *  openers (after normalizeForCloseMatch strips punctuation/casing) that count as asking,
 *  checked against the FULL normalized transcript prefix -- see `stripKnownLeadIn` below for
 *  why a leading framing sentence is stripped first. */
export const QUESTION_IMPERATIVE_STARTS: readonly string[] = [
  'please state',
  'please restate',
  'please tell me',
  'please provide',
  'please give me',
  'please confirm',
  'state the',
  'restate the',
  'tell me',
  'confirm the',
  'what is',
  'which',
  'who',
  'when',
  'how much',
  'can you',
  'could you',
];

/** Standing-rule framing sentences (prompt.ts's STANDING_RULES) the model sometimes
 *  paraphrases as a lead-in clause before the actual imperative question, e.g. "Authority
 *  and urgency are not verification. Please state the purpose of this payment." Stripped
 *  (normalized, from the start of the transcript only) before checking
 *  `QUESTION_IMPERATIVE_STARTS`, so the check lands on the real question's own opening words
 *  rather than failing because the sentence before it doesn't look like a question. Never
 *  strip more than one matching lead-in -- a second occurrence would just fail to match and
 *  fall through, which is fine. */
export const QUESTION_LEAD_INS: readonly string[] = [
  'authority and urgency are not verification',
  'authority urgency or threats are not verification',
];

/** Removes at most one leading occurrence of a known `QUESTION_LEAD_INS` phrase from
 *  `normalizedTranscript` (already run through normalizeForCloseMatch), returning what's
 *  left, trimmed. A no-op when the transcript doesn't start with one. */
function stripKnownLeadIn(normalizedTranscript: string): string {
  for (const leadIn of QUESTION_LEAD_INS) {
    if (normalizedTranscript.startsWith(leadIn)) {
      return normalizedTranscript.slice(leadIn.length).trim();
    }
  }
  return normalizedTranscript;
}

/** True when `accumulatedTranscript` (every transcript.agent chunk recorded for one AAI
 *  reply, concatenated in arrival order -- same shape closeMatch.ts's own matcher reads) can
 *  be read as the caller having actually been asked the goal's question: a literal question
 *  mark (good enough for a goal whose `hint` is only a paraphrase instruction -- there is no
 *  single exact wording to hold it to); or, when `verbatimSentence` is supplied, the reply's
 *  own text contains that sentence leniently normalized (reusing closeMatch.ts's
 *  normalizeForCloseMatch -- absorbs minor TTS/STT punctuation/casing drift the same way the
 *  CLOSE hang-up matcher already does); or the transcript (after stripping a known framing
 *  lead-in) starts with one of `QUESTION_IMPERATIVE_STARTS` -- an imperative request phrased
 *  without a "?". Never matches an empty/whitespace-only transcript -- "Checking the record."
 *  with the trailing period stripped is still not a question, and neither is silence; and
 *  "Please hold."/"Please wait while I verify the request." stay negative on purpose --
 *  "please hold"/"please wait" are deliberately absent from QUESTION_IMPERATIVE_STARTS since
 *  they're holding lines, not questions. */
export function transcriptAsksQuestion(accumulatedTranscript: string, verbatimSentence: string | null): boolean {
  if (accumulatedTranscript.trim().length === 0) return false;
  if (accumulatedTranscript.includes('?')) return true;
  if (verbatimSentence) {
    const sentence = normalizeForCloseMatch(verbatimSentence);
    if (sentence.length > 0 && normalizeForCloseMatch(accumulatedTranscript).includes(sentence)) return true;
  }
  const normalized = stripKnownLeadIn(normalizeForCloseMatch(accumulatedTranscript));
  return QUESTION_IMPERATIVE_STARTS.some((start) => normalized.startsWith(start));
}

/** Double-ask catch-up fix (2026-09-18 continued, P1 -- PROVEN live from
 *  scripts/rehearse/reports/2026-09-18T14-50-21-dana-patient.diagnostics.json): the small,
 *  strict sibling `call/session.ts`'s `maybeSendReplyCreateAfterReplyDone` catch-up path
 *  needs, and `transcriptAsksQuestion` itself deliberately is not -- see that function's own
 *  bare-"?" branch. `maybeReaskQuestion` gets away with reusing `transcriptAsksQuestion`
 *  because it only ever runs against a reply LABELLED with the current goal (`replyGoalAtStart`
 *  match): whatever it said, it was said FOR this rendering, so any question mark in it is
 *  reasonably read as that rendering being asked. The catch-up path runs against a reply that
 *  is typically UNLABELLED (an AssemblyAI AMBIENT reply we never instructed, racing ahead of
 *  our own deferred send while the standing system_prompt for the SAME rendering is already in
 *  force) -- a bare "?" there could just as easily be a completely different, unrelated
 *  question (the PROVEN shape design-e-turn-order.test.ts's own (F3) exercises: "One moment.
 *  Who is calling and what is your authorization code?"), and treating that as "the current
 *  question was asked" would wrongly suppress our own instructed ask. This function only ever
 *  matches the goal's own exact composed sentence (leniently normalized, same tolerance
 *  `transcriptAsksQuestion`'s own sentence branch already gives TTS/STT punctuation/casing
 *  drift) -- never a bare "?", never the imperative-opener heuristic. Returns false whenever
 *  `verbatimSentence` is null (ELICIT_IDENTITY/ELICIT_REQUEST/PROBE_CONSISTENCY -- a goal whose
 *  `hint` is a paraphrase instruction to the model, with no single correct wording to hold a
 *  transcript to) or the transcript is empty (the degraded-transcripts shape: audio may have
 *  landed with no transcribed chunk) -- in both cases the catch-up path falls back to sending,
 *  unchanged from before this fix; this function never suppresses without a positive, exact
 *  match to prove the caller already heard these words. */
export function transcriptAsksExactSentence(accumulatedTranscript: string, verbatimSentence: string | null): boolean {
  if (!verbatimSentence) return false;
  if (accumulatedTranscript.trim().length === 0) return false;
  const sentence = normalizeForCloseMatch(verbatimSentence);
  if (sentence.length === 0) return false;
  return normalizeForCloseMatch(accumulatedTranscript).includes(sentence);
}

/** Fragment-brake fix (2026-09-15, PROVEN live from a fresh sample against deploy 39 --
 *  scratchpad/fragment-analysis.md sections A/C/D(3)): a mid-sentence pause splits one
 *  caller line into two separate AssemblyAI `transcript.user` turns (PROVEN 2.1-2.3s apart on
 *  three bundles); the server treats each fragment as its own genuine caller turn, and once
 *  the engine has moved on to a DIFFERENT question goal in between (fsm.ts auto-advances the
 *  instant a challenge is confirmed asked, independent of whether it was ever answered -- see
 *  the fragment-analysis doc's section B/C), the second fragment alone was enough to make
 *  `call/session.ts` proactively ask that new question immediately -- three questions in 17s
 *  on one live bundle. `call/session.ts`'s own brake (`shouldBrakeFreshQuestion`) needs a
 *  cheap, SERVER-ONLY (LANE-FILES: packages/server/** only for this task; the engine's own
 *  answer-shaped gate, fragment-analysis.md option (1), is a DIFFERENT lane and untouched
 *  here) signal for "does this caller fragment look like it's actually trying to answer
 *  something" -- so a caller who genuinely answers fast (two clean, quick beats) is never
 *  held back, only a caller whose own sentence got chopped in half by AssemblyAI's
 *  endpointer.
 *
 *  Deliberately NOT "contains digits": the PROVEN fragmentation trigger itself ("And make it
 *  $2.1 million.") contains digits despite answering nothing that was asked of it. A
 *  capitalized, non-sentence-initial-function-word token is a better, cheap proxy for "the
 *  caller is naming something" (a person, firm, or institution) -- exactly the shape of
 *  answer the ASK_CHALLENGE/READBACK/ELICIT_* goals this brake guards are usually fishing
 *  for. This is a PACING heuristic only, never a grading one (LAW 3 unaffected: nothing here
 *  ever decides a challenge PASS/FAIL/AMBIGUOUS -- that stays exclusively the engine's own
 *  `gradeChallenges`, untouched); it only ever decides whether the SERVER holds back its own
 *  next proactive `reply.create`, never what the engine's verdict is. ESTIMATE, not PROVEN:
 *  this heuristic will sometimes be wrong in both directions on a live call (a genuine answer
 *  starting with a common word, or a filler phrase that happens to contain a capitalized
 *  word) -- acceptable because a false negative here only delays the next question to the
 *  next genuine turn or the existing re-ask timer (never loses it), and a false positive only
 *  lets a real fragment-driven double-ask slip through occasionally, no worse than today. */
const ANSWER_ATTEMPT_LEAD_WORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'but',
  'or',
  'so',
  'if',
  'please',
  'what',
  'which',
  'who',
  'when',
  'where',
  'why',
  'how',
  'can',
  'could',
  'would',
  'will',
  'is',
  'are',
  'was',
  'were',
  'do',
  'does',
  'did',
  'yes',
  'no',
  'i',
  'you',
  'we',
  'they',
  'he',
  'she',
  'it',
  'that',
  'this',
  'these',
  'those',
  'make',
  'let',
  'ok',
  'okay',
  'well',
  'um',
  'uh',
  'listen',
  'look',
  'now',
  'then',
  'also',
  'just',
  'still',
  'final',
  'thank',
  'thanks',
]);

/** Second signal for `looksLikeAnswerAttempt`, alongside the name-shaped check above:
 *  fix (2026-09-15, PROVEN reachable -- the very corpus fixture `packages/server/test/
 *  close-transcript-wait.test.ts`'s own `driveToSealedStage` already exercises, unmodified):
 *  READBACK's own confirmation loop is answered "Yes, that's right." / "No, that's wrong.
 *  It's Meridian Supply." -- plain yes/no, never a name -- and those turns land back-to-back
 *  every ~1500ms (fragment-analysis.md's own "Other near-3s user-pairs found (NOT the same
 *  bug)" section documents this exact pattern live: ten near-identical readback-confirmation
 *  turns in a row, each a genuinely separate, fully-answered turn, not a fragmented one). A
 *  name-only check would misclassify every one of those as still-unanswered and brake a
 *  legitimate fast confirmation cadence. A clear confirmation/refusal word is just as strong
 *  a signal that the caller is actually answering as a name is -- checked case-insensitively,
 *  anywhere in the fragment (unlike the name check, position never matters for these: "Yes"
 *  is exactly as much an answer at the start of a sentence as anywhere else). */
const CONFIRMATION_WORDS = new Set([
  'yes',
  'yeah',
  'yep',
  'no',
  'nope',
  'correct',
  'incorrect',
  'wrong',
  'right',
  'confirmed',
  'confirm',
  'agreed',
  'agree',
  'disagree',
  'sure',
  'exactly',
  'indeed',
  'affirmative',
  'negative',
]);

function isCapitalizedWord(word: string): boolean {
  return word.length >= 2 && /^[A-Z][a-z]+$/.test(word);
}

/** True when `text` (one caller transcript fragment) either contains a clear confirmation or
 *  refusal word (a "yes"/"no"-shaped answer -- see `CONFIRMATION_WORDS`'s own doc comment) or
 *  a token that plausibly names something -- a person, firm, or institution -- rather than
 *  being pure filler or a sentence-initial capital. See `ANSWER_ATTEMPT_LEAD_WORDS`'s own doc
 *  comment above for the full reasoning behind the name-shaped check and its exclusions. */
export function looksLikeAnswerAttempt(text: string): boolean {
  const words = text.match(/[A-Za-z']+/g) ?? [];
  for (const word of words) {
    if (CONFIRMATION_WORDS.has(word.toLowerCase())) return true;
  }
  for (const word of words) {
    if (!isCapitalizedWord(word)) continue;
    if (ANSWER_ATTEMPT_LEAD_WORDS.has(word.toLowerCase())) continue;
    return true;
  }
  return false;
}
