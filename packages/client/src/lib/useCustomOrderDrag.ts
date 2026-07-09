import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  CSSProperties,
  PointerEvent as ReactPointerEvent,
  MouseEvent as ReactMouseEvent,
} from 'react';
import type { Note } from '@deltos/shared';
import { reorderCustom } from './customOrderReorder.js';

const LONG_PRESS_MS = 260;
const MOVE_TOLERANCE = 10;
const FLIP_MS = 170;

type LayoutMode = 'list' | 'grid';

interface DragOverlay {
  note: Note;
  style: CSSProperties;
}

interface PendingPress {
  pointerId: number;
  index: number;
  note: Note;
  startX: number;
  startY: number;
  target: HTMLElement;
  timer: number;
  cancelled: boolean;
}

interface ActiveDrag {
  pointerId: number;
  from: number;
  note: Note;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  rect: DOMRect;
}

export type CustomOrderRenderItem =
  | { kind: 'note'; note: Note; originalIndex: number }
  | { kind: 'placeholder'; key: string; height: number; rowSpan: string };

export interface CustomOrderDrag {
  /** True when a reorder drag is active. */
  dragging: boolean;
  /** The id of the note being dragged, or null. */
  draggingId: string | null;
  /** The original-list insert index the dragged note would drop at, or null. */
  overIndex: number | null;
  /** Notes plus a real placeholder while dragging, still keyed to the source note order. */
  renderItems: CustomOrderRenderItem[];
  /** Fixed lifted copy following the pointer while the source item is out of flow. */
  overlay: DragOverlay | null;
  /** Register a rendered note element for hit-testing and FLIP animation. */
  registerRow: (noteId: string, el: HTMLElement | null) => void;
  /** Long-press-anywhere props for the note body. Horizontal movement before the hold is left to SwipeRow. */
  bodyProps: (index: number, note: Note) => {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
    onClickCapture: (e: ReactMouseEvent<HTMLElement>) => void;
    onContextMenu: (e: ReactMouseEvent<HTMLElement>) => void;
  };
}

