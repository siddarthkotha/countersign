import { useEffect, useState } from 'react';
import MicCheck, { type MicCheckReason, type MicCheckResultInfo } from '../components/MicCheck';
import RoleCards from '../components/RoleCards';
import RecentCalls from '../components/RecentCalls';
import Masthead from '../components/Masthead';
import { startSession, getHealth, type DemoPersona, type StartResult, type LiveCallsReason } from '../api';

type StartedSession = Extract<StartResult, { session_id: string }>;

export type LandingProps = {
  onWatch: () => void;
  onCall: (result: StartedSession, persona: DemoPersona | null) => void;
};

// Task W6 (QA walk 2026-09-02, finding 1): "Try it live (experimental)" used to grey out with zero
// explanation -- a mic-less stranger had no way to tell broken from intentional. This text
// always states the current condition in plain words, and doubles as both the button's
// `title` (hover) and its `aria-describedby` target (screen readers) -- same words either
// way, never a second, drifting copy of the same idea.
const MIC_HELPER_DEFAULT = 'Try it live (experimental) unlocks after Check microphone passes';
const MIC_HELPER_PASSED = 'Microphone ready';
const MIC_HELPER_ROLE_NEEDED = 'Pick a role card above to unlock Try it live (experimental)';
const MIC_HELPER_BY_REASON: Record<Exclude<MicCheckReason, 'passed'>, string> = {
  'not-allowed': "Microphone blocked. Allow it in the browser's address bar, then check again",
  'not-found': 'No microphone found. The recorded attack works without one',
  'not-readable': 'Microphone is in use by another app. Close it, then check again',
  timeout: 'Microphone check timed out. Try again, or use "Watch a recorded attack" instead',
  error: 'Microphone check failed. Use "Watch a recorded attack" instead'
};

function micHelperText(result: MicCheckResultInfo | null, roleSelected: boolean): string {
  if (!result) return MIC_HELPER_DEFAULT;
  if (result.ok && !roleSelected) return MIC_HELPER_ROLE_NEEDED;
  return result.ok ? MIC_HELPER_PASSED : MIC_HELPER_BY_REASON[result.reason];
}

// Judge review finding (2026-09-04), defect 1: the demo runs on Render's free tier, which
// sleeps after 15 minutes idle and can take up to about a minute to wake. Before this, the
// button just went disabled with unchanged text while `starting` was true -- a stranger had
// no way to tell "waking up" from "broken". This takes priority over the mic-result text
// (below) for exactly as long as `starting` is true, through the SAME helper element and
// button `title` that finding 1 (above) already wired up -- one sentence, both places, same
// as before.
const STARTING_HELPER = 'Waking the server. This can take up to a minute on the free plan';

function tryButtonHelperText(result: MicCheckResultInfo | null, starting: boolean, roleSelected: boolean): string {
  if (starting) return STARTING_HELPER;
  return micHelperText(result, roleSelected);
}

const REPLAY_ONLY_REASONS: Record<string, string> = {
  session_in_use: 'another judge is on the line',
  daily_cap: "today's call budget is used up",
  mint_rate: 'too many starts in a minute',
  kill_switch: 'live calls are paused',
  no_api_key: 'the voice service is not configured',
  // Reviewer finding (2026-09-11): "credits-exhausted replay mode" is a submission
  // requirement (CLAUDE.md abuse caps) -- these two plain-English phrases are shared
  // between the click-time failure path above (REPLAY_ONLY_REASONS) and the health-check
  // banner below (liveUnavailableBanner), one source of words either way.
  credits_exhausted: 'demo credits are exhausted',
  mint_error: 'the voice service is not responding right now'
};

function reasonToPlainWords(reason: string): string {
  return REPLAY_ONLY_REASONS[reason] ?? reason;
}

// Health-check-driven banner (GET /health's `live_calls`), shown before any click, not only
// after a failed one -- so Start Call is disabled and replay is the visible primary action
// from the moment the page loads. No detection language, no em-dashes, no jargon (LAW 1 /
// CLAUDE.md founder style rules).
function liveUnavailableBanner(reason: LiveCallsReason | null): string {
  const plainReason = reason ? reasonToPlainWords(reason) : 'live calls are paused right now';
  return `Live calls are paused: ${plainReason}. Replay mode below plays a real recorded call through the full interface.`;
}

