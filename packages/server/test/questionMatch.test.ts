import { describe, it, expect } from 'vitest';
import type { ChallengeSpec, PhrasingGoal } from '@countersign/engine';
import {
  transcriptAsksQuestion,
  verbatimQuestionSentence,
  QUESTION_IMPERATIVE_STARTS,
  QUESTION_LEAD_INS,
  transcriptContainsLoadBearingValue,
  loadBearingValueFor,
  replyCoversCurrentRendering,
  QUESTION_GOALS,
} from '../src/call/questionMatch.js';

// GREET-GREETING-SWAP audit (2026-09-25, founder ruling: DEFAULT_GREETING now asks "Who am I
// speaking with?" instead of "How can I help you today?", packages/server/src/aai/config.ts).
// `call/session.ts` labels the AAI-automatic greeting reply's `replyGoalAtStart` as `GREET`
// (the goal already in force from `start()`'s first `tick()`, before any caller speech has
// landed) -- never `ELICIT_IDENTITY`, regardless of what the greeting's own audio text asks.
// This is the one invariant that makes the rest of the greeting swap safe: as long as `GREET`
// stays out of `QUESTION_GOALS`, the greeting can never register as an owed/asked identity
// question in `maybeReaskQuestion`'s or `maybeSendReplyCreateAfterReplyDone`'s own bookkeeping
// (both gate on `QUESTION_GOALS.has(goal.code)` before doing anything -- see each one's own
// call site in session.ts), so it can never suppress the real `ELICIT_IDENTITY` ask that
// follows once a caller states a request with no name.
describe('QUESTION_GOALS excludes GREET (greeting-swap safety invariant, 2026-09-25)', () => {
  it('does not include GREET', () => {
    expect(QUESTION_GOALS.has('GREET')).toBe(false);
  });
});

