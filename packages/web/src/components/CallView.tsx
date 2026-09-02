// packages/web/src/components/CallView.tsx
// Renders `ScreenState` verbatim: this component computes NOTHING about verdicts, gates, or
// evidence -- every word on screen is a field read straight off the prop. Status words are
// always rendered as text, never colour-only. The "simulated" banner is owned by the SCREEN
// component (Call.tsx / Replay.tsx), not by this one -- see fix round 3, item 2 below.
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
//
// Task W5, fix round 3: (1) the verdict banner now leads the checks board (right column),
// above the "Checks" heading and its own scrolling row list, so it clears the fold at
// 1920x1080; (2) this component no longer renders `SimulatedBanner` itself -- Replay.tsx
// used to end up with two copies on screen at once (its own screen-level banner plus this
// one), a real duplicate the controller ruled out under "nothing disappears" (removing a
// duplicate is not removing content); Call.tsx's and Replay.tsx's own screen-level banners
// are now the SINGLE, ALWAYS-ON source per screen. (6) the verdict reasons are a real `<ul>`
// again, not a string-joined line -- the " · " separator is CSS-only.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { AssuranceChecklist, Claim, ChallengeResult, Evidence, Quote, ScreenState, Speaker } from '@countersign/engine';

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

// Task P3, evidence-to-quote linking: `Quote.utterance_id` already names the transcript line
// it came from (packages/engine/src/types.ts) -- so the primary match is by id, never a
// fresh substring search. The substring fallback below only fires if an id somehow doesn't
// resolve to a line on THIS screen's transcript (should not happen -- every quote is drawn
// from the same conversation the transcript is built from -- but a silent wrong-line jump is
// worse than a defensive extra check), and even then it is an exact-substring match per
// LAW 4 (quotes are always verbatim), first match, never a fuzzy one.
type TranscriptLine = ScreenState['transcript'][number];

function findQuoteLine(quote: Quote, transcript: TranscriptLine[]): TranscriptLine | null {
  const byId = transcript.find((line) => line.id === quote.utterance_id);
  if (byId && byId.text.includes(quote.text)) return byId;
  return transcript.find((line) => line.text.includes(quote.text)) ?? byId ?? null;
}

/** Wraps the verbatim quoted substring in a `<mark>` -- the surrounding text is untouched
 *  (LAW 4: `line.text` itself is never edited or reworded, only wrapped for display). Falls
 *  back to the plain string if the substring can't be found (defensive; should not happen). */
function withQuoteMark(text: string, quote: string) {
  const idx = text.indexOf(quote);
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="quote-mark">{text.slice(idx, idx + quote.length)}</mark>
      {text.slice(idx + quote.length)}
    </>
  );
}

/** Task P3: the checks-board's compact row form of the SAME evidence card -- amber square
 *  glyph (decorative only, `aria-hidden`), label, status word, one-line detail. The full card
 *  (provenance, quotes) still renders via `EvidenceCard` in the forensic section below the
 *  fold; this is an addition above the fold, not a replacement.
 *
 *  A row with at least one quote is a real button-semantics control (`role="button"`,
 *  `tabIndex`, `aria-pressed`, Enter/Space activation) that jumps the transcript to the
 *  quoted line; `aria-pressed` is the row's own non-colour signal for "this is the active
 *  one". A row with no quote is left plain and inert -- its `title` says why, rather than
 *  silently doing nothing on click. */
