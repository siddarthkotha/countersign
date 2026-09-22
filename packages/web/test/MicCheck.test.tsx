// packages/web/test/MicCheck.test.tsx
// Task W6 (QA walk 2026-09-02, finding 2): "Check microphone" used to produce zero visible
// feedback on any path but a bare happy path -- a mic-less judge saw nothing and concluded
// the product was broken. Every branch below asserts one thing: a click always ends with a
// visible, distinct sentence on screen, word-prefixed (never colour alone).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MicCheck, { MIC_CHECK_TIMEOUT_MS } from '../src/components/MicCheck';

function mockGetUserMedia(impl: () => Promise<MediaStream>) {
  const getUserMedia = vi.fn(impl);
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia }
  });
  return getUserMedia;
}

function fakeStream(trackOpts: { label?: string } = {}): { stream: MediaStream; stop: ReturnType<typeof vi.fn> } {
  const stop = vi.fn();
  const track = { stop, label: trackOpts.label ?? '' };
  return { stream: { getTracks: () => [track] } as unknown as MediaStream, stop };
}

afterEach(() => {
  // Never let a real `navigator.permissions` (or a per-test stub of it) leak into the next
  // test -- each test that cares about it sets its own.
  Object.defineProperty(navigator, 'permissions', { configurable: true, value: undefined });
});

