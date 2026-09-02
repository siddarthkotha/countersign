// packages/server/src/call/stalls.ts
// The stalling library (BRIEF §6.2): short, neutral holding lines the LLM is told to say
// while a check is running, so the call never sits in silence. >=8 distinct lines per check
// kind, so a run of consecutive stalls on the same kind of check doesn't repeat itself while
// alternatives remain. Pure: `stallLineFor` never mutates `used` and never touches the
// clock or Math.random -- the caller decides what "already said" means by what it puts in
// the set it passes in, and updates that set between calls. `call/session.ts` owns the
// actual `used` state for the life of a call (fix round 1, finding 1) -- this module never
// carries session state itself.
import type { EngineOutput } from '@countersign/engine';

export type StallKind = 'sso' | 'history' | 'oob' | 'generic';

const STALL_LINES: Record<StallKind, string[]> = {
  sso: [
    'Give me one second on that sign-in session.',
    'Checking the sign-in session now, one moment.',
    'Confirming the sign-in details, just a moment.',
    'One moment, verifying the sign-in session.',
    'Hold on, the sign-in check is still running.',
    'A moment longer on the sign-in session check.',
    'Still confirming that sign-in session.',
    'One second, finishing the sign-in session check.',
  ],
  history: [
    'Pulling the payment file now.',
    'One moment, checking the file on this request.',
    'Looking at the payment history now.',
    'Give me a moment on the payment file.',
    'Still reviewing the request history.',
    'One moment, the payment file is loading.',
    'Checking prior activity on this request.',
    'A moment longer while I check the file.',
  ],
  oob: [
    "I've sent a confirmation to the registered device; a moment.",
    'Waiting on that device confirmation, just a moment.',
    'One moment, confirming with the registered device.',
    'Still waiting on the device confirmation.',
    'A moment longer for the device to confirm.',
    'Checking for a response from the registered device.',
    'One moment, that confirmation is still pending.',
    'Hold on, waiting for the device response.',
  ],
  generic: [
    'One moment while that check completes.',
    'Bear with me, running a quick check.',
    'Still working through this, almost there.',
    'One moment longer, verifying a detail.',
    'Thanks for your patience, nearly done.',
    'Just a moment, finishing this check.',
    'Give me a second longer, please.',
    "One moment, I don't want to rush this.",
  ],
};

/** Picks a line for `kind` that isn't in `used`, in fixed library order, so the same
 *  (kind, used) input always yields the same output. Once every line for a kind has been
 *  used, it starts repeating from the top rather than throwing -- a call can run long
 *  enough to exhaust the library, and a repeated holding line is still better than none. */
export function stallLineFor(kind: StallKind, used: Set<string>): string {
  const candidates = STALL_LINES[kind];
  const fresh = candidates.find((line) => !used.has(line));
  return fresh ?? candidates[0]!;
}

/** Fix round 1, finding 2: derives the check kind a STALL goal is actually stalling on from
 *  the live evidence state, not hint text -- the engine's STALL hints don't currently name a
 *  specific check (see `kindFromHint`'s own note below), so `kindFromHint` alone was always
 *  falling through to 'generic' in the real call path. Looks for the PENDING evidence card
 *  among the three tool-backed checks (SSO context, payment/request history, out-of-band
 *  verification) -- PENDING means that check's tool call is outstanding: no result yet,
 *  errored, or stale for the current request version (engine/src/evidence/fromTools.ts
 *  `pendingCard`). Falls back to `kindFromHint(output.goal.hint)` when nothing is pending
 *  (e.g. no tool has been called yet, or every called tool already resolved). */
export function stallKindFor(output: EngineOutput): StallKind {
  const pending = output.evidence.find(
    (e) =>
      e.status === 'PENDING' &&
      (e.kind === 'sso_context_result' || e.kind === 'context_check_result' || e.kind === 'oob_verification_result'),
  );
  if (pending?.kind === 'sso_context_result') return 'sso';
  if (pending?.kind === 'context_check_result') return 'history';
  if (pending?.kind === 'oob_verification_result') return 'oob';
  return kindFromHint(output.goal.hint);
}

/** Maps a goal's hint to the kind of check it's naming, so the stalling line matches what's
 *  actually pending instead of always saying something generic. Keyword match against the
 *  hint text; falls back to 'generic' when the hint doesn't name a specific check (the
 *  engine's current STALL hints are deliberately check-agnostic). Kept as `stallKindFor`'s
 *  fallback, and exported in its own right for anything that only has hint text to go on. */
export function kindFromHint(hint: string): StallKind {
  const h = hint.toLowerCase();
  if (h.includes('sso') || h.includes('sign-in') || h.includes('sign in') || h.includes('session context')) {
    return 'sso';
  }
  if (h.includes('history') || h.includes('payment file') || h.includes('prior payment') || h.includes('request history')) {
    return 'history';
  }
  if (
    h.includes('out-of-band') ||
    h.includes('out of band') ||
    h.includes('registered device') ||
    h.includes('confirmation')
  ) {
    return 'oob';
  }
  return 'generic';
}
