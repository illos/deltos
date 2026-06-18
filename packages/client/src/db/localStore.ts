import type { Note, NoteId, NotebookId } from '@deltos/shared';
import type { ClientNote, NotebookRow, NoteVersion, SyncQueueEntry, NotebookQueueEntry } from './schema.js';

/** Conflict resolution actions (UX-called) — values match the spec + UX button labels. */
export type ConflictResolution = 'keep-mine' | 'keep-theirs' | 'keep-both';

/**
 * LocalStore — the pluggable persistence + reactive-query seam for the client.
 *
 * Surfaces (components/routes) and the sync engine depend ONLY on this interface, NEVER on Dexie
 * types (Table / EntityTable / Collection / liveQuery handles). The Dexie implementation
 * (`dexieLocalStore`) is one adapter; a native-SQLite adapter drops in without touching a single
 * consumer. Reactivity crosses the boundary as a plain `subscribe(cb) -> Unsubscribe` + value
 * snapshots — no library-specific live handle leaks — so swapping the reactivity engine later is a
 * non-breaking add (planSys: build (a) now, shaped so (b) is non-breaking).
 *
 * F7 HARD GATE (planSys, secSys 30-day-TTL clearance is VOID if violated): this layer has NO method
 * to store a session / bearer token, and no adapter may add one. The token is IN-MEMORY ONLY
 * (gruntSys2's Zustand store); it has deliberately no at-rest home here — not a Dexie table, not
 * localStorage, not a cold-start cache. Keep it that way.
 *
 * The correctness-critical sync operations (applyAccepted / applyConflict / mergeServerNotes) keep
 * the Stream-B data-loss invariants (PIN-SYNC-1, selective-vs-blanket drain, pending-edit pull
 * guard) — the adapter holds the transaction + conditional-write MECHANICS; the contract here names
 * the INTENT so a second adapter must satisfy the same guarantees. See
 * `sync-pushqueued-drain-invariants` before touching the accepted/conflict asymmetry.
 */

/** A reactive subscription: fires `cb` on change; call the returned fn to stop observing. */
export type Unsubscribe = () => void;

export interface LocalStore {
  // --- notes: single-row reads/writes used by surfaces + the sync engine ---
  getNote(id: NoteId): Promise<ClientNote | undefined>;
  putNote(note: Note): Promise<void>;
  deleteNote(id: NoteId): Promise<void>;

  /** Reactive single-note read for a surface; `cb` gets the current note (or undefined) on each change. */
  observeNote(id: NoteId, cb: (note: ClientNote | undefined) => void): Unsubscribe;

  /** Reactive list of ALL account LIVE notes (trashed + tombstone-state excluded), updatedAt desc. */
  observeNotes(cb: (notes: ClientNote[]) => void): Unsubscribe;

  /**
   * Reactive list of ALL account TRASHED notes (Fork P soft-delete) — the exact inverse of
   * observeNotes' trash exclusion (one shared, fail-safe predicate, so the two can't drift), sorted
   * most-recently-trashed first. Powers the trash view.
   */
  observeTrashedNotes(cb: (notes: ClientNote[]) => void): Unsubscribe;

  // --- conflict-as-version (Part 2) ---
  /**
   * Reactive list of a note's retained conflict-version snapshots — accountId-SCOPED (client-side
   * D6, via the [noteId+accountId] index) so a multi-account-on-one-device case can never surface
   * another account's versions.
   */
  observeNoteVersions(noteId: NoteId, accountId: string, cb: (versions: NoteVersion[]) => void): Unsubscribe;

  /**
   * Resolve a note's conflict (UX-called), atomic + accountId-scoped:
   * - keep-mine: the divergent version becomes the note's live content, enqueued as a new edit at the
   *   CURRENT server version (push CAS-updates on top); delete the versions; clear hasConflict.
   * - keep-theirs: delete the versions; server content stays live; clear hasConflict.
   * - keep-both: retain the version rows (Phase-3 browsable); clear hasConflict (no auto second note).
   */
  resolveConflict(noteId: NoteId, resolution: ConflictResolution, accountId: string): Promise<void>;

  // --- sync queue: the Stream-B drainer's domain ---
  /** All queue entries (the engine dedupes/filters per notebook itself). */
  queueEntries(): Promise<SyncQueueEntry[]>;
  /** Count of queued entries; reactive variant powers the sync indicator. */
  queueCount(): Promise<number>;
  observeQueueCount(cb: (count: number) => void): Unsubscribe;

