import type { Note } from '@deltos/shared';
import { type NoteSort, DEFAULT_NOTE_SORT, pinnedAt, notebookOrder } from '@deltos/shared';
import { notePreview } from './notePreview.js';

/**
 * THE single note-ordering comparator (notebook-menu-and-keep-view.md §5). One pure function drives every
 * note-list surface (the List view, the future Board view) so ordering can never drift between them.
 *
 * The design doc (§5.2) places the comparator "in observeNotes", but the SORT MODE is a PER-NOTEBOOK
 * preference and `observeNotes` produces one account-wide list with no notebook context. So the comparator
 * lives here as a pure `sortNotes(notes, mode)` and is applied at the call site that HAS the notebook
 * context (HomeView, after the notebookId filter), reading the mode off the current notebook row. This is
 * the minimal, correct seam — the same list is reused everywhere, mode is resolved where it's known, and
 * `observeNotes` keeps its cheap default order untouched (a warm mobile first paint never pays for this).
 *
 * Two-tier ordering in ALL modes:
 *   1. PIN PARTITION — pinned notes (SYS_PINNED_AT_KEY) float FIRST, ordered by pinnedAt DESCENDING
 *      (most-recently-pinned on top — pinning "puts it at the top"). Jim's decision, applies to every mode.
 *   2. Within each partition, the active MODE:
 *        'modified' — updatedAt DESC (the pre-feature default)
 *        'alpha'    — displayTitle A–Z, case-insensitive (via notePreview so untitled notes sort stably)
 *        'created'  — createdAt DESC
 *        'custom'   — SYS_NOTEBOOK_ORDER_KEY (fractional index) ASC; unkeyed notes sort AFTER keyed ones
 *
 * Pure — returns a NEW array, does not mutate the input.
 */

/** Compare two notes within a partition by the given non-pin mode. Stable-friendly (returns 0 on a tie). */
function compareByMode(a: Note, b: Note, mode: NoteSort): number {
  // FAIL-SAFE: a row with a missing/non-string timestamp must not crash the whole list sort (mirrors
  // isTrashed's fail-safe stance); String()-coerce so localeCompare is always defined + deterministic.
  const au = String(a.updatedAt ?? '');
  const bu = String(b.updatedAt ?? '');
  switch (mode) {
    case 'modified':
      return bu.localeCompare(au); // DESC
    case 'created':
      return String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')); // DESC
    case 'alpha': {
      const at = notePreview(a).displayTitle.toLocaleLowerCase();
      const bt = notePreview(b).displayTitle.toLocaleLowerCase();
      const c = at.localeCompare(bt);
      // Tie-break equal titles by updatedAt DESC so the order is deterministic (not IDB-insertion-order).
      return c !== 0 ? c : bu.localeCompare(au);
    }
    case 'custom': {
      const ao = notebookOrder(a.properties);
      const bo = notebookOrder(b.properties);
      // Unkeyed notes (null) sort AFTER keyed ones; between two unkeyed, fall back to updatedAt DESC.
      if (ao === null && bo === null) return bu.localeCompare(au);
      if (ao === null) return 1;
      if (bo === null) return -1;
      return ao - bo; // ASC fractional index
    }
  }
}

/**
 * Sort `notes` by the active per-notebook `mode`, with pinned notes partitioned to the top
 * (most-recently-pinned first). Returns a new array. An unknown/missing mode falls back to the default.
 */
export function sortNotes(notes: Note[], mode: NoteSort = DEFAULT_NOTE_SORT): Note[] {
  const active = coerceNoteSort(mode); // normalize a stray/invalid mode → default (never an undefined compare)
  return [...notes].sort((a, b) => {
    const ap = pinnedAt(a.properties);
    const bp = pinnedAt(b.properties);
    // Tier 1 — pin partition. Pinned before unpinned; within pinned, pinnedAt DESC (most-recent on top).
    if (ap !== null && bp === null) return -1;
    if (ap === null && bp !== null) return 1;
    if (ap !== null && bp !== null) {
      const c = bp.localeCompare(ap); // DESC
      if (c !== 0) return c;
    }
    // Tier 2 — the active mode (same for both partitions).
    return compareByMode(a, b, active);
  });
}

/**
 * Coerce a persisted notebook `noteSort` string (server-opaque) into a valid {@link NoteSort}, defaulting
 * an unknown/missing value. Used at the HomeView seam where the raw string comes off the NotebookRow.
 */
export function coerceNoteSort(raw: string | null | undefined): NoteSort {
  return raw === 'modified' || raw === 'alpha' || raw === 'created' || raw === 'custom' ? raw : DEFAULT_NOTE_SORT;
}

/**
 * Fractional-index midpoint between two order keys for a custom-order drag (§5.4). Given the keys of the
 * notes the dragged note is dropped BETWEEN (`before` = the neighbour above, `after` = the neighbour below;
 * `null` = "no neighbour on that side"), returns the new key: the midpoint of the two, or an offset past a
 * single bound. O(1) — only the moved note's key changes. Uses float midpoints (Jim-user scale never
 * exhausts float precision; a renumber is a trivial future fallback, not needed now).
 */
export function fractionalMidpoint(before: number | null, after: number | null): number {
  if (before === null && after === null) return 0; // first item in an empty custom order
  if (before === null) return after! - 1; // dropped at the very top → below-of-first
  if (after === null) return before + 1; // dropped at the very bottom → above-of-last
  return (before + after) / 2; // between two notes
}
