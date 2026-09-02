// packages/web/src/components/SimulatedBanner.tsx
// Design law: the "simulated" banner is always on. CallView.tsx renders THIS component once
// a ScreenState exists (Task R1: it used to keep its own inline copy of the same text --
// one truth, two render sites, an easy way for the wording to drift. Now there is exactly
// one copy). Call.tsx renders it directly for every moment CallView is not yet on screen
// (before Start Call, and while a mic failure banner is up), so the simulated banner never
// has a gap.
export default function SimulatedBanner() {
  return <p className="banner">Every system here is simulated.</p>;
}
