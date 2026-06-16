# PART 2 — conflict-as-version: data-model CONTRACT

**Status:** CONTRACT for parallel build (publish-before-deep-impl) · **Owner:** devSys2 (Stream-B
client sync core) · **For:** gruntSys2 (conflict UX/toast/badge/view), gruntSys (tests), pilot ·
**Date:** 2026-06-16 · **Spec:** `docs/specs/v1-shell-and-conflict-versions.md` Part 2 (option A).

This is a **CLIENT-SIDE representation change** — the worker/sync protocol is UNCHANGED (server CAS
on `expectedVersion` still decides accept/conflict, PIN-SYNC-1; the conflict response still carries
the server note). What changes is how the CLIENT retains the divergent edit on conflict: **a retained
version of the SAME note id**, never a new-id fork, never lost. Build on the audited Stream-B
no-lost-edit core — both sides are already retained; this re-expresses the retention.

## 1. Note gains `hasConflict` (client-side state, like `syncStatus`)

`Note.hasConflict: boolean` (default `false`). True iff the note has an **unresolved** conflict
version attached. Drives the persistent badge. Set `true` by the conflict reconcile; cleared by any
resolve action. Client-only (the server never sees it), exactly like `syncStatus`.

## 2. New table `noteVersions` — retained whole-note snapshots (lays the Phase-3 versions model)

```ts
export interface NoteVersion {
  id: string;            // version-row UUID (PK)
  noteId: NoteId;        // the note this version belongs to — SAME id, indexed
  accountId: string;     // CLIENT-side D6 scope — stamped from the session at creation (NEVER body);
                         // observeNoteVersions filters by it (multi-account-on-one-device safety)
  kind: 'conflict';      // v1 retains only conflict versions; Phase-3 adds 'history' etc.
  title: string;
  properties: PropertyBag;
  body: Block[];
  baseVersion: number;   // the server version the divergent edit was authored against
  createdAt: string;     // ISO-8601 Z (when retained)
}
```

Dexie store (client schema **version 4**): `noteVersions: 'id, noteId, [noteId+accountId]'` (compound
index for the accountId-scoped per-note read). Whole-note snapshot grain (S2). No worker/D1
migration — client-local only.

## 3. Reactive read API (follows the existing `observeNote`/`useNote` seam pattern)

- `LocalStore.observeNoteVersions(noteId, accountId, cb: (versions: NoteVersion[]) => void): Unsubscribe`
  — accountId-scoped (client-side D6); filters via the `[noteId+accountId]` index.
- hook `useNoteVersions(noteId): NoteVersion[]` — reads the session accountId (useAuthStore) and
  passes it to `observeNoteVersions`; for the conflict view (shows the divergent version(s)).
- The **badge** reads `useNote(noteId)` → `.hasConflict` (already reactive). No new hook needed for it.

Interface-only (no Dexie types cross the boundary); F7 unaffected (no token).

## 4. Conflict reconcile — `applyConflict` REVISED (the engine path; replaces the fork)

On a server CONFLICT, atomically (one tx over notes + noteVersions + syncQueue):
1. **Retain** the CURRENT local note (reflecting any in-flight edit) as a `noteVersions` row
   (`kind:'conflict'`, keyed to the **same** noteId, `baseVersion` = what we pushed, `accountId`
   stamped from the session principal — the engine reads it from useAuthStore and passes it in).
2. **Adopt** the server state as the note's LIVE content (`syncStatus:'synced'`, server version).
   - **PIN-SYNC-3 (server tombstone):** the live note is RETAINED as a tombstone-state row (not
     hard-deleted) so the badge + `keep-mine` resurrection work; the divergent edit lives in the
     retained version. (Differs from the old hard-delete path.)
3. **Set** `note.hasConflict = true`.
4. **Blanket-drain** the record's queue entries (unchanged from today — keeping the in-flight entry
   would re-push the now-server state).

`forkedFromId` is RETIRED for the conflict path (PIN-SYNC-4 revised): the note keeps its id →
inbound relations stay valid for free. No `(conflict copy)` titles, no new-id sibling note.

## 5. Resolve actions — `LocalStore.resolveConflict(noteId, resolution)` (UX-called)

`resolveConflict(noteId: NoteId, resolution: 'keep-mine' | 'keep-theirs' | 'keep-both'): Promise<void>`,
atomic (values match the UX button labels + spec wording):
- **`'keep-mine'`** → the divergent version's content becomes the note's LIVE content, enqueued as a
  new edit with `baseVersion` = the CURRENT server version (pushes as the new top version, CAS-safe);
  delete the note's conflict versions; `hasConflict = false`.
- **`'keep-theirs'`** → delete the note's conflict versions; server content stays live; `hasConflict = false`.
- **`'keep-both'`** → KEEP the version row(s) as retained versions of the ONE note (no auto second
  note, planner ruling); `hasConflict = false`. (An explicit "duplicate to new note" action is separate.)

All clear the badge. keep-both leaves the snapshot as dormant per-note version data Phase-3 browses.

## 6. Online push cadence — TUNABLE, not hardcoded-buried

Debounced server push for near-real-time online sync. Cadence is **planSys-blessed**:
`SYNC_PUSH_CADENCE = { idleSettleMs: 2000, maxWaitMs: 5000 }` — 2s idle-settle, 5s max-wait cap so
continuous typing still flushes at least every 5s. Exposed as a single named/tunable constant (not
buried in the trigger); adjustable later. Two scopeSys riders (adopted, not cadence changes):
- **(a) DECOUPLE the server-push debounce from local autosave.** Local write/list stay TIGHT
  (post-put + the E3 blur-flush already there) so the list is fresh + crash-safe; only the
  radio-bearing server push uses the 2s/5s. They are separate timers.
