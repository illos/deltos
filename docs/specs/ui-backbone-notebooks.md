# Spec — UI Backbone + Notebooks (view-driven shell, v1)

> **Historical — v1 shipped 2026-06-24. This is the spec as of 2026-06-18; preserved as record, not
> current status.** Key reversals since this was written: (1) there is NO stored default notebook —
> "All Notes" is a synthetic aggregate (no row, no flag); see `docs/specs/all-notes-synthetic-default.md`.
> (2) delete-notebook → **uncategorizes** its notes (not Trash). (3) notes have an OPTIONAL `notebookId`
> (nullable); a note with no `notebookId` is uncategorized and lives in All Notes. (4) "note belongs
> to exactly one notebook" is no longer true — uncategorized notes belong to All Notes implicitly.

**Status:** SHIPPED — v1 live 2026-06-24. See archive-note above for reversals.
**Design basis:** `[[ui-view-driven-architecture]]`, `[[notebooks-and-search-plan]]`. Sketched + locked with the user 2026-06-18.
**Sequencing:** the first build of the new view-driven UI. Comes after the reactivity fix (#15) lands; **Search** is the next spec on top of this; the pure-visual **UI refresh** (restyle) is a later, separate item. Heavy client lane — coordinate with #15 (also client) to avoid contention.

## Goal
Turn deltos from a single implicit-notebook app into a **view-driven shell** with real **notebooks as low-overlap contexts**, WITHOUT building the full multi-view system. Ship the *engine* (the view-resolution seam as the UI backbone) "wearing one outfit": one collection view + one item view. Future views (Keep-cards, voice, file, kanban) must be later *registrations*, not refactors.

## The three sections (user's model)
1. **Backbone / shell** — the stable frame: current-notebook landing, notebook switcher, search entry, settings/account, Trash. NOT view-swappable.
2. **Notebook view** — a *collection* view (v1: the standard note list).
3. **Note editor** — an *item* view (v1: the existing doc editor).
Search results, Trash, and a future all-notes view are also collection-views (same seam, different source) — out of scope here except Search's entry point.

## Scope

### A. View-resolution seam as the UI backbone (foundation — non-negotiable)
- Route the **existing note list** through a **collection-view** resolver and the **existing doc editor** through the **item-view** resolver (`registerNoteView`/`resolveNoteView` already exist for items; add the collection-view analog if absent).
- Register exactly **one collection view** (standard list) + **one item view** (doc editor) in v1.
- A notebook stores a **default collection view**; a note **resolves its item view** from content/type/properties. Both ride existing fields (notebookId first-class + open property bag) — **no schema upheaval**.
- **No per-note view override UI in v1** (the seam supports it; we just don't build the UI).
- v1 **reuses the existing list/editor visuals** — the restyle is the later UI-refresh item.

### B. Notebooks as a real feature
- **CRUD:** create, rename, delete notebooks. There is **always a default notebook** that **cannot be deleted** (safety net + new-user landing).
- **Notebook entities SYNC** (account-scoped, like notes) — the same notebook list appears on every device.
- A note **belongs to exactly one notebook** (the current one at creation). **Move note between notebooks** = a per-note action (editor menu and/or swipe). Server stamps notebookId; respects the existing CAS/sync path.
- Deleting a notebook: define behavior — proposal = its notes go to **Trash** (not hard-deleted), notebook removed. (Confirm with planner if ambiguous at build.)

### C. Current-notebook persistence (device-local)
- "Current/last-open notebook" is a **device-local pointer**, **persisted in IndexedDB** (NOT localStorage — iOS evicts localStorage; this must survive weeks-long gaps. See `[[e4-cold-reload-fix]]`/`[[cold-reload-rehydration-guard]]`).
- **Per-device, NEVER synced** — work phone opens to Work, laptop to D&D, independently.
- Cold launch lands on the saved notebook.
- **Fallback** (pointer missing = new device, or dangling = notebook deleted elsewhere & synced away) → land on the **all-notebooks/settings screen**, not a guessed notebook.

### D. Surfaces
- **Home** = current notebook's note list. Top bar: `notebook name ▾` (tap = switcher) + `🔍` (global search entry). New-note **FAB** (bottom-right, thumb reach) → creates in the current notebook.
- **Switcher / all-notebooks-settings screen** — content: notebook list (current indicator + per-notebook note count), `＋ New notebook`, `Trash`, `Settings & account`. **Two presentations of the same surface:** (a) slide-up **sheet** when tapped from inside a notebook; (b) **full-screen landing** on cold-start-with-no-valid-current-notebook.
- **Note editor** = the existing doc editor (item view via the seam); native swipe-back returns to the list.
- **Switch gesture:** tap-the-name sheet (NOT a swipe-from-left drawer) for v1.
- **No bottom tab bar.**

## Constraints
- Holds `[[performance-is-a-standing-value]]` — no load-feel regression; the cold-launch → current-notebook path must be fast.
- In-place reactive, **never a page reload** (consistent with the #15 fix discipline).
- Seam-correctness is the point: adding view #2 later must be a registration, provable without touching the list/editor internals.
- Notebook-list reads/writes go through the substrate/store (no Dexie reach-around) and stay account-scoped (sync isolation intact).

## Acceptance criteria
1. Create / rename / delete notebooks; default notebook exists and cannot be deleted.
2. Notebooks sync: create a notebook on device A → it appears on device B (account-scoped).
3. New note lands in the current notebook; moving a note to another notebook works and syncs.
4. Current notebook persists in IndexedDB, per-device: set different current notebooks on two devices → each cold-launches to its own. **Verify after a simulated long gap / storage pressure that it is NOT lost (the IDB-not-localStorage check).**
5. New device / deleted-current → lands on the all-notebooks/settings screen.
6. The note list renders via the collection-view seam and the editor via the item-view seam; a *throwaway* second view can be registered in a test to prove additivity (not shipped).
7. No load-feel regression vs current; no full-page reloads.

## Out of scope (explicit)
- Per-note item-view override UI; any second collection/item view (Keep-cards, voice, file, kanban).
- Search internals (next spec — only the entry point/affordance here).
- The pure-visual UI restyle (later UI-refresh item).
- Cross-notebook "all notes" aggregate view (post-v1; portable-fallback keeps it buildable later).

## ADDENDUM — Responsive layout (locked with user 2026-06-18; SUPERSEDES the tap-sheet switcher)
The shell has **three composable regions**: **Nav** (notebook switcher + New notebook + Trash + Settings/account), **Note list** (notes in the current notebook), **Active note** (editor). The earlier "tap-the-name sheet" switcher is **RETIRED** — nav is now a left pane/drawer.

Presentations by device class (same regions, different composition):
- **Desktop + tablet-landscape:** Nav as a **LEFT PANE** | Note list | Active note, with a **drag-to-resize handle** between list and note. (Nav-pane collapsibility = TBD at build.)
- **Mobile + tablet-portrait:** Note list = **main screen** (edge-to-edge); Active note = a pushed **SUB-SCREEN** (back returns to list — same as current behavior); Nav = **LEFT PULL-OUT drawer**.
- The cold-start "no valid current notebook" fallback = the **Nav content rendered full-screen** (the AllNotebooksScreen). One nav surface, three forms (pane / drawer / full-screen).

**NOW vs LATER (sequencing):**
- **NOW (#18):** build the switcher as the **LEFT DRAWER** (mobile/tablet-portrait form) holding notebook switcher + New notebook + Trash + Settings/account; keep list-as-screen + note-as-sub-screen. Do NOT build the tap-sheet.
- **LATER (UI-refresh layout pass):** the wide-screen **multi-pane** layout (nav pane | list | note + resize handle).
- **Discipline:** build the three regions as independent **composable components** so the wide-screen panes are an *additive* shell change, NOT a rewrite (plugin-first / no-rewrites doctrine).
- Colors + fonts (the other look-and-feel axis) = still to be designed; part of the refresh.
