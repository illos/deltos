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
  kind: 'conflict';      // v1 retains only conflict versions; Phase-3 adds 'history' etc.
  title: string;
  properties: PropertyBag;
  body: Block[];
  baseVersion: number;   // the server version the divergent edit was authored against
  createdAt: string;     // ISO-8601 Z (when retained)
}
```

Dexie store (client schema **version 4**): `noteVersions: 'id, noteId'` (index `noteId` for per-note
lookup). Whole-note snapshot grain (S2). No worker/D1 migration — client-local only.

## 3. Reactive read API (follows the existing `observeNote`/`useNote` seam pattern)

- `LocalStore.observeNoteVersions(noteId, cb: (versions: NoteVersion[]) => void): Unsubscribe`
- hook `useNoteVersions(noteId): NoteVersion[]` — for the conflict view (shows the divergent
  version(s) beside the live note).
- The **badge** reads `useNote(noteId)` → `.hasConflict` (already reactive). No new hook needed for it.

Interface-only (no Dexie types cross the boundary); F7 unaffected (no token).

## 4. Conflict reconcile — `applyConflict` REVISED (the engine path; replaces the fork)

On a server CONFLICT, atomically (one tx over notes + noteVersions + syncQueue):
1. **Retain** the CURRENT local note (reflecting any in-flight edit) as a `noteVersions` row
   (`kind:'conflict'`, keyed to the **same** noteId, `baseVersion` = what we pushed).
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
buried in the trigger); adjustable later. Reuses the autosave-debounce mechanism.

## 7. Invariants held (GATE)

Stream-B no-lost-edit trip-wire (`test/syncEngine.test.ts`) MUST stay green; secSys re-audits the new
representation when it lands. In force: PIN-SYNC-1 atomic CAS, PIN-SYNC-2 monotonic cursor, D6
accountId scoping, F7 token in-memory only. The accept-path selective drain + pending-edit pull guard
are UNCHANGED — only the conflict path's retention representation changes (fork → version).

## What teammates build against this

- **gruntSys2 (UX):** badge off `useNote().hasConflict`; conflict view off `useNoteVersions(noteId)`;
  resolve buttons call `resolveConflict(noteId, 'mine'|'theirs'|'both')`; non-blocking toast on detect.
- **gruntSys (tests):** the conflict trip-wire becomes "divergent edit retained as a `noteVersions`
  row on the SAME id (no second note in the list), `hasConflict` set, resolve paths correct"; the
  existing no-lost-edit invariants stay.
