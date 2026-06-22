import { useEffect, useState } from 'react';

/**
 * Height (px) the on-screen keyboard currently overlaps from the layout-viewport bottom — 0 when the
 * keyboard is closed. Driven by window.visualViewport: on iOS the layout viewport (window.innerHeight)
 * stays fixed when the keyboard opens, but the VISUAL viewport shrinks, so the overlap is
 * innerHeight − (visualViewport.height + visualViewport.offsetTop). offsetTop folds in any scroll of the
 * visual viewport so the value is correct mid-scroll too.
 *
 * Used to float the mobile editor bar just above the keyboard (task #66). NOTE: this does NOT remove
 * Apple's native ^⌄✓ accessory bar (not web-removable — see [[ios-keyboard-accessory-bar-not-web-removable]]);
 * our bar sits ABOVE Apple's, so it honestly adds one row on top of (Apple's bar + keyboard).
 *
 * SSR-safe + degrades gracefully: if visualViewport is unavailable the inset stays 0 and the bar keeps
 * its layout-bottom position.
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : undefined;
    if (!vv) return;
    const update = () => {
      const overlap = window.innerHeight - (vv.height + vv.offsetTop);
      // Clamp tiny sub-pixel jitter (and negative values when the layout/visual viewports momentarily
      // disagree during rotation) to 0 so we don't flicker the bar a pixel off the bottom.
      setInset(overlap > 1 ? overlap : 0);
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);

  return inset;
}