  /**
   * The atomic write path (mutate.ts): put the note AND enqueue its sync entry in ONE transaction,
   * leaving no window where a mutation exists locally but is not yet queued.
   */
  putNoteAndEnqueue(note: Note, entry: SyncQueueEntry): Promise<void>;

  // --- sync-engine reconcile (correctness-critical; mechanics live in the adapter) ---
  /**
   * Push ACCEPTED reconcile (PIN-SYNC-1), atomic: (a) set the note's version + synced status; (b)
   * drain ONLY the pushed entry + strictly-OLDER superseded entries for this record — a same- or
   * later-millisecond in-flight edit MUST survive (the silent-data-loss guard); (c) reconcile any
   * surviving entry's baseVersion to the accepted version so it pushes next cycle as a CAS UPDATE,
   * not a stale-baseVersion re-INSERT. SELECTIVE drain — never unify with applyConflict's blanket.
   */
  applyAccepted(recordId: NoteId, version: number, pushedEntryId: string, pushedCreatedAt: string): Promise<void>;

  /**
   * Push CONFLICT reconcile — conflict-as-version (Part 2), atomic over notes + noteVersions +
   * syncQueue: (1) RETAIN the CURRENT local note (reflecting any in-flight edit) as a `noteVersions`
   * snapshot keyed to the SAME id (kind:'conflict', accountId-stamped — client D6) — never a new-id
   * fork; (2) ADOPT the server state as the note's LIVE content, or when `serverNote` is null
   * (server tombstone / PIN-SYNC-3) retain the row as a `deletedAt` tombstone-state so keep-mine can
   * resurrect; (3) set `hasConflict`; (4) BLANKET-drain the record's queue entries (asymmetry
   * preserved — never unify with applyAccepted's selective drain). No-op if no local note exists.
   */
  applyConflict(recordId: NoteId, serverNote: Note | null, accountId: string, baseVersion: number): Promise<void>;

  /**
   * Pull MERGE (PIN-SYNC-2 + pending-edit guard), atomic over BOTH notes AND the sync queue: compute
   * the pending-edit record ids INSIDE this transaction, then apply `liveNotes` (put) / `tombstones`
   * (delete), skipping any pending id. Computing pendingIds in-transaction (NOT as a prior separate
   * read) closes a TOCTOU silent-loss window: a concurrent putNoteAndEnqueue — which also locks
   * notes+queue — serializes against this, so its edit is either seen as pending (guarded) or applied
   * strictly AFTER the merge (note not stomped). An id with a pending edit is reconciled by the push
   * path, never stomped by pull.
   */
  mergeServerNotes(liveNotes: Note[], tombstones: NoteId[]): Promise<void>;

  // --- notebooks mirror ---
  getNotebook(id: NotebookId): Promise<NotebookRow | undefined>;
  putNotebook(row: NotebookRow): Promise<void>;
  /** Reactive list of all live (non-deleted) notebooks, sorted by name asc. */
  observeNotebooks(cb: (notebooks: NotebookRow[]) => void): Unsubscribe;
  /**
   * Atomic notebook write + queue entry: notebook row + queue entry land in one transaction.
   * Only writer for notebook CRUD (create/rename/delete via mutateNotebooks).
   */
  putNotebookAndEnqueue(row: NotebookRow, entry: NotebookQueueEntry): Promise<void>;
  /** All notebook queue entries (the sync engine dedupes before pushing). */
  notebookQueueEntries(): Promise<NotebookQueueEntry[]>;
  /** Remove a single notebook queue entry after it has been pushed (accepted or conflict-resolved). */
  drainNotebookQueueEntry(id: string): Promise<void>;
  /** Update the notebook's confirmed server version after a push is accepted. */
  updateNotebookVersion(id: NotebookId, version: number): Promise<void>;

  /**
   * Local-only trash cascade: set sys:trashedAt on every live note in the notebook.
   * Called when a notebook is deleted locally so its notes leave the main list immediately,
   * mirroring the server-side cascade that the next pull will confirm. No sync-queue entry
   * is added — the server handles the authoritative delete.
   */
  trashNotesInNotebook(notebookId: NotebookId, trashedAtTimestamp: string): Promise<void>;
}
