# Stream-D Phase-2 — accountId scope application to the notes data routes (spine)

**Owner:** scopeSys. **Status:** PREP (read-only enumeration) — 2026-06-16. Mechanical to
apply once devSys's per-query scope helper signature lands.

**Goal:** every id-/notebookId-keyed notes query in the spine filters by the *caller's*
`accountId` (= `principal.id` after the D6 zero-delta re-point), so no authenticated account
can read, mutate, delete, or search another account's notes. This is the **LOAD-BEARING
fail-closed control** (per [[tenancy-grant-account-relative]] refinement 1) — the data-layer
per-query scope is PRIMARY; `can()`/`grantAllows` ownership is the belt (devSys).

The original finding's sharp edge: **`note.search` with no `notebookId` returns ALL accounts'
notes** ([[cross-account-data-layer-finding]]). That branch is item S-6 below.

Migration `0003_account-identity.sql` (landed) already adds `notes.accountId` (nullable, ALTER)
+ index `notes_byAccount (accountId, notebookId)` + single-account back-fill. The column exists;
this checklist wires the queries to it.

---

## ⚠ PREREQUISITE SEAM (blocks everything below) — handlers have no accountId today

`guard()` (`http.ts:80`) resolves `principal` internally but the `handle(req, c)` callback is
**never given it** — the principal is dropped after the `can()` check (`http.ts:97-101`).
So no spine handler can currently name the caller's `accountId`.

**Required before any query can be scoped — coordinate with devSys (owns `http.ts`):** expose
the resolved principal to the handler. Two candidate shapes (devSys's call):
- `handle(req, c, principal)` — extra param on `GuardConfig.handle`; explicit, type-safe,
  no context-key magic. **Preferred** (mirrors how `can()` already receives it).
- `c.set('principal', principal)` on the Hono context, read via `c.get('principal')` — looser,
  stringly-keyed.

`principal.id` is then the caller `accountId` (post re-point). **Read accountId off `principal.id`
ONLY — never a body field** (F2 discipline; same class as `accountFingerprint` server-compute).
Loud comment at the seam: `principal.id = accountId, NOT accountFingerprint`
(planSys binding condition).

**Surfacing pattern is devSys's — DO NOT invent a local way to reach accountId** (pilot,
2026-06-16). devSys is deciding the ONE mechanism to surface accountId into handlers across the
shared guard→handler boundary (guard-sets-on-`c` / 3rd `handle` arg / helper-reads-from-`c`); it
applies to these notes routes IDENTICALLY to how devSys2 wires sync. Leave a slot for that pattern;
wire notes-spine queries to it the same way. (`handle(req, c, principal)` is the leading candidate —
devSys's lane to land.)

**Helper dependency:** devSys is landing a per-query scope helper "in its own file" that REQUIRES
the caller accountId (the split's only gap-risk = a handler omitting it — the helper makes omission
a type error). The per-site notes below are written to be agnostic: each names the query, the
file:line, and the scope key to apply.

### PILOT RULINGS (2026-06-16) — mutate.ts single-editor + one signature for notes AND sync

1. **`mutate.ts` SINGLE-EDITOR = scopeSys for Phase-2.** It is shared with the sync lane; to avoid a
   lock fight + a fail-open seam, scopeSys owns ALL `mutate.ts` edits — helper signatures gain a
   **REQUIRED `accountId` param**, scope/stamp applied INSIDE. devSys2 edits ONLY `sync.ts` call
   sites, never `mutate.ts`.
2. **Lock the signature BEFORE editing.** Collect devSys2's exact sync call-site needs (pullNotes
   scope, the conflict-path serverNote SELECT scope, push insert/update stamp) + devSys's
   scope-helper shape, so the ONE `mutate.ts` signature serves both notes and sync in a single shape.
   A required `accountId` param is fail-closed by construction: a call site cannot compile without
   passing it.

### FROZEN mutate.ts signatures (converged + confirmed with devSys2, 2026-06-16)

Convention: `accountId: string` is a **REQUIRED** param placed **immediately after the
entry/notebookId identity arg**, server-supplied (= `principal.id` post-D6), never folded into
`entry` (entry is the client `SyncPushEntry` wire shape — accountId must stay server-supplied,
F2). Required ⇒ fail-closed: a call site cannot compile without it. Order is devSys2's confirmed
"FREEZE it" shape exactly.

