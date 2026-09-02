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

    expect(await screen.findByText('PASSED — Microphone ready (USB Microphone).')).toBeInTheDocument();
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
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

    expect(await screen.findByText('PASSED — Microphone ready.')).toBeInTheDocument();
    expect(onResult).toHaveBeenCalledWith({ ok: true, reason: 'passed', deviceLabel: null });
  });

  it('shows a distinct sentence and reports failure for NotAllowedError (permission denied)', async () => {
    mockGetUserMedia(() => Promise.reject(new DOMException('denied', 'NotAllowedError')));
    const onResult = vi.fn();
    const user = userEvent.setup();
    render(<MicCheck onResult={onResult} />);

    await user.click(screen.getByRole('button', { name: 'Check microphone' }));

    const line = await screen.findByRole('alert');
    expect(line).toHaveTextContent(/^FAILED — Microphone blocked\./);
    expect(onResult).toHaveBeenCalledWith({ ok: false, reason: 'not-allowed', deviceLabel: null });
  });

  it('shows a distinct sentence and reports failure for NotFoundError (no device)', async () => {
    mockGetUserMedia(() => Promise.reject(new DOMException('no device', 'NotFoundError')));
    const onResult = vi.fn();
    const user = userEvent.setup();
    render(<MicCheck onResult={onResult} />);

    await user.click(screen.getByRole('button', { name: 'Check microphone' }));

    const line = await screen.findByRole('alert');
    expect(line).toHaveTextContent(/^FAILED — No microphone found\./);
    expect(onResult).toHaveBeenCalledWith({ ok: false, reason: 'not-found', deviceLabel: null });
  });

  it('shows a distinct sentence and reports failure for NotReadableError (device in use)', async () => {
    mockGetUserMedia(() => Promise.reject(new DOMException('busy', 'NotReadableError')));
    const onResult = vi.fn();
    const user = userEvent.setup();
    render(<MicCheck onResult={onResult} />);

    await user.click(screen.getByRole('button', { name: 'Check microphone' }));

    const line = await screen.findByRole('alert');
    expect(line).toHaveTextContent(/^FAILED — Microphone is in use by another app\./);
    expect(onResult).toHaveBeenCalledWith({ ok: false, reason: 'not-readable', deviceLabel: null });
  });

  it('shows a distinct sentence and reports failure for an unrecognised/generic error', async () => {
    mockGetUserMedia(() => Promise.reject(new Error('something odd')));
    const onResult = vi.fn();
    const user = userEvent.setup();
    render(<MicCheck onResult={onResult} />);

    await user.click(screen.getByRole('button', { name: 'Check microphone' }));

    const line = await screen.findByRole('alert');
    expect(line).toHaveTextContent(/^FAILED — Could not access the microphone\./);
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
    mockGetUserMedia(() => new Promise<MediaStream>(() => {})); // never settles
    const onResult = vi.fn();
    const user = userEvent.setup();
    render(<MicCheck onResult={onResult} timeoutMs={20} />);

    await user.click(screen.getByRole('button', { name: 'Check microphone' }));

    const line = await screen.findByRole('alert');
    expect(line).toHaveTextContent(/^FAILED — The browser did not respond within 8 seconds\./);
    expect(onResult).toHaveBeenCalledWith({ ok: false, reason: 'timeout', deviceLabel: null });
  });

  it('shows CHECKING immediately on click, before the result arrives', async () => {
    let resolveStream!: (s: MediaStream) => void;
    mockGetUserMedia(() => new Promise<MediaStream>((resolve) => { resolveStream = resolve; }));
    const user = userEvent.setup();
    render(<MicCheck onResult={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Check microphone' }));
    expect(screen.getByText('CHECKING — asking your browser for the microphone.')).toBeInTheDocument();

    resolveStream(fakeStream().stream);
    expect(await screen.findByText(/^PASSED —/)).toBeInTheDocument();
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

    expect(await screen.findByText('PASSED — Microphone ready.')).toBeInTheDocument();
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

    expect(await screen.findByText('PASSED — Microphone ready.')).toBeInTheDocument();
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

    expect(await screen.findByText('PASSED — Microphone ready.')).toBeInTheDocument();
    expect(onResult).toHaveBeenCalledWith({ ok: true, reason: 'passed', deviceLabel: null });
  });
});
