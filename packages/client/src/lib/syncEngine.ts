import { db } from '../db/schema.js';
import type { SyncQueueEntry } from '../db/schema.js';
import type { Note, NoteId, NotebookId, SyncStatus } from '@deltos/shared';
import { NoteResponseSchema } from '@deltos/shared';
import type {
  SyncPushRequest,
  SyncPushResponse,
  SyncPullResponse,
  SyncNote,
} from '@deltos/shared';

/**
 * Stream B sync engine: offline-first write buffer + server-authoritative pull.
 *
 * Guarantees (acceptance criteria from phase-1-vertical-slice.md Stream B):
 *   - PIN-SYNC-1: push uses the CAS baseVersion; the server raises conflicts, never silently loses
 *   - Single-flight: concurrent triggers (debounce + poll + online-event) push a queue entry at
 *     most once; a second call while one is in flight is a no-op
 *   - Edit-while-syncing: edits during an in-flight push land in the queue; local serverVersion
 *     updates synchronously on push success before the next cycle
 *   - Pending-edit pull guard: pull does NOT stomp a note with a pending local edit
 *   - Delete-vs-edit (PIN-SYNC-3): conflict with a tombstone → fork with resurrection label
 */

// ---------------------------------------------------------------------------
// Cursor persistence (per-notebook, per-device, PIN-SYNC-2)
// ---------------------------------------------------------------------------

const CURSOR_KEY = (notebookId: NotebookId) => `deltos.sync.cursor.v1.${notebookId}`;

export function getSyncCursor(notebookId: NotebookId): number {
  return Number(localStorage.getItem(CURSOR_KEY(notebookId)) ?? '0');
}

function setSyncCursor(notebookId: NotebookId, cursor: number): void {
  localStorage.setItem(CURSOR_KEY(notebookId), String(cursor));
}

// ---------------------------------------------------------------------------
// Sync status observable (for the indicator UI)
// ---------------------------------------------------------------------------

export type SyncIndicatorState = 'idle' | 'pending' | 'syncing' | 'offline' | 'error';

type Listener = (state: SyncIndicatorState) => void;
const listeners = new Set<Listener>();
let _state: SyncIndicatorState = 'idle';

export function getSyncState(): SyncIndicatorState {
  return _state;
}

