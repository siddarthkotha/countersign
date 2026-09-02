import { describe, it, expect } from 'vitest';
import type { ToolName } from '@countersign/engine';
import { toolSchemasFor } from '../src/call/allowlist.js';

const ALL_TOOLS: ToolName[] = [
  'get_request_history',
  'check_sso_context',
  'verify_out_of_band',
  'stage_payment_for_second_approval',
  'freeze_transaction_rail',
  'open_incident',
  'alert_principal',
  'seal_evidence_record',
];

// v2 controller ruling removed `record_answer` from ToolName -- it must never come back.
const RECORD_ANSWER = 'record_answer';

describe('toolSchemasFor', () => {
  it('returns one flat schema per allowed tool name, in order', () => {
    const schemas = toolSchemasFor(ALL_TOOLS);
    expect(schemas.map((s) => s.name)).toEqual(ALL_TOOLS);
  });

  it('returns [] for an empty allowlist (e.g. INTAKE)', () => {
    expect(toolSchemasFor([])).toEqual([]);
  });

  it('every schema is flat: type/name/description/parameters/execution_mode/timeout_seconds', () => {
    for (const schema of toolSchemasFor(ALL_TOOLS)) {
      expect(schema.type).toBe('function');
      expect(typeof schema.name).toBe('string');
      expect(typeof schema.description).toBe('string');
      expect(schema.description.length).toBeGreaterThan(0);
      expect(typeof schema.parameters).toBe('object');
      expect(['hold', 'interactive']).toContain(schema.execution_mode);
      expect(schema.timeout_seconds).toBeGreaterThan(0);
    }
  });

  it('holds for verify_out_of_band and every terminal action', () => {
    const holdNames: ToolName[] = [
      'verify_out_of_band',
      'stage_payment_for_second_approval',
      'freeze_transaction_rail',
      'open_incident',
      'alert_principal',
      'seal_evidence_record',
    ];
    const schemas = toolSchemasFor(holdNames);
    for (const s of schemas) {
      expect(s.execution_mode).toBe('hold');
    }
  });

  it('is interactive for the two fast lookups', () => {
    const schemas = toolSchemasFor(['get_request_history', 'check_sso_context']);
    for (const s of schemas) {
      expect(s.execution_mode).toBe('interactive');
    }
  });

  it('never produces a schema named record_answer, and never claims detection in any description', () => {
    const schemas = toolSchemasFor(ALL_TOOLS);
    const names: string[] = schemas.map((s) => s.name);
    expect(names).not.toContain(RECORD_ANSWER);
    const banned = ['deepfake', 'synthetic voice', 'clone', 'biometric', 'detect'];
    for (const s of schemas) {
      const text = s.description.toLowerCase();
      for (const word of banned) {
        expect(text).not.toContain(word);
      }
    }
  });

  it('respects a restricted allowlist (per-state enforcement upstream) -- only asked-for tools come back', () => {
    const schemas = toolSchemasFor(['get_request_history']);
    expect(schemas).toHaveLength(1);
    expect(schemas[0]!.name).toBe('get_request_history');
  });
});
