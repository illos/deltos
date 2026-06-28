import Dexie, { type EntityTable, type Table } from 'dexie';
import type { Note, NoteId, NotebookId } from '@deltos/shared';
import type { NotebookPushEntry, DictionaryPushEntry } from '@deltos/shared';

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

/**
 * A locally-mirrored custom-dictionary word (§5.2). Account-synced, SET semantics. The local store only
 * ever holds the resident account's words (wiped on account switch — see db/accountScope.ts); `word` is
 * the identity (PK). `deletedAt` is the tombstone (kept so observeWords filters it + a re-add un-tombstones).
 */
export interface DictionaryWordRow {
  word: string;           // the normalized custom word (trim + lowercase) — primary key
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  syncSeq: number;
}

/**
 * One entry in the outbound dictionary sync queue. The sync engine dedupes by recordId (the word) before
 * pushing. Only writer is the dictionary store (add/remove).
 */
export interface DictionaryQueueEntry {
  id: string;            // queue-scoped UUID
  recordId: string;      // word — dedup key
  payload: DictionaryPushEntry;
  createdAt: string;
}

/**
 * A content-addressed local cache of blob bytes (originals + host-baked webp derivatives), so reopening a
 * PDF/image is instant + offline-capable and never re-races the cold-boot pre-auth window. Bytes are
 * content-addressed (hash) → immutable → safe to cache indefinitely; the cache layer only ever swaps a
 * network fetch for a local read, never changes meaning.
 *
 * ACCOUNT ISOLATION (HARD, #52 lineage): the PK is the COMPOUND `[accountId+resourceKey]`, so account B's
 * read for an identical hash lands on a different row and CANNOT see account A's bytes. The lookup ALWAYS
 * scopes on the resident `accountId` (useAuthStore) — there is no unscoped/global bucket and an unauthed
 * (`accountId===null`) caller neither reads nor writes. The whole table is dropped by `wipeLocalState`
 * (db/accountScope.ts) on every account-switch + logout, exactly like notes.
 *
 * `resourceKey` = `${hash}` for an original, `${hash}:${variant}` for a `thumb`/`view` derivative (distinct
 * content under the same hash). LRU is by `lastAccess` (touched on every hit) under a total-size budget.
 * F7-safe: only bytes + accountId + hash + mime + size are stored — NEVER the bearer/token.
 */
export interface BlobCacheRow {
  accountId: string;     // resident account (data-ownership scope) — half the compound PK
  resourceKey: string;   // `${hash}` | `${hash}:thumb` | `${hash}:view` — the other half of the PK
  bytes: ArrayBuffer;    // the immutable blob bytes
  mime?: string;         // content type (for object-URL typing); absent for raw-bytes (pdf) reads
  size: number;          // byte length — summed for the LRU budget
  lastAccess: number;    // epoch ms, bumped on every hit (informational on the bytes row; the meta sidecar
                         //   below carries the authoritative LRU recency that eviction reads)
}

/**
 * Size-only LRU sidecar mirroring {@link BlobCacheRow} by the SAME compound PK `[accountId+resourceKey]`,
 * holding ONLY the bytes' length + last-access timestamp — never the bytes. Eviction (blobClient) sums sizes
 * and selects oldest-first victims entirely from THIS table, so a normal blob persist never deserializes any
 * cached `ArrayBuffer` to do the budget math (PERF — Jim's load north-star; up to ~200 MB otherwise). Kept in
 * lockstep with `blobCache` on every put/touch/evict, and dropped in the SAME `wipeLocalState` clear.
 */
export interface BlobCacheMetaRow {
  accountId: string;     // resident account — half the compound PK (mirrors blobCache)
  resourceKey: string;   // the other half of the PK (mirrors blobCache)
  size: number;          // byte length — summed for the LRU budget (no bytes loaded)
  lastAccess: number;    // epoch ms, bumped on every hit — the authoritative LRU ordering key
}

class DeltosDB extends Dexie {
  notes!: EntityTable<ClientNote, 'id'>;
  syncQueue!: EntityTable<SyncQueueEntry, 'id'>;
  notebooks!: EntityTable<NotebookRow, 'id'>;
  noteVersions!: EntityTable<NoteVersion, 'id'>;
  deviceState!: EntityTable<DeviceStateRow, 'key'>;
  notebookQueue!: EntityTable<NotebookQueueEntry, 'id'>;
  dictionaryWords!: EntityTable<DictionaryWordRow, 'word'>;
  dictionaryQueue!: EntityTable<DictionaryQueueEntry, 'id'>;
  // Compound primary key [accountId+resourceKey] → typed via Dexie's Table (EntityTable takes a single
  // key-property name; a compound key has none, so the key type is the tuple [accountId, resourceKey]).
  blobCache!: Table<BlobCacheRow, [string, string]>;
  blobCacheMeta!: Table<BlobCacheMetaRow, [string, string]>;

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
    this.version(7).stores({
      // Custom dictionary (§5.2): the word set (PK = word) + its outbound queue (dedup by recordId=word).
      dictionaryWords: 'word, syncSeq',
      dictionaryQueue: 'id, recordId, createdAt',
    });
    this.version(8).stores({
      // Content-addressed local blob cache: COMPOUND PK [accountId+resourceKey] (account isolation — an
      // identical hash under a different account is a different row), + an accountId index (scoped sweeps)
      // and a lastAccess index (LRU eviction by oldest touch).
      blobCache: '[accountId+resourceKey], accountId, lastAccess',
    });
    this.version(9).stores({
      // Size-only LRU sidecar for blobCache: mirrors the compound PK so eviction sums sizes + picks oldest
      // victims WITHOUT deserializing any bytes row (perf — Jim's load north-star). lastAccess index = LRU order.
      blobCacheMeta: '[accountId+resourceKey], lastAccess',
    });
  }
}

export const db = new DeltosDB();
