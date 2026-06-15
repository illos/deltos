import { db } from './schema.js';
import type { Note } from '@deltos/shared';

/**
 * The write API for synced notes. Call mutateNotes.put() for every note write — never
 * db.notes.put() directly. Both the row and the syncQueue entry must land in one transaction
 * (all-or-nothing), leaving no window where a mutation exists locally but isn't queued.
 */
export const mutateNotes = {
  async put(note: Note): Promise<void> {
    await db.transaction('rw', db.notes, db.syncQueue, async () => {
      await db.notes.put(note);
      await db.syncQueue.add({
        id: crypto.randomUUID(),
        recordId: note.id,
        payload: note,
        baseVersion: note.version,   // CAS precondition: what the server had when we started editing
        createdAt: new Date().toISOString(),
      });
    });
  },
};
