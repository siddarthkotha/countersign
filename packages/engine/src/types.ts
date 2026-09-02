// packages/engine/src/types.ts
// Shared vocabulary for engine → server → UI → tests. Keep dependency-free.
//
// LAW 1: no detection claims. LAW 2: STAGE is the verdict ceiling — there is no RELEASE.
// Names in this file are frozen contract: later tasks (extractors, ledger, challenges,
// rules, corpus, hash chain) import from here verbatim. See amendment-v2-brief.md §A —
// where it conflicts with the original Task 2 brief, the amendment wins.

export type Speaker = 'caller' | 'agent';

/** One verbatim transcript line as emitted by speech-to-text. `text` is never edited. */
export interface Utterance {
  id: string;
  speaker: Speaker;
  text: string;
  t_ms: number; // ms since call start
  interrupted?: boolean; // agent line cut off by caller barge-in
}

// v2 (controller ruling): 'record_answer' REMOVED. The LLM gets NO evidence-writing tool;
// tools are server-executed and challenge grading is deterministic (src/challenges.ts).
export type ToolName =
  | 'get_request_history'
  | 'check_sso_context'
  | 'verify_out_of_band'
  | 'stage_payment_for_second_approval'
  | 'freeze_transaction_rail'
  | 'open_incident'
  | 'alert_principal'
  | 'seal_evidence_record';

export interface ToolLogEntry {
  id: string;
  name: ToolName;
  t_ms: number;
  args: Record<string, unknown>;
  result?: Record<string, unknown>; // absent = still running
}

/** v2: things the AGENT side did, written by the server when the LLM's reply for a goal
 *  completes. Never written by the LLM itself. */
export type AgentActionKind = 'challenge_issued' | 'readback_issued' | 'session_config_updated';

export interface AgentAction {
  id: string;
  kind: AgentActionKind;
  t_ms: number;
  challenge_id?: string; // challenge_issued
  // Founder-morning item 4: the exact ChallengeSpec the server recorded issuing, when
  // available. `reconstructIssued` (compose.ts) uses this verbatim after validating it was
  // a LEGAL choice at that point in the call, instead of recomputing `selectChallenge` and
  // hoping the recomputation agrees -- this is what lets the knowledge card name the
  // question actually asked (e.g. counsel-of-record) rather than whatever the hash-order
  // recomputation would have picked. Absent ⇒ falls back to the existing recomputation.
  spec?: ChallengeSpec; // challenge_issued
  field?: ClaimField; // readback_issued: what the agent read back
  value?: string; // readback_issued: what the agent read back
  detail?: string; // session_config_updated: e.g. "keyterms+=First Meridian Trust"
}

export type CallOriginKind = 'registered_device' | 'internal_line' | 'unverified_voip';

/** Simulated telephony metadata for the session (labelled "simulated" in the UI). */
export interface CallContext {
  session_id: string;
  origin_kind: CallOriginKind;
  origin_geo: string; // e.g. "Austin, TX"
}

// ---------- Story ledger (v2) ----------

export type ClaimField =
  | 'amount_usd'
  | 'beneficiary'
  | 'account_last4'
  | 'deadline'
  | 'approver'
  | 'counsel'
  | 'escrow_institution'
  | 'purpose'
  | 'others_aware'
  | 'identity';

export type ClaimKind = 'STATED' | 'CONFIRMED' | 'APPROXIMATE' | 'CORRECTED' | 'CONTRADICTED' | 'UNKNOWN';

/** One entry in the STORY LEDGER: a fact the caller stated, verbatim, with its lifecycle. */
export interface Claim {
  id: string;
  field: ClaimField;
  kind: ClaimKind;
  value: string | number; // normalized (amount as number; names lower-cased, trimmed)
  quote: Quote; // verbatim
  t_ms: number;
  supersedes?: string; // claim id this one corrected or contradicted
  request_version: number; // version this claim belongs to
}

// ---------- Challenges (v2: the LLM may ask, never grade) ----------

export type ChallengeKind = 'SEED_FACT' | 'LIVE_COMMITMENT' | 'TRAP_FACT' | 'RELATIONAL';

