# Notebook "…" menu + Keep-style board view — design spec

Status: design (not yet built). Author: design crew. Scope: fill the notebook `ContextMenuSheet`
"…" shell with real residents (rename · share · sort · view), and add a Google Keep-style board
`CollectionView`. Grounded against the live code; every non-trivial claim cites `path:line`.

deltos values honored throughout: **one user (Jim)** — no a11y/i18n/multi-user taxes; **performance
north star** — the Keep grid is a lazy off-track `CollectionView`, never static-imported into the
entry; **reuse** — the menu, popover, and card visuals re-source existing overlay/theme CSS; **live=dev**
— this changes real look/feel, no scaffolding.

---

## 1. Summary (5 bullets)

- **Fill the "…" menu.** `ContextMenuSheet` is an empty shell today
  (`components/ContextMenuSheet.tsx:48-51`). It becomes a per-notebook options surface with four
  residents: **Rename**, **Share notebook**, **Sort**, **View** — mobile bottom-sheet + a desktop
  equivalent popover, reusing the app's overlay language.
- **Rename** rides the existing, already-built notebook sync path (`mutateNotebooks.rename`,
  `db/mutateNotebooks.ts:39-52`) — no new mutation, no schema change. Only the missing UI is added.
- **Notebook share** is already a **complete server feature** (mint → `/s/<token>` renders the
  notebook's note list, theme-stamped — `worker/src/routes/shareSurface.ts:455-482`). Part 2 is purely
  a **client relocation**: move the "Share this notebook" mint UI out of the per-note
  `ShareLinkSection` into the notebook menu. The per-note share stays in the note.
- **Sort** ships 4 modes (Last modified · Alphabetical · Date created · Custom drag-drop). The chosen
  mode + custom order persist **synced, per-notebook** via the existing `NotebookDraft` /
  `defaultCollectionView` sync channel (extended) for the mode, and a **`sys:`-namespaced per-note
  order key** for custom order — both reuse patterns that already exist and sync with zero protocol
  change.
- **Keep board view** is a new `CollectionView` (`lib/collectionViews.ts:22-26`) registered against the
  existing seam. It dissolves the middle+right panes into a responsive square-card grid (~2 cols mobile
  → ~4 cols laptop). Opening a note stays full-screen on mobile but becomes a **popover over a blurred
  backdrop** on desktop. It is a lazy chunk; the view choice + switcher generalize to future Kanban.

---

## 2. The "…" menu IA

### 2.1 What it is and where it mounts

The "…" button already exists in the mobile shell bar and opens `ContextMenuSheet`
(`App.tsx:445, 684-691, 612`). Its doc comment already names the planned residents: *"rename notebook,
note organization, notebook display options, per-notebook sharing"* (`ContextMenuSheet.tsx:14-15`) —
this spec fills exactly that.

The menu is **per-notebook context**. It is opened while browsing a notebook's list (or All Notes).
The **note-level "…"** is a *separate context* — that surface is the note editor's own action row
(`NoteMetaBar.tsx` on desktop; the mobile shell-bar `?share`/`?info`/`?history` buttons,
`App.tsx:649-691`). This spec does **not** touch the note context except to remove the notebook-share
block from it (§4). One surface, two contexts — the note context keeps its residents, the notebook
context gains these four.

### 2.2 Residents (in order)

The body of `ContextMenuSheet` (`components/ContextMenuSheet.tsx:48-51`, currently a single hint
`<p>`) is replaced by a vertical list of menu rows. Order top→bottom (most-reached last, toward the
thumb, per the close-at-bottom convention `ContextMenuSheet.tsx:20-21`):

| # | Resident | Control type | Action |
|---|----------|--------------|--------|
| 1 | **Rename notebook** | Row → inline text field (in-sheet), Save/Cancel | Renames the current notebook. Disabled/omitted for the synthetic **All Notes** (null notebook — no real row to rename; same null-guard `ShareLinkSection.tsx:260-261`, `App.tsx:439`). |
| 2 | **Share notebook** | Row → expands a share sub-panel (mint / copy / revoke), OR pushes a nested share screen | Mints/manages the notebook read-only share link (§4). Omitted for All Notes. |
| 3 | **Sort** | Row → 4-option single-select (segmented list; the 4th, Custom, arms drag-drop in the list) | Sets the per-notebook note sort (§5). Available for All Notes too (sorts the aggregate). |
| 4 | **View** | Row → single-select of registered collection views (today: **List** · **Board**) | Switches the notebook's `CollectionView` (§6/§7). Available for All Notes. |

Below the residents sits the existing bottom **Close** button (`ContextMenuSheet.tsx:52-55`,
`.context-menu__close`) — kept verbatim.

Interaction model for the sub-controls: **in-place expansion**, not nested navigation. Rename expands
to a field row; Sort/View expand to their option list inline (accordion), matching the app's
`settings__section` row idiom that `ShareLinkSection` already uses (`ShareLinkSection.tsx:154-170`).
Share is the one candidate for a nested push (it has its own async mint list) — see §4.3. Keeping the
common cases in-place avoids a second overlay stack and keeps the sheet shallow.

### 2.3 Mobile presentation

Unchanged container: the bottom-sheet `.context-menu` (`styles.css:3273-3318`). It already slides up
over a dimmed + blurred backdrop (`styles.css:3278-3281`, `backdrop-filter: blur(8px)`), rounded top,
safe-area padded, close at bottom in the thumb zone. The only change is the **body content** — swap the
hint `<p>` for the resident rows. `.context-menu__body` currently centers a single hint
(`styles.css:3304-3308`); it becomes a top-aligned scrollable list (`align-items: stretch;
justify-content: flex-start`). New row styles reuse the existing `.settings__row` /
`.settings__row-action` vocabulary already loaded for the share section, so no new visual language is
introduced.

### 2.4 Desktop presentation

Desktop has **no** `ContextMenuSheet` today — the "…" button is mobile-only (`App.tsx:684-691`,
`.shell__nav-btn--mobile-only`), and the desktop 3-region shell (`ThreeRegionShell.tsx`) has no top
bar. So the notebook menu needs a **desktop entry point + a desktop container**:

- **Entry point (new):** a per-notebook kebab/"…" affordance in the nav pane. `NavContent.tsx:29-31`
  explicitly notes *"there is NO per-row kebab/⋮ — the notebook-delete affordance is deferred to the
  phase-2 interactive pass"* — this spec is that pass. Add a "…" button that appears on the **current**
  notebook row (hover/selected) in `NavContent`'s notebook `<li>` (`NavContent.tsx:124-138`). It opens
  the same menu, anchored to that row.
- **Container (new, thin):** a desktop **anchored popover** (not a bottom-sheet — a sheet is wrong on a
  wide window). It reuses the **same overlay tokens**: a dimmed+blurred backdrop
  (`.context-menu__backdrop` rules, `styles.css:3274-3281`) + a small floating panel (`--nav` surface,
  22px radius, `0 -8px 32px` shadow — `styles.css:3282-3288`) positioned near the row rather than pinned
  to the bottom edge. The residents inside are **identical components** — only the wrapper geometry
  differs (bottom-sheet vs anchored popover). Follow the master pattern already used elsewhere: one
  content component, two containers (exactly how `NavContent` serves `DrawerNav` + `NavSheet`,
  `NavSheet.tsx:14-16`).

Recommendation: factor the four residents into a `NotebookMenuBody` component; `ContextMenuSheet`
(mobile) and a new `NotebookMenuPopover` (desktop) each render it. This is the one-surface/two-context
+ one-content/two-container discipline the codebase already follows.

---

## 3. Rename

### 3.1 Interaction

Resident #1. Tapping "Rename notebook" swaps the row for an inline text field pre-filled with the
current name + Save/Cancel — the exact shape `NavContent` already uses for **create** notebook
(`NavContent.tsx:141-154`: `.nav-content__new-form` / `.nav-content__new-input` / confirm+cancel).
Reuse that markup/CSS. Enter or Save commits; Escape or Cancel reverts; empty/whitespace is a no-op
(trim guard, mirroring `NavContent.tsx:79`).

### 3.2 Where the mutation goes — already built

**No new mutation, no schema change.** The write path exists and syncs:

- `mutateNotebooks.rename(id, name)` (`db/mutateNotebooks.ts:39-52`) — CAS-updates the local row and
  enqueues a `NotebookDraft` payload `{ name, defaultCollectionView }`.
- It rides the notebook sync queue → server `renameNotebook` CAS-updates `name` +
  `defaultCollectionView` atomically (`worker/src/db/notebooks.ts:66-91`).
- After the call, notify the queue: `notifyQueueWrite(id)` (the create path does this,
  `NavContent.tsx:82`).

So Rename is: render the field, call `mutateNotebooks.rename` + `notifyQueueWrite`, collapse the row.
Nothing server-side or schema-side changes.

---

## 4. Notebook share — the note-vs-notebook split

### 4.1 What "notebook share URL" means today — it is a REAL, working feature

Contrary to the task's hedge, notebook sharing is **fully implemented end-to-end on the server** (this
was verified in the worker):

