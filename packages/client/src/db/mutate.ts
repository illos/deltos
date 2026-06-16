import type { Note } from '@deltos/shared';
import { getStore } from './store.js';

/**
 * The write API for synced notes. Call mutateNotes.put() for every note write — never write the
 * persistence layer directly. The row and the syncQueue entry land in ONE transaction
 * (all-or-nothing, via the store's putNoteAndEnqueue), leaving no window where a mutation exists
 * locally but isn't queued. Depends only on the LocalStore seam, never on Dexie.
 */
export const mutateNotes = {
  async put(note: Note): Promise<void> {
    await getStore().putNoteAndEnqueue(note, {
      id: crypto.randomUUID(),
      recordId: note.id,
      payload: note,
      baseVersion: note.version, // CAS precondition: what the server had when we started editing
      createdAt: new Date().toISOString(),
    });
  },
};
