# Swipe Actions on the Note List (mobile)

**Status:** SHIPPED — v1 live 2026-06-24. Part of the **"basic notes,
day-to-day usable"** milestone — this is the **delete affordance** that milestone was missing, plus a
duplicate. **Reuse-discipline gate applies** (KICKOFF §Reuse): the source packet
(`_inbox/SWIPE_ACTIONS_EXPORT.md`, from TRKR — React 18 + framer-motion + Tailwind) is a **behavioral
reference only**. deltos is React 19 + hand-rolled CSS + Dexie + zustand with **no animation/gesture
library**, so the mechanism is rewritten from scratch; only the *behavior* (thresholds, stretchy-delete
math, the §8 gotchas) transfers.

## Why
The user wants iOS-Mail-style swipe actions on the **note list** (`HomeView`), mobile-first. It delivers
the milestone's known gaps in one stroke: a real **delete** UX (no delete affordance exists today) and a
quick **duplicate**. The user's directive: *"copy the swipe-to-the-right features verbatim — Copy and
Delete buttons revealed on a soft swipe, note deleted on a hard swipe."*

## Scope decisions (user, 2026-06-17)
- **Mobile only for now.** Build touch-first. Desktop keeps tap-to-open (the existing `<Link>`); a
  desktop affordance (hover/context action) is a later, separate item — do **not** build swipe-on-desktop.
- **Swipe RIGHT (drag-right) = verbatim TRKR right side:**
  - Soft swipe → snap **open-right**, revealing **Copy** + **Delete** buttons (tappable, stay open).
  - Hard fling right (past the far threshold) → **commit Delete** directly, with the **stretchy-delete**
    treatment (Copy shrinks to zero + fades, Delete grows to fill the gutter) and the row animates off.
- **Swipe LEFT = Move → notebook picker sheet (SHIPPED).** *(This spec originally reserved left-swipe
  for a future Pin action. As shipped: LEFT swipe reveals a notebook-picker sheet to move the note to
  another notebook or uncategorize it via "All Notes". The Pin/other-controls idea remains deferred.)*
- **No framer-motion / no new animation or gesture dependency** (perf standing-value — see Implementation).

---

## The surface
`packages/client/src/App.tsx → HomeView` renders the list:
```
<ul className="home__notes">
  {notes.map(note => <li><Link to={`/note/${id}`}>{title}</Link><ConflictBadgeSlot/></li>)}
</ul>
```
Each `<li>` becomes a **swipeable row**. Tapping the closed row still navigates to the note (today's
`<Link>` behavior); the `ConflictBadgeSlot` must keep rendering and stay tappable.

---

## Lane 1 — Data layer: sync-correct delete + undo, and duplicate (devSys2 lead; devSys consult)
**This is the non-obvious half. Do NOT wire the UI to the existing `deleteNote()`.**

`LocalStore.deleteNote(id)` is a **hard local delete with no enqueue** — it is the internal path the
pull-merge uses to apply *server* tombstones. A user swipe-delete must instead **soft-delete + enqueue +
be undoable**, sync-correct against the worker's `deletedAt` CAS path. Required:

1. **`mutateNotes.delete(note)` (or `softDelete`)** — atomic (one transaction, mirroring
   `putNoteAndEnqueue`): mark the row `deletedAt` (tombstone-state: it leaves the list via the existing
   `!n.deletedAt` filter but the row survives for undo + sync) **and** enqueue a sync entry so the server
   soft-deletes too (worker already supports the `deletedAt` UPDATE with CAS). `baseVersion` = current
   persisted version (CAS precondition; respect the **rows_written>0** CAS semantics —
   `[[d1-rowswritten-index-inflation]]`). *(Archive note: as shipped, delete uses the **Fork P
   `sys:trashedAt` property** pattern, not a `deletedAt` field. The spec's `deletedAt` approach
   describes the intended design; the live implementation uses `sys:trashedAt` in the note's
   properties bag as the soft-delete marker.)*
2. **Undo = resurrect**, same shape as `resolveConflict` keep-mine resurrection
   (`dexieLocalStore.ts`): drop `deletedAt` (omit, not set-`undefined` — `exactOptionalPropertyTypes`),
   re-put, enqueue at the current version. The note returns to the list.
3. **`mutateNotes.duplicate(note)` ("Copy")** — create a NEW note (fresh `crypto.randomUUID()` id,
   copied title/body/properties, fresh timestamps, `version` seeded as a new note, `accountId` stamped
   for the current account — same as `NewNote` create) via the existing put-and-enqueue path. New id =
   new sync record, no CAS conflict. Title convention: keep the same title (no "Copy of" prefix) unless
   the user later asks otherwise.

**Correctness guards (carry the sync invariants — do not regress):** soft-delete + undo must respect the
accepted/conflict drain asymmetry and the in-flight-edit survival guard
(`[[sync-pushqueued-drain-invariants]]`, `[[stream-b-conflict-audit]]`). A delete enqueued while an edit
is in flight, or undone mid-sync, must not lose data. **Regression tests** (real input→output shape,
tdd-cycle): delete→tombstone-hidden + enqueued; undo→resurrected + enqueued; duplicate→new id + both rows
present; delete-while-pending-edit doesn't drop the edit.