- Mint accepts `resourceType: 'notebook'` (`worker/src/routes/shares.ts:54-110`,
  `ShareMintRequestSchema`), stores a grant row (`grants` table, `principalKind='anonymous'`,
  `scope=['read']`, theme-stamped — `worker/src/db/authStore.ts:1174-1199`).
- The public render `/s/<token>` has a **dedicated notebook branch**
  (`worker/src/routes/shareSurface.ts:455-482`): it fetches the notebook, lists its **non-trashed**
  notes (hides `sys:trashedAt`), and renders an `<ul>` of note links; each note opens at
  `/s/<token>/n/<noteId>` with a back-link. Liveness heartbeat + token-scoped blob serving both handle
  the notebook case (`shareSurface.ts:314-335, 338-376`).
- Owner theme (palette+voice) is stamped at mint and inlined into the public page
  (`shares.ts:79-82`, `shareSurface.ts:86-87, 130-167`).
- The client **already calls it**: `ShareLinkSection` renders a second `ShareTarget` with
  `resourceType="notebook"` whenever the open note lives in a real notebook
  (`ShareLinkSection.tsx:279-287`), via `createShare('notebook', …)` (`lib/shareApi.ts:127-145`).

So the notebook share URL, its grants model, revocation, and public render **all exist and work**. This
part is **not** a feature build — it is an **IA move**. Nothing in `shareApi.ts` or the worker changes.

