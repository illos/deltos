# Audit — client local-store account isolation (#52)

**Status:** AUDIT (devSys, 2026-06-20). A MAP, not a fix. Architectural approach is a Jim + navSys
decision (see §4); secSys co-audits with the tenancy lens. No build until the approach is chosen.

## 0. Root — CONFIRMED

The client local store (Dexie/IndexedDB + a couple of localStorage keys) is **device-global and
unfiltered by the current authenticated accountId**. It **accumulates** every account that has ever
logged in on the browser, and the list/switcher/search/trash reads return the **union** across all of
them. On a shared browser (Jim made several accounts this incident) a new login therefore shows prior
accounts' notebooks + notes. Sync itself IS account-scoped (server scopes by the bearer; the pull
cursor is per-account) — **the gap is purely client-local read/write scoping + account lifecycle.**

Two compounding facts:
- A note's `accountId` is **local-only — never pushed to or returned by the server** (`spine/identity.ts:44`).
  So locally-created notes are tagged, but **pull-merged notes land with `accountId` undefined** — the
  server can't give it back.
- `NotebookRow` has **no `accountId` field at all** — notebooks are untaggable as written.

## 1. READ paths — does each scope by current accountId?

| # | Read path | Code | Scopes by accountId? |
|---|-----------|------|----------------------|
| R1 | Notes list (`observeNotes`) | `dexieLocalStore.ts:55` | **NO** — `db.notes.toArray()` then filter `!deletedAt && !isInTrash` only |
| R2 | Trash view (`observeTrashedNotes`) | `:68` | **NO** — same, inverse trash filter |
| R3 | Notebook switcher + list (`observeNotebooks`) | `:299` | **NO** — `db.notebooks.toArray()` then `deletedAt===null` only |
| R4 | Current notebook (`useCurrentNotebook`) | `storeHooks.ts` | **NO** — finds within unfiltered `observeNotebooks` |
| R5 | Search (`SearchRoute` → `useNotes`) | `SearchRoute.tsx` | **NO** — consumes `observeNotes` (R1) |
| R6 | Single note (`observeNote(id)`) | `:39` | **NO** explicit filter — keyed by id (global UUID). Safe only because ids aren't guessable; but R1 surfaces every account's ids, so a wrong-account note IS reachable |
| R7 | Notes in a notebook (`notesInNotebook(notebookId)`, trash cascade) | `:332` | **Indirect** — scoped by `notebookId` (global UUID). Account-safe per-notebook, but notebooks aren't account-filtered (R3) |
| R8 | Note versions (`observeNoteVersions`, `resolveConflict`, capture prune) | `:84/:94/:139` | **YES** — `[noteId+accountId]` compound index, accountId from the session principal |
| R9 | Sync cursor (`getSyncCursor`) | `syncEngine.ts:51` | **YES** — per-account localStorage key `deltos.sync.cursor.v2.<accountId>` |

Leaking reads: **R1, R2, R3, R4, R5** (and R6/R7 transitively). R8/R9 are correctly scoped.

## 2. WRITE paths — is accountId stamped / scoped?

| # | Write path | Code | accountId handling |
|---|-----------|------|--------------------|
| W1 | Create note (`NewNote` → `mutateNotes.put`) | `NewNote.tsx:31` | **Tags** `note.accountId` from session ✓ |
| W2 | Edit save (`putNoteAndEnqueue`) | `mutate.ts` / `dexieLocalStore.ts:184` | **Preserves** the note object's accountId (✓ iff it had one) |
| W3 | Pull-merge notes (`mergeServerNotes`) | `:285` | **NO** — puts server notes as-is; server omits accountId → **synced notes land untagged** (GAP) |
| W4 | Pull-merge notebooks (`mergeNotebooks`) | `syncEngine.ts:319` | **NO** — builds `NotebookRow` with no accountId field (GAP) |
| W5 | Create notebook (`mutateNotebooks`) | `mutateNotebooks.ts` | **NO** accountId on the row (GAP) |
| W6 | Conflict version (`applyConflict`) | `:237` | **Stamps** accountId from session ✓ |
| W7 | Session capture (`captureSessionVersion`) | `:136` | accountId on the row (from session) ✓ |
| W8 | syncQueue / notebookQueue | various | record-scoped, transient; push is account-scoped by bearer — not a read-leak surface |