export interface ChallengeSpec {
  challenge_id: string; // deterministic: `${session_id}-${index}`
  kind: ChallengeKind;
  field: ClaimField;
  ask: string; // phrasing goal for the LLM (never contains the expected answer)
  expect:
    | { accept_tokens: string[] }
    | { commitment_claim_id: string }
    | { trap_value: string; true_claim_id: string };
  fact_id?: string; // SEED_FACT only: the seed.knowledge entry id (e.g. "counsel_of_record"), for judge-legible evidence detail
}

export type ChallengeResult = 'PASS' | 'FAIL' | 'AMBIGUOUS' | 'REFUSED' | 'UNANSWERED';

// ---------- Seed (the synthetic world; all fictional) ----------

export interface Identity {
  id: string;
  name: string;
  aliases: string[]; // extra spoken forms, e.g. "Mr. Miller", "Bob Miller"
  role: string;
  sso: { active: boolean; geo: string; device: string };
  registered_devices: string[];
  oob: { response: 'confirmed' | 'no_response'; latency_ms: number };
  home_geo: string; // where a legitimate call from this person would originate
}

export interface ScheduledPayment {
  id: string;
  requester_id: string;
  vendor: string;
  vendor_aliases: string[];
  amount_usd: number;
  account_last4: string;
  due: string; // ISO date
  approved_in: string; // human note
}

export interface KnowledgeFact {
  id: string; // e.g. "counsel_of_record"
  topic: string; // e.g. "Hartwell acquisition"
  ask: string; // phrasing goal for the LLM
  truth: string; // display value
  accept_tokens: string[]; // lower-case tokens that must ALL appear in the answer
}

export interface SeedConfig {
  company: string;
  identities: Identity[];
  payments: ScheduledPayment[];
  knowledge: KnowledgeFact[];
  rails: { id: string; label: string }[];
  second_approver_id: string;
  incident_seed: number; // first incident id, e.g. 8092
  thresholds: {
    high_value_usd: number; // 50_000
    max_challenges: number; // v2: 3
    pressure_flag_min: number; // distinct pressure hits to FLAG, 2
    correction_window_ms: number; // v2: 20000
    tool_timeout_ms: number; // v2: 45000
  };
  pressure_lexicon: string[]; // lower-case phrases
  out_of_scope_lexicon: string[]; // lower-case phrases
  correction_lexicon: string[]; // v2: lower-case phrases, e.g. "actually", "scratch that"
  affirm_lexicon: string[]; // v2: lower-case phrases, e.g. "yes", "correct"
  negate_lexicon: string[]; // v2: lower-case phrases, e.g. "no", "wrong"
  injection_lexicon: string[]; // v2: lower-case phrases, e.g. "ignore previous"
  keyterms: string[]; // v2: fed to session.update as the baseline listening vocabulary
}

// ---------- Evidence (facts separate from interpretation) ----------

export interface Quote {
  utterance_id: string;
  text: string; // verbatim substring of that utterance's text
}

export type EvidenceKind =
  | 'identity_claim'
  | 'request_params'
  | 'knowledge_check_result'
  | 'consistency_flag'
  | 'sso_context_result'
  | 'oob_verification_result'
  | 'context_check_result'
  | 'pressure_marker'
  | 'out_of_scope_marker'
  | 'identity_switch'
  | 'exposure_check_result'
  | 'readback_result'
  | 'injection_marker';

export type EvidenceStatus = 'PASS' | 'FAIL' | 'FLAG' | 'PENDING' | 'INFO';

/** v2: where a fact came from — never conflated with whether it's true. */
export type Provenance = 'CALLER_SAID' | 'CALLER_CORRECTED' | 'SIMULATED_SYSTEM' | 'POLICY_DERIVED' | 'UNRESOLVED';

export interface Evidence {
  id: string;
  kind: EvidenceKind;
  t_ms: number;
  label: string; // card title, e.g. "Identity"
  status: EvidenceStatus; // interpretation
  detail: string; // interpretation, one line, judge-legible
  facts: Record<string, string | number | boolean | null>; // raw, machine facts
  quotes: Quote[]; // verbatim STT substrings backing this card
  source: 'transcript' | 'tool';
  provenance: Provenance; // v2
  request_version: number; // v2
}

// ---------- Engine output ----------

export type EngineState =
  | 'INTAKE'
  | 'CLAIM'
  | 'CHALLENGE'
  | 'EVIDENCE'
  | 'CONSISTENCY_CHECK'
  | 'DECISION'
  | 'ACTION'
  | 'SEALED'
  | 'OUT_OF_SCOPE';

