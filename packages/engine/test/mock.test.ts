// packages/engine/test/mock.test.ts
import { describe, expect, it } from 'vitest';
import { mockToolResult } from '../src/mock/backend';
import { MERIDIAN } from '../src/seed/meridian';

describe('mock backend', () => {
  const ctx = { evidence_count: 5, incident_index: 0 };

  it('is deterministic from the seed', () => {
    expect(mockToolResult('check_sso_context', { identity_id: 'robert-miller' }, MERIDIAN, ctx)).toEqual({
      session_active: true,
      geo: 'Frankfurt, DE',
      device: 'MacBook Pro (managed)',
    });
    expect(mockToolResult('open_incident', { severity: 'high' }, MERIDIAN, ctx)).toEqual({ incident_id: 'INC-8092' });
    expect(mockToolResult('verify_out_of_band', { identity_id: 'robert-miller', method: 'push' }, MERIDIAN, ctx)).toMatchObject({
      response: 'no_response',
      devices: 2,
    });
    expect(mockToolResult('get_request_history', { identity_id: 'dana-whitfield' }, MERIDIAN, ctx)).toMatchObject({
      matches: [{ vendor: 'Meridian Supply', amount_usd: 84_500 }],
    });
  });

  it('never returns a release', () => {
    const r = mockToolResult('stage_payment_for_second_approval', { amount_usd: 84_500 }, MERIDIAN, ctx);
    expect(r).toMatchObject({ status: 'SECOND_APPROVAL_PENDING', approver_id: 'marcus-obi' });
    expect(JSON.stringify(r).toLowerCase()).not.toContain('released');
    expect(JSON.stringify(mockToolResult('freeze_transaction_rail', { rail_id: 'TREASURY-WIRE', reason: 'x' }, MERIDIAN, ctx)).toLowerCase()).not.toContain(
      'released',
    );
  });

  it('echoes request_version for the identity-driven evidence tools, but not on the exact shapes above', () => {
    expect(mockToolResult('verify_out_of_band', { identity_id: 'robert-miller', method: 'push', request_version: 2 }, MERIDIAN, ctx)).toMatchObject({
      request_version: 2,
    });
    expect(mockToolResult('get_request_history', { identity_id: 'dana-whitfield', request_version: 2 }, MERIDIAN, ctx)).toMatchObject({
      request_version: 2,
    });
    // default request_version is 1 when not supplied
    expect(mockToolResult('verify_out_of_band', { identity_id: 'dana-whitfield' }, MERIDIAN, ctx)).toMatchObject({ request_version: 1 });
  });

  it('unknown identity errors, does not throw', () => {
    expect(mockToolResult('check_sso_context', { identity_id: 'nobody' }, MERIDIAN, ctx)).toEqual({
      error: 'unknown_identity',
      request_version: 1,
    });
    expect(mockToolResult('get_request_history', { identity_id: 'nobody' }, MERIDIAN, ctx)).toEqual({
      error: 'unknown_identity',
      request_version: 1,
    });
  });

  it('open_incident advances with incident_index', () => {
    expect(mockToolResult('open_incident', { severity: 'high' }, MERIDIAN, { evidence_count: 0, incident_index: 3 })).toEqual({
      incident_id: 'INC-8095',
    });
  });

  it('seal_evidence_record and alert_principal shapes', () => {
    expect(mockToolResult('seal_evidence_record', { review_id: 'r1' }, MERIDIAN, ctx)).toEqual({ exported: true });
    expect(mockToolResult('alert_principal', { identity_id: 'robert-miller', channel: 'sms' }, MERIDIAN, ctx)).toEqual({
      sent: true,
      devices: 2,
    });
  });
});
