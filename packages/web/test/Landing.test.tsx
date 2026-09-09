import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Landing from '../src/screens/Landing';
import { startSession } from '../src/api';

vi.mock('../src/api', () => ({
  startSession: vi.fn()
}));

const HIDDEN_FACTS = ['Calder', 'Finch', 'First Meridian Trust', '8830', 'Zurich', 'Lena Voss', 'August 19', 'Whitmore'];

function mockGetUserMedia(outcome: 'resolve' | 'reject', errorName = 'NotAllowedError') {
  const stop = vi.fn();
  const fakeStream = { getTracks: () => [{ stop, label: '' }] } as unknown as MediaStream;
  const getUserMedia = outcome === 'resolve'
    ? vi.fn().mockResolvedValue(fakeStream)
    : vi.fn().mockRejectedValue(new DOMException('denied', errorName));
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia }
  });
  return { getUserMedia, stop };
}

beforeEach(() => {
  vi.mocked(startSession).mockReset();
  // Task W6: MicCheck reads navigator.permissions best-effort before getUserMedia -- absent
  // by default in jsdom, which is also the realistic "unsupported" case these tests exercise.
  Object.defineProperty(navigator, 'permissions', { configurable: true, value: undefined });
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
    mockGetUserMedia('reject', 'NotAllowedError');
    const user = userEvent.setup();
    render(<Landing onWatch={vi.fn()} onCall={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Check microphone' }));

    // Two elements now say "Microphone blocked" -- MicCheck's own result line, and the
    // helper text under the button row (finding 1) -- so this waits for (then asserts on)
    // the helper text specifically, by its stable id, rather than a substring match that
    // would now be ambiguous.
    await screen.findAllByText(/Microphone blocked/);
    expect(document.getElementById('try-break-helper')).toHaveTextContent(/Microphone blocked/);
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

    const banner = await screen.findByText(/today's call budget is used up/);
    expect(banner).toBeInTheDocument();
    // MINOR (final review): announced to assistive tech, not just visible on screen.
    expect(banner).toHaveAttribute('role', 'alert');
    expect(screen.getByRole('button', { name: 'Watch a recorded attack' })).toBeEnabled();
  });

  // Task W6 (QA walk 2026-09-02, finding 1): "Try to break it" used to be disabled with zero
  // on-page explanation. The helper text now always states the current condition, is wired
  // to the button via aria-describedby, and doubles as the button's title (hover) -- same
  // words, one source of truth.
  it('always shows plain-words helper text explaining why Try to break it is locked, wired via aria-describedby and title', () => {
    render(<Landing onWatch={vi.fn()} onCall={vi.fn()} />);

    const tryButton = screen.getByRole('button', { name: 'Try to break it' });
    expect(tryButton).toBeDisabled();

    const helper = screen.getByText('Try to break it unlocks after Check microphone passes');
    expect(helper).toHaveAttribute('id', 'try-break-helper');
    expect(tryButton).toHaveAttribute('aria-describedby', 'try-break-helper');
    expect(tryButton).toHaveAttribute('title', 'Try to break it unlocks after Check microphone passes');
  });

  it('updates the helper text (and the button title) to "Microphone ready" once the mic check passes', async () => {
    mockGetUserMedia('resolve');
    const user = userEvent.setup();
    render(<Landing onWatch={vi.fn()} onCall={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Check microphone' }));

    const tryButton = await screen.findByRole('button', { name: 'Try to break it' });
    expect(tryButton).toHaveAttribute('title', 'Microphone ready');
    expect(document.getElementById('try-break-helper')).toHaveTextContent('Microphone ready');
    expect(
      screen.queryByText('Try to break it unlocks after Check microphone passes')
    ).not.toBeInTheDocument();
  });

  it('updates the helper text to the "no microphone found" sentence for a NotFoundError', async () => {
    mockGetUserMedia('reject', 'NotFoundError');
    const user = userEvent.setup();
    render(<Landing onWatch={vi.fn()} onCall={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Check microphone' }));

    expect(
      await screen.findByText('No microphone found. The recorded attack works without one')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try to break it' })).toHaveAttribute(
      'title',
      'No microphone found. The recorded attack works without one'
    );
  });

  // Judge review finding (2026-09-04), defect 1: the demo runs on Render's free tier, which
  // sleeps after 15 minutes and can take up to about a minute to wake -- before this fix, the
  // button just went disabled with unchanged text for that whole minute, indistinguishable
  // from broken. `startSession` is held pending (not resolved) here specifically to observe
  // that in-between window, the same way the mic-check tests above observe CHECKING before
  // PASSED/FAILED.
  it('shows a cold-start message in the helper text and button title while starting, then reverts once it resolves', async () => {
    mockGetUserMedia('resolve');
    let resolveStart: (value: Awaited<ReturnType<typeof startSession>>) => void = () => {};
    const pending = new Promise<Awaited<ReturnType<typeof startSession>>>((resolve) => {
      resolveStart = resolve;
    });
    vi.mocked(startSession).mockReturnValue(pending);
    const user = userEvent.setup();
    render(<Landing onWatch={vi.fn()} onCall={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Check microphone' }));
    await screen.findByText('Microphone ready');

    await user.click(screen.getByRole('button', { name: 'Try to break it' }));

    const COLD_START_TEXT = 'Waking the server. This can take up to a minute on the free plan';
    expect(await screen.findByText(COLD_START_TEXT)).toHaveAttribute('id', 'try-break-helper');
    const tryButton = screen.getByRole('button', { name: 'Try to break it' });
    expect(tryButton).toHaveAttribute('title', COLD_START_TEXT);
    expect(tryButton).toBeDisabled();

    resolveStart({ session_id: 'sess-1', ws_path: '/ws/call/sess-1', cap_seconds: 300 });

    await screen.findByText('Microphone ready');
    expect(screen.queryByText(COLD_START_TEXT)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try to break it' })).toHaveAttribute('title', 'Microphone ready');
  });

  // Bug fix (2026-09-04): the role cards used to be decorative -- the server always built a
  // live call's simulated telemetry from a hardcoded default, so which card a visitor read
  // changed nothing. Landing now tracks which card was picked and passes it through
  // `startSession` so the server can use the matching persona.
  describe('demo persona selection (bug fix 2026-09-04)', () => {
    it('passes the legitimate persona to startSession after the Dana Whitfield card is picked', async () => {
      mockGetUserMedia('resolve');
      vi.mocked(startSession).mockResolvedValue({ session_id: 's1', ws_path: '/ws/call/s1', cap_seconds: 300 });
      const user = userEvent.setup();
      render(<Landing onWatch={vi.fn()} onCall={vi.fn()} />);

      await user.click(screen.getByRole('button', { name: 'Check microphone' }));
      await screen.findByText('Microphone ready');

      await user.click(screen.getByText('Dana Whitfield, treasury manager'));
      await user.click(screen.getByRole('button', { name: 'Try to break it' }));

      expect(startSession).toHaveBeenCalledWith('legitimate');
    });

    it('passes the attacker persona to startSession after the CEO-claim card is picked', async () => {
      mockGetUserMedia('resolve');
      vi.mocked(startSession).mockResolvedValue({ session_id: 's1', ws_path: '/ws/call/s1', cap_seconds: 300 });
      const user = userEvent.setup();
      render(<Landing onWatch={vi.fn()} onCall={vi.fn()} />);

      await user.click(screen.getByRole('button', { name: 'Check microphone' }));
      await screen.findByText('Microphone ready');

      await user.click(screen.getByText('A caller claiming to be the CEO'));
      await user.click(screen.getByRole('button', { name: 'Try to break it' }));

      expect(startSession).toHaveBeenCalledWith('attacker');
    });

    it('passes no persona (null) to startSession when no card was picked -- the server applies the safe default', async () => {
      mockGetUserMedia('resolve');
      vi.mocked(startSession).mockResolvedValue({ session_id: 's1', ws_path: '/ws/call/s1', cap_seconds: 300 });
      const user = userEvent.setup();
      render(<Landing onWatch={vi.fn()} onCall={vi.fn()} />);

      await user.click(screen.getByRole('button', { name: 'Check microphone' }));
      await screen.findByText('Microphone ready');
      await user.click(screen.getByRole('button', { name: 'Try to break it' }));

      expect(startSession).toHaveBeenCalledWith(null);
    });
  });
});
