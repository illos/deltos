# Spec — "All Notes" synthetic default (notebook-model refinement)

**Status:** SPEC-READY (planner, 2026-06-20). Handoff target = pilot-2.
**Design basis:** decided with Jim 2026-06-20 → [[all-notes-synthetic-default]]. Governs:
[[performance-is-a-standing-value]], [[ui-view-driven-architecture]] (supersedes its "all-notes ≠ v1 /
notebooks as low-overlap silos" lean), [[reuse-discipline]].
**Sequencing:** the NEXT notebook-model refinement, AFTER the account-isolation fix (now LIVE + verified).
The prod DB was just wiped to a clean slate — an ideal time for the schema change (no real data to migrate).

## Goal
Collapse two ideas — the **undeletable default "Notes" notebook** and a **future all-notes aggregate view**
— into ONE concept: **"All Notes."** It's a **synthetic aggregate** (not a stored notebook row) that shows
every note in the account; notebooks become filters/subsets of it. **Bonus: this structurally eliminates the
duplicate-default-notebook bug class** (the root of the 2026-06-20 incident) — with no stored default row,
there's nothing to duplicate.

## Data model
- **`notebookId` becomes OPTIONAL/nullable on notes.** A note with no `notebookId` is **uncategorized** and
  lives in All Notes. A note with a `notebookId` shows in that notebook AND in All Notes (which aggregates).
- **Retire the stored default-notebook entirely:** no default-notebook ROW, no `createDefaultNotebook` on
  signup, and retire the 0008/0009 default-consolidation + unique-default-index machinery (that whole
  apparatus existed to keep ONE default container — no longer needed).
- **"All Notes" is COMPUTED, never stored:** the All-Notes query = "all notes for this account, regardless of
  `notebookId`." Real notebooks remain stored, synced entities (accountSyncSeq, CRUD, move — unchanged);
  All Notes is simply not one of them.
- Server `notes.notebookId` → nullable; sync must handle null `notebookId` cleanly (it was already demoted to
  an organizing tag, accountId is the sync boundary — this fits).

## UI (treat it like a real notebook — Jim's constraint)
- **Switcher:** the client composes the list as **[All Notes] + [the account's real notebooks]**. All Notes
  renders as a first-class entry, visually like any notebook, **but undeletable** (no delete affordance — it's
  the aggregate; undeletable by being synthetic, not by a flag).
- **Default landing / current-notebook:** All Notes is the **default value** of the existing per-device
  current-notebook pointer. **The current-notebook selection persists per-device** (unchanged mechanism;
  All Notes is just its default).
- **Selecting a real notebook** filters the list to that notebook's notes; selecting All Notes shows everything.
- **New-note notebook assignment:** a note created while viewing **All Notes** is **uncategorized**
  (`notebookId = null`); created while viewing a **specific notebook**, it gets that `notebookId`.
- **Move-note:** the move target list includes **All Notes** = "remove from notebook / uncategorize"
  (`notebookId = null`), alongside the real notebooks.
- Search / Trash / other collection-views: unaffected (they already span the account).

## Migration
- New migration number (never rewrite an applied one — [[migration-never-rewrite-applied]],
  [[migration-d1-no-temp-table]]): make `notes.notebookId` nullable; retire default-notebook
  creation/consolidation/unique-index. Validate against REAL D1 (`db:migrate:local` + a real-D1 apply), not
  just better-sqlite3 ([[migration-d1-no-temp-table]]).
- Because the DB is freshly wiped (no notes/notebooks), there's nothing to back-fill — but the schema change
  must still be correct as a pattern (this is an ARCHITECTURAL refactor, comprehensive not patch, per Jim's
  standing directive). If any default-notebook rows somehow exist, the migration nulls their notes'
  `notebookId` and drops the rows.
- Client local store (Dexie): mirror the nullable `notebookId`; on the fixed build, the existing
  account-isolation logout/switch purge + a store-version bump cover any stale local default rows.

## Constraints
- **`[[performance-is-a-standing-value]]`:** All Notes is the DEFAULT view, so its aggregate query must be as
  fast as today's single-notebook query — instant, no jank as note count grows. Report any perf delta.
- **Structurally bug-proof:** there is no code path that can produce a second default — assert it.
- **`[[reuse-discipline]]`:** reuse the existing switcher/collection-view rendering; All Notes is a composed
  entry + an unfiltered query, not a new one-off list.
- Account-scoped by construction (all queries carry accountId — the just-shipped isolation invariant holds).

## Acceptance
- Switcher shows **All Notes** as a first-class, **undeletable** entry; it's the default landing.
- All Notes shows **every** note (uncategorized + all notebooks'); selecting a notebook filters to it.
- `notebookId` is optional; uncategorized notes (no notebook) render correctly in All Notes.
- New note in All Notes → uncategorized; new note in a notebook → that notebook. Move-note to/from All Notes
  works (uncategorize via All Notes target).
- Current-notebook selection **persists per-device** (All Notes default).
- **No code path can create a duplicate default** — there is no stored default row at all (assert in tests).
- Migration applies clean on REAL D1; `notebookId` nullable; default machinery retired.
- **Gate** (per [[ui-features-need-rendered-ui-gate]]): routed-tree render tests (All Notes in switcher,
  undeletable, shows-all, filter-to-notebook, new-note categorization, move-note, per-device persistence) +
  the no-duplicate-default assertion + a thin on-device smoke + green + prod typecheck
  ([[green-gate-needs-prod-typecheck]]) + perf-budget report.

## Suggested lanes (orchestrator's call)
- **Server/schema:** `notebookId` nullable migration + retire default-notebook creation/consolidation/index +
  sync handles null notebookId.
- **Client:** switcher composes [All Notes]+[notebooks]; unfiltered All-Notes query; new-note + move-note
  notebookId logic; per-device current-notebook (All Notes default); local Dexie nullable mirror.
- **secSys:** light pass — account-scope holds on the new All-Notes/null-notebookId query paths.

## Open question (flag to planSys if it bites)
- Naming: confirm the label is exactly **"All Notes"** (vs keeping "Notes"). Jim's framing said "All Notes."
- Whether real notebooks themselves can be empty/deleted freely now that there's no special default — yes
  (no default among them); confirm delete-notebook just uncategorizes its notes (→ they fall back to All
  Notes) rather than cascading to Trash. (Was a trash-cascade in #28; revisit under the new model.)
