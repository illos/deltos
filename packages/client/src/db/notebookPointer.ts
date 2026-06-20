import { NotebookIdSchema } from '@deltos/shared';
import type { NotebookId } from '@deltos/shared';
import { db } from './schema.js';

export const CURRENT_NOTEBOOK_KEY = 'current-notebook';

/** The old localStorage key (Phase-1 stub). Used once for migration then discarded. */
export const LEGACY_DEFAULT_NB_LS_KEY = 'deltos.defaultNotebookId';

export async function readCurrentNotebookId(): Promise<NotebookId | null> {
  const row = await db.deviceState.get(CURRENT_NOTEBOOK_KEY);
  if (!row) return null;
  const parsed = NotebookIdSchema.safeParse(row.value);
  return parsed.success ? parsed.data : null;
}

export async function writeCurrentNotebookId(id: NotebookId): Promise<void> {
  await db.deviceState.put({ key: CURRENT_NOTEBOOK_KEY, value: id });
}

export async function deleteCurrentNotebookId(): Promise<void> {
  await db.deviceState.delete(CURRENT_NOTEBOOK_KEY);
}

/**
 * Bootstrap load: IDB first, then one-time localStorage migration for users upgrading from the
 * Phase-1 stub (getDefaultNotebookId stored in localStorage). Returns null if neither source
 * has a valid ID — caller decides whether to prompt the user or create a default.
 */
export async function loadCurrentNotebookId(): Promise<NotebookId | null> {
  const fromIdb = await readCurrentNotebookId();
  if (fromIdb) return fromIdb;

  if (typeof localStorage !== 'undefined') {
    const raw = localStorage.getItem(LEGACY_DEFAULT_NB_LS_KEY);
    if (raw) {
      const parsed = NotebookIdSchema.safeParse(raw);
      if (parsed.success) {
        await writeCurrentNotebookId(parsed.data);
        localStorage.removeItem(LEGACY_DEFAULT_NB_LS_KEY);
        return parsed.data;
      }
    }
  }

  return null;
}
