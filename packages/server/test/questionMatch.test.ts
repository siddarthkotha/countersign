import { describe, it, expect } from 'vitest';
import {
  transcriptAsksQuestion,
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
});
