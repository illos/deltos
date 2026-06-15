# Spike S2 — trkr sync sizing: findings

**Status:** complete · **Type:** throwaway research (no kept code) · **Date:** 2026-06-15

---

## 1. Change-map: trkr sync component by component

### Keep as pattern

| Component | What carries over | Deltos rewrite target |
|---|---|---|
| **Atomic write+enqueue** (`mutate.ts`) | One Dexie transaction: `db.notes.put(note)` + `db.syncQueue.add(entry)`. Row and queue entry live or die together — no window where a write exists but isn't queued. | `mutateNotes.put(note)` — same shape, entity is the note (full spine payload). |
| **Full-snapshot queue payload** | Queue stores the whole entity row, not a diff. Makes server UPSERT trivial and latest-wins dedup a simple `Map` overwrite. | Spine note = larger payload (block tree serialized as JSON in `body` column) but the same pattern holds. |
| **Sync triggers** | `online` event, 30s poll, 1s debounced post-write. | Identical triggers — none of these care about entity shape. |
| **Cursor pull** | Server stamps `server_time` at pull start; client persists it as next `since`. Cursor is in the server's time frame — sidesteps client/server clock skew. | Keep, but cursor becomes **per-notebook** (`deltos.sync.cursor.v1.<notebookId>`) since deltos scopes notes to notebooks. |
| **Server-time cursor** | Using server time (not client time) for the cursor is the right pattern regardless of conflict model. | Keep. |
| **Timestamp clamping** (`clampTimestamp`) | Clamp client-supplied `updated_at` to `min(client, serverNow)`. Came from security audit (Phase 4n). Without it a buggy client sends `updated_at: '9999-12-31'` and permanently locks the row against future updates. | Keep verbatim in concept — still protects the cursor-indexed pull even after LWW is replaced. |
| **Ownership gating** | `notes.user_id = excluded.user_id` check in UPSERT; reject writes to rows you don't own. | Keep. deltos notes are owned by the device's principal; grant-based multi-user access is a later layer. |
| **Latest-wins dedup on push** | Collapse rapid edits of the same note into one queue entry before pushing (Map keyed on `note:${id}`). | Identical pattern — prevents a burst of keystrokes from sending N payloads when one will do. |
| **Online-only read mirror** | Server-authoritative data (notebooks list, account settings) is pulled on boot/reconnect into a read-only local mirror. Never touches the syncQueue. | deltos needs the same split: note bodies are bidirectionally synced; notebook metadata + grants + user settings are server-authoritative read mirrors. |
| **`/api/` SW navigation denylist** | SPA navigation fallback in the service worker must exclude `/api/*` or direct navigations to API URLs return the cached app shell instead. Discovered as a real bug. | Copy the pattern verbatim into deltos's `sw.ts`. |
| **Sync indicator state machine** | pending / syncing / offline / error states, driven by queue count + sync status. | Rewrite UI for deltos, keep the state model. |

### Needs rework