### 4.2 The split: what stays in the note vs moves to the notebook menu

Today `ShareLinkSection` conflates two contexts in the note's Share screen: it renders **both** a
"Share this note" target and a "Share this notebook" target (`ShareLinkSection.tsx:269-288`). That's the
wrong home for the notebook one — it's only reachable while a note in that notebook is open, and it's
duplicated across every note in the notebook.

- **Stays in the note** (`ShareExportPanel` → `ShareLinkSection`): the **"Share this note"** target
  (`ShareLinkSection.tsx:271-277`) + the whole `ExportSection` (Markdown/PDF/Print,
  `ShareExportPanel.tsx:37`). The note Share screen keeps its `?share`-param route + lazy chunk
  (`NoteRoute.tsx:29-30, 231-243`) untouched.
- **Moves to the notebook "…" menu** (resident #2): the **"Share this notebook"** target
  (`ShareLinkSection.tsx:279-287`). Delete that block from `ShareLinkSection`; it becomes
  standalone-mounted in the notebook menu, keyed by the **current notebook id** (from
  `useNotebookStore().currentNotebookId`, `lib/notebookStore.ts:9`) rather than by the open note's
  `notebookId`.

### 4.3 How the moved piece is built — reuse `ShareTarget` verbatim

The `ShareTarget` inner component (`ShareLinkSection.tsx:59-254`) is already self-contained: it takes
`{resourceType, resourceId, heading, targetLabel, accountId}` and does mint/list/copy/revoke/re-mint
against `shareApi`. **Extract it** into its own module (`components/ShareTarget.tsx`) and render one
instance in the notebook menu with `resourceType="notebook"`, `resourceId=currentNotebookId`. The note
Share screen keeps its own `ShareTarget` for the note. Zero logic change; one component, two mount
points.

Residency: `shareApi` + `ShareTarget` must stay off the first-load bundle (the note path already
guarantees this via the lazy `ShareExportPanel` chunk, `shareApi.ts:6-9`). The notebook menu is itself
opened on demand, but to be safe the notebook-share sub-panel should **lazy-import** `ShareTarget` on
expansion (dynamic `import()`), so opening the "…" menu doesn't pull `shareApi` into the shell. This
honors `plugins-lazy-past-first-paint`.

Because the notebook-share body has async mint state + a list, resident #2 may present as a **nested
push** (a sub-screen inside the menu with a back arrow, mirroring `ShareExportPanel`'s
`.history__header` back pattern, `ShareExportPanel.tsx:29-34`) rather than an inline accordion — the
one resident where a push reads better than in-place expand.

---

## 5. Sort controls

### 5.1 The 4 modes

Applied over the current notebook's note list (or the All-Notes aggregate):

1. **Last modified** — `updatedAt` DESC. **Current default** and the only ordering today
   (`db/dexieLocalStore.ts:76-87`: `.sort((a,b) => b.updatedAt.localeCompare(a.updatedAt))`).
2. **Alphabetical** — by display title ASC (case-insensitive; use the same title resolution as
   `notePreview`, `lib/notePreview.ts:29-45`, so untitled notes sort consistently).
3. **Date created** — `createdAt` DESC. `createdAt` exists on the row (`NotebookRow`/note rows carry
   it; note create stamps it).
4. **Custom (drag-drop)** — manual per-notebook order; see §5.4.

### 5.2 Where the ordering is applied — one place

Ordering is done **in memory**, not at the Dexie query level: `observeNotes` fetches `.toArray()` then
filters + `.sort()`s (`db/dexieLocalStore.ts:76-87`). This is deliberate (liveQuery reactivity on
`.toArray()`). So the sort change is a **single comparator swap** in that observer — no new index, no
query rewrite. Concretely: `observeNotes` gains a `sort` parameter (or reads the active per-notebook
sort), and picks the comparator. The `[notebookId+updatedAt]` compound index exists
(`db/schema.ts:201-203`) if we ever want to push ordering into the query, but it's **not** needed for
this design and adding it would break the reactive-`.toArray()` contract.

Note: the middle-pane list (`HomeView`, `App.tsx:177-192`) filters the account-wide `useNotes()` in
memory and does not currently re-sort — it consumes the store's already-sorted order. So the
comparator lives at the store/observer layer and both the List view and the Keep view inherit it for
free.

### 5.3 Persistence of the chosen MODE — synced, per-notebook (recommended)

**Recommendation: persist the sort MODE synced, per-notebook, on the notebook row — reusing the exact
channel `defaultCollectionView` rides.** Justification: sort preference is a property *of the notebook*
(Jim wants notebook "A—Z" to look A—Z on his phone and laptop), not of the device; and there is already
a proven, zero-protocol-cost synced notebook-preference field. The `defaultCollectionView` precedent
shows the pattern is cheap: a free-string field on `NotebookSchema` that the server stores + syncs but
does not semantically validate (`shared/src/spine/notebook.ts:14-29`).

**Exact shape:** add one optional field to `NotebookSchema` + `NotebookDraft`:

```ts
// shared/src/spine/notebook.ts
export const NoteSortSchema = z.enum(['modified', 'alpha', 'created', 'custom']);
export const DEFAULT_NOTE_SORT = 'modified';
// on NotebookSchema:
noteSort: NoteSortSchema.default('modified'),
// NotebookDraftSchema.pick adds noteSort: true
```

Wire it through the three touch points that already carry `defaultCollectionView` (all mechanical):
`NotebookDraft` (`notebook.ts:36-39`) → `NotebookPushEntry.draft` (`shared/src/api/sync.ts:59-69`) →
server `renameNotebook` UPDATE (`worker/src/db/notebooks.ts:66-91`, add `noteSort = ?` to the SET) →
`NotebookRow` (`client/src/db/schema.ts:51-60`). `mutateNotebooks` gains a
`setNoteSort(id, sort)` that mirrors `rename` (same CAS + enqueue, `mutateNotebooks.ts:39-52`) but
varies `noteSort` instead of `name`.

Alternative considered (device-local via `deviceState`, mirroring `panePointer`
`db/panePointer.ts` / key `'notebook-sort:<id>'`): rejected as the default. It's cheaper (no shared
schema edit) but wrong semantically — sort would not follow Jim across devices, contradicting the
"looks the same everywhere" intent. Keep `deviceState` for genuinely device-local prefs (pane width,
keyboard mode — `db/accountScope.ts:6-17`).