- **(b) FLUSH the push on `visibilitychange`→hidden / `pagehide`** (mobile backgrounding), alongside
  the existing `online` event — bounds the unsynced window on app-switch (the common iOS interruption).

## 7. Invariants held (GATE)

Stream-B no-lost-edit trip-wire (`test/syncEngine.test.ts`) MUST stay green; secSys re-audits the new
representation when it lands. In force: PIN-SYNC-1 atomic CAS, PIN-SYNC-2 monotonic cursor, D6
accountId scoping, F7 token in-memory only. The accept-path selective drain + pending-edit pull guard
are UNCHANGED — only the conflict path's retention representation changes (fork → version).

## 8. secSys audit-angle invariants — DESIGNED IN (not discovered at audit)

1. **No-lost-edit survives the representation change.** On CAS-conflict, BOTH sides retained: the
   server-live content is adopted as the note's live content AND the divergent local edit is retained
   as a `noteVersions` row on the SAME id — never LWW-clobber either side. This re-expresses the
   audited Stream-B both-sides-retained core (fork → version); the retention is wired to the version,
   not lost in the change.
2. **Atomic version-append (PIN-SYNC-1).** `applyConflict` is ONE Dexie transaction over
   notes + noteVersions + syncQueue: conflict-handling and version-append commit together, no
   SELECT-then-write TOCTOU. The version row's PK is its own UUID, indexed by `noteId`; concurrent
   conflict-versions get distinct UUIDs (no collision, no drop). Client sync is single-flight PER
   NOTEBOOK, so there is no concurrent same-note conflict in the first place.
3. **Pending-edit pull guard survives.** `mergeServerNotes` is UNCHANGED (pendingIds computed inside
   its notes+queue tx, skips pending). Divergence-as-version is produced by the PUSH conflict path
   (`applyConflict`), never by pull; a pull of a new server version still does NOT clobber a pending
   local edit.
4. **Drain asymmetry holds.** accept = SELECTIVE drain, conflict = BLANKET drain — UNCHANGED. The
   version representation changes only WHAT is retained on conflict (a version, not a new-id fork),
   not the drain logic. See [[sync-pushqueued-drain-invariants]].
5. **D6 account scoping — ARCHITECTURE CLARIFICATION (confirm please, secSys).** In v1, conflict
   versions are **CLIENT-LOCAL** (Dexie `noteVersions`), NOT server objects — per the spec (server
   live content is authoritative; the divergent is the client's retained snapshot) and pilot's
   client-only file scope; the worker/sync protocol is UNCHANGED, there is NO new server route / D1
   table / object for versions. Consequences:
   - NO new SERVER object route → the server-side two-account isolation is the EXISTING notes/sync
     scoping (dd86704, isolation.acceptance 10/10), not a new route test. The client `noteVersions`
     store is single-account (the client receives only its account's notes — server-scoped pull; the
     client note row carries no accountId today, so versions match that model).
   - The conflict toast carries the DEVICE'S OWN account note title (client-local) — no cross-account
     content leak (no server response returns another account's version).
   - `keep-mine` → live enqueues a normal note edit that flows through the EXISTING push → server CAS
     + accountId-stamp from the principal (dd86704) — so the resolution WRITE is already accountId
     -scoped server-side, never from the body.
   - **RULED (pilot):** client-only DISCHARGES the new-server-object-route concern, AND client-side D6
     scoping STILL applies — so `noteVersions` carries `accountId` (stamped from the session principal
     at create, never the body), `observeNoteVersions` is accountId-scoped (a multi-account-on-one
     -device case can never surface another account's conflict versions via the
     `[noteId+accountId]` index), and `resolveConflict`'s keep-mine re-push stamps accountId server
     -side via the existing push (dd86704). The store methods take `accountId` as an explicit param
     (the hook/engine supply the session accountId from useAuthStore) — the persistence layer stays
     auth-free. Phase-3 server-synced version-history then inherits D6 cleanly.
6. **PIN-SYNC-3 resurrect.** `keep-mine` on a server-tombstoned note re-establishes the note
   atomically (live ← version content, enqueued) — the resulting push is accountId-scoped server-side
   like any write; the tombstone live-row is RETAINED (not hard-deleted) so the badge + resurrection work.
7. **`forkedFromId` retirement.** Removing it from the conflict path does not touch CAS (keyed on
   `version`, not `forkedFromId`) or isolation (accountId/notebookId scoping unaffected); no orphaned
   references (it was only ever set on forks, which no longer exist). The column stays nullable/unused
   (no reader depends on it for conflict) — confirmed no consumer breaks.

## What teammates build against this

- **gruntSys2 (UX):** badge off `useNote().hasConflict`; conflict view off `useNoteVersions(noteId)`;
  resolve buttons call `resolveConflict(noteId, 'mine'|'theirs'|'both')`; non-blocking toast on detect.
- **gruntSys (tests):** the conflict trip-wire becomes "divergent edit retained as a `noteVersions`
  row on the SAME id (no second note in the list), `hasConflict` set, resolve paths correct"; the
  existing no-lost-edit invariants stay.