function ChecksRow({
  evidence,
  isActive,
  onActivate,
}: {
  evidence: Evidence;
  isActive: boolean;
  onActivate: (evidence: Evidence) => void;
}) {
  const hasQuote = evidence.quotes.length > 0;

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
      // Space also scrolls the page in most browsers -- this row isn't a native <button>
      // (it sits inside a CSS grid row shared with plain, non-interactive rows), so that
      // default has to be suppressed by hand.
      event.preventDefault();
      onActivate(evidence);
    }
  }

  return (
    <div
      className={`checks-row${hasQuote ? ' checks-row-clickable' : ''}`}
      role={hasQuote ? 'button' : undefined}
      tabIndex={hasQuote ? 0 : undefined}
      aria-pressed={hasQuote ? isActive : undefined}
      onClick={hasQuote ? () => onActivate(evidence) : undefined}
      onKeyDown={hasQuote ? handleKeyDown : undefined}
      title={
        hasQuote
          ? isActive
            ? 'Clear the quoted line in the transcript'
            : 'Jump to the quoted line in the transcript'
          : 'No verbatim quote on the transcript to jump to for this check'
      }
    >
      {/* Task W7, item 2: `aria-pressed` already carries the "this row is the active one"
          signal for assistive tech; sighted users who don't rely on colour get their own
          non-colour cue too -- a leading "▸" glyph prepended to the existing decorative
          square, the same glyph already used elsewhere on screen (the transcript's "▸ quoted"
          flag) for the identical purpose, so this isn't a new visual vocabulary. Decorative
          only (`aria-hidden`), never a substitute for `aria-pressed` itself. */}
      <span className="checks-mark" aria-hidden="true">
        {isActive ? '▸ ■' : '■'}
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

// Task P3: how long a clicked-through quote stays highlighted before it's cleared
// automatically, and how much of that window is the (CSS-only, `prefers-reduced-motion`
// guarded) fade at the end -- so the mark and its "quoted" flag don't just vanish outright.
const QUOTE_HIGHLIGHT_MS = 2000;
const QUOTE_FADE_MS = 300;

type ActiveQuote = {
  evidenceId: string;
  utteranceId: string;
  text: string;
  fading: boolean;
};

/** Task W7, item 4: the banner subline's export-hash short form (10 characters, the server's
 *  own `shortHash`, packages/server/src/screen/state.ts) now gets a visible "…" truncation
 *  marker right after it, so it reads as an intentionally-cut string rather than the whole
 *  hash. This is a display-time insertion only -- `screen.banner.subline` itself (the server-
 *  composed string) is never rewritten, matching this file's rule that verbatim server/
 *  transcript text is wrapped for display, never edited (see `withQuoteMark` above). The full
 *  hash stays reachable exactly the same way as before: the paragraph's own `title`. Falls
 *  back to the subline exactly as sent if there's no export hash yet, or the short form
 *  doesn't turn up in it (defensive; should not happen). */
function withHashEllipsis(subline: string, exportHash: string | null) {
  if (!exportHash) return subline;
  const marker = `export ${exportHash.slice(0, 10)}`;
  const idx = subline.indexOf(marker);
  if (idx === -1) return subline;
  const cut = idx + marker.length;
  return (
    <>
      {subline.slice(0, cut)}
      <span aria-hidden="true">&hellip;</span>
      {subline.slice(cut)}
    </>
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

  // Task P3, evidence-to-quote linking: which checks-row (if any) is currently "pressed",
  // and which transcript line/substring it points at. One ref per transcript line (not just
  // the last one) so a click handler can scroll straight to it; two timers so the highlight
  // clears itself after ~2s even if the caller never clicks it away, with a short fade first
  // (skipped visually, not skipped in timing, under `prefers-reduced-motion` -- that's a CSS
  // concern, guarded in styles.css, not a branch here).
  const [activeQuote, setActiveQuote] = useState<ActiveQuote | null>(null);
  const quoteLineRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const quoteFadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const quoteClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function clearQuoteTimers() {
    if (quoteFadeTimerRef.current !== null) {
      clearTimeout(quoteFadeTimerRef.current);
      quoteFadeTimerRef.current = null;
    }
    if (quoteClearTimerRef.current !== null) {
      clearTimeout(quoteClearTimerRef.current);
      quoteClearTimerRef.current = null;
    }
  }

  // Unmount cleanup only -- a real dependency array here would also fire on every
  // `activeQuote` change, clearing timers the click handler just armed.
  useEffect(() => clearQuoteTimers, []);

  function handleChecksRowActivate(evidence: Evidence) {
    if (evidence.quotes.length === 0) return;

    // A second click/press on the row that's already active clears it immediately --
    // requirement, not just the ~2s timeout's job.
    if (activeQuote?.evidenceId === evidence.id) {
      clearQuoteTimers();
      setActiveQuote(null);
      return;
    }

    // Only the row's first quote drives the jump -- the row (and the "why" this check
    // failed/passed) can cite more than one, but "click a row, land on a line" only ever
    // means one line at a time.
    const quote = evidence.quotes[0]!;
    const line = findQuoteLine(quote, screen.transcript);
    const utteranceId = line?.id ?? quote.utterance_id;

    clearQuoteTimers();
    setActiveQuote({ evidenceId: evidence.id, utteranceId, text: quote.text, fading: false });
    quoteLineRefs.current.get(utteranceId)?.scrollIntoView({ block: 'center' });

    quoteFadeTimerRef.current = setTimeout(() => {
      setActiveQuote((current) => (current ? { ...current, fading: true } : current));
      quoteFadeTimerRef.current = null;
    }, QUOTE_HIGHLIGHT_MS - QUOTE_FADE_MS);

    quoteClearTimerRef.current = setTimeout(() => {
      setActiveQuote(null);
      quoteClearTimerRef.current = null;
    }, QUOTE_HIGHLIGHT_MS);
  }

  return (
    <div className="call-view">
      {/* Task W5, fix round 3, item 2: CallView no longer renders its own copy of the
          "simulated" banner -- Replay.tsx had it rendering here AND at the screen level
          simultaneously (a real duplicate on screen), and Call.tsx's screen-level banner now
          stays up unconditionally too, so there is exactly one always-on `SimulatedBanner`
          per screen, owned by the screen component, not this one. */}

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
            {screen.transcript.map((line, i) => {
              const isQuoted = activeQuote !== null && activeQuote.utteranceId === line.id;
              return (
                <div
                  key={line.id}
                  ref={(el) => {
                    if (i === screen.transcript.length - 1) lastLineRef.current = el;
                    if (el) quoteLineRefs.current.set(line.id, el);
                    else quoteLineRefs.current.delete(line.id);
                  }}
                  className={`turn turn-${line.speaker}${line.highlighted ? ' highlighted' : ''}${
                    isQuoted ? ` quote-active${activeQuote!.fading ? ' quote-fading' : ''}` : ''
                  }`}
                  data-highlighted={line.highlighted ? 'true' : 'false'}
                  data-quote-active={isQuoted ? 'true' : 'false'}
                  data-speaker={line.speaker}
                >
                  <span className="turn-index">{String(i + 1).padStart(2, '0')}.</span>
                  <span className="turn-body">
                    <span className="turn-speaker">{SPEAKER_LABELS[line.speaker]}</span>
                    <span className="turn-text">
                      {/* Task P3: the "quoted" prefix glyph -- a visible word, not a colour --
                          so the checks-row's `aria-pressed` and this line's own label both say
                          "this is the linked one" without either depending on colour alone. */}
                      {isQuoted && (
                        <span className="quote-flag">
                          <span aria-hidden="true">▸</span> quoted
                        </span>
                      )}
                      {isQuoted ? withQuoteMark(line.text, activeQuote!.text) : line.text}
                    </span>
                    {line.highlighted && <em className="turn-note">[flagged]</em>}
                    {line.interrupted && <em className="turn-note">[interrupted]</em>}
                  </span>
                </div>
              );
            })}
          </div>
        </section>

        <section className="checks-board" aria-label="checks-board">
          {/* Task W5, fix round 3, item 1: the verdict banner now leads the right column --
              at 1920x1080 it used to land after every check row, below the fold. Headline
              (h2) before the "Checks" heading (h3), so the heading order matches reading
              order too. */}
          {screen.banner && (
            <section className="banner-terminal" role="alert">
              <h2>{screen.banner.headline}</h2>
              {/* Task W5, fix round 3, item 6: list semantics restored -- a real <ul>, the
                  " · " separator is CSS-only (styles.css, ::after on non-last <li>), never
                  string-joined into one text node. */}
              {/* Task W7, item 7: explicit `role="list"` -- Safari/VoiceOver drops the
                  implicit list role off a `<ul>` once `list-style: none` is set
                  (styles.css, `.verdict-reasons`), so without this the reasons read to
                  VoiceOver as plain unstructured text, not a list of N items. */}
              <ul className="verdict-reasons" role="list">
                {screen.banner.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
              {/* Task W6 (QA walk 2026-09-02, finding 3): the subline already carries the
                  export hash short-form (first 10 characters, `state.ts`'s own `shortHash`)
                  -- the only change here is a `title` so hovering it reveals the full hash
                  this short form stands for. The full hash itself is never repeated on
                  screen a second time outside the forensic section below.
                  Task W7, item 4: `withHashEllipsis` appends a visible "…" right after that
                  short form -- see its own comment above. */}
              <p title={screen.forensic.export_hash ?? undefined}>
                {withHashEllipsis(screen.banner.subline, screen.forensic.export_hash)}
              </p>
            </section>
          )}

          <h3 className="checks-board-title">Checks</h3>
          {/* Task W5, fix round 3, item 1: its own scroll box (max-height tied to the
              viewport, styles.css) so the banner above and the first rows are always
              visible, no matter how many evidence cards this call has produced. */}
          <div className="checks-rows">
            {screen.forensic.evidence.map((e) => (
              <ChecksRow
                key={`checks-${e.id}`}
                evidence={e}
                isActive={activeQuote?.evidenceId === e.id}
                onActivate={handleChecksRowActivate}
              />
            ))}
          </div>

          {/* No tool-call rows here: ScreenState.forensic carries no tool-result log, so the
              look's "TOOL CALLS" section would have to be invented data -- it is omitted
              rather than faked. */}
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

            {/* Task W6, finding 3: labelled "hash-chained evidence export" (LAW 4 vocabulary
                -- never "sealed"/"immutable"), and this is now the ONE place the full hash
                is shown as text; the banner above only ever shows the 10-character short
                form, with the full hash reachable there via a `title` hover instead. */}
            <p>Hash-chained evidence export: {screen.forensic.export_hash ?? 'not yet available'}</p>
            <p className="countersign">
              server verdict {screen.forensic.countersign.server_verdict}, recomputed: {screen.forensic.countersign.recomputed ? 'yes' : 'no'}
            </p>
          </section>
        )}
      </div>
    </div>
  );
}
