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
 *
 *  Review fix (2026-09-11, two findings against the first version of this file):
 *  1. CRITICAL -- 429 used to count as a credits signal, and the caller latched it
 *     permanently on the FIRST occurrence (caps.ts). A single transient 429 during a
 *     Render cold start would then kill live calls for every judge until a redeploy. 429
 *     is now excluded from the status match entirely; a real credit/quota condition is
 *     still caught by the 402 status or by a keyword (AssemblyAI's own wording, whatever
 *     it turns out to be, very likely says "credit"/"quota"/"insufficient"/"billing"
 *     regardless of which status code it rides on). The caller (caps.ts) additionally
 *     requires several consecutive classified failures inside a cool-down window before
 *     latching a bare `mint_error`, so a single blip of ANY kind no longer sticks.
 *  2. IMPORTANT -- 401/403 used to count as credits too, so a wrong or rotated API key
 *     showed judges "demo credits are exhausted" -- a false and confusing claim. 401/403
 *     are now excluded from the status match; without a credit/quota keyword they fall
 *     through to the caller's generic `mint_error` classification instead, whose banner
 *     text never mentions credits.
 */

export type LiveCallsReason = 'kill_switch' | 'daily_cap' | 'credits_exhausted' | 'mint_error';

export interface LiveCallsStatus {
  available: boolean;
  reason: LiveCallsReason | null;
}

// Only 402 (Payment Required) is treated as an unambiguous credits/payment signal by
// status code alone. 401/403 (auth) and 429 (rate limit) are common, everyday failure
// modes unrelated to credits -- they classify as a generic `mint_error` unless the
// message itself uses one of the CREDIT_KEYWORDS below.
const CREDIT_STATUS_CODES = new Set([402]);
const CREDIT_KEYWORDS = ['credit', 'quota', 'insufficient', 'billing'];

/** UNKNOWN (not documented in docs/ASSEMBLYAI_INTEGRATION.md as of 2026-09-11): the exact
 *  shape AssemblyAI returns when an account's credits/quota run out -- docs/
 *  ASSEMBLYAI_INTEGRATION.md only lists a generic "Auth header error" for the token-mint
 *  endpoint (line 59) and a generic `session.error` event on the WebSocket (line 31), no
 *  credit-specific code or message documented anywhere. This matches on either signal (an
 *  OR, not an AND): the 402 status alone, or a credit/quota/insufficient/billing keyword
 *  alone (or paired with any status). Deliberately narrower than a first draft of this
 *  function, which also matched 401/403/429 by status alone -- see the review-fix note
 *  above for why that was wrong. Anything this function returns false for is classified
 *  by the caller as a generic `mint_error`, never silently ignored.
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
