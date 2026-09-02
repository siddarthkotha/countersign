// packages/web/test/Masthead.test.tsx
// TDD for src/components/Masthead.tsx, direct (not routed through Call.tsx/Replay.tsx --
// those integration tests still cover the wiring, but the truncation/title-attribute
// behaviour itself (Task W5, fix round 3, item 4) is a property of this component alone).
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import Masthead from '../src/components/Masthead';

const UUID = '2e756eed-70c8-4fb2-8ced-2793a3512fdf';

describe('Masthead', () => {
  it('renders the wordmark only, with no meta line, when no sessionId is given (Landing)', () => {
    render(<Masthead />);
    expect(screen.getByText('COUNTERSIGN')).toBeInTheDocument();
    expect(screen.queryByText(/Treasury desk/)).not.toBeInTheDocument();
  });

  // Fix round 3, item 4: a real session id (a UUID) is far longer than 8 characters -- only
  // the first 8 show on screen, and the FULL id is still available, on a `title` attribute
  // (a native browser tooltip on hover/focus).
  it('truncates a long session id to its first 8 characters on screen, with the full id on a title attribute', () => {
    render(<Masthead sessionId={UUID} />);
    expect(UUID.length).toBeGreaterThan(8);

    const idSpan = screen.getByTitle(UUID);
    expect(idSpan).toHaveTextContent('session 2e756eed');
    expect(idSpan.textContent).not.toContain(UUID);
  });

  it('shows a short session id (<=8 characters) unchanged, still with the full id on the title attribute', () => {
    render(<Masthead sessionId="sess-123" />);
    const idSpan = screen.getByTitle('sess-123');
    expect(idSpan).toHaveTextContent('session sess-123');
  });

  it('adds "Treasury desk" once a sessionId exists, and "state <STATUS>" only once status is also given', () => {
    const { rerender } = render(<Masthead sessionId={UUID} />);
    expect(screen.getByTitle(UUID).closest('.masthead-meta')).toHaveTextContent('session 2e756eed · Treasury desk');
    expect(screen.queryByText(/state /)).not.toBeInTheDocument();

    rerender(<Masthead sessionId={UUID} status="VERDICT" />);
    expect(screen.getByTitle(UUID).closest('.masthead-meta')).toHaveTextContent(
      'session 2e756eed · Treasury desk · state VERDICT',
    );
  });

  it('never shows "state <STATUS>" without a sessionId (status alone is meaningless -- no protocol field invented)', () => {
    render(<Masthead status="VERDICT" />);
    expect(screen.queryByText(/state VERDICT/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Treasury desk/)).not.toBeInTheDocument();
  });
});