| Component | What changes | Why |
|---|---|---|
| **Conflict resolution: LWW → version-counter fork** | Replace `WHERE excluded.updated_at > notes.updated_at` (server LWW UPSERT) with a **check-and-apply** using a `version` INTEGER column. See §2 for the full mechanic. | deltos is multi-device and will have a second surface pinned from a different entry point. LWW silently loses the older write. Fork-on-conflict gives the user both edits. |
| **D1 schema** | trkr's flat `tasks`/`services` table is irrelevant. deltos needs a `notes` table with `body TEXT` (serialized block tree), `properties TEXT` (JSON property bag), `version INTEGER`, `notebook_id`, and the `(notebook_id, updated_at)` index. | The spine is the new entity. |
| **Dexie schema** | `syncQueue` stays as a pattern. The synced entity table changes to `notes` carrying the full spine. Indexes: `[notebookId+updatedAt]`, `[notebookId+title]`, `[notebookId+version]`. Online mirrors: `notebooks`, `settings`. | Entity shape changed; notebooks add a scoping dimension. |
| **Push path queue entry** | Queue entry needs an extra field: **`baseVersion`** — the last server-confirmed version of this note at the time the edit was started. The server uses this for the conflict check. | Can't do fork-on-conflict without knowing what version the offline edit was based on. |
| **Worker `POST /push`** | No more LWW UPSERT. Logic becomes: `IF notes.version = incoming.base_version THEN UPSERT (version = base_version + 1) ELSE return conflict`. Client handles conflicts by forking. | The entire conflict model changes. The SQL changes from one UPSERT to a conditional check + UPSERT. |
| **`mergeIntoDexie` (pull merge)** | The merge guard changes: don't stomp a note that has a pending local edit (exists in syncQueue). If queue has an entry for this note ID, skip the incoming pull update (the push flush will reconcile). | LWW's `newer(incoming.updatedAt, local.updatedAt)` guard is insufficient when the client has dirty edits that haven't been pushed yet. |
| **camelCase↔snake_case mappers** | Replace `taskToServer`/`serverToTask` with `noteToServer`/`serverToNote` covering the full spine (`id, notebookId, title, properties, body, version, baseVersion, createdAt, updatedAt, deletedAt`). | Entity changed. |

### Drop

| Component | Why |
|---|---|
| `tasks`/`services` specific schema, types, mappers | Irrelevant — deltos's entity is the note. |
| TRKR push handlers in `sw.ts` | TRKR-specific; deltos doesn't use push notifications at launch. |
| `ownedTaskIds()` parent-join ownership check | `services` needed a join because they carried no `user_id`. deltos notes carry `notebook_id` (and notebooks carry the owner); a simpler `notebook_id` scope check replaces it. |
| Field-ownership `CASE` gates (invoice/billing state) | TRKR-specific business logic. deltos's server-owned fields are the grant + encryption metadata, not billing state. |

---

## 2. Version-counter fork mechanic (concrete threading)

### Where the counter lives

- **D1:** `notes.version INTEGER NOT NULL DEFAULT 1`. Bumped by the server on each accepted push.
- **Dexie local store:** `notes.serverVersion` — the last version the server confirmed (set on successful push; set from pull response). Separate from the client's local version which may be ahead (dirty edits).
- **syncQueue entry:** adds `baseVersion: number` — the `serverVersion` at the time the edit began.

### When it bumps

- Server bumps `version = base_version + 1` on a successful push. Never bumped client-side.
- This means the server is the authoritative version incrementor. The client tracks what it last saw.

### Threading through the push flow

```
1.  User edits note N (last serverVersion = 3).
    Local: note is dirty. Queue entry: { recordId: N.id, payload: note, baseVersion: 3 }

2.  syncNow() fires. Latest-wins dedup (collapses rapid edits to one entry).
    POST /api/sync/push { notes: [{ ...notePayload, base_version: 3 }] }

3.  Worker checks:
    SELECT version FROM notes WHERE id = ? AND notebook_id = ?
    → version = 3 (unchanged since client last saw it)
    → UPSERT, SET version = 4, updated_at = clamp(client.updated_at, serverNow)
    → return { accepted: [N.id], conflicts: [] }

4.  Client: bulkDelete queue entries for N. Update notes.serverVersion = 4.

--- conflict scenario ---

5.  Same note N was also edited from another device while this device was offline.
    That device already pushed → server version is now 4.

6.  This device reconnects. Pushes with base_version: 3.
    Worker: SELECT version → 4. 4 ≠ 3 → conflict.
    Return { conflicts: [{ id: N.id, serverVersion: 4, serverNote: <full row> }] }

7.  Client conflict handler:
    a. Take the server's note (version 4) — put it into local Dexie as-is.
       Update notes.serverVersion = 4. Clear queue entry for N.
    b. Mint a new note (new client UUID) from the local dirty payload.
       Title: "<original title> (offline edit, <date>)". version: 1, serverVersion: 0.
       Add to syncQueue for immediate push.
    c. (UX) surface a "needs attention" badge — two copies now exist.
```

