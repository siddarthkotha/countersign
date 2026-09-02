// packages/web/src/components/SimulatedBanner.tsx
// Design law: the "simulated" banner is always on. CallView.tsx (landed W2) already renders
// its own copy of this exact text once a ScreenState exists; this component is what Call.tsx
// shows for every moment CallView is not yet on screen (before Start Call, and while a mic
// failure banner is up), so the simulated banner never has a gap. Kept byte-for-byte
// identical to CallView.tsx's inline banner text on purpose -- one truth, two render sites.
export default function SimulatedBanner() {
  return <p className="banner">Every system here is simulated.</p>;
}
