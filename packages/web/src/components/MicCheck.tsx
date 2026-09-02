import { useState } from 'react';

export type MicCheckProps = {
  onResult: (ok: boolean) => void;
};

type Status = 'idle' | 'checking' | 'ready' | 'blocked';

export default function MicCheck({ onResult }: MicCheckProps) {
  const [status, setStatus] = useState<Status>('idle');

  async function check() {
    setStatus('checking');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      stream.getTracks().forEach((track) => track.stop());
      setStatus('ready');
      onResult(true);
    } catch {
      setStatus('blocked');
      onResult(false);
    }
  }

  return (
    <div>
      <button type="button" onClick={check}>
        Check microphone
      </button>
      {status === 'ready' && <p>Microphone ready</p>}
      {status === 'blocked' && (
        <p className="banner" role="alert">
          Microphone blocked. Use &apos;Watch a recorded attack&apos; instead.
        </p>
      )}
    </div>
  );
}
