// packages/server/src/personas.ts
// Bug fix (2026-09-04): the live CallContext used to be hardcoded to `unverified_voip`/
// `unknown` for EVERY call (ws/browser.ts's old `defaultCallContext`), which made
// evidenceFromTools.ssoEvidence fail always, which made STAGE structurally unreachable on
// the deployed demo no matter how a caller behaved. The corpus proved the intended design:
// every scenario whose expected verdict is STAGE (scenario-a-dana-legitimate,
// honest-correction-stages, pressure-only-still-stages) carries `registered_device` + a real
// geo ("Austin, TX"); scenario-b-miller-fraud carries `unverified_voip` + "unknown".
//
// The browser may NAME a demo persona; it must never supply telemetry values directly --
// this table is the ONLY place a persona name becomes `origin_kind`/`origin_geo`, and it
// must mirror the recorded corpus exactly so a live call and the corpus's own oracle agree.
import type { CallContext, CallOriginKind } from '@countersign/engine';

export type DemoPersona = 'legitimate' | 'attacker';

/** The SAFEST persona -- used whenever the browser's request is missing, unknown, or
 *  malformed. Never the permissive one: an ambiguous or absent choice must never be treated
 *  as a trusted, registered-device caller. */
export const DEFAULT_PERSONA: DemoPersona = 'attacker';

const PERSONA_TELEMETRY: Record<DemoPersona, { origin_kind: CallOriginKind; origin_geo: string }> = {
  // Mirrors scenario-a-dana-legitimate.json / honest-correction-stages.json /
  // pressure-only-still-stages.json's own `call` block exactly.
  legitimate: { origin_kind: 'registered_device', origin_geo: 'Austin, TX' },
  // Mirrors scenario-b-miller-fraud.json's own `call` block exactly.
  attacker: { origin_kind: 'unverified_voip', origin_geo: 'unknown' },
};

/** Strict allowlist: anything other than exactly `'legitimate'` or `'attacker'` -- wrong
 *  type, wrong case, an unknown string, missing entirely -- resolves to `DEFAULT_PERSONA`.
 *  Callers pass whatever a request body decoded to `unknown`; this is the one gate that
 *  matters, so no caller (`/api/session/start`'s route handler) needs its own validation. */
export function resolvePersona(input: unknown): DemoPersona {
  return input === 'legitimate' || input === 'attacker' ? input : DEFAULT_PERSONA;
}

/** The ONLY place a live CallContext's telemetry fields are constructed from a persona name.
 *  `session_id` is the one thing that varies per call; `origin_kind`/`origin_geo` come
 *  solely from `PERSONA_TELEMETRY` above, never from caller-supplied input. */
export function callContextForPersona(session_id: string, persona: DemoPersona): CallContext {
  return { session_id, ...PERSONA_TELEMETRY[persona] };
}
