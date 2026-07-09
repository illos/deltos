import { useRef } from 'react';
import type { ReactNode } from 'react';
import { DragDropProvider, PointerSensor, KeyboardSensor } from '@dnd-kit/react';
import type { DragStartEvent, DragEndEvent } from '@dnd-kit/react';
import { useSortable } from '@dnd-kit/react/sortable';
import { move } from '@dnd-kit/helpers';
import { directionBiased } from '@dnd-kit/collision';
import { PointerActivationConstraints } from '@dnd-kit/dom';
import type { Note } from '@deltos/shared';
import { commitReorder } from './customReorderDrop.js';

// ── Library-based custom-order drag-reorder — the LAZY chunk (ROAD-0019) ─────────────────────────────
// This module statically imports every @dnd-kit/* package, so it MUST stay off the entry bundle. It is
// reached ONLY through the dynamic import() in useCustomReorder.ts, which fires when a surface renders in
// 'custom' sort. HomeView (list) and Board (masonry) both route through here — ONE wiring. Ported from the
// user-approved probe (spikes/dnd-demo/src/demos/Next.tsx): explicit per-input activation constraints so a
// touch swipe still scrolls, per-item directionBiased collision for masonry, move()+event index mapping.

// Explicit per-input-type activation (probe §5 "Demo 2" — dnd-kit #1723 touch defaults misbehave, so we set
// the long-press constraint by hand). Touch = 250ms hold / 5px drift → drag, so a quick horizontal swipe is
// left to SwipeRow and a vertical flick scrolls natively. Pointer (mouse/pen) = short delay + 5px distance so
// desktop feels immediate.
const pointerSensor = PointerSensor.configure({
  activationConstraints(event) {
    if (event.pointerType === 'touch') {
      return [new PointerActivationConstraints.Delay({ value: 250, tolerance: 5 })];
    }
    return [
      new PointerActivationConstraints.Delay({ value: 200, tolerance: 10 }),
      new PointerActivationConstraints.Distance({ value: 5 }),
    ];
  },
  // The library DEFAULT vetoes activation whenever pointerdown lands on any interactive element other than
  // the sortable element itself — and our whole row/card body is an <a> (the note Link), so the default
  // blocks EVERY press and reorder can never start. Override: veto only real controls (same closest() guard
  // the pre-library reorder used) so a press on the link body arms the drag but buttons/fields stay tappable.
  preventActivation(event: PointerEvent) {
    const target = event.target;
    return target instanceof Element
      && target.closest('button,input,textarea,select,[contenteditable="true"]') !== null;
  },
});

const SENSORS = [pointerSensor, KeyboardSensor];

/** Layout the reorder is wired into — 'list' (HomeView) or 'masonry' (Board grid). Drives collision choice. */
export type ReorderLayout = 'list' | 'masonry';

interface SortableRowInput {
  id: string;
  index: number;
  layout: ReorderLayout;
}

interface SortableRowState {
  /** Attach to the row's outer element — dnd-kit measures + drives it from here. */
  ref: (element: Element | null) => void;
  /** True while this row is the one being dragged (for a lifted-card class). */
  isDragging: boolean;
}

/**
 * Make one row/card sortable. Masonry passes layout='masonry' → the directionBiased collision detector (the
 * library's own fix for variable-height jitter, #1950): four-directional so there are no dead zones between
 * cards of wildly different heights. List uses the library default.
 */
export function useSortableRow({ id, index, layout }: SortableRowInput): SortableRowState {
  // Masonry → directionBiased; list → the library default. Spread the detector in only for masonry so we never
  // pass `collisionDetector: undefined` (exactOptionalPropertyTypes rejects it).
  const { ref, isDragging } = useSortable({
    id,
    index,
    ...(layout === 'masonry' ? { collisionDetector: directionBiased } : {}),
  });
  return { ref, isDragging };
}

interface CustomReorderProviderProps {
  /** The current sorted notes (index-aligned with what the user sees). Drives from→to index mapping on drop. */
  notes: Note[];
  /** Called AFTER the moved note's id + reordered id-list are known — fires the one reorderCustom write. */
  children: ReactNode;
  /** Fired on drop with the final id order so the masonry owner can re-measure grid spans post-reflow. */
  onReorder?: () => void;
}

/**
 * The DragDropProvider wrapper. Tracks the dragged id, runs move() to get the reordered id-list on drop, and
 * hands (orderedIds, reorderedIds, movedId) to commitReorder → reorderCustom (ONE O(1) fractional write).
 * Order state itself stays reactive in the store; we hold NO parallel copy beyond the active-drag refs.
 */
export function CustomReorderProvider({ notes, children, onReorder }: CustomReorderProviderProps) {
  // The id list dnd-kit reorders. Rebuilt each render from the reactive notes — never a separate source of truth.
  const ids = notes.map((n) => n.id);
  // Snapshot the pre-drag order + notes so the drop handler maps indices against exactly what was on screen when
  // the lift began (a mid-drag store update must not shift the from/to math). Refs, not state → no re-render.
  const dragIds = useRef<string[]>([]);
  const dragNotes = useRef<Note[]>([]);
  const draggingId = useRef<string | null>(null);

  const handleDragStart = (event: DragStartEvent) => {
    draggingId.current = String(event.operation.source?.id ?? '');
    dragIds.current = ids;
    dragNotes.current = notes;
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const movedId = draggingId.current;
    draggingId.current = null;
    if (!movedId) return;
    // move() applies the drag operation to the id list; a cancelled drag returns the same array → no-op.
    const reorderedIds = move(dragIds.current, event) as string[];
    void commitReorder(dragNotes.current, dragIds.current, reorderedIds, movedId);
    onReorder?.();
  };

  return (
    <DragDropProvider sensors={SENSORS} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      {children}
    </DragDropProvider>
  );
}
