import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import RoleCards from '../src/components/RoleCards';

// Bug fix (2026-09-04): RoleCards used to be static text with no selection mechanism at all,
// so the landing page had no way to tell the server which demo persona (simulated call
// telemetry) a visitor means to play. This is the minimum interaction added to make that
// choice readable -- same markup, same classes, same copy, only a click handler on each
// EXISTING <section>, so the page's visual design is unchanged.
describe('RoleCards', () => {
  it('still renders both cards with their original copy unchanged', () => {
    render(<RoleCards selected={null} onSelect={vi.fn()} />);
    expect(screen.getByText('Dana Whitfield, treasury manager')).toBeInTheDocument();
    expect(
      screen.getByText('Ask to move the scheduled Meridian Supply payment earlier than Friday. Use your own words.')
    ).toBeInTheDocument();
    expect(screen.getByText('A caller claiming to be the CEO')).toBeInTheDocument();
    expect(
      screen.getByText('Ask for a confidential escrow transfer for an acquisition. Improvise. The system will ask you questions.')
    ).toBeInTheDocument();
  });

  it('Dana card renders the "Say first" and "Then" facts from RoleFacts', () => {
    render(<RoleCards selected={null} onSelect={vi.fn()} />);
    // Both cards have "Say first:" so use getAllByText and check the first one is present
    expect(screen.getAllByText(/Say first:/)).toHaveLength(2);
    expect(screen.getByText(/This is Dana Whitfield from corporate treasury/)).toBeInTheDocument();
    expect(screen.getAllByText(/Then:/)).toHaveLength(2);
    expect(screen.getByText(/I need to wire a payment to Meridian Supply, \$84,500/)).toBeInTheDocument();
    expect(screen.getByText(/84,500/)).toBeInTheDocument();
    expect(screen.getByText(/4471/)).toBeInTheDocument();
    expect(screen.getByText(/Marcus Obi/)).toBeInTheDocument();
    expect(screen.getByText(/INV-7734/)).toBeInTheDocument();
  });

  it('CEO-claim card renders the "Say first" and "Then" facts from RoleFacts', () => {
    render(<RoleCards selected={null} onSelect={vi.fn()} />);
    // Both cards have "Say first:" so check that both are present
    expect(screen.getAllByText(/Say first:/)).toHaveLength(2);
    expect(screen.getByText(/This is Robert Miller/)).toBeInTheDocument();
    expect(screen.getAllByText(/Then:/)).toHaveLength(2);
    expect(screen.getByText(/I'm closing the Hartwell acquisition/)).toBeInTheDocument();
    expect(screen.getByText(/Hartwell/)).toBeInTheDocument();
    expect(screen.getByText(/1.8 million/)).toBeInTheDocument();
    expect(screen.getByText(/2.1 million/)).toBeInTheDocument();
  });

  it('clicking the Dana Whitfield card selects the legitimate persona', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<RoleCards selected={null} onSelect={onSelect} />);

    await user.click(screen.getByText('Dana Whitfield, treasury manager'));

    expect(onSelect).toHaveBeenCalledWith('legitimate');
  });

  it('clicking the CEO-claim card selects the attacker persona', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<RoleCards selected={null} onSelect={onSelect} />);

    await user.click(screen.getByText('A caller claiming to be the CEO'));

    expect(onSelect).toHaveBeenCalledWith('attacker');
  });

  // Accessibility (2026-09-04, review finding): the cards were made clickable with a click
  // handler on a plain section, which is mouse-only. They now carry a button role and take
  // focus, so a keyboard user must be able to reach and activate them the way a button works.
  // The review noted the keyboard path was implemented but never exercised; these cover it.
  it('a keyboard user can reach both cards and activate one with Enter', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<RoleCards selected={null} onSelect={onSelect} />);

    const cards = screen.getAllByRole('button');
    expect(cards).toHaveLength(2);

    await user.tab();
    expect(cards[0]).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledWith('legitimate');
  });

  it('Space activates a card, the way a real button does', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<RoleCards selected={null} onSelect={onSelect} />);

    const cards = screen.getAllByRole('button');
    cards[1]!.focus();
    await user.keyboard('[Space]');

    expect(onSelect).toHaveBeenCalledWith('attacker');
  });

  it('says in words which card is chosen, never by styling alone', () => {
    render(<RoleCards selected={'legitimate'} onSelect={vi.fn()} />);

    expect(screen.getByText(/Dana Whitfield, treasury manager \(chosen\)/)).toBeInTheDocument();
    expect(screen.getAllByRole('button')[0]).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByRole('button')[1]).toHaveAttribute('aria-pressed', 'false');
  });
});
