import { getStore } from '../db/store.js';
import { useAuthStore } from '../auth/store.js';
import { showConflictToast } from './toastEvents.js';
import type { SyncQueueEntry, NotebookQueueEntry, NotebookRow, DictionaryQueueEntry, DictionaryWordRow } from '../db/schema.js';
import type { Note, NoteId, NotebookId } from '@deltos/shared';
import { NoteResponseSchema } from '@deltos/shared';
import type {
  SyncPushRequest,
  SyncPushResponse,
  SyncPullResponse,
  SyncNote,
  SyncNotebook,
  SyncDictionaryWord,
  NotebookPushResult,
} from '@deltos/shared';
import { useNotebookStore } from './notebookStore.js';

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
// Cursor persistence (per-account, per-device, PIN-SYNC-2)
// v2 key is account-scoped; the old v1 per-notebook key is abandoned (first run
// gets a cursor=0 full re-pull, which backfills all account notes correctly).
// ---------------------------------------------------------------------------

const CURSOR_KEY = (accountId: string) => `deltos.sync.cursor.v2.${accountId}`;

export function getSyncCursor(accountId: string): number {
  return Number(localStorage.getItem(CURSOR_KEY(accountId)) ?? '0');
}

function setSyncCursor(accountId: string, cursor: number): void {
  localStorage.setItem(CURSOR_KEY(accountId), String(cursor));
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
/**
 * Sync suspension (#52 tenancy wipe). When suspended: no NEW cycle starts, and an in-flight cycle is
 * allowed to finish its PUSH (so a logout flushes the account's own un-pushed edits to its own account —
 * the secondary flush-first), but its PULL is SKIPPED so it can't re-populate the store AFTER a wipe.
 * suspendSync() is called before a logout wipe; startSyncTriggers() resumes on (re-)login.
 */
let _suspended = false;
export function suspendSync(): void {
  _suspended = true;
  if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
  if (_maxWaitTimer) { clearTimeout(_maxWaitTimer); _maxWaitTimer = null; }
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}
export function resumeSync(): void {
  _suspended = false;
}

export function syncNow(notebookId: NotebookId, apiBase = '/api'): void {
  if (_suspended) return; // tenancy wipe in progress / logged out — do not start a cycle
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
    await pushNotebooks(apiBase);
    await pushDictionary(apiBase);
    if (_suspended) return; // suspended mid-cycle (e.g. logout): the push flushed; SKIP the re-populating pull
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
 * Collapse the queue to the latest entry per note (latest-wins dedup within the client's own
 * queue). Account-scoped: all queued entries are pushed in one batch regardless of their
 * payload.notebookId — the server derives the account from the bearer token, so notebookId is
 * only an organizing hint for new notes, not an access-control boundary.
 */
async function dedupeQueue(): Promise<SyncQueueEntry[]> {
  const all = await getStore().queueEntries();
  const byNote = new Map<string, SyncQueueEntry>();
  for (const entry of all.sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    byNote.set(entry.recordId, entry);
  }
  return [...byNote.values()];
}

async function pushQueued(notebookId: NotebookId, apiBase: string): Promise<void> {
  const entries = await dedupeQueue();
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
      entries: batch.map((e) => ({
        id: e.payload.id,
        // INSERT (baseVersion 0) always declares its notebook; plain UPDATE omits so the server keeps the
        // existing assignment; an explicit move sets isMove in the queue entry (detected in putNoteAndEnqueue).
        ...(e.baseVersion === 0 || e.isMove ? { notebookId: e.payload.notebookId } : {}),
        draft: {
          title: e.payload.title,
          properties: e.payload.properties,
          body: e.payload.body,
        },
        baseVersion: baseFor.get(e.id) ?? e.baseVersion,
      })),
      notebookEntries: [],
      dictionaryEntries: [],
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

// Dedup-key sentinel for the single-flight guard when notebookId is null (All Notes / #59).
// pushQueued's notebookId param is vestigial (the push is account-scoped by the bearer token;
// dedupeQueue batches ALL queued entries regardless of notebookId) — any stable id satisfies it.
const FLUSH_SENTINEL = '00000000-0000-4000-8000-000000000000' as NotebookId;

// ---------------------------------------------------------------------------
// Awaitable push drain (#54) — the "ensure everything is pushed" primitive
// ---------------------------------------------------------------------------

/**
 * Push every queued edit and resolve once the queue is EMPTY. Unlike {@link syncNow} (fire-and-forget,
 * single-flight, also pulls), this is a pure, AWAITABLE push — the "ensure synced before X" primitive.
 *
 * Logout uses it to flush ALL queued edits before the local wipe: today suspendSync only lets an
 * already-in-flight push finish, so an edit queued in the ~2s debounce window at the sign-out instant
 * is otherwise dropped by the wipe (data-loss on logout is a bad surprise for real users — navSys #54).
 *
 * Loops until the queue drains or MAX_PASSES is hit — a persistent conflict or being offline can't
 * drain, and logout must never hang. The caller suspends new cycles first (logout → suspendSync), so
 * there's no competing pusher; a double-push that somehow raced is CAS-safe (the loser conflicts, no
 * data lost). Propagates a network error so the caller decides (logout proceeds best-effort).
 */
export async function flushPushQueue(apiBase = '/api'): Promise<void> {
  const MAX_PASSES = 5;
  for (let pass = 0; pass < MAX_PASSES && (await getStore().queueCount()) > 0; pass++) {
    await pushQueued(FLUSH_SENTINEL, apiBase);
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
  const accountId = useAuthStore.getState().accountId;
  if (!accountId) return; // no authed session — skip pull; next cycle retries
  const cursor = getSyncCursor(accountId);
  let next = cursor;
  let hasMore = true;

  while (hasMore) {
    const res = await fetch(
      `${apiBase}/sync/pull?cursor=${next}`,
      { headers: authHeader() },
    );
    if (!res.ok) throw new Error(`pull ${res.status}`);

    const json: SyncPullResponse = await res.json();

    await mergePull(json.notes);
    await mergeNotebooks(json.notebooks);
    await mergeDictionary(json.dictionaryWords);

    next = json.nextCursor;
    hasMore = json.hasMore;
  }

  if (next !== cursor) setSyncCursor(accountId, next);
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
export async function mergePull(notes: SyncNote[]): Promise<void> {
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
// Notebook sync helpers
// ---------------------------------------------------------------------------

export async function mergeNotebooks(notebooks: SyncNotebook[]): Promise<void> {
  if (notebooks.length === 0) return;
  for (const nb of notebooks) {
    const row: NotebookRow = {
      id: nb.id as NotebookId,
      name: nb.name,
      defaultCollectionView: nb.defaultCollectionView,
      version: nb.version,
      createdAt: nb.createdAt,
      updatedAt: nb.updatedAt,
      deletedAt: nb.deletedAt,
      syncSeq: nb.syncSeq,
    };
    await getStore().putNotebook(row);
  }
  // Reconcile the device-local current-notebook pointer. null = All Notes (always valid — skip).
  // Only reconcile when a real notebook id is selected and that notebook no longer resolves:
  //   (a) was deleted; OR
  //   (b) is a STALE/LEGACY pointer (Phase-1 per-device random id, or an id that never synced).
  //       Left stale, new notes stamped with that id are re-homed to null by the server on edit →
  //       they "vanish" from the filtered view. Fall back to null (All Notes) — no stored default.
  const { currentNotebookId, setCurrentNotebook } = useNotebookStore.getState();
  if (currentNotebookId === null) return; // All Notes is always valid — no reconcile needed
  const currentRow = await getStore().getNotebook(currentNotebookId);
  const currentResolves = currentRow !== undefined && currentRow.deletedAt === null;
  if (!currentResolves) {
    await setCurrentNotebook(null); // fall back to All Notes — no stored default any more
  }
}

async function dedupeNotebookQueue(): Promise<NotebookQueueEntry[]> {
  const all = await getStore().notebookQueueEntries();
  const byNotebook = new Map<string, NotebookQueueEntry>();
  for (const e of all) {
    const existing = byNotebook.get(e.recordId);
    if (!existing || e.createdAt > existing.createdAt) byNotebook.set(e.recordId, e);
  }
  return [...byNotebook.values()];
}

async function pushNotebooks(apiBase: string): Promise<void> {
  const entries = await dedupeNotebookQueue();
  if (entries.length === 0) return;

  const body: SyncPushRequest = {
    entries: [],
    notebookEntries: entries.map((e) => e.payload),
    dictionaryEntries: [],
  };

  const res = await fetch(`${apiBase}/sync/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`push notebooks ${res.status}`);

  const json: SyncPushResponse = await res.json();

  for (const result of json.notebookResults) {
    const pushed = entries.find((e) => e.payload.id === result.id);
    if (!pushed) continue;
    if (result.outcome === 'accepted') {
      await getStore().updateNotebookVersion(result.id as NotebookId, result.version);
    } else {
      // Conflict: adopt server state OR restore on default_undeletable.
      const conflictResult = result as Extract<NotebookPushResult, { outcome: 'conflict' }>;
      if (conflictResult.serverNotebook) {
        const sn = conflictResult.serverNotebook;
        await getStore().putNotebook({
          id: sn.id as NotebookId,
          name: sn.name,
          defaultCollectionView: sn.defaultCollectionView,
          version: sn.version,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          deletedAt: null,
          syncSeq: 0,
        });
      } else if (conflictResult.reason === 'default_undeletable') {
        // Delete was rejected — restore the row
        const nb = await getStore().getNotebook(result.id as NotebookId);
        if (nb) await getStore().putNotebook({ ...nb, deletedAt: null });
      }
    }
    await getStore().drainNotebookQueueEntry(pushed.id);
  }
}

// ---------------------------------------------------------------------------
// Custom-dictionary sync helpers (§5.2) — set semantics, conflict-free
// ---------------------------------------------------------------------------

/** Apply incoming server dictionary words (live or tombstoned) to the local mirror. */
export async function mergeDictionary(words: SyncDictionaryWord[]): Promise<void> {
  if (words.length === 0) return;
  for (const w of words) {
    const row: DictionaryWordRow = {
      word: w.word,
      createdAt: w.createdAt,
      updatedAt: w.updatedAt,
      deletedAt: w.deletedAt,
      syncSeq: w.syncSeq,
    };
    await getStore().mergeDictionaryWord(row);
  }
}

/** Collapse the dictionary queue to the latest entry per word (latest-wins within the client's queue). */
async function dedupeDictionaryQueue(): Promise<DictionaryQueueEntry[]> {
  const all = await getStore().dictionaryQueueEntries();
  const byWord = new Map<string, DictionaryQueueEntry>();
  for (const e of all) {
    const existing = byWord.get(e.recordId);
    if (!existing || e.createdAt > existing.createdAt) byWord.set(e.recordId, e);
  }
  return [...byWord.values()];
}

async function pushDictionary(apiBase: string): Promise<void> {
  const entries = await dedupeDictionaryQueue();
  if (entries.length === 0) return;

  const body: SyncPushRequest = {
    entries: [],
    notebookEntries: [],
    dictionaryEntries: entries.map((e) => e.payload),
  };

  const res = await fetch(`${apiBase}/sync/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`push dictionary ${res.status}`);

  const json: SyncPushResponse = await res.json();

  // Set semantics → always accepted; confirm the local row's syncSeq + drain the queue entry.
  for (const result of json.dictionaryResults) {
    const pushed = entries.find((e) => e.payload.word === result.word);
    if (!pushed) continue;
    await getStore().drainDictionaryQueueEntry(pushed.id);
  }
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

/**
 * Visibility-gated pull cadence (planSys-blessed; tunable — do not bury the literal).
 * visibleIntervalMs: periodic pull ONLY while the page is visible (battery/cost: don't poll a
 * backgrounded tab). Suspended on visibilitychange→hidden, resumed on →visible.
 * 2s chosen to keep merge-conflict windows short (conflicts are non-destructive, so frequency
 * trades battery for convergence speed — user preference).
 */
export const SYNC_PULL_CADENCE = { visibleIntervalMs: 2_000 } as const;

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
  resumeSync(); // (re-)login clears any logout-time suspension so this account's sync runs normally
  // Visibility-gated pull cadence: poll ONLY while visible; suspend when hidden (battery + cost).
  function startPoll() {
    if (_pollTimer) return;
    _pollTimer = setInterval(() => syncNow(notebookId, apiBase), SYNC_PULL_CADENCE.visibleIntervalMs);
  }
  function stopPoll() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  }

  // Start polling immediately if visible (normal case on app open or in a foreground tab).
  if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
    startPoll();
  }

  const onOnline = () => flushPush(notebookId, apiBase); // reconnect → flush buffered edits now
  const onOffline = () => setState('offline');
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') {
      stopPoll();
      flushPush(notebookId, apiBase); // mobile backgrounding — bound the unsynced window
    } else {
      syncNow(notebookId, apiBase); // immediate pull on return-to-app (don't wait for next tick)
      startPoll();
    }
  };
  const onPageHide = () => flushPush(notebookId, apiBase); // mobile backgrounding — bound the unsynced window
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onPageHide);

  return () => {
    if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
    if (_maxWaitTimer) { clearTimeout(_maxWaitTimer); _maxWaitTimer = null; }
    stopPoll();
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
export function notifyQueueWrite(notebookId: NotebookId | null, apiBase = '/api'): void {
  schedulePush(notebookId ?? FLUSH_SENTINEL, apiBase);
}

// Re-export for callers that need the NoteResponseSchema (used in pull)
export { NoteResponseSchema };