export default function Landing({ onWatch, onCall }: LandingProps) {
  const [micResult, setMicResult] = useState<MicCheckResultInfo | null>(null);
  const [starting, setStarting] = useState(false);
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null);
  // Bug fix (2026-09-04): which role card the visitor picked, so the server can build the
  // matching simulated call telemetry instead of a hardcoded default. Landing.tsx had no
  // existing state tracking this -- added for this fix; null (no card picked) sends no
  // persona at all, and the server applies its own safe default.
  const [role, setRole] = useState<DemoPersona | null>(null);
  // Reviewer finding (2026-09-11): "credits-exhausted replay mode" is a submission
  // requirement (CLAUDE.md abuse caps). This reads GET /health's `live_calls` once on
  // mount so a stranger sees the plain-English banner and the disabled Start Call button
  // before ever clicking -- not only after a failed attempt (the `unavailableReason` path
  // above, which still exists for reasons `live_calls` doesn't cover, like session_in_use).
  // `null` here means either "still loading" or "the health check itself failed" -- both
  // fail OPEN (Start Call stays enabled) so a flaky health check never hides the demo.
  const [liveUnavailableReason, setLiveUnavailableReason] = useState<LiveCallsReason | null | undefined>(undefined);
  const micOk = micResult?.ok ?? false;
  const liveCallsDown = liveUnavailableReason !== undefined && liveUnavailableReason !== null;

  useEffect(() => {
    // Restore role card selection from sessionStorage on mount
    try {
      const stored = sessionStorage.getItem('countersign.role');
      if (stored && (stored === 'legitimate' || stored === 'attacker')) {
        setRole(stored);
      }
    } catch {
      // sessionStorage unavailable (private window, etc.) -- fail silently
    }

    let cancelled = false;
    getHealth().then((health) => {
      if (cancelled) return;
      setLiveUnavailableReason(health && !health.live_calls.available ? health.live_calls.reason : null);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function handleRoleSelect(selectedRole: DemoPersona | null) {
    setRole(selectedRole);
    // Persist role selection to sessionStorage
    try {
      if (selectedRole) {
        sessionStorage.setItem('countersign.role', selectedRole);
      } else {
        sessionStorage.removeItem('countersign.role');
      }
    } catch {
      // sessionStorage unavailable -- fail silently
    }
  }

  async function handleTry() {
    setStarting(true);
    setUnavailableReason(null);
    const result = await startSession(role);
    setStarting(false);
    if ('replay_only' in result) {
      setUnavailableReason(reasonToPlainWords(result.reason));
      return;
    }
    onCall(result, role);
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

      {/* Founder decision 2026-09-11 9:25 PM: the business-value stat that grounds this whole
          product in a real, sourced number. Reuses `.replay-note` (Replay.tsx's own helper
          line) so this is the same muted, boxless, colour-free style already on the page --
          no new class, no new colour (founder is colour blind; meaning is never colour-only). */}
      <p className="replay-note">
        In 2025 the FBI logged $3.05 billion in losses to business email compromise, the fraud family where an
        impersonator talks a payments desk into sending a wire.{' '}
        <a
          href="https://www.ic3.gov/AnnualReport/Reports/2025_IC3Report.pdf"
          target="_blank"
          rel="noopener noreferrer"
        >
          Source: FBI IC3 2025 report
        </a>
      </p>

      <p>
        You will speak with a treasury desk checkpoint. It verifies the request, not the voice. Nothing you say can
        release money; a verified request is only staged for a second human signature.
      </p>

      {/* Reviewer finding (2026-09-11): "credits-exhausted replay mode" is a submission
          requirement (CLAUDE.md abuse caps) -- when GET /health says live calls are down,
          this renders BEFORE the button row, so replay reads as the primary action a
          stranger sees first, not a fallback discovered after a broken click. */}
      {liveCallsDown && (
        <p className="banner" role="alert">{liveUnavailableBanner(liveUnavailableReason ?? null)}</p>
      )}

      <div>
        <button type="button" className="primary" onClick={onWatch}>
          Watch a recorded attack
        </button>
        {!liveCallsDown && (
          <button
            type="button"
            onClick={handleTry}
            disabled={!micOk || starting || !role}
            aria-describedby="try-break-helper"
            title={tryButtonHelperText(micResult, starting, !!role)}
          >
            Try it live (experimental)
          </button>
        )}
      </div>

      {/* Task W6, finding 1: always-visible, plain-words statement of why the button above
          is (or isn't) locked -- same words as the button's own `title`, referenced by
          `aria-describedby` so assistive tech gets it too, not just a hover tooltip.
          Judge review finding (2026-09-04), defect 1: while `starting` is true this shows the
          cold-start sentence instead (see `tryButtonHelperText` above). Hidden along with the
          button itself while live calls are down -- the banner above already explains why. */}
      {!liveCallsDown && <p id="try-break-helper">{tryButtonHelperText(micResult, starting, !!role)}</p>}

      {unavailableReason && (
        <p className="banner" role="alert">Live calls are unavailable right now: {unavailableReason}</p>
      )}

      <MicCheck onResult={setMicResult} />

      <RoleCards selected={role} onSelect={handleRoleSelect} />

      <p className="replay-note">
        To see the third outcome, escalated to a callback, open "Watch a recorded attack" and choose the recorded
        escalated call.
      </p>

      <RecentCalls />

      <p>Desktop Chrome recommended. Every system here is simulated; nothing moves real money.</p>
    </main>
  );
}
