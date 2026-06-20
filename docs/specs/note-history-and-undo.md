# Spec — Note History + Undo/Redo v1

**Status:** SPEC-READY (planner, 2026-06-20). Handoff target = pilot.
**Design basis:** the "basic notes, day-to-day usable" milestone (user, 2026-06-17 — note HISTORY named
explicitly; pulls the deferred Phase-3 version-history FORWARD onto the conflict-as-version data model
already shipped). Undo/redo added in the 2026-06-20 design dialog. User confirmed the granularity model
("sounds great", bulletin #2). Governs: `[[performance-is-a-standing-value]]`, `[[reuse-discipline]]`.
**Design record:** PLAN.md decision log 2026-06-20 (forming model).

## Framing — two layers of one idea, different grains
- **Undo/redo** = fine-grained, in-the-moment, **ephemeral** (in-editor, resets when you leave the note).
- **History/versions** = coarse, across-time, **persistent** checkpoints (saved snapshots).
- **Handoff seam:** leaving a note. The moment the undo stack is discarded, a version checkpoint is saved,
  so nothing meaningful is lost at the boundary.

These are independent mechanisms — undo/redo does NOT create versions; versions come from session settling.
They can be built and shipped together or in either order; both hang off the existing editor + the existing
client `noteVersions` store.

---

## Part A — Undo/Redo

### Goal
Reliable undo/redo while editing a note, with **mobile buttons** (the primary surface) and desktop keyboard
shortcuts, behaving the way a good editor does — one undo takes back "the last thing you were doing," not a
single character.

### Behavior
- **Granularity = the editor's natural transaction grouping**, NOT a fixed word/line. Continuous typing
  collapses into ONE undo step; a new step starts on a short pause (~0.5s, the editor's group-delay) or an
  operation change (delete / paste / formatting). This is ProseMirror's `prosemirror-history` default — wire
  it, don't hand-roll. The group-delay is **tunable on-device**.
- **Scope = the current editing session.** Undo history lives while the note is open and **resets when you
  leave** the note (open a different note / navigate away). Standard; not persisted.
- **Surface:** Undo + Redo **buttons in the editor**, reachable on mobile (primary). Co-locate with the
  future **editor-tools** formatting toolbar if that lands together; otherwise a minimal editor-header
  placement is fine for v1. Buttons reflect availability — **disabled when there's nothing to undo/redo**
  (`undoDepth`/`redoDepth` === 0).
- **Desktop:** standard Cmd/Ctrl+Z (undo) / Shift+Cmd/Ctrl+Z (redo) keymap.
- Undo/redo must play correctly with the **unique-block-ID plugin** and the **unified-title-as-first-heading**
  model (don't resurrect stale block IDs or split the title node) — exercise both in tests.

### Out of scope (A)
- Persisting undo across sessions (that's what history is for).
- Per-collaborator undo (no collab in v1).

---

## Part B — Note History (version timeline + diff + restore)

### Goal
A per-note **history timeline** of past checkpoints the user can scan by time and change-size, **diff**
against the current note (or the previous version), and **restore** — non-destructively.

### Data model (build on what exists)
- Reuse the existing client `noteVersions` IndexedDB store (`packages/client/src/db/schema.ts` —
  `NoteVersion`: `id, noteId, accountId, kind, title, properties, body, baseVersion, createdAt`). It already
  holds whole-note snapshots and is **account-scoped** (`[noteId+accountId]` index) — keep that.
- **Add a `kind` value for history** (e.g. `'session'`) alongside the existing `'conflict'`. The history
  timeline shows **all** kinds for a note (a retained `keep-both` conflict version is a legitimate point in
  history) — unify them in one chronological list, with conflict-origin versions visually distinguishable.
- **Precompute the change-delta at capture** and store it on the version row: `charsAdded` + `charsRemoved`
  (split, not net — per user). Computed from a text diff of the new snapshot vs the **previous version's**
  content at capture time, so the timeline list never recomputes diffs while scrolling (perf standing value).
- **Storage = client-only** for v1 (versions are not synced — unchanged from today). **Honest limitation,
  surfaced in the UI:** history is per-device; it does NOT survive clearing browser data or moving to a new
  device (the live note still syncs fine — only its past is local). Syncing history = a later backend slice.

### When a version is captured (the granularity — confirmed)
A version = a **coalesced edit session**, NOT a paragraph or a change-count. Capture a new `'session'`
version when, since the last captured version, the note has materially changed AND one of:
- **(a) idle-settle:** the user stops editing for a few minutes (tunable, e.g. ~3–5 min) after edits, OR
- **(b) on-leave:** the user leaves/closes the note (this is also the undo→history handoff point), OR
- **(c) big-change checkpoint:** a single large change (large paste / large deletion above a threshold)
  forces an immediate checkpoint so a major edit is always recoverable even mid-session.
- **Material-change threshold:** skip trivial deltas (e.g. < a few chars) so micro-edits don't spawn
  versions. All thresholds (idle minutes, big-change size, material-change floor) **tunable on-device**.
- This is a **separate, coarser layer** from the 400ms autosave debounce and the 2s/5s sync push — it must
  not change save or sync cadence. Track a per-note "last-version baseline" to compute material change.

### Retention (anti-bloat — standing value)
- **Cap** retained `'session'` versions per note (e.g. last ~50, or last 30 days — tunable); prune oldest
  beyond the cap. Do not prune unresolved conflict versions (they're cleared by conflict resolution).
- Keep the store lean; pruning runs at capture time, not on a timer.

### UI
- **Entry:** a "History" / "Version history" affordance on the open note (e.g. in the editor's overflow /
  the note's menu). Reachable from the note, mobile-first.
- **Timeline list:** reverse-chronological rows. Each row = **relative timestamp** ("Today 2:14 PM",
  "Yesterday", "Jun 18") + **char-delta `+120 −18`** (the change that version's session introduced). Absolute
  timestamp on tap/long-press. Conflict-origin versions marked. The live current note sits implicitly at the
  top ("Current").
- **Diff view:** tapping a version opens a **unified inline diff** (added = highlighted, removed =
  struck-through), mobile-first (not side-by-side). **Toggle: vs Current / vs Previous version** — "vs
  current" answers "how far is this from now," "vs previous" answers "what changed in this edit."
- **Restore:** a Restore action on a version makes it the current note. **Non-destructive** — restoring
  itself produces a new version capturing what *was* current, so nothing is lost; restore is just another
  edit. Restored content syncs normally (CAS-safe push at the current server version, like conflict
  keep-mine).
- **Empty state:** a note with no captured versions yet shows a plain "No earlier versions" (a brand-new or
  never-re-edited note).

### Constraints
- `[[performance-is-a-standing-value]]`: timeline rows are cheap (precomputed deltas, lazy render); diffs
  computed **on demand** only when a version is opened; capture/prune must not jank typing or the list.
- `[[reuse-discipline]]`: reuse the existing `noteVersions` store, the conflict-version retention path, and
  the diff approach (pick a vetted small text-diff, rewrite to deltos quality — no patch-and-paste; no heavy
  dep that regresses the bundle — report bundle delta on hand-back).
- Account-scoped by construction (all reads carry `accountId`); no cross-account leakage.
- Whole-note-snapshot grain (per S2); **per-block history stays Phase 3** (block IDs already preserved for it).

### Out of scope (B)
- **Synced** history (per-device only in v1).
- Per-block / character-level history timeline (Phase 3).
- Branching/named versions, manual "save a version now" button (could be a cheap add later — flag if trivial).

---

## Acceptance
**Undo/redo:**
- Mobile Undo + Redo buttons present in the editor; disabled when depth is 0; enabled after edits.
- One undo reverts a continuous typing burst (not one char); a pause/operation-change starts a new step.
- Desktop keyboard shortcuts work; undo/redo preserves block IDs + the unified title node.
- Undo state resets on leaving the note.

**History:**
- Editing a note across separated sessions (idle-settle and/or leave-and-return) produces distinct versions;
  a continuous burst does NOT spawn many versions; a big single paste/delete forces a checkpoint; trivial
  micro-edits don't.
- Timeline shows rows with relative time + `+added/−removed` delta; conflict versions appear + are marked.
- Diff view renders a unified inline diff with a vs-current / vs-previous toggle.
- Restore makes a version current non-destructively (prior current retained as a new version) and syncs.
- Retention cap prunes oldest beyond the limit.
- Per-device limitation is stated honestly in the history UI.

**Gate (per `[[ui-features-need-rendered-ui-gate]]`):** render tests that mount the real editor/timeline and
assert undo grouping, button enable/disable, version capture on session boundaries (idle/leave/big-change,
not on bursts), delta computation, diff render, and restore-as-new-version — PLUS a thin on-device smoke
(undo/redo feel on iOS; edit-leave-return creates a version; diff + restore round-trip) before deploy. Tests
green + prod typecheck clean (`[[green-gate-needs-prod-typecheck]]`). Report bundle delta (perf gate).

## Suggested lanes (orchestrator's call)
- **Editor/undo:** wire `prosemirror-history` + keymap + mobile Undo/Redo buttons with depth-driven
  enable/disable (pairs naturally with the editor-tools toolbar lane).
- **History capture:** the session-coalescing version-capture layer (idle-settle + on-leave + big-change,
  material-change threshold, baseline tracking, retention prune) over `noteVersions`.
- **History UI:** timeline + unified diff (vs current/previous) + restore, mobile-first.
- **secSys:** light pass — account-scope on all version reads/writes + restore's CAS-safe sync path.
