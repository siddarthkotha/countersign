// packages/web/src/components/MicCheck.tsx
// Task W6 (QA walk 2026-09-02, finding 2): "Check microphone" used to leave the page silent
// on every path but the happy one -- a stranger with no mic, or a browser that denies the
// prompt, saw nothing at all. Every click now produces exactly one visible result line
// within that same click: CHECKING while the browser is asked, then PASSED or FAILED with a
// plain-word reason -- never left empty. The result WORD always leads the sentence (colour
// is decoration only, never the sole carrier -- brief requirement D).
import { useState } from 'react';

/** `'passed'` is the only success reason; every failure reason gets its own plain sentence
 *  below (QA finding 2's explicit list: NotAllowedError, NotFoundError, NotReadableError, a
 *  generic error, and an 8s timeout -- each distinct, never a single catch-all string). */
export type MicCheckReason = 'passed' | 'not-allowed' | 'not-found' | 'not-readable' | 'timeout' | 'error';

/** Discriminated on `ok` so a caller (Landing.tsx) can narrow `reason` to the failure set
 *  without a cast -- `deviceLabel` is only ever meaningful (and only ever present) on the
 *  success branch. */
export type MicCheckResultInfo =
  | { ok: true; reason: 'passed'; deviceLabel: string | null }
  | { ok: false; reason: Exclude<MicCheckReason, 'passed'>; deviceLabel: null };

export type MicCheckProps = {
  onResult: (result: MicCheckResultInfo) => void;
  /** Test-only override for the 8s wait below (real timers, no fake-timer/act juggling in
   *  test/MicCheck.test.tsx). Production code never passes this -- it always gets the real
   *  `MIC_CHECK_TIMEOUT_MS`. */
  timeoutMs?: number;
};

type Line = { kind: 'checking' | 'passed' | 'failed'; text: string };

/** QA finding 2: a hung permission prompt (or a browser that never resolves the promise)
 *  must not leave the button silent forever -- 8 seconds, then a specific timeout sentence. */
export const MIC_CHECK_TIMEOUT_MS = 8000;

const FAILURE_SENTENCES: Record<Exclude<MicCheckReason, 'passed'>, string> = {
  'not-allowed': "FAILED — Microphone blocked. Allow it in the browser's address bar, then check again.",
  'not-found': 'FAILED — No microphone found. The recorded attack works without one.',
  'not-readable': 'FAILED — Microphone is in use by another app. Close it, then check again.',
  timeout: 'FAILED — The browser did not respond within 8 seconds. Check again, or use "Watch a recorded attack".',
  error: 'FAILED — Could not access the microphone. Use "Watch a recorded attack" instead.',
};

class MicCheckTimeoutError extends Error {
  constructor() {
    super('mic-check-timeout');
    this.name = 'MicCheckTimeoutError';
  }
}

function classifyGetUserMediaError(err: unknown): Exclude<MicCheckReason, 'passed' | 'timeout'> {
  const name = err instanceof DOMException ? err.name : (err as { name?: unknown } | null | undefined)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') return 'not-allowed';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'not-found';
  if (name === 'NotReadableError' || name === 'TrackStartError') return 'not-readable';
  return 'error';
}

/** Best-effort, advisory-only permission read -- QA finding 2 caught the live site's own
 *  `navigator.permissions.query('microphone')` returning `{}` (no `.state` at all). Whatever
 *  comes back (or if the whole API is absent, or the call throws), it is never used to
 *  change control flow: this always falls through to `getUserMedia`, the one call that can
 *  actually answer "does this work" -- so an unsupported/odd permissions implementation can
 *  never leave the check silently stuck. */
async function peekPermissionState(): Promise<void> {
  try {
    const permissionsApi = (
      navigator as unknown as { permissions?: { query?: (opts: { name: string }) => Promise<{ state?: string }> } }
    ).permissions;
    if (!permissionsApi || typeof permissionsApi.query !== 'function') return;
    const status = await permissionsApi.query({ name: 'microphone' });
    void status?.state; // read defensively, never branched on
  } catch {
    // Unsupported, or the descriptor throws in this browser -- unknown, same as absent.
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new MicCheckTimeoutError()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

export default function MicCheck({ onResult, timeoutMs }: MicCheckProps) {
  const [line, setLine] = useState<Line | null>(null);

  async function check() {
    setLine({ kind: 'checking', text: 'CHECKING — asking your browser for the microphone.' });

    await peekPermissionState();

    try {
      const stream = await withTimeout(
        navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        }),
        timeoutMs ?? MIC_CHECK_TIMEOUT_MS
      );
      const tracks = stream.getTracks();
      const audioTrack = typeof stream.getAudioTracks === 'function' ? stream.getAudioTracks()[0] : tracks[0];
      const deviceLabel = audioTrack?.label || null;
      tracks.forEach((track) => track.stop());
      setLine({
        kind: 'passed',
        text: deviceLabel ? `PASSED — Microphone ready (${deviceLabel}).` : 'PASSED — Microphone ready.'
      });
      onResult({ ok: true, reason: 'passed', deviceLabel });
    } catch (err) {
      const reason = err instanceof MicCheckTimeoutError ? 'timeout' : classifyGetUserMediaError(err);
      setLine({ kind: 'failed', text: FAILURE_SENTENCES[reason] });
      onResult({ ok: false, reason, deviceLabel: null });
    }
  }

  return (
    <div>
      <button type="button" onClick={check}>
        Check microphone
      </button>
      {line && line.kind === 'failed' && (
        <p className="banner" role="alert">
          {line.text}
        </p>
      )}
      {line && line.kind !== 'failed' && <p>{line.text}</p>}
    </div>
  );
}
