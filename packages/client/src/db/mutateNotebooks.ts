import { DEFAULT_COLLECTION_VIEW } from '@deltos/shared';
import type { NotebookId } from '@deltos/shared';
import { getStore } from './store.js';
import { newNotebookId } from '../lib/ids.js';
import type { NotebookRow } from './schema.js';

/**
 * Notebook CRUD mutations — the ONLY writer for notebook rows + notebookQueue.
 * Every operation is atomic: the row and the queue entry land in one transaction.
 *
 * Guards:
 *   - create: always non-default (isDefault is server-owned)
 *   - rename: no-op on missing or already-deleted notebooks
 *   - delete: no-op on default notebooks (server would reject; guard here prevents local confusion)
 */
export const mutateNotebooks = {
  async create(name: string): Promise<NotebookId> {
    const id = newNotebookId();
    const now = new Date().toISOString();
    const row: NotebookRow = {
      id,
      name,
      defaultCollectionView: DEFAULT_COLLECTION_VIEW,
      isDefault: false,
      version: 0,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      syncSeq: 0,
    };
    await getStore().putNotebookAndEnqueue(row, {
      id: crypto.randomUUID(),
      recordId: id,
      payload: { id, baseVersion: 0, draft: { name, defaultCollectionView: DEFAULT_COLLECTION_VIEW } },
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
        payload: { id, baseVersion: nb.version, draft: { name, defaultCollectionView: nb.defaultCollectionView } },
        createdAt: now,
      },
    );
  },

  async delete(id: NotebookId): Promise<void> {
    const nb = await getStore().getNotebook(id);
    if (!nb || nb.deletedAt !== null || nb.isDefault) return;
    const now = new Date().toISOString();
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
