// packages/web/test/CallView.test.tsx
// TDD for src/components/CallView.tsx. Fixture: Scenario B's real end-of-call ScreenState,
// derived the same way the server itself derives it -- `evaluate` (the real engine) piped
// through the real `deriveScreenState` mapper (packages/server/src/screen/state.ts) -- so
// this test exercises the actual contract, not a hand-typed guess at its shape. CallView
// must render ScreenState verbatim: it computes nothing about verdicts.
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { evaluate, MERIDIAN } from '@countersign/engine';
import type { CorpusFile, EngineInput, ScreenState } from '@countersign/engine';
import { deriveScreenState } from '@countersign/server/src/screen/state.js';
import CallView from '../src/components/CallView';
import scenarioBJson from '../../engine/corpus/scenario-b-miller-fraud.json' with { type: 'json' };

const scenarioB = scenarioBJson as unknown as CorpusFile;

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

describe('CallView', () => {
  it('always shows the simulated banner', () => {
    render(<CallView screen={scenarioBFinalState()} />);
    expect(screen.getByText('Every system here is simulated.')).toBeInTheDocument();
  });

  it('renders the WIRE FROZEN banner for Scenario B\'s terminal state', () => {
    render(<CallView screen={scenarioBFinalState()} />);
    expect(screen.getByRole('heading', { name: 'WIRE FROZEN' })).toBeInTheDocument();
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
    const c2 = within(transcript).getByText(/Whitmore & Bass/).closest('p');
    const c3 = within(transcript).getByText(/final figure moved this morning/).closest('p');
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

    const callerLine = within(transcript).getByText(/This is Robert Miller/).closest('p');
    expect(callerLine).not.toBeNull();
    expect(callerLine).toHaveClass('turn-caller');
    expect(callerLine).toHaveAttribute('data-speaker', 'caller');
    expect(within(callerLine as HTMLElement).getByText('Caller:')).toBeInTheDocument();

    const agentLine = within(transcript).getByText(/Before anything can stage/).closest('p');
    expect(agentLine).not.toBeNull();
    expect(agentLine).toHaveClass('turn-agent');
    expect(agentLine).toHaveAttribute('data-speaker', 'agent');
    expect(within(agentLine as HTMLElement).getByText('Countersign:')).toBeInTheDocument();

    // The agent is never given a human name anywhere on screen.
    expect(within(transcript).queryByText(/Robert Miller:/)).not.toBeInTheDocument();
  });

  // Task W5, requirement B: the verdict line lands inside the keynote board, above the fold,
  // alongside who is calling / what they ask / the amount / the status word.
  it('lands the verdict line inside the board region', () => {
    render(<CallView screen={scenarioBFinalState()} />);
    const board = screen.getByLabelText('board');
    expect(within(board).getByRole('heading', { name: 'WIRE FROZEN' })).toBeInTheDocument();
    expect(within(board).getByText(/Claimed identity:/)).toBeInTheDocument();
    expect(within(board).getByLabelText('gates')).toBeInTheDocument();
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
    expect(within(forensic).getByText('Export hash: hash-chained evidence export not yet available')).toBeInTheDocument();
    expect(container.textContent ?? '').not.toMatch(/seal/i);
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
