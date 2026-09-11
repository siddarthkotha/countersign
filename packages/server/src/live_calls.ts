/** Single source of truth for "can a browser start (or keep) a real AssemblyAI call right
 *  now" -- exposed on GET /health and POST /api/session/start as `live_calls` so the web
 *  landing page can show a plain-English banner and lead with replay mode instead of a
 *  Start Call button that silently fails.
 *
 *  Reviewer finding (2026-09-11): CLAUDE.md / docs/BRIEF.md AMENDMENT 2 list a
 *  "credits-exhausted REPLAY mode" as a SUBMISSION REQUIREMENT among the abuse caps, but a
 *  repo grep found no implementation under that name. caps.ts's `canStartSession` already
 *  covers kill_switch, session_in_use, daily_cap and mint_rate -- all per-request, all
 *  already surfaced to the browser via the existing `{ replay_only, reason }` shape. What
 *  was missing is a way to know the AssemblyAI account itself has run out of credits (a
 *  durable, cross-session condition), and a way for the founder to force that state for a
 *  rehearsal. This module adds exactly those two reasons (`credits_exhausted`,
 *  `mint_error`) without touching the existing four.
 */

export type LiveCallsReason = 'kill_switch' | 'daily_cap' | 'credits_exhausted' | 'mint_error';

export interface LiveCallsStatus {
  available: boolean;
  reason: LiveCallsReason | null;
}

const CREDIT_STATUS_CODES = new Set([401, 402, 403, 429]);
const CREDIT_KEYWORDS = ['credit', 'quota', 'insufficient', 'billing'];

/** UNKNOWN (not documented in docs/ASSEMBLYAI_INTEGRATION.md as of 2026-09-11): the exact
 *  shape AssemblyAI returns when an account's credits/quota run out -- docs/
 *  ASSEMBLYAI_INTEGRATION.md only lists a generic "Auth header error" for the token-mint
 *  endpoint (line 59) and a generic `session.error` event on the WebSocket (line 31), no
 *  credit-specific code or message documented anywhere. This matches on either signal (an
 *  OR, not an AND) on purpose: a false positive just shows the credits-exhausted banner a
 *  little early on some unrelated 429/403; a false negative would leave Start Call
 *  silently broken in front of a stranger-judge, which is worse. Design a generic
 *  fallback (`mint_error`) for anything that fails but doesn't match either signal, so a
 *  real outage still gets *some* banner instead of a mystery-broken button.
 */
export function isCreditsExhaustedError(input: { status?: number; message?: string }): boolean {
  if (input.status !== undefined && CREDIT_STATUS_CODES.has(input.status)) return true;
  const message = (input.message ?? '').toLowerCase();
  return CREDIT_KEYWORDS.some((keyword) => message.includes(keyword));
}

/** `mintToken` (token.ts) and `connectAai` (aai/session.ts) throw plain `Error`s whose
 *  message embeds the HTTP status ("token mint failed: 402") rather than a structured
 *  error shape -- this pulls a 3-digit status back out of the message, best-effort, so
 *  `isCreditsExhaustedError` can look at both signals from just the caught error. */
export function classifyMintFailure(err: unknown): { status?: number; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  const match = /\b(\d{3})\b/.exec(message);
  const digits = match?.[1];
  const status = digits === undefined ? undefined : Number.parseInt(digits, 10);
  return status === undefined ? { message } : { status, message };
}
