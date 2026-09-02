// packages/web/src/components/CallControls.tsx
// Structure only -- no look (W5 picks the visual language). Start Call / End Call / Start
// over buttons, a cap countdown ("call ends in m:ss"), and a link-state chip rendered as
// plain text (LIVE / RECONNECTING / ENDED) -- never colour-only, per design law.
import { useEffect, useState } from 'react';

export type LinkState = 'idle' | 'live' | 'reconnecting' | 'ended';

export type CallControlsProps = {
  link: LinkState;
  capSeconds: number;
  onStart: () => void;
  onEnd: () => void;
  onStartOver: () => void;
};

function formatCountdown(totalSeconds: number): string {
  const clamped = Math.max(0, totalSeconds);
  const minutes = Math.floor(clamped / 60);
  const seconds = clamped % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export default function CallControls({ link, capSeconds, onStart, onEnd, onStartOver }: CallControlsProps) {
  const [remaining, setRemaining] = useState(capSeconds);

  useEffect(() => {
    if (link !== 'live') return undefined;
    setRemaining(capSeconds);
    const interval = setInterval(() => {
      setRemaining((r) => Math.max(0, r - 1));
    }, 1000);
    return () => clearInterval(interval);
  }, [link, capSeconds]);

  return (
    <div className="call-controls">
      {link !== 'idle' && <span className="link-chip">{link.toUpperCase()}</span>}

      {link === 'idle' && (
        <button type="button" onClick={onStart}>
          Start Call
        </button>
      )}

      {(link === 'live' || link === 'reconnecting') && (
        <>
          <span className="cap-countdown">call ends in {formatCountdown(remaining)}</span>
          <button type="button" onClick={onEnd}>
            End Call
          </button>
        </>
      )}

      {link === 'ended' && (
        <button type="button" onClick={onStartOver}>
          Start over
        </button>
      )}
    </div>
  );
}
