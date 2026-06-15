import { NotebookIdSchema } from '@deltos/shared';
import type { NotebookId } from '@deltos/shared';
import { newNotebookId } from './ids.js';

const STORAGE_KEY = 'deltos.defaultNotebookId';

/**
 * Phase 1 stub: returns a stable default notebook ID, persisted in localStorage.
 * Stream A (identity layer) replaces this with a real notebook bound to the account once
 * passkey unlock and device registration are wired in.
 */
export function getDefaultNotebookId(): NotebookId {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    const parsed = NotebookIdSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
  }
  const id = newNotebookId();
  localStorage.setItem(STORAGE_KEY, id);
  return id;
}
