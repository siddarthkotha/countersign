// packages/engine/src/mock/backend.ts
// Deterministic mocked tool backend. Every result is derived only from the (name, args,
// seed, ctx) inputs -- same inputs, same output, always. SCOPE FENCE: no real banking,
// SSO, or SIEM integration; this is the "simulated" system the server tags as such.
// LAW 2: there is no release verdict or tool -- nothing here ever returns one.
import type { Identity, SeedConfig, ToolName } from '../types';

export interface MockCtx {
  evidence_count: number;
  incident_index: number;
}

function findIdentity(seed: SeedConfig, identityId: unknown): Identity | undefined {
  return seed.identities.find((i) => i.id === identityId);
}

function requestVersion(args: Record<string, unknown>): number {
  return Number(args.request_version ?? 1);
}

export function mockToolResult(
  name: ToolName,
  args: Record<string, unknown>,
  seed: SeedConfig,
  ctx: MockCtx,
): Record<string, unknown> {
  const request_version = requestVersion(args);

  switch (name) {
    case 'check_sso_context': {
      const identity = findIdentity(seed, args.identity_id);
      if (!identity) return { error: 'unknown_identity', request_version };
      return { session_active: identity.sso.active, geo: identity.sso.geo, device: identity.sso.device, request_version };
    }

    case 'get_request_history': {
      const identity = findIdentity(seed, args.identity_id);
      if (!identity) return { error: 'unknown_identity', request_version };
      const payments = seed.payments.filter((p) => p.requester_id === identity.id);
      const known_vendors = [...new Set(payments.map((p) => p.vendor))];
      const matches = payments.map((p) => ({
        vendor: p.vendor,
        amount_usd: p.amount_usd,
        account_last4: p.account_last4,
        due: p.due,
      }));
      return { known_vendors, matches, request_version };
    }

    case 'verify_out_of_band': {
      const identity = findIdentity(seed, args.identity_id);
      if (!identity) return { error: 'unknown_identity', request_version };
      return {
        sent: true,
        devices: identity.registered_devices.length,
        response: identity.oob.response,
        latency_ms: identity.oob.latency_ms,
        request_version,
      };
    }

    case 'stage_payment_for_second_approval':
      return { staged: true, approver_id: seed.second_approver_id, status: 'SECOND_APPROVAL_PENDING', request_version };

    case 'freeze_transaction_rail':
      return { frozen: true, rail_id: args.rail_id, request_version };

    case 'open_incident':
      return { incident_id: `INC-${seed.incident_seed + ctx.incident_index}`, request_version };

    case 'alert_principal': {
      const identity = findIdentity(seed, args.identity_id);
      return { sent: true, devices: identity ? identity.registered_devices.length : 0, request_version };
    }

    case 'seal_evidence_record':
      return { exported: true, request_version };

    default: {
      const _exhaustive: never = name;
      return _exhaustive;
    }
  }
}
