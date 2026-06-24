# Client Account-Isolation Audit (#53)

**Owner:** secSys · **Status:** AUDIT (gates the build — no fix until navSys+Jim pick an approach)
**Scope:** the client-side tenancy gap — the local store (Dexie/IDB + device-local pointers) is
not isolated by the current authenticated `accountId`, so a second login on the same device
inherits a prior account's local data. Same CLASS as the server cross-account findings
(per-query account scope), now on the client.

> Not a live multi-tenant leak crisis (same-person-same-device dogfood) — but the real isolation
> correctness gap, and it includes a **write-side cross-account migration** path that read-filtering
> alone does not close. Verified from code @phase-0-foundation; cross-check with devSys's parallel map.

---

## 1. MAP — every client local path × scoped by current authenticated accountId?

### Persistence surface (complete inventory)
- **IDB / Dexie tables (6):** `notes`, `syncQueue`, `notebooks`, `noteVersions`, `notebookQueue`, `deviceState`
- **`deviceState` keys:** `current-notebook` (notebook pointer), `appearance-theme` (theme)
- **localStorage keys:** `deltos.sync.cursor.v2.<accountId>` (pull cursor), `deltos.defaultNotebookId` (legacy, migration-only)
- **In-memory (Zustand singletons):** `authStore` (session), `notebookStore` (`currentNotebookId`)
- **Service Worker Cache Storage:** Workbox precache (app shell) + nav route

### READ paths
| Path | Source | Scoped by accountId? |
|---|---|---|
| Notes list — `observeNotes` | `db.notes.toArray()` | ❌ NO |
| Search — `useNotes` → `observeNotes` | (inherits) | ❌ NO |
| Trash view — `observeTrashedNotes` | `db.notes.toArray()` | ❌ NO |
| Note-by-id — `observeNote` / `getNote` | `db.notes.get(id)` | ❌ NO (no accountId check) |
| Notebook switcher — `observeNotebooks` | `db.notebooks.toArray()` | ❌ NO |
| Single notebook — `getNotebook` | `db.notebooks.get(id)` | ❌ NO |
| History / conflict — `observeNoteVersions` / `resolveConflict` | `where('[noteId+accountId]')` | ✅ YES |
| Sync pull cursor — `getSyncCursor` | `localStorage CURSOR_KEY(accountId)` | ✅ YES |
| Current-notebook pointer — `notebookPointer` | `deviceState 'current-notebook'` | ❌ NO (device-global) |
| Theme — `themePointer` | `deviceState 'appearance-theme'` | N/A (device pref, non-tenant) |

### WRITE paths
| Path | Scopes / stamps accountId? |
|---|---|
| `putNoteAndEnqueue` (create/edit) | note row gets accountId only if caller set it / server stamps on first sync; **`syncQueue` entry carries NO accountId** ❌ |
| `softDelete` / `restore` / `duplicate` | same as above |
| **`pushQueued` drain** | ❌ NO — `queueEntries()` returns ALL entries; pushes under the CURRENT bearer (`authHeader()`) |
| **`pushNotebooks` drain** | ❌ NO — same, `notebookQueue` unscoped |
| Pull hydration — `mergeServerNotes` / `applyAccepted` / `applyConflict` | server rows carry server accountId; conflict path stamps session accountId ✅ |
| Default-notebook creation | client cold-start auto-select / server canonical; rows server-stamped |
| Session capture — `captureSessionVersion` | ✅ accountId stamped from session |

---

## 2. Account LIFECYCLE today

- **login / signup / refresh / reset** (`authStore` set): overwrites the in-memory `accountId`.
  **No compare vs a prior device account. No local-store action.**
- **logout** (`authStore.logout`): clears ONLY in-memory auth fields. Touches **no** Dexie table,
  **no** notebook pointer, **no** cursor, **not** the in-memory `notebookStore`.
- **account-switch** (logout→login B, or login B over A): the local store **ACCUMULATES** A's data;
  B reads it unfiltered.
