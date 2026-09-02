// packages/engine/src/ledger.ts
// The STORY LEDGER: every fact the CALLER states is committed verbatim, with a lifecycle
// (STATED/CONFIRMED/APPROXIMATE/CORRECTED/CONTRADICTED/UNKNOWN). A legitimate correction
// ("sorry, I mean 1.9") is graded differently from an unexplained contradiction. Behavioral
// only — no claim about voice authenticity. See amendment-v2-brief.md §B for the rules this
// implements; facts (verbatim quotes) live separately from interpretation (kind).
import { extractAccountLast4, extractCuedNames, extractDeadline } from './extract/claims';
import { extractAmounts } from './extract/amounts';
import { extractIdentityClaim } from './extract/identity';
import { normalizeValue } from './normalize';
import type { AgentAction, Claim, ClaimField, ClaimKind, SeedConfig, Utterance } from './types';

// request_version bumps only when the current value of one of these fields changes.
const VERSIONED_FIELDS = new Set<ClaimField>(['amount_usd', 'beneficiary', 'account_last4']);

const APPROX_WORDS_RE = /\b(about|around|roughly|approximately)\b/;

/** Case-insensitive: does any lexicon phrase occur anywhere in `text`? */
function lexiconHit(text: string, lexicon: string[]): boolean {
  const lowerText = text.toLowerCase();
  return lexicon.some((phrase) => lowerText.includes(phrase.toLowerCase()));
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

export function buildLedger(
  conversation: Utterance[],
  actions: AgentAction[],
  seed: SeedConfig,
): { claims: Claim[]; request_version: number } {
  const callerUtterances = conversation.filter((u) => u.speaker === 'caller').sort((a, b) => a.t_ms - b.t_ms);

  let claims: Claim[] = [];
  let request_version = 1;
  let nextId = 1;

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

  // Non-identity fields: first sighting is STATED (or APPROXIMATE); a later different value
  // is CORRECTED (correction-lexicon hit, inside the correction window, or the current claim
  // was APPROXIMATE) or otherwise CONTRADICTED; a repeated same value is a no-op here (the
  // readback pass below is the only route to CONFIRMED/UNKNOWN).
  function processHit(field: ClaimField, rawValue: string | number, quote: string, u: Utterance, approximate: boolean): void {
    const value = normalizeValue(field, rawValue);
    const current = currentClaim(claims, field);
    if (!current) {
      addClaim(field, approximate ? 'APPROXIMATE' : 'STATED', value, u.id, quote, u.t_ms, undefined);
      return;
    }
    if (current.value === value) return;
    const withinWindow = u.t_ms - current.t_ms <= seed.thresholds.correction_window_ms;
    const kind: ClaimKind =
      lexiconHit(u.text, seed.correction_lexicon) || withinWindow || current.kind === 'APPROXIMATE'
        ? 'CORRECTED'
        : 'CONTRADICTED';
    if (VERSIONED_FIELDS.has(field)) request_version += 1;
    addClaim(field, kind, value, u.id, quote, u.t_ms, current.id);
  }

  for (const u of callerUtterances) {
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

  // Readback: a readback_issued action naming the value currently on the ledger for that
  // field, followed by the next caller utterance that affirms or negates it. Negate wins
  // over affirm when a naive lexicon hit gives both (e.g. "that's not right" contains
  // "right"), matching the rule: a negate hit is UNKNOWN regardless of any affirm hit.
  const readbacks = actions.filter((a) => a.kind === 'readback_issued').sort((a, b) => a.t_ms - b.t_ms);
  for (const action of readbacks) {
    if (!action.field || action.value === undefined) continue;
    const current = currentClaim(claims, action.field);
    if (!current) continue;
    if (normalizeValue(action.field, action.value) !== current.value) continue;

    const followUp = callerUtterances.find(
      (u) => u.t_ms > action.t_ms && (lexiconHit(u.text, seed.negate_lexicon) || lexiconHit(u.text, seed.affirm_lexicon)),
    );
    if (!followUp) continue;

    const currentId = current.id;
    if (lexiconHit(followUp.text, seed.negate_lexicon)) {
      claims = claims.map((c) => (c.id === currentId ? { ...c, kind: 'UNKNOWN' as ClaimKind } : c));
    } else if (lexiconHit(followUp.text, seed.affirm_lexicon)) {
      claims = claims.map((c) => (c.id === currentId ? { ...c, kind: 'CONFIRMED' as ClaimKind } : c));
    }
  }

  return { claims, request_version };
}
