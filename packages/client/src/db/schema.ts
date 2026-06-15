import Dexie, { type EntityTable } from 'dexie';
import type { Note, NotebookId } from '@deltos/shared';

/**
 * A locally-mirrored notebook entry. Notebooks are server-authoritative; the client holds a
 * read-only mirror populated on boot and reconnect. Never written via syncQueue.
 */
export interface NotebookRow {
  id: NotebookId;
  name: string;
  updatedAt: string;
}

/**
 * One entry in the outbound sync queue. The sync engine (Stream B) is the sole reader/drainer.
 * `mutateNotes.put()` is the only writer — never call db.notes.put() directly.
 *
 * baseVersion carries the CAS precondition: the note's last-confirmed server version at the
 * moment the client made this edit. The worker checks `WHERE version = baseVersion` and forks
 * rather than silently clobbering if the server has moved on.
 */
export interface SyncQueueEntry {
  id: string;           // queue-scoped UUID (not a NoteId)
  recordId: string;     // note.id — used for latest-wins dedup by Stream B's push path
  payload: Note;        // full note snapshot at write time
  baseVersion: number;  // note.version at write time — the atomic CAS precondition
  createdAt: string;    // ISO-8601, queue ordering key
}

class DeltosDB extends Dexie {
  notes!: EntityTable<Note, 'id'>;
  syncQueue!: EntityTable<SyncQueueEntry, 'id'>;
  notebooks!: EntityTable<NotebookRow, 'id'>;

  constructor() {
    super('deltos');
    this.version(1).stores({
      // notes: primary + per-notebook cursor index ([notebookId+updatedAt])
      notes: 'id, notebookId, updatedAt, [notebookId+updatedAt]',
      // syncQueue: primary + per-note dedup index (recordId) + ordering index
      syncQueue: 'id, recordId, createdAt',
      // notebooks: primary only — mirror is small, full re-pull on reconnect
      notebooks: 'id',
    });
  }
}

export const db = new DeltosDB();
