import { useEffect, useRef } from 'react';
import type { NotebookId } from '@deltos/shared';
import { NotebookMenuBody } from './NotebookMenuBody.js';

interface ContextMenuSheetProps {
  open: boolean;
  onClose: () => void;
  /** The notebook these options act on. null = the synthetic "All Notes" aggregate (Rename/Share hidden). */
  notebookId: NotebookId | null;
}

/**
 * ContextMenuSheet — the contextual options surface the top-bar "…" button opens (ROAD-0011).
 *
 * The drag-up {@link NavSheet} IS the app's navigation now (Jim's ruling), so the "…" button is
 * repurposed as the CONTEXTUAL settings surface — a notebook/note options menu. This component is the
 * SHELL for that surface: mostly empty in v1 (a quiet empty-state hint + an easy-to-reach close).
 * Planned residents, built later — NOT here: rename notebook, note organization, notebook display
 * options, per-notebook sharing; note-level items when the "…" is opened while editing a note.
 *
 * Presentation follows the app's overlay language — a bottom-sheet (matching {@link NavSheet}'s panel
 * geometry: rounded top, slides up over a dimmed+blurred backdrop). Dismiss is consistent with the
 * other overlays: backdrop tap + Escape. `inert` + aria-hidden when closed keep the panel out of the
 * tab / AT tree exactly like the other sheets. The CLOSE control sits at the BOTTOM of the surface
 * (thumb zone) per Jim — comfortably reachable, never a tiny top-corner ×.
 *
 * The BODY is {@link NotebookMenuBody} (the four notebook residents) — the MOBILE container of the
 * one-content/two-container pair (the desktop container is {@link NotebookMenuPopover}).
 */
export function ContextMenuSheet({ open, onClose, notebookId }: ContextMenuSheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Escape closes (mirrors the NavSheet / drawer overlays).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <div className={`context-menu${open ? ' context-menu--open' : ''}`} aria-hidden={!open}>
      <div className="context-menu__backdrop" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        className="context-menu__panel"
        role="dialog"
        aria-modal="true"
        aria-label="Options"
        inert={!open}
      >
        <div className="context-menu__grabber" aria-hidden="true">
          <span className="context-menu__grabber-bar" />
        </div>
        <div className="context-menu__body context-menu__body--menu">
          <NotebookMenuBody notebookId={notebookId} onClose={onClose} />
        </div>
        {/* Bottom-of-surface close (thumb zone, Jim) — the comfortable dismiss target on mobile. */}
        <button type="button" className="context-menu__close" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
