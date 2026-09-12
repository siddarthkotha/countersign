// packages/web/test/CallView.test.tsx
// TDD for src/components/CallView.tsx. Fixture: Scenario B's real end-of-call ScreenState,
// derived the same way the server itself derives it -- `evaluate` (the real engine) piped
// through the real `deriveScreenState` mapper (packages/server/src/screen/state.ts) -- so
// this test exercises the actual contract, not a hand-typed guess at its shape. CallView
// must render ScreenState verbatim: it computes nothing about verdicts.
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { evaluate, MERIDIAN } from '@countersign/engine';
import type { CorpusFile, EngineInput, ScreenState } from '@countersign/engine';
import { deriveScreenState } from '@countersign/server/src/screen/state.js';
import CallView from '../src/components/CallView';
import scenarioBJson from '../../engine/corpus/scenario-b-miller-fraud.json' with { type: 'json' };
import judgeOutOfScopeJson from '../../engine/corpus/judge-out-of-scope-no-request.json' with { type: 'json' };

const scenarioB = scenarioBJson as unknown as CorpusFile;
const judgeOutOfScope = judgeOutOfScopeJson as unknown as CorpusFile;

// Facts that are true in the seed world but never appear in this call's transcript (the
// real counsel of record, "Calder & Finch" -- the caller answered "Whitmore & Bass"
// instead). LAW 4: evidence quotes only verbatim transcript substrings, so these must never
// leak onto the screen -- not even inside the Why panel.
const HIDDEN_FACTS = ['Calder', 'Finch'];

function scenarioBFinalState() {
  const engineInput: EngineInput = {
    conversation: scenarioB.conversation,
    tools: scenarioB.tools,
    actions: scenarioB.actions,
    call: scenarioB.call,
    seed: MERIDIAN,
  };
  const output = evaluate(engineInput);
  return deriveScreenState({
    session_id: 'sess-b',
    t_ms: 52000,
    engineInput,
    output,
    speaking: false,
    export_hash: 'abc123def456',
    recomputed: true,
    link: 'live',
  });
}

// Judge-sim finding 2026-09-11 (docs/JUDGE-SIM-2026-09-11.md, fix 1): the corpus recording of
// exactly the line a judge tries ("I'm not the CEO, I'm testing this") -- proves fix 1 both
// live and in replay mode, since replay drives this same CallView with `link: 'replay'`.
function judgeOutOfScopeFinalState(): ScreenState {
  const engineInput: EngineInput = {
    conversation: judgeOutOfScope.conversation,
    tools: judgeOutOfScope.tools,
    actions: judgeOutOfScope.actions,
    call: judgeOutOfScope.call,
    seed: MERIDIAN,
  };
  const output = evaluate(engineInput);
  return deriveScreenState({
    session_id: 'sess-judge-1',
    t_ms: 1000,
    engineInput,
    output,
    speaking: false,
    export_hash: null,
    recomputed: false,
    link: 'replay', // the judge walked replay mode -- this is the path that must show it
  });
}