// Imperative-question false-negative fix (2026-09-14): unit tests for the matcher extension
// that lets an imperative request ("Please state X.") count as asking, per
// scripts/rehearse/reports/2026-09-14T17-18-03-dana-patient.md's PROVEN live double-ask.
// See questionMatch.ts's own doc comment for the mechanism.
describe('transcriptAsksQuestion', () => {
  describe('literal "?" still passes', () => {
    it('matches a plain question', () => {
      expect(transcriptAsksQuestion('What is the account number?', null)).toBe(true);
    });
  });

  describe('verbatim sentence match still passes', () => {
    it('matches when the transcript contains the goal\'s composed sentence', () => {
      const sentence = 'Please restate the dollar amount you provided earlier.';
      expect(transcriptAsksQuestion(sentence, sentence)).toBe(true);
    });
  });

  describe('imperative phrasing (the live bug)', () => {
    it('the exact live first phrasing counts as asking', () => {
      expect(
        transcriptAsksQuestion('Please state the purpose of this payment to Meridian Supply.', null),
      ).toBe(true);
    });

    it('the exact live second (redundant reask) phrasing also counts as asking', () => {
      expect(transcriptAsksQuestion('What this payment to Meridian Supply is for?', null)).toBe(true);
    });

    it('the exact live restate-amount first phrasing counts as asking', () => {
      expect(transcriptAsksQuestion('Please restate the dollar amount you provided earlier.', null)).toBe(
        true,
      );
    });

    it('the exact live restate-amount reask phrasing also counts as asking', () => {
      expect(
        transcriptAsksQuestion('Can you restate the amount in dollars you gave me earlier?', null),
      ).toBe(true);
    });

    for (const start of QUESTION_IMPERATIVE_STARTS) {
      it(`matches an imperative sentence starting with "${start}"`, () => {
        expect(transcriptAsksQuestion(`${start} the account balance.`, null)).toBe(true);
      });
    }

    it('matches after stripping a known lead-in clause', () => {
      expect(
        transcriptAsksQuestion(
          'Authority and urgency are not verification. Please state the purpose of this payment to Meridian Supply.',
          null,
        ),
      ).toBe(true);
    });

    it('matches the other known lead-in phrasing too', () => {
      for (const leadIn of QUESTION_LEAD_INS) {
        expect(transcriptAsksQuestion(`${leadIn}. Please confirm the routing number.`, null)).toBe(true);
      }
    });
  });

  describe('negative cases stay negative', () => {
    it('does not match a bare holding line', () => {
      expect(transcriptAsksQuestion('Checking the record.', null)).toBe(false);
    });

    it('does not match a bare verification holding line', () => {
      expect(transcriptAsksQuestion('One moment while I verify the account details.', null)).toBe(false);
    });

    it('does not match "Please hold." -- please-hold is a holding line, not a question', () => {
      expect(transcriptAsksQuestion('Please hold.', null)).toBe(false);
    });

    it('does not match "Please wait while I verify the request." -- please-wait is a holding line too', () => {
      expect(transcriptAsksQuestion('Please wait while I verify the request.', null)).toBe(false);
    });

    it('does not match an empty transcript', () => {
      expect(transcriptAsksQuestion('', null)).toBe(false);
    });

    it('does not match whitespace only', () => {
      expect(transcriptAsksQuestion('   ', null)).toBe(false);
    });
  });

  describe('ELICIT_REQUEST engine-composed sentences (review fix 2026-09-15)', () => {
    // The engine's elicitRequestSentence (fsm.ts ~line 199) now composes exact, speakable
    // sentences for ELICIT_REQUEST goals instead of paraphrase instructions. These tests
    // verify that the question-reask logic in session.ts (maybeReaskQuestion) correctly
    // recognizes these engine-composed sentences as questions that were asked, so the
    // server does not re-ask when the model already spoke them.
    it('recognizes "What do you need today?" as a question (intent not stated, no beneficiary)', () => {
      const elicitSentence = 'What do you need today?';
      expect(transcriptAsksQuestion(elicitSentence, elicitSentence)).toBe(true);
    });

    it('recognizes "What is the exact amount for this payment to <beneficiary>?" as a question (amount elicit with beneficiary)', () => {
      const beneficiary = 'Meridian Supply';
      const elicitSentence = `What is the exact amount for this payment to ${beneficiary}?`;
      expect(transcriptAsksQuestion(elicitSentence, elicitSentence)).toBe(true);
    });

    it('recognizes "What is the exact amount you need to send, and to which vendor?" as a question (amount elicit without beneficiary)', () => {
      const elicitSentence = 'What is the exact amount you need to send, and to which vendor?';
      expect(transcriptAsksQuestion(elicitSentence, elicitSentence)).toBe(true);
    });

    it('negative case: a holding line like "Checking your account balance." is not an ELICIT_REQUEST question', () => {
      // This is a negative test to ensure holding lines are not confused with questions
      const holdingLine = 'Checking your account balance.';
      expect(transcriptAsksQuestion(holdingLine, null)).toBe(false);
    });
  });
});