## Lane 2 — Gesture + UI: the hand-rolled swipe row (gruntSys2 lead)
A new component (e.g. `components/SwipeRow.tsx`) wrapping each note `<li>`; data-agnostic, calls
callbacks. **Lightweight mechanism, no framer-motion:**

- **Pointer Events**: `pointerdown` → `setPointerCapture`; `pointermove` writes
  `foreground.style.transform = translateX(dx)` **imperatively** (no React state during drag → no
  re-renders → 60fps); `pointerup`/`pointercancel` runs the release decision.
- **Snap** via CSS `transition: transform 320ms cubic-bezier(...)` to the target (or a small rAF spring
  if the bouncy feel is wanted — gruntSys2's call, keep it tiny). `touch-action: pan-y` on the draggable
  so vertical list-scroll still works; a horizontal-intent threshold (~8px, dominant axis) before
  capturing so a scroll isn't hijacked.
- **Geometry / thresholds — port from the packet (§3):** resting `open-right` ≈ `OPEN_RIGHT` (Copy+Delete
  side by side), `SNAP_OPEN` ≈ 60 (min to snap open), `FAR_RIGHT` ≈ 240 (fling-commit delete). Use the
  **absolute x at release**, not the delta, for the decision tree. **Stretchy delete:** Copy width shrinks
  `OPEN_RIGHT/2 → 0` and fades between `OPEN_RIGHT` and `FAR_RIGHT`; Delete grows to fill — drive these
  imperatively off the same pointer-x. Tune the numbers to deltos's row size on-device.
- **Buttons:** **Copy** → `onDuplicate` (toast "Duplicated"); **Delete** → `onDelete` (soft-delete +
  **undo toast** — reuse the existing `ToastHost`/`toastEvents`, do not build a new toast). Button taps
  `stopPropagation()` so they don't bubble to the row's tap-to-open.
- **Single-open invariant + close-on-outside:** lift "which row is open" to `HomeView` (one `openId`);
  opening one closes others; a tap/scroll outside the open row closes it (the packet's `data-*` +
  outside-pointerdown detector, rewritten). Tap on a closed row = navigate (existing `<Link>`); tap on an
  open row = close.
- **Delete fly-off:** on hard-commit, don't snap the foreground back — let the row animate out as it
  leaves the list (CSS height/opacity collapse on removal; the reactive list re-renders when `deletedAt`
  is set). Coordinate the exit with the reactive `observeNotes` re-render.
- **Left drag:** rubber-band back to closed (no action). Leave a clear seam (a `left` panel slot /
  `open-left` state stub) for the future Pin action.
- **Haptics:** OPTIONAL and low-priority — `navigator.vibrate` is a **no-op in iOS Safari PWAs** (the
  packet says so), which is our primary target, so it buys nothing on-device. A tiny wrapper is fine to
  include for Android, but it is not acceptance-bearing; do not gold-plate the armed-commit haptic.

---

## Acceptance criteria
1. On an iPhone (the dogfood device), dragging a note row right reveals **Copy** + **Delete**; they're
   tappable and the row stays open until dismissed.
2. A hard right-fling deletes the note directly with the stretchy-delete feel; the row leaves the list.
3. **Delete is sync-correct and undoable:** the deleted note disappears from the list, an **undo toast**
   restores it, and the deletion (and any undo) propagates to the server on next sync — verified against
   the real worker, not just better-sqlite3 (`[[d1-rowswritten-index-inflation]]`).
4. **Copy** creates a duplicate note that appears in the list and syncs as its own record.
5. Single-open invariant holds; tap-outside / scroll closes the open row; tap on a closed row still opens
   the note; the `ConflictBadgeSlot` still renders and works.
6. Vertical list-scroll is unaffected by the gesture; a left drag rubber-bands closed (no action).
7. **No data loss** on delete/undo/duplicate while a sync is in flight (regression tests, Lane 1).
8. **Perf budget (standing value, `[[performance-is-a-standing-value]]`):** no new heavyweight dependency;
   bundle delta is small (target: low single-digit KB, gzipped — report it); list-load feel is unchanged
   (still beats Apple Notes). pilot reports the before/after served-bundle size at hand-back.

## Security (secSys — light pass)
Within-account, low surface. Confirm: duplicate stamps the **current** `accountId` (no cross-account
leak), and soft-delete/undo enqueue is account-scoped like every other write
(`[[stream-d-accountid-readiness]]`). No new auth surface; not expected to block.

## Out of scope / deferred
- **Left-swipe action (Pin or other)** — reserved; user undecided. Seam only, no action.
- **Multi-select via long-press** (TRKR §1) — not requested; defer.
- **Desktop swipe / hover affordance** — later, separate item.
- **+15m / −15m / fill-to-now** — TRKR-specific, dropped entirely (meaningless for notes).

## Decomposition for pilot
- **Lane 1 (data, devSys2 + devSys consult):** sync-correct soft-delete+undo, duplicate, regression tests.
  Gates Lane 2's wiring — but the UI can build against a stubbed callback in parallel.
- **Lane 2 (gesture/UI, gruntSys2):** `SwipeRow` + HomeView integration + stretchy delete + undo-toast
  wiring + single-open/outside-close.
- **secSys:** light account-scope confirm.
- **On-device tuning is mandatory** — thresholds/feel are tuned against the real iPhone, same
  exploratory-relay pattern (user verifies feel; planSys relays).
