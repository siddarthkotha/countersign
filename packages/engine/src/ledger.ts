// packages/engine/src/ledger.ts
// The STORY LEDGER: every fact the CALLER states is committed verbatim, with a lifecycle
// (STATED/CONFIRMED/APPROXIMATE/CORRECTED/CONTRADICTED/UNKNOWN). Behavioral only — no claim
// about voice authenticity. See amendment-v2-brief.md §B for the rules this implements;
// facts (verbatim quotes) live separately from interpretation (kind).
//
// CORRECTED vs CONTRADICTED (fix-round-1 ruling — time alone is not evidence of honesty): a
// later different value for a field is CORRECTED iff (a) the utterance has a
// correction-lexicon hit ("sorry", "actually", ...), OR (b) the current claim for that
// field is APPROXIMATE and (for numeric fields) the new value stays within
// `approximate_jump_ratio` of it — fix-round-2 ruling: a wildly bigger/smaller exact figure
// after an approximate one (e.g. "about fifty thousand-ish" then "two hundred forty
// thousand") is CONTRADICTED, not a free pass, because there's no bound on how far off an
// "approximation" can honestly be — OR (c) the utterance has a negate-lexicon hit AND it
// also names the PREVIOUS value inline (e.g. "not 1.8, it's 1.9" — the caller explicitly
// disowns the old figure while restating), OR (d) it arrives within `correction_window_ms`
// after a `readback_issued` for that field that the caller NEGATED (the readback-repair
// path). Otherwise CONTRADICTED. A plain time gap with none of the above is CONTRADICTED,
// full stop — "it happened soon after" is not, by itself, evidence the caller was honest.
import { extractAccountLast4, extractCuedNames, extractDeadline } from './extract/claims.js';
import { extractAmounts } from './extract/amounts.js';
import { extractSpokenAmounts } from './extract/spokenNumbers.js';
import { extractIdentityClaim } from './extract/identity.js';
import { answersToPersonQuestion } from './extract/personQuestion.js';
import { hasLexiconHit, normalizeText, normalizeValue } from './normalize.js';
import { escapeRegExp } from './util.js';
import type { AgentAction, Claim, ClaimField, ClaimKind, SeedConfig, Utterance } from './types.js';

// request_version bumps only when the current value of one of these fields changes.
const VERSIONED_FIELDS = new Set<ClaimField>(['amount_usd', 'beneficiary', 'account_last4']);

const APPROX_WORDS_RE = /\b(about|around|roughly|approximately)\b/;

/** True when the amount at `text[idx..end)` is preceded within three words by an
 *  approximation word, or immediately followed by "ish". */
function isApproximateAt(text: string, idx: number, end: number): boolean {
  const before = text
    .slice(0, idx)
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .slice(-3)
    .join(' ')
    .toLowerCase();
  const after = text.slice(end).trimStart().toLowerCase();
  return APPROX_WORDS_RE.test(before) || after.startsWith('ish');
}

/** Condition (c): a negate-lexicon hit alone isn't enough — the utterance must also name
 *  the OLD value (e.g. "not 1.8, it's 1.9" contains "1.8", the figure it's disowning). */
function referencesPreviousValue(text: string, current: Claim): boolean {
  if (current.field === 'amount_usd') {
    const m = /\d+(?:\.\d+)?/.exec(current.quote.text);
    if (!m) return false;
    return new RegExp(`\\b${escapeRegExp(m[0])}\\b`).test(text);
  }
  if (current.field === 'account_last4') {
    return new RegExp(`\\b${escapeRegExp(String(current.value))}\\b`).test(text);
  }
  return text.toLowerCase().includes(current.quote.text.toLowerCase());
}

