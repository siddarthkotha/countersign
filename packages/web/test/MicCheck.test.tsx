import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MicCheck from '../src/components/MicCheck';

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

describe('MicCheck', () => {
  it('shows "Microphone ready", stops the tracks, and reports success', async () => {
    const { getUserMedia, stop } = mockGetUserMedia('resolve');
    const onResult = vi.fn();
    const user = userEvent.setup();
    render(<MicCheck onResult={onResult} />);

    await user.click(screen.getByRole('button', { name: 'Check microphone' }));

    expect(await screen.findByText('Microphone ready')).toBeInTheDocument();
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    expect(stop).toHaveBeenCalled();
    expect(onResult).toHaveBeenCalledWith(true);
  });

  it('shows the blocked banner and reports failure when getUserMedia rejects', async () => {
    mockGetUserMedia('reject');
    const onResult = vi.fn();
    const user = userEvent.setup();
    render(<MicCheck onResult={onResult} />);

    await user.click(screen.getByRole('button', { name: 'Check microphone' }));

    expect(await screen.findByText(/Microphone blocked. Use 'Watch a recorded attack' instead\./)).toBeInTheDocument();
    expect(onResult).toHaveBeenCalledWith(false);
  });
});
