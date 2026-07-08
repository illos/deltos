import { getStore } from '../db/store.js';
import { useAuthStore } from '../auth/store.js';
import { showConflictToast } from './toastEvents.js';
import type { SyncQueueEntry, NotebookQueueEntry, NotebookRow, DictionaryQueueEntry, DictionaryWordRow } from '../db/schema.js';
import type { Note, NoteId, NotebookId, BlockBody, SyncPushEntry } from '@deltos/shared';
import { NoteResponseSchema, SyncPushEntrySchema } from '@deltos/shared';
import type {
  SyncPushRequest,
  SyncPushResponse,
  SyncPullResponse,
  SyncNote,
  SyncNotebook,
  SyncDictionaryWord,
  NotebookPushResult,
} from '@deltos/shared';
import { sanitizeBlockIds } from '../editor/serializer.js';
import { useNotebookStore } from './notebookStore.js';
import { DEFAULT_CAPTURE_THRESHOLDS } from './historyCapture.js';

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

/** Raised by {@link syncFetch} when a re-mint could NOT restore a usable bearer — carries WHY so runSync
 *  sets the right non-error state. 'revoked' → signed out (hard-gate, #89); 'offline' → can't reach server. */
class SyncAuthError extends Error {
  constructor(public readonly kind: 'revoked' | 'offline') {
    super(`sync auth ${kind}`);
    this.name = 'SyncAuthError';
  }
}

// Single-flight the re-mint: a cycle's push AND pull can both be rejected for the same expired token —
// share ONE /refresh, never fire two concurrent re-mints.
let _remintInFlight: Promise<'ok' | 'revoked' | 'offline'> | null = null;
function remintOnce(): Promise<'ok' | 'revoked' | 'offline'> {
  if (!_remintInFlight) {
    _remintInFlight = useAuthStore.getState().remintBearer().finally(() => { _remintInFlight = null; });
  }
  return _remintInFlight;
}

/**
 * fetch() for EVERY sync request. On an auth rejection it re-mints the in-memory bearer from the refresh
 * cookie ONCE and retries. The rejection statuses are subtle (verified against the worker guard):
 *   - 403 — an EXPIRED/revoked access token. The worker finds the grant by token-hash (no expiry filter)
 *           but `grantAllows` fails the expiry check → the chokepoint denies with 403, NOT 401. This is
 *           the COMMON case (15-min access TTL) and the one behind "stuck yellow until I hard-reload".
 *   - 401 — defensive (the sync routes don't currently emit it, but treat it the same as 403).
 *   - 503 — an ABSENT bearer (no Authorization → dev-stub principal → prod fail-closed tripwire). Covers
 *           the offline/weak-boot recovery: the shell opened with bearer=null and now re-mints in place.
 * On a sync route a 403 can only mean "your token expired" (the client can never request another account —
 * accountId is server-derived), so re-mint is always the right response. Before this, the engine threw on
 * any !res.ok → setState('error') and every 2s tick re-failed with the same dead token; only a full reload
 * re-minted via init(). A dead cookie (re-mint → 'revoked') or unreachable server ('offline') surfaces a
 * typed {@link SyncAuthError} so runSync sets revoked/offline rather than a generic error.
 */