// fix (live barge-in rehearsal, report 2026-09-11T22-51-38-barge-in-interrupt.md): a
// readback's answer used to resolve ONLY on an affirm/negate lexicon hit ("yes"/"no"/
// "that's right"/...). A caller who instead just repeats the read-back value verbatim
// ("Meridian Supply.") hit neither lexicon, so the readback stayed PENDING forever --
// live, this looped the same readback line 5 times until idle timeout (then row 14, now row 15, ESCALATE,
// critical_fields_confirmed stayed false even though the caller never once gave a
// different value). Fix: a bare EXACT restatement of the readback's own value now also
// resolves it, as CONFIRMED. "Exact" is deliberately strict -- after normalizing case/
// punctuation and stripping up to one leading filler token ("yes"/"it's"/"that's"/
// "yeah"/"yep"), the ENTIRE remainder must equal the readback value's normalized form,
// not merely contain it. "Meridian Supply Inc" (a superset of readback value "Meridian
// Supply") therefore does NOT confirm -- ruling: treat it as unresolved (falls through
// to the 2-utterance cap below) rather than guessing whether "Inc" is the same company,
// since a materially different name is exactly the kind of thing this ledger exists to
// catch. A genuinely different value is untouched by this path; it is graded exactly as
// before by `processHit`/`classifyDifferentValue` further down this same utterance loop.
// Review fix (fail on e433670, Important): a literal token-for-token comparison misses
// two forms a caller routinely uses to restate a value the AGENT itself just spoke back
// in that same form -- a spoken-word amount ("eighty four thousand five hundred" for
// stored "84500") and a spaced-out digit readback for an account number ("4 4 7 1" for
// stored "4471", exactly how the live agent reads it: "the account ends in 4 4 7 1").
// Fixed by reusing the Sep-9 spoken-number parser (extractSpokenAmounts, already used by
// extractAmounts elsewhere in this file) for amount_usd, and by joining a run of bare
// single-digit tokens for account_last4, ONLY as fallbacks after the literal comparison
// fails -- so the existing digit-string and word-for-word paths are untouched.
const RESTATEMENT_FILLER_TOKENS = new Set(['yes', 'yeah', 'yep', 'its', 'thats']);

function isExactRestatement(field: ClaimField, text: string, expectedValue: string): boolean {
  const expectedNorm = normalizeText(expectedValue);
  if (expectedNorm.length === 0) return false;
  const tokens = normalizeText(text)
    .split(' ')
    .filter((w) => w.length > 0);
  let start = 0;
  while (start < tokens.length && RESTATEMENT_FILLER_TOKENS.has(tokens[start]!)) start += 1;
  const remainder = tokens.slice(start);
  if (remainder.length === 0) return false;
  if (remainder.join(' ') === expectedNorm) return true;

  if (field === 'amount_usd') {
    const remainderText = remainder.join(' ');
    const spokenHits = extractSpokenAmounts(remainderText);
    if (
      spokenHits.length === 1 &&
      spokenHits[0]!.start === 0 &&
      spokenHits[0]!.end === remainderText.length &&
      String(spokenHits[0]!.value_usd) === expectedNorm
    ) {
      return true;
    }
  }

  if (field === 'account_last4' && remainder.every((t) => /^\d$/.test(t))) {
    return remainder.join('') === expectedNorm;
  }

  return false;
}

/** The latest (most recently added) claim for `field`, or null. Claims are appended in
 *  time order and never reordered, so this is simply the last matching entry. */
export function currentClaim(claims: Claim[], field: ClaimField): Claim | null {
  for (let i = claims.length - 1; i >= 0; i--) {
    const claim = claims[i]!;
    if (claim.field === field) return claim;
  }
  return null;
}

export function isConfirmed(claims: Claim[], field: ClaimField): boolean {
  return currentClaim(claims, field)?.kind === 'CONFIRMED';
}

interface PendingReadback {
  action: AgentAction;
  utterancesSeen: number;
}

/** Fields that expect a person name as the answer (for identity extraction context). */
const PERSON_SHAPED_FIELDS = new Set<ClaimField>(['approver', 'counsel', 'beneficiary', 'escrow_institution']);

type TimelineEntry = { t_ms: number; kind: 'utterance'; u: Utterance } | { t_ms: number; kind: 'action'; a: AgentAction };

