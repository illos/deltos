import type { Note } from '@deltos/shared';
import { notebookOrder } from '@deltos/shared';
import { fractionalMidpoint } from './noteSort.js';
import { mutateNotes } from '../db/mutate.js';
import { notifyQueueWrite } from './syncEngine.js';

// NOTE: currently import-free — the hand-rolled long-press drag hook (useCustomOrderDrag) was ripped out;
// this is the ORDER-PERSISTENCE seam (ROAD-0013) that the future library-based drag will call to commit a move.
/**
 * Custom-order drag REORDER (notebook-menu-and-keep-view.md §5.4) — the persistence half of the drag gesture.
 * Given the CURRENT custom-sorted list and a move (drag note at `from` → drop at index `to`), compute the moved
 * note's new fractional key from its NEW neighbours (`fractionalMidpoint`) and persist it via `mutateNotes.setOrder`
 * → the reserved `sys:notebookOrder` property, riding the existing `updateNote` CAS.
 *
 * COST: normally ONE O(1) write — only the moved note's key changes, never a whole-list renumber (perf bar +
 * sync-conflict window). EXCEPTION — cold start: the 'custom' comparator sorts keyed notes BEFORE all unkeyed
 * ones, so a fractional key derived from an UNKEYED neighbour is meaningless (both bounds read null → key 0 →
 * the moved note jumps to the top regardless of drop position). So when a NEEDED neighbour has no key yet, we
 * first SEED explicit keys (index `i`) over the current rendered order — a ONE-TIME batch of N writes on the
 * first-ever drag in a notebook (idempotent: notes whose key already equals their index are skipped). Once
 * seeded, every subsequent drag stays the single O(1) write.
 *
 * `notes` MUST be the currently-rendered custom-sorted order (so index math matches what the user sees). `to`
 * is the INSERT POSITION in the original list — 0..notes.length (len = "drop at the very end", past every row).
 * The neighbours are computed on the list with the dragged note removed, matching a standard reorder drop. No-op
 * when nothing moves.
 */
export async function reorderCustom(notes: Note[], from: number, to: number): Promise<void> {
  if (from < 0 || from >= notes.length || to < 0 || to > notes.length) return;
  // Dropping into the note's own current slot (right where it already sits) moves nothing.
  if (to === from || to === from + 1) return;
  const moved = notes[from];
  if (!moved) return;
  // The list with the dragged note removed — the drop lands BEFORE `destIndex` in this reduced list.
  const without = notes.slice(0, from).concat(notes.slice(from + 1));
  // Insert position within the reduced list: an insert at or past `from` shifts left by one (the gap `from` left).
  const destIndex = to > from ? to - 1 : to;
  let before = destIndex > 0 ? notebookOrder(without[destIndex - 1]!.properties) : null;
  let after = destIndex < without.length ? notebookOrder(without[destIndex]!.properties) : null;
  // A NEEDED neighbour with no key yet → the fractional key would be meaningless against the 'custom'
  // comparator (keyed-before-unkeyed). Seed explicit keys over the current rendered order first, then use
  // the freshly-seeded integer bounds. `needed`: before is needed iff there IS a row above the drop
  // (destIndex > 0); after iff there IS a row below (destIndex < without.length).
  const needBefore = destIndex > 0 && before === null;
  const needAfter = destIndex < without.length && after === null;
  if (needBefore || needAfter) {
    // Seed each note in the reduced (`without`) order with its index; skip an already-consistent prefix.
    await Promise.all(
      without.map((n, i) => (notebookOrder(n.properties) === i ? undefined : mutateNotes.setOrder(n, i))),
    );
    // Bounds are now the seeded integers (`without` index == its key).
    before = destIndex - 1 >= 0 ? destIndex - 1 : null;
    after = destIndex < without.length ? destIndex : null;
  }
  const key = fractionalMidpoint(before, after);
  await mutateNotes.setOrder(moved, key);
  notifyQueueWrite(moved.notebookId);
}
