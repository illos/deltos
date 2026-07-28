# Collections — design spec

Status: **design — SIGNED OFF (Jim, 2026-07-28), ready to build**. Author: Lead (T3). Scope: a new
grouping primitive for notes — folder-like, metadata-powered, manual membership in v1 with a
reserved seam for future filter/auto membership. Fully first-class over sync, REST, and MCP.

**Locked decisions (Jim, 2026-07-28):** (1) user-facing name = **Collections**; (2) v1 = **manual
membership only** (rule/auto seam reserved, not built); (3) surface = collections **live inside a
notebook** and render as **inline accordion folders in the default note view** — tap a collection
header and it expands *in place* to reveal its notes (no navigation). Each collection has a **home
notebook**; the join-table model is retained so a future null-home = cross-notebook/global collection
lands with zero rewrite.

Grounded against live code; every non-trivial claim cites `path:line`. deltos values honored:
**one user (Jim)** — no multi-user/a11y taxes; **performance north star** — collections add one
lazy nav section + one lightweight sync arm, nothing on the note-render hot path; **reuse** — the
grouping rides the exact notebook sync machinery and the existing note-list display seam; **correctness
as a pattern** — the data model is chosen so concurrent membership edits from phone + laptop + an
agent never contend ([[sync-asap-conflict-window]]).

---

## 1. What a collection is (and is not)

- A **collection** is a named, metadata-powered grouping of notes. It is folder-like and is often
  *displayed* as a folder, but it is not a container the note "lives in."
- A note lives in **exactly one notebook** (`notebookId: NotebookId | null`, `spine/identity.ts:43`;
  `null` = All Notes). That is unchanged.
- A **collection lives inside one notebook** (its **home notebook**, `collection.notebookId`) and
  displays as an accordion folder in that notebook's note list (§5.2). A note can belong to **zero or
  many collections** within its notebook, independent of and on top of the flat note list.
- **Cross-notebook is a reserved future** — the join-table model + a nullable `collection.notebookId`
  mean a later "global collection" (null home, gathers across notebooks) lands with no rewrite. v1
  ships home-notebook collections only.
- **v1 = manual membership** (Jim/an agent explicitly adds/removes notes). The model reserves a
  `rule` field so **v2 auto-membership** (filters/parameters: "all notes tagged X", "notebook Y +
  contains Z") slots in with **no data-model migration** — effective membership becomes the *union*
  of manual members + rule-matched notes (§8).

### 1.1 Naming — resolve the collision up front

The word "collection" is already load-bearing in two unrelated places:

- `lib/collectionViews.ts` — `CollectionView` is the **per-notebook display seam** (list vs board
  *rendering* of a note list). Nothing to do with grouping.
- `mcp/tools.ts:119,458` — `gate: 'collection'` is an MCP enum meaning "the tool returns a
  *collection of results* and self-filters." Nothing to do with grouping.

**Resolved (Jim, 2026-07-28): user-facing name = "Collections."** Code entity = `Collection` /
`collectionId`, join = `CollectionMember`. We accept the overload — the two existing usages read
differently enough (`CollectionView` is a render descriptor; the gate is an internal enum) that a
rename isn't worth the churn. Reviewers: don't confuse `Collection` (the grouping entity) with
`CollectionView` (the list/board render seam).

---

## 2. The data-model decision (the crux)

Membership is many-to-many. Three ways to store it — the choice drives every other layer.

| Model | Membership lives on | Concurrent-add contention | Server "notes in collection X" | Migration cost |
|-------|--------------------|---------------------------|-------------------------------|----------------|
| **A** note property bag (`sys:collections: string[]`) | the note | contends on the **note's** CAS version; JSON array | full-table JSON scan (D1 can't index a JSON array) | zero |
| **B** collection row (`collection.noteIds: string[]`) | the collection | **every add/remove rewrites the whole collection row** → constant CAS contention + big rows | trivial | zero |
| **C** join entity (`collectionMembers` rows) | its own synced row | **none** — each membership is an independent row | indexed lookup both directions | new table + sync arm |

**Decision: Model C — a `collectionMembers` join entity, synced as a first-class account-scoped
record on `accountSyncSeq`, mirroring the notebook sync machinery.**

Why not the zero-migration options:

- **Model B is disqualified.** Two devices (or an agent + Jim) adding *different* notes to the same
  collection concurrently both bump the same collection row's version → CAS conflict on every
  concurrent add. Against [[sync-asap-conflict-window]] this is the worst possible shape.