export function buildLedger(
  conversation: Utterance[],
  actions: AgentAction[],
  seed: SeedConfig,
  personQuestionAnswers?: Set<string>,
): { claims: Claim[]; request_version: number } {
  const callerUtterances = conversation.filter((u) => u.speaker === 'caller').sort((a, b) => a.t_ms - b.t_ms);

  // fix (run 34, report scripts/rehearse/reports/2026-09-11T22-48-44-structuring-two-wires.md):
  // AssemblyAI's endpointing can finalize one scripted caller line as two separate
  // transcript turns with no agent turn between them (real STT/turn-segmentation
  // variance -- see `classifyDifferentValue` below for the full story). Used to decide
  // whether a correction-lexicon hit in the PRECEDING caller utterance still counts for
  // the current one: only when nothing (no agent turn) happened in between.
  const agentTurnTimes = conversation.filter((u) => u.speaker === 'agent').map((u) => u.t_ms);
  function hasAgentTurnBetween(fromExclusive: number, toExclusive: number): boolean {
    return agentTurnTimes.some((t) => t > fromExclusive && t < toExclusive);
  }

  // Only readback_issued/challenge_issued actions matter to the ledger: the former drives
  // CONFIRMED/UNKNOWN and the repair window; both bound how long a readback stays "open for
  // an answer" (§C: the agent has moved on once it asks the next thing).
  const boundaryActions = actions
    .filter((a) => a.kind === 'readback_issued' || a.kind === 'challenge_issued')
    .sort((a, b) => a.t_ms - b.t_ms);

  const timeline: TimelineEntry[] = [
    ...callerUtterances.map((u): TimelineEntry => ({ t_ms: u.t_ms, kind: 'utterance', u })),
    ...boundaryActions.map((a): TimelineEntry => ({ t_ms: a.t_ms, kind: 'action', a })),
  ].sort((x, y) => x.t_ms - y.t_ms || (x.kind === 'action' ? -1 : 1));

  let claims: Claim[] = [];
  let request_version = 1;
  let nextId = 1;
  const activeReadback: Partial<Record<ClaimField, PendingReadback>> = {};
  const repairWindowSince: Partial<Record<ClaimField, number>> = {};

  // Compute which caller utterances are answers to person-shaped questions (approver, counsel, etc).
  //
  // FIX (2026-09-15, person-window lane): a caller (`buildLedger` is called from evaluate.ts)
  // can supply the SAME extended-window exemption set (computed with seed, claims, and the
  // reconstructed issued specs -- see personQuestion.ts) that fromTranscript.ts and
  // resolveIdentitySwitch already use, so all three `extractIdentityClaim` call sites agree.
  // Falling back to the bare 2-arg call here (no seed/claims/issued) is intentionally the OLD,
  // narrow behavior: it can only ever exempt the first caller utterance and, worse, cannot
  // resolve a `challenge_issued` action's field at all when the action carries no recorded
  // `spec` (the common corpus-fixture shape) -- since there's no `issued` to fall back to. That
  // makes the fallback a safe, deliberately-conservative PROVISIONAL pass only (see evaluate.ts's
  // two-pass ledger build), never the real exemption a caller answering a person question needs.
  const pqa = personQuestionAnswers ?? answersToPersonQuestion(conversation, actions);

  function addClaim(
    field: ClaimField,
    kind: ClaimKind,
    value: string | number,
    utterance_id: string,
    text: string,
    t_ms: number,
    supersedes: string | undefined,
    additive?: boolean,
  ): void {
    const claim: Claim = {
      id: `cl-${nextId}`,
      field,
      kind,
      value,
      quote: { utterance_id, text },
      t_ms,
      request_version,
      ...(supersedes !== undefined ? { supersedes } : {}),
      // entered_as records the original kind when the claim was first created,
      // preserved if the kind later changes (e.g., CORRECTED → CONFIRMED via readback)
      entered_as: kind,
      ...(additive !== undefined ? { additive } : {}),
    };
    nextId += 1;
    claims = [...claims, claim];
  }

  // fix-round-2 (red team item 2): an APPROXIMATE claim followed by a wildly different exact
  // value isn't a correction, it's a contradiction dressed up as one — "about fifty
  // thousand-ish" then "two hundred forty thousand" should count against the caller. Only
  // numeric fields (amount_usd) get this bound; non-numeric fields keep the old behavior.
  function isImplausibleJumpFromApproximate(field: ClaimField, oldValue: string | number, newValue: string | number): boolean {
    if (field !== 'amount_usd') return false;
    if (typeof oldValue !== 'number' || typeof newValue !== 'number' || oldValue === 0) return false;
    const ratio = newValue / oldValue;
    const bound = seed.thresholds.approximate_jump_ratio;
    return ratio > bound || ratio < 1 / bound;
  }

  function classifyDifferentValue(
    field: ClaimField,
    u: Utterance,
    current: Claim,
    value: string | number,
    precedingCorrectionText: string | undefined,
  ): ClaimKind {
    // Review fix (fail on e433670/d9846d0, Critical): the Sep-9 ratified magnitude bound
    // must gate EVERY correction-lexicon path, not just the APPROXIMATE-with-no-cue path
    // (b) below -- a cue's job is to explain a SMALL refinement, never to launder a jump
    // beyond the ratified bound. Computed once and reused by (a) and (a2): reviewer
    // proved that without this gate on (a2), "It's about fifty thousand-ish." ->
    // "Actually, hold on one second." -> "The wire will be two hundred forty thousand."
    // (no agent turn between the last two) graded the 4.8x jump CORRECTED purely because
    // "actually" sat in the immediately preceding turn, while the identical jump inside
    // one utterance (test 4b) stays CONTRADICTED. `isImplausibleJumpFromApproximate`
    // no-ops for anything but a numeric field whose CURRENT claim is APPROXIMATE, so this
    // gate never touches an ordinary correction (test 2 and friends are unaffected).
    const implausibleJump = current.kind === 'APPROXIMATE' && isImplausibleJumpFromApproximate(field, current.value, value);

    if (!implausibleJump && hasLexiconHit(u.text, seed.correction_lexicon)) return 'CORRECTED'; // (a)
    // (a2) fix (run 34, report 2026-09-11T22-48-44-structuring-two-wires.md): the
    // scripted line "Actually, there's a second one too -- $42,300 to the same account,
    // same vendor." is normally ONE utterance, so "actually" and the new amount land in
    // the same `u.text` and (a) fires. Live, AssemblyAI split it into two finalized
    // turns with no agent turn between them; "actually" landed in the PRIOR turn, so the
    // amount-bearing turn alone had no correction cue and fell through to CONTRADICTED,
    // which (combined with an already-failing context check) FROZE the call instead of
    // reaching row 9's structuring ESCALATE. Fix: also credit a correction-lexicon hit
    // found in the immediately preceding caller utterance, gated on `precedingCorrectionText`
    // being defined -- callers pass that only when there was no intervening agent turn
    // (see `hasAgentTurnBetween` above), mirroring the adjacency the readback affirm/
    // negate resolution loop already relies on. A correction word from further back, or
    // after the agent has moved on to something else, does not retroactively soften a
    // later contradiction. Gated on `!implausibleJump` for the same reason as (a) above.
    if (!implausibleJump && precedingCorrectionText !== undefined && hasLexiconHit(precedingCorrectionText, seed.correction_lexicon)) {
      return 'CORRECTED';
    }
    if (current.kind === 'APPROXIMATE' && !implausibleJump) return 'CORRECTED'; // (b)
    if (hasLexiconHit(u.text, seed.negate_lexicon) && referencesPreviousValue(u.text, current)) return 'CORRECTED'; // (c)
    const repairSince = repairWindowSince[field];
    if (repairSince !== undefined && u.t_ms - repairSince <= seed.thresholds.correction_window_ms) {
      delete repairWindowSince[field]; // (d) — the repair window is spent once used
      return 'CORRECTED';
    }
    return 'CONTRADICTED';
  }

  // Non-identity fields: first sighting is STATED (or APPROXIMATE); a later different value
  // is classified by `classifyDifferentValue`; a repeated same value is a no-op here (the
  // readback resolution below is the only route to CONFIRMED/UNKNOWN).
  function processHit(
    field: ClaimField,
    rawValue: string | number,
    quote: string,
    u: Utterance,
    approximate: boolean,
    precedingCorrectionText: string | undefined,
  ): void {
    const value = normalizeValue(field, rawValue);
    const current = currentClaim(claims, field);
    if (!current) {
      addClaim(field, approximate ? 'APPROXIMATE' : 'STATED', value, u.id, quote, u.t_ms, undefined);
      return;
    }
    if (current.value === value) return;
    const kind = classifyDifferentValue(field, u, current, value, precedingCorrectionText);
    if (VERSIONED_FIELDS.has(field)) request_version += 1;
    // Founder ruling 2026-09-14: a CORRECTED claim that is additive (hits additive_lexicon)
    // indicates a new transaction, not a replacement. This flag is read by compose.ts
    // buildExposureEvidence to distinguish "also $42k" (both count) from "sorry $42k" (withdrawn).
    // Check both current utterance AND immediately preceding caller utterance (no agent turn
    // between), mirroring the correction-lexicon path (a2) to handle split-turn transcripts.
    const additive = kind === 'CORRECTED' && (
      hasLexiconHit(u.text, seed.additive_lexicon) ||
      (precedingCorrectionText !== undefined && hasLexiconHit(precedingCorrectionText, seed.additive_lexicon))
    );
    addClaim(field, kind, value, u.id, quote, u.t_ms, current.id, additive);
  }

  let previousCallerUtterance: Utterance | null = null;

  for (const entry of timeline) {
    if (entry.kind === 'action') {
      // Any readback_issued or challenge_issued action closes out whatever was pending —
      // the follow-up window for a readback ends at the NEXT such action (§C).
      for (const f of Object.keys(activeReadback) as ClaimField[]) delete activeReadback[f];
      if (entry.a.kind === 'readback_issued' && entry.a.field) {
        activeReadback[entry.a.field] = { action: entry.a, utterancesSeen: 0 };
      }
      continue;
    }

    const u = entry.u;

    // Fix (bare-name-challenge-answer): Determine if this utterance is answering a
    // person-focused readback/challenge so we can skip false identity claims (rule b).
    // Check both active readbacks AND the precomputed set of challenge answers.
    const answeringPersonQuestion =
      Object.keys(activeReadback).some((field) => PERSON_SHAPED_FIELDS.has(field as ClaimField)) ||
      pqa.has(u.id);

    // See `classifyDifferentValue`'s (a2) comment: defined only when the immediately
    // preceding caller utterance exists AND no agent turn happened between it and this
    // one -- the two conditions that make crediting its correction-lexicon word safe.
    const precedingCorrectionText =
      previousCallerUtterance && !hasAgentTurnBetween(previousCallerUtterance.t_ms, u.t_ms)
        ? previousCallerUtterance.text
        : undefined;

    // Resolve any pending readback(s) with this utterance, capped at 2 utterances (§C).
    for (const field of Object.keys(activeReadback) as ClaimField[]) {
      const pending = activeReadback[field];
      if (!pending) continue;
      pending.utterancesSeen += 1;
      const negated = hasLexiconHit(u.text, seed.negate_lexicon);
      const affirmed = hasLexiconHit(u.text, seed.affirm_lexicon);
      const restated =
        !negated && !affirmed && pending.action.value !== undefined && isExactRestatement(field, u.text, pending.action.value);
      if (negated || affirmed || restated) {
        const current = currentClaim(claims, field);
        if (current && pending.action.value !== undefined && normalizeValue(field, pending.action.value) === current.value) {
          if (negated) {
            const currentId = current.id;
            claims = claims.map((c) => (c.id === currentId ? { ...c, kind: 'UNKNOWN' as ClaimKind } : c));
            repairWindowSince[field] = pending.action.t_ms;
          } else {
            // affirmed (lexicon hit) or restated (bare exact repeat of the value) both
            // resolve the readback the same way. Preserve entered_as so we can later tell
            // if this was originally a CORRECTED claim.
            const currentId = current.id;
            claims = claims.map((c) => (c.id === currentId ? { ...c, kind: 'CONFIRMED' as ClaimKind } : c));
          }
        }
        delete activeReadback[field];
      } else if (pending.utterancesSeen >= 2) {
        delete activeReadback[field]; // exhausted the cap without a resolving reply
      }
    }

    // Identity: value is the seed identity id itself, never text-normalized. A switch to a
    // DIFFERENT identity is always CONTRADICTED (never a "correction" — see amendment §B).
    const idHit = extractIdentityClaim(u.text, seed, answeringPersonQuestion);
    if (idHit) {
      const current = currentClaim(claims, 'identity');
      if (!current) {
        addClaim('identity', 'STATED', idHit.identity_id, u.id, idHit.quote, u.t_ms, undefined);
      } else if (current.value !== idHit.identity_id) {
        request_version += 1;
        addClaim('identity', 'CONTRADICTED', idHit.identity_id, u.id, idHit.quote, u.t_ms, current.id);
      }
    }

    // extractAmounts can yield an overlapping duplicate for a mixed numeric+scale-word
    // mention (e.g. "$1.8 million" plus a spurious standalone-"million" spoken hit); a
    // search cursor that only ever advances forward skips any hit whose quote can't be
    // found past the previous one's end, which discards exactly those duplicates while
    // still finding any genuine second amount mentioned later in the utterance.
    let cursor = 0;
    for (const amount of extractAmounts(u.text)) {
      const idx = u.text.indexOf(amount.quote, cursor);
      if (idx === -1) continue;
      const end = idx + amount.quote.length;
      cursor = end;
      processHit('amount_usd', amount.value_usd, amount.quote, u, isApproximateAt(u.text, idx, end), precedingCorrectionText);
    }

    const account = extractAccountLast4(u.text);
    if (account) processHit('account_last4', account.value, account.quote, u, false, precedingCorrectionText);

    const deadline = extractDeadline(u.text);
    if (deadline) processHit('deadline', deadline.value, deadline.quote, u, false, precedingCorrectionText);

    for (const cued of extractCuedNames(u.text)) {
      processHit(cued.field, cued.value, cued.quote, u, false, precedingCorrectionText);
    }

    previousCallerUtterance = u;
  }

  return { claims, request_version };
}
