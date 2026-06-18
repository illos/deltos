import { useState, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { NavContent } from '../views/NavContent.js';
import { getNavActions } from '../lib/bottomNavActions.js';

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
 */
export function BottomNav() {
  const [expanded, setExpanded] = useState(false);
  const navigate = useNavigate();
  const touchStartY = useRef<number | null>(null);

  const collapse = useCallback(() => setExpanded(false), []);

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
    if (id === 'new-note') { navigate('/new'); return; }
    if (id === 'search')   { navigate('/search'); return; }
    // Future: other registered action ids dispatched here.
  }, [navigate]);

  const actions = getNavActions();

  return (
    <>
      {expanded && (
        <div
          className="bottom-nav__scrim"
          aria-hidden
          onClick={collapse}
        />
      )}

      <div
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
