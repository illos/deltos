import { useEffect } from 'react';
import { NavContent } from '../views/NavContent.js';

interface DrawerNavProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Left pull-out drawer container for NavContent (mobile / tablet-portrait form).
 * Desktop multi-pane uses NavContent directly as a left pane — no drawer needed there.
 * The open/close state lives in AuthedShell (no global store — it's pure view state).
 */
export function DrawerNav({ open, onClose }: DrawerNavProps) {
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
        className={`nav-drawer${open ? ' nav-drawer--open' : ''}`}
        aria-hidden={!open}
        aria-label="Notebook navigation"
      >
        <NavContent onNavigate={onClose} />
      </div>
    </>
  );
}