### 5.4 Custom drag-drop order — `sys:`-namespaced per-note key (synced)

Custom order is *per-notebook manual sequence*. The clean, already-blessed mechanism is a **reserved
`sys:` property on each note**, exactly like `sys:trashedAt` (Fork P):

- **Key:** `sys:notebookOrder` (define in `shared/src/spine/reservedKeys.ts` next to `SYS_TRASHED_AT_KEY`,
  `reservedKeys.ts:24-32`). **Type:** `number` (a fractional order key). Read/write via helpers
  `notebookOrder(bag)` / `setNotebookOrder(bag, n)` mirroring `trashedAt` / `setTrashedAt`
  (`reservedKeys.ts:54-78`). It is reserved → user property edits can never touch it
  (`UserPropertyBagSchema`, `reservedKeys.ts:85-114`), and it **rides the normal note `upsert`** with
  zero protocol change (same as trash, `reservedKeys.ts` doc).
- **Stable ordering key:** use **fractional indexing** — the order value is a float; inserting between
  two notes picks the midpoint of their keys. This gives a *stable per-notebook ordering key* (the
  task's requirement) with **O(1) writes on a drag** (only the moved note's property changes, not the
  whole list) — critical for the perf bar and for shrinking the sync conflict window
  (`sync-asap-conflict-window`). A note with no `sys:notebookOrder` sorts after keyed notes (or is
  lazily assigned on first custom-sort entry).
