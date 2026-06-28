import { db } from './schema.js';
import { LEGACY_DEFAULT_NB_LS_KEY } from './notebookPointer.js';
import { useNotebookStore } from '../lib/notebookStore.js';

/**
 * Device-global `deviceState` keys that belong to the DEVICE, not the authenticated account, and so
 * MUST survive an account-change/logout wipe. The wipe is DENY-BY-DEFAULT (#57): every other
 * deviceState key — the device-global notebook pointer, the resident-account marker, and ANY pointer
 * added later — is cleared on account change, so a forgotten future tenant key can't silently leak
 * across accounts (the missed-reader/key class, cf. the server [[cross-account-data-layer-finding]]).
 * Keep this list in sync as device-level (non-account) pointers are added.
 *   - 'appearance-theme' = the UI-refresh theme preference (lands when the ui-refresh branch
 *     integrates; harmless to preserve before then — it's just a no-op on a build without it).
 *   - 'custom-keyboard' = the #69 custom-keyboard opt-in — a per-device preference, not account data.
 *   - 'spellcheck' = the #69 §5 local-spellcheck toggle — a per-device preference, not account data.
 */
const DEVICE_GLOBAL_DEVICE_KEYS: readonly string[] = ['appearance-theme', 'custom-keyboard', 'spellcheck'];

/**
 * #52 client tenancy — OPTION B (clear-on-account-change). SHIPPED (secSys-reviewed; live).
 *
 * The client local store is a single device-global Dexie DB that ACCUMULATES every account that logs in
 * on the device, and the list/switcher/search/trash reads are unfiltered by accountId → a new login
 * inherits prior accounts' notes/notebooks. Option B closes this by PURGING the local store whenever the
 * authenticated account differs from the one the local data belongs to.
 *
 * A durable at-rest marker (`deviceState['last-account']`) records whose data is currently resident.
 * It is F7-safe: it stores the accountId (a stable, non-secret identifier), NEVER the bearer token (which
 * stays in-memory only). On every session-establish, {@link ensureAccountScope} compares the live
 * accountId to the marker:
 *   - MATCH → keep the local data (same account on this device).
 *   - DIFFER, or marker ABSENT → WIPE the local store, then stamp the marker. "Marker absent" also covers
 *     the FIRST load of the fixed build, so pre-fix polluted/cross-account residue self-purges once for
 *     free (the rollout's client-local wipe — the server D1 wipe is the other half).
 *
 * The wipe MUST run BEFORE the shell's first local read (the caller awaits it before opening the gate),
 * so there is no cold-boot flash of the prior account's notes. The marker is stamped AFTER the wipe, so a
 * crash mid-wipe simply re-wipes on the next boot (idempotent).
 *
 * Clearing the QUEUES is load-bearing, not housekeeping: syncQueue/notebookQueue carry no accountId and
 * `pushQueued` drains every entry under the CURRENT bearer, so a prior account's un-pushed entry would
 * otherwise push under the new account and MIGRATE its content server-side (secSys W8). The wipe drops
 * those un-pushed entries — acceptable pre-real-users ([[pre-real-users-clean-state-bias]]); it is the
 * deliberate clear-vs-partition trade (clear is simpler; offline multi-account on one device is not a v1 goal).
 */

const ACCOUNT_MARKER_KEY = 'last-account';

export async function readAccountMarker(): Promise<string | null> {
  return (await db.deviceState.get(ACCOUNT_MARKER_KEY))?.value ?? null;
}

/**
 * Wipe ALL account-scoped client-local state — every Dexie table that holds account data, the
 * device-global notebook pointer, the legacy localStorage default-id, AND every per-account sync cursor.
 * Resetting the cursor is load-bearing (secSys): the cursor is `deltos.sync.cursor.v2.<accountId>` and the
 * pull fetches `accountSyncSeq > cursor`; if the tables are wiped but the cursor kept, a re-login as the
 * SAME account pulls only post-cursor changes → all older unchanged notes NEVER re-hydrate (silent
 * vanish). Clearing every cursor forces a full re-pull from seq 0 into the clean store. Theme
 * (deviceState `appearance-theme`) is device-level, NOT account data — preserved.
 */
async function wipeLocalState(): Promise<void> {
  await db.transaction(
    'rw',
    [db.notes, db.notebooks, db.noteVersions, db.syncQueue, db.notebookQueue, db.dictionaryWords, db.dictionaryQueue, db.blobCache, db.deviceState],
    async () => {
      await Promise.all([
        db.notes.clear(),
        db.notebooks.clear(),
        db.noteVersions.clear(),
        db.syncQueue.clear(), // W8: drop un-pushed entries — never drain under another bearer
        db.notebookQueue.clear(),
        db.dictionaryWords.clear(), // §5.2 ISOLATION: the custom dictionary is account-scoped — never inherit across accounts
        db.dictionaryQueue.clear(), // W8: drop un-pushed dictionary entries — never drain under another bearer
        db.blobCache.clear(), // ISOLATION: cached blob bytes are account-scoped — never inherit across accounts (#52)
      ]);
      // DENY-BY-DEFAULT deviceState wipe (#57): delete EVERY key except the device-global allowlist
      // (the notebook pointer + the resident-account marker + any future per-account pointer all go).
      // The marker is re-stamped (ensureAccountScope) or dropped (purgeAllLocalState) by the caller
      // right after, so deleting it here is harmless and keeps the wipe a single source of truth.
      const keys = await db.deviceState.toCollection().primaryKeys();
      await Promise.all(
        keys
          .filter((k) => !DEVICE_GLOBAL_DEVICE_KEYS.includes(k as string))
          .map((k) => db.deviceState.delete(k)),
      );
    },
  );
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem(LEGACY_DEFAULT_NB_LS_KEY);
    // Collect cursor keys via the Storage API (length/key) THEN remove — removing mid-enumeration shifts indices.
    const cursorKeys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('deltos.sync.cursor')) cursorKeys.push(k);
    }
    for (const k of cursorKeys) localStorage.removeItem(k);
  }
  // In-memory mirror is part of local account state (#57): reset it so a logout→login (or switch)
  // shows NO stale prior-account notebook for the ~1 tick before AuthedShell's initNotebook rehydrates.
  useNotebookStore.getState().reset();
}

/**
 * Ensure the local store belongs to `accountId`; wipe + re-stamp if it belongs to another account (or is
 * unmarked). Returns true iff a wipe ran. MUST be awaited before any local read (login/switch path).
 */
export async function ensureAccountScope(accountId: string): Promise<boolean> {
  const marker = await readAccountMarker();
  if (marker === accountId) return false; // same account — local data is already correctly scoped
  await wipeLocalState();
  // Stamp AFTER the wipe so an interrupted wipe re-runs next boot (idempotent).
  await db.deviceState.put({ key: ACCOUNT_MARKER_KEY, value: accountId });
  return true;
}

/**
 * Unconditional full local wipe for LOGOUT (security wipe — primary). Clears everything
 * {@link wipeLocalState} does AND drops the resident-account marker, so the device retains NO account
 * data after sign-out and the next login re-detects from a clean slate. Caller should suspend sync first
 * (so no in-flight pull re-populates) and best-effort flush the queue while online (so a deliberate
 * sign-out doesn't silently drop recent un-pushed edits) BEFORE calling this.
 */
export async function purgeAllLocalState(): Promise<void> {
  await wipeLocalState();
  await db.deviceState.delete(ACCOUNT_MARKER_KEY);
}