- **cold boot:** the shell renders **local-first, before** auth resolves → shows whatever is in IDB
  (the last account's data) before the session is confirmed.

**Verdict: today the local store is neither cleared, partitioned, nor filtered — pure accumulation.**

---

## 3. Which paths LEAK cross-account

- **READ (visibility):** notes list, search, trash, note-by-id, notebook switcher all show account A's
  content to account B.
- **POINTER:** `current-notebook` selects A's notebook for B (+ the in-memory `notebookStore` mirror).
- **WRITE / MIGRATION — worst:** `pushQueued` / `pushNotebooks` drain A's **un-pushed** queue entries
  under **B's** bearer → the server stamps **B** → **A's note/notebook content migrates into B's
  account.** This is cross-account data *migration*, not mere visibility, and **read-filtering does
  nothing for it** (the queue drains regardless of reads).
- **RENDER-BEFORE-AUTH:** cold boot flashes the prior account's notes before the session resolves.

**Already clean (do not regress):** `noteVersions` ([noteId+accountId]); sync cursor (account-keyed);
SW `/api` denylisted from the shell cache (pin-storage-1 holds — no `/api` runtime cache); theme
(device pref, non-tenant).

---

## 3b. Cross-check vs devSys's map (docs/design/client-account-isolation-audit.md @0320d3b)

Two independently-built maps cover the **same** read (R1–R9), write (W1–W8), and pointer (K1–K4)
surface → high confidence the inventory is COMPLETE. devSys's three facts sharpen this audit:

- **W3 `mergeServerNotes` STRIPS accountId (the mechanism behind Edge-1).** The server never returns
  accountId (`spine/identity.ts:44`, local-only), and `mergeServerNotes` (`dexieLocalStore.ts:285`)
  does `db.notes.put(serverNote)` as-is. So a creation-stamped note loses its tag the first time it is
  pulled back → untagged → a scoped read drops it. **Filter/partition MUST re-stamp the session
  accountId inside `mergeServerNotes`, not just at creation.** (This makes filter strictly more work than
  it looks, and is invisible until a note round-trips.)
- **`NotebookRow` has NO accountId field at all** (keyed `'id'` only). Partition/filter requires a
  schema change + a Dexie version bump + an index before notebooks can be tagged (W4/W5). Notes already
  carry accountId (schema v3); notebooks do not.
- **No durable accountId marker** — accountId is in-memory only (`useAuthStore`). A switch can't be
  detected at boot before the shell reads. Any clear/partition needs a persisted "last accountId on
  device" marker (F7-safe — accountId is not the bearer).

**One disagreement to settle (write-side):** devSys's W8 calls `syncQueue`/`notebookQueue`
"record-scoped, transient; push is account-scoped by bearer — not a read-leak surface." Correct that
it's not a *read* leak — but "account-scoped by bearer" is the migration *vector*, not a safeguard: the
queues carry no accountId, and `pushQueued`→`queueEntries()` (`syncEngine.ts:144`) drains **every**
entry under the **current** bearer. If account A's un-pushed entries survive into B's session (logout
does NOT clear the queue), B's sync loop pushes A's payload → the server stamps **B** → **A's content
migrates into B's account.** This WRITE/migration leak is **not closed by read-filtering** — a
filter-everywhere approach must ALSO clear or account-scope the queue drain on switch. Surfacing it so
the option-A surface isn't undercounted.

## 4. The architectural options

### A. PARTITION-in-query (tag every row + filter every read, shared DB)
- **Offline multi-account:** ✅ data coexists, no re-pull on switch.
- **Render-before-auth shell:** ⚠️ needs accountId known at first render; shell renders empty/skeleton
  until accountId resolves (can't safely show "last account" data).
- **Perf:** compound `[accountId+…]` indexes; filtered reads fine; storage grows with #accounts.
- **Cost (sharpened by devSys facts):** the WIDEST surface — requires a `NotebookRow` schema change +
  Dexie version bump to tag notebooks (W4/W5), a re-stamp of session accountId in `mergeServerNotes`
  (W3, else pulled notes lose their tag), accountId-scoping the **queue drains** (the W8 migration leak —
  not optional), per-account pointers (K1), AND every read (R1–R7) filtered, with accountId threaded
  through the hooks.
- **Risk:** LARGEST missed-reader surface across 6 tables + 2 queues — exactly the failure mode that bit
  us server-side, on a bigger surface. Highest ongoing correctness discipline (every FUTURE read too).

### B. CLEAR on account-change — wipe tenant tables + device-local pointers on switch/logout
- **Offline multi-account:** ❌ none — switching wipes; re-login re-pulls from the server (needs network).
  Acceptable only if multi-account-on-one-device is not a v1 goal.
- **Render-before-auth shell:** ✅ simplest — after a clear the store is empty until B's pull; no stale
  flash IF the clear precedes shell mount. Same-account cold boot still renders local-first (good).
- **Perf:** re-pull cost on switch; the wipe itself is cheap.
- **Risk:** DATA-LOSS of the outgoing account's un-pushed `syncQueue`/`notebookQueue` (acceptable
  pre-real-users; must be deliberate, and become drain-before-clear once real users exist). Clear must
  be COMPLETE (all 6 tables + `current-notebook` pointer + reset in-memory `notebookStore`) and ORDERED
  before B's first read/sync (else a race window leaks).
- Smallest surface, F7-safe, matches the current phase posture.

### C. PER-ACCOUNT DATABASE — open `deltos-<accountId>` per login (physical namespace; devSys's lean)
- **Offline multi-account:** ✅ best — each account's data is a physically separate IndexedDB; hard
  isolation by construction, no per-query discipline, no cross-account drain (each account's queue lives
  in its own DB → the W8 migration leak cannot occur).
- **Render-before-auth shell:** ⚠️ STRONGEST tension — the `db` singleton becomes per-account, so nothing
  can be read until accountId is known. On cold boot accountId is in-memory-only (gone) → must await
  `/refresh` before opening the DB → CANNOT render local-first before auth UNLESS the "last accountId"
  marker is used to optimistically open `deltos-<lastAccountId>` then verify. This complicates the
  load-decoupled-from-auth shell (a core deltos value).
- **Perf:** clean; no filter overhead; per-account storage.
- **Cost:** dynamic db-handle plumbing (the `db` singleton → per-account), cross-account DB
  migration/upgrade handling, more moving parts. No per-row tagging, no W3/W4 re-stamp, no schema bump.
- **Risk:** LOWEST ongoing leak-risk (isolation by construction, nothing to maintain per-query).

### (rejected) FILTER-only — add an accountId predicate to reads, leave everything else
Not a standalone option: it ignores the W8 queue-migration WRITE leak, the W3 strip (pulled notes lose
their tag), the unstamped-creation edge, and the pointer. Making it complete = A. Listed only to record
why "just filter the list" is insufficient.

## 4b. Rollout cleanliness — does pre-fix polluted local data auto-purge?

Jim wants a TWO-LAYER clean slate after deploy (server D1 wipe + client local wipe). A server-only wipe
is INSUFFICIENT: the pre-fix accumulated local store (Jim's several test accounts' notes/notebooks +
the stale `current-notebook` pointer + untagged/`mergeServerNotes`-stripped rows) survives on-device
regardless of the server reset. Each option differs on whether the fixed build self-purges that residue:

- **B. CLEAR-on-account-change — SELF-PURGING (cleanest rollout).** The clear mechanism doubles as the
  one-time purge: on first load of the fixed build there is **no "last accountId" marker**, so the
  marker-absent path treats it as a switch → full local wipe → re-hydrate from the (server-wiped) stream.
  No separate purge codepath; the steady-state mechanism IS the rollout purge. (Must wire the
  marker-absent case to wipe — don't let "no marker" silently no-op.)
- **A. PARTITION-in-query — NEEDS an explicit one-time purge.** Filtering only HIDES pre-fix residue
  (untagged / undefined-accountId rows fall out of a scoped read) — it does NOT remove it: the rows
  physically remain (storage bloat) and untagged rows are ambiguous. Requires an explicit
  store-version-bump purge (wipe Dexie tables + `deviceState` pointers + the legacy localStorage keys)
  shipped in the fixed build, on top of the steady-state filtering work.
- **C. PER-ACCOUNT DATABASE — NEEDS an explicit one-time purge.** The fixed build opens a NEW
  `deltos-<accountId>` DB; the pre-fix shared `deltos` DB is orphaned but NOT auto-deleted → it dangles
  forever. Requires an explicit `indexedDB.deleteDatabase('deltos')` (+ the legacy localStorage keys) on
  migration.

**SW Cache Storage:** holds only the app shell (precache); `/api` is denylisted (pin-storage-1) → no
tenant data in the SW cache. Workbox auto-rotates the precache on each deploy, so no manual tenant-data
purge there. (An optional belt for a TOTAL reset: unregister the SW / clear Cache Storage — cosmetic,
not a tenancy requirement.)

**Net:** B gets the rollout purge for free; A and C each need an extra, deliberate one-time
local-purge step in the fixed build. This is another point in B's favor.

---

## 5. RECOMMENDATION

**The decision collapses to ONE product question: is offline multi-account *on the same device* a v1
goal?** That single answer picks the approach, because the safe options differ only on whether they keep
other accounts' data around:

- **NO (current posture) → B: CLEAR-on-account-change.** Simplest, no schema change, no per-query
  discipline, leak-impossible, and it UNIQUELY preserves the local-first render-before-auth shell for the
  common case (same-account cold boot still renders from IDB; only a *switch* wipes).
- **YES (now or soon) → C: PER-ACCOUNT DATABASE**, NOT A. Both give multi-account, but C isolates by
  construction while A carries the widest missed-reader surface + schema churn + the W3/W8 write-side
  work. **A is dominated by C** — it achieves the same goal with more leak-risk and more maintenance.

**My recommendation: B (CLEAR).** Multi-account-on-one-device is not a stated v1 goal; the data is
disposable pre-real-users; B is the smallest, leak-proof surface, best preserves the render-before-auth
value, AND self-purges the pre-fix residue for the clean-slate rollout (no extra one-time purge codepath
— §4b). If/when multi-account becomes a goal, evolve to C (per-account DB) — a clean additive migration,
and still avoids A's per-query tax. Either way, **do not ship A (partition-in-query)** — it's the highest
ongoing leak-risk for no advantage over C.

Conditions if B (CLEAR) is chosen:
1. **Trigger:** persist a durable "last device accountId" marker (F7-safe — accountId is not a secret/token;
   only the bearer stays in-memory). On any session-establishing response whose accountId ≠ the marker,
   run a COMPLETE clear BEFORE the shell reads or sync starts, then set the marker. Also clear on logout.
2. **Completeness:** wipe `notes`, `syncQueue`, `notebooks`, `noteVersions`, `notebookQueue`,
   `deviceState['current-notebook']`, the account-scoped cursor key, AND reset the in-memory
   `notebookStore` (theme may survive — device pref).
3. **Ordering:** gate the shell/sync on "isolation ready" so the clear completes before the first
   `observe*` / `syncNow`.
4. **Data-loss:** explicitly accept dropping the outgoing account's un-pushed queue at this phase;
   revisit to drain-before-clear when real users / multi-account arrive.
5. **Evolution:** CLEAR now does not preclude PARTITION later — partition is the additive answer IF/WHEN
   offline-multi-account-on-one-device becomes a product goal. Don't pay partition's correctness tax for
   a non-goal today.

**Acceptance gate (any chosen approach):** login A → create notes/notebooks + leave an un-pushed edit →
login B → B shows ZERO of A's (list, search, trash, note-by-id, switcher) AND no A-entry pushes under B
(queue empty/scoped) AND cold-boot as B shows no A flash.

---

## Completeness-critic — what a naive "filter the notes list" map misses
1. **`syncQueue` + `notebookQueue` (no accountId)** → cross-account PUSH MIGRATION under the new bearer.
   Write-side, invisible to read-filtering. ← the big one.
2. **Unstamped locally-created notes** (accountId only after first server sync) → a strict read-filter
   hides the creator's own brand-new note; partition needs write-path stamping at creation.
3. **`current-notebook` deviceState pointer (device-global) + the in-memory `notebookStore` mirror** →
   both carry A→B.
4. **Render-before-auth cold-boot flash** of the prior account's data.
5. **note-by-id reads** (`observeNote`/`getNote`) — not just list queries; a retained URL/deep-link to
   A's note id resolves under B.
6. **Clear-ordering race** — the clear must precede the first read/sync or a window leaks.
7. **Already clean — don't regress:** `noteVersions` scope, cursor scope, SW `/api` denylist (pin-storage-1).
