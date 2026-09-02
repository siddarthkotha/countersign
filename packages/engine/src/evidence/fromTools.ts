// packages/engine/src/evidence/fromTools.ts
// Evidence built from simulated tool results: SSO context, out-of-band verification, and
// the scheduled-payment context check. LAW 4: facts (raw) live separately from status/detail
// (interpretation). Provenance SIMULATED_SYSTEM -- these are mocked tools (SCOPE FENCE: no
// real banking/SSO/SIEM integration), never treated as proof of anything beyond themselves.
import { normalizeText } from '../normalize.js';
import { money } from '../util.js';
import type { CallContext, Evidence, EvidenceKind, EvidenceStatus, SeedConfig, ToolLogEntry, ToolName } from '../types.js';

export interface ToolEvidenceCtx {
  claimed_id: string | null;
  amount_usd: number | null;
  beneficiary: string | null;
  request_version: number;
}

function latest(tools: ToolLogEntry[], name: ToolName): ToolLogEntry | undefined {
  let found: ToolLogEntry | undefined;
  for (const t of tools) if (t.name === name) found = t; // last entry of this name wins
  return found;
}

/** A missing/null field in a tool result renders as "unknown" in facts/detail, never the
 *  literal string "undefined" that `String(undefined)` would produce. */
function stringOrUnknown(v: unknown): string {
  return v !== undefined && v !== null ? String(v) : 'unknown';
}

function card(
  id: string,
  kind: EvidenceKind,
  label: string,
  t_ms: number,
  status: EvidenceStatus,
  detail: string,
  facts: Evidence['facts'],
  ctx: ToolEvidenceCtx,
): Evidence {
  return {
    id,
    kind,
    t_ms,
    label,
    status,
    detail,
    facts,
    quotes: [],
    source: 'tool',
    provenance: 'SIMULATED_SYSTEM',
    request_version: ctx.request_version,
  };
}

/** Returns a PENDING card if the entry has no result yet, errored, or was obtained for a
 *  different request version than the one currently under evaluation -- null when the
 *  entry is ready to be graded. */
function pendingCard(
  id: string,
  kind: EvidenceKind,
  label: string,
  entry: ToolLogEntry,
  ctx: ToolEvidenceCtx,
): Evidence | null {
  if (!entry.result) {
    return card(id, kind, label, entry.t_ms, 'PENDING', 'Awaiting result.', {}, ctx);
  }
  const result = entry.result;
  if (result.error !== undefined && result.error !== null) {
    return card(id, kind, label, entry.t_ms, 'PENDING', `Tool error: ${String(result.error)}`, { error: String(result.error) }, ctx);
  }
  const resultVersion = Number(result.request_version);
  if (resultVersion !== ctx.request_version) {
    return card(
      id,
      kind,
      label,
      entry.t_ms,
      'PENDING',
      `Stale: obtained for request version ${resultVersion}.`,
      { stale: true },
      ctx,
    );
  }
  return null;
}

function ssoEvidence(entry: ToolLogEntry, call: CallContext, ctx: ToolEvidenceCtx): Evidence {
  const pending = pendingCard('ev-sso', 'sso_context_result', 'SSO context', entry, ctx);
  if (pending) return pending;
  const r = entry.result as Record<string, unknown>;
  const sessionActive = Boolean(r.session_active);
  const geo = stringOrUnknown(r.geo);
  const device = stringOrUnknown(r.device);
  const fail = call.origin_kind === 'unverified_voip' || (sessionActive && geo !== call.origin_geo);

  const activeLabel = sessionActive ? `SSO active in ${geo}` : 'No active SSO session';
  const originLabel =
    call.origin_kind === 'unverified_voip'
      ? 'unverified VoIP gateway'
      : call.origin_kind === 'internal_line'
        ? 'internal line'
        : `registered device in ${call.origin_geo}`;

  return card(
    'ev-sso',
    'sso_context_result',
    'SSO context',
    entry.t_ms,
    fail ? 'FAIL' : 'PASS',
    `${activeLabel}; call from ${originLabel}`,
    { session_active: sessionActive, geo, device, origin_kind: call.origin_kind, origin_geo: call.origin_geo },
    ctx,
  );
}

