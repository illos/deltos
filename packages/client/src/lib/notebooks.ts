import type { NotebookId } from '@deltos/shared';
import { useNotebookStore } from './notebookStore.js';

/**
 * Returns the current notebook ID. Only valid inside AuthedShell after `notebookStore.init()`
 * has resolved and `currentNotebookId` is non-null (i.e. routes only render in that state).
 *
 * Phase-1 stub used localStorage; this version reads from the Zustand/IDB-backed store.
 */
export function getDefaultNotebookId(): NotebookId {
  const id = useNotebookStore.getState().currentNotebookId;
  if (!id) throw new Error('[deltos] getDefaultNotebookId() called before notebook is ready');
  return id;
}
