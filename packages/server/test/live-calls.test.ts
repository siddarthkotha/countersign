import { describe, it, expect } from 'vitest';
import { isCreditsExhaustedError, classifyMintFailure } from '../src/live_calls.js';

describe('isCreditsExhaustedError', () => {
  // Review fix (2026-09-11, CRITICAL finding): 402 is the only status code that
  // unambiguously means "payment/credits" -- 401/403 are just as likely to mean "wrong or
  // rotated API key" (a judge would then wrongly be told "demo credits are exhausted"),
  // and 429 is an ordinary rate limit that happens routinely on a Render cold start. Only
  // a real credit/quota keyword or the 402 status counts as credits_exhausted; everything
  // else is classified as a generic mint_error by the caller (see caps.ts).
  it('matches on the 402 status code alone', () => {
    expect(isCreditsExhaustedError({ status: 402 })).toBe(true);
  });

  it('does NOT match on 401, 403 or 429 alone -- those are mint_error, not credits', () => {
    expect(isCreditsExhaustedError({ status: 401 })).toBe(false);
    expect(isCreditsExhaustedError({ status: 403 })).toBe(false);
    expect(isCreditsExhaustedError({ status: 429 })).toBe(false);
  });

  it('matches on a credit/quota/insufficient/billing keyword in the message alone, case-insensitively', () => {
    expect(isCreditsExhaustedError({ message: 'Insufficient credits remaining' })).toBe(true);
    expect(isCreditsExhaustedError({ message: 'account QUOTA exceeded' })).toBe(true);
    expect(isCreditsExhaustedError({ message: 'insufficient balance' })).toBe(true);
    expect(isCreditsExhaustedError({ message: 'billing issue on this account' })).toBe(true);
  });

  it('a keyword still matches even paired with a non-402 status (401/403/429)', () => {
    expect(isCreditsExhaustedError({ status: 401, message: 'insufficient credits' })).toBe(true);
    expect(isCreditsExhaustedError({ status: 429, message: 'quota exceeded' })).toBe(true);
  });

  it('does not match an unrelated status with an unrelated message', () => {
    expect(isCreditsExhaustedError({ status: 500, message: 'internal server error' })).toBe(false);
    expect(isCreditsExhaustedError({ status: 400, message: 'bad request' })).toBe(false);
  });

  it('does not match with neither status nor message given', () => {
    expect(isCreditsExhaustedError({})).toBe(false);
  });
});

describe('classifyMintFailure', () => {
  it('pulls the status code back out of mintToken-style error messages', () => {
    expect(classifyMintFailure(new Error('token mint failed: 402'))).toEqual({
      status: 402,
      message: 'token mint failed: 402',
    });
  });

  it('leaves status undefined when the message has no 3-digit code', () => {
    expect(classifyMintFailure(new Error('token mint failed: no api key configured'))).toEqual({
      message: 'token mint failed: no api key configured',
    });
  });

  it('stringifies a non-Error thrown value', () => {
    expect(classifyMintFailure('boom')).toEqual({ message: 'boom' });
  });
});
