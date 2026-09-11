import { describe, it, expect } from 'vitest';
import { isCreditsExhaustedError, classifyMintFailure } from '../src/live_calls.js';

describe('isCreditsExhaustedError', () => {
  it('matches on a credit-style status code alone', () => {
    expect(isCreditsExhaustedError({ status: 402 })).toBe(true);
    expect(isCreditsExhaustedError({ status: 401 })).toBe(true);
    expect(isCreditsExhaustedError({ status: 403 })).toBe(true);
    expect(isCreditsExhaustedError({ status: 429 })).toBe(true);
  });

  it('matches on a credit/quota/insufficient/billing keyword in the message alone, case-insensitively', () => {
    expect(isCreditsExhaustedError({ message: 'Insufficient credits remaining' })).toBe(true);
    expect(isCreditsExhaustedError({ message: 'account QUOTA exceeded' })).toBe(true);
    expect(isCreditsExhaustedError({ message: 'insufficient balance' })).toBe(true);
    expect(isCreditsExhaustedError({ message: 'billing issue on this account' })).toBe(true);
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
