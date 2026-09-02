// packages/server/src/screen/state.ts
// EngineOutput (+ the little bit of live/replay context an EngineOutput alone can't carry:
// t_ms, whether the agent is mid-reply, the export hash, the countersign re-run result,
// and whether this is a live call or a replay) -> the judge-legible ScreenState the browser
// actually renders. Pure: same inputs, same ScreenState, always. `call/session.ts` (live)
// and `replay.ts` (recorded) both call this -- it is the ONE code path that turns engine
// output into what appears on screen, so a live run and a replay of the same corpus file
// render identically save for `link`.
import { counterfactuals } from '@countersign/engine';
import type {
  Claim,
  ClaimField,
  EngineInput,
  EngineOutput,
  Evidence,
  EvidenceStatus,
  ScreenState,
  Verdict,
} from '@countersign/engine';

export interface ScreenStateInput {
  session_id: string;
  t_ms: number;
  /** The exact (conversation, tools, actions, call, seed) `output` was computed from --
   *  needed here too, since ScreenState surfaces more than EngineOutput alone carries
   *  (the transcript itself, tool-outstanding checks for agent_status, and the
   *  counterfactual re-runs, which need the full input to call `evaluate` again). */
  engineInput: EngineInput;
  output: EngineOutput;
  /** True strictly between a `reply.started` and its matching `reply.done`. */
  speaking: boolean;
  /** Set once the terminal-action countersign re-run has produced a hash-chained export;
   *  null before that (PENDING/mid-call, or a verdict that never reaches a terminal action). */
  export_hash: string | null;
  /** Whether re-running `evaluate` over the frozen logs (after the terminal actions ran)
   *  reproduced the same verdict. `false` (never null -- LAW: no unverified claim of a
   *  match) until that re-run has actually happened. */
  recomputed: boolean;
  link: 'live' | 'replay' | 'lost';
}

function currentClaimByField(ledger: Claim[], field: ClaimField): Claim | null {
  for (let i = ledger.length - 1; i >= 0; i--) {
    if (ledger[i]!.field === field) return ledger[i]!;
  }
  return null;
}

function findEvidence(evidence: Evidence[], id: string): Evidence | undefined {
  return evidence.find((e) => e.id === id);
}

/** "Worst" of a set of consistency-flag statuses. In practice every `ev-consistency-*`
 *  card status is always FAIL (buildConsistencyEvidence never emits anything else), so this
 *  degenerates to "any card present -> FAIL"; the explicit order keeps the gate honest if
 *  that ever changes without this file being touched. */
const SEVERITY_ORDER: EvidenceStatus[] = ['FAIL', 'FLAG', 'PENDING', 'INFO', 'PASS'];

function worstStatus(statuses: EvidenceStatus[]): EvidenceStatus {
  for (const s of SEVERITY_ORDER) if (statuses.includes(s)) return s;
  return 'PASS';
}

function plainWords(reason: string): string {
  return reason.toLowerCase().replace(/_/g, ' ');
}

function shortHash(hash: string | null): string | null {
  return hash ? hash.slice(0, 10) : null;
}

const BANNER_HEADLINE: Record<'FREEZE' | 'STAGE' | 'ESCALATE', string> = {
  FREEZE: 'WIRE FROZEN',
  STAGE: 'STAGED FOR SECOND APPROVAL',
  ESCALATE: 'ESCALATED TO A HUMAN',
};

function isBannerVerdict(v: Verdict): v is 'FREEZE' | 'STAGE' | 'ESCALATE' {
  return v === 'FREEZE' || v === 'STAGE' || v === 'ESCALATE';
}

export function deriveScreenState(input: ScreenStateInput): ScreenState {
  const { session_id, t_ms, engineInput, output, speaking, export_hash, recomputed, link } = input;
  const { seed, tools, conversation } = engineInput;

  const amountClaim = currentClaimByField(output.ledger, 'amount_usd');
  const beneficiaryClaim = currentClaimByField(output.ledger, 'beneficiary');
  const claimedIdentity = output.claimed_identity_id
    ? (seed.identities.find((i) => i.id === output.claimed_identity_id)?.name ?? output.claimed_identity_id)
    : null;

  const contextEv = findEvidence(output.evidence, 'ev-context');
  const oobEv = findEvidence(output.evidence, 'ev-oob');
  const consistencyStatuses = output.evidence.filter((e) => e.id.startsWith('ev-consistency-')).map((e) => e.status);

  const gates = {
    context: contextEv?.status ?? ('PENDING' as EvidenceStatus),
    device: oobEv?.status ?? ('PENDING' as EvidenceStatus),
    consistency: consistencyStatuses.length > 0 ? worstStatus(consistencyStatuses) : ('PASS' as EvidenceStatus),
  };

  const highlightedUtteranceIds = new Set<string>();
  for (const e of output.evidence) {
    if (e.status === 'FAIL' || e.status === 'FLAG') {
      for (const q of e.quotes) highlightedUtteranceIds.add(q.utterance_id);
    }
  }

  const transcript = conversation.map((u) => ({
    id: u.id,
    speaker: u.speaker,
    text: u.text,
    t_ms: u.t_ms,
    ...(u.interrupted ? { interrupted: true as const } : {}),
    ...(highlightedUtteranceIds.has(u.id) ? { highlighted: true as const } : {}),
  }));

  const oobOutstanding = tools.some((t) => t.name === 'verify_out_of_band' && t.result === undefined);
  const anyToolOutstanding = tools.some((t) => t.result === undefined);
  const terminalVerdict = output.verdict !== 'PENDING';

  let agent_status: ScreenState['agent_status'];
  if (terminalVerdict) {
    agent_status = 'VERDICT';
  } else if (gates.device === 'PENDING' && oobOutstanding) {
    agent_status = 'AWAITING_OUT_OF_BAND';
  } else if (speaking) {
    agent_status = 'SPEAKING';
  } else if (anyToolOutstanding) {
    agent_status = 'VERIFYING';
  } else {
    agent_status = 'LISTENING';
  }

  let banner: ScreenState['banner'] = null;
  if (isBannerVerdict(output.verdict)) {
    const incidentResult = tools.find((t) => t.name === 'open_incident' && t.result)?.result;
    const incidentId = incidentResult ? String(incidentResult.incident_id ?? '') : null;
    const approverName = seed.identities.find((i) => i.id === seed.second_approver_id)?.name ?? 'the second approver';
    const hashShort = shortHash(export_hash);

    const subParts: string[] = [];
    if (incidentId) subParts.push(`incident ${incidentId}`);
    if (output.verdict === 'STAGE') subParts.push(`second approval: ${approverName}`);
    if (hashShort) subParts.push(`export ${hashShort}`);

    banner = {
      headline: BANNER_HEADLINE[output.verdict],
      reasons: output.reasons.map(plainWords),
      subline: subParts.join(' · '),
    };
  }

  return {
    session_id,
    t_ms,
    state: output.state,
    verdict: output.verdict,
    reasons: output.reasons,
    request: {
      claimed_identity: claimedIdentity,
      amount_usd: amountClaim ? Number(amountClaim.value) : null,
      beneficiary: beneficiaryClaim ? String(beneficiaryClaim.value) : null,
      request_version: output.request_version,
    },
    gates,
    transcript,
    agent_status,
    banner,
    forensic: {
      evidence: output.evidence,
      ledger: output.ledger,
      challenges: output.challenges,
      assurance: output.assurance,
      counterfactuals: counterfactuals(engineInput),
      export_hash,
      countersign: { server_verdict: output.verdict, recomputed },
    },
    simulated: true,
    link,
  };
}
