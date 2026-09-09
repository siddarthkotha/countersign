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
  knowledge: [
    {
      id: 'counsel_of_record', topic: 'Hartwell acquisition',
      ask: 'Ask which law firm is our counsel of record on the Hartwell deal.',
      truth: 'Calder & Finch', accept_tokens: ['calder', 'finch'],
      priority: 1, // ratified demo script opens with this question (controller ruling 2026-09-01 11:25 AM CDT)
    },
    {
      id: 'escrow_institution', topic: 'Hartwell acquisition',
      ask: 'Ask which institution holds the Hartwell escrow.',
      truth: 'First Meridian Trust', accept_tokens: ['first', 'meridian', 'trust'],
      priority: 2, // ratified demo script asks this second (controller ruling 2026-09-01 11:25 AM CDT)
    },
    // v2 (amendment §A): grow to >=6 SEED_FACT entries.
    {
      id: 'hartwell_target_ceo', topic: 'Hartwell acquisition',
      ask: "Ask who the target company's CEO is on the Hartwell deal.",
      truth: 'Lena Voss', accept_tokens: ['lena', 'voss'],
    },
    {
      id: 'deal_signing_city', topic: 'Hartwell acquisition',
      ask: 'Ask which city the deal will be signed in.',
      truth: 'Zurich', accept_tokens: ['zurich'],
    },
    {
      id: 'escrow_account_last4', topic: 'Hartwell acquisition',
      ask: 'Ask for the last four digits of the escrow account.',
      truth: '8830', accept_tokens: ['8830'],
    },
    {
      id: 'board_approval_date', topic: 'Hartwell acquisition',
      ask: 'Ask when the board approved the deal.',
      truth: 'August 19', accept_tokens: ['august', '19'],
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
    challenge_answer_window_ms: 15_000, // ruling 2026-09-09 (item 21)
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
