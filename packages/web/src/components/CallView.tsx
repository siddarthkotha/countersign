// packages/web/src/components/CallView.tsx
// Renders `ScreenState` verbatim: this component computes NOTHING about verdicts, gates, or
// evidence -- every word on screen is a field read straight off the prop. Status words are
// always rendered as text, never colour-only. The "simulated" banner is present
// unconditionally, rendered via the shared `SimulatedBanner` component (Task R1: the banner
// text has one source -- Call.tsx renders the same component for every moment CallView isn't
// on screen instead of this file keeping its own copy).
//
// Task W5, fix round 2: the look's real structure is a full-width two-column board, not a
// single stacked column -- `.keynote-grid` below the request/gates strip holds the
// transcript board (left) and the checks board (right, evidence summary + verdict banner).
// Nothing that was on screen before this round is gone: the full evidence detail
// (provenance, quotes), the story ledger, challenges, counterfactuals and the countersign
// line all still live in the forensic section below the fold, unchanged from fix round 1.
// Two fields the look's own mockup never renders and this component still must not invent:
// `EngineState` (`screen.state`) is never shown raw -- one of its members is literally
// `'SEALED'`, banned by LAW 1 -- and there is no tool-call log on `ScreenState.forensic` at
// all, so the look's "TOOL CALLS" rows are omitted rather than faked.
import { useEffect, useRef, useState } from 'react';
import type { AssuranceChecklist, Claim, ChallengeResult, Evidence, ScreenState, Speaker } from '@countersign/engine';
import SimulatedBanner from './SimulatedBanner';

// No standalone `AgentStatus` export exists on `@countersign/engine` (an engine change is
// out of scope for this task) -- derived locally from `ScreenState['agent_status']` instead,
// so this type can never drift from the real field it mirrors.
type AgentStatus = ScreenState['agent_status'];

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