export function useCustomOrderDrag(notes: Note[], enabled: boolean, layout: LayoutMode = 'list'): CustomOrderDrag {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [overlay, setOverlay] = useState<DragOverlay | null>(null);
  const [placeholder, setPlaceholder] = useState<{ height: number; rowSpan: string }>({ height: 0, rowSpan: '1' });

  const rows = useRef<Map<string, HTMLElement>>(new Map());
  const pending = useRef<PendingPress | null>(null);
  const active = useRef<ActiveDrag | null>(null);
  const notesRef = useRef(notes);
  const firstRects = useRef<Map<string, DOMRect> | null>(null);
  const suppressClickUntil = useRef(0);
  const raf = useRef<number | null>(null);
  const touchSuppressed = useRef(false);

  notesRef.current = notes;

  const idToIndex = useMemo(() => {
    const map = new Map<string, number>();
    notes.forEach((note, index) => map.set(note.id, index));
    return map;
  }, [notes]);

  const registerRow = useCallback((noteId: string, el: HTMLElement | null) => {
    if (el) rows.current.set(noteId, el);
    else rows.current.delete(noteId);
  }, []);

  const measureFirst = useCallback(() => {
    const rects = new Map<string, DOMRect>();
    for (const [id, el] of rows.current) rects.set(id, el.getBoundingClientRect());
    firstRects.current = rects;
  }, []);

  const playFlip = useCallback(() => {
    const before = firstRects.current;
    if (!before) return;
    firstRects.current = null;
    for (const [id, el] of rows.current) {
      if (id === active.current?.note.id) continue;
      const prev = before.get(id);
      if (!prev) continue;
      const next = el.getBoundingClientRect();
      const dx = prev.left - next.left;
      const dy = prev.top - next.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      el.style.transition = 'none';
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      el.getBoundingClientRect();
      el.style.transition = `transform ${FLIP_MS}ms ease`;
      el.style.transform = '';
      window.setTimeout(() => {
        if (el.style.transition.includes('transform')) el.style.transition = '';
      }, FLIP_MS + 40);
    }
  }, []);

  useLayoutEffect(() => {
    playFlip();
  }, [overIndex, draggingId, playFlip]);

  useEffect(() => () => {
    if (pending.current) window.clearTimeout(pending.current.timer);
    if (raf.current !== null) window.cancelAnimationFrame(raf.current);
    window.removeEventListener('pointermove', onWindowPointerMove, true);
    window.removeEventListener('pointerup', onWindowPointerUp, true);
    window.removeEventListener('pointercancel', onWindowPointerCancel, true);
    window.removeEventListener('touchmove', onWindowTouchMove, true);
  // These handlers are function declarations intentionally scoped to the current hook instance.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Transform-FREE viewport rect: the FLIP pass parks sibling rows under `transform: translate(...)` mid-flight,
  // so a raw getBoundingClientRect() reports shifted centers → the target index oscillates and the placeholder
  // thrashes. Two load-bearing facts make this a one-liner: (1) the ONLY transforms in play are the FLIP translates
  // that playFlip sets on the row elements THEMSELVES — no ancestor is ever transformed; (2) getBoundingClientRect()
  // already accounts for EVERY ancestor's scroll offset, positioned or not (unlike an offsetParent walk, which skips
  // static overflow containers like `.home__notes`). So the settled layout rect is simply the row's live gBCR minus
  // its OWN current transform translation. getComputedStyle().transform returns the mid-transition INTERPOLATED
  // matrix, so subtracting m41/m42 yields the settled position even while a FLIP animation is in flight. FLIP only
  // translates (never scales), so gBCR width/height are already correct.
  const untransformedRect = useCallback((el: HTMLElement): { left: number; top: number; width: number; height: number } => {
    const rect = el.getBoundingClientRect();
    const tf = window.getComputedStyle(el).transform;
    if (!tf || tf === 'none' || typeof DOMMatrixReadOnly === 'undefined') {
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    }
    const m = new DOMMatrixReadOnly(tf);
    return { left: rect.left - m.m41, top: rect.top - m.m42, width: rect.width, height: rect.height };
  }, []);

  const indexAtPoint = useCallback((clientX: number, clientY: number): number => {
    const currentNotes = notesRef.current;
    if (currentNotes.length === 0) return 0;

    if (layout === 'list') {
      for (const note of currentNotes) {
        if (note.id === active.current?.note.id) continue;
        const el = rows.current.get(note.id);
        if (!el) continue;
        const rect = untransformedRect(el);
        const idx = idToIndex.get(note.id);
        if (idx === undefined) continue;
        if (clientY < rect.top + rect.height / 2) return idx;
      }
      return currentNotes.length;
    }

    let best: { index: number; after: boolean; distance: number } | null = null;
    for (const note of currentNotes) {
      if (note.id === active.current?.note.id) continue;
      const el = rows.current.get(note.id);
      const idx = idToIndex.get(note.id);
      if (!el || idx === undefined) continue;
      const rect = untransformedRect(el);
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = clientX - cx;
      const dy = clientY - cy;
      const distance = dx * dx + dy * dy;
      const after = Math.abs(dy) > rect.height / 3 ? clientY > cy : clientX > cx;
      if (!best || distance < best.distance) best = { index: idx, after, distance };
    }
    if (!best) return currentNotes.length;
    return best.index + (best.after ? 1 : 0);
  }, [idToIndex, layout, untransformedRect]);

  const updateOverlay = useCallback((drag: ActiveDrag) => {
    const dx = drag.lastX - drag.startX;
    const dy = drag.lastY - drag.startY;
    setOverlay({
      note: drag.note,
      style: {
        position: 'fixed',
        left: drag.rect.left,
        top: drag.rect.top,
        width: drag.rect.width,
        height: drag.rect.height,
        transform: `translate(${dx}px, ${dy}px)`,
        zIndex: 370,
        pointerEvents: 'none',
      },
    });
  }, []);

  const setTargetIndex = useCallback((next: number) => {
    setOverIndex((prev) => {
      if (prev === next) return prev;
      measureFirst();
      return next;
    });
  }, [measureFirst]);

  const startSuppressingTouch = useCallback(() => {
    if (touchSuppressed.current) return;
    touchSuppressed.current = true;
    window.addEventListener('touchmove', onWindowTouchMove, { passive: false, capture: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopSuppressingTouch = useCallback(() => {
    if (!touchSuppressed.current) return;
    touchSuppressed.current = false;
    window.removeEventListener('touchmove', onWindowTouchMove, true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clearPending = useCallback(() => {
    const press = pending.current;
    if (!press) return;
    window.clearTimeout(press.timer);
    stopSuppressingTouch();
    window.removeEventListener('pointermove', onWindowPointerMove, true);
    window.removeEventListener('pointerup', onWindowPointerUp, true);
    window.removeEventListener('pointercancel', onWindowPointerCancel, true);
    pending.current = null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stopSuppressingTouch]);

  const teardownDrag = useCallback(() => {
    active.current = null;
    setDraggingId(null);
    setOverIndex(null);
    setOverlay(null);
    suppressClickUntil.current = Date.now() + 450;
    stopSuppressingTouch();
    window.removeEventListener('pointermove', onWindowPointerMove, true);
    window.removeEventListener('pointerup', onWindowPointerUp, true);
    window.removeEventListener('pointercancel', onWindowPointerCancel, true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finishDrag = useCallback((clientX: number, clientY: number) => {
    const drag = active.current;
    teardownDrag();
    if (!drag) return;
    const to = indexAtPoint(clientX, clientY);
    void reorderCustom(notesRef.current, drag.from, to);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indexAtPoint, teardownDrag]);

  // pointercancel (native scroll/gesture claim, app-switch) must ABORT — restore the source order, no write.
  const abortDrag = useCallback(() => {
    teardownDrag();
  }, [teardownDrag]);

  function armDrag(press: PendingPress) {
    if (press.cancelled || !enabled) return;
    const row = rows.current.get(press.note.id);
    const rect = (row ?? press.target).getBoundingClientRect();
    const rowSpan = row?.style.getPropertyValue('--board-row-span') || '1';
    const drag: ActiveDrag = {
      pointerId: press.pointerId,
      from: press.index,
      note: press.note,
      startX: press.startX,
      startY: press.startY,
      lastX: press.startX,
      lastY: press.startY,
      rect,
    };
    active.current = drag;
    pending.current = null;
    setPlaceholder({ height: rect.height, rowSpan });
    measureFirst();
    setDraggingId(press.note.id);
    setOverIndex(press.index);
    updateOverlay(drag);
    try { press.target.setPointerCapture(press.pointerId); } catch { /* jsdom */ }
  }

  function onWindowPointerMove(ev: PointerEvent) {
    const drag = active.current;
    if (drag) {
      if (ev.pointerId !== drag.pointerId) return;
      ev.preventDefault();
      ev.stopPropagation();
      drag.lastX = ev.clientX;
      drag.lastY = ev.clientY;
      if (raf.current !== null) window.cancelAnimationFrame(raf.current);
      raf.current = window.requestAnimationFrame(() => {
        raf.current = null;
        updateOverlay(drag);
        setTargetIndex(indexAtPoint(drag.lastX, drag.lastY));
      });
      return;
    }

    const press = pending.current;
    if (!press || ev.pointerId !== press.pointerId) return;
    const dx = ev.clientX - press.startX;
    const dy = ev.clientY - press.startY;
    if (Math.abs(dx) > MOVE_TOLERANCE || Math.abs(dy) > MOVE_TOLERANCE) {
      press.cancelled = true;
      clearPending();
    }
  }

  function onWindowPointerUp(ev: PointerEvent) {
    const drag = active.current;
    if (drag && ev.pointerId === drag.pointerId) {
      ev.preventDefault();
      ev.stopPropagation();
      finishDrag(ev.clientX, ev.clientY);
      return;
    }
    const press = pending.current;
    if (press && ev.pointerId === press.pointerId) clearPending();
  }

  function onWindowPointerCancel(ev: PointerEvent) {
    const drag = active.current;
    if (drag && ev.pointerId === drag.pointerId) {
      abortDrag();
      return;
    }
    const press = pending.current;
    if (press && ev.pointerId === press.pointerId) clearPending();
  }

  // Touch scroll suppression: setPointerCapture does NOT stop native panning. Once a drag is ARMED we must
  // preventDefault touchmove (passive:false, capture) or the browser claims the gesture and fires pointercancel,
  // killing the drag. Never suppress during the pending press — normal vertical scroll must stay live there (a
  // pending press is already cancelled by >10px movement). Guarded by `active.current` so it self-gates.
  function onWindowTouchMove(ev: TouchEvent) {
    if (active.current && ev.cancelable) ev.preventDefault();
  }

  const bodyProps = useCallback(
    (index: number, note: Note) => ({
      onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
        if (!enabled || e.button !== 0) return;
        if ((e.target as HTMLElement).closest('button,input,textarea,select,[contenteditable="true"]')) return;
        clearPending();
        const target = e.currentTarget;
        const press: PendingPress = {
          pointerId: e.pointerId,
          index,
          note,
          startX: e.clientX,
          startY: e.clientY,
          target,
          cancelled: false,
          timer: window.setTimeout(() => armDrag(press), LONG_PRESS_MS),
        };
        pending.current = press;
        window.addEventListener('pointermove', onWindowPointerMove, true);
        window.addEventListener('pointerup', onWindowPointerUp, true);
        window.addEventListener('pointercancel', onWindowPointerCancel, true);
        // Touch pointers: pre-attach the touchmove interceptor now (finger is already down); it only
        // preventDefaults once a drag ARMS, so scroll stays native through the pending press.
        if (e.pointerType !== 'mouse') startSuppressingTouch();
      },
      onClickCapture: (e: ReactMouseEvent<HTMLElement>) => {
        if (Date.now() < suppressClickUntil.current) {
          e.preventDefault();
          e.stopPropagation();
        }
      },
      onContextMenu: (e: ReactMouseEvent<HTMLElement>) => {
        if (enabled) e.preventDefault();
      },
    }),
    // `armDrag` and the window handlers intentionally read live refs; recreating the props on note/order changes
    // is enough to keep the start index fresh without per-move React churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [clearPending, enabled, startSuppressingTouch],
  );

  const renderItems = useMemo<CustomOrderRenderItem[]>(() => {
    if (!draggingId || overIndex === null) {
      return notes.map((note, originalIndex) => ({ kind: 'note', note, originalIndex }));
    }
    const from = idToIndex.get(draggingId);
    if (from === undefined) return notes.map((note, originalIndex) => ({ kind: 'note', note, originalIndex }));
    const without: CustomOrderRenderItem[] = notes
      .map((note, originalIndex) => ({ kind: 'note' as const, note, originalIndex }))
      .filter((item) => item.note.id !== draggingId);
    const insertAt = Math.max(0, Math.min(without.length, overIndex > from ? overIndex - 1 : overIndex));
    without.splice(insertAt, 0, {
      kind: 'placeholder',
      key: `custom-order-placeholder-${draggingId}`,
      height: placeholder.height,
      rowSpan: placeholder.rowSpan,
    });
    return without;
  }, [draggingId, idToIndex, notes, overIndex, placeholder.height, placeholder.rowSpan]);

  return { dragging: draggingId !== null, draggingId, overIndex, renderItems, overlay, registerRow, bodyProps };
}
