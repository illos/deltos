import { z } from 'zod';
import { NotebookIdSchema } from './ids.js';

/**
 * A notebook is a low-overlap CONTEXT for notes (ui-view-driven-architecture / ui-backbone-notebooks).
 * It is a first-class, account-scoped, SYNCED entity (rides the per-account syncSeq stream alongside
 * notes — see [[sync-notebookid-per-device-regression]] Option B). A note belongs to exactly one
 * notebook (its `notebookId`); "move note" restamps that id on the server CAS path.
 *
 * There is ALWAYS exactly one DEFAULT notebook per account (the undeletable safety net + new-user
 * landing). `isDefault` is system-owned — the server sets it at account creation / backfill; the client
 * never creates or deletes the default.
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

export const NotebookSchema = z.object({
  id: NotebookIdSchema,
  name: z.string().min(1).max(200),
  defaultCollectionView: CollectionViewSchema,
  /** True for the single undeletable default notebook of the account. System-owned. */
  isDefault: z.boolean(),
});
export type Notebook = z.infer<typeof NotebookSchema>;

/**
 * The client-authored slice of a notebook (create/rename). The server owns `id` ownership scoping,
 * `isDefault`, `createdAt`/`updatedAt`/`version`/`deletedAt`/`syncSeq`. A client can never assert
 * `isDefault` — the default is created server-side only.
 */
export const NotebookDraftSchema = NotebookSchema.pick({
  name: true,
  defaultCollectionView: true,
});
export type NotebookDraft = z.infer<typeof NotebookDraftSchema>;