- **Model A collapses into C anyway.** A many-to-many can't be a single indexed column (unlike
  `notebookId`), so Model A stores membership as a JSON array — which D1 cannot index, making the
  agent-facing "list notes in collection X" a full-table scan. Since "helpful to agents via MCP" is
  a stated requirement, we need server-side indexed queryability in *both* directions, which is
  exactly what a join table gives.

Model C is the textbook many-to-many and the only option where membership edits never contend and
both lookup directions are indexed. Cost is one new synced entity type — and we already have the
notebook entity as a complete, proven template for every layer it touches.

---

## 3. Two new synced entities

### 3.1 `Collection` — the grouping's identity (mirrors `Notebook`)

Shared schema — new `packages/shared/src/spine/collection.ts`, modeled on `spine/notebook.ts:43-59`:

```ts
export const CollectionSchema = z.object({
  id: CollectionIdSchema,          // new branded id in spine/ids.ts, UUID, client-generated
  notebookId: NotebookIdSchema.nullable(),  // HOME notebook. v1: always set; null (v2) = global/cross-notebook
  name: z.string().min(1).max(200),
  icon: z.string().max(64).optional(),    // reuse the notebook/icon token set (icons/)
  color: z.string().max(32).optional(),   // theme token key
  order: z.number().default(0),           // accordion order within the home notebook's list
  rule: CollectionRuleSchema.nullable().default(null),  // v1: always null; v2 auto-membership (§8)
});
export const CollectionDraftSchema =
  CollectionSchema.pick({ notebookId: true, name: true, icon: true, color: true, order: true, rule: true });
```

The `notebookId` is `nullable` in the schema for v2-readiness, but v1 create/update **always sets it**
(a collection is created from within a notebook). A collection whose home notebook is deleted follows
the notebook cascade — see §4. Ownership: server verifies the `notebookId` is owned by the same
`accountId` on create/update (same belt as a note move, `db/mutate.ts:180-185`).

`CollectionRuleSchema` in v1 is `z.null()` widened to `z.unknown().nullable()` behind a named
schema so v2 can fill it without a protocol break (§8). The server treats `rule` as opaque in v1.

D1 table — new migration `0025_collections.sql`, mirroring `0008_notebooks.sql`:

```sql
CREATE TABLE collections (
  id         TEXT    NOT NULL PRIMARY KEY,
  accountId  TEXT    NOT NULL,
  notebookId TEXT,                        -- HOME notebook (v1 always set; NULL reserved for v2 global)
  name       TEXT    NOT NULL,
  icon       TEXT,
  color      TEXT,
  ord        REAL    NOT NULL DEFAULT 0,   -- accordion order within the home notebook
  rule       TEXT,                        -- JSON, NULL in v1
  version    INTEGER NOT NULL DEFAULT 1,
  createdAt  TEXT    NOT NULL,
  updatedAt  TEXT    NOT NULL,
  deletedAt  TEXT,                         -- tombstone; NULL = live
  syncSeq    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX collections_accountPull ON collections (accountId, syncSeq);
CREATE INDEX collections_byNotebook  ON collections (accountId, notebookId, deletedAt);
```

### 3.2 `CollectionMember` — the join (new shape, still on the notebook sync spine)

```ts
export const CollectionMemberSchema = z.object({
  id: CollectionMemberIdSchema,    // DETERMINISTIC: collectionMemberId(collectionId, noteId) — see below
  collectionId: CollectionIdSchema,
  noteId: NoteIdSchema,
  ord: z.number().default(0),      // manual ordering within the collection (reuses reorder infra later)
});
```

**Member id is DETERMINISTIC, not random.** `collectionMemberId(collectionId, noteId)` (exported from
shared, a uuidv5 over a fixed namespace + `${collectionId}:${noteId}`) — so every device (and the MCP
`add_notes_to_collection` tool) computes the *same* id for the same (collection, note) pair. Add becomes
a pure idempotent upsert on the unique triple: no re-keying, tombstones propagate normally, and a
remove-then-readd across an offline peer can't produce a duplicate membership. Clients MUST use this
helper, never `crypto.randomUUID()`, for member ids.

D1 table in the same `0025` migration:

```sql
CREATE TABLE collectionMembers (
  id           TEXT    NOT NULL PRIMARY KEY,
  accountId    TEXT    NOT NULL,
  collectionId TEXT    NOT NULL,
  noteId       TEXT    NOT NULL,
  ord          REAL    NOT NULL DEFAULT 0,   -- fractional order for cheap reinserts
  version      INTEGER NOT NULL DEFAULT 1,
  createdAt    TEXT    NOT NULL,
  updatedAt    TEXT    NOT NULL,
  deletedAt    TEXT,                          -- tombstone; NULL = live member
  syncSeq      INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX collectionMembers_unique ON collectionMembers (accountId, collectionId, noteId);
CREATE INDEX collectionMembers_accountPull ON collectionMembers (accountId, syncSeq);
CREATE INDEX collectionMembers_byCollection ON collectionMembers (accountId, collectionId, deletedAt);
CREATE INDEX collectionMembers_byNote       ON collectionMembers (accountId, noteId, deletedAt);
```

