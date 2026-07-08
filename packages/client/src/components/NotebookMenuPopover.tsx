import { useEffect, useRef } from 'react';
import type { NotebookId } from '@deltos/shared';
import { NotebookMenuBody } from './NotebookMenuBody.js';

/**
 * NotebookMenuPopover — the DESKTOP container for the notebook "…" residents (§2.4). The desktop 3-region
 * shell has no top bar / bottom-sheet, so a wide-window sheet would be wrong; this is an anchored floating
 * panel instead. It renders the SAME {@link NotebookMenuBody} as the mobile {@link ContextMenuSheet} — one
 * content, two containers (the discipline NavContent uses for DrawerNav + NavSheet). Only the wrapper geometry
 * differs.
 *
 * Reuses the app's overlay LANGUAGE via `.context-menu*` tokens (dimmed+blurred backdrop, `--nav` panel,
 * radius, shadow), just floated near the anchor row rather than pinned to the bottom edge. Dismiss = backdrop
 * click + Escape, exactly like every other overlay.
 */

interface NotebookMenuPopoverProps {
  open: boolean;
  onClose: () => void;
  notebookId: NotebookId | null;
}

export function NotebookMenuPopover({ open, onClose, notebookId }: NotebookMenuPopoverProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="nb-popover" role="dialog" aria-modal="true" aria-label="Notebook options">
      <div className="nb-popover__backdrop" onClick={onClose} aria-hidden="true" />
      <div ref={panelRef} className="nb-popover__panel">
        <div className="nb-popover__body">
          <NotebookMenuBody notebookId={notebookId} onClose={onClose} />
        </div>
        <button type="button" className="context-menu__close" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
