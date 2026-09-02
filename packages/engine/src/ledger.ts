// packages/engine/src/ledger.ts
// The STORY LEDGER: every fact the CALLER states is committed verbatim, with a lifecycle
// (STATED/CONFIRMED/APPROXIMATE/CORRECTED/CONTRADICTED/UNKNOWN). Behavioral only — no claim
// about voice authenticity. See amendment-v2-brief.md §B for the rules this implements;
// facts (verbatim quotes) live separately from interpretation (kind).
//
// CORRECTED vs CONTRADICTED (fix-round-1 ruling — time alone is not evidence of honesty): a
// later different value for a field is CORRECTED iff (a) the utterance has a
// correction-lexicon hit ("sorry", "actually", ...), OR (b) the current claim for that
// field is APPROXIMATE, OR (c) the utterance has a negate-lexicon hit AND it also names the
// PREVIOUS value inline (e.g. "not 1.8, it's 1.9" — the caller explicitly disowns the old
// figure while restating), OR (d) it arrives within `correction_window_ms` after a
// `readback_issued` for that field that the caller NEGATED (the readback-repair path).
// Otherwise CONTRADICTED. A plain time gap with none of the above is CONTRADICTED, full
// stop — "it happened soon after" is not, by itself, evidence the caller was being honest.
import { extractAccountLast4, extractCuedNames, extractDeadline } from './extract/claims';
import { extractAmounts } from './extract/amounts';
import { extractIdentityClaim } from './extract/identity';
import { hasLexiconHit, normalizeValue } from './normalize';
import type { AgentAction, Claim, ClaimField, ClaimKind, SeedConfig, Utterance } from './types';

// request_version bumps only when the current value of one of these fields changes.
const VERSIONED_FIELDS = new Set<ClaimField>(['amount_usd', 'beneficiary', 'account_last4']);

const APPROX_WORDS_RE = /\b(about|around|roughly|approximately)\b/;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when the amount at `text[idx..end)` is preceded within three words by an
 *  approximation word, or immediately followed by "ish". */
function isApproximateAt(text: string, idx: number, end: number): boolean {
  const before = text
    .slice(0, idx)
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .slice(-3)
    .join(' ')
    .toLowerCase();
  const after = text.slice(end).trimStart().toLowerCase();
  return APPROX_WORDS_RE.test(before) || after.startsWith('ish');
}

/** Condition (c): a negate-lexicon hit alone isn't enough — the utterance must also name
 *  the OLD value (e.g. "not 1.8, it's 1.9" contains "1.8", the figure it's disowning). */
function referencesPreviousValue(text: string, current: Claim): boolean {
  if (current.field === 'amount_usd') {
    const m = /\d+(?:\.\d+)?/.exec(current.quote.text);
    if (!m) return false;
    return new RegExp(`\\b${escapeRegExp(m[0])}\\b`).test(text);
  }
  if (current.field === 'account_last4') {
    return new RegExp(`\\b${escapeRegExp(String(current.value))}\\b`).test(text);
  }
  return text.toLowerCase().includes(current.quote.text.toLowerCase());
}

/** The latest (most recently added) claim for `field`, or null. Claims are appended in
 *  time order and never reordered, so this is simply the last matching entry. */
export function currentClaim(claims: Claim[], field: ClaimField): Claim | null {
  for (let i = claims.length - 1; i >= 0; i--) {
    const claim = claims[i]!;
    if (claim.field === field) return claim;
  }
  return null;
}

export function isConfirmed(claims: Claim[], field: ClaimField): boolean {
  return currentClaim(claims, field)?.kind === 'CONFIRMED';
}

interface PendingReadback {
  action: AgentAction;
  utterancesSeen: number;
}

type TimelineEntry = { t_ms: number; kind: 'utterance'; u: Utterance } | { t_ms: number; kind: 'action'; a: AgentAction };