- **Scope:** the order lives on the note, so it is naturally per-note; "per-notebook" falls out because
  a note belongs to exactly one notebook (`shared/src/spine/notebook.ts:7-8`). Moving a note to another
  notebook can clear/reassign its order (a follow-up detail; simplest: clear on move, it drops to the
  end of the target).
- **Comparator:** when mode = `custom`, `observeNotes` sorts by `notebookOrder(properties)` ASC
  (undefined last). Same single-comparator seam as §5.2.

Why not device-local for custom order: a manual arrangement is content-adjacent and Jim expects it to
sync (his phone and laptop should show the same board arrangement). The `sys:` property is the exact
precedent for "a synced, system-owned bit of per-note state that rides upsert."

**Drag-drop UI:** in List view, entering Custom sort arms row reordering (the swipe-row list already
has per-row gesture handling, `App.tsx:376-411` / `SwipeRow`). In Board view, cards are the drag units.
Reuse the desktop DnD primitive already in the tree (`lib/dnd/useNoteDnd.js`, used for note→notebook
drag, `NavContent.tsx:54-55`, `App.tsx:203`) — extend it for intra-list reordering rather than adding a
new DnD library (reuse discipline; keep it off the mobile first-load path — it's already a lazy
desktop-only chunk).

---

## 6. Keep board view

### 6.1 The `CollectionView` contract it implements

The seam is `lib/collectionViews.ts:18-47`. A collection view is:

```ts
interface CollectionViewProps { notebookId: NotebookId | null; }         // :18-20
interface CollectionViewDescriptor { key; matches(notebookId); component; } // :22-26
```

Register the Keep view with `registerCollectionView({ key: 'board', matches, component })`
(`collectionViews.ts:31-33`). `matches` returns true when the current notebook's persisted view is
`'board'`. But `matches` is **synchronous and must be pure/deterministic** (`collectionViews.ts:13-15`)
— it cannot read async storage. Two clean options; pick **B**:

- (A) `matches` reads a synchronous in-memory mirror of the active view. Fragile (needs a hydrated
  store before first resolve).
- (B, recommended) **Resolve by the notebook row's `defaultCollectionView`** at the call site, not
  inside `matches`. `App.tsx:571` already computes
  `resolveCollectionView(notebookId, HomeView)`. Change the caller to read the current notebook's
  `defaultCollectionView` (already on the synced `NotebookRow`, `db/schema.ts:53`; already loaded via
  `useCurrentNotebook`, `App.tsx:438`) and select the component directly — the Keep view's `matches`
  simply checks `view === 'board'`. This keeps resolution synchronous and data-driven off the synced
  row (which §7 already makes the persistence home).

The Board `component` receives `{ notebookId }` and does its own `useNotes()` + filter (exactly as
`HomeView`, `App.tsx:177-192`) + the active-sort comparator (§5.2).

### 6.2 Responsive grid spec

CSS Grid with `repeat(auto-fill, …)` is the wrong fit for a *fixed column count by breakpoint*; use an
explicit column count per breakpoint so it reads as "2 up / 4 up" not "as many as fit":

```
.board { display: grid; gap: 12px; grid-template-columns: repeat(2, 1fr); padding: 12px; }
@media (min-width: 480px)  { .board { grid-template-columns: repeat(3, 1fr); } }
@media (min-width: 769px)  { .board { grid-template-columns: repeat(4, 1fr); } }  /* desktop breakpoint = useIsDesktop 769, useIsDesktop.ts:6 */
@media (min-width: 1200px) { .board { grid-template-columns: repeat(5, 1fr); } }
```

- **~2 columns on mobile, ~4 on a laptop, scaling smoothly** (the task's target) — 2 → 3 → 4 → 5 as
  width grows. The 769px step aligns with the app's single device breakpoint (`useIsDesktop.ts:5-6`,
  `@media (max-width: 768px)`), so CSS and JS agree.
- **Card shape:** "square-ish" sticky notes. Cards size to the grid cell width; height is
  content-driven but **capped** (e.g. `max-height` ~ the cell width × 1.4, with `overflow: hidden` and a
  soft fade) so the board reads as a tidy grid of tiles, not a ragged masonry. (True masonry is a
  later refinement — avoid it now; it needs JS measurement and threatens the perf bar.)
- **What a card shows:** reuse `notePreview` (`lib/notePreview.ts:29-45`) — `displayTitle` (bold, 1–2
  lines) + `previewLine` (clamped) + `formatSmartDate(updatedAt)` (`notePreview.ts:52`), matching the
  list row's content (`App.tsx:366-405`). File notes render the existing `FileNotePill`
  (`App.tsx:394-397`). A conflict badge slot reuses `ConflictBadgeSlot` (`App.tsx:409`). Cards are
  `--paper` surface, `--border` hairline, small radius — pure token reuse, no new palette.

