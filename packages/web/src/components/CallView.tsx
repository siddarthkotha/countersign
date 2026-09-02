// packages/web/src/components/CallView.tsx
// Structure only -- no look (Task W5 picks the visual language, per design law in the W2
// brief). Renders `ScreenState` verbatim: this component computes NOTHING about verdicts,
// gates, or evidence -- every word on screen is a field read straight off the prop. Status
// words are always rendered as text, never colour-only. The "simulated" banner is present
// unconditionally, rendered via the shared `SimulatedBanner` component (Task R1: the banner
// text has one source -- Call.tsx renders the same component for every moment CallView isn't
// on screen instead of this file keeping its own copy).
import { useState } from 'react';
import type { AssuranceChecklist, Claim, ChallengeResult, Evidence, ScreenState, Speaker } from '@countersign/engine';
import SimulatedBanner from './SimulatedBanner';

export type CallViewProps = {
  screen: ScreenState;
  /** Task W5, requirement B: the forensic section sits behind one "Evidence" toggle
   *  ("Why?" / "Hide why", unchanged text), default CLOSED on the live call screen and
   *  default OPEN in Replay (Replay.tsx passes `true`). Purely which way `showWhy` starts --
   *  no other behaviour changes. */
  defaultForensicOpen?: boolean;
};

// Task W5, requirement E: anywhere the UI names the agent, it says "Countersign" -- never a
// human name (controller ruling, 2026-09-02). `line.speaker` off the wire is the plain
// 'caller' | 'agent' tag (packages/engine/src/types.ts); this is a display-only relabel of
// that tag, never a change to `line.text` itself (LAW 4 / requirement C: the transcript text
// stays verbatim, never reworded).
const SPEAKER_LABELS: Record<Speaker, string> = {
  caller: 'Caller',
  agent: 'Countersign',
};

const ASSURANCE_LABELS: Record<keyof AssuranceChecklist, string> = {
  identity_claimed: 'Identity claimed',
  sso_pass_current: 'SSO context current',
  oob_confirmed_current: 'Out-of-band confirmed',
  context_pass_current: 'Request matches known context',
  no_contradictions: 'No contradictions',
  critical_fields_confirmed: 'Critical fields confirmed',
  exposure_within_limit: 'Exposure within limit',
  challenge_requirement_met: 'Challenge requirement met',
  no_identity_switch: 'No identity switch',
  not_new_beneficiary: 'Not a new beneficiary',
};

const ASSURANCE_KEYS = Object.keys(ASSURANCE_LABELS) as (keyof AssuranceChecklist)[];

/** `results[challenge_id]` can be absent for a challenge that has been issued but not yet
 *  graded (the engine has not graded it yet -- there is no eligible caller reply on the
 *  transcript for it). "awaiting answer" is NOT a member of `ChallengeResult` (PASS | FAIL |
 *  AMBIGUOUS | REFUSED | UNANSWERED) and must never be confused with one -- it is plain
 *  words for "no verdict exists here", rendered in a visibly non-status style, never an
 *  invented status word. */
function labelForChallenge(result: ChallengeResult | undefined): { text: string; ungraded: boolean } {
  if (result === undefined) return { text: 'awaiting answer', ungraded: true };
  return { text: result, ungraded: false };
}

function EvidenceCard({ evidence }: { evidence: Evidence }) {
  return (
    <article className="evidence-card">
      <h4>
        {evidence.label} — {evidence.status}
      </h4>
      <p>{evidence.detail}</p>
      <p className="provenance">Provenance: {evidence.provenance}</p>
      {evidence.quotes.length > 0 && (
        <ul className="quotes">
          {evidence.quotes.map((q, i) => (
            // Quote text is a verbatim transcript substring (LAW 4); index is fine as a key
            // here since this list is never reordered.
            <li key={`${evidence.id}-quote-${i}`}>&quot;{q.text}&quot;</li>
          ))}
        </ul>
      )}
    </article>
  );
}

function LedgerRow({ claim }: { claim: Claim }) {
  return (
    <tr>
      <td>{claim.field}</td>
      <td>{claim.kind}</td>
      <td>{String(claim.value)}</td>
      <td>&quot;{claim.quote.text}&quot;</td>
    </tr>
  );
}