The unique index makes "add note already in collection" idempotent (upsert-revive the tombstone
instead of a second row). `byCollection` / `byNote` give indexed lookup in **both** directions —
the property that ruled out Models A/B.

**Membership lifecycle = create + tombstone + (optional) reorder**, exactly the notebook entry
shape (`api/sync.ts:60-69`): `baseVersion 0` = add, `delete: true` = remove (soft, so the removal
propagates over sync), CAS `version` bump = reorder. Removing a note from a collection is a
tombstone, never a hard delete — so a device that was offline still learns the note left.

---

## 4. Sync protocol — a fourth (and fifth) push/pull arm

The pull is already a UNION over `notes + notebooks + dictionaryWords` on one account cursor
(`db/mutate.ts:446-455`). We add `collections` and `collectionMembers` as two more UNION arms —
same `WHERE accountId=? AND syncSeq > cursor`, same single interleaved cursor. No new cursor, no
protocol fork.

Push (`api/sync.ts:92-99`) gains two arrays alongside `notebookEntries`:

```ts
collectionEntries:       z.array(CollectionPushEntrySchema).max(100).default([]),
collectionMemberEntries: z.array(CollectionMemberPushEntrySchema).max(100).default([]),
```

`CollectionPushEntrySchema` / `CollectionMemberPushEntrySchema` mirror `NotebookPushEntrySchema`
(`draft | delete`, `baseVersion`, discriminated accept/conflict result — `api/sync.ts:60-140`).

**Ordering (secSys #19):** the push handler (`routes/sync.ts:150-197`) must process in
dependency order: **notebooks → collections → collectionMembers → notes**. A member entry naming a
collection created in the same batch must see it; the collection-ownership check on a member insert
must be able to resolve the collection's `accountId`.

**Referential hygiene (server, fail-safe not fail-loud):** on a `collectionMembers` insert, verify
the `collectionId` **and** `noteId` are owned by the same `accountId` (the same ownership belt as
the note-move check, `db/mutate.ts:180-185`). A member naming a foreign or missing collection/note
is **rejected as a conflict** — never a 400 that wedges the whole batch ([[GOTCHA-0008]]: one bad
entry must never 400 the batch).

**Cascade on delete:**
- Delete a **collection** → tombstone the collection row **and** tombstone all its live members
  (account-scoped, each member gets a distinct syncSeq). Notes are untouched (they only lost a
  grouping). This mirrors `deleteNotebook`'s two-step uncategorize (`db/notebooks.ts:132-163`).
- Delete a **home notebook** → its notes uncategorize to All Notes as today (`db/notebooks.ts:132-163`),
  **and** its collections tombstone (with their members). A collection cannot outlive its home notebook
  in v1 (its notes fall back to the flat All-Notes list). Fold this into `deleteNotebook` as a third
  step, same account-scoped syncSeq bump.
- Trash a **note** → **memberships are NOT tombstoned** (decided 2026-07-28). deltos note-delete is a
  soft-trash (`sys:trashedAt` via `updateNote`), and keeping the membership rows means trash→restore
  preserves collection membership. A trashed note is *hidden* from collection accordions client-side
  (the same `sys:trashedAt` filter the flat list uses). A truly hard-deleted note leaves orphan member
  rows, which are harmless — the client/`get_collection` join skips a missing note.

---

## 5. Client — Dexie, mutations, sync engine

Mirror the notebook client stack (agent-mapped: `db/schema.ts:51-100,187-230`,
`dexieLocalStore.ts:366-420`, `mutateNotebooks.ts`, `syncEngine.ts:502-591`):

- **Dexie tables** (schema version bump): `collections` (`id`), `collectionMembers`
  (`id, collectionId, noteId, [collectionId+ord], accountId`), plus `collectionQueue` and
  `collectionMemberQueue` (mirror `notebookQueue`).
- **Reactive queries:** `observeCollections()` (live, `deletedAt === null`, sorted by name/order).
  Effective membership for a collection = live members `byCollection` (client already holds all
  notes locally, so resolving member `noteId`s to notes is a local join, no network).
- **Mutation API** — new `db/mutateCollections.ts`: `create`, `rename`/`setIcon`/`setColor`
  (CAS on version), `delete` (+ local member-tombstone cascade), `addNotes(collectionId, noteIds)`,
  `removeNotes(collectionId, noteIds)` (member create/tombstone), `reorder`.
- **Sync engine:** `mergeCollections` + `mergeCollectionMembers` (put + reconcile), `pushCollections`
  + `pushCollectionMembers` (dedupe-latest-wins per recordId, POST via the shared push, apply
  accept/conflict) — direct analogs of `mergeNotebooks`/`pushNotebooks`.

### 5.1 Display: inline accordion folders in the note list (NO new browse context)

Jim's model (2026-07-28): collections **live inside the notebook** and render as **accordion folders
inline in the default note view** — tapping a collection header expands it *in place* to reveal its
notes. There is **no separate collection route/destination** and therefore **no `BrowseContext`
generalization** — the current context stays `notebookId: NotebookId | null` exactly as today
(`notebookStore.ts`). This is a pure *presentation* layer over the existing note list.

The note-list view for a notebook composes into two zones, top-to-bottom:

1. **Collection accordions** — one collapsible header per live collection whose `notebookId` = the
   current notebook (query `collections_byNotebook`), ordered by `ord`. Collapsed by default;
   tapping expands inline to show that collection's member notes (live members `byCollection` → local
   join to notes; trashed notes hidden). Expanded/collapsed state is **device-local UI state** (not
   synced) — a small set of open collection ids in the existing device-state store.
