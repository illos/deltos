import { z } from 'zod';
import { NotebookIdSchema } from './ids.js';

/**
 * A notebook is a low-overlap CONTEXT for notes (ui-view-driven-architecture / ui-backbone-notebooks).
 * It is a first-class, account-scoped, SYNCED entity (rides the per-account syncSeq stream alongside
 * notes — see [[sync-notebookid-per-device-regression]] Option B). A note belongs to exactly one
 * notebook (its `notebookId`); "move note" restamps that id on the server CAS path.
 *
 * There is no stored "default" notebook — the synthetic "All Notes" aggregate (notebookId = null =
 * uncategorized) serves that role. Every real notebook is equally deletable (#58 / #61).
 */

/**
 * The notebook's default COLLECTION view (the view the note list renders through). v1 ships exactly one
 * registered collection view, `'list'`. Kept as a free string (not an enum) because the view registry
 * is a CLIENT concern — the server stores+syncs the pointer but does not validate it against the
 * registry, so adding a view later (Keep-cards, kanban) needs no server/schema change.
 */
export const CollectionViewSchema = z.string().min(1).max(64);
export type CollectionView = z.infer<typeof CollectionViewSchema>;

export const DEFAULT_COLLECTION_VIEW = 'list';

/**
 * The notebook's NOTE-SORT mode (notebook-organization). A synced, per-notebook preference — Jim wants a
 * notebook sorted "A—Z" to look A—Z on both his phone and his laptop (sort is a property of the notebook,
 * not the device). It rides the SAME `NotebookDraft`→server-SET channel as {@link CollectionViewSchema}
 * (proven zero-protocol-cost). Four modes:
 *   - 'modified' — updatedAt DESC (the current default + only ordering pre-feature)
 *   - 'alpha'    — display title A–Z (case-insensitive)
 *   - 'created'  — createdAt DESC
 *   - 'custom'   — manual per-note fractional order (SYS_NOTEBOOK_ORDER_KEY)
 * Pinned notes (SYS_PINNED_AT_KEY) partition ABOVE the active mode in ALL four cases. Unlike
 * `defaultCollectionView` this IS validated as an enum: the value set is server-agnostic but small and
 * closed, and an invalid persisted mode should fall back cleanly.
 */
export const NoteSortSchema = z.enum(['modified', 'alpha', 'created', 'custom']);
export type NoteSort = z.infer<typeof NoteSortSchema>;

export const DEFAULT_NOTE_SORT: NoteSort = 'modified';

export const NotebookSchema = z.object({
  id: NotebookIdSchema,
  name: z.string().min(1).max(200),
  defaultCollectionView: CollectionViewSchema,
  noteSort: NoteSortSchema.default(DEFAULT_NOTE_SORT),
});
export type Notebook = z.infer<typeof NotebookSchema>;

/**
 * The client-authored slice of a notebook (create/rename). The server owns `id` ownership scoping,
 * `createdAt`/`updatedAt`/`version`/`deletedAt`/`syncSeq`.
 */
export const NotebookDraftSchema = NotebookSchema.pick({
  name: true,
  defaultCollectionView: true,
  noteSort: true,
});
export type NotebookDraft = z.infer<typeof NotebookDraftSchema>;
