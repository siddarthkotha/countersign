// packages/server/src/call/closeMatch.ts
// reply.create fix, round 3 (2026-09-13, PROVEN live failure on deploy 26 -- see
// scripts/rehearse/reports/2026-09-13T22-23-50-miller-patient.diagnostics.json): CLOSE
// rendered at t=47567; the server sent reply.create at 47569 (reason tick_end);
// reply.started arrived at 47573, only 4 ms later -- too fast to be a reply generated from
// our request, and its own transcript.agent text turned out to be "Please provide the",
// AssemblyAI's OWN turn-driven reply composed under the PREVIOUS prompt, not our close line.
// The server labelled it CLOSE anyway (a reply.create was outstanding), armed nothing useful,
// and the closing sentence was never spoken. Conclusion: the server cannot tell AssemblyAI's
// own turn-driven reply from the reply it explicitly requested, so labelling a reply.started
// with what was requested (session.ts's replyGoalAtStart/pendingRequestedGoal) can prove a
// request was SENT, never that it was HONOURED. This module is the new source of truth for
// the CLOSE hang-up: was the close sentence actually heard in a reply's own accumulated
// transcript.agent text.
//
// The four exact close sentences are copied (not imported) from engine/src/fsm.ts's own
// `closeSentence(verdict)`, grepped verbatim 2026-09-13 -- fsm.ts is owned by another lane's
// worktree for this task (LANE-FILES here is packages/server/** only) and exports nothing
// from the engine package's public surface. Production code in session.ts never needs this
// constant either: it already has the live sentence at `this.last.goal.hint` once
// `this.last.goal.code === 'CLOSE'` (fsm.ts composes the sentence straight into `goal.hint`;
// prompt.ts's CLOSE case relays it verbatim). This file's own tests use the constant below to
// exercise the matcher against the real wording rather than a stand-in string.
export const ENGINE_CLOSE_SENTENCES: Record<'STAGE' | 'FREEZE' | 'ESCALATE' | 'NO_ACTION', string> = {
  STAGE:
    'Your request is staged for independent approval. The payment is not released. Goodbye.',
  FREEZE: 'This transfer is frozen and an incident is open. The payment is not released. Goodbye.',
  ESCALATE: 'This cannot be completed by voice. A callback on the registered number will follow. Goodbye.',
  NO_ACTION: 'Thank you for calling. Goodbye.',
};

/** Lowercases, strips everything but letters/digits/spaces, collapses whitespace, and folds
 *  the "good bye" / "goodbye" STT spelling variants together -- enough normalization to
 *  absorb minor TTS/STT transcription differences (a missing trailing period, punctuation
 *  drift, casing) without being so loose it would match unrelated text. Exported for the
 *  matcher's own unit tests; session.ts never calls this directly. */
export function normalizeForCloseMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/good\s?bye/g, 'goodbye')
    .trim();
}

/** The non-"Goodbye" clauses of a close sentence, normalized -- `closeSentence`'s own shape
 *  is always "<opening clause(s)>. <content clause>. Goodbye." (STAGE/FREEZE/ESCALATE) or
 *  "<content clause>. Goodbye." (the default/NO_ACTION line). */
function contentClauses(sentence: string): string[] {
  return sentence
    .split('.')
    .map((c) => normalizeForCloseMatch(c))
    .filter((c) => c.length > 0 && c !== 'goodbye');
}

/** For each verdict, the first of its own close sentence's content clauses that does not
 *  appear as a content clause of any OTHER verdict's sentence -- the shortest piece of
 *  wording that, on its own, identifies which verdict was actually spoken. Computed
 *  generically off `ENGINE_CLOSE_SENTENCES` (never a hardcoded index), so a future wording
 *  edit that makes two verdicts share their first clause throws here instead of silently
 *  reintroducing cross-matching. Founder ruling 2026-09-16 gave STAGE and FREEZE a shared
 *  final clause ("The payment is not released"), which is exactly what made the OLD "require
 *  every clause" fallback here too strict (any small rewording of either sentence's OTHER
 *  clause then failed the match, which on the server re-sends CLOSE and doubles the
 *  goodbye) -- see closeMatch.test.ts's own "every verdict's distinguishing clause is
 *  unique" test. */
export const DISTINGUISHING_CLAUSE_BY_VERDICT: Record<'STAGE' | 'FREEZE' | 'ESCALATE' | 'NO_ACTION', string> = (() => {
  const verdicts = Object.keys(ENGINE_CLOSE_SENTENCES) as Array<keyof typeof ENGINE_CLOSE_SENTENCES>;
  const clausesByVerdict = new Map(verdicts.map((v) => [v, contentClauses(ENGINE_CLOSE_SENTENCES[v])]));
  const result = {} as Record<keyof typeof ENGINE_CLOSE_SENTENCES, string>;
  for (const verdict of verdicts) {
    const ownClauses = clausesByVerdict.get(verdict)!;
    const distinguishing = ownClauses.find((clause) =>
      verdicts.every((other) => other === verdict || !clausesByVerdict.get(other)!.includes(clause)),
    );
    if (distinguishing === undefined) {
      throw new Error(
        `closeMatch: "${verdict}"'s close sentence has no content clause that distinguishes it from the other verdicts -- a wording change made every clause ambiguous`,
      );
    }
    result[verdict] = distinguishing;
  }
  return result;
})();

/** True when `accumulatedTranscript` (every transcript.agent chunk recorded for one AAI
 *  reply, concatenated in arrival order) can be read as the caller having actually heard
 *  `closeSentence` -- leniently: either an exact normalized match, or both "goodbye" and
 *  this verdict's own DISTINGUISHING content clause (see `DISTINGUISHING_CLAUSE_BY_VERDICT`)
 *  appearing somewhere in the transcript. The lenient branch accepts a reply that
 *  paraphrased any OTHER clause but landed the one clause that actually proves which
 *  verdict this is, plus a reply cut short by barge-in that still got that clause and the
 *  word "goodbye" out before being interrupted. Never matches an empty transcript, never
 *  matches on "goodbye" alone (that word alone proves nothing about WHICH outcome was
 *  spoken), and never matches a DIFFERENT verdict's sentence (the distinguishing clause is
 *  unique to its own verdict by construction). `closeSentence` must be one of
 *  `ENGINE_CLOSE_SENTENCES`'s own values -- an unrecognized sentence has no fallback and
 *  can only match exactly. */
export function transcriptMatchesCloseSentence(accumulatedTranscript: string, closeSentence: string): boolean {
  const transcript = normalizeForCloseMatch(accumulatedTranscript);
  if (transcript.length === 0) return false;

  const sentence = normalizeForCloseMatch(closeSentence);
  if (sentence.length > 0 && transcript.includes(sentence)) return true;

  const verdict = (Object.keys(ENGINE_CLOSE_SENTENCES) as Array<keyof typeof ENGINE_CLOSE_SENTENCES>).find(
    (v) => normalizeForCloseMatch(ENGINE_CLOSE_SENTENCES[v]) === sentence,
  );
  if (verdict === undefined) return false;

  const distinguishingClause = DISTINGUISHING_CLAUSE_BY_VERDICT[verdict];
  const hasGoodbye = transcript.includes('goodbye');
  return transcript.includes(distinguishingClause) && hasGoodbye;
}
