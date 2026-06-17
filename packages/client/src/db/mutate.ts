import type { Note, NoteId } from '@deltos/shared';
import { getStore } from './store.js';
import type { ClientNote } from './schema.js';

/**
 * The write API for synced notes. Call mutateNotes.* for every note write — never write the
 * persistence layer directly. The row and the syncQueue entry land in ONE transaction
 * (all-or-nothing, via the store's putNoteAndEnqueue), leaving no window where a mutation exists
 * locally but isn't queued. Depends only on the LocalStore seam, never on Dexie.
 *
 * putNoteAndEnqueue is data-layer-version-authoritative: it stores the note + enqueues using the
 * CURRENT persisted version as both the row version and the CAS baseVersion, ignoring a stale
 * caller note.version. So every method below just supplies content + intent (the `op` tag); the base
 * is always correct. The `op` rides on the queue entry, so the existing latest-wins dedup and the
 * accept-selective / conflict-blanket drain asymmetry are untouched (devSys's in-flight-race trace).
 */
export const mutateNotes = {
  /** Upsert (create/edit) — the default sync intent. */
  async put(note: Note): Promise<void> {
    await getStore().putNoteAndEnqueue(note, {
      id: crypto.randomUUID(),
      recordId: note.id,
      payload: note,
      baseVersion: note.version, // overridden to the live version inside putNoteAndEnqueue
      createdAt: new Date().toISOString(),
    });
  },

  /**
   * Soft-delete (swipe / Delete) — atomic, undoable. Marks `deletedAt` so the row leaves the list via
   * the observeNotes `!deletedAt` filter but SURVIVES for undo + sync, and enqueues a `delete` entry
   * (own id+createdAt) so the worker soft-deletes server-side (CAS on the live version). Not a hard
   * delete: never use LocalStore.deleteNote (that is the internal pull-merge server-tombstone path).
   */
  async softDelete(note: Note): Promise<void> {
    const deleted: ClientNote = { ...note, deletedAt: new Date().toISOString() };
    await getStore().putNoteAndEnqueue(deleted, {
      id: crypto.randomUUID(),
      recordId: note.id,
      payload: deleted,
      baseVersion: note.version,
      createdAt: new Date().toISOString(),
      op: 'delete',
    });
  },

  /**
   * Undo a soft-delete — resurrect. Clears `deletedAt` (OMIT it, never set `undefined` —
   * exactOptionalPropertyTypes) and enqueues a `restore` entry so the worker clears the server
   * tombstone (resurrectNote, CAS on the live version). The note returns to the list.
   */
  async restore(note: Note): Promise<void> {
    const { deletedAt: _dropped, ...live } = note as ClientNote;
    await getStore().putNoteAndEnqueue(live, {
      id: crypto.randomUUID(),
      recordId: note.id,
      payload: live,
      baseVersion: note.version,
      createdAt: new Date().toISOString(),
      op: 'restore',
    });
  },

  /**
   * Duplicate ("Copy") — a brand-new note (fresh id → new sync record, no CAS conflict): copied
   * title/body/properties, fresh timestamps, version reseeded (INSERT), current-account scope (the
   * server stamps accountId on first sync, same as a NewNote create). Client-only flags (deletedAt /
   * hasConflict) are NOT copied. Returns the new note for the caller (e.g. the "Duplicated" toast).
   */
  async duplicate(note: Note): Promise<Note> {
    const now = new Date().toISOString();
    const { deletedAt: _d, hasConflict: _h, ...base } = note as ClientNote;
    const dup: Note = {
      ...base,
      id: crypto.randomUUID() as NoteId,
      version: 0, // a fresh note → server INSERTs at the first version
      createdAt: now,
      updatedAt: now,
      syncStatus: 'local-only',
    };
    await getStore().putNoteAndEnqueue(dup, {
      id: crypto.randomUUID(),
      recordId: dup.id,
      payload: dup,
      baseVersion: 0,
      createdAt: now,
    });
    return dup;
  },
};
