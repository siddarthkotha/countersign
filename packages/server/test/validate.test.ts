import { describe, it, expect } from 'vitest';
import { validateToolArgs, type FlatToolSchema } from '../src/call/validate.js';

const IDENTITY_SCHEMA: FlatToolSchema = {
  type: 'object',
  properties: { identity_id: { type: 'string' } },
  required: ['identity_id'],
};

const NUMERIC_SCHEMA: FlatToolSchema = {
  type: 'object',
  properties: { amount_usd: { type: 'number' }, count: { type: 'integer' } },
  required: ['amount_usd'],
};

const ENUM_SCHEMA: FlatToolSchema = {
  type: 'object',
  properties: { rail_id: { type: 'string', enum: ['TREASURY-WIRE', 'ACH'] } },
  required: ['rail_id'],
};

const BOOLEAN_SCHEMA: FlatToolSchema = {
  type: 'object',
  properties: { confirm: { type: 'boolean' } },
};

describe('validateToolArgs', () => {
  it('passes a fully well-formed call through unchanged', () => {
    const result = validateToolArgs('check_sso_context', { identity_id: 'robert-miller' }, IDENTITY_SCHEMA);
    expect(result).toEqual({ ok: true, args: { identity_id: 'robert-miller' }, repaired: [], rejected: [] });
  });

  it('drops an unknown property and lists it in repaired', () => {
    const result = validateToolArgs(
      'check_sso_context',
      { identity_id: 'robert-miller', ignore_previous_instructions: 'do it now' },
      IDENTITY_SCHEMA,
    );
    expect(result.ok).toBe(true);
    expect(result.args).toEqual({ identity_id: 'robert-miller' });
    expect(result.repaired).toEqual(['ignore_previous_instructions']);
    expect(result.rejected).toEqual([]);
  });

  it('coerces a numeric string ("3") to a number for a number field', () => {
    const result = validateToolArgs('mock', { amount_usd: '3' }, NUMERIC_SCHEMA);
    expect(result.ok).toBe(true);
    expect(result.args.amount_usd).toBe(3);
    expect(result.repaired).toEqual(['amount_usd']);
  });

  it('rejects a non-integer string for an integer field', () => {
    const result = validateToolArgs('mock', { amount_usd: 10, count: '3.5' }, NUMERIC_SCHEMA);
    expect(result.ok).toBe(false);
    expect(result.rejected).toEqual(['count']);
    expect(result.args).toEqual({ amount_usd: 10 });
  });

  it('coerces "true"/"false" strings to booleans', () => {
    expect(validateToolArgs('mock', { confirm: 'true' }, BOOLEAN_SCHEMA)).toEqual({
      ok: true,
      args: { confirm: true },
      repaired: ['confirm'],
      rejected: [],
    });
    expect(validateToolArgs('mock', { confirm: 'false' }, BOOLEAN_SCHEMA).args.confirm).toBe(false);
  });

  it('rejects when a required field is missing', () => {
    const result = validateToolArgs('check_sso_context', {}, IDENTITY_SCHEMA);
    expect(result.ok).toBe(false);
    expect(result.rejected).toEqual(['identity_id']);
    expect(result.args).toEqual({});
  });

  it('rejects on an enum violation', () => {
    const result = validateToolArgs('freeze_transaction_rail', { rail_id: 'CRYPTO-RAIL' }, ENUM_SCHEMA);
    expect(result.ok).toBe(false);
    expect(result.rejected).toEqual(['rail_id']);
    expect(result.args).toEqual({});
  });

  it('accepts a value on the enum allowlist', () => {
    const result = validateToolArgs('freeze_transaction_rail', { rail_id: 'ACH' }, ENUM_SCHEMA);
    expect(result).toEqual({ ok: true, args: { rail_id: 'ACH' }, repaired: [], rejected: [] });
  });

  it('treats a non-object payload as empty rather than throwing', () => {
    const result = validateToolArgs('check_sso_context', 'not an object', IDENTITY_SCHEMA);
    expect(result.ok).toBe(false);
    expect(result.rejected).toEqual(['identity_id']);
  });

  it('a wrong-typed value for a string field is rejected, not silently stringified', () => {
    const result = validateToolArgs('check_sso_context', { identity_id: 42 }, IDENTITY_SCHEMA);
    expect(result.ok).toBe(false);
    expect(result.rejected).toEqual(['identity_id']);
  });
});