export default function CallView({ screen, defaultForensicOpen }: CallViewProps) {
  const [showWhy, setShowWhy] = useState(defaultForensicOpen ?? false);

  return (
    <div className="call-view">
      {screen.simulated === true && <SimulatedBanner />}

      {/* Task W5, requirement B: the departure board -- who is calling, what they ask, the
          amount, the status word, and the verdict line landing as a board update. Same
          fields as before, grouped as one keynote board instead of a loose paragraph stack;
          nothing added or removed. */}
      <div className="board" aria-label="board">
        <header className="request-header">
          <p>Claimed identity: {screen.request.claimed_identity ?? 'unknown'}</p>
          <p>Amount: {screen.request.amount_usd !== null ? `$${screen.request.amount_usd.toLocaleString()}` : 'unknown'}</p>
          <p>Beneficiary: {screen.request.beneficiary ?? 'unknown'}</p>
          <p>Request version: {screen.request.request_version}</p>
          <p>Agent status: {screen.agent_status}</p>
        </header>

        <section className="gates" aria-label="gates">
          <p>Context: {screen.gates.context}</p>
          <p>Device: {screen.gates.device}</p>
          <p>Consistency: {screen.gates.consistency}</p>
        </section>

        {screen.banner && (
          <section className="banner-terminal" role="alert">
            <h2>{screen.banner.headline}</h2>
            <ul>
              {screen.banner.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
            <p>{screen.banner.subline}</p>
          </section>
        )}
      </div>

      {/* Task W5, requirement C: two-channel live trace. Each line still renders `line.text`
          verbatim -- only the speaker LABEL is relabelled (SPEAKER_LABELS, above), and the
          channel is marked by both a class (`turn-caller` / `turn-agent`, colour) and the
          label text itself, so the two channels read apart without relying on colour alone. */}
      <section className="transcript" aria-label="transcript">
        {screen.transcript.map((line) => (
          <p
            key={line.id}
            className={`turn turn-${line.speaker}${line.highlighted ? ' highlighted' : ''}`}
            data-highlighted={line.highlighted ? 'true' : 'false'}
            data-speaker={line.speaker}
          >
            <strong>{SPEAKER_LABELS[line.speaker]}:</strong> {line.text}
            {line.highlighted ? ' [flagged]' : ''}
            {line.interrupted ? ' [interrupted]' : ''}
          </p>
        ))}
      </section>

      <div className="forensic-zone">
        <button type="button" onClick={() => setShowWhy((v) => !v)}>
          {showWhy ? 'Hide why' : 'Why?'}
        </button>

        {showWhy && (
          <section className="forensic" aria-label="forensic">
            <h3>Evidence</h3>
            {screen.forensic.evidence.map((e) => (
              <EvidenceCard key={e.id} evidence={e} />
            ))}

            <h3>Story ledger</h3>
            <table>
              <tbody>
                {screen.forensic.ledger.map((c) => (
                  <LedgerRow key={c.id} claim={c} />
                ))}
              </tbody>
            </table>

            <h3>Challenges</h3>
            <ul>
              {screen.forensic.challenges.issued.map((c) => {
                const { text, ungraded } = labelForChallenge(screen.forensic.challenges.results[c.challenge_id]);
                return (
                  <li key={c.challenge_id}>
                    {c.field}: <span className={ungraded ? 'ungraded' : 'status-word'}>{text}</span>
                  </li>
                );
              })}
            </ul>

            <h3>Assurance</h3>
            <ul>
              {ASSURANCE_KEYS.map((key) => (
                <li key={key}>
                  {screen.forensic.assurance[key] ? '✓' : '✗'} {ASSURANCE_LABELS[key]}
                </li>
              ))}
            </ul>

            <h3>Counterfactuals</h3>
            <ul>
              {screen.forensic.counterfactuals.map((c, i) => (
                <li key={`cf-${i}`}>
                  {c.flip} → {c.verdict} ({c.state})
                </li>
              ))}
            </ul>

            <p>Export hash: {screen.forensic.export_hash ?? 'not yet sealed (hash-chained evidence export pending)'}</p>
            <p className="countersign">
              server verdict {screen.forensic.countersign.server_verdict}, recomputed: {screen.forensic.countersign.recomputed ? 'yes' : 'no'}
            </p>
          </section>
        )}
      </div>
    </div>
  );
}
