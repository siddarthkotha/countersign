import { describe, it, expect } from 'vitest';
import {
  transcriptAsksQuestion,
  verbatimQuestionSentence,
  QUESTION_IMPERATIVE_STARTS,
  QUESTION_LEAD_INS,
} from '../src/call/questionMatch.js';

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