### 6.3 How it dissolves the panes

- **Desktop:** in `ThreeRegionShell`, the middle **list** pane + right **note** pane normally coexist
  (`ThreeRegionShell.tsx:58-64`, `.shell-3region__list` fixed/resizable width +
  `.shell-3region__note` fills, `ThreeRegionShell.css:25-42`). When the active view is Board, the shell
  renders the Board `CollectionView` **spanning both regions** as one full-width grid — i.e. the
  Board component fills the combined list+note area, and the `ResizeHandle`
  (`ThreeRegionShell.tsx:62`) is hidden. Cleanest implementation: `ThreeRegionShell` checks the active
  view; for `'board'` it renders a single `.shell-3region__board` region (grid) instead of the
  list|handle|note triple, keeping the nav pane. This is a layout branch in one file, not a new shell.
- **Mobile:** the mobile shell is already single-column (`App.tsx:695-733`, the note *pushes over* the
  list via routing). The Board just replaces the single `<CollectionView>` at `App.tsx:726` — the grid
  fills the one column. No pane-dissolve needed; it's inherently one region.

### 6.4 Opening a note: desktop popover-over-blur vs mobile full-screen

The task's key nuance: on desktop the list pane is *gone* in Board view, so a full-width note would look
bad; on mobile nothing special is needed.

- **Mobile:** **unchanged.** Tapping a card navigates `/note/:id` and the note takes the full column
  exactly as today (`App.tsx:386-388, 698-707`). Full-screen, as specified.
- **Desktop:** tapping a card opens the note as a **centered modal popover over a blurred backdrop**,
  *not* the right pane (which no longer exists in Board). Implementation: a Board-scoped overlay that
  renders `NoteRoute` inside a floating panel. **Reuse the exact overlay language** already defined —
  the dimmed + blurred backdrop (`.context-menu__backdrop` / `.nav-sheet__backdrop` rules,
  `styles.css:3274-3281, 2418-2424`, both `backdrop-filter: blur(8px)` over `rgba(0,0,0,0.42)`) with a
  large centered `--paper` panel (radius + `0 -8px 32px` shadow from the same token set,
  `styles.css:3282-3288`). Dismiss = backdrop click + Escape (the same handlers every overlay uses,
  `ContextMenuSheet.tsx:27-32`, `NavSheet.tsx:234-239`).
  - The note *content* is unchanged: the popover mounts the same lazy `NoteRoute` chunk (`App.tsx:17`),
    so the editor, its plugins, sync, history/info/share params all work identically — it's just framed
    by a modal instead of the pane. Route model: keep `/note/:id` and let the Board's parent detect the
    match and render the popover (mirrors how `HomeView` reads `useMatch('/note/:id')` for the
    master-detail selection, `App.tsx:195-196`), so deep links + back-button still work; closing the
    popover navigates back to the board URL.

### 6.5 Lazy-loading posture

The Board view is a **new lazy off-track chunk**. It must **never** be static-imported into `App.tsx`
or `ThreeRegionShell.tsx` (both are entry-reachable). Register it via a tiny side-effect module that
`lazy()`-wraps the grid component, mirroring `registerFileNoteView` (`App.tsx:63-65`) and the editor's
own lazy split (`App.tsx:14-17`, `ThreeRegionShell.tsx:16-19`). The card DnD/reorder logic
(`useNoteDnd` extension, §5.4) is likewise a desktop-only lazy chunk (it already is,
`App.tsx:201-203`). This satisfies `backend-resident-plumbing-default` / `plugins-lazy-past-first-paint`
/ `performance-is-a-standing-value`: the entry bundle and mobile first paint are untouched until Jim
actually switches a notebook to Board.

---

## 7. View persistence & the switcher

- **Where the chosen view is stored:** on the **synced notebook row**, in the **existing**
  `defaultCollectionView` field (`shared/src/spine/notebook.ts:14-29`, `db/schema.ts:53`). It is already
  a free-form string the server stores+syncs but does not validate, *explicitly so new views need no
  server change* (`notebook.ts:16-18`). Values: `'list'` (today) and `'board'` (new). **Zero schema or
  server work** — this is the single biggest reuse win in the spec.
- **How the switcher lives in the menu:** resident #4 ("View") is a single-select whose options are the
  registered collection views. On select, call a new `mutateNotebooks.setView(id, view)` — a clone of
  `rename` (`mutateNotebooks.ts:39-52`) that varies `defaultCollectionView` instead of `name` (the CAS +
  enqueue + server SET already carry this field, `worker/src/db/notebooks.ts:75-79`). It syncs
  immediately; the Board view is device-consistent.