| Helper | Today | FROZEN | Scope/stamp applied inside |
|--------|-------|--------|----------------------------|
| insertNote | `(db, entry, serverNow)` | `(db, entry, accountId, serverNow)` | STAMP `notes.accountId = accountId` into INSERT cols. SHARED: notes.create + sync push-new. |
| updateNote | `(db, entry, serverNow)` | `(db, entry, accountId, serverNow)` | CAS `WHERE … AND accountId=?`; conflict-path serverNote SELECT also `AND accountId=?` (no cross-account leak — cross-account push gets 0-row CAS → conflict → scoped SELECT null → client forks new id; secSys pt-4). Sync only. |
| patchNote | `(db, id, notebookId, patch, expectedVersion, serverNow)` | `(db, id, notebookId, accountId, patch, expectedVersion, serverNow)` | UPDATE `WHERE … AND accountId=?` + exists-check SELECT (`mutate.ts:265`) + final SELECT. notes.update/append/property. |
| deleteNote | `(db, id, notebookId, expectedVersion, serverNow)` | `(db, id, notebookId, accountId, expectedVersion, serverNow)` | UPDATE `WHERE … AND accountId=?` + serverRow SELECT. notes.delete. |
| pullNotes | `(db, notebookId, cursor)` | `(db, notebookId, accountId, cursor)` | SELECT `WHERE … AND accountId=?` (read isolation). Sync only. |
| searchNotes | `(db, notebookId, text)` | `(db, notebookId, accountId, text)` | ALL 3 branches `AND accountId=?` (the title-LIKE leak). notes.search. |
| getNote | `(db, id, notebookId)` | `(db, id, notebookId, accountId)` | Exported, UNUSED in worker (index.ts uses inline SELECT) — scope for consistency or drop. |

**Signature CONVERGED + CONFIRMED by devSys2** ("FREEZE it"): its 3 sync helpers
(insertNote/updateNote/pullNotes) verified against its sync call sites; the scoped conflict
serverNote SELECT is the no-leak behavior it wants; no other sync notes query exists. I edit
`mutate.ts` (single-editor); devSys2 passes accountId from sync.ts call sites. **Test blast radius I own:** `conflict.test.ts` calls these helpers directly
(19 call sites: insertNote/updateNote/deleteNote/pullNotes) — all need the accountId arg added
when the signature lands. Those tests seed a SINGLE account/notebook today (the root-cause blind
spot).

### ⚠ OWNERSHIP DISCREPANCY (routed to pilot 2026-06-16) — who edits index.ts notes call sites?

Pilot's fresh-start message assigned scopeSys the **index.ts notes data routes**
(note.get/update/delete, block.append, property.set, note.search) + mutate.ts. devSys2's memory
records the index.ts call sites as devSys2's (devSys2 = "index.ts call-sites + sync.ts"). These
conflict on index.ts. **Resolution pending pilot.** Until ruled: scopeSys holds index.ts edits to
avoid a collision; signature + mutate.ts ownership are unaffected (both confirmed mine).

---

## Scope of THIS chunk (pilot, 2026-06-16)

**IN:** the 6 notes-data operations in the spine `packages/worker/src/index.ts`
(note.get / note.update / note.delete / note.search / block.append / property.set) **+** the
write-stamp on note.create.

**OUT (Stream-D sync lane, NOT this chunk):** `routes/sync.ts` push/pull and their helpers
`updateNote` / `pullNotes` ([[stream-a-routes-lane]] open item 5; [[stream-d-accountid-readiness]]).
Flagged here only because they share `mutate.ts` helpers — see "Shared-helper coordination".

---

## A. Inline SELECTs in `index.ts` (5 direct queries — scopeSys edits)

Each currently keys on `id` (or `id + deletedAt`) ONLY. Each must additionally filter
`AND accountId = ?` with the caller accountId (or go through the scope helper). A miss = a
cross-account read/existence-oracle.

| # | Op | File:line | Current query | Fix |
|---|----|-----------|---------------|-----|
| S-1 | note.get | `index.ts:147` | `SELECT * FROM notes WHERE id = ? AND deletedAt IS NULL` | + `AND accountId = ?` (caller). Miss → 404 (not 403 — no cross-account existence oracle, same rule as the revoke BOLA fix). |
| S-2 | note.update | `index.ts:170` | `SELECT notebookId FROM notes WHERE id = ? AND deletedAt IS NULL` (pre-fetch for CAS) | + `AND accountId = ?`. Scopes the notebookId lookup so the subsequent `patchNote` operates only on a row the caller owns. Miss → 404. |
| S-3 | note.delete | `index.ts:201` | `SELECT notebookId FROM notes WHERE id = ?` (NOTE: no `deletedAt` filter — idempotent-delete intent) | + `AND accountId = ?`. Miss → 404. |
| S-4 | block.append | `index.ts:260` | `SELECT * FROM notes WHERE id = ? AND deletedAt IS NULL` | + `AND accountId = ?`. Miss → 404. |
| S-5 | property.set | `index.ts:297` | `SELECT * FROM notes WHERE id = ? AND deletedAt IS NULL` | + `AND accountId = ?`. Miss → 404. |

