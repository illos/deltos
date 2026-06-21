import { useState, useRef, useCallback, useEffect, useLayoutEffect } from 'react';
import type { ComponentType } from 'react';
import { useNavigate } from 'react-router-dom';
import { NavContent } from '../views/NavContent.js';
import { getNavActions } from '../lib/bottomNavActions.js';
import { lockBodyScroll, unlockBodyScroll } from '../lib/bodyScrollLock.js';
import { useDragAxis } from '../lib/useDragAxis.js';
import { ComposeNew, Undo, Redo, Search } from '../icons/index.js';
import type { IconProps } from '../icons/index.js';

// Action-slot icons, mapped by registry id (the registry stays data-only). Packet §4: New (compose,
// --accent) · Undo · Redo · Search (--secondary), icon over a Plex Mono 10px label.
const ACTION_ICONS: Record<string, ComponentType<IconProps>> = {
  'new-note': ComposeNew,
  undo: Undo,
  redo: Redo,
  search: Search,
};

/**
 * Mobile bottom nav — replaces the left-drawer container on mobile / tablet-portrait.
 *
 * Collapsed: a pinned action-slot row (registry-driven, v1 = New note + Search).
 * Expanded: a bottom sheet containing the full NavContent (notebook switcher +
 *           new notebook + Trash + Settings/account).
 *
 * Expand: tap handle, drag up.
 * Collapse: tap handle, tap scrim, drag down (when sheet is scrolled to top).
 * No edge-swipe dependency (spec AC-5).
 *
 * Gesture engine: useDragAxis (Y axis), GPU translateY only — no max-height animation.
 * The sheet is always 75vh tall; translateY parks it off-screen when collapsed so only
 * the bar (handle + actions) is visible. 1:1 finger-follow + velocity-based snap.
 *
 * Inner-scroll-vs-dismiss: a downward drag only collapses when the sheet is at scrollTop=0;
 * otherwise the drag scrolls the sheet content.
 *
 * Safe-area aware: .bottom-nav__bar carries env(safe-area-inset-bottom) padding so the
 * action row clears the iOS home indicator on notched devices.
 */
export function BottomNav() {
  const [expanded, setExpanded] = useState(false);
  const navigate = useNavigate();

  const navRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const kbAnchorRef = useRef<HTMLInputElement>(null);

  // closedY = translateY that parks the nav so only the bar is visible.
  // Measured on mount (collapsed); stable thereafter.
  const closedYRef = useRef(0);

  // Snap helpers — imperative, no re-render
  const snapToY = useCallback((target: number, onDone?: () => void) => {
    const el = navRef.current;
    if (!el) { onDone?.(); return; }
    el.classList.add('bottom-nav--snapping');
    el.style.transform = `translateY(${target}px)`;
    const cleanup = () => {
      el.classList.remove('bottom-nav--snapping');
      onDone?.();
    };
    el.addEventListener('transitionend', cleanup, { once: true });
    setTimeout(cleanup, 320);
  }, []);

  const openSheet = useCallback(() => {
    setExpanded((was) => {
      if (!was) {
        // Sheet just mounted — animate into view on next frame
        requestAnimationFrame(() => snapToY(0));
      } else {
        snapToY(0);
      }
      return true;
    });
  }, [snapToY]);

  const closeSheet = useCallback((immediate?: boolean) => {
    if (immediate) {
      // Click-based collapse: swap content immediately so tests see the change at once
      setExpanded(false);
      snapToY(closedYRef.current);
    } else {
      // Drag-based collapse: keep sheet visible during animation, swap after
      snapToY(closedYRef.current, () => setExpanded(false));
    }
  }, [snapToY]);

  // Measure closed offset once on mount (starts collapsed, so offsetHeight ≈ bar only)
  useLayoutEffect(() => {
    const nav = navRef.current;
    const bar = barRef.current;
    if (!nav || !bar) return;
    const navH = nav.offsetHeight;
    const barH = bar.offsetHeight;
    closedYRef.current = Math.max(0, navH - barH);
    nav.style.transform = `translateY(${closedYRef.current}px)`;
  }, []);

  // Body scroll lock
  useEffect(() => {
    if (expanded) lockBodyScroll(); else unlockBodyScroll();
  }, [expanded]);

  useEffect(() => () => { unlockBodyScroll(); }, []);

  // Drag gesture (Y axis)
  const dragHandlers = useDragAxis({
    axis: 'y',
    getBase: () => expanded ? 0 : closedYRef.current,
    min: 0,
    ...(closedYRef.current > 0 ? { max: closedYRef.current } : {}),
    onMove: (pos) => {
      if (navRef.current) navRef.current.style.transform = `translateY(${pos}px)`;
    },
    onSettle: (pos, velocity) => {
      const closedY = closedYRef.current;
      const VELOCITY_THRESHOLD = 0.3; // px/ms
      let target: number;
      if (Math.abs(velocity) > VELOCITY_THRESHOLD) {
        target = velocity > 0 ? closedY : 0;
      } else {
        target = pos < closedY / 2 ? 0 : closedY;
      }
      if (target === 0) openSheet(); else closeSheet();
    },
    onLockConfirm: (dir) => {
      // Don't take control of downward drags when the sheet is scrolled down
      if (dir === 1 && sheetRef.current && sheetRef.current.scrollTop > 0) return false;
      return true;
    },
  });

  const handleAction = useCallback((id: string) => {
    if (id === 'new-note') {
      kbAnchorRef.current?.focus();
      navigate('/new');
      return;
    }
    if (id === 'search') {
      kbAnchorRef.current?.focus();
      navigate('/search');
      return;
    }
    // 'undo' / 'redo' are present in the §4 action row (mockup) but INERT for the static-vibe phase —
    // wiring them to the editor's undo/redo lands with the editor work (Deploy 3). No-op for now.
  }, [navigate]);

  const actions = getNavActions();

  return (
    <>
      {/* iOS keyboard anchor — off tab-order, prevents zoom on focus */}
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
          onClick={() => closeSheet(true)}
        />
      )}

      <div
        ref={navRef}
        className={`bottom-nav${expanded ? ' bottom-nav--expanded' : ''}`}
        {...dragHandlers}
      >
        {/* Bar: always rendered at top of the nav element; visible when collapsed. */}
        <div ref={barRef} className="bottom-nav__bar">
          <button
            className="bottom-nav__handle"
            aria-label={expanded ? 'Collapse navigation' : 'Expand navigation'}
            aria-expanded={expanded}
            onClick={() => (expanded ? closeSheet(true) : openSheet())}
          >
            <span className="bottom-nav__handle-bar" />
          </button>

          {!expanded && (
            <div className="bottom-nav__actions" role="toolbar" aria-label="Navigation actions">
              {actions.map((action) => {
                const Icon = ACTION_ICONS[action.id];
                return (
                  <button
                    key={action.id}
                    className={`bottom-nav__action${action.id === 'new-note' ? ' bottom-nav__action--accent' : ''}`}
                    aria-label={action.ariaLabel}
                    onClick={() => handleAction(action.id)}
                  >
                    {Icon ? <Icon size={22} /> : null}
                    <span className="bottom-nav__action-label">{action.label}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {expanded && (
          <div ref={sheetRef} className="bottom-nav__sheet">
            <NavContent onNavigate={() => closeSheet(true)} />
          </div>
        )}
      </div>
    </>
  );
}