### Residual: edit-while-syncing

If a push is in-flight and the user makes another edit, that edit lands in the queue with `baseVersion` = last known serverVersion (same as the in-flight push's base). On successful push return, the client updates `serverVersion` to the new value. The next sync cycle re-pushes with the updated `baseVersion` — safe, no data loss.

If the push fails (network), the queue still has both the old and new entries; latest-wins dedup collapses them on the next attempt.

---

## 3. Block sync granularity — recommendation

**Recommendation: whole-note granularity.** Blocks are serialized as a JSON array in `notes.body`.

### Why whole-note wins

- **Version-counter fork requires whole-note atomicity.** Forking is a note-level operation ("copy the whole note"). You cannot fork at block granularity without a completely different conflict model (per-block version counters, per-block conflict detection, partial-note fork — none of which align with brainstorm's "write a copy" design).
- **trkr's dedup + latest-wins still works.** Rapid edits collapse to one queue entry (the full note snapshot). The dedup key is `note:${id}` — unchanged from trkr's `tasks:${id}` pattern.
- **The pull query stays simple.** One `SELECT * FROM notes WHERE notebook_id = ? AND updated_at > ?` — no block-level join.
- **Blobs are already separated.** Media blocks reference blobs by content hash, not inline bytes. The note payload carries the hash, not the file — so large media doesn't bloat sync payloads. A separate blob queue handles uploads.
- **D1 JSON columns are practical.** SQLite stores `body TEXT` efficiently. A 100-block note with typical text content is well under 100KB. `json_extract()` enables server-side search indexing later.

### Trade-offs (accepted)

| Trade-off | Implication |
|---|---|
| No per-block history | History is a future slice; whole-note snapshots suffice for v1 and can be extended later. |
| Large note bodies in sync payload | Mitigated by blob separation. Text-heavy notes stay small. Media-heavy notes are just hashes. |
| No server-side block-level query without JSON parsing | Full-text search runs against a separate index, not the `body` column directly. Server-side `json_extract` available for structured queries if needed. |

### Per-block (rejected for v1)

Would require: a `blocks` table in D1, per-block version tracking, a multi-table push payload, join-heavy pulls, and a block-level conflict model. Complexity is disproportionate; defer to a future refinement if large documents or CRDT collaboration demand it.

---

## 4. Phase 1 substrate+sync sizing

### D1 schema scope
- `notes` table + `notebooks` table + `grants` stub (foreign key target). Indexes on `(notebook_id, updated_at)`, `id` PK. Migration: ~0.5 day.

### Dexie schema + online mirrors
- `notes`, `syncQueue`, online mirrors (`notebooks`, `settings`). ~0.5 day.

### Mutate layer
- `mutateNotes` (put/update/bulkPut), `makeSyncEntry()` with `baseVersion`. ~0.5 day.

### Sync engine (`syncStore.ts` equivalent)
- Push path: dedup, `noteToServer` mapper, `POST /api/sync/push`, conflict handler (fork copy), queue drain. Pull path: per-notebook cursor, `mergeIntoDexie` with pending-edit guard, `serverToNote` mapper. Trigger wiring. Version-counter integration. ~2.5 days (the fork-on-conflict logic and the merge guard are new; LWW would be ~1 day).

### Worker sync endpoints (`sync.ts` equivalent)
- `GET /sync/pull?notebookId=&since=` cursor-filtered note pull. `POST /sync/push` check-and-apply with conflict return. `clampTimestamp`. Ownership gate. ~1 day.

### Conflict UX surface
- Sync indicator rewrite (same state machine). Conflict badge + "needs attention" view (minimal for v1). ~0.5 day.

**Total Phase 1 substrate+sync: ~5.5 days** (clean deltos-native authorship; no porting credit for trkr since everything is reworked to the new spine + conflict model).

**Phase 0 foundation (not full sync):** PWA shell + Worker scaffold + D1 schema stub + API contract types + core spine TS types + the `/api/` denylist SW. ~2–3 days.

### Module shape (deltos-native names)

```
src/db/schema.ts           -- Dexie schema (notes, syncQueue, online mirrors)
src/db/mutate.ts           -- atomic write+enqueue for notes
src/lib/syncEngine.ts      -- push/pull/conflict orchestration, status store
src/lib/apiFetch.ts        -- fetch wrapper
src/components/SyncStatus.tsx  -- status indicator
worker/routes/sync.ts      -- GET /sync/pull + POST /sync/push
worker/routes/notebooks.ts -- online-only notebook mirror endpoints
worker/lib/clampTs.ts      -- timestamp clamping (keep the lesson)
migrations/0001_init.sql   -- notes + notebooks schema
```

---

## 5. Editor engine — which doc model maps cleanest onto the synced block-tree

The block spine is `{ id: string, type: string, content: ..., children?: Block[] }` — a typed, addressable, nestable tree. Sync granularity is whole-note; the editor serializes its document to/from this shape on save and load. The key requirements:

1. **Typed node tree** — every block has a type that maps to a spine type.
2. **Stable block IDs** — blocks need IDs for the plugin island model (host refers to blocks by stable ID for future collab seam) and for future per-block history.
3. **Opaque island model** — a plugin block is an opaque node; the editor owns the cursor and reorder around it; the plugin owns the inside.
4. **Collab seam** — not built in Phase 1, but the editor must support "promote note to DO-based collab" later without a rewrite.

### ProseMirror

- **Doc model:** `Node { type, attrs, content: Node[], marks }`. A typed, nested tree — structurally identical to the spine. Block IDs are a node `attrs.id`. The schema declares node types (heading, paragraph, listItem, codeBlock, etc.) — maps 1:1 to the spine's core block types.
- **Stable IDs:** add as a node attribute; a custom plugin ensures every node gets an ID at creation and it persists through transforms. Well-established pattern.
- **Opaque island:** `NodeView` — a plugin registers a custom view for its node type, owning rendering+editing inside while PM owns everything between nodes. This **directly implements** the `plugin block = opaque island` design.
- **Collab seam:** PM's **Steps** (atomic, composable document transforms) + the `collab` package are the proven path to OT/CRDT collab. Mapping steps to Durable Object messages is well-documented. The promote-to-DO design aligns with PM's existing ecosystem.
- **Serialization:** custom `pmDocToSpine()` and `spineToPmDoc()` transforms — a few hundred lines, manageable. PM's existing JSON serialization is a close starting point.
- **Fit: excellent.** PM's data model is essentially the spine.

### Lexical

- **Doc model:** an `EditorState` graph of `LexicalNode { __key, __type, __parent, __children }`. Nodes are tree-structured but the API is mutation-via-commands (`editor.update()`), not immutable transforms.
- **Stable IDs:** `__key` is Lexical-internal (ephemeral per session, not persisted). To get stable block IDs you'd need a custom `__id` attribute and a serialization layer that maps `__key` → stable `__id` on export. This adds friction.
- **Opaque island:** `DecoratorNode` — a node type that delegates rendering to an external component. Similar semantics to PM's `NodeView`.
- **Collab seam:** `@lexical/yjs` (experimental, Yjs-based). Yjs + Durable Object is a valid collab path, but it's off-axis from the "promote to DO, use PM Steps" design. If collab is Yjs-first, Lexical is fine; if collab is OT/Steps-first, it adds friction.
- **DX:** excellent — Meta actively develops it; the command/listener model is ergonomic for Phase 1. But the stable-ID friction and Yjs-collab path are both off-axis from the deltos design.
- **Fit: good, with caveats.**

### TipTap

- **Built on ProseMirror** — inherits all of PM's structural advantages.
- **Extensions API** — ergonomic block type registration (less boilerplate than raw PM). Good for quickly authoring the 12 core block types.
- **NodeView is the same** — TipTap extensions wrap PM NodeViews; plugin islands work the same way.
- **Collab seam:** `@tiptap/extension-collaboration` wraps PM + Y.js. This adds a Yjs dependency over PM's own Steps package. If you want PM Steps collab later, you'd be working around the Yjs layer.
- **Tradeoff:** TipTap's abstraction makes the ergonomic day-1 easier but adds opacity at the collab seam. You can reach through the abstraction to raw PM (`editor.view` is the PM EditorView), but it's less clean.
- **Fit: good for Phase 1 velocity; slightly weaker at the collab seam.**

### Recommendation (for planSys to decide)

**ProseMirror** is the clearest structural match: the node schema is the spine, `NodeView` is the island model, and PM Steps is the natural collab path for the promote-to-DO design. The ergonomic cost is real (more boilerplate per block type), but deltos has only ~12 core block types plus plugin islands — a bounded problem.

**TipTap** is the pragmatic Phase 1 choice if ergonomic speed matters in the first vertical slice. The collab seam costs can be deferred (the PM underpinning is still there). Not unreasonable if the team reaches through the abstraction deliberately.

**Lexical** is the weakest fit: the stable-ID friction and the Yjs-collab path are both off-axis. Lexical's advantages (DX, Meta backing) don't outweigh the structural friction for deltos's specific shape.

**Suggested signal to planSys:** if Phase 1 is building the collab seam placeholder (just the design, not the build), prefer ProseMirror and eat the boilerplate. If Phase 1 is purely "working note creation + sync, no collab seam", TipTap is defensible and the PM foundation is still there when collab arrives.

---

## 6. Landmines banked

| Landmine | Risk | Mitigation |
|---|---|---|
| **Stable client UUIDs** | If UUID is generated at sync time (not at creation), two offline creates on different devices may produce identical IDs → dup-on-sync. | Generate UUID at note creation, persist immediately. `crypto.randomUUID()` on the client. Never defer to server. |
| **Edit-while-syncing** | Push in-flight; user edits the same note. New edit has `baseVersion` = last known, same as in-flight push. On push success, `serverVersion` updates; next cycle pushes with correct new `baseVersion`. On push failure, both queue entries merge (latest-wins dedup). | Handled by the baseVersion + latest-wins dedup. Must update local `serverVersion` synchronously on push success before triggering the next cycle. |
| **Timestamp clamping** | Client-supplied `updated_at: '9999-12-31'` permanently locks the row against future cursor-pull updates (since `WHERE updated_at > since` never matches). | `clampTimestamp(client, serverNow)` on every push, server side. Keep this unconditionally. |
| **Per-notebook cursor** | trkr has one global cursor. deltos's notes are notebook-scoped; a single global cursor would over-pull (returning notes from all notebooks, even those not open) or under-pull (missing notes added to other notebooks). | Cursor keyed per notebook: `deltos.sync.cursor.v1.<notebookId>`. Pull endpoint scoped to `notebookId` param. |
| **Fork copy is relationally lossy** | Forked copy gets a new ID. `relation` properties on other notes pointing to the original now point to the "old" version, not the fork. | Accepted trade-off (per brainstorm). UX must surface forks prominently and offer manual merge/dedup later. Forked copy should carry a `forkedFromId` metadata field. |
| **Blob queue vs note queue** | A note that references a blob may sync (version counter advances) before the blob upload completes. The receiving device has a valid note with a broken blob reference. | Separate blob sync queue with its own status signal. Note sync and blob sync are independent; UI must show "note synced, attachment pending" state. |
| **Full-sync on cursor clear** | Clearing `localStorage` (or first install) triggers a full re-pull of all notes in all notebooks. For large vaults this can be heavy. | No immediate mitigation — acceptable for v1. Design the pull endpoint to support pagination later (`LIMIT`/`OFFSET` or keyset). |