export function buildLedger(
  conversation: Utterance[],
  actions: AgentAction[],
  seed: SeedConfig,
): { claims: Claim[]; request_version: number } {
  const callerUtterances = conversation.filter((u) => u.speaker === 'caller').sort((a, b) => a.t_ms - b.t_ms);

  // Only readback_issued/challenge_issued actions matter to the ledger: the former drives
  // CONFIRMED/UNKNOWN and the repair window; both bound how long a readback stays "open for
  // an answer" (§C: the agent has moved on once it asks the next thing).
  const boundaryActions = actions
    .filter((a) => a.kind === 'readback_issued' || a.kind === 'challenge_issued')
    .sort((a, b) => a.t_ms - b.t_ms);

  const timeline: TimelineEntry[] = [
    ...callerUtterances.map((u): TimelineEntry => ({ t_ms: u.t_ms, kind: 'utterance', u })),
    ...boundaryActions.map((a): TimelineEntry => ({ t_ms: a.t_ms, kind: 'action', a })),
  ].sort((x, y) => x.t_ms - y.t_ms || (x.kind === 'action' ? -1 : 1));

  let claims: Claim[] = [];
  let request_version = 1;
  let nextId = 1;
  const activeReadback: Partial<Record<ClaimField, PendingReadback>> = {};
  const repairWindowSince: Partial<Record<ClaimField, number>> = {};

  function addClaim(
    field: ClaimField,
    kind: ClaimKind,
    value: string | number,
    utterance_id: string,
    text: string,
    t_ms: number,
    supersedes: string | undefined,
  ): void {
    const claim: Claim = {
      id: `cl-${nextId}`,
      field,
      kind,
      value,
      quote: { utterance_id, text },
      t_ms,
      request_version,
      ...(supersedes !== undefined ? { supersedes } : {}),
    };
    nextId += 1;
    claims = [...claims, claim];
  }

  function classifyDifferentValue(field: ClaimField, u: Utterance, current: Claim): ClaimKind {
    if (hasLexiconHit(u.text, seed.correction_lexicon)) return 'CORRECTED'; // (a)
    if (current.kind === 'APPROXIMATE') return 'CORRECTED'; // (b)
    if (hasLexiconHit(u.text, seed.negate_lexicon) && referencesPreviousValue(u.text, current)) return 'CORRECTED'; // (c)
    const repairSince = repairWindowSince[field];
    if (repairSince !== undefined && u.t_ms - repairSince <= seed.thresholds.correction_window_ms) {
      delete repairWindowSince[field]; // (d) — the repair window is spent once used
      return 'CORRECTED';
    }
    return 'CONTRADICTED';
  }

  // Non-identity fields: first sighting is STATED (or APPROXIMATE); a later different value
  // is classified by `classifyDifferentValue`; a repeated same value is a no-op here (the
  // readback resolution below is the only route to CONFIRMED/UNKNOWN).
  function processHit(field: ClaimField, rawValue: string | number, quote: string, u: Utterance, approximate: boolean): void {
    const value = normalizeValue(field, rawValue);
    const current = currentClaim(claims, field);
    if (!current) {
      addClaim(field, approximate ? 'APPROXIMATE' : 'STATED', value, u.id, quote, u.t_ms, undefined);
      return;
    }
    if (current.value === value) return;
    const kind = classifyDifferentValue(field, u, current);
    if (VERSIONED_FIELDS.has(field)) request_version += 1;
    addClaim(field, kind, value, u.id, quote, u.t_ms, current.id);
  }

  for (const entry of timeline) {
    if (entry.kind === 'action') {
      // Any readback_issued or challenge_issued action closes out whatever was pending —
      // the follow-up window for a readback ends at the NEXT such action (§C).
      for (const f of Object.keys(activeReadback) as ClaimField[]) delete activeReadback[f];
      if (entry.a.kind === 'readback_issued' && entry.a.field) {
        activeReadback[entry.a.field] = { action: entry.a, utterancesSeen: 0 };
      }
      continue;
    }

    const u = entry.u;

    // Resolve any pending readback(s) with this utterance, capped at 2 utterances (§C).
    for (const field of Object.keys(activeReadback) as ClaimField[]) {
      const pending = activeReadback[field];
      if (!pending) continue;
      pending.utterancesSeen += 1;
      const negated = hasLexiconHit(u.text, seed.negate_lexicon);
      const affirmed = hasLexiconHit(u.text, seed.affirm_lexicon);
      if (negated || affirmed) {
        const current = currentClaim(claims, field);
        if (current && pending.action.value !== undefined && normalizeValue(field, pending.action.value) === current.value) {
          if (negated) {
            const currentId = current.id;
            claims = claims.map((c) => (c.id === currentId ? { ...c, kind: 'UNKNOWN' as ClaimKind } : c));
            repairWindowSince[field] = pending.action.t_ms;
          } else {
            const currentId = current.id;
            claims = claims.map((c) => (c.id === currentId ? { ...c, kind: 'CONFIRMED' as ClaimKind } : c));
          }
        }
        delete activeReadback[field];
      } else if (pending.utterancesSeen >= 2) {
        delete activeReadback[field]; // exhausted the cap without a resolving reply
      }
    }

    // Identity: value is the seed identity id itself, never text-normalized. A switch to a
    // DIFFERENT identity is always CONTRADICTED (never a "correction" — see amendment §B).
    const idHit = extractIdentityClaim(u.text, seed);
    if (idHit) {
      const current = currentClaim(claims, 'identity');
      if (!current) {
        addClaim('identity', 'STATED', idHit.identity_id, u.id, idHit.quote, u.t_ms, undefined);
      } else if (current.value !== idHit.identity_id) {
        request_version += 1;
        addClaim('identity', 'CONTRADICTED', idHit.identity_id, u.id, idHit.quote, u.t_ms, current.id);
      }
    }

    // extractAmounts can yield an overlapping duplicate for a mixed numeric+scale-word
    // mention (e.g. "$1.8 million" plus a spurious standalone-"million" spoken hit); a
    // search cursor that only ever advances forward skips any hit whose quote can't be
    // found past the previous one's end, which discards exactly those duplicates while
    // still finding any genuine second amount mentioned later in the utterance.
    let cursor = 0;
    for (const amount of extractAmounts(u.text)) {
      const idx = u.text.indexOf(amount.quote, cursor);
      if (idx === -1) continue;
      const end = idx + amount.quote.length;
      cursor = end;
      processHit('amount_usd', amount.value_usd, amount.quote, u, isApproximateAt(u.text, idx, end));
    }

    const account = extractAccountLast4(u.text);
    if (account) processHit('account_last4', account.value, account.quote, u, false);

    const deadline = extractDeadline(u.text);
    if (deadline) processHit('deadline', deadline.value, deadline.quote, u, false);

    for (const cued of extractCuedNames(u.text)) {
      processHit(cued.field, cued.value, cued.quote, u, false);
    }
  }

  return { claims, request_version };
}