- **How it generalizes to future Kanban/others:** adding a view is *registration only*
  (`collectionViews.ts:8-11` promises this). A future Kanban is: register a descriptor with
  `key: 'kanban'`, add `'kanban'` to the View switcher's option list, ship the lazy chunk. No change to
  persistence (same string field), the menu (same single-select), or the shell (same resolve seam). The
  Sort persistence (§5.3) generalizes the same way — it's an orthogonal per-notebook field. The switcher
  should render its options from the **registry** (`_registry` in `collectionViews.ts:28`, exposed via a
  small `listCollectionViews()` accessor) rather than a hardcoded list, so registering a view
  auto-populates the menu.

---

## 8. Reuse map

| Piece | Reuses (existing) | Genuinely new |
|-------|-------------------|---------------|
| "…" menu (mobile) | `ContextMenuSheet` shell + `.context-menu*` CSS (`ContextMenuSheet.tsx`, `styles.css:3273-3318`); `.settings__row*` row idiom | The four resident rows in the body |
| "…" menu (desktop) | Overlay tokens (`--nav` panel, blurred backdrop, `styles.css:3274-3288`); one-content/two-container pattern (`NavSheet.tsx:14-16`) | Per-notebook kebab in `NavContent` row (`NavContent.tsx:124-138`); `NotebookMenuPopover` wrapper |
| Rename | `mutateNotebooks.rename` + sync (`mutateNotebooks.ts:39-52`); create-form markup/CSS (`NavContent.tsx:141-154`) | Nothing (UI only) |
| Notebook share | **Entire feature**: `shareApi` (`lib/shareApi.ts`), `ShareTarget` (`ShareLinkSection.tsx:59-254`), worker mint + `/s/<token>` notebook render (`worker/.../shareSurface.ts:455-482`) | Extract `ShareTarget` to its own module; mount in the menu keyed by `currentNotebookId`. Remove notebook block from `ShareLinkSection` (`:279-287`) |
| Sort mode persistence | `defaultCollectionView` sync channel (`notebook.ts`, `notebooks.ts:66-91`); `mutateNotebooks.rename` clone | `noteSort` field on `NotebookSchema`/`Draft`; `setNoteSort` mutation; comparator in `observeNotes` |
| Custom order | `sys:` reserved-key pattern (`reservedKeys.ts:24-78`); rides note `upsert`; `useNoteDnd` (`lib/dnd/useNoteDnd.js`) | `sys:notebookOrder` key + helpers; fractional-index logic; intra-list DnD extension |
| Sort application | `observeNotes` in-memory sort seam (`dexieLocalStore.ts:76-87`) | Comparator switch by active sort |
| Keep grid | `CollectionView` seam (`collectionViews.ts`); `notePreview`/`formatSmartDate` (`notePreview.ts`); `FileNotePill`, `ConflictBadgeSlot`; theme tokens (`--paper`/`--border`) | `Board` component + `.board` grid CSS; register-side-effect lazy module |
| Pane dissolve | `ThreeRegionShell` layout (`ThreeRegionShell.tsx/.css`) | One `'board'` layout branch spanning list+note |
| Desktop note popover | Overlay blur/backdrop/panel tokens (`styles.css:3274-3288`); dismiss handlers (`ContextMenuSheet.tsx:27-32`); lazy `NoteRoute` (`App.tsx:17`) | `.board-note-popover` wrapper + `useMatch` detection |
| View persistence + switcher | `defaultCollectionView` synced field; `mutateNotebooks` clone; `_registry` (`collectionViews.ts:28`) | `setView` mutation; `listCollectionViews()` accessor; View resident |

---

## 9. Build plan (chunked, parallelizable)

Lanes A–D are largely independent and can run in parallel; E and F depend on earlier lanes.

**Lane A — Menu IA shell (no features).** Refactor `ContextMenuSheet` body into a `NotebookMenuBody`
component rendering four placeholder rows + keep the Close button. Add the desktop `NotebookMenuPopover`
wrapper + a per-notebook "…" kebab entry in `NavContent`'s current-notebook row. Wire both to open the
same body.
*Accept:* mobile "…" and the new desktop kebab both open a menu listing Rename/Share/Sort/View rows
(inert), dismiss on backdrop+Escape; unchanged on All Notes except Rename/Share are hidden. Render test
mounts the routed tree and asserts the four rows + null-notebook hiding (`ui-features-need-rendered-ui-gate`).