Gaps that make R1–R5 unfixable-by-filter-alone until closed: **W3** (untagged synced notes) and **W4/W5**
(untagged notebooks).

## 3. Device-local pointers / keys — per-account?

| # | Key | Store | Per-account? |
|---|-----|-------|--------------|
| K1 | `current-notebook` (`notebookPointer`) | deviceState (IDB) | **NO** — single key; the current-notebook selection **carries across accounts** (GAP) |
| K2 | `deltos.defaultNotebookId` (legacy Phase-1 migration) | localStorage | **NO** — single key; legacy per-device default id (GAP / residue) |
| K3 | `deltos.sync.cursor.v2.<accountId>` | localStorage | **YES** ✓ |
| K4 | `appearance-theme` (`themePointer`) | deviceState (IDB) | **NO — by design**: appearance is a device-level preference, not account data. Not a tenancy leak; flagged for completeness |

## 4. Account lifecycle — TODAY

- **login**: `useAuthStore` sets `accountId`/bearer (in-memory). The local store is **not** cleared,
  partitioned, or re-scoped. `notebookStore.init()` reads the single K1 pointer (possibly the prior
  account's). Sync pulls the new account's stream (per-account cursor ✓) and **merges into the same
  shared tables** alongside the prior account's rows.
- **account-switch** (login B with A present): **ACCUMULATES**. No clear/partition. R1–R5 return A ∪ B.
- **logout** (`auth/store.ts logout()`): clears in-memory accountId/bearer + auth gate; **does NOT** clear
  Dexie (notes/notebooks/deviceState/queues) or reset `notebookStore`. Everything persists for the next login.
- **Net:** there is **no account-lifecycle handling** of the local store. It is one shared device-global
  store that grows with every account; unfiltered reads → full cross-account visibility on a shared browser.

## 5. Architectural approaches (Jim + navSys to choose — NOT assumed here)

- **(A) Filter-everywhere (partition-in-query).** Tag all rows with accountId (add it to `NotebookRow`;
  stamp synced notes in `mergeServerNotes` — W3; stamp notebooks — W4/W5), make K1/K2 per-account, and
  filter every read (R1–R7) by the current session accountId. *Pros:* non-destructive, preserves each
  account's offline data, multi-account coexists, mirrors the server's accountId model + the existing R8
  pattern. *Cons:* widest surface (schema bump + every read/write + pointer + hooks threading); a missed
  filter = a leak (needs the secSys sweep).
- **(B) Clear-on-switch.** On login / account-change, wipe the local Dexie store + device-local pointers
  so only the current account's data is ever present (re-hydrated from the server pull). *Pros:* simplest,
  no schema change, no per-query filter, impossible to leak. *Cons:* destructive — drops the prior
  account's UNSYNCED offline edits on switch; offline multi-account unusable; relies on detecting the
  switch reliably.
- **(C) Per-account database (namespaced IndexedDB).** Open a Dexie DB named `deltos-<accountId>` on
  login; each account's data is a physically separate store. *Pros:* hard isolation by construction, no
  per-query filter, clean lifecycle (open/close per account), offline multi-account preserved. *Cons:*
  dynamic db-handle plumbing (the `db` singleton becomes per-account); cross-account migration/upgrade
  handling; more moving parts.

devSys lean (for discussion, not a decision): **(C)** gives the strongest guarantee with the least
ongoing leak-risk (no per-query discipline to maintain); **(A)** is the incremental path that reuses the
existing model. **(B)** is the cheap stopgap but loses offline edits on switch.

## 6. Notes for the decision
- `@6e8b43f` (within-account stale-pointer reconcile + single-default + vanish guards) is **valid and
  parked** — it is orthogonal/subordinate and composes with any of A/B/C.
- The server is correct (accountId-scoped; `notebooks_oneDefault` index holds; per-edit reassign covers
  orphans). **No 0010 migration needed** for this.
- Data is disposable pre-real-users — a one-time wipe clears Jim's accumulated local mess regardless of
  the chosen approach.
