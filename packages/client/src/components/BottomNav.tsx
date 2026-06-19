import { useState, useRef, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { NavContent } from '../views/NavContent.js';
import { getNavActions } from '../lib/bottomNavActions.js';
import { lockBodyScroll, unlockBodyScroll } from '../lib/bodyScrollLock.js';

/**
 * Mobile bottom nav — replaces the left-drawer container on mobile / tablet-portrait.
 *
 * Collapsed: a pinned action-slot row (registry-driven, v1 = New note + Search).
 * Expanded: a bottom sheet containing the full NavContent (notebook switcher +
 *           new notebook + Trash + Settings/account).
 *
 * Expand: tap the handle OR drag up.
 * Collapse: select a notebook (NavContent onNavigate), swipe down, or tap the scrim.
 * No edge-swipe dependency (spec AC-5).
 *
 * Safe-area aware: respects env(safe-area-inset-bottom) so the bar clears the
 * iOS home indicator on notched devices.
 *
 * Scroll-lock: body scroll is locked while the sheet is open using the position:fixed
 * technique — the only approach that works in mobile Safari (overflow:hidden is a no-op
 * there). A non-passive touchmove listener on the bar also prevents body scroll during
 * the drag gesture on the collapsed bar, before the sheet opens.
 */
export function BottomNav() {
  const [expanded, setExpanded] = useState(false);
  const navigate = useNavigate();
  const touchStartY = useRef<number | null>(null);
  const navRef = useRef<HTMLDivElement>(null);
  // iOS keyboard anchor: focused synchronously within the tap gesture so iOS raises the
  // keyboard before any async hop (IDB write + route change). Stays mounted in BottomNav
  // (outside Routes) so focus is preserved across route transitions until PM inherits it.
  const kbAnchorRef = useRef<HTMLInputElement>(null);

  const collapse = useCallback(() => setExpanded(false), []);

  // Lock body scroll while the sheet is open (position:fixed — iOS-safe).
  useEffect(() => {
    if (expanded) {
      lockBodyScroll();
    } else {
      unlockBodyScroll();
    }
  }, [expanded]);

  // Safety net: always unlock on unmount (e.g. route change while sheet is open).
  useEffect(() => {
    return () => { unlockBodyScroll(); };
  }, []);

  // Prevent body scroll during the drag gesture on the collapsed bar.
  // Must be a non-passive listener — React's synthetic onTouchMove is passive and
  // e.preventDefault() is silently ignored in mobile Safari / Chrome.
  // Only active when collapsed: when expanded the body is already position:fixed,
  // and the inner sheet must be free to scroll (no preventDefault on its touches).
  useEffect(() => {
    if (expanded) return;
    const el = navRef.current;
    if (!el) return;
    const prevent = (e: TouchEvent) => {
      if (touchStartY.current !== null) e.preventDefault();
    };
    el.addEventListener('touchmove', prevent, { passive: false });
    return () => el.removeEventListener('touchmove', prevent);
  }, [expanded]);

  // Drag-up / drag-down gesture
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    touchStartY.current = e.touches[0]!.clientY;
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (touchStartY.current === null) return;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const dy = e.touches[0]!.clientY - touchStartY.current;
    if (!expanded && dy < -30) { setExpanded(true); touchStartY.current = null; }
    if (expanded  && dy >  30) { setExpanded(false); touchStartY.current = null; }
  }, [expanded]);

  const handleTouchEnd = useCallback(() => {
    touchStartY.current = null;
  }, []);

  const handleAction = useCallback((id: string) => {
    if (id === 'new-note') {
      // Focus the keyboard anchor synchronously (within the tap gesture) so iOS raises the
      // keyboard before the async note-create flow runs. PM inherits the open keyboard when
      // the editor mounts and calls view.focus().
      kbAnchorRef.current?.focus();
      navigate('/new');
      return;
    }
    if (id === 'search')   { navigate('/search'); return; }
    // Future: other registered action ids dispatched here.
  }, [navigate]);

  const actions = getNavActions();

  return (
    <>
      {/* iOS keyboard anchor — kept out of the tab order and screen readers.
          font-size:16px prevents iOS from zooming on focus. */}
      <input
        ref={kbAnchorRef}
        className="bottom-nav__kb-anchor"
        tabIndex={-1}
        aria-hidden="true"
      />

      {expanded && (
        <div
          className="bottom-nav__scrim"
          aria-hidden
          onClick={collapse}
        />
      )}

      <div
        ref={navRef}
        className={`bottom-nav${expanded ? ' bottom-nav--expanded' : ''}`}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        <button
          className="bottom-nav__handle"
          aria-label={expanded ? 'Collapse navigation' : 'Expand navigation'}
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          <span className="bottom-nav__handle-bar" />
        </button>

        {expanded ? (
          <div className="bottom-nav__sheet">
            <NavContent onNavigate={collapse} />
          </div>
        ) : (
          <div className="bottom-nav__actions" role="toolbar" aria-label="Navigation actions">
            {actions.map((action) => (
              <button
                key={action.id}
                className="bottom-nav__action"
                aria-label={action.ariaLabel}
                onClick={() => handleAction(action.id)}
              >
                {action.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