describe('MicCheck', () => {
  it('shows "PASSED" with the device label, stops the tracks, and reports success', async () => {
    const { stream, stop } = fakeStream({ label: 'USB Microphone' });
    const getUserMedia = mockGetUserMedia(() => Promise.resolve(stream));
    const onResult = vi.fn();
    const user = userEvent.setup();
    render(<MicCheck onResult={onResult} />);

    await user.click(screen.getByRole('button', { name: 'Check microphone' }));

    expect(await screen.findByText('PASSED: Microphone ready (USB Microphone).')).toBeInTheDocument();
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: true }
    });
    expect(stop).toHaveBeenCalled();
    expect(onResult).toHaveBeenCalledWith({ ok: true, reason: 'passed', deviceLabel: 'USB Microphone' });
  });

  it('shows "PASSED" with no device label when the browser does not supply one', async () => {
    mockGetUserMedia(() => Promise.resolve(fakeStream().stream));
    const onResult = vi.fn();
    const user = userEvent.setup();
    render(<MicCheck onResult={onResult} />);

    await user.click(screen.getByRole('button', { name: 'Check microphone' }));

    expect(await screen.findByText('PASSED: Microphone ready.')).toBeInTheDocument();
    expect(onResult).toHaveBeenCalledWith({ ok: true, reason: 'passed', deviceLabel: null });
  });

  it('shows a distinct sentence and reports failure for NotAllowedError (permission denied)', async () => {
    mockGetUserMedia(() => Promise.reject(new DOMException('denied', 'NotAllowedError')));
    const onResult = vi.fn();
    const user = userEvent.setup();
    render(<MicCheck onResult={onResult} />);

    await user.click(screen.getByRole('button', { name: 'Check microphone' }));

    const line = await screen.findByText(/^FAILED: Microphone blocked\./);
    expect(line).toHaveAttribute('role', 'status');
    expect(line).toHaveAttribute('aria-live', 'polite');
    expect(onResult).toHaveBeenCalledWith({ ok: false, reason: 'not-allowed', deviceLabel: null });
  });

  it('shows a distinct sentence and reports failure for NotFoundError (no device)', async () => {
    mockGetUserMedia(() => Promise.reject(new DOMException('no device', 'NotFoundError')));
    const onResult = vi.fn();
    const user = userEvent.setup();
    render(<MicCheck onResult={onResult} />);

    await user.click(screen.getByRole('button', { name: 'Check microphone' }));

    const line = await screen.findByText(/^FAILED: No microphone found\./);
    expect(line).toHaveAttribute('role', 'status');
    expect(line).toHaveAttribute('aria-live', 'polite');
    expect(onResult).toHaveBeenCalledWith({ ok: false, reason: 'not-found', deviceLabel: null });
  });

  it('shows a distinct sentence and reports failure for NotReadableError (device in use)', async () => {
    mockGetUserMedia(() => Promise.reject(new DOMException('busy', 'NotReadableError')));
    const onResult = vi.fn();
    const user = userEvent.setup();
    render(<MicCheck onResult={onResult} />);

    await user.click(screen.getByRole('button', { name: 'Check microphone' }));

    const line = await screen.findByText(/^FAILED: Microphone is in use by another app\./);
    expect(line).toHaveAttribute('role', 'status');
    expect(line).toHaveAttribute('aria-live', 'polite');
    expect(onResult).toHaveBeenCalledWith({ ok: false, reason: 'not-readable', deviceLabel: null });
  });

  it('shows a distinct sentence and reports failure for an unrecognised/generic error', async () => {
    mockGetUserMedia(() => Promise.reject(new Error('something odd')));
    const onResult = vi.fn();
    const user = userEvent.setup();
    render(<MicCheck onResult={onResult} />);

    await user.click(screen.getByRole('button', { name: 'Check microphone' }));

    const line = await screen.findByText(/^FAILED: Could not access the microphone\./);
    expect(line).toHaveAttribute('role', 'status');
    expect(line).toHaveAttribute('aria-live', 'polite');
    expect(onResult).toHaveBeenCalledWith({ ok: false, reason: 'error', deviceLabel: null });
  });

  // Real timers, a tiny `timeoutMs` override (a test-only prop -- production always uses the
  // real MIC_CHECK_TIMEOUT_MS, exported and asserted as 8000 below) instead of fake timers:
  // this exercises the exact same `withTimeout` race the 8s production path uses, without
  // the fake-timer/act sequencing fragility of firing a real click handler's own `setTimeout`
  // registration mid-microtask-chain.
  it('exports the real 8-second timeout constant', () => {
    expect(MIC_CHECK_TIMEOUT_MS).toBe(8000);
  });

  it('times out with its own sentence when getUserMedia never resolves', async () => {
    const testTimeoutMs = 30;
    mockGetUserMedia(() => new Promise<MediaStream>(() => {})); // never settles
    const onResult = vi.fn();
    const user = userEvent.setup();
    render(<MicCheck onResult={onResult} timeoutMs={testTimeoutMs} />);

    await user.click(screen.getByRole('button', { name: 'Check microphone' }));

    const expectedSeconds = Math.round(testTimeoutMs / 1000);
    const line = await screen.findByText(
      new RegExp(`^FAILED: The browser did not respond within ${expectedSeconds} seconds\\.`)
    );
    expect(line).toHaveAttribute('role', 'status');
    expect(line).toHaveAttribute('aria-live', 'polite');
    expect(onResult).toHaveBeenCalledWith({ ok: false, reason: 'timeout', deviceLabel: null });
  });

  // Task W6, fix round 1: the "N seconds" wording is derived from the actual timeout in
  // effect (Math.round(timeoutMs / 1000)), not a second, hand-typed "8 seconds" -- so it
  // cannot drift from MIC_CHECK_TIMEOUT_MS. Asserted directly against a value that isn't 8,
  // to prove it's a real derivation and not a coincidence of the default.
  it('derives the timeout sentence\'s second count from the actual timeoutMs in effect', async () => {
    mockGetUserMedia(() => new Promise<MediaStream>(() => {})); // never settles
    const onResult = vi.fn();
    const user = userEvent.setup();
    render(<MicCheck onResult={onResult} timeoutMs={1500} />);

    await user.click(screen.getByRole('button', { name: 'Check microphone' }));

    const line = await screen.findByText(
      /^FAILED: The browser did not respond within 2 seconds\./,
      {},
      { timeout: 3000 }
    );
    expect(line).toHaveAttribute('role', 'status');
    expect(onResult).toHaveBeenCalledWith({ ok: false, reason: 'timeout', deviceLabel: null });
  }, 6000);

  it('shows CHECKING immediately on click, before the result arrives', async () => {
    let resolveStream!: (s: MediaStream) => void;
    mockGetUserMedia(() => new Promise<MediaStream>((resolve) => { resolveStream = resolve; }));
    const user = userEvent.setup();
    render(<MicCheck onResult={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Check microphone' }));
    const checkingLine = screen.getByText('CHECKING: asking your browser for the microphone.');
    expect(checkingLine).toBeInTheDocument();
    // Task W6, fix round 1: role="status"/aria-live="polite" on every state, not only FAILED.
    expect(checkingLine).toHaveAttribute('role', 'status');
    expect(checkingLine).toHaveAttribute('aria-live', 'polite');

    resolveStream(fakeStream().stream);
    const passedLine = await screen.findByText(/^PASSED:/);
    expect(passedLine).toBeInTheDocument();
    expect(passedLine).toHaveAttribute('role', 'status');
    expect(passedLine).toHaveAttribute('aria-live', 'polite');
  });

  // QA finding 2, root cause: the live site's own `navigator.permissions.query('microphone')`
  // returned `{}` -- no `.state` at all. The check must never gate on that: it proceeds to
  // getUserMedia and still yields a visible result either way.
  it('still yields a result when navigator.permissions is entirely absent', async () => {
    Object.defineProperty(navigator, 'permissions', { configurable: true, value: undefined });
    mockGetUserMedia(() => Promise.resolve(fakeStream().stream));
    const onResult = vi.fn();
    const user = userEvent.setup();
    render(<MicCheck onResult={onResult} />);

    await user.click(screen.getByRole('button', { name: 'Check microphone' }));

    expect(await screen.findByText('PASSED: Microphone ready.')).toBeInTheDocument();
    expect(onResult).toHaveBeenCalledWith({ ok: true, reason: 'passed', deviceLabel: null });
  });

  it('still yields a result when permissions.query resolves to an object with no .state', async () => {
    Object.defineProperty(navigator, 'permissions', {
      configurable: true,
      value: { query: vi.fn().mockResolvedValue({}) }
    });
    mockGetUserMedia(() => Promise.resolve(fakeStream().stream));
    const onResult = vi.fn();
    const user = userEvent.setup();
    render(<MicCheck onResult={onResult} />);

    await user.click(screen.getByRole('button', { name: 'Check microphone' }));

    expect(await screen.findByText('PASSED: Microphone ready.')).toBeInTheDocument();
    expect(onResult).toHaveBeenCalledWith({ ok: true, reason: 'passed', deviceLabel: null });
  });

  it('still yields a result when permissions.query itself throws', async () => {
    Object.defineProperty(navigator, 'permissions', {
      configurable: true,
      value: { query: vi.fn().mockRejectedValue(new Error('unsupported descriptor')) }
    });
    mockGetUserMedia(() => Promise.resolve(fakeStream().stream));
    const onResult = vi.fn();
    const user = userEvent.setup();
    render(<MicCheck onResult={onResult} />);

    await user.click(screen.getByRole('button', { name: 'Check microphone' }));

    expect(await screen.findByText('PASSED: Microphone ready.')).toBeInTheDocument();
    expect(onResult).toHaveBeenCalledWith({ ok: true, reason: 'passed', deviceLabel: null });
  });
});