/** LAW 2: STAGE is the ceiling. There is no release. */
export type Verdict = 'PENDING' | 'ESCALATE' | 'STAGE' | 'FREEZE' | 'NO_ACTION';

export type VerdictReason =
  | 'IDENTITY_UNVERIFIED'
  | 'URGENCY_ESCALATION'
  | 'CONTEXT_FAILURE'
  | 'STORY_INCONSISTENCY'
  | 'OUT_OF_BAND_NO_RESPONSE'
  | 'KNOWLEDGE_CHECK_FAILED'
  | 'OUT_OF_SCOPE'
  // v2 fix round 1 (review finding, minor): rows 9/10 could ESCALATE with reasons: [] --
  // these give the anti-structuring and first-time-beneficiary escalations their own
  // reason codes, appended after URGENCY_ESCALATION in the ordered reasons list.
  | 'EXPOSURE_LIMIT'
  | 'NEW_BENEFICIARY';

export type GoalCode =
  | 'GREET'
  | 'ELICIT_IDENTITY'
  | 'ELICIT_REQUEST'
  | 'ASK_CHALLENGE'
  | 'STALL'
  | 'PROBE_CONSISTENCY'
  | 'REFUSE_AUTHORITY'
  | 'ANNOUNCE_STAGED'
  | 'ANNOUNCE_FROZEN'
  | 'ANNOUNCE_ESCALATED'
  | 'CONTAIN'
  | 'EXPLAIN_OUT_OF_SCOPE'
  | 'CLOSE'
  // v2 additions:
  | 'READBACK'
  | 'RE_ELICIT_AFTER_SWITCH'
  | 'EXPLAIN_OPEN_REQUEST'
  | 'CONTAIN_NO_DISCLOSURE';

export interface PhrasingGoal {
  code: GoalCode;
  hint: string; // plain-English instruction for the LLM, never a verdict
  challenge?: ChallengeSpec; // present when code === 'ASK_CHALLENGE' (v2: was KnowledgeFact)
  readback?: { field: ClaimField; value: string }; // present when code === 'READBACK' (v2)
  keyterms: string[]; // v2: seed keyterms + every proper noun/amount the caller has stated
  turn_detection_hint: 'default' | 'patient'; // v2: 'patient' in CHALLENGE and READBACK
}

export interface EngineInput {
  conversation: Utterance[];
  tools: ToolLogEntry[];
  actions: AgentAction[]; // v2
  call: CallContext;
  seed: SeedConfig;
}

/** v2: the affirmative requirements for STAGE, each true/false with a reason baked into
 *  how it was computed. All true is necessary (not sufficient on its own) for STAGE. */
export interface AssuranceChecklist {
  identity_claimed: boolean;
  sso_pass_current: boolean;
  oob_confirmed_current: boolean;
  context_pass_current: boolean;
  no_contradictions: boolean;
  critical_fields_confirmed: boolean;
  exposure_within_limit: boolean;
  challenge_requirement_met: boolean;
  no_identity_switch: boolean;
  not_new_beneficiary: boolean;
}

export interface EngineOutput {
  state: EngineState;
  verdict: Verdict;
  reasons: VerdictReason[];
  failure_tally: number; // count of independent FAILED checks (FLAGs excluded)
  evidence: Evidence[];
  allowed_tools: ToolName[]; // per-state allowlist (server enforces too)
  required_actions: ToolName[]; // terminal actions still owed for the verdict
  goal: PhrasingGoal;
  claimed_identity_id: string | null;
  // v2 additions:
  ledger: Claim[];
  request_version: number;
  challenges: { issued: ChallengeSpec[]; results: Record<string, ChallengeResult> };
  assurance: AssuranceChecklist;
  invariants_ok: boolean; // VOICE_CAN_NEVER_RELEASE and friends; false = engine bug, treated as NO_ACTION
}

// ---------- Corpus (Task 6; typed here so seed/corpus files share one contract) ----------

export interface CorpusFile {
  title: string;
  description: string;
  call: CallContext;
  conversation: Utterance[];
  tools: ToolLogEntry[];
  actions: AgentAction[]; // v2
  expected: {
    verdict: Verdict;
    state: EngineState;
    reasons: VerdictReason[];
    failure_tally: number;
    request_version: number; // v2
    assurance?: Partial<AssuranceChecklist>; // v2 (Task 6): required for STAGE/ESCALATE files
  };
}
