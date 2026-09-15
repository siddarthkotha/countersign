// packages/engine/src/evidence/fromTranscript.ts
// Evidence built directly from the caller's own words. LAW 4: every quote here is a
// verbatim substring of the utterance it cites -- facts (raw) are kept separate from
// status/detail (interpretation). LAW 1: nothing here is a claim about voice authenticity;
// it is behavioral -- what was said, and whether it was said under pressure or contradicted
// itself. The story ledger (a later task) owns request-version bookkeeping and the
// consistency_flag card; this module always tags its cards `request_version: 1` and lets
// the ledger overwrite when it composes the full evidence set.
import { extractAmounts } from '../extract/amounts.js';
import { extractIdentityClaim } from '../extract/identity.js';
import { answersToPersonQuestion } from '../extract/personQuestion.js';
import { extractOutOfScope } from '../extract/outOfScope.js';
import { extractPressure } from '../extract/pressure.js';
import { money } from '../util.js';
import type { AgentAction, Evidence, Quote, SeedConfig, Utterance } from '../types.js';

const TRANSCRIPT_REQUEST_VERSION = 1;

function identityName(seed: SeedConfig, id: string): string {
  return seed.identities.find((i) => i.id === id)?.name ?? id;
}

export function evidenceFromTranscript(conversation: Utterance[], seed: SeedConfig, actions?: AgentAction[]): Evidence[] {
  const out: Evidence[] = [];
  const callerUtterances = conversation.filter((u) => u.speaker === 'caller');

  // ---- identity_claim + identity_switch ----
  // Follow-up (option B review, commit b56be9e): a caller can switch identity more than
  // once in a call (A -> B -> C). `identityChain` records one entry per DISTINCT identity
  // claimed, in order -- mirroring ledger.ts's own rule that a claim only changes when it
  // differs from the CURRENT one (a repeat of the already-current identity is a no-op), so
  // this chain always agrees with the ledger's own sequence of identity claims/switches.
  // The "Identity" card (below) always names the FIRST entry (who opened the call); the
  // "Identity switch" card always names the LAST TWO entries -- the LATEST switch -- so a
  // second (or third...) switch is never invisible behind an earlier one, and
  // resolveIdentitySwitch (compose.ts) always resolves against the CURRENT identity, never
  // one abandoned earlier in the chain.
  const identityChain: { identity_id: string; quote: string; utterance: Utterance }[] = [];
  const personQuestionAnswers = answersToPersonQuestion(conversation, actions);
  for (const u of callerUtterances) {
    const isAnsweringPersonQuestion = personQuestionAnswers.has(u.id);
    const hit = extractIdentityClaim(u.text, seed, isAnsweringPersonQuestion);
    if (!hit) continue;
    const last = identityChain[identityChain.length - 1];
    if (!last || hit.identity_id !== last.identity_id) {
      identityChain.push({ identity_id: hit.identity_id, quote: hit.quote, utterance: u });
    }
  }
  const firstIdentity = identityChain[0] ?? null;
  const switchInfo =
    identityChain.length >= 2
      ? { prev: identityChain[identityChain.length - 2]!, later: identityChain[identityChain.length - 1]! }
      : null;

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

  if (switchInfo) {
    const { prev, later } = switchInfo;
    const quotes: Quote[] = [
      { utterance_id: prev.utterance.id, text: prev.quote },
      { utterance_id: later.utterance.id, text: later.quote },
    ];
    out.push({
      id: 'ev-identity-switch',
      kind: 'identity_switch',
      t_ms: later.utterance.t_ms,
      label: 'Identity switch',
      status: 'FLAG',
      detail: `Caller first claimed ${identityName(seed, prev.identity_id)}, then claimed ${identityName(seed, later.identity_id)}.`,
      facts: { first_id: prev.identity_id, later_id: later.identity_id },
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
    // `phrase` (facts) stays the lower-case lexicon entry, matched case-insensitively --
    // that is the raw, machine-comparable fact (LAW 4). `quote` (below) is sliced from the
    // ORIGINAL utterance text at the matched index, so it keeps the caller's actual casing
    // verbatim, even though the match itself was case-insensitive.
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
