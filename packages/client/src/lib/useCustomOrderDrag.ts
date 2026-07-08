import { useCallback, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { Note } from '@deltos/shared';
import { reorderCustom } from './customOrderReorder.js';

/**
 * useCustomOrderDrag — the custom-sort drag-reorder INTERACTION for the note list (notebook-menu-and-keep-view.md
 * §5.4). Armed ONLY when the active sort is 'custom'; the persistence half is `reorderCustom` (fractional key via
 * `mutateNotes.setOrder`).
 *
 * GESTURE DISAMBIGUATION from SwipeRow (Jim: mobile-first, must coexist with the horizontal swipe): the drag is
 * initiated ONLY from an explicit GRIP HANDLE (`handleProps` below), never the row body — so a horizontal swipe
 * on the row still opens the swipe actions, and only a deliberate grab of the handle arms a vertical reorder.
 * The handle is rendered only in custom mode, so no new affordance appears otherwise.
 *
 * Pointer-based (works on touch AND mouse — HTML5 DnD doesn't fire from touch): pointerdown on the handle
 * captures the pointer; pointermove tracks which row index the finger is over (via the row rects the caller
 * registers); pointerup persists the move. A live `draggingId` + `overIndex` drive the caller's visual feedback.
 */
export interface CustomOrderDrag {
  /** True when a reorder drag is active. */
  dragging: boolean;
  /** The id of the note being dragged (for styling the lifted row), or null. */
  draggingId: string | null;
  /** The index the dragged row would drop at (for a drop-line indicator), or null. */
  overIndex: number | null;
  /** Register a row element for hit-testing (call in a ref callback keyed by index). */
  registerRow: (index: number, el: HTMLElement | null) => void;
  /** Props for the per-row grip handle; pass the row's index + its note. */
  handleProps: (index: number, note: Note) => {
    onPointerDown: (e: ReactPointerEvent) => void;
    role: string;
    'aria-label': string;
    tabIndex: number;
  };
}

export function useCustomOrderDrag(notes: Note[], enabled: boolean): CustomOrderDrag {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const rows = useRef<Map<number, HTMLElement>>(new Map());
  const fromIndex = useRef<number | null>(null);
  // Keep the latest notes for the pointerup handler (which is created once per drag).
  const notesRef = useRef(notes);
  notesRef.current = notes;

  const registerRow = useCallback((index: number, el: HTMLElement | null) => {
    if (el) rows.current.set(index, el);
    else rows.current.delete(index);
  }, []);

  /** Which row index is under clientY, using the registered row rects (midpoint split for insert position). */
  const indexAtY = useCallback((clientY: number): number => {
    let best = notesRef.current.length; // default: past the end
    for (const [idx, el] of rows.current) {
      const r = el.getBoundingClientRect();
      if (clientY < r.top + r.height / 2) { best = Math.min(best, idx); }
    }
    return best;
  }, []);

  const handleProps = useCallback(
    (index: number, note: Note) => ({
      role: 'button',
      'aria-label': 'Drag to reorder',
      tabIndex: 0,
      onPointerDown: (e: ReactPointerEvent) => {
        if (!enabled) return;
        e.preventDefault();
        e.stopPropagation();
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        fromIndex.current = index;
        setDraggingId(note.id);
        setOverIndex(index);

        const onMove = (ev: PointerEvent) => {
          setOverIndex(indexAtY(ev.clientY));
        };
        const onUp = (ev: PointerEvent) => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          const from = fromIndex.current;
          // indexAtY returns an INSERT position (0..len) — reorderCustom takes exactly that (len = drop at end).
          const to = indexAtY(ev.clientY);
          fromIndex.current = null;
          setDraggingId(null);
          setOverIndex(null);
          if (from !== null) void reorderCustom(notesRef.current, from, to);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
      },
    }),
    [enabled, indexAtY],
  );

  return { dragging: draggingId !== null, draggingId, overIndex, registerRow, handleProps };
}