// Push-53 fix (2026-09-18 continued, P0 -- PROVEN live from
// scripts/rehearse/reports/2026-09-18T15-52-39-miller-patient.diagnostics.json, 39398/43240):
// the push-52 label-attachment fix (sentenceNamesLabelWithRestateCue) still missed a paraphrase
// of the LABEL ITSELF, not just the sentence around it -- the ambient reply said "restate the
// dollar amount you requested earlier?" (39398), our own instructed reply said "restate the
// amount in dollars you gave me earlier?" (43240) four seconds later, and both were logged as
// separate challenge_issued actions. `spokenField('amount_usd')` is exactly one canonical
// string, "amount in dollars" -- the cue attached to it fine, but the ambient reply's own words
// were a different, equally natural label for the SAME field concept, so the old single-string
// check never matched.
//
// Fix (questionMatch.ts): `LABEL_SYNONYMS` widens the label-attachment check from one canonical
// string to a small, per-field set drawn from the engine's OWN vocabulary for that field
// (challenges.ts's `spokenField`, fsm.ts's `readbackSentence`/`elicitMissingSentence`,
// extract/claims.ts's own comment) -- never invented. A second, previously-latent gap surfaced
// while fixing this: `transcriptContainsLoadBearingValue`'s digit-shaped-field branch
// (`field === 'account_last4' || field === 'amount_usd'`) ran UNCONDITIONALLY before the
// `kind === 'label'` check, so a LIVE_COMMITMENT amount_usd challenge or a RELATIONAL
// account_last4 challenge (both `kind: 'label'`, `value` = the spoken LABEL, never an actual
// digit/amount) could never even reach the label-attachment check at all -- the digit branch
// always intercepted first, tried to find a digit run equal to a non-numeric label string, and
// always returned false. The 'label' branch is now checked FIRST; the digit branch (unchanged
// internally) is now reached only for `kind: 'specific'` (READBACK's own real digit/amount
// values), exactly as it always was for every OTHER field.
describe('transcriptContainsLoadBearingValue / loadBearingValueFor -- field-CONCEPT synonym widening (push-53, 2026-09-18 continued, P0)', () => {
  describe('(a) LIVE_COMMITMENT amount_usd: PROVEN live paraphrase, scripts/rehearse/reports/2026-09-18T15-52-39-miller-patient.diagnostics.json (39398/43240)', () => {
    const OUR_SENTENCE = 'Can you restate the amount in dollars you gave me earlier?';
    const challenge: ChallengeSpec = {
      challenge_id: 'test-amount-usd-live-commitment',
      kind: 'LIVE_COMMITMENT',
      field: 'amount_usd',
      ask: 'Ask the caller to restate the amount in dollars they gave earlier. Do not say the value yourself.',
      speak: OUR_SENTENCE,
      expect: { commitment_claim_id: 'claim-amount-1' },
    };
    const goal: PhrasingGoal = { code: 'ASK_CHALLENGE', hint: OUR_SENTENCE, keyterms: [], turn_detection_hint: 'patient', challenge };

    it('loadBearingValueFor still reports the canonical spokenField label, unchanged', () => {
      expect(loadBearingValueFor(goal)).toEqual({ field: 'amount_usd', value: 'amount in dollars', kind: 'label' });
    });

    it('RED (pre-fix): MUST suppress -- the ambient reply\'s own PROVEN live paraphrase, "restate the dollar amount", names a SYNONYM of the field label with the cue attached, not the canonical string', () => {
      const ambient = 'Authority or urgency is not verification. Can you please restate the dollar amount you requested earlier?';
      expect(replyCoversCurrentRendering(ambient, goal)).toBe(true);
    });

    it('still suppresses the canonical exact label too ("amount in dollars")', () => {
      expect(replyCoversCurrentRendering('Can you restate the amount in dollars you requested earlier?', goal)).toBe(true);
    });

    // Tightened after the push-53 review (PROVEN false suppression): the bare word "amount" is
    // no longer a synonym, because with it any ambient sentence attaching a cue to that one
    // common word ate our real ask -- the reviewer's own probe "restate the amount you charged
    // us last month?" suppressed. Neither PROVEN live paraphrase needed it (the miller-patient
    // record's ambient line said "dollar amount"), so the cost of dropping it is that an ambient
    // reply saying only "the amount" is answered by our ask going out again: an extra question,
    // never a silenced one.
    it('MUST NOT suppress the bare word "amount" alone, even with the cue attached', () => {
      expect(replyCoversCurrentRendering('One moment. Can you restate the amount you gave me earlier?', goal)).toBe(false);
    });

    it("guard rail (reviewer probe): MUST NOT suppress \"restate the amount you charged us last month?\" -- unrelated content", () => {
      expect(replyCoversCurrentRendering('Can you restate the amount you charged us last month?', goal)).toBe(false);
    });

    it('guard rail: MUST NOT suppress "Can you hold while I check the amount?" -- "can you" attaches to "hold", never to a restate of the amount', () => {
      expect(replyCoversCurrentRendering('Can you hold while I check the amount?', goal)).toBe(false);
    });

    it('guard rail: MUST NOT suppress "Give me a moment, I am looking at the dollar amount?" -- "give me" attaches to "a moment", never the label', () => {
      expect(replyCoversCurrentRendering('Give me a moment, I am looking at the dollar amount?', goal)).toBe(false);
    });

    it('guard rail: MUST NOT suppress "Is the amount correct?" -- a yes/no question about the value, never a restate/supply request', () => {
      expect(replyCoversCurrentRendering('Is the amount correct?', goal)).toBe(false);
    });
  });

  describe('(b) RELATIONAL account_last4: same widening, justified by fsm.ts\'s own shorter forms ("last four digits", "the account ends in")', () => {
    const OUR_SENTENCE = 'Can you give me the last four digits of the account attached to the beneficiary you named?';
    const challenge: ChallengeSpec = {
      challenge_id: 'test-account-last4-relational',
      kind: 'RELATIONAL',
      field: 'account_last4',
      ask: 'Ask for the last four digits of the account attached to the beneficiary they named.',
      speak: OUR_SENTENCE,
      expect: { accept_tokens: ['4471'] },
    };
    const goal: PhrasingGoal = { code: 'ASK_CHALLENGE', hint: OUR_SENTENCE, keyterms: [], turn_detection_hint: 'patient', challenge };

    // Tightened after the push-53 review, same reason as amount_usd above: the reviewer's probe
    // "give me the account holder's name?" suppressed while the bare word "account" was a
    // synonym. Dropping it costs one extra ask when an ambient reply says only "the account".
    it('MUST NOT suppress the bare word "account" alone, even with the cue attached', () => {
      expect(replyCoversCurrentRendering('Can you give me the account number attached to the beneficiary you named?', goal)).toBe(false);
    });

    it("guard rail (reviewer probe): MUST NOT suppress \"give me the account holder's name?\" -- unrelated content", () => {
      expect(replyCoversCurrentRendering("Can you give me the account holder's name?", goal)).toBe(false);
    });

    it('RED (pre-fix, latent): a paraphrase naming "last four digits" alone (no "of the account") MUST suppress', () => {
      expect(replyCoversCurrentRendering('Can you restate the last four digits you gave me earlier?', goal)).toBe(true);
    });

    it('guard rail: MUST NOT suppress "Can you hold while I check the account?" -- "can you" attaches to "hold"', () => {
      expect(replyCoversCurrentRendering('Can you hold while I check the account?', goal)).toBe(false);
    });

    it('guard rail: MUST NOT suppress "Is the account correct?" -- a yes/no question, never a restate/supply request', () => {
      expect(replyCoversCurrentRendering('Is the account correct?', goal)).toBe(false);
    });
  });

  describe('(c) regression: kind "specific" digit-run matching for amount_usd/account_last4 (READBACK) is unaffected by "label" now being checked first', () => {
    it('amount_usd specific: spoken-amount digit match still works', () => {
      expect(
        transcriptContainsLoadBearingValue(
          'One moment. Just to confirm, the amount is eighty four thousand five hundred dollars. Is that correct?',
          'amount_usd',
          '84500',
          'specific',
        ),
      ).toBe(true);
    });

    it('account_last4 specific: spoken-digit-run match still works', () => {
      expect(
        transcriptContainsLoadBearingValue(
          'One moment. Just to confirm, the account ends in 4 4 7 1. Is that correct?',
          'account_last4',
          '4471',
          'specific',
        ),
      ).toBe(true);
    });

    it('amount_usd specific: no "?" still fails closed, unchanged', () => {
      expect(
        transcriptContainsLoadBearingValue('The amount is eighty four thousand five hundred dollars.', 'amount_usd', '84500', 'specific'),
      ).toBe(false);
    });
  });

  describe('(d) every other label field keeps its single canonical spokenField form only -- no synonyms invented without a PROVEN incident or engine-vocabulary basis', () => {
    it('deadline: canonical label still required, unaffected by this fix -- an un-justified synonym must NOT suppress', () => {
      const OUR_SENTENCE = 'Can you restate the deadline you gave me earlier?';
      const challenge: ChallengeSpec = {
        challenge_id: 'test-deadline-unaffected',
        kind: 'LIVE_COMMITMENT',
        field: 'deadline',
        ask: 'Ask the caller to restate the deadline they gave earlier. Do not say the value yourself.',
        speak: OUR_SENTENCE,
        expect: { commitment_claim_id: 'claim-deadline-1' },
      };
      const goal: PhrasingGoal = { code: 'ASK_CHALLENGE', hint: OUR_SENTENCE, keyterms: [], turn_detection_hint: 'patient', challenge };
      expect(replyCoversCurrentRendering('Can you restate the deadline you gave me earlier?', goal)).toBe(true);
      expect(replyCoversCurrentRendering('Can you restate the due date you gave me earlier?', goal)).toBe(false);
    });
  });
});
