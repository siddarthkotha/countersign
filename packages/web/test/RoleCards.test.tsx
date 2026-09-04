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
});
