import type { DemoPersona } from '../api';
import RoleFacts from './RoleFacts';

export type RoleCardsProps = {
  selected: DemoPersona | null;
  onSelect: (persona: DemoPersona) => void;
};

// Bug fix (2026-09-04): these cards used to be inert text -- clicking one changed nothing,
// so the server always built a live call's simulated telemetry from a hardcoded default.
// Same markup/classes/copy as before; only an onClick added to each EXISTING <section> so a
// visitor's choice of script is readable by Landing.tsx and passed to the server as a named
// persona. No visual design change: no new elements, no colours, no layout.
/** Accessibility correction (2026-09-04): giving a plain <section> an onClick made the cards
 *  mouse-only and left `aria-pressed` on an element with no button role, which is invalid.
 *  These cards now carry a real button role, are focusable, and respond to Enter and Space
 *  the way a button does. No visual change: same tags, classes, layout and copy. */
function activateOnKey(e: React.KeyboardEvent, run: () => void): void {
  if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
    e.preventDefault();
    run();
  }
}

export default function RoleCards({ selected, onSelect }: RoleCardsProps) {
  return (
    <div className="role-cards">
      <section
        className="role-card"
        role="button"
        tabIndex={0}
        onClick={() => onSelect('legitimate')}
        onKeyDown={(e) => activateOnKey(e, () => onSelect('legitimate'))}
        aria-pressed={selected === 'legitimate'}
      >
        <h2>Dana Whitfield, treasury manager{selected === 'legitimate' ? ' (chosen)' : ''}</h2>
        <p>Ask to move the scheduled Meridian Supply payment earlier than Friday. Use your own words.</p>
        <RoleFacts persona="legitimate" />
      </section>
      <section
        className="role-card"
        role="button"
        tabIndex={0}
        onClick={() => onSelect('attacker')}
        onKeyDown={(e) => activateOnKey(e, () => onSelect('attacker'))}
        aria-pressed={selected === 'attacker'}
      >
        <h2>A caller claiming to be the CEO{selected === 'attacker' ? ' (chosen)' : ''}</h2>
        <p>Ask for a confidential escrow transfer for an acquisition. Improvise. The system will ask you questions.</p>
        <RoleFacts persona="attacker" />
      </section>
    </div>
  );
}
