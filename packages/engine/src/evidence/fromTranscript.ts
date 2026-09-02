// packages/engine/src/evidence/fromTranscript.ts
// Evidence built directly from the caller's own words. LAW 4: every quote here is a
// verbatim substring of the utterance it cites -- facts (raw) are kept separate from
// status/detail (interpretation). LAW 1: nothing here is a claim about voice authenticity;
// it is behavioral -- what was said, and whether it was said under pressure or contradicted
// itself. The story ledger (a later task) owns request-version bookkeeping and the
// consistency_flag card; this module always tags its cards `request_version: 1` and lets
// the ledger overwrite when it composes the full evidence set.
import { extractAmounts } from '../extract/amounts';
import { extractIdentityClaim } from '../extract/identity';
import { extractOutOfScope } from '../extract/outOfScope';
import { extractPressure } from '../extract/pressure';
import type { Evidence, Quote, SeedConfig, Utterance } from '../types';

const TRANSCRIPT_REQUEST_VERSION = 1;

function money(n: number): string {
  return `$${n.toLocaleString('en-US')}`;
}

function identityName(seed: SeedConfig, id: string): string {
  return seed.identities.find((i) => i.id === id)?.name ?? id;
}

export function evidenceFromTranscript(conversation: Utterance[], seed: SeedConfig): Evidence[] {
  const out: Evidence[] = [];
  const callerUtterances = conversation.filter((u) => u.speaker === 'caller');

  // ---- identity_claim + identity_switch ----
  let firstIdentity: { identity_id: string; quote: string; utterance: Utterance } | null = null;
  let switchInfo: { later_id: string; quote: string; utterance: Utterance } | null = null;
  for (const u of callerUtterances) {
    const hit = extractIdentityClaim(u.text, seed);
    if (!hit) continue;
    if (!firstIdentity) {
      firstIdentity = { identity_id: hit.identity_id, quote: hit.quote, utterance: u };
    } else if (!switchInfo && hit.identity_id !== firstIdentity.identity_id) {
      switchInfo = { later_id: hit.identity_id, quote: hit.quote, utterance: u };
    }
  }

  if (firstIdentity) {
    out.push({
      id: 'ev-identity',
      kind: 'identity_claim',
      t_ms: firstIdentity.utterance.t_ms,
      label: 'Identity',
      status: 'INFO',
      detail: `Caller identified as ${identityName(seed, firstIdentity.identity_id)}.`,
      facts: { identity_id: firstIdentity.identity_id },
      quotes: [{ utterance_id: firstIdentity.utterance.id, text: firstIdentity.quote }],
      source: 'transcript',
      provenance: 'CALLER_SAID',
      request_version: TRANSCRIPT_REQUEST_VERSION,
    });
  }

  if (firstIdentity && switchInfo) {
    const quotes: Quote[] = [
      { utterance_id: firstIdentity.utterance.id, text: firstIdentity.quote },
      { utterance_id: switchInfo.utterance.id, text: switchInfo.quote },
    ];
    out.push({
      id: 'ev-identity-switch',
      kind: 'identity_switch',
      t_ms: switchInfo.utterance.t_ms,
      label: 'Identity switch',
      status: 'FLAG',
      detail: `Caller first claimed ${identityName(seed, firstIdentity.identity_id)}, then claimed ${identityName(seed, switchInfo.later_id)}.`,
      facts: { first_id: firstIdentity.identity_id, later_id: switchInfo.later_id },
      quotes,
      source: 'transcript',
      provenance: 'CALLER_SAID',
      request_version: TRANSCRIPT_REQUEST_VERSION,
    });
  }

  // ---- request_params (first amount only) ----
  let firstAmount: { value_usd: number; quote: string; utterance: Utterance } | null = null;
  for (const u of callerUtterances) {
    const hits = extractAmounts(u.text);
    if (hits.length > 0) {
      firstAmount = { value_usd: hits[0]!.value_usd, quote: hits[0]!.quote, utterance: u };
      break;
    }
  }
  if (firstAmount) {
    out.push({
      id: 'ev-request',
      kind: 'request_params',
      t_ms: firstAmount.utterance.t_ms,
      label: 'Request',
      status: 'INFO',
      detail: `Caller requested ${money(firstAmount.value_usd)}.`,
      facts: { amount_usd: firstAmount.value_usd },
      quotes: [{ utterance_id: firstAmount.utterance.id, text: firstAmount.quote }],
      source: 'transcript',
      provenance: 'CALLER_SAID',
      request_version: TRANSCRIPT_REQUEST_VERSION,
    });
  }

  // ---- pressure_marker (always emitted) ----
  const seenPhrases = new Set<string>();
  const pressureQuotes: Quote[] = [];
  for (const u of callerUtterances) {
    for (const hit of extractPressure(u.text, seed.pressure_lexicon)) {
      if (seenPhrases.has(hit.phrase)) continue;
      seenPhrases.add(hit.phrase);
      pressureQuotes.push({ utterance_id: u.id, text: hit.quote });
    }
  }
  const interruptedAgentUtterance = conversation.find((u) => u.speaker === 'agent' && u.interrupted);
  const talkOvers = conversation.filter((u) => u.speaker === 'agent' && u.interrupted).length;
  const hits = seenPhrases.size;
  const pressureFlag = hits >= seed.thresholds.pressure_flag_min || talkOvers > 0;
  const pressureT =
    pressureQuotes.length > 0
      ? (callerUtterances.find((u) => u.id === pressureQuotes[0]!.utterance_id)?.t_ms ?? 0)
      : (interruptedAgentUtterance?.t_ms ?? conversation[0]?.t_ms ?? 0);
  out.push({
    id: 'ev-pressure',
    kind: 'pressure_marker',
    t_ms: pressureT,
    label: 'Pressure signals',
    status: pressureFlag ? 'FLAG' : 'INFO',
    detail: pressureFlag
      ? `${hits} pressure phrase(s) detected${talkOvers > 0 ? `; ${talkOvers} agent interruption(s)` : ''}.`
      : 'No urgency pressure detected.',
    facts: { hits, talk_overs: talkOvers },
    quotes: pressureQuotes,
    source: 'transcript',
    provenance: 'CALLER_SAID',
    request_version: TRANSCRIPT_REQUEST_VERSION,
  });

  // ---- out_of_scope_marker (first hit only) ----
  for (const u of callerUtterances) {
    const hit = extractOutOfScope(u.text, seed.out_of_scope_lexicon);
    if (!hit) continue;
    out.push({
      id: 'ev-scope',
      kind: 'out_of_scope_marker',
      t_ms: u.t_ms,
      label: 'Out of scope',
      status: 'FLAG',
      detail: `Caller indicated this may not be a real request: "${hit.quote}".`,
      facts: {},
      quotes: [{ utterance_id: u.id, text: hit.quote }],
      source: 'transcript',
      provenance: 'CALLER_SAID',
      request_version: TRANSCRIPT_REQUEST_VERSION,
    });
    break;
  }

  // ---- injection_marker (first hit only; content, never proof) ----
  for (const u of callerUtterances) {
    const lower = u.text.toLowerCase();
    let matched: { phrase: string; quote: string } | null = null;
    for (const phrase of seed.injection_lexicon) {
      const idx = lower.indexOf(phrase.toLowerCase());
      if (idx !== -1) {
        matched = { phrase, quote: u.text.slice(idx, idx + phrase.length) };
        break;
      }
    }
    if (!matched) continue;
    out.push({
      id: 'ev-injection',
      kind: 'injection_marker',
      t_ms: u.t_ms,
      label: 'Injection attempt',
      status: 'FLAG',
      detail: 'Caller utterance contains an instruction-injection phrase; content only, never proof on its own.',
      facts: { phrase: matched.phrase },
      quotes: [{ utterance_id: u.id, text: matched.quote }],
      source: 'transcript',
      provenance: 'CALLER_SAID',
      request_version: TRANSCRIPT_REQUEST_VERSION,
    });
    break;
  }

  return out;
}
