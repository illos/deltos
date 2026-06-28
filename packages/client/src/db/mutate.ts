import type { Note, NoteId } from '@deltos/shared';
import { setTrashedAt, userProperties, setFileType, UNSYNCED_VERSION } from '@deltos/shared';
import { getStore } from './store.js';
import type { ClientNote } from './schema.js';
import { newNoteId } from '../lib/ids.js';
import { getDefaultNotebookId } from '../lib/notebooks.js';
import { useAuthStore } from '../auth/store.js';

/**
 * The write API for synced notes. Call mutateNotes.* for every note write — never write the
 * persistence layer directly. The row and the syncQueue entry land in ONE transaction
 * (all-or-nothing, via the store's putNoteAndEnqueue), leaving no window where a mutation exists
 * locally but isn't queued. Depends only on the LocalStore seam, never on Dexie.
 *
 * putNoteAndEnqueue is data-layer-version-authoritative: it stores the note + enqueues using the
 * CURRENT persisted version as both the row version and the CAS baseVersion, ignoring a stale caller
 * note.version. So EVERY method below is a plain upsert at the live CAS base (secSys (A): a stale or
 * replayed trash/restore toggle CAS-misses a newer edit — `updateNote` version CAS — instead of
 * clobbering it; never last-write-wins). Trash (Fork P) is just a system-property edit on the bag, so
 * it rides the existing upsert push path with no wire/op change.
 */
export const mutateNotes = {
  /** Upsert (create/edit). */
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
   * Soft-delete (swipe / Delete) — undoable trash. Sets the reserved `sys:trashedAt` system property
   * (via setTrashedAt) so the note leaves the main list (observeNotes excludes trashed) but SURVIVES
   * for undo + sync, then enqueues a plain upsert (rides updateNote's version CAS). Not a hard delete:
   * never use LocalStore.deleteNote (that is the internal pull-merge server-tombstone path).
   */
  async softDelete(note: Note): Promise<void> {
    const trashed: Note = { ...note, properties: setTrashedAt(note.properties, new Date().toISOString()) };
    await getStore().putNoteAndEnqueue(trashed, {
      id: crypto.randomUUID(),
      recordId: note.id,
      payload: trashed,
      baseVersion: note.version,
      createdAt: new Date().toISOString(),
    });
  },

  /**
   * Undo a soft-delete — restore. Clears the trash flag (setTrashedAt(.., null) REMOVES the reserved
   * key, leaving no residue) and enqueues a plain upsert. The note returns to the main list.
   */
  async restore(note: Note): Promise<void> {
    const live: Note = { ...note, properties: setTrashedAt(note.properties, null) };
    await getStore().putNoteAndEnqueue(live, {
      id: crypto.randomUUID(),
      recordId: note.id,
      payload: live,
      baseVersion: note.version,
      createdAt: new Date().toISOString(),
    });
  },

  /**
   * Duplicate ("Copy") — a brand-new note (fresh id → new sync record, no CAS conflict): copied
   * title/body, fresh timestamps, version reseeded (INSERT), current-account scope (server-stamped on
   * first sync, same as NewNote). The copy is always LIVE + clean: reserved system keys are stripped
   * from the bag (userProperties — so duplicating a TRASHED note yields a live copy), and the
   * client-only deletedAt / hasConflict flags are not carried. Returns the new note (e.g. for a toast).
   */
  async duplicate(note: Note): Promise<Note> {
    const now = new Date().toISOString();
    const { deletedAt: _d, hasConflict: _h, ...base } = note as ClientNote;
    const dup: Note = {
      ...base,
      id: crypto.randomUUID() as NoteId,
      properties: userProperties(note.properties), // strip reserved sys: keys → live + clean copy
      version: 0, // fresh note → server INSERTs at the first version
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

  /**
   * Create a FILE NOTE from a foreign file (file-notes.md §5.1) — the note-type sibling of the
   * attachment block, minted from a desktop list-drop (or a future mobile picker). The note's title
   * is the filename, its properties carry the `fileType:'file'` marker (setFileType), and its body is
   * the SINGLE attachment block pointing at the content-addressed R2 blob — the same payload shape the
   * editor insert path produces (buildAttachmentContent/Block), so the two never drift.
   *
   * Upload FIRST and ABORT on failure (no orphan note — a file note with no blob is useless, §5.1).
   * This is the one mutator that also drives a blob upload; every other method is a pure local upsert.
   * The blob client + attachment builder are dynamic-imported so this path (and blobClient) stays OUT
   * of the entry bundle — createFileNote is only reached from the lazy desktop-drop chunk, never on
   * first paint (perf north-star / gate FN-8).
   */
  async createFileNote(file: File): Promise<Note> {
    const [{ uploadBlob }, { buildAttachmentContent, buildAttachmentBlock }] = await Promise.all([
      import('../plugins/attachment/blobClient.js'),
      import('../plugins/attachment/attachmentBlock.js'),
    ]);
    const { hash, size } = await uploadBlob(file);
    const now = new Date().toISOString();
    const content = buildAttachmentContent(file, { hash, size });
    const note: Note = {
      id: newNoteId(),
      notebookId: getDefaultNotebookId(),
      title: file.name,
      properties: setFileType({}),
      body: [buildAttachmentBlock(content)],
      version: UNSYNCED_VERSION,
      createdAt: now,
      updatedAt: now,
      syncStatus: 'local-only',
      accountId: useAuthStore.getState().accountId ?? undefined,
    };
    await getStore().putNoteAndEnqueue(note, {
      id: crypto.randomUUID(),
      recordId: note.id,
      payload: note,
      baseVersion: note.version,
      createdAt: now,
    });
    return note;
  },
};