**Lane B — Rename.** Wire resident #1 to the inline field (reuse create-form markup) →
`mutateNotebooks.rename` + `notifyQueueWrite`.
*Accept:* renaming updates the nav row + list header live and survives a reload/sync (2-device or
sync-round check). Unit + render test.

**Lane C — Notebook share relocation.** Extract `ShareTarget` to `components/ShareTarget.tsx`
(lazy-imported); remove the notebook block from `ShareLinkSection` (`:279-287`); mount `ShareTarget`
(`resourceType='notebook'`, `resourceId=currentNotebookId`) in resident #2.
*Accept:* the note Share screen no longer shows "Share this notebook"; the notebook menu mints/copies/
revokes a working `/s/<token>` notebook link (open it anonymously → see the note list). No worker change.
Existing `ShareLinkSection`/`shareApi` tests stay green; add a render test for the menu-mounted target.

**Lane D — Sort: mode + application.** Add `noteSort` to `NotebookSchema`/`Draft`/`PushEntry`/server
SET/`NotebookRow` + `DEFAULT_NOTE_SORT`; add `mutateNotebooks.setNoteSort`; add the comparator switch in
`observeNotes` (modified/alpha/created). Wire resident #3 (excluding Custom).
*Accept:* switching sort re-orders the list live for the 3 non-custom modes; the mode persists across
reload + syncs. `schema-first` applied to the new field (schema is source of truth). Comparator unit
tests (tdd-cycle — pure comparators are test-shaped).

**Lane E — Custom order (depends on D).** Add `sys:notebookOrder` key + helpers in `reservedKeys.ts`
with fractional-index insert; comparator for `custom`; intra-list drag reorder (extend `useNoteDnd`,
desktop lazy) + mobile row reorder.
*Accept:* dragging a note in Custom sort persists its new position (one property write), survives
reload + sync, and a second note dragged between two others lands correctly (fractional key). Unit tests
for the fractional-index + comparator; render/DnD smoke.

**Lane F — Keep board view (depends on A for the View switcher; independent of B–E).**
- F1: `Board` grid component (`useNotes` + filter + active comparator) + `.board` responsive CSS +
  card content (reuse `notePreview`/`FileNotePill`). Lazy register-side-effect module. Wire the View
  resident (#4) → `mutateNotebooks.setView`; drive `resolveCollectionView` off the notebook's
  `defaultCollectionView`.
- F2: Desktop pane-dissolve branch in `ThreeRegionShell` (Board spans list+note, hide handle).
- F3: Desktop note popover-over-blur (reuse overlay tokens + `useMatch` + lazy `NoteRoute`); confirm
  mobile note open stays full-screen.
*Accept per sub-chunk:* F1 — a notebook set to Board renders a 2/3/4/5-col grid of cards that reflows on
resize; the choice persists + syncs; entry bundle size unchanged (Board not in the entry chunk — verify
build output). F2 — on desktop Board the list+note dissolve into one grid, nav pane stays. F3 — desktop
card tap opens the note in a blurred modal (backdrop+Escape dismiss, back-button works); mobile card tap
is full-screen. Rendered-DOM tests per `ui-features-need-rendered-ui-gate` + a thin on-device smoke
before deploy.

**Perf gate (all lanes):** no new static import into `App.tsx`/`ThreeRegionShell.tsx`; Board + share +
DnD stay lazy; `green-gate-needs-prod-typecheck` (strict tsc) before deploy.

---

## 10. Open questions for Jim (with recommendations)

1. **Sort persistence: synced or device-local?** *Recommend synced-per-notebook* (§5.3) so "A—Z" looks
   A—Z on both his phone and laptop — it reuses the `defaultCollectionView` channel at ~zero cost. Only
   flip to device-local if he specifically wants sort to be a per-device whim. (Proceeding synced unless
   told otherwise.)
2. **Custom order when a note moves notebooks:** *Recommend "clear on move → drops to end of the target
   notebook."* Simplest, no cross-notebook key coordination, matches the fractional-index model. (The
   alternative — preserving a global order — adds complexity for little gain.)
3. **Desktop notebook-menu entry point:** a per-notebook **kebab on the current nav row** (§2.4). Jim
   previously deferred a per-row kebab (`NavContent.tsx:29-31`); confirm he's happy with it now returning
   on the *current/hovered* row only (not every row). *Recommend current-row-only* to keep the nav clean.
4. **Board card height:** *Recommend fixed-tidy tiles* (capped height + fade), **not** true masonry —
   masonry needs JS measurement and risks the load-feel bar. Confirm he's fine with uniform-ish tiles
   over Keep's exact ragged masonry.
