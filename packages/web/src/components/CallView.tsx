// packages/web/src/components/CallView.tsx
// Structure only -- no look (Task W5 picks the visual language, per design law in the W2
// brief). Renders `ScreenState` verbatim: this component computes NOTHING about verdicts,
// gates, or evidence -- every word on screen is a field read straight off the prop. Status
// words are always rendered as text, never colour-only. The "simulated" banner is present
// unconditionally.
import { useState } from 'react';
import type { AssuranceChecklist, Claim, Evidence, ScreenState } from '@countersign/engine';

export type CallViewProps = {
  screen: ScreenState;
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

export default function CallView({ screen }: CallViewProps) {
  const [showWhy, setShowWhy] = useState(false);

  return (
    <div className="call-view">
      <p className="banner">Every system here is simulated.</p>

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

      <section className="transcript" aria-label="transcript">
        {screen.transcript.map((line) => (
          <p key={line.id} className={line.highlighted ? 'highlighted' : undefined} data-highlighted={line.highlighted ? 'true' : 'false'}>
            <strong>{line.speaker}:</strong> {line.text}
            {line.highlighted ? ' [flagged]' : ''}
            {line.interrupted ? ' [interrupted]' : ''}
          </p>
        ))}
      </section>

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
            {screen.forensic.challenges.issued.map((c) => (
              <li key={c.challenge_id}>
                {c.field}: {screen.forensic.challenges.results[c.challenge_id] ?? 'PENDING'}
              </li>
            ))}
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
  );
}
