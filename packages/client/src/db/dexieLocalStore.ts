import { liveQuery } from 'dexie';
import type { Note, NoteId, NotebookId, SyncStatus } from '@deltos/shared';
import { isTrashed, trashedAt, setTrashedAt } from '@deltos/shared';
import { noteHasContent } from '../lib/noteContent.js';
import { db } from './schema.js';
import type { ClientNote, NotebookRow, NoteVersion, SyncQueueEntry, NotebookQueueEntry } from './schema.js';
import type { ConflictResolution, LocalStore, Unsubscribe } from './localStore.js';

/**
 * "Is this note in the trash?" (Fork P) — the ONE source shared by the main-list exclusion
 * (observeNotes) and the trash-view inclusion (observeTrashedNotes), so the two directions cannot
 * drift. `isTrashed()` is strict-and-FAIL-SAFE (defined via trashedAt() !== null): an absent OR a
 * malformed/non-date sys:trashedAt value reads as NOT trashed → a CORRUPT trash flag leaves the note
 * VISIBLE in the main list (and out of the trash view, so it shows normally — never lost). secSys (B).
 */
const isInTrash = (n: ClientNote): boolean => isTrashed(n.properties);

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

  observeNotes(cb: (notes: ClientNote[]) => void): Unsubscribe {
    const sub = liveQuery(async () => {
      const notes = await db.notes.toArray();
      // The MAIN list excludes (a) client tombstone-state rows (PIN-SYNC-3: a conflict against a
      // server-deleted note keeps the row marked deletedAt for badge + keep-mine resurrection) and
      // (b) trashed notes (Fork P soft-delete). isInTrash is the shared, fail-safe predicate.
      return notes
        .filter((n) => !n.deletedAt && !isInTrash(n))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }).subscribe({ next: cb });
    return () => sub.unsubscribe();
  },

  observeTrashedNotes(cb: (notes: ClientNote[]) => void): Unsubscribe {
    // The TRASH VIEW — the exact inverse of observeNotes' trash exclusion (same isInTrash source).
    // Sorted by when trashed (most-recently-trashed first) via the sys:trashedAt timestamp.
    const sub = liveQuery(async () => {
      const notes = await db.notes.toArray();
      return notes
        .filter((n) => !n.deletedAt && isInTrash(n))
        .sort((a, b) => (trashedAt(b.properties) ?? '').localeCompare(trashedAt(a.properties) ?? ''));
    }).subscribe({ next: cb });
    return () => sub.unsubscribe();
  },

  // --- conflict-as-version (Part 2) ---
  observeNoteVersions(noteId: NoteId, accountId: string, cb: (versions: NoteVersion[]) => void): Unsubscribe {
    // accountId-SCOPED via the [noteId+accountId] compound index (client-side D6).
    const sub = liveQuery(() =>
      db.noteVersions.where('[noteId+accountId]').equals([noteId, accountId]).toArray(),
    ).subscribe({ next: cb });
    return () => sub.unsubscribe();
  },

  async resolveConflict(noteId: NoteId, resolution: ConflictResolution, accountId: string): Promise<void> {
    // Atomic over notes + noteVersions + syncQueue; all version ops are accountId-scoped.
    await db.transaction('rw', db.notes, db.noteVersions, db.syncQueue, async () => {
      if (resolution === 'keep-mine') {
        const note = await db.notes.get(noteId);
        const versions = await db.noteVersions.where('[noteId+accountId]').equals([noteId, accountId]).toArray();
        const latest = versions.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        if (note && latest) {
          // The divergent version becomes the note's LIVE content, enqueued as a new edit at the
          // CURRENT server version so the push CAS-updates on top (not a stale-base re-INSERT). Drop
          // deletedAt (omit, not set-undefined — exactOptionalPropertyTypes) so a tombstone-state note
          // is RESURRECTED back into the list when the user keeps their edit.
          const { deletedAt: _resurrected, ...base } = note;
          const live: ClientNote = {
            ...base,
            title: latest.title,
            properties: latest.properties,
            body: latest.body,
            syncStatus: 'local-only' satisfies SyncStatus,
            hasConflict: false,
          };
          await db.notes.put(live);
          await db.syncQueue.add({
            id: crypto.randomUUID(),
            recordId: noteId,
            payload: live,
            baseVersion: note.version, // CAS on the current server version
            createdAt: new Date().toISOString(),
          });
        }
      }
      if (resolution === 'keep-mine' || resolution === 'keep-theirs') {
        // mine: the version is now live; theirs: discard the divergent. Either way drop the snapshots.
        await db.noteVersions.where('[noteId+accountId]').equals([noteId, accountId]).delete();
      }
      // keep-both retains the version rows (Phase-3 browsable). ALL resolutions clear the unresolved flag.
      await db.notes.where('id').equals(noteId).modify((n) => {
        (n as ClientNote).hasConflict = false;
      });
    });
  },

  // --- session history capture (#45) ---
  async captureSessionVersion(version: NoteVersion, retentionCap: number): Promise<void> {
    // Insert + prune atomically, all scoped to [noteId+accountId] (client D6). The capture layer has
    // already decided this checkpoint is material and precomputed the delta — this is the write + prune.
    await db.transaction('rw', db.noteVersions, async () => {
      await db.noteVersions.add(version);
      // Prune only OUR 'session' rows beyond the cap; conflict rows are untouched (resolution clears them).
      const sessions = (
        await db.noteVersions.where('[noteId+accountId]').equals([version.noteId, version.accountId]).toArray()
      )
        .filter((v) => v.kind === 'session')
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)); // oldest first
      const excess = sessions.length - retentionCap;
      if (excess > 0) {
        await db.noteVersions.bulkDelete(sessions.slice(0, excess).map((v) => v.id));
      }
    });
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
    //
    // The `version` field is DATA-LAYER-OWNED (sync-authoritative): a local CONTENT write must never
    // regress it, nor enqueue a stale CAS baseVersion. So use the CURRENT persisted version (kept
    // fresh by applyAccepted / pull) as BOTH the stored version and the entry's baseVersion — a
    // caller's possibly-stale `note.version` (e.g. an editor still holding the pre-sync version) is
    // ignored. This kills the phantom-conflict loop: without it, a same-content save at a stale base
    // CAS-misses the server on every sync tick (a single device, no second device, conflict ~every
    // cadence). A brand-new note (no existing row) keeps `note.version` (0 → INSERT). An in-flight
    // edit's base is still reconciled forward by applyAccepted, so edit-while-syncing is unaffected.
    //
    // Push-deferral (#32): a newly-created blank note (version=0, !noteHasContent) never enters the
    // queue. The note is saved to IDB so the editor can populate it; the first content edit arms the
    // push normally (version still 0, but noteHasContent → true → queue entry added). This closes
    // the B3 resurrection gap without a server-side delete: a blank note that was never pushed cannot
    // be restored by a server pull. Existing synced notes cleared to blank (version>0) still enqueue
    // so their blank content persists on the server per-interim design (see pilot note on #32 scope).
    await db.transaction('rw', db.notes, db.syncQueue, async () => {
      const existing = await db.notes.get(note.id);
      const version = existing ? existing.version : note.version;
      const isMove = existing ? existing.notebookId !== note.notebookId : false;
      const synced: Note = { ...note, version };
      await db.notes.put(synced);
      const isNewBlank = version === 0 && !noteHasContent(note);
      if (!isNewBlank) {
        await db.syncQueue.add({ ...entry, payload: synced, baseVersion: version, ...(isMove ? { isMove: true } : {}) });
      }
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

  async applyConflict(recordId: NoteId, serverNote: Note | null, accountId: string, baseVersion: number): Promise<void> {
    // conflict-as-version (Part 2): retain the divergent edit as a version of the SAME note id,
    // adopt server state as live, flag the conflict — never a new-id fork.
    await db.transaction('rw', db.notes, db.noteVersions, db.syncQueue, async () => {
      const local = await db.notes.get(recordId);
      if (!local) return; // nothing local diverged — nothing to retain

      // (1) RETAIN the current local note (reflecting any in-flight edit) as a conflict version,
      // keyed to the SAME id, accountId-stamped (client D6). The no-lost-edit retention, re-expressed.
      await db.noteVersions.add({
        id: crypto.randomUUID(),
        noteId: recordId,
        accountId,
        kind: 'conflict',
        title: local.title,
        properties: local.properties,
        body: local.body,
        baseVersion, // the CAS precondition the divergent edit was authored against (pushed entry's baseVersion)
        createdAt: new Date().toISOString(),
      });

      // (2) ADOPT server state as LIVE + (3) set hasConflict — same note id (no fork).
      if (serverNote) {
        await db.notes.put({ ...serverNote, syncStatus: 'synced' satisfies SyncStatus, hasConflict: true });
      } else {
        // PIN-SYNC-3: server tombstoned the note. Retain the row as a deletedAt tombstone-state (NOT
        // hard-deleted) carrying hasConflict, so the badge + keep-mine resurrection work.
        await db.notes.put({
          ...local,
          deletedAt: new Date().toISOString(),
          syncStatus: 'synced' satisfies SyncStatus,
          hasConflict: true,
        });
      }

      // (4) BLANKET drain — correct ONLY here: keeping the in-flight entry would re-push the
      // now-server state. Never unify with applyAccepted's selective drain.
      await db.syncQueue.where('recordId').equals(recordId).delete();
    });
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

  observeNotebooks(cb: (notebooks: NotebookRow[]) => void): Unsubscribe {
    const sub = liveQuery(async () => {
      const all = await db.notebooks.toArray();
      return all
        .filter((nb) => nb.deletedAt === null)
        .sort((a, b) => a.name.localeCompare(b.name));
    }).subscribe({ next: cb });
    return () => sub.unsubscribe();
  },

  async putNotebookAndEnqueue(row: NotebookRow, entry: NotebookQueueEntry): Promise<void> {
    await db.transaction('rw', db.notebooks, db.notebookQueue, async () => {
      await db.notebooks.put(row);
      await db.notebookQueue.add(entry);
    });
  },

  notebookQueueEntries(): Promise<NotebookQueueEntry[]> {
    return db.notebookQueue.toArray();
  },

  async drainNotebookQueueEntry(id: string): Promise<void> {
    await db.notebookQueue.delete(id);
  },

  async updateNotebookVersion(id: NotebookId, version: number): Promise<void> {
    await db.notebooks.where('id').equals(id).modify((nb: NotebookRow) => {
      nb.version = version;
    });
  },

  async trashNotesInNotebook(notebookId: NotebookId, trashedAtTimestamp: string): Promise<void> {
    // Local-only cascade: no sync queue entries (server handles the authoritative delete).
    const notes = await db.notes.where('notebookId').equals(notebookId).toArray();
    const live = notes.filter((n) => !n.deletedAt && !isInTrash(n));
    await Promise.all(live.map((n) =>
      db.notes.put({ ...n, properties: setTrashedAt(n.properties, trashedAtTimestamp) }),
    ));
  },

  async uncategorizeNotesInNotebook(notebookId: NotebookId): Promise<void> {
    // Set notebookId → null so notes fall into All Notes (uncategorized).
    // Uses the notebookId index; null-notebookId rows are excluded from that index by Dexie (correct).
    await db.notes.where('notebookId').equals(notebookId).modify((n: ClientNote) => {
      n.notebookId = null;
    });
  },

  async discardBlankNote(id: NoteId): Promise<void> {
    await db.transaction('rw', db.notes, db.syncQueue, async () => {
      const note = await db.notes.get(id);
      if (!note) return;
      if (note.title !== '' || note.body.length > 0) return;
      await db.notes.delete(id);
      await db.syncQueue.where('recordId').equals(id).delete();
    });
  },
};