describe('CallView', () => {
  // Fix round 3, item 2: CallView used to render its own copy of the "simulated" banner --
  // on Replay.tsx that produced two copies on screen at once (its own screen-level banner
  // plus this one). The banner is now owned exclusively by the screen component (Call.tsx /
  // Replay.tsx, both tested separately for "always on" coverage) -- this locks in the fix so
  // it can't quietly come back.
  it('never renders its own copy of the simulated banner (owned by the screen component)', () => {
    render(<CallView screen={scenarioBFinalState()} />);
    expect(screen.queryByText('Every system here is simulated.')).not.toBeInTheDocument();
  });

  it('renders the WIRE FROZEN banner for Scenario B\'s terminal state', () => {
    render(<CallView screen={scenarioBFinalState()} />);
    expect(screen.getByRole('heading', { name: 'WIRE FROZEN' })).toBeInTheDocument();
  });

  // Judge-sim finding 2026-09-11 (docs/JUDGE-SIM-2026-09-11.md, fix 1): NO_ACTION -- the
  // verdict for an honest "I'm not the CEO, I'm testing this" -- used to render no banner at
  // all, unlike STAGE/FREEZE above. This locks the fix in: same slot, same section, a
  // headline plus a plain-English line so the outcome reads as deliberate, not broken. This
  // also proves replay mode shows it (`judgeOutOfScopeFinalState()` builds the state with
  // `link: 'replay'`, exactly how Replay.tsx feeds this same component).
  it('renders a NO ACTION TAKEN banner with a plain-English description for the out-of-scope end state, including in replay mode', () => {
    render(<CallView screen={judgeOutOfScopeFinalState()} />);
    const heading = screen.getByRole('heading', { name: 'NO ACTION TAKEN' });
    expect(heading).toBeInTheDocument();
    expect(
      screen.getByText(
        'Nothing was at stake on this call. No request was staged, nothing was frozen, and the evidence record is complete.',
      ),
    ).toBeInTheDocument();
  });

  // The glyph is decorative (aria-hidden) -- founder is colour-blind, so it must never be the
  // ONLY thing distinguishing this banner; the heading's accessible name is the word alone.
  it("gives the NO ACTION TAKEN banner a decorative glyph that doesn't leak into its accessible name", () => {
    render(<CallView screen={judgeOutOfScopeFinalState()} />);
    const heading = screen.getByRole('heading', { name: 'NO ACTION TAKEN' });
    expect(heading.textContent).toContain('○');
    const glyph = heading.querySelector('.banner-glyph');
    expect(glyph).not.toBeNull();
    expect(glyph).toHaveAttribute('aria-hidden', 'true');
  });

  it('renders all three gates as FAIL, as text -- never colour-only', () => {
    render(<CallView screen={scenarioBFinalState()} />);
    const gates = screen.getByLabelText('gates');
    expect(within(gates).getByText(/Context:\s*FAIL/)).toBeInTheDocument();
    expect(within(gates).getByText(/Device:\s*FAIL/)).toBeInTheDocument();
    expect(within(gates).getByText(/Consistency:\s*FAIL/)).toBeInTheDocument();
  });

  it('marks the contradicted/flagged transcript lines as highlighted', () => {
    render(<CallView screen={scenarioBFinalState()} />);
    const transcript = screen.getByLabelText('transcript');
    // Fix round 2: each row's outer element is a `<div class="turn ...">` (it now nests
    // block content -- the speaker line and the text line -- so it can no longer be a `<p>`,
    // which the HTML parser would auto-close around a nested block element).
    const c2 = within(transcript).getByText(/Whitmore & Bass/).closest('.turn');
    const c3 = within(transcript).getByText(/final figure moved this morning/).closest('.turn');
    expect(c2).toHaveAttribute('data-highlighted', 'true');
    expect(c3).toHaveAttribute('data-highlighted', 'true');
  });

  it('hides the forensic detail until "Why?" is toggled, then reveals the knowledge card and the countersign line', async () => {
    const user = userEvent.setup();
    render(<CallView screen={scenarioBFinalState()} />);

    expect(screen.queryByLabelText('forensic')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Why?' }));

    const forensic = screen.getByLabelText('forensic');
    expect(within(forensic).getByText(/Asked: which law firm is our counsel of record/i)).toBeInTheDocument();
    expect(within(forensic).getAllByText(/Whitmore & Bass/).length).toBeGreaterThan(0);
    expect(within(forensic).getByText('server verdict FREEZE, recomputed: yes')).toBeInTheDocument();
    expect(within(forensic).getByText(/abc123def456/)).toBeInTheDocument();
  });

  // Founder-law item 1 (2026-09-09): the two checklist items rulings A/B added
  // (at_least_one_challenge_passed, no_injection_attempt) get final plain-English labels,
  // replacing the rules lane's placeholder wording. Scenario B's real terminal state
  // (unmodified fixture) already carries at_least_one_challenge_passed: false and
  // no_injection_attempt: true, so this exercises both the false and the true glyph without
  // hand-building a state. The glyph (checkmark/cross), not colour, carries the true/false
  // signal -- matching every other AssuranceChecklist row in this same list.
  it('renders plain-English labels for the two rulings A/B checklist items, with glyph -- not colour -- carrying true/false', async () => {
    const state = scenarioBFinalState();
    expect(state.forensic.assurance.at_least_one_challenge_passed).toBe(false);
    expect(state.forensic.assurance.no_injection_attempt).toBe(true);

    const user = userEvent.setup();
    render(<CallView screen={state} />);
    await user.click(screen.getByRole('button', { name: 'Why?' }));

    const forensic = screen.getByLabelText('forensic');
    // The glyph and the label are separate text nodes (`{glyph} {label}` in CallView.tsx), so
    // a single `getByText` can't match the label alone against the <li>'s full text content --
    // find each row by its full rendered text instead.
    const assuranceItems = within(forensic).getAllByRole('listitem');
    const failedItem = assuranceItems.find((li) => (li.textContent ?? '').includes('At least one question answered correctly'));
    const passedItem = assuranceItems.find((li) => (li.textContent ?? '').includes('No attempt to override the agent'));
    expect(failedItem).not.toBeUndefined();
    expect(passedItem).not.toBeUndefined();
    expect(failedItem!.textContent).toMatch(/^✗/);
    expect(passedItem!.textContent).toMatch(/^✓/);
  });

  it('renders "awaiting answer" -- never an invented status word -- for an issued-but-ungraded challenge', async () => {
    const state = scenarioBFinalState();
    // The real engine always grades every issued challenge (at worst UNANSWERED), so this
    // shape never occurs from a live evaluate() call -- it is hand-built here specifically
    // to exercise CallView's defensive branch for a challenge_id absent from `results`
    // (TypeScript's noUncheckedIndexedAccess types that lookup as possibly undefined, and
    // CallView must never paper over it with an invented ChallengeResult like "PENDING").
    const ungradedState: ScreenState = {
      ...state,
      forensic: {
        ...state.forensic,
        challenges: { issued: state.forensic.challenges.issued, results: {} },
      },
    };

    const user = userEvent.setup();
    render(<CallView screen={ungradedState} />);
    await user.click(screen.getByRole('button', { name: 'Why?' }));

    const forensic = screen.getByLabelText('forensic');
    expect(within(forensic).getByText('awaiting answer')).toBeInTheDocument();
    expect(within(forensic).queryByText('PENDING')).not.toBeInTheDocument();
  });

  it('never leaks a hidden seed fact anywhere on screen, including inside the Why panel', async () => {
    const user = userEvent.setup();
    const { container } = render(<CallView screen={scenarioBFinalState()} />);
    await user.click(screen.getByRole('button', { name: 'Why?' }));

    const text = container.textContent ?? '';
    for (const fact of HIDDEN_FACTS) {
      expect(text).not.toContain(fact);
    }
  });

  // Task W5, requirement C: the two-channel live trace. Distinct WITHOUT relying on colour
  // alone -- every caller line carries the "Caller" label and a `turn-caller` class, every
  // agent line carries the "Countersign" label (never a human name, requirement E) and a
  // `turn-agent` class; the underlying `line.text` is untouched (LAW 4, never reworded).
  it('renders the caller and Countersign channels distinctly, by label and class, not colour alone', () => {
    render(<CallView screen={scenarioBFinalState()} />);
    const transcript = screen.getByLabelText('transcript');

    // Fix round 2: each row is now a numbered board row (`.turn`, a `<div>` -- see the note
    // above) with the role label on its own line, above the verbatim text, so the label
    // text itself no longer carries a trailing colon ("Caller", not "Caller:").
    const callerLine = within(transcript).getByText(/This is Robert Miller/).closest('.turn');
    expect(callerLine).not.toBeNull();
    expect(callerLine).toHaveClass('turn-caller');
    expect(callerLine).toHaveAttribute('data-speaker', 'caller');
    expect(within(callerLine as HTMLElement).getByText('Caller')).toBeInTheDocument();

    const agentLine = within(transcript).getByText(/Before anything can stage/).closest('.turn');
    expect(agentLine).not.toBeNull();
    expect(agentLine).toHaveClass('turn-agent');
    expect(agentLine).toHaveAttribute('data-speaker', 'agent');
    expect(within(agentLine as HTMLElement).getByText('Countersign')).toBeInTheDocument();

    // The agent is never given a human name anywhere on screen -- no `.turn-speaker` label
    // reads as anything but "Caller" or "Countersign".
    expect(within(transcript).queryByText('Robert Miller', { selector: '.turn-speaker' })).not.toBeInTheDocument();
  });

  // Task W5 requirement B / fix round 2: who is calling, what they ask, the amount, the
  // status word still land in the top `.board` strip, unchanged content from before this
  // round -- the verdict banner itself now lands in the checks board (the right column),
  // matching the look's actual structure.
  it('keeps the request/gates strip in the board region', () => {
    render(<CallView screen={scenarioBFinalState()} />);
    const board = screen.getByLabelText('board');
    expect(within(board).getByText(/Claimed identity:/)).toBeInTheDocument();
    expect(within(board).getByLabelText('gates')).toBeInTheDocument();
    expect(within(board).queryByRole('heading', { name: 'WIRE FROZEN' })).not.toBeInTheDocument();
  });

  // Task W5, fix round 2, requirement 2: the verdict banner lands in the checks board (the
  // right column of the two-column grid).
  it('lands the verdict line inside the checks board', () => {
    render(<CallView screen={scenarioBFinalState()} />);
    const checksBoard = screen.getByLabelText('checks-board');
    expect(within(checksBoard).getByRole('heading', { name: 'WIRE FROZEN' })).toBeInTheDocument();
  });

  // Fix round 3, item 1: at 1920x1080 the verdict banner used to land AFTER every evidence
  // row -- below the fold. It now leads the checks board, with the "Checks" heading and the
  // row list beneath it; the heading order (verdict h2 before checks h3) matches reading
  // order. `compareDocumentPosition` proves actual DOM order, not just presence.
  it('puts the verdict banner (and its h2) before the "Checks" heading (h3) and the row list', () => {
    render(<CallView screen={scenarioBFinalState()} />);
    const checksBoard = screen.getByLabelText('checks-board');
    const verdictHeading = within(checksBoard).getByRole('heading', { name: 'WIRE FROZEN', level: 2 });
    const checksHeading = within(checksBoard).getByRole('heading', { name: 'Checks', level: 3 });
    const firstRow = checksBoard.querySelector('.checks-row');

    expect(firstRow).not.toBeNull();
    // Node.DOCUMENT_POSITION_FOLLOWING (4): verdictHeading comes before checksHeading, which
    // comes before the first evidence row.
    expect(verdictHeading.compareDocumentPosition(checksHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(checksHeading.compareDocumentPosition(firstRow as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // Fix round 3, item 6: list semantics restored -- a real <ul>/<li> per reason (fix round 2
  // had string-joined them into one text node), the same reasons array, same words; the
  // " · " between them is CSS-only (styles.css `::after`), never part of any reason's text.
  it('renders the verdict reasons as a real list, one <li> per reason, with no separator baked into the text', () => {
    const state = scenarioBFinalState();
    render(<CallView screen={state} />);
    const checksBoard = screen.getByLabelText('checks-board');
    const list = checksBoard.querySelector('ul.verdict-reasons');
    expect(list).not.toBeNull();
    // Task W7, item 7: explicit `role="list"` -- `.verdict-reasons` sets `list-style: none`
    // (styles.css), which Safari/VoiceOver treats as "not really a list" and drops the
    // implicit list role for, unless one is restored explicitly.
    expect(list).toHaveAttribute('role', 'list');

    const items = within(list as HTMLElement).getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual(state.banner!.reasons);
    for (const li of items) {
      expect(li.textContent ?? '').not.toContain('·');
    }
  });

  // Task W5, fix round 2, requirement 2: each evidence card CallView already renders also
  // renders as one checks-board row above the fold (count equals the evidence array), while
  // the full card (provenance, quotes) stays in the forensic section below the fold.
  it('renders one checks-board row per evidence card', () => {
    const state = scenarioBFinalState();
    const { container } = render(<CallView screen={state} />);
    const checksBoard = screen.getByLabelText('checks-board');
    expect(within(checksBoard).getByText(state.forensic.evidence[0]!.label)).toBeInTheDocument();
    expect(container.querySelectorAll('.checks-row').length).toBe(state.forensic.evidence.length);
  });

  // Task W5, fix round 2, requirement 2: the left column's agent-status tabs are a second,
  // tab-shaped rendering of the SAME `agent_status` word already in the request-header line
  // -- never new data -- with the current one distinguishable by more than colour (its own
  // "active" class, on top of the accent colour).
  it('marks the current agent status as the active tab in the transcript board', () => {
    const state = scenarioBFinalState();
    render(<CallView screen={state} />);
    const transcriptBoard = screen.getByLabelText('transcript-board');
    const activeTab = within(transcriptBoard).getByText('Verdict');
    expect(activeTab).toHaveClass('active');
    expect(state.agent_status).toBe('VERDICT');
  });

  // Task W5, fix round 2, requirement 2: the two-column grid container itself.
  it('renders the two-column keynote grid', () => {
    const { container } = render(<CallView screen={scenarioBFinalState()} />);
    expect(container.querySelector('.keynote-grid')).not.toBeNull();
  });

  // Task W5, requirement B: Replay.tsx passes `defaultForensicOpen` so the forensic section
  // -- evidence, ledger, challenges, counterfactuals, the export hash and the countersign
  // line -- is open by default there, without a click, instead of hidden behind "Why?".
  it('opens the forensic section by default when defaultForensicOpen is set, with the export hash and countersign line present', () => {
    render(<CallView screen={scenarioBFinalState()} defaultForensicOpen />);

    const forensic = screen.getByLabelText('forensic');
    expect(within(forensic).getByText(/abc123def456/)).toBeInTheDocument();
    expect(within(forensic).getByText('server verdict FREEZE, recomputed: yes')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide why' })).toBeInTheDocument();
  });

  // Fix round 1, Critical 1: LAW 1 vocabulary -- "sealed" is banned outright, including in
  // the negative ("not yet sealed"). Before any verdict, `export_hash` is null and this is
  // the string a judge sees on the default (defaultForensicOpen) Replay path.
  it('never says "sealed" for an unset export hash, and says the hash-chained export is not yet available', async () => {
    const state = scenarioBFinalState();
    const pendingState: ScreenState = {
      ...state,
      forensic: { ...state.forensic, export_hash: null },
    };

    const user = userEvent.setup();
    const { container } = render(<CallView screen={pendingState} />);
    await user.click(screen.getByRole('button', { name: 'Why?' }));

    const forensic = screen.getByLabelText('forensic');
    expect(within(forensic).getByText('Hash-chained evidence export: not yet available')).toBeInTheDocument();
    expect(container.textContent ?? '').not.toMatch(/seal/i);
  });

  // Task W6 (QA walk 2026-09-02, finding 3): the banner's export line used to read the full
  // hash truncated inconsistently against the forensic section's own full hash below it. Now
  // the banner ever shows only the 10-character short form (already `state.ts`'s own
  // `shortHash`) -- the full hash is reachable there only via a `title` hover, and stays a
  // visible full string exactly once, in the forensic section's labelled export line.
  //
  // Task W7, item 4: that short form now also carries a visible "…" truncation marker right
  // after it, so it reads as a deliberately-cut string, not the whole hash -- the `title`
  // hover (full hash) is unchanged, and the marker itself is `aria-hidden` (decorative, the
  // `title` already carries the accessible full value).
  it('shows only the 10-character export hash in the banner, followed by a visible "…" marker (full hash in its title), and the full hash in the forensic section', async () => {
    const state = scenarioBFinalState();
    const fullHash = state.forensic.export_hash;
    expect(fullHash).not.toBeNull();
    const exportHash = fullHash as string;
    const shortHash = exportHash.slice(0, 10);

    const user = userEvent.setup();
    const { container } = render(<CallView screen={state} />);

    const checksBoard = screen.getByLabelText('checks-board');
    const banner = within(checksBoard).getByRole('alert');

    // Not `getByText` here: the "…" marker sits in its own nested `<span>` (see
    // `withHashEllipsis`, CallView.tsx), so the short hash and the marker are no longer one
    // single text node -- `getNodeText`'s default (direct child text nodes only) wouldn't
    // find either the `<p>` or the `<span>` matching the full pattern. Select the paragraph
    // directly and read its full (all-descendants) `textContent` instead.
    const sublineEl = banner.querySelector('p[title]') as HTMLElement;
    expect(sublineEl).not.toBeNull();
    expect(sublineEl.textContent ?? '').toMatch(new RegExp(`export ${shortHash}…`));
    expect(sublineEl).toHaveAttribute('title', exportHash);
    expect(sublineEl.querySelector('span[aria-hidden="true"]')?.textContent).toBe('…');
    expect(container.textContent ?? '').not.toContain(exportHash);

    await user.click(screen.getByRole('button', { name: 'Why?' }));
    const forensic = screen.getByLabelText('forensic');
    expect(within(forensic).getByText(`Hash-chained evidence export: ${exportHash}`)).toBeInTheDocument();
  });

  // Fix round 1, Important: brief requirement C asks for an auto-scrolling transcript
  // ("newest at the bottom"). `.transcript` (styles.css) is a fixed-height `overflow-y: auto`
  // box, so a newly-appended line needs something to bring it into view. `scrollIntoView` is
  // stubbed as a no-op for every test in test/setup.ts (jsdom has no layout, so it doesn't
  // implement it); spy over that stub here to assert CallView actually calls it, on the
  // newest line, both on first render and again when a line is appended.
  it('scrolls the newest transcript line into view on render and again when a line is appended', () => {
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});

    const full = scenarioBFinalState();
    const withoutLastLine: ScreenState = { ...full, transcript: full.transcript.slice(0, -1) };

    const { rerender } = render(<CallView screen={withoutLastLine} />);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    rerender(<CallView screen={full} />);
    expect(scrollIntoView).toHaveBeenCalledTimes(2);

    scrollIntoView.mockRestore();
  });
});

// Task P3, evidence-to-quote linking: every evidence card's `quotes[]` carries a verbatim
// STT substring AND the `utterance_id` it came from (packages/engine/src/types.ts, `Quote`).
// Clicking (or Enter/Space-activating) a checks-row with a quote scrolls the transcript to
// that line and marks the exact substring; a row with no quotes is inert; a second
// activation clears the highlight; it also clears itself after ~2s on its own. Scenario B's
// real engine output (same fixture as the suite above) is used throughout -- never a
// hand-typed ScreenState -- so this exercises the real `Evidence.quotes` shape.
describe('evidence-to-quote linking (Task P3)', () => {
  // `ev-consistency-amount_usd`'s first quote is `{ utterance_id: 'c1', text: '$1.8 million' }`
  // (packages/engine/corpus/scenario-b-miller-fraud.json, verified against the real engine
  // output) -- a short, unambiguous substring of c1's utterance text, distinct from the
  // request-header's differently-formatted "$1,800,000".
  const CONSISTENCY_LABEL = 'Consistency: amount usd';
  const CONSISTENCY_QUOTE = '$1.8 million';
  const CONSISTENCY_UTTERANCE_ID = 'c1';

  function getRow(label: string) {
    const row = screen.getByText(label).closest('.checks-row');
    expect(row).not.toBeNull();
    return row as HTMLElement;
  }

  it('clicking a checks-row with a quote scrolls the transcript to the matching line and marks the verbatim substring', async () => {
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
    const user = userEvent.setup();
    render(<CallView screen={scenarioBFinalState()} />);

    const row = getRow(CONSISTENCY_LABEL);
    expect(row).toHaveAttribute('role', 'button');
    expect(row).toHaveAttribute('aria-pressed', 'false');

    await user.click(row);

    expect(row).toHaveAttribute('aria-pressed', 'true');

    const transcript = screen.getByLabelText('transcript');
    const targetLine = transcript.querySelector(`[data-quote-active="true"]`);
    expect(targetLine).not.toBeNull();
    expect(targetLine).toHaveAttribute('data-speaker', 'caller');

    // The line the quote points at is really `c1` -- found by `utterance_id`, not a
    // coincidental substring match elsewhere.
    const callerLine = within(transcript).getByText(/This is Robert Miller/).closest('.turn');
    expect(targetLine).toBe(callerLine);

    const mark = (targetLine as HTMLElement).querySelector('mark.quote-mark');
    expect(mark).not.toBeNull();
    expect(mark!.textContent).toBe(CONSISTENCY_QUOTE);

    // The "quoted" prefix glyph -- a visible word, not colour -- names the line as the
    // linked one.
    expect(within(targetLine as HTMLElement).getByText('quoted')).toBeInTheDocument();

    // scrollIntoView was actually called on that exact line element (not just on some
    // element -- `mock.instances` records the `this` each call was invoked with).
    expect(scrollIntoView.mock.instances).toContain(targetLine);

    scrollIntoView.mockRestore();
  });

  // Task W7, item 2: `aria-pressed` alone is the row's semantic "this is the active one"
  // signal, but a sighted user who doesn't rely on colour to read `--cs-elevated` needs a cue
  // too -- a leading "▸" glyph prepended to the row's existing decorative square, in addition
  // to (not instead of) `aria-pressed`.
  it('shows a leading "▸" glyph on the pressed row, in addition to aria-pressed', async () => {
    const user = userEvent.setup();
    render(<CallView screen={scenarioBFinalState()} />);

    const row = getRow(CONSISTENCY_LABEL);
    const mark = row.querySelector('.checks-mark') as HTMLElement;
    expect(mark).not.toBeNull();
    expect(mark.textContent ?? '').not.toContain('▸');

    await user.click(row);

    expect(row).toHaveAttribute('aria-pressed', 'true');
    expect(mark.textContent ?? '').toContain('▸');

    await user.click(row);

    expect(row).toHaveAttribute('aria-pressed', 'false');
    expect(mark.textContent ?? '').not.toContain('▸');
  });

  it('a checks-row with no quotes is inert: no button semantics, click does nothing, and its title says why', async () => {
    const user = userEvent.setup();
    const { container } = render(<CallView screen={scenarioBFinalState()} />);

    // `ev-sso` ("SSO context") carries no quotes in Scenario B's real engine output.
    const row = getRow('SSO context');
    expect(row).not.toHaveAttribute('role');
    expect(row).not.toHaveAttribute('tabindex');
    expect(row).not.toHaveAttribute('aria-pressed');
    expect(row).toHaveAttribute('title', 'No verbatim quote on the transcript to jump to for this check');

    await user.click(row);

    expect(row).not.toHaveAttribute('aria-pressed');
    expect(container.querySelector('[data-quote-active="true"]')).toBeNull();
  });

  it('activates a checks-row from the keyboard (Enter), same result as a click', async () => {
    const user = userEvent.setup();
    render(<CallView screen={scenarioBFinalState()} />);

    const row = getRow(CONSISTENCY_LABEL);
    row.focus();
    expect(row).toHaveFocus();

    await user.keyboard('{Enter}');

    expect(row).toHaveAttribute('aria-pressed', 'true');
    const transcript = screen.getByLabelText('transcript');
    expect(transcript.querySelector('[data-quote-active="true"]')).not.toBeNull();
  });

  it('activates a checks-row from the keyboard (Space) too', async () => {
    const user = userEvent.setup();
    render(<CallView screen={scenarioBFinalState()} />);

    const row = getRow(CONSISTENCY_LABEL);
    row.focus();
    await user.keyboard(' ');

    expect(row).toHaveAttribute('aria-pressed', 'true');
  });

  it('a second click on the same row clears the highlight', async () => {
    const user = userEvent.setup();
    const { container } = render(<CallView screen={scenarioBFinalState()} />);

    const row = getRow(CONSISTENCY_LABEL);
    await user.click(row);
    expect(row).toHaveAttribute('aria-pressed', 'true');
    expect(container.querySelector('[data-quote-active="true"]')).not.toBeNull();

    await user.click(row);
    expect(row).toHaveAttribute('aria-pressed', 'false');
    expect(container.querySelector('[data-quote-active="true"]')).toBeNull();
  });

  it('clicking a different row moves the highlight instead of requiring a clear first', async () => {
    const user = userEvent.setup();
    render(<CallView screen={scenarioBFinalState()} />);

    const consistencyRow = getRow(CONSISTENCY_LABEL);
    await user.click(consistencyRow);
    expect(consistencyRow).toHaveAttribute('aria-pressed', 'true');

    // `ev-knowledge-*` ("Knowledge check")'s quote sits on a different line (`c2`), so this
    // proves the highlight actually moves to the new row's line, not just that a second row
    // also reports itself pressed.
    const knowledgeRow = getRow('Knowledge check');
    await user.click(knowledgeRow);

    expect(consistencyRow).toHaveAttribute('aria-pressed', 'false');
    expect(knowledgeRow).toHaveAttribute('aria-pressed', 'true');

    const transcript = screen.getByLabelText('transcript');
    const activeLines = transcript.querySelectorAll('[data-quote-active="true"]');
    expect(activeLines.length).toBe(1);
  });

  it('the quote highlight clears itself automatically after ~2s even without a second click', () => {
    vi.useFakeTimers();
    try {
      render(<CallView screen={scenarioBFinalState()} />);
      const row = getRow(CONSISTENCY_LABEL);

      fireEvent.click(row);
      expect(row).toHaveAttribute('aria-pressed', 'true');

      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(row).toHaveAttribute('aria-pressed', 'false');
    } finally {
      vi.useRealTimers();
    }
  });

  // Task W7, item 1: `handleChecksRowActivate` arms two `setTimeout`s (the fade timer, then
  // the clear timer, ~2s out -- see the constants above CallView). Unmounting while both are
  // still pending used to leave them free to fire later and call `setActiveQuote` on a
  // component that's gone, which is exactly the "act" warning / "state update on an
  // unmounted component" pattern this test locks out. The real fix already lives in
  // CallView.tsx (the unmount-only `useEffect(() => clearQuoteTimers, [])` above
  // `handleChecksRowActivate`) -- this test proves it actually clears both timers on unmount,
  // not just that a cleanup function exists, and that advancing past when they WOULD have
  // fired produces no console.error (React's act/state-update warnings both land there).
  it('clears the pending quote-highlight timers on unmount -- no act warning, no state update after unmount', () => {
    vi.useFakeTimers();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    try {
      const { unmount } = render(<CallView screen={scenarioBFinalState()} />);
      const row = getRow(CONSISTENCY_LABEL);

      fireEvent.click(row);
      expect(row).toHaveAttribute('aria-pressed', 'true');
      // Both timers are armed and still pending (well under the 2s window) at this point.
      clearTimeoutSpy.mockClear();

      unmount();

      // Both the fade timer and the clear timer got cleared on unmount -- not just one of
      // the two.
      expect(clearTimeoutSpy).toHaveBeenCalledTimes(2);

      act(() => {
        vi.advanceTimersByTime(5000);
      });

      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      clearTimeoutSpy.mockRestore();
      consoleError.mockRestore();
      vi.useRealTimers();
    }
  });

  // Motion is a CSS-only concern here (no matchMedia branch in the component -- see
  // CallView.tsx), guarded the same way `.banner-terminal`'s landing animation already is
  // (styles.css). This reads the real file and asserts the mechanism directly: the quote
  // mark/flag transitions exist by default and are turned off under
  // `prefers-reduced-motion: reduce`.
  it('turns the quote-highlight fade transition off under prefers-reduced-motion (styles.css)', () => {
    const cssPath = resolve(dirname(fileURLToPath(import.meta.url)), '../src/styles.css');
    const css = readFileSync(cssPath, 'utf-8');

    expect(css).toMatch(/\.quote-mark\s*\{[^}]*transition:/);
    expect(css).toMatch(/\.quote-flag\s*\{[^}]*transition:/);

    const reducedMotionBlock = css.match(/@media \(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}\n/);
    expect(reducedMotionBlock, 'no prefers-reduced-motion block found in styles.css').not.toBeNull();
    expect(reducedMotionBlock![1]).toMatch(/\.quote-flag,\s*\n\s*\.quote-mark\s*\{\s*transition:\s*none;/);
  });
});
