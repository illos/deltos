import Dexie, { type EntityTable } from 'dexie';
import type { Note, NoteId, NotebookId } from '@deltos/shared';
import type { NotebookPushEntry } from '@deltos/shared';

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
 * A retained whole-note snapshot keyed to the SAME note id (never a new-id fork). `accountId` is the
 * client-side D6 scope (stamped from the session principal, never the body). Two kinds share this store
 * and the one chronological timeline (#45):
 *   - `'conflict'` — a CAS-conflict divergence retained by the sync engine (PART 2 conflict-as-version).
 *   - `'session'`  — a coalesced edit-session checkpoint captured by the history layer (idle-settle /
 *     on-leave / big-change). Carries the precomputed split char-delta so the timeline never recomputes.
 * `charsAdded`/`charsRemoved` are precomputed at capture vs the previous snapshot; present on `'session'`
 * rows, absent on `'conflict'` rows (the conflict path predates them). Versions are client-only (unsynced)
 * in v1. Per-block history stays Phase 3 (whole-note grain here, per S2).
 */
export interface NoteVersion {
  id: string;            // version-row UUID (PK)
  noteId: NoteId;        // the note this version belongs to — SAME id
  accountId: string;     // client-side D6 scope (session principal)
  kind: 'conflict' | 'session';
  title: string;
  properties: Note['properties'];
  body: Note['body'];
  baseVersion: number;   // conflict: the server version the divergent edit was authored against;
                         // session: the note's current local version at capture (informational).
  createdAt: string;     // ISO-8601 Z (when retained/captured)
  charsAdded?: number;   // 'session' only — precomputed split delta vs the previous snapshot.
  charsRemoved?: number; // 'session' only.
}

/**
 * A locally-mirrored notebook entry. Synced entity with full server state; the client also
 * queues mutations via notebookQueue and merges pull results into this table.
 */
export interface NotebookRow {
  id: NotebookId;
  name: string;
  defaultCollectionView: string;
  isDefault: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  syncSeq: number;
}

/**
 * Per-device key-value state that is NEVER synced. Used for device-local pointers such as the
 * current-notebook selection (NOT localStorage — iOS evicts localStorage on storage pressure;
 * IDB survives. See e4-cold-reload-fix / cold-reload-rehydration-guard memories).
 */
export interface DeviceStateRow {
  key: string;
  value: string;
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
  isMove?: boolean;     // true when the note's notebookId changed (explicit move signal)
}

/**
 * One entry in the outbound notebook sync queue. The sync engine dedupes by recordId before
 * pushing. Only writer is mutateNotebooks (create/rename/delete).
 */
export interface NotebookQueueEntry {
  id: string;            // queue-scoped UUID
  recordId: NotebookId;  // notebook id — dedup key
  payload: NotebookPushEntry;
  createdAt: string;
}

class DeltosDB extends Dexie {
  notes!: EntityTable<ClientNote, 'id'>;
  syncQueue!: EntityTable<SyncQueueEntry, 'id'>;
  notebooks!: EntityTable<NotebookRow, 'id'>;
  noteVersions!: EntityTable<NoteVersion, 'id'>;
  deviceState!: EntityTable<DeviceStateRow, 'key'>;
  notebookQueue!: EntityTable<NotebookQueueEntry, 'id'>;

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
    this.version(5).stores({
      // Per-device key-value state (never synced): current-notebook pointer, etc.
      deviceState: 'key',
    });
    this.version(6).stores({
      notebookQueue: 'id, recordId, createdAt',
    });
  }
}

export const db = new DeltosDB();
