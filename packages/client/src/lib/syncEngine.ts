import { getStore } from '../db/store.js';
import { useAuthStore } from '../auth/store.js';
import { showConflictToast } from './toastEvents.js';
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
 * The `Authorization: Bearer <grant-token>` header for sync requests. The token is read FRESH from
 * the in-memory auth store at request time (F7: the grant token lives ONLY in memory — Zustand —
 * never persisted at rest; reading it here keeps it that way and picks up a re-unlock's new token).
 * When locked / not yet unlocked the token is null and the header is omitted — the server then
 * resolves no real principal and the F13 tripwire denies in production (sync needs an authed client).
 */
function authHeader(): Record<string, string> {
  const token = useAuthStore.getState().bearerToken;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

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
 *   - Delete-vs-edit (PIN-SYNC-3): conflict with a tombstone → divergent edit retained as a version (resurrectable via keep-mine)
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
    const remaining = await getStore().queueCount(); // any queue left?
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
  const all = await getStore().queueEntries();
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

  // Re-stamp each entry's CAS baseVersion to the CURRENT local note version at push time. The
  // pending-edit pull guard (mergeServerNotes) pins a queued note's local version to whatever the
  // edit was composed on — a remote change can't advance it while an edit for that note is queued —
  // so the live local version IS the correct CAS base. Re-reading it here closes the phantom-conflict
  // loop: a sibling entry enqueued in the WINDOW between a prior push and its applyAccepted carries a
  // momentarily-stale base (the version hadn't advanced yet) that would otherwise CAS-miss the now-
  // advanced server on every cadence tick. A REAL conflict still surfaces — when an un-pulled remote
  // change exists the local version genuinely trails the server, so base < server → conflict. (Belt
  // to the data-layer base-ownership in putNoteAndEnqueue + applyAccepted's survivor reconcile.)
  const baseFor = new Map<string, number>();
  for (const e of entries) {
    const cur = await getStore().getNote(e.recordId as NoteId);
    baseFor.set(e.id, cur ? cur.version : e.baseVersion);
  }

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
        baseVersion: baseFor.get(e.id) ?? e.baseVersion,
      })),
    };

    const res = await fetch(`${apiBase}/sync/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`push ${res.status}`);

    const json: SyncPushResponse = await res.json();

    // Each result reconciles in its own store transaction. Safe because sync is single-flight PER
    // NOTEBOOK (no intra-notebook concurrency), so per-record atomicity preserves every invariant;
    // the per-batch transaction was incidental. The SELECTIVE vs BLANKET drain asymmetry now lives
    // in the store (applyAccepted vs applyConflict) and MUST NOT be unified.
    for (const result of json.results) {
      // The single (latest-wins deduped) entry we actually pushed for this note.
      const pushed = batch.find((e) => e.payload.id === result.id);

      if (result.outcome === 'accepted') {
        if (pushed) {
          // applyAccepted (atomic): set version+synced, SELECTIVE-drain the pushed + strictly-older
          // entries (a same-/later-ms in-flight edit survives — the silent-data-loss guard), and
          // reconcile any survivor's baseVersion to the accepted version.
          await getStore().applyAccepted(result.id as NoteId, result.version, pushed.id, pushed.createdAt);
        }
        // (No `pushed` is structurally impossible — results only come for entries we sent. If it
        // ever occurred there'd be nothing to drain; the note reconciles on the next pull/cycle.)
      } else {
        // Conflict: retain-as-version (Part 2). handleConflict retains the CURRENT local note
        // (reflecting any in-flight edit) as a conflict VERSION on the SAME id, adopts server state
        // as live, and BLANKET-drains the queue — all atomic in applyConflict. Blanket is correct
        // ONLY here; keeping the in-flight entry would re-push the now-server state. The retained
        // version records the baseVersion the divergent edit was authored against = the pushed
        // entry's CAS precondition (NOT the note's current version field).
        await handleConflict(result.id as NoteId, result.serverNote, pushed?.baseVersion ?? 0);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Conflict reconcile — retain-as-version (PIN-SYNC-3/4: no fork; same note id)
// ---------------------------------------------------------------------------

async function handleConflict(
  localId: NoteId,
  serverNote: Note | null,
  baseVersion: number, // the CAS precondition the divergent edit was pushed at — recorded on the version
): Promise<void> {
  // conflict-as-version (Part 2): retain the divergent local edit as a version of the SAME note id
  // (no fork). accountId comes from the session principal (client D6 scope), never a body.
  const accountId = useAuthStore.getState().accountId;
  if (!accountId) return; // no authed session — leave the queue entry; the next cycle retries.

  // Read the live title BEFORE applyConflict adopts server state, for the conflict toast.
  const local = await getStore().getNote(localId);
  await getStore().applyConflict(localId, serverNote, accountId, baseVersion);
  if (local) showConflictToast(localId, local.title); // non-blocking "your version was kept" toast
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
      { headers: authHeader() },
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
  // The engine splits the wire notes into live puts vs tombstone deletes; the store's
  // mergeServerNotes applies both atomically AND computes the pending-edit guard inside its own
  // notes+queue transaction (closing the TOCTOU window — see dexieLocalStore.mergeServerNotes).
  const liveNotes: Note[] = [];
  const tombstones: NoteId[] = [];
  for (const serverNote of notes) {
    if (serverNote.deletedAt !== null) {
      tombstones.push(serverNote.id as NoteId);
    } else {
      liveNotes.push({
        id: serverNote.id,
        notebookId: serverNote.notebookId,
        title: serverNote.title,
        properties: serverNote.properties,
        body: serverNote.body,
        version: serverNote.version,
        createdAt: serverNote.createdAt,
        updatedAt: serverNote.updatedAt,
        syncStatus: 'synced',
      });
    }
  }

  await getStore().mergeServerNotes(liveNotes, tombstones);
}

// ---------------------------------------------------------------------------
// Trigger wiring — call from the app boot
// ---------------------------------------------------------------------------

/**
 * Server-push cadence (planSys-blessed; tunable — do not bury the literals). The radio-bearing PUSH
 * debounces on THIS; local write/list stay tight (post-put + blur-flush) — rider (a), decoupled.
 * idleSettleMs: push this long after the last queue write. maxWaitMs: under continuous typing the
 * idle timer keeps resetting, so a one-shot cap from the first pending write flushes within this.
 */
export const SYNC_PUSH_CADENCE = { idleSettleMs: 2000, maxWaitMs: 5000 } as const;

let _idleTimer: ReturnType<typeof setTimeout> | null = null;
let _maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
let _pollTimer: ReturnType<typeof setInterval> | null = null;

function flushPush(notebookId: NotebookId, apiBase: string): void {
  if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
  if (_maxWaitTimer) { clearTimeout(_maxWaitTimer); _maxWaitTimer = null; }
  syncNow(notebookId, apiBase);
}

/**
 * (Re)arm the debounced push: reset the idle-settle timer on every queue write, and arm a one-shot
 * max-wait cap from the FIRST pending write (so continuous typing still flushes within maxWaitMs).
 * Either timer firing flushes and clears both.
 */
function schedulePush(notebookId: NotebookId, apiBase: string): void {
  setState('pending');
  if (_idleTimer) clearTimeout(_idleTimer);
  _idleTimer = setTimeout(() => flushPush(notebookId, apiBase), SYNC_PUSH_CADENCE.idleSettleMs);
  if (!_maxWaitTimer) {
    _maxWaitTimer = setTimeout(() => flushPush(notebookId, apiBase), SYNC_PUSH_CADENCE.maxWaitMs);
  }
}

/**
 * Start the sync triggers: a 30s poll + flush-now events (online recovery + mobile backgrounding via
 * visibilitychange→hidden / pagehide — rider (b), bounding the unsynced window on app-switch). The
 * debounced push itself is armed by `notifyQueueWrite` (the production path — every queue write goes
 * through mutateNotes.put, whose caller nudges notifyQueueWrite), so there is deliberately NO
 * liveQuery queue observer here: it was redundant with notifyQueueWrite AND a Dexie liveQuery
 * deadlocks under fake timers (the cadence-test hang). OPT-IN (not module-load) so controlled-sync
 * tests that drive syncNow directly are unaffected.
 */
export function startSyncTriggers(notebookId: NotebookId, apiBase = '/api'): () => void {
  _pollTimer = setInterval(() => syncNow(notebookId, apiBase), 30_000);

  const onOnline = () => flushPush(notebookId, apiBase); // reconnect → flush buffered edits now
  const onOffline = () => setState('offline');
  const onVisibility = () => { if (document.visibilityState === 'hidden') flushPush(notebookId, apiBase); };
  const onPageHide = () => flushPush(notebookId, apiBase); // mobile backgrounding — bound the unsynced window
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onPageHide);

  return () => {
    if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
    if (_maxWaitTimer) { clearTimeout(_maxWaitTimer); _maxWaitTimer = null; }
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', onPageHide);
  };
}

/**
 * Call after every `mutateNotes.put()` to (re)arm the debounced server push (idle-settle / max-wait).
 * This is THE push trigger (the production path): every queue write goes through mutateNotes.put and
 * its caller nudges this. Decoupled so mutate.ts doesn't import syncEngine (avoids a circular dep).
 */
export function notifyQueueWrite(notebookId: NotebookId, apiBase = '/api'): void {
  schedulePush(notebookId, apiBase);
}

// Re-export for callers that need the NoteResponseSchema (used in pull)
export { NoteResponseSchema };
