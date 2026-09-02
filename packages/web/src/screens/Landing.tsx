import { useState } from 'react';
import MicCheck from '../components/MicCheck';
import RoleCards from '../components/RoleCards';
import Masthead from '../components/Masthead';
import { startSession, type StartResult } from '../api';

type StartedSession = Extract<StartResult, { session_id: string }>;

export type LandingProps = {
  onWatch: () => void;
  onCall: (result: StartedSession) => void;
};

const REPLAY_ONLY_REASONS: Record<string, string> = {
  session_in_use: 'another judge is on the line',
  daily_cap: "today's call budget is used up",
  mint_rate: 'too many starts in a minute',
  kill_switch: 'live calls are paused',
  no_api_key: 'the voice service is not configured'
};

function reasonToPlainWords(reason: string): string {
  return REPLAY_ONLY_REASONS[reason] ?? reason;
}

export default function Landing({ onWatch, onCall }: LandingProps) {
  const [micOk, setMicOk] = useState(false);
  const [starting, setStarting] = useState(false);
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null);

  async function handleTry() {
    setStarting(true);
    setUnavailableReason(null);
    const result = await startSession();
    setStarting(false);
    if ('replay_only' in result) {
      setUnavailableReason(reasonToPlainWords(result.reason));
      return;
    }
    onCall(result);
  }

  return (
    <main>
      {/* Task W5, fix round 2, requirement 4/1: Landing has no session yet, so the masthead
          renders with no props -- wordmark only, no meta line (there's nothing in client
          state to build "session <id> · Treasury desk · state <STATUS>" from). */}
      <Masthead />

      <h1>Countersign</h1>
      <p>A call can request a privileged action. It can never authorize one.</p>

      <p>
        You will speak with a treasury desk checkpoint. It verifies the request, not the voice. Nothing you say can
        release money; a verified request is only staged for a second human signature.
      </p>

      <div>
        <button type="button" className="primary" onClick={onWatch}>
          Watch a recorded attack
        </button>
        <button type="button" onClick={handleTry} disabled={!micOk || starting}>
          Try to break it
        </button>
      </div>

      {unavailableReason && (
        <p className="banner" role="alert">Live calls are unavailable right now: {unavailableReason}</p>
      )}

      <MicCheck onResult={setMicOk} />

      <RoleCards />

      <p>Desktop Chrome recommended. Every system here is simulated; nothing moves real money.</p>
    </main>
  );
}
