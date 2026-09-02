import { useState } from 'react';
import MicCheck, { type MicCheckReason, type MicCheckResultInfo } from '../components/MicCheck';
import RoleCards from '../components/RoleCards';
import Masthead from '../components/Masthead';
import { startSession, type StartResult } from '../api';

type StartedSession = Extract<StartResult, { session_id: string }>;

export type LandingProps = {
  onWatch: () => void;
  onCall: (result: StartedSession) => void;
};

// Task W6 (QA walk 2026-09-02, finding 1): "Try to break it" used to grey out with zero
// explanation -- a mic-less stranger had no way to tell broken from intentional. This text
// always states the current condition in plain words, and doubles as both the button's
// `title` (hover) and its `aria-describedby` target (screen readers) -- same words either
// way, never a second, drifting copy of the same idea.
const MIC_HELPER_DEFAULT = 'Try to break it unlocks after Check microphone passes';
const MIC_HELPER_PASSED = 'Microphone ready';
const MIC_HELPER_BY_REASON: Record<Exclude<MicCheckReason, 'passed'>, string> = {
  'not-allowed': "Microphone blocked — allow it in the browser's address bar, then check again",
  'not-found': 'No microphone found — the recorded attack works without one',
  'not-readable': 'Microphone is in use by another app — close it, then check again',
  timeout: 'Microphone check timed out — try again, or use "Watch a recorded attack" instead',
  error: 'Microphone check failed — use "Watch a recorded attack" instead'
};

function micHelperText(result: MicCheckResultInfo | null): string {
  if (!result) return MIC_HELPER_DEFAULT;
  return result.ok ? MIC_HELPER_PASSED : MIC_HELPER_BY_REASON[result.reason];
}

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
  const [micResult, setMicResult] = useState<MicCheckResultInfo | null>(null);
  const [starting, setStarting] = useState(false);
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null);
  const micOk = micResult?.ok ?? false;

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

      {/* Task W5, fix round 3, item 5: the masthead already says "COUNTERSIGN" -- the big h1
          used to say it again. The tagline is now the h1 (same words as before, just a
          bigger element); the old duplicate tagline paragraph is gone, not the tagline
          itself -- a removed duplicate, not removed content. */}
      <h1>A call can request a privileged action. It can never authorize one.</h1>

      <p>
        You will speak with a treasury desk checkpoint. It verifies the request, not the voice. Nothing you say can
        release money; a verified request is only staged for a second human signature.
      </p>

      <div>
        <button type="button" className="primary" onClick={onWatch}>
          Watch a recorded attack
        </button>
        <button
          type="button"
          onClick={handleTry}
          disabled={!micOk || starting}
          aria-describedby="try-break-helper"
          title={micHelperText(micResult)}
        >
          Try to break it
        </button>
      </div>

      {/* Task W6, finding 1: always-visible, plain-words statement of why the button above
          is (or isn't) locked -- same words as the button's own `title`, referenced by
          `aria-describedby` so assistive tech gets it too, not just a hover tooltip. */}
      <p id="try-break-helper">{micHelperText(micResult)}</p>

      {unavailableReason && (
        <p className="banner" role="alert">Live calls are unavailable right now: {unavailableReason}</p>
      )}

      <MicCheck onResult={setMicResult} />

      <RoleCards />

      <p>Desktop Chrome recommended. Every system here is simulated; nothing moves real money.</p>
    </main>
  );
}
