import { useEffect, useState } from 'react';

// ≥769px = desktop / tablet-landscape (the persistent 3-region shell). ≤768px = mobile /
// tablet-portrait (single-column push + bottom-sheet nav). Matches the existing styles.css
// `@media (max-width: 768px)` mobile breakpoint so CSS and JS agree on the device class.
const DESKTOP_QUERY = '(min-width: 769px)';

/**
 * True on desktop / tablet-landscape (Lane 2 Pass B). Drives the shell's structural fork: the
 * persistent nav-pane | resizable-list | note master-detail (desktop) vs the single-column pushed
 * sub-screen + bottom-sheet nav (mobile). SSR-safe default (false); re-evaluates on resize/rotate.
 */
export function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia(DESKTOP_QUERY).matches,
  );
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(DESKTOP_QUERY);
    const onChange = () => setIsDesktop(mql.matches);
    mql.addEventListener('change', onChange);
    setIsDesktop(mql.matches); // sync in case it changed between initial state and effect
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return isDesktop;
}