## B. `note.search` — the original leak (`index.ts:235` → `searchNotes`, `mutate.ts:329`)

| # | Op | File:line | Issue | Fix |
|---|----|-----------|-------|-----|
| S-6 | note.search | `mutate.ts:329-355` (called from `index.ts:235`) | 3 branches: (text+notebookId), (**text only** → `WHERE title LIKE ?` = **ALL accounts**), (notebookId only). The text-only branch is the disclosure. | EVERY branch filters `AND accountId = ?`. With no notebookId the search is bounded to the caller's own notes. `notebookId` is a bare client string → A's and B's "notebook-X" must stay distinct, so even the notebookId branches need the accountId filter (effective key = `(accountId, notebookId)`). |

## C. Write path — STAMP, don't filter (`note.create`, `index.ts:127` → `insertNote`, `mutate.ts:57`)

| # | Op | File:line | Fix |
|---|----|-----------|-----|
| S-7 | note.create | `index.ts:118-131` → `insertNote` (`mutate.ts:57`, INSERT at `mutate.ts:72`) | STAMP `accountId` from `principal.id` SERVER-SIDE into the INSERT column list — **never a body field** ([[tenancy-grant-account-relative]] refinement 4; F2 discipline). Else A could create a note tagged as B. `insertNote`'s `entry` arg or signature gains the caller accountId. |

## D. `mutate.ts` write helpers — defense-in-depth gate (shared; see coordination)

The pre-fetch SELECTs in A already gate by accountId, so the row handed to these helpers is
already caller-owned. **Belt-and-suspenders:** the helper UPDATEs should ALSO carry `AND accountId = ?`
so a forged/guessed `notebookId` can never widen the CAS across accounts.

| # | Helper | File:line | Used by | Fix |
|---|--------|-----------|---------|-----|
| S-8 | patchNote | `mutate.ts:258` (UPDATE `WHERE id = ? AND notebookId = ? AND deletedAt IS NULL`) | note.update, block.append, property.set | + `AND accountId = ?`. |
| S-9 | deleteNote | `mutate.ts:195` (UPDATE `WHERE id = ? AND notebookId = ? AND deletedAt IS NULL`) | note.delete | + `AND accountId = ?`. |

## E. Wire-leak check (no edit expected — assert)

- `rowToResponse` (`index.ts:92`, dup `sync.ts:23`) maps EXPLICIT fields and does NOT include
  `accountId`, so `SELECT *` rows do not leak the owner to the wire. **Add a test** asserting
  `accountId` is absent from every note response shape (guards against a future careless spread).

---

## Cross-account negative test class (STANDING DISCIPLINE — [[stream-a-routes-lane]], planSys condition 3)

Two-account fixture (seed account A + account B, distinct accountId). For EACH of S-1..S-7:
**A acts on B's object → 404 (reads/CRUD) and B's row is UNMUTATED**; and the positive path
(A on A's own → success). For S-6: A's search (text-only AND notebookId) returns ONLY A's notes,
never B's. Root cause of the original blind spot: every existing test seeded ONE account
([[cross-account-data-layer-finding]]). The semantic test (planSys condition 2): an end-to-end
assertion that scope reads resolve through `principal.id == accountId`.

## Shared-helper coordination (mutate.ts is shared with the sync lane)

`insertNote` / `patchNote` / `deleteNote` / `searchNotes` live in `mutate.ts`, also called by
`routes/sync.ts` (Stream-D sync lane). `updateNote` + `pullNotes` are sync-only. Changing these
signatures to require accountId touches sync's call sites too — **coordinate signature with devSys
(scope helper) + whoever holds the sync lane** before editing `mutate.ts`, so push/pull get the
same accountId scoping in the same shape (don't leave sync unscoped — that's the same finding on a
different route). `coord ask packages/worker/src/db/mutate.ts "..."` if held.

## Apply order (once helper lands)

1. devSys: principal→handler seam (`http.ts`) + scope helper file + `insertNote` accountId param.
2. scopeSys: S-1..S-6 (inline SELECTs + search) routed through the helper.
3. scopeSys: S-7 write-stamp; S-8/S-9 helper UPDATE gates (coordinate mutate.ts).
4. scopeSys: cross-account negative test class + wire-leak test (E).
5. secSys: fail-closed per-query-scope review + two-account-test audit (the build-audit).
