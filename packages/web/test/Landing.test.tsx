import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Landing from '../src/screens/Landing';
import { startSession } from '../src/api';

vi.mock('../src/api', () => ({
  startSession: vi.fn()
}));

const HIDDEN_FACTS = ['Calder', 'Finch', 'First Meridian Trust', '8830', 'Zurich', 'Lena Voss', 'August 19', 'Whitmore'];

function mockGetUserMedia(outcome: 'resolve' | 'reject') {
  const stop = vi.fn();
  const fakeStream = { getTracks: () => [{ stop }] } as unknown as MediaStream;
  const getUserMedia = outcome === 'resolve'
    ? vi.fn().mockResolvedValue(fakeStream)
    : vi.fn().mockRejectedValue(new Error('denied'));
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia }
  });
  return { getUserMedia, stop };
}

beforeEach(() => {
  vi.mocked(startSession).mockReset();
});

describe('Landing', () => {
  it('renders the tagline, both buttons in order, and both role cards', () => {
    render(<Landing onWatch={vi.fn()} onCall={vi.fn()} />);

    expect(screen.getByText('A call can request a privileged action. It can never authorize one.')).toBeInTheDocument();

    const buttons = screen.getAllByRole('button').filter((b) => b.textContent !== 'Check microphone');
    expect(buttons[0]).toHaveTextContent('Watch a recorded attack');
    expect(buttons[1]).toHaveTextContent('Try to break it');

    expect(screen.getByText('Dana Whitfield, treasury manager')).toBeInTheDocument();
    expect(screen.getByText('A caller claiming to be the CEO')).toBeInTheDocument();
  });

  it('never renders any hidden scenario fact', () => {
    render(<Landing onWatch={vi.fn()} onCall={vi.fn()} />);
    const bodyText = document.body.textContent ?? '';
    for (const fact of HIDDEN_FACTS) {
      expect(bodyText).not.toContain(fact);
    }
  });

  it('enables Try to break it once the mic check passes', async () => {
    mockGetUserMedia('resolve');
    const user = userEvent.setup();
    render(<Landing onWatch={vi.fn()} onCall={vi.fn()} />);

    const tryButton = screen.getByRole('button', { name: 'Try to break it' });
    expect(tryButton).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Check microphone' }));

    expect(await screen.findByText('Microphone ready')).toBeInTheDocument();
    expect(tryButton).toBeEnabled();
  });

  it('keeps Watch enabled and Try disabled when the mic check fails', async () => {
    mockGetUserMedia('reject');
    const user = userEvent.setup();
    render(<Landing onWatch={vi.fn()} onCall={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Check microphone' }));

    expect(await screen.findByText(/Microphone blocked/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try to break it' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Watch a recorded attack' })).toBeEnabled();
  });

  it('shows the plain-words reason and keeps Watch available when live calls are replay_only', async () => {
    mockGetUserMedia('resolve');
    vi.mocked(startSession).mockResolvedValue({ replay_only: true, reason: 'daily_cap' });
    const user = userEvent.setup();
    render(<Landing onWatch={vi.fn()} onCall={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Check microphone' }));
    await screen.findByText('Microphone ready');
    await user.click(screen.getByRole('button', { name: 'Try to break it' }));

    expect(await screen.findByText(/today's call budget is used up/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Watch a recorded attack' })).toBeEnabled();
  });
});
