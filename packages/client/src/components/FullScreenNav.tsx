import { useEffect, useRef } from 'react';
import { NavContent } from '../views/NavContent.js';

interface FullScreenNavProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Full-screen nav overlay for mobile (#69 global-nav gap-fill).
 *
 * Shown when the 3-dot button in .shell__bar-end is tapped. Renders the same
 * NavContent as DrawerNav, but full-screen so it also works when body.deck-custom
 * is active (BottomNav is hidden in that mode — this is the only full-menu path).
 *
 * Mirrors the DrawerNav pattern: inert + aria-hidden when closed (focusable
 * descendants are truly unreachable by Tab/AT), Escape to close, role="dialog".
 * Structured as panel + open/close lifecycle so it can later shrink to a
 * bottom-sheet/partial without a rewrite.
 */
export function FullScreenNav({ open, onClose }: FullScreenNavProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    if (open) {
      el.removeAttribute('inert');
    } else {
      el.setAttribute('inert', '');
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <div
      ref={panelRef}
      className={`full-screen-nav${open ? ' full-screen-nav--open' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label="Navigation"
      aria-hidden={!open}
    >
      <NavContent onNavigate={onClose} />
    </div>
  );
}
