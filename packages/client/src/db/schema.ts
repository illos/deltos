import Dexie, { type EntityTable } from 'dexie';
import type { Note, NoteId, NotebookId } from '@deltos/shared';

/**
 * The client's stored note shape: the spine {@link Note} plus client-only state. `syncStatus` is
 * already a client-owned field on the spine Note; `hasConflict` is the same class — a client-only
 * flag (default/absent = false) set when an UNRESOLVED conflict version is attached, driving the
 * list badge. `deletedAt` is the client tombstone-state (PIN-SYNC-3): a conflict against a
 * server-deleted note retains the live row marked deleted (not hard-removed) so the badge + keep-mine
 * resurrection still work; `observeNotes` filters it out of the list. Both are client-only (no
 * spine/shared change) — the server never sees them. See docs/design/part2-conflict-version-data-model.md.
 */
export type ClientNote = Note & { hasConflict?: boolean; deletedAt?: string };

/**
 * A retained whole-note snapshot — PART 2 conflict-as-version. On a CAS-conflict the device's
 * divergent edit is kept as a version of the SAME note id (never a new-id fork). `accountId` is the
 * client-side D6 scope (stamped from the session principal, never the body). Phase-3 extends this
 * per-note versions model (kind gains 'history' etc.); v1 retains only 'conflict'.
 */
export interface NoteVersion {
  id: string;            // version-row UUID (PK)
  noteId: NoteId;        // the note this version belongs to — SAME id
  accountId: string;     // client-side D6 scope (session principal)
  kind: 'conflict';
  title: string;
  properties: Note['properties'];
  body: Note['body'];
  baseVersion: number;   // the server version the divergent edit was authored against
  createdAt: string;     // ISO-8601 Z (when retained)
}

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
  /**
   * Sync intent. Absent ≡ 'upsert' (insert/update — the default, backward-compatible). 'delete' =
   * soft-delete (worker → deleteNote, CAS on baseVersion); 'restore' = undo a soft-delete (worker →
   * resurrectNote: clear deletedAt + re-put content, CAS on baseVersion). pushQueued maps this to the
   * wire SyncPushEntry.op (default 'upsert'). The op rides on the entry so the existing latest-wins
   * dedup + accept/conflict drain asymmetry are untouched.
   */
  op?: 'delete' | 'restore';
}

class DeltosDB extends Dexie {
  notes!: EntityTable<ClientNote, 'id'>;
  syncQueue!: EntityTable<SyncQueueEntry, 'id'>;
  notebooks!: EntityTable<NotebookRow, 'id'>;
  noteVersions!: EntityTable<NoteVersion, 'id'>;

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
    this.version(2).stores({
      // Intermediate — accountFingerprint index (superseded by v3 rebind to accountId).
      notes: 'id, notebookId, updatedAt, [notebookId+updatedAt], accountFingerprint',
    });
    this.version(3).stores({
      // Rebind: swap credential-derived accountFingerprint for stable credential-independent accountId.
      notes: 'id, notebookId, updatedAt, [notebookId+updatedAt], accountId',
    });
    this.version(4).stores({
      // PART 2 conflict-as-version: retained whole-note snapshots keyed to the SAME note id.
      // [noteId+accountId] compound index serves the accountId-scoped per-note read (client D6).
      noteVersions: 'id, noteId, [noteId+accountId]',
    });
  }
}

export const db = new DeltosDB();
