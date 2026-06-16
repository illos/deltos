import { liveQuery } from 'dexie';
import type { Note, NoteId, NotebookId, SyncStatus } from '@deltos/shared';
import { db } from './schema.js';
import type { NotebookRow, SyncQueueEntry } from './schema.js';
import type { LocalStore, Unsubscribe } from './localStore.js';

/**
 * The Dexie/IndexedDB implementation of {@link LocalStore}. This is the ONE place Dexie types live;
 * nothing crosses the interface boundary but domain types + plain subscribe/Unsubscribe. A
 * native-SQLite adapter can implement the same interface without any consumer change.
 *
 * The sync-reconcile methods (applyAccepted / applyConflict / mergeServerNotes) are the Stream-B
 * data-loss surface — their Dexie mechanics are RELOCATED here byte-for-byte from the sync engine
 * (selective drain on accept, blanket drain on conflict, pending-edit guard on merge). Do NOT alter
 * the accept/conflict drain asymmetry. See `sync-pushqueued-drain-invariants`.
 *
 * Transaction granularity note: the engine wrapped a whole push BATCH in one transaction; here each
 * record reconciles in its OWN transaction. This is safe because sync is single-flight PER NOTEBOOK
 * (no intra-notebook concurrency), so per-record atomicity preserves every invariant — batch
 * atomicity was incidental (crash-partial-progress only, idempotent on the next cycle). Flagged to
 * secSys at the engine migration for explicit blessing.
 *
 * F7: there is no token storage here, by construction — the interface offers none.
 */
export const dexieLocalStore: LocalStore = {
  // --- notes ---
  getNote(id: NoteId): Promise<Note | undefined> {
    return db.notes.get(id);
  },

  async putNote(note: Note): Promise<void> {
    await db.notes.put(note);
  },

  async deleteNote(id: NoteId): Promise<void> {
    await db.notes.delete(id);
  },

  observeNote(id: NoteId, cb: (note: Note | undefined) => void): Unsubscribe {
    const sub = liveQuery(() => db.notes.get(id)).subscribe({ next: cb });
    return () => sub.unsubscribe();
  },

  observeNotes(notebookId: NotebookId, cb: (notes: Note[]) => void): Unsubscribe {
    const sub = liveQuery(async () => {
      const notes = await db.notes.where('notebookId').equals(notebookId).toArray();
      return notes.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }).subscribe({ next: cb });
    return () => sub.unsubscribe();
  },

  // --- sync queue ---
  queueEntries(): Promise<SyncQueueEntry[]> {
    return db.syncQueue.toArray();
  },

  queueCount(): Promise<number> {
    return db.syncQueue.count();
  },

  observeQueueCount(cb: (count: number) => void): Unsubscribe {
    const sub = liveQuery(() => db.syncQueue.count()).subscribe({ next: cb });
    return () => sub.unsubscribe();
  },

  async putNoteAndEnqueue(note: Note, entry: SyncQueueEntry): Promise<void> {
    // Both the row and the queue entry land in one transaction (all-or-nothing) — no window where a
    // mutation exists locally but is not yet queued.
    await db.transaction('rw', db.notes, db.syncQueue, async () => {
      await db.notes.put(note);
      await db.syncQueue.add(entry);
    });
  },

  // --- sync-engine reconcile (relocated mechanics) ---
  async applyAccepted(
    recordId: NoteId,
    version: number,
    pushedEntryId: string,
    pushedCreatedAt: string,
  ): Promise<void> {
    await db.transaction('rw', db.notes, db.syncQueue, async () => {
      // (a) update local serverVersion synchronously (edit-while-syncing guarantee).
      await db.notes.where('id').equals(recordId).modify((note: Note) => {
        note.version = version;
        note.syncStatus = 'synced' satisfies SyncStatus;
      });
      // (b) SELECTIVE drain: the pushed entry + strictly-older superseded entries ONLY. A same- or
      // later-millisecond in-flight edit is a NEWER entry and MUST survive (the silent-data-loss
      // guard) — match the pushed entry by its own id, older entries by strict-less-than createdAt.
      await db.syncQueue
        .where('recordId')
        .equals(recordId)
        .filter((e) => e.id === pushedEntryId || e.createdAt < pushedCreatedAt)
        .delete();
      // (c) reconcile any surviving in-flight entry to the accepted version, so it pushes next cycle
      // as a CAS UPDATE on this version — not a stale-baseVersion re-INSERT the server would fork.
      await db.syncQueue
        .where('recordId')
        .equals(recordId)
        .modify((e) => {
          e.baseVersion = version;
        });
    });
  },

  async applyConflict(
    recordId: NoteId,
    serverNote: Note | null,
    makeFork: (local: Note) => Note,
  ): Promise<boolean> {
    let forked = false;
    await db.transaction('rw', db.notes, db.syncQueue, async () => {
      const local = await db.notes.get(recordId);
      if (!local) return; // nothing local to fork — discard (forked stays false)

      // Fork the CURRENT local note (reflects any in-flight edit), store as a new local-only note.
      await db.notes.put(makeFork(local));

      // Adopt server state for the original id (or tombstone if the server deleted it).
      if (serverNote) {
        await db.notes.put({ ...serverNote, syncStatus: 'synced' satisfies SyncStatus });
      } else {
        await db.notes.delete(recordId);
      }

      // BLANKET drain — correct ONLY here: keeping the in-flight entry would re-push the now-server
      // state and double-fork. Never unify with applyAccepted's selective drain.
      await db.syncQueue.where('recordId').equals(recordId).delete();
      forked = true;
    });
    return forked;
  },

  async mergeServerNotes(liveNotes: Note[], tombstones: NoteId[]): Promise<void> {
    // Transaction over BOTH notes AND syncQueue, with pendingIds computed INSIDE it. This closes the
    // TOCTOU silent-loss window (secSys): a concurrent putNoteAndEnqueue also locks notes+queue, so it
    // serializes against this merge — its edit is either visible in pendingIds here (guarded) or
    // applied strictly after (note not stomped). Reading pendingIds as a prior separate query (the old
    // shape) let an edit slip into the gap, get stomped, then be silently dropped if the next push
    // conflict-forked the stomped state and blanket-drained the edit's queue entry.
    await db.transaction('rw', db.notes, db.syncQueue, async () => {
      const pendingIds = new Set((await db.syncQueue.toArray()).map((e) => e.recordId));
      for (const id of tombstones) {
        // Pending-edit pull guard: never stomp a note with an unsent local edit (push reconciles it).
        if (pendingIds.has(id)) continue;
        await db.notes.delete(id);
      }
      for (const note of liveNotes) {
        if (pendingIds.has(note.id)) continue;
        await db.notes.put(note);
      }
    });
  },

  // --- notebooks mirror ---
  getNotebook(id: NotebookId): Promise<NotebookRow | undefined> {
    return db.notebooks.get(id);
  },

  async putNotebook(row: NotebookRow): Promise<void> {
    await db.notebooks.put(row);
  },
};
