import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_LIST_PANE_WIDTH,
  clampListPaneWidth,
  readListPaneWidth,
  writeListPaneWidth,
} from '../db/panePointer.js';

const KEYBOARD_STEP = 16; // px per ←/→ press

export interface ResizableListPane {
  /** Current pane width in px (clamped). Starts at the default, then swaps to the persisted value. */
  width: number;
  /** Spread onto {@link ResizeHandle}: pointer-drag + keyboard (←/→) resize + the live aria value. */
  handleProps: {
    onPointerDown: (e: React.PointerEvent) => void;
    onKeyDown: (e: React.KeyboardEvent) => void;
    valueNow: number;
  };
}

/**
 * Drag-to-resize state for the desktop note-list pane (Lane 2 Pass B, the `--handle` divider).
 *
 * Render-before-data (load-feel gate): the pane paints at the default width immediately, then swaps
 * to the device-local persisted width once IDB resolves — one swap, no per-frame layout work. Resize
 * by pointer-drag (window-level move/up listeners so the drag survives the pointer leaving the thin
 * handle) or keyboard (←/→ by KEYBOARD_STEP, for a11y); every settle persists to deviceState so the
 * width survives reloads. No deps, no animation lib.
 */
export function useResizableListPane(): ResizableListPane {
  const [width, setWidth] = useState(DEFAULT_LIST_PANE_WIDTH);
  // Live width for the pointer/keyboard handlers — avoids stale-closure width inside a drag.
  const widthRef = useRef(width);
  widthRef.current = width;

  useEffect(() => {
    let live = true;
    void readListPaneWidth().then((w) => { if (live) setWidth(w); });
    return () => { live = false; };
  }, []);

  const commit = useCallback((px: number) => {
    const w = clampListPaneWidth(px);
    setWidth(w);
    void writeListPaneWidth(w);
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return; // primary button only
    e.preventDefault();
    const startX = e.clientX;
    const startW = widthRef.current;
    const onMove = (ev: PointerEvent) => commit(startW + (ev.clientX - startX));
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [commit]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); commit(widthRef.current - KEYBOARD_STEP); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); commit(widthRef.current + KEYBOARD_STEP); }
  }, [commit]);

  return { width, handleProps: { onPointerDown, onKeyDown, valueNow: width } };
}