function oobEvidence(entry: ToolLogEntry, ctx: ToolEvidenceCtx): Evidence {
  const pending = pendingCard('ev-oob', 'oob_verification_result', 'Out-of-band verification', entry, ctx);
  if (pending) return pending;
  const r = entry.result as Record<string, unknown>;
  // A missing/malformed response (not one of the known strings) is graded FAIL but must not
  // be mislabeled "declined" -- that implies the caller actively refused, which we cannot
  // claim from silence/garbage. Reserve "declined" for an explicit non-confirmed response.
  const KNOWN_RESPONSES = new Set(['confirmed', 'no_response', 'denied']);
  const rawResponse = r.response;
  const response = typeof rawResponse === 'string' && KNOWN_RESPONSES.has(rawResponse) ? rawResponse : null;
  const devices = Number(r.devices ?? 0);
  const latency_ms = Number(r.latency_ms ?? 0);
  const pass = response === 'confirmed';
  const detail =
    response === null
      ? 'No usable response.'
      : pass
        ? `Out-of-band confirmed on ${devices} registered device(s).`
        : response === 'no_response'
          ? `No response from ${devices} registered devices.`
          : 'Declined.';

  return card(
    'ev-oob',
    'oob_verification_result',
    'Out-of-band verification',
    entry.t_ms,
    pass ? 'PASS' : 'FAIL',
    detail,
    { response, devices, latency_ms },
    ctx,
  );
}

function contextEvidence(entry: ToolLogEntry, ctx: ToolEvidenceCtx): Evidence {
  const pending = pendingCard('ev-context', 'context_check_result', 'Payment context check', entry, ctx);
  if (pending) return pending;
  const r = entry.result as Record<string, unknown>;
  const matches = Array.isArray(r.matches) ? (r.matches as Array<Record<string, unknown>>) : [];
  const knownVendors = Array.isArray(r.known_vendors) ? (r.known_vendors as unknown[]).map(String) : [];
  const amount = ctx.amount_usd;
  const beneficiaryNorm = ctx.beneficiary !== null ? normalizeText(ctx.beneficiary) : null;

  const hit =
    amount === null
      ? undefined
      : matches.find((m) => {
          const mAmount = Number(m.amount_usd);
          const withinOnePct = Math.abs(mAmount - amount) <= Math.abs(amount) * 0.01;
          if (!withinOnePct) return false;
          if (beneficiaryNorm === null) return true;
          return normalizeText(String(m.vendor)) === beneficiaryNorm;
        });

  const facts: Evidence['facts'] = { matches: matches.length, known_vendors: knownVendors.join(', ') };

  if (hit) {
    const exact = amount !== null && Number(hit.amount_usd) === amount && beneficiaryNorm !== null
      && normalizeText(String(hit.vendor)) === beneficiaryNorm;
    if (exact) facts.amendment_only = true;
    return card(
      'ev-context',
      'context_check_result',
      'Payment context check',
      entry.t_ms,
      'PASS',
      `Matches a scheduled payment of ${money(Number(hit.amount_usd))} to ${String(hit.vendor)}.`,
      facts,
      ctx,
    );
  }

  const amountLabel = amount === null ? 'the stated amount' : money(amount);
  const beneficiaryLabel = ctx.beneficiary ?? 'the stated beneficiary';
  return card(
    'ev-context',
    'context_check_result',
    'Payment context check',
    entry.t_ms,
    'FAIL',
    `No scheduled payment matches ${amountLabel} to ${beneficiaryLabel}.`,
    facts,
    ctx,
  );
}

export function evidenceFromTools(
  tools: ToolLogEntry[],
  call: CallContext,
  seed: SeedConfig,
  ctx: ToolEvidenceCtx,
): Evidence[] {
  void seed; // reserved for future seed-driven grading; not needed by the current rules
  const out: Evidence[] = [];

  const sso = latest(tools, 'check_sso_context');
  if (sso) out.push(ssoEvidence(sso, call, ctx));

  const context = latest(tools, 'get_request_history');
  if (context) out.push(contextEvidence(context, ctx));

  const oob = latest(tools, 'verify_out_of_band');
  if (oob) out.push(oobEvidence(oob, ctx));

  return out;
}
