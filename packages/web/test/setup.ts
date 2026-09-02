import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// jsdom does not implement Element.scrollIntoView (packages/web/src/components/CallView.tsx,
// Fix round 1: the transcript auto-scroll effect calls it on every render with a transcript
// line) -- without this no-op default, every test that renders CallView throws. Individual
// tests can still `vi.spyOn(Element.prototype, 'scrollIntoView')` over this to assert calls.
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoViewNoop() {
    // No layout in jsdom -- nothing to scroll. Real browsers get the real implementation.
  };
}

afterEach(() => {
  cleanup();
});
