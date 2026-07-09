import type { Note } from '@deltos/shared';
import { reorderCustom } from '../customOrderReorder.js';

/**
 * Pure drop-index mapping for the library-based custom-order reorder (ROAD-0019). Kept OUT of the lazy
 * dnd-kit chunk (no @dnd-kit import here) so it stays unit-testable and the perf gate is honoured: the
 * lazy impl module calls this with the ids dnd-kit produced; this maps them back to `reorderCustom`.
 *
 * dnd-kit's `move()` reorders the array of ids; we translate that "before → after" pair into the
 * `(from, to)` INSERT-POSITION contract `reorderCustom` expects (see customOrderReorder.ts):
 *  - `from` = the dragged note's index in the ORIGINAL sorted list.
 *  - `to`   = the INSERT POSITION in the ORIGINAL list (0..len). Derived from the moved id's index in the
 *             REORDERED list, adjusted so a downward move (newIndex >= from) maps to insert-position
 *             newIndex+1 (drop AFTER that slot), matching reorderCustom's `to === from + 1` no-op guard.
 *
 * `orderedIds` is the current sorted order (what the user sees); `reorderedIds` is what dnd-kit's move()
 * returned. Returns null (no write) for a no-op drop (id missing, or lands back in its own slot).
 */
export function computeReorderMove(
  orderedIds: string[],
  reorderedIds: string[],
  movedId: string,
): { from: number; to: number } | null {
  const from = orderedIds.indexOf(movedId);
  const newIndex = reorderedIds.indexOf(movedId);
  if (from < 0 || newIndex < 0) return null;
  // Moving DOWN (to a higher index) means inserting AFTER that slot in the original coordinate space, so
  // the insert position is newIndex + 1; moving UP inserts BEFORE, so it stays newIndex. reorderCustom's
  // own guard collapses `to === from` and `to === from + 1` to no-ops, so an unmoved drop writes nothing.
  const to = newIndex > from ? newIndex + 1 : newIndex;
  if (to === from || to === from + 1) return null;
  return { from, to };
}

/**
 * Read the projected sortable index off a dnd-kit source instance (duck-typed the same way dnd-kit's own
 * move() helper does — SortableDraggable carries index/initialIndex at runtime but the DragEndEvent type
 * only says Draggable). Returns null when the source isn't a sortable or genuinely didn't move.
 */
export function projectedSortableIndex(source: unknown): number | null {
  if (source !== null && typeof source === 'object' && 'index' in source && 'initialIndex' in source) {
    const { index, initialIndex } = source as { index: unknown; initialIndex: unknown };
    if (typeof index === 'number' && typeof initialIndex === 'number' && index !== initialIndex) {
      return index;
    }
  }
  return null;
}

/**
 * GAP-DROP fallback: when a drop ends over no droppable (masonry gutter, board padding, past the last row),
 * dnd-kit's move() returns the id array UNCHANGED even though the sortable already optimistically moved the
 * DOM — the visible order and the persisted order silently diverge until the next render snaps the list
 * back. The projected index (where the sortable visually sits) is still known, so re-derive the reordered
 * ids from it and persist what the user sees. Returns `orderedIds` untouched for a genuine no-move.
 */
export function applyProjectedIndex(
  orderedIds: string[],
  movedId: string,
  projected: number | null,
): string[] {
  if (projected === null || projected < 0 || projected >= orderedIds.length) return orderedIds;
  const from = orderedIds.indexOf(movedId);
  if (from < 0 || from === projected) return orderedIds;
  const next = orderedIds.slice();
  next.splice(projected, 0, ...next.splice(from, 1));
  return next;
}

/**
 * Bridge the reordered ids to the persistence seam. `notes` is the CURRENT sorted list (index-aligned with
 * `orderedIds`). No-op drops issue no write. One O(1) fractional-order write via reorderCustom.
 */
export async function commitReorder(
  notes: Note[],
  orderedIds: string[],
  reorderedIds: string[],
  movedId: string,
): Promise<void> {
  const move = computeReorderMove(orderedIds, reorderedIds, movedId);
  if (!move) return;
  await reorderCustom(notes, move.from, move.to);
}