// Task W5, fix round 2: the look's left-column state strip (LISTENING / SPEAKING /
// VERIFYING / AWAITING OUT-OF-BAND / VERDICT) maps 1:1 onto `ScreenState['agent_status']` --
// same five values, already rendered verbatim in the request-header's "Agent status: X"
// line -- so this is a second, tab-shaped display of the SAME already-rendered value, not
// new data. Order matches the look's own tab order.
const AGENT_STATUS_ORDER: AgentStatus[] = ['LISTENING', 'SPEAKING', 'VERIFYING', 'AWAITING_OUT_OF_BAND', 'VERDICT'];
const AGENT_STATUS_LABELS: Record<AgentStatus, string> = {
  LISTENING: 'Listening',
  SPEAKING: 'Speaking',
  VERIFYING: 'Verifying',
  AWAITING_OUT_OF_BAND: 'Awaiting out-of-band',
  VERDICT: 'Verdict',
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

/** Task W5, fix round 2: the checks-board's compact row form of the SAME evidence card --
 *  amber square glyph (decorative only, `aria-hidden`), label, status word, one-line detail.
 *  The full card (provenance, quotes) still renders via `EvidenceCard` in the forensic
 *  section below the fold; this is an addition above the fold, not a replacement. */
function ChecksRow({ evidence }: { evidence: Evidence }) {
  return (
    <div className="checks-row">
      <span className="checks-mark" aria-hidden="true">
        ■
      </span>
      <span className="checks-label">{evidence.label}</span>
      <span className="checks-status">{evidence.status}</span>
      <span className="checks-detail">{evidence.detail}</span>
    </div>
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
  // Fix round 1, Important: brief requirement C asks for an auto-scrolling transcript with
  // newest at the bottom. `.transcript` (styles.css) is a fixed-height `overflow-y: auto`
  // box, so without this a new line can land below the visible viewport. `lastLineId` (not
  // just `.length`) is the effect's dependency so a replay that restarts with a shorter
  // transcript (same length, different last line) still re-triggers the scroll -- instant,
  // no `behavior: 'smooth'`, so there is nothing here for `prefers-reduced-motion` to guard
  // and it never delays the verdict line reaching the screen.
  const lastLineRef = useRef<HTMLDivElement | null>(null);
  const lastLineId = screen.transcript.length > 0 ? screen.transcript[screen.transcript.length - 1]!.id : null;
  useEffect(() => {
    lastLineRef.current?.scrollIntoView({ block: 'end' });
  }, [lastLineId]);

  return (
    <div className="call-view">
      {screen.simulated === true && <SimulatedBanner />}

      {/* Task W5 requirement B / fix round 2: who is calling, what they ask, the amount, the
          status word -- unchanged fields, same five request-header lines and three gate
          lines as before this round; the verdict banner itself has moved into the checks
          board (below) to match the look's actual structure. */}
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
      </div>

      {/* Task W5, fix round 2, requirement 2: the full-width two-column board -- left is the
          transcript board, right is the checks board (evidence summary + verdict banner).
          Stacks to one column under 900px (styles.css). */}
      <div className="keynote-grid">
        <section className="transcript-board" aria-label="transcript-board">
          <div className="board-col-title">
            <span>Time</span>
            <span>Transcript</span>
          </div>

          <div className="agent-states" aria-label="agent-states">
            {AGENT_STATUS_ORDER.map((s) => (
              <span key={s} className={`state-pill${s === screen.agent_status ? ' active' : ''}`}>
                {AGENT_STATUS_LABELS[s]}
              </span>
            ))}
          </div>

          {/* Task W5, requirement C: two-channel live trace. Each line still renders
              `line.text` verbatim -- only the speaker LABEL is relabelled (SPEAKER_LABELS,
              above), and the channel is marked by both a class (`turn-caller`/`turn-agent`)
              and the label text itself, so the two channels read apart without relying on
              colour alone. The "[flagged]"/"[interrupted]" markers are the look's italic
              amber notes (`.turn-note`), same words as before this round. */}
          <div className="transcript" aria-label="transcript">
            {screen.transcript.map((line, i) => (
              <div
                key={line.id}
                ref={i === screen.transcript.length - 1 ? lastLineRef : undefined}
                className={`turn turn-${line.speaker}${line.highlighted ? ' highlighted' : ''}`}
                data-highlighted={line.highlighted ? 'true' : 'false'}
                data-speaker={line.speaker}
              >
                <span className="turn-index">{String(i + 1).padStart(2, '0')}.</span>
                <span className="turn-body">
                  <span className="turn-speaker">{SPEAKER_LABELS[line.speaker]}</span>
                  <span className="turn-text">{line.text}</span>
                  {line.highlighted && <em className="turn-note">[flagged]</em>}
                  {line.interrupted && <em className="turn-note">[interrupted]</em>}
                </span>
              </div>
            ))}
          </div>
        </section>

        <section className="checks-board" aria-label="checks-board">
          <h3 className="checks-board-title">Checks</h3>
          <div className="checks-rows">
            {screen.forensic.evidence.map((e) => (
              <ChecksRow key={`checks-${e.id}`} evidence={e} />
            ))}
          </div>

          {/* No tool-call rows here: ScreenState.forensic carries no tool-result log, so the
              look's "TOOL CALLS" section would have to be invented data -- it is omitted
              rather than faked. */}

          {screen.banner && (
            <section className="banner-terminal" role="alert">
              <h2>{screen.banner.headline}</h2>
              <p className="verdict-reasons">{screen.banner.reasons.join(' · ')}</p>
              <p>{screen.banner.subline}</p>
            </section>
          )}
        </section>
      </div>

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

            <p>Export hash: {screen.forensic.export_hash ?? 'hash-chained evidence export not yet available'}</p>
            <p className="countersign">
              server verdict {screen.forensic.countersign.server_verdict}, recomputed: {screen.forensic.countersign.recomputed ? 'yes' : 'no'}
            </p>
          </section>
        )}
      </div>
    </div>
  );
}
