import { useEffect, useRef } from 'react';
import { NavContent } from '../views/NavContent.js';

interface DrawerNavProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Left pull-out drawer container for NavContent (mobile / tablet-portrait form).
 * Desktop multi-pane uses NavContent directly as a left pane — no drawer needed there.
 * The open/close state lives in AuthedShell (no global store — it's pure view state).
 *
 * Uses the `inert` attribute (via ref) when closed so buttons inside are not reachable
 * by Tab or AT — aria-hidden alone leaves focusable descendants accessible.
 */
export function DrawerNav({ open, onClose }: DrawerNavProps) {
  const drawerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = drawerRef.current;
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
    <>
      {open && (
        <div
          className="nav-drawer__overlay"
          aria-hidden
          onClick={onClose}
        />
      )}
      <div
        ref={drawerRef}
        className={`nav-drawer${open ? ' nav-drawer--open' : ''}`}
        aria-hidden={!open}
        aria-label="Notebook navigation"
      >
        <NavContent onNavigate={onClose} />
      </div>
    </>
  );
}