2. **Loose notes** — the flat note list, exactly as today.

A note that is a member of a collection still appears in the flat loose list too (membership is
additive metadata, not a move). We do **not** hide collected notes from the flat list in v1 —
collections are an *overlay* grouping, not a partition. (If Jim later wants "filed notes leave the
flat list," that's a one-line filter, no data change.)

**Rendering seam:** the collection accordion body reuses the same note-row component the flat list
uses — a collection is just another note list, so it inherits Board/Keep view later for free via
`resolveCollectionView` (`lib/collectionViews.ts:22-30`) without any collection-specific work.

**All Notes (`notebookId = null`):** v1 shows no collection accordions there (collections have a
concrete home notebook; the null-home/global case is v2). All Notes stays the flat aggregate.

### 5.2 UI surface (minimal, lazy)

- **In-list accordions:** as §5.1 — the collection headers + expand/collapse live in the note-list
  view. The accordion chrome reuses the app's existing disclosure/overlay CSS language.
- **Create a collection:** an affordance in the notebook's "…" menu ("New collection") and/or a
  header row in the note list; creates a collection with `notebookId` = current notebook.
- **Add/remove a note:** a resident in the note's context menu / swipe surface — "Add to
  collection…" → multi-select sheet of the notebook's collections (with create-new inline). Mirrors
  the notebook "…" menu pattern (`docs/design/notebook-menu-and-keep-view.md`). Drag-a-note-onto-a-
  collection-header is a v2 nicety on the existing @dnd-kit infra ([ROAD-0019]); v1 is menu-driven.
- **Manage:** rename/icon/color/delete/reorder live in the collection header's own "…" menu, reusing
  `ContextMenuSheet`.
- Everything past first paint is a **lazy off-track chunk** ([CONV-0004], [[plugins-lazy-past-first-paint]]).

---

## 6. MCP + REST — first-class for agents

Add to the tool registry (`mcp/tools.ts:284`), following the `create_notebook` template
(`tools.ts:702-736`) and the plugin-declared aggregation seam (`shared/src/mcp/agentTools.ts`):

| Tool | op | resource / gate | Notes |
|------|-----|-----------------|-------|
| `list_collections` | read | `gate: 'collection'` (scope-presence, self-filter) | returns `{id,name,icon,notebookId,memberCount}[]`; optional `notebookId` arg filters to one notebook |
| `get_collection` | read | `resource: {kind:'collection', id}` | collection + its effective notes (manual now, +rule later) |
| `create_collection` | create | `resource: {kind:'notebook', id: notebookId}` | requires `notebookId` (home notebook); server-mints id, stamps accountId, verifies notebook ownership |
| `update_collection` | write | `resource: {kind:'collection', id}` | rename/icon/color (rule in v2) |
| `delete_collection` | delete | `resource: {kind:'collection', id}` | cascade member-tombstone |
| `add_notes_to_collection` | write | `resource: {kind:'collection', id}` | idempotent via unique index |
| `remove_notes_from_collection` | write | `resource: {kind:'collection', id}` | member tombstone |

Plus enrich existing read tools so an agent *sees* collections without extra calls:
`get_note` / `search_notes` responses gain a `collections: {id,name}[]` field, and `create_note`
accepts an optional `collectionIds` to file on creation.

**Authz — extend the `Resource` union** (`shared/src/api/grant.ts:54-58`):

```ts
z.object({ kind: z.literal('collection'), id: CollectionIdSchema }),
```

Coverage in `canWith` (`auth.ts:227-268`): a collection is account-scoped and **crosses
notebooks**, so it does **not** nest under a notebook grant. Rule: a **workspace** grant covers all
collections; an explicit **collection** grant covers that collection; a notebook/note grant does
**not** cover a collection. In practice Jim's tokens are workspace-default, so collection tools work
out of the box; the model is nonetheless correct for future narrowed tokens. Write tools charge the
`mcpWrite` daily cap like every other write (`mcp.ts:240-260`).

REST mirrors (`index.ts:218-421` pattern): `POST /api/collections`, `PATCH/DELETE
/api/collections/:id`, `POST /api/collections/:id/notes`, `DELETE /api/collections/:id/notes/:noteId`
— each through the same `guard()` chokepoint. (Optional for v1 if MCP suffices; the sync arm is the
mandatory path.)

---

## 7. Diagnostics & schema-first

- Add `collections` + `collectionMembers` to the diagnostic snapshot dump ([CONV-0008]) and validate
  via the new push-entry schemas.
- Every new boundary (push entries, tool args, REST bodies, D1 rows) is **schema-first** — Zod is the
  source of truth, the static type is derived (`/schema-first`).

---

## 8. Future auto-membership (reserved seam, not built in v1)

`collection.rule` (nullable, opaque in v1) will hold a serialized predicate — e.g.
`{ all: [{ notebook: id }, { text: 'invoice' }, { property: {key,val} }, { updatedAfter: ts }] }`.
**Effective membership = union(live `collectionMembers`, notes matching `rule`).** Rule evaluation:
client-side over the local note set (cheap, reactive); server-side compiled to a D1 `WHERE` for
`get_collection`/MCP. Because manual membership is already its own table and `rule` is already a
column, v2 is **additive** — no migration to the membership model, no protocol break. v1 shipping
`rule = null` everywhere is the whole point of choosing Model C now.

---

## 9. Build plan — lanes for the team

Dependency spine first, then parallel fan-out. Red-team audits each lane as it lands.

- **Lane 1 — backend spine (S1).** `spine/ids.ts` branded ids; `spine/collection.ts` schemas;
  `api/sync.ts` push-entry + result schemas + two request arrays; migration `0025`; `db/collections.ts`
  (insert/rename/delete + member add/remove/reorder, ownership belts); `db/mutate.ts` pull UNION arms;
  `routes/sync.ts` push ordering + results. Unit tests: CAS, cascade, cross-account rejection,
  one-bad-entry-doesn't-400.
- **Lane 2 — client (S2), after Lane 1 contract lands.** Dexie tables + queues; `mutateCollections.ts`;
  `syncEngine` merge/push; `BrowseContext` generalization; nav section + add-to-collection sheet +
  collection list via existing display seam. Component/integration tests that MOUNT the tree
  ([[ui-features-need-rendered-ui-gate]]).
- **Lane 3 — MCP + REST (S1, parallel with Lane 2).** Tool defs + `Resource` union extension +
  `canWith` collection coverage + REST routes + response enrichment. Scope-enforcement tests.
- **Red-team (continuous).** Focus: cross-account membership leak (member naming a foreign
  collection/note), CAS/conflict correctness under concurrent add, sync-batch resilience
  ([[GOTCHA-0008]]), MCP scope enforcement for the new `collection` Resource kind, `mcpWrite` cap.
- **Integration + deploy (Lead).** Green-gate (strict tsc + vitest, [[green-gate-needs-prod-typecheck]])
  → migration `--remote` → deploy → live smoke → Jim feel-pass on the live site
  ([[review-on-live-never-local-preview]]).

## 10. Non-goals for v1

Auto/filter membership (seam only), drag-to-collection, Board/Keep view of a collection (free later
via the display seam), nested collections, sharing a collection via `/s/*` (rides ROAD-0011 later),
collection-scoped agent grants.

## 11. Decisions — RESOLVED (Jim, 2026-07-28)

1. **Name → "Collections"** (`Collection`/`collectionId` in code; `CollectionView` kept as-is). §1.1.
2. **v1 scope → manual membership only**; `rule`/auto seam reserved, not built. §8.
3. **Surfacing → inline accordion folders in the notebook's default note view**, expand-in-place on
   tap; each collection has a home notebook; no separate route, no `BrowseContext` change. §5.1.
   Cross-notebook/global (null home) is a reserved v2 relaxation, no rewrite.