async function syncFetch(apiBase: string, path: string, init: RequestInit = {}): Promise<Response> {
  const send = () => fetch(`${apiBase}${path}`, { ...init, headers: { ...(init.headers ?? {}), ...authHeader() } });
  const res = await send();
  if (res.status !== 401 && res.status !== 403 && res.status !== 503) return res;
  const outcome = await remintOnce();
  if (outcome !== 'ok') throw new SyncAuthError(outcome);
  return send(); // retry ONCE with the fresh bearer (a still-failing retry returns as-is → caller throws)
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

// Last sync-cycle failure message (diagnostics only). A push/pull throw (e.g. a `push 400` from a
// malformed queue entry) is otherwise swallowed by runSync's catch into the coarse 'error' state; we
// retain its message so the diagnostic-snapshot manifest can surface WHY a cycle is wedged. Cleared on
// any clean cycle. NEVER carries credentials — it's the Error.message string only.
let _lastError: string | null = null;

// Last push QUARANTINE message (Fix B). Distinct from `_lastError` (a transient cycle throw, cleared on
// the next clean cycle) because a quarantine is a PERSISTENT condition — the unpushable entry stays in the
// queue and is re-evaluated every push. Set/cleared at the top of each push's validate loop so it always
// reflects the CURRENT state: a message while an entry is quarantined, null once it's gone. Never carries
// credentials (the entry's recordId + the schema issue message only).
let _lastQuarantine: string | null = null;

export function getSyncState(): SyncIndicatorState {
  return _state;
}

/**
 * The last sync diagnostic message (or null when healthy). Prefers a live cycle error; falls back to a
 * standing push-quarantine condition (an entry that can't be made schema-valid and was isolated so it
 * can't wedge the rest). For the diagnostic snapshot.
 */
export function getLastSyncError(): string | null {
  return _lastError ?? _lastQuarantine;
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
    _lastError = null; // a clean cycle clears any retained failure
    setState(remaining > 0 ? 'pending' : 'idle');
  } catch (err) {
    _lastError = err instanceof Error ? err.message : String(err);
    if (err instanceof SyncAuthError) {
      if (err.kind === 'revoked') {
        // #89: the refresh cookie is dead → a full re-login is required. STOP the loop (no point
        // re-failing every 2s with no way to mint a token) and mark the session revoked. Grey, NOT the
        // scary yellow 'error' — a signed-out device isn't an error (companion to #85/#86).
        useAuthStore.setState({ sessionState: 'revoked' });
        suspendSync();
        setState('offline');
      } else {
        setState('offline'); // couldn't reach the server to re-mint — not synced, but not an error
      }
    } else if (err instanceof TypeError && err.message.includes('fetch')) {
      setState('offline');
    } else {
      setState('error');
    }
  } finally {
    _inFlight.delete(notebookId);
    // Honour a trigger that arrived mid-cycle — UNLESS we were suspended (logout / revoked), where a
    // re-run would just re-fail or re-populate after a wipe.
    if (!_suspended && _pending.has(notebookId)) {
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

/**
 * Build the wire {@link SyncPushEntry} for a queued note. `wireBaseVersion` is the re-stamped CAS base
 * (the current local version, see below); the INSERT-vs-UPDATE notebook signal still keys on the entry's
 * STORED baseVersion / isMove (the queue entry's authored intent), not the re-stamped wire base.
 */
function buildPushEntry(e: SyncQueueEntry, wireBaseVersion: number): SyncPushEntry {
  return {
    id: e.payload.id,
    // INSERT (stored baseVersion 0) always declares its notebook; plain UPDATE omits so the server keeps
    // the existing assignment; an explicit move sets isMove in the queue entry (putNoteAndEnqueue).
    ...(e.baseVersion === 0 || e.isMove ? { notebookId: e.payload.notebookId } : {}),
    draft: {
      title: e.payload.title,
      properties: e.payload.properties,
      body: e.payload.body,
    },
    baseVersion: wireBaseVersion,
  } as SyncPushEntry;
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

  // VALIDATE → REPAIR → QUARANTINE (resilience: one bad note must NEVER wedge all sync). Build each wire
  // entry and check it against the SAME SyncPushEntrySchema the worker enforces, BEFORE sending — so the
  // server can never 400 the batch on a validation failure and stall every other queued edit behind it.
  // The known, fixable corruption is a non-UUID block id leaked into payload.body (the render-only id
  // leak — GOTCHA-0005): re-mint the offending ids in the canonical note + its queued payload (self-heal,
  // so it never re-leaks), then re-validate. An entry that STILL can't be made valid (e.g. a corrupt note
  // id, which can't be re-minted without losing identity) is QUARANTINED — skipped from the batch and
  // recorded via getLastSyncError — so the good entries always drain. The retained createdAt/baseVersion/
  // version of each entry are untouched by the repair (a pure content fix), so all CAS preconditions hold.
  const prepared: Array<{ entry: SyncQueueEntry; push: SyncPushEntry }> = [];
  _lastQuarantine = null; // recomputed below — reflects the CURRENT push's quarantines, not a stale one
  for (const original of entries) {
    const wireBase = baseFor.get(original.id) ?? original.baseVersion;
    let entry = original;
    let push = buildPushEntry(entry, wireBase);
    if (!SyncPushEntrySchema.safeParse(push).success) {
      // REPAIR the common case: re-mint non-UUID block ids in the body (recursively, incl. children).
      const repairedBody = sanitizeBlockIds((entry.payload.body ?? []) as BlockBody);
      await getStore().repairQueueEntry(entry.id, repairedBody); // persist self-heal: note row + queue payload
      entry = { ...entry, payload: { ...entry.payload, body: repairedBody } };
      push = buildPushEntry(entry, wireBase);
    }
    const checked = SyncPushEntrySchema.safeParse(push);
    if (checked.success) {
      prepared.push({ entry, push: checked.data });
    } else {
      // QUARANTINE — unrepairable; skip it so it can't 400 the batch. Surfaced for the diagnostic snapshot.
      _lastQuarantine = `sync: quarantined unpushable note ${entry.recordId} — ${checked.error.issues[0]?.message ?? 'schema-invalid'}`;
      console.warn(_lastQuarantine, checked.error.issues);
    }
  }
  if (prepared.length === 0) return; // nothing valid to send (all quarantined) — don't POST an empty batch

  const BATCH = 50; // keep payloads reasonable
  for (let i = 0; i < prepared.length; i += BATCH) {
    const batch = prepared.slice(i, i + BATCH);
    const body: SyncPushRequest = {
      entries: batch.map((p) => p.push),
      notebookEntries: [],
      dictionaryEntries: [],
    };

    const res = await syncFetch(apiBase, '/sync/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
      const pushed = batch.find((p) => p.entry.payload.id === result.id)?.entry;

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
    const res = await syncFetch(apiBase, `/sync/pull?cursor=${next}`);
    if (!res.ok) throw new Error(`pull ${res.status}`);

    const json: SyncPullResponse = await res.json();

    await mergePull(json.notes, accountId);
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
 * `accountId` (the caller's authed principal — non-null in pullUpdates) scopes the pre-overwrite
 * kind:'sync' capture the store does before a material foreign change clobbers a local note.
 *
 * Exported for direct testing (syncEngine.test.ts).
 */
export async function mergePull(notes: SyncNote[], accountId: string): Promise<void> {
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

  await getStore().mergeServerNotes(liveNotes, tombstones, accountId, {
    materialFloorChars: DEFAULT_CAPTURE_THRESHOLDS.materialFloorChars,
    retentionCap: DEFAULT_CAPTURE_THRESHOLDS.retentionCap,
  });
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
      noteSort: nb.noteSort,
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

  const res = await syncFetch(apiBase, '/sync/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
          noteSort: sn.noteSort,
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

  const res = await syncFetch(apiBase, '/sync/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
/** #91 idle timeout: pause sync after this long with NO user interaction, even if focused+visible (the
 *  walked-away case). Resumes (catch-up pull) on the next interaction. Tunable, like the cadence consts. */
export const SYNC_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
/** Activity is sampled at most this often (don't churn the idle timer per pixel of pointermove). */
const ACTIVITY_THROTTLE_MS = 5_000;
/** The user-interaction events that count as activity (passive listeners). 'focus' (window regained focus)
 *  counts as interaction → resets idle / resumes a catch-up; 'blur' is NOT a pause trigger (#91 revised:
 *  pause on idle only, never on mere unfocus — side-by-side windows keep live-syncing). */
const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'touchstart', 'scroll', 'wheel', 'focus'] as const;

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

  // #91: the poll is "active" only while VISIBLE and (on DESKTOP) the window is FOCUSED — so a desktop
  // window that's visible but unfocused (another app in front) pauses sync too. Focus gates DESKTOP ONLY
  // (mobile focus/blur fire unreliably — visibility already covers mobile). One unified reconcile drives
  // both visibility and focus.
  // #91 (revised): the poll is "active" while VISIBLE and NOT IDLE. Pause on idle ONLY — a visible-but-
  // unfocused window does NOT pause (side-by-side windows keep live-syncing). Idle = no interaction for
  // SYNC_IDLE_TIMEOUT_MS (the walked-away case), platform-agnostic. Time-based; the activity timer below
  // fires the reconcile when the idle threshold is crossed.
  let lastActivity = Date.now();
  let activityIdleTimer: ReturnType<typeof setTimeout> | null = null;
  const isIdle = () => Date.now() - lastActivity >= SYNC_IDLE_TIMEOUT_MS;
  const shouldBeActive = () =>
    (typeof document === 'undefined' || document.visibilityState !== 'hidden') && !isIdle();
  let wasActive = shouldBeActive();
  if (wasActive) startPoll(); // poll immediately when active on open (foreground + focused)

  // Reconcile on a visibility / focus / idle change — only on the active⇄inactive EDGE (no double-syncNow
  // while already active). INACTIVE → stop polling + flush pending edits first (keep the conflict window
  // tight). ACTIVE → immediate catch-up pull + resume polling (composes with #90: the open note refreshes).
  const reconcileActive = () => {
    const active = shouldBeActive();
    if (active === wasActive) return;
    wasActive = active;
    if (active) { syncNow(notebookId, apiBase); startPoll(); }
    else { stopPoll(); flushPush(notebookId, apiBase); }
  };

  // The idle timer fires the reconcile (→ pause) once the threshold passes with no activity; re-armed on
  // every (throttled) interaction. Activity listeners stay ALWAYS-ON so the next interaction after an
  // idle-pause resumes. The throttle ignores rapid repeats (no per-px pointermove churn) but the first
  // interaction after an idle-pause is always >throttle-old → it resumes immediately.
  const armIdleTimer = () => {
    if (activityIdleTimer) clearTimeout(activityIdleTimer);
    activityIdleTimer = setTimeout(reconcileActive, SYNC_IDLE_TIMEOUT_MS);
  };
  const onActivity = () => {
    const now = Date.now();
    if (now - lastActivity < ACTIVITY_THROTTLE_MS) return;
    lastActivity = now;
    armIdleTimer();
    reconcileActive(); // resume on the idle→active edge (edge-guarded → no-op when already active)
  };
  armIdleTimer();

  const onOnline = () => flushPush(notebookId, apiBase); // reconnect → flush buffered edits now
  const onOffline = () => setState('offline');
  const onPageHide = () => flushPush(notebookId, apiBase); // mobile backgrounding — bound the unsynced window
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', reconcileActive);
  window.addEventListener('pagehide', onPageHide);
  // Activity listeners (incl. window 'focus') keep idle reset / resume the catch-up; NOT focus/blur PAUSE.
  for (const evt of ACTIVITY_EVENTS) window.addEventListener(evt, onActivity, { passive: true });

  return () => {
    if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
    if (_maxWaitTimer) { clearTimeout(_maxWaitTimer); _maxWaitTimer = null; }
    if (activityIdleTimer) { clearTimeout(activityIdleTimer); activityIdleTimer = null; }
    stopPoll();
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', reconcileActive);
    window.removeEventListener('pagehide', onPageHide);
    for (const evt of ACTIVITY_EVENTS) window.removeEventListener(evt, onActivity);
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
