// packages/web/src/components/Masthead.tsx
// Task W5, fix round 2, requirement 1: a thin top bar on every screen -- wordmark left, a
// monospace status line right ("session <id> · Treasury desk · state <STATUS>"). Every part
// of the right side comes from data the screen already holds in client state: `sessionId`
// is Call.tsx's `session.session_id` (from `StartResult`, held before any call even starts)
// or Replay.tsx's chosen recording / the replay's own `ScreenState.session_id`; `status` is
// the same `agent_status` word `CallView` already renders inside the board. No clock (no
// elapsed-time value exists client-side to show one), no protocol field invented -- when
// `sessionId` is absent (Landing; Replay before a recording is picked) the whole meta line
// is omitted rather than padded with a placeholder.
//
// Task W5, fix round 3, item 4: a real session id (a UUID) made the meta line long enough to
// crowd the bar -- shows only the first 8 characters ("session 2e756eed") with the FULL id
// on a `title` attribute (a native browser tooltip on hover/focus), so the complete id is
// still available, just not printed in full on screen.
export type MastheadProps = {
  sessionId?: string | null;
  status?: string | null;
};

const SHORT_ID_LENGTH = 8;

/** Small dial glyph, inline SVG only (no external asset, no new dependency) -- optional per
 *  the brief, purely decorative next to the wordmark. */
function DialGlyph() {
  return (
    <svg className="masthead-dial" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <line x1="12" y1="12" x2="12" y2="4.5" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

export default function Masthead({ sessionId, status }: MastheadProps) {
  const restParts: string[] = [];
  if (sessionId) {
    restParts.push('Treasury desk');
    if (status) restParts.push(`state ${status}`);
  }

  return (
    <header className="masthead">
      <span className="masthead-wordmark">
        <DialGlyph />
        COUNTERSIGN
      </span>
      {sessionId && (
        <span className="masthead-meta">
          <span title={sessionId}>session {sessionId.slice(0, SHORT_ID_LENGTH)}</span>
          {restParts.length > 0 ? ` · ${restParts.join(' · ')}` : null}
        </span>
      )}
    </header>
  );
}
