// packages/engine/src/seed/meridian.ts
// ALL FICTIONAL. Meridian Dynamics does not exist; nobody here is a real person.
import type { SeedConfig } from '../types.js';

export const MERIDIAN: SeedConfig = {
  company: 'Meridian Dynamics',
  identities: [
    {
      id: 'robert-miller', name: 'Robert Miller', aliases: ['mr. miller', 'mr miller', 'bob miller', 'robert'],
      role: 'CEO', sso: { active: true, geo: 'Frankfurt, DE', device: 'MacBook Pro (managed)' },
      registered_devices: ['iPhone (managed)', 'Yubikey'], oob: { response: 'no_response', latency_ms: 8000 },
      home_geo: 'Frankfurt, DE',
    },
    {
      id: 'dana-whitfield', name: 'Dana Whitfield', aliases: ['dana', 'ms. whitfield', 'ms whitfield'],
      role: 'Treasury Manager', sso: { active: true, geo: 'Austin, TX', device: 'Dell Latitude (managed)' },
      registered_devices: ['iPhone (managed)'], oob: { response: 'confirmed', latency_ms: 2500 },
      home_geo: 'Austin, TX',
    },
    {
      id: 'marcus-obi', name: 'Marcus Obi', aliases: ['marcus'], role: 'Controller (second approver)',
      sso: { active: true, geo: 'Austin, TX', device: 'ThinkPad (managed)' },
      registered_devices: ['Pixel (managed)'], oob: { response: 'confirmed', latency_ms: 3000 },
      home_geo: 'Austin, TX',
    },
    {
      id: 'elena-park', name: 'Elena Park', aliases: ['elena'], role: 'Payment desk operator',
      sso: { active: true, geo: 'Austin, TX', device: 'iMac (managed)' },
      registered_devices: ['iPhone (managed)'], oob: { response: 'confirmed', latency_ms: 2000 },
      home_geo: 'Austin, TX',
    },
  ],
  payments: [
    {
      id: 'pay-4471', requester_id: 'dana-whitfield', vendor: 'Meridian Supply',
      vendor_aliases: ['meridian supply', 'meridian supply co'], amount_usd: 84_500, account_last4: '4471',
      due: '2026-09-04', approved_in: 'quarterly close meeting',
    },
  ],
  // Fix (judge review, 2026-09-03; founder ruling 2026-09-09): every Hartwell entry below
  // is Robert Miller's own acquisition business -- counsel of record, escrow institution,
  // the target's CEO, the signing city, the escrow account, the board approval date. Scoped
  // identity_ids: ['robert-miller'] so a different caller (e.g. Dana Whitfield, on an
  // unrelated Meridian Supply payment) can never be handed one of these as a knowledge
  // check -- see selectSeedFact/factInScope in src/challenges.ts, which enforces the scope
  // and fails safe (returns nothing) rather than reaching for someone else's business.
  knowledge: [
    {
      id: 'counsel_of_record', topic: 'Hartwell acquisition',
      ask: 'Ask which law firm is our counsel of record on the Hartwell deal.',
      truth: 'Calder & Finch', accept_tokens: ['calder', 'finch'],
      priority: 1, // ratified demo script opens with this question (controller ruling 2026-09-01 11:25 AM CDT)
      identity_ids: ['robert-miller'],
    },
    {
      id: 'escrow_institution', topic: 'Hartwell acquisition',
      ask: 'Ask which institution holds the Hartwell escrow.',
      truth: 'First Meridian Trust', accept_tokens: ['first', 'meridian', 'trust'],
      priority: 2, // ratified demo script asks this second (controller ruling 2026-09-01 11:25 AM CDT)
      identity_ids: ['robert-miller'],
    },
    // v2 (amendment §A): grow to >=6 SEED_FACT entries.
    {
      id: 'hartwell_target_ceo', topic: 'Hartwell acquisition',
      ask: "Ask who the target company's CEO is on the Hartwell deal.",
      truth: 'Lena Voss', accept_tokens: ['lena', 'voss'],
      identity_ids: ['robert-miller'],
    },
    {
      id: 'deal_signing_city', topic: 'Hartwell acquisition',
      ask: 'Ask which city the deal will be signed in.',
      truth: 'Zurich', accept_tokens: ['zurich'],
      identity_ids: ['robert-miller'],
    },
    {
      id: 'escrow_account_last4', topic: 'Hartwell acquisition',
      ask: 'Ask for the last four digits of the escrow account.',
      truth: '8830', accept_tokens: ['8830'],
      priority: 3, // founder ruling 2026-09-09: the demo script's third question, right
      // after counsel-of-record and escrow-institution (in that order) for Robert Miller.
      identity_ids: ['robert-miller'],
    },
    {
      id: 'board_approval_date', topic: 'Hartwell acquisition',
      ask: 'Ask when the board approved the deal.',
      truth: 'August 19', accept_tokens: ['august', '19'],
      identity_ids: ['robert-miller'],
    },
    // Founder ruling 2026-09-09 (Option A of docs/PARKED-CHALLENGE-SCOPING.md): Dana
    // Whitfield's own knowledge facts, scoped to her identity and drawn from her own world
    // (her vendor's invoice reference, the internal approver who signed off, the payment's
    // stated purpose) -- all synthetic, all consistent with her existing Meridian Supply
    // payment (pay-4471). Without these, the scoping fix above leaves an honest caller with
    // nothing answerable at all once every Hartwell fact is correctly out of her scope.
    {
      id: 'dana_invoice_reference', topic: 'Meridian Supply payment',
      ask: 'Ask for the invoice reference number on this Meridian Supply payment.',
      truth: 'INV-7734', accept_tokens: ['inv', '7734'],
      identity_ids: ['dana-whitfield'],
    },
    {
      id: 'dana_internal_approver', topic: 'Meridian Supply payment',
      ask: 'Ask which internal approver signed off on this payment.',
      truth: 'Marcus Obi', accept_tokens: ['marcus', 'obi'],
      identity_ids: ['dana-whitfield'],
    },
    {
      id: 'dana_payment_purpose', topic: 'Meridian Supply payment',
      ask: 'Ask what this payment to Meridian Supply is for.',
      truth: 'Quarterly parts restock', accept_tokens: ['quarterly', 'parts', 'restock'],
      identity_ids: ['dana-whitfield'],
    },
  ],
  rails: [{ id: 'TREASURY-WIRE', label: 'Treasury wire rail' }],
  second_approver_id: 'marcus-obi',
  incident_seed: 8092,
  thresholds: {
    high_value_usd: 50_000,
    max_challenges: 3, // v2: was 2
    pressure_flag_min: 2,
    correction_window_ms: 20_000, // v2
    tool_timeout_ms: 45_000, // v2
    approximate_jump_ratio: 2, // fix-round-2: red team item 2
  },
  pressure_lexicon: [
    'minutes', 'right now', 'immediately', 'fired', 'do not loop', "don't loop", "don't tell",
    'under nda', 'every minute', 'release it', 'release the wire', 'or else', 'urgent', 'no time',
  ],
  out_of_scope_lexicon: [
    "i'm not the ceo", 'not the ceo', 'not really', 'testing', 'hackathon', 'judge', 'just trying',
    'this is a demo', 'is this a demo', 'are you a bot', 'what is this',
  ],
  // v2 (amendment §A):
  correction_lexicon: [
    'sorry', 'i mean', 'correction', 'actually', 'no wait', 'scratch that', 'let me correct',
  ],
  affirm_lexicon: [
    'yes', 'correct', "that's right", 'right', 'yep', 'confirmed', 'exactly',
  ],
  negate_lexicon: [
    'no', 'not', 'wrong', 'incorrect', "that's not", 'never said',
  ],
  injection_lexicon: [
    'ignore previous', 'ignore your instructions', 'system prompt', 'mark this verified', 'override', 'developer mode',
  ],
  keyterms: [
    'wire transfer', 'escrow', 'Hartwell', 'Meridian', 'treasury', 'SSO', 'out-of-band',
    'verification', 'VoIP', 'incident', 'second approval', 'beneficiary', 'routing number',
    'Whitmore', 'Calder', 'Finch', 'First Meridian Trust',
  ],
};
