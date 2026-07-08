import { DEFAULT_COLLECTION_VIEW, DEFAULT_NOTE_SORT } from '@deltos/shared';
import type { NotebookId, NoteSort } from '@deltos/shared';
import { getStore } from './store.js';
import { newNotebookId } from '../lib/ids.js';
import type { NotebookRow } from './schema.js';

/**
 * Notebook CRUD mutations — the ONLY writer for notebook rows + notebookQueue.
 * Every operation is atomic: the row and the queue entry land in one transaction.
 *
 * Guards:
 *   - create: new notebook (version 0 → server INSERT)
 *   - rename: no-op on missing or already-deleted notebooks
 *   - delete: no-op on already-deleted notebooks; notes uncategorized (All Notes)
 */
export const mutateNotebooks = {
  async create(name: string): Promise<NotebookId> {
    const id = newNotebookId();
    const now = new Date().toISOString();
    const row: NotebookRow = {
      id,
      name,
      defaultCollectionView: DEFAULT_COLLECTION_VIEW,
      noteSort: DEFAULT_NOTE_SORT,
      version: 0,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      syncSeq: 0,
    };
    await getStore().putNotebookAndEnqueue(row, {
      id: crypto.randomUUID(),
      recordId: id,
      payload: { id, baseVersion: 0, draft: { name, defaultCollectionView: DEFAULT_COLLECTION_VIEW, noteSort: DEFAULT_NOTE_SORT } },
      createdAt: now,
    });
    return id;
  },

  async rename(id: NotebookId, name: string): Promise<void> {
    const nb = await getStore().getNotebook(id);
    if (!nb || nb.deletedAt !== null) return;
    const now = new Date().toISOString();
    await getStore().putNotebookAndEnqueue(
      { ...nb, name, updatedAt: now },
      {
        id: crypto.randomUUID(),
        recordId: id,
        payload: { id, baseVersion: nb.version, draft: { name, defaultCollectionView: nb.defaultCollectionView, noteSort: nb.noteSort as NoteSort } },
        createdAt: now,
      },
    );
  },

  /**
   * Set the per-notebook NOTE-SORT mode (§5.3). A clone of {@link rename} that varies `noteSort` instead of
   * `name` — same CAS + enqueue + server SET path (renameNotebook carries noteSort alongside name +
   * defaultCollectionView). Synced so the sort follows Jim across devices. No-op on missing/deleted.
   */
  async setNoteSort(id: NotebookId, noteSort: NoteSort): Promise<void> {
    const nb = await getStore().getNotebook(id);
    if (!nb || nb.deletedAt !== null) return;
    const now = new Date().toISOString();
    await getStore().putNotebookAndEnqueue(
      { ...nb, noteSort, updatedAt: now },
      {
        id: crypto.randomUUID(),
        recordId: id,
        payload: { id, baseVersion: nb.version, draft: { name: nb.name, defaultCollectionView: nb.defaultCollectionView, noteSort } },
        createdAt: now,
      },
    );
  },

  /**
   * Set the per-notebook default COLLECTION VIEW ('list' | 'board' | future 'kanban'…) (§7). A clone of
   * {@link rename}/{@link setNoteSort} that varies `defaultCollectionView` — same CAS + enqueue + server SET
   * (renameNotebook already carries defaultCollectionView). The field is a server-opaque free string so a new
   * view needs ZERO server/schema change. Synced so the chosen view follows Jim across devices. No-op on
   * missing/deleted.
   */
  async setDefaultCollectionView(id: NotebookId, view: string): Promise<void> {
    const nb = await getStore().getNotebook(id);
    if (!nb || nb.deletedAt !== null) return;
    const now = new Date().toISOString();
    await getStore().putNotebookAndEnqueue(
      { ...nb, defaultCollectionView: view, updatedAt: now },
      {
        id: crypto.randomUUID(),
        recordId: id,
        payload: { id, baseVersion: nb.version, draft: { name: nb.name, defaultCollectionView: view, noteSort: nb.noteSort as NoteSort } },
        createdAt: now,
      },
    );
  },

  async delete(id: NotebookId): Promise<void> {
    const nb = await getStore().getNotebook(id);
    if (!nb || nb.deletedAt !== null) return;
    const now = new Date().toISOString();
    // Uncategorize notes locally so they fall back to All Notes immediately (#58: server also
    // uncategorizes on delete — no longer trashes). Next pull confirms the server-side move.
    await getStore().uncategorizeNotesInNotebook(id);
    await getStore().putNotebookAndEnqueue(
      { ...nb, deletedAt: now, updatedAt: now },
      {
        id: crypto.randomUUID(),
        recordId: id,
        payload: { id, baseVersion: nb.version, delete: true },
        createdAt: now,
      },
    );
  },
};