export function subscribeSyncState(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function setState(s: SyncIndicatorState): void {
  if (s === _state) return;
  _state = s;
  listeners.forEach((fn) => fn(s));
}

// ---------------------------------------------------------------------------
// Single-flight guard (PIN-SYNC-1 client gate)
// ---------------------------------------------------------------------------

// Single-flight is keyed PER NOTEBOOK: a global gate would let one notebook's in-flight cycle
// swallow a concurrent trigger for a different notebook (the deferred re-run only knew the
// in-flight notebook's id), silently dropping the other notebook's edits.
const _inFlight = new Set<NotebookId>();
const _pending = new Set<NotebookId>();

/**
 * Trigger a sync cycle for a notebook. If a cycle for THAT notebook is already in progress,
 * marks a re-run needed and returns immediately — the in-progress cycle checks this on completion
 * and re-runs if set. This collapses N concurrent triggers for one notebook (1s-debounce +
 * 30s-poll + online-event) into at most one concurrent push, with at most one deferred follow-up,
 * while leaving other notebooks free to sync concurrently.
 */
export function syncNow(notebookId: NotebookId, apiBase = '/api'): void {
  if (_inFlight.has(notebookId)) {
    _pending.add(notebookId);
    return;
  }
  void runSync(notebookId, apiBase);
}

async function runSync(notebookId: NotebookId, apiBase: string): Promise<void> {
  _inFlight.add(notebookId);
  _pending.delete(notebookId);
  try {
    setState('syncing');
    await pushQueued(notebookId, apiBase);
    await pullUpdates(notebookId, apiBase);
    const remaining = await db.syncQueue.where('id').above('').count(); // any queue left?
    setState(remaining > 0 ? 'pending' : 'idle');
  } catch (err) {
    if (err instanceof TypeError && err.message.includes('fetch')) {
      setState('offline');
    } else {
      setState('error');
    }
  } finally {
    _inFlight.delete(notebookId);
    if (_pending.has(notebookId)) {
      // A trigger for THIS notebook arrived while we were running — honour it with one follow-up.
      void runSync(notebookId, apiBase);
    }
  }
}

// ---------------------------------------------------------------------------
// Push — flush the syncQueue (PIN-SYNC-1)
// ---------------------------------------------------------------------------

/**
 * Collapse the queue for each note to its latest entry (latest-wins dedup within the client's
 * own queue — NOT latest-wins globally; the server's CAS is what prevents global lost-writes).
 */
async function dedupeQueue(notebookId: NotebookId): Promise<SyncQueueEntry[]> {
  const all = await db.syncQueue.toArray();
  // Keep only entries whose note belongs to this notebook
  const forNotebook = all.filter((e) => e.payload.notebookId === notebookId);
  // Latest-wins per note within the queue
  const byNote = new Map<string, SyncQueueEntry>();
  for (const entry of forNotebook.sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    byNote.set(entry.recordId, entry);
  }
  return [...byNote.values()];
}

async function pushQueued(notebookId: NotebookId, apiBase: string): Promise<void> {
  const entries = await dedupeQueue(notebookId);
  if (entries.length === 0) return;

  const BATCH = 50; // keep payloads reasonable
  for (let i = 0; i < entries.length; i += BATCH) {
    const batch = entries.slice(i, i + BATCH);
    const body: SyncPushRequest = {
      notebookId,
      entries: batch.map((e) => ({
        id: e.payload.id,
        draft: {
          title: e.payload.title,
          properties: e.payload.properties,
          body: e.payload.body,
        },
        baseVersion: e.baseVersion,
      })),
    };

    const res = await fetch(`${apiBase}/sync/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`push ${res.status}`);

    const json: SyncPushResponse = await res.json();

    await db.transaction('rw', db.notes, db.syncQueue, async () => {
      for (const result of json.results) {
        // The single (latest-wins deduped) entry we actually pushed for this note.
        const pushed = batch.find((e) => e.payload.id === result.id);

        if (result.outcome === 'accepted') {
          // Update local serverVersion synchronously (edit-while-syncing guarantee).
          await db.notes.where('id').equals(result.id).modify((note: Note) => {
            note.version = result.version;
            note.syncStatus = 'synced' satisfies SyncStatus;
          });

          if (pushed) {
            // Drain ONLY the entry we pushed plus any strictly-older superseded entries for this
            // note. An edit that arrived DURING the in-flight fetch is a NEWER queue entry — it
            // MUST survive. A blanket delete-by-recordId here is the silent-data-loss race: it
            // wipes the in-flight edit, marks the note synced at the server version, empties the
            // queue, and the next pull (carrying the server's pre-edit state) then overwrites the
            // local edit unguarded. Tie-safe on createdAt: match the pushed entry by its own id,
            // older entries by strict-less-than, so a same-millisecond in-flight edit is kept.
            await db.syncQueue
              .where('recordId')
              .equals(result.id)
              .filter((e) => e.id === pushed.id || e.createdAt < pushed.createdAt)
              .delete();

            // Reconcile any surviving in-flight edit to the just-accepted server version, so it
            // pushes next cycle as a CAS UPDATE on top of this version — not as a re-INSERT at the
            // stale baseVersion it was authored at (which the server would fork as a new note).
            await db.syncQueue
              .where('recordId')
              .equals(result.id)
              .modify((e) => { e.baseVersion = result.version; });
          }
        } else {
          // Conflict: server has moved on. handleConflict forks the CURRENT local note (which
          // already reflects any in-flight edit) and adopts server state for the original id, so
          // the in-flight content is preserved in the fork. A blanket drain is correct here —
          // keeping the in-flight entry would re-push the original id (now server state) and
          // double-fork.
          await handleConflict(result.id as NoteId, result.serverNote);
          await db.syncQueue.where('recordId').equals(result.id).delete();
        }
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Conflict resolution — fork-on-conflict (PIN-SYNC-3/4)
// ---------------------------------------------------------------------------

async function handleConflict(
  localId: NoteId,
  serverNote: Note | null,
): Promise<void> {
  const localNote = await db.notes.get(localId);
  if (!localNote) return; // nothing local to fork — discard

  const isResurrection = serverNote === null; // null = server tombstone (PIN-SYNC-3)

  const forkTitle = isResurrection
    ? `(deleted on another device — your edits kept) ${localNote.title}`
    : `(conflict copy) ${localNote.title}`;

  const fork: Note = {
    ...localNote,
    id: crypto.randomUUID() as NoteId,
    title: forkTitle,
    version: 0, // fork starts unsynced; will push as new note
    syncStatus: 'local-only' satisfies SyncStatus,
  };

  // Store fork as a new local-only note (not in syncQueue — it will be pushed next cycle via put)
  await db.notes.put(fork);

  // Adopt server state for the original id (or tombstone if deleted)
  if (serverNote) {
    await db.notes.put({ ...serverNote, syncStatus: 'synced' });
  } else {
    await db.notes.delete(localId);
  }
}

// ---------------------------------------------------------------------------
// Pull — server-authoritative updates (PIN-SYNC-2, pending-edit pull guard)
// ---------------------------------------------------------------------------

async function pullUpdates(notebookId: NotebookId, apiBase: string): Promise<void> {
  const cursor = getSyncCursor(notebookId);
  let next = cursor;
  let hasMore = true;

  while (hasMore) {
    const res = await fetch(
      `${apiBase}/sync/pull?notebookId=${encodeURIComponent(notebookId)}&cursor=${next}`,
    );
    if (!res.ok) throw new Error(`pull ${res.status}`);

    const json: SyncPullResponse = await res.json();

    await mergePull(json.notes, notebookId);

    next = json.nextCursor;
    hasMore = json.hasMore;
  }

  if (next !== cursor) setSyncCursor(notebookId, next);
}

/**
 * Apply incoming server notes to the local store.
 *
 * Pending-edit pull guard (PIN-SYNC-1 landmine): if a note has a pending local edit in
 * syncQueue, skip the incoming server update — the push flush will reconcile. This prevents
 * an in-flight pull from overwriting unsent edits.
 *
 * Exported for direct testing (syncEngine.test.ts).
 */
export async function mergePull(notes: SyncNote[], _notebookId: NotebookId): Promise<void> {
  // Collect note IDs that have a pending local edit
  const pendingIds = new Set(
    (await db.syncQueue.toArray()).map((e) => e.recordId),
  );

  await db.transaction('rw', db.notes, async () => {
    for (const serverNote of notes) {
      // Pending-edit pull guard
      if (pendingIds.has(serverNote.id)) continue;

      if (serverNote.deletedAt !== null) {
        // Tombstone: remove the local copy (no local edit to protect — it was cleared above)
        await db.notes.delete(serverNote.id as NoteId);
      } else {
        const note: Note = {
          id: serverNote.id,
          notebookId: serverNote.notebookId,
          title: serverNote.title,
          properties: serverNote.properties,
          body: serverNote.body,
          version: serverNote.version,
          createdAt: serverNote.createdAt,
          updatedAt: serverNote.updatedAt,
          syncStatus: 'synced',
        };
        await db.notes.put(note);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Trigger wiring — call from the app boot
// ---------------------------------------------------------------------------

let _debounceTimer: ReturnType<typeof setTimeout> | null = null;
let _pollTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the sync triggers: 1s debounce on queue writes, 30s poll, and online-event.
 * All funnelled through `syncNow()` so the single-flight guard applies to all three.
 */
export function startSyncTriggers(notebookId: NotebookId, apiBase = '/api'): () => void {
  // Debounce: on any queue write, wait 1s then sync
  const onQueueWrite = () => {
    setState('pending');
    if (_debounceTimer) clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(() => syncNow(notebookId, apiBase), 1000);
  };

  // 30s poll
  _pollTimer = setInterval(() => syncNow(notebookId, apiBase), 30_000);

  // Online recovery
  const onOnline = () => syncNow(notebookId, apiBase);
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', () => setState('offline'));

  // Subscribe to syncQueue table changes via Dexie live query is not straightforward —
  // callers should call onQueueWrite() from mutateNotes.put() via the exported hook below.
  void onQueueWrite; // reference to prevent lint warnings; real wire-up in mutateNotes

  return () => {
    if (_debounceTimer) clearTimeout(_debounceTimer);
    if (_pollTimer) clearInterval(_pollTimer);
    window.removeEventListener('online', onOnline);
  };
}

/**
 * Call this after every `mutateNotes.put()` to trigger the debounced sync.
 * Decoupled so mutate.ts doesn't import syncEngine (avoids a circular dep chain).
 */
export function notifyQueueWrite(notebookId: NotebookId, apiBase = '/api'): void {
  setState('pending');
  if (_debounceTimer) clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(() => syncNow(notebookId, apiBase), 1000);
}

// Re-export for callers that need the NoteResponseSchema (used in pull)
export { NoteResponseSchema };
