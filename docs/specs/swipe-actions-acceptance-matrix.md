# Swipe Actions (note list) — executable acceptance matrix

**Owner:** scopeSys (analyst). **Status:** DRAFT — 2026-06-17. The spec-level **done-gate** for
`docs/specs/swipe-actions-note-list.md`. Each row is an individually-verifiable acceptance criterion
drawn verbatim-in-intent from that spec's **Acceptance criteria** (§AC1–8), with its lane decomposition
(§Lane 1 data / §Lane 2 gesture-UI). Same shape as the matrix I own at
`v1-shell-conflict-acceptance-matrix.md`.

**The Tier split (pilot's framing):**
- **Tier-A — automatable** = the **data-layer correctness** half (Lane 1): soft-delete + undo, duplicate,
  and **no-data-loss-while-syncing**. Pure input→output contracts on `mutateNotes` + the push queue;
  written TDD (`tdd-cycle`), backed by `fake-indexeddb`. **A Tier-A row is a hard merge gate.**
- **Tier-B — on-device-only** = everything the gesture *feels* like: stretchy-delete, single-open,
  tap/scroll-outside close, and **scroll-not-hijacked**. These have no honest headless proof — they are
  tuned and verified on the real iPhone via the exploratory-relay pattern (user verifies feel; planSys
  relays). render-level legs that *can* run in jsdom are noted, but the **gesture/feel verdict stays
  [DEV]**.
- **AC8 perf** is its own gate: a **measurable** half (bundle delta, no-new-heavyweight-dep) + a **felt**
  half (list-load still beats Apple Notes). pilot reports the before/after served-bundle size at hand-back.

**Proof tiers** (same vocabulary as `v1-done-gate-acceptance-checklist.md` / the v1 matrix):
- **[CLI-auto]** — headless client suite (Vitest + jsdom; `fake-indexeddb`; fake timers where cadence
  applies). The Lane-1 regression tests live here. `render` sub-tag = needs the jsdom render harness.
- **[SRV / real-D1]** — the deletion **and** undo-resurrection round-trips must be proven against the
  **real worker on real D1** (not better-sqlite3), exercised through the **NEW sync-push path**, **not**
  the REST `deleteNote`. **Protocol gap devSys2 found:** the spec assumed the worker already accepted a
  `deletedAt` write on push — but that was REST `deleteNote`; the **sync-push path does not carry a
  delete/restore signal today.** devSys is extending it (`SyncPushEntry` gains a delete/restore signal +
  the worker push handler gains delete + restore branches). So this leg verifies **push → server → pull**
  through that new branch. Both the delete and the restore ride a CAS `UPDATE` on the multi-index `notes`
  table whose hit-detection is `rows_written > 0`, **not `=== 1`** — on real D1 a single-row UPDATE
  reports `rows_written > 1` (index writes), and better-sqlite3's `.changes` (=rows-changed=1) **masks**
  the class. This is the **planSys-directed explicit leg** (not a sub-note): the rows_written
  index-inflation family has bitten us **twice** (`[[d1-rowswritten-index-inflation]]`,
  `[[migration-d1-no-temp-table]]`), so it is a first-class Tier-A row with a **real-D1 harness
  requirement** — `wrangler dev` + `d1:migrate:local` against a real D1, per
  `[[dogfood-prod-worker-recipe]]`. A green better-sqlite3 suite does **not** satisfy this leg.
- **[DEV]** — on-device dogfood capstone (real installed PWA over Tailscale HTTPS, the iPhone). Every
  feel/gesture leg is *only* fully provable here.

A row is GREEN when its proof passes in its tier. **The gate closes when every Tier-A [CLI-auto] +
[SRV/real-D1] row is green — including the explicit real-D1 CAS legs SA-T5 (delete) + SA-T6 (undo),
which the better-sqlite3 suite alone does NOT satisfy — AND the [DEV] dogfood confirms the gesture feel,
single-open, scroll-safety, and the perf-feel — AND AC8's measured bundle delta is reported and within
budget.**

---

## Acceptance matrix — one row per criterion (SA-1 … SA-8)

| ID | Criterion (spec AC) | Tier | What to test | How to verify | Owning lane |
|----|---------------------|------|--------------|---------------|-------------|
| **SA-1** | Drag-right reveals **Copy** + **Delete**; they're tappable and the row **stays open** until dismissed (AC1) | **Tier-B** [DEV] (+ [CLI-auto: render] partial) | a soft right-swipe snaps to `open-right` and rests there; both buttons are hit-testable and invoke their callbacks; the row does **not** auto-close | **[DEV]** on-device: swipe, confirm rest + both buttons tap. **render-partial:** in jsdom, drive a synthetic `pointerdown→move→up` past `SNAP_OPEN`≈60 and assert the open state + button click handlers fire (mechanism, not feel) | Lane 2 (gruntSys2) |
| **SA-2** | Hard right-fling **commits Delete directly** with the **stretchy-delete** feel; the row **leaves the list** (AC2) | **Tier-B** [DEV] | release past `FAR_RIGHT`≈240 commits delete without resting open; Copy shrinks→0 + fades while Delete grows to fill the gutter, driven off pointer-x; the row animates off as `deletedAt` is set and `observeNotes` re-renders | **[DEV]** on-device feel verdict (stretchy math + fly-off tuned to deltos row size). The *delete result* (tombstone set) is covered by SA-3/Tier-A; here it's the **gesture→commit threshold + animation** that is on-device-only | Lane 2 (gruntSys2) |
| **SA-3** | **Delete is sync-correct and undoable:** note disappears, an **undo toast** restores it, and the delete (and undo) **propagates to the server through the sync-push path** on next sync (AC3) | **Tier-A** [CLI-auto] + **[SRV/real-D1]**; undo-toast UX = [DEV] | `mutateNotes.delete(note)` is atomic: sets `deletedAt` (row hidden by `!n.deletedAt` filter, survives for undo) **and** enqueues a **delete-signal** sync-push entry at the current `version` (CAS baseVersion). **Undo = resurrect:** drop `deletedAt` (omit, not `=undefined` — `exactOptionalPropertyTypes`), re-put, enqueue a **restore-signal** sync-push entry. Propagation rides the **new sync-push delete/restore branch** (devSys's protocol extension), **not** REST `deleteNote` | **[CLI-auto]** = SA-T1 + SA-T2 below (shape: tombstone-hidden+enqueued; resurrected+enqueued). **[SRV/real-D1]** = SA-T5 (delete) + SA-T6 (restore) below — drive **push→server→pull** through the new sync-push branch on the **real worker on real D1**, assert each CAS accepts (`rows_written>0`, not a phantom conflict despite index-inflated `rows_written>1`). **[DEV]** = the undo-toast actually appears and restores on tap | **Lane 1** (devSys2 lead, devSys consult) |
| **SA-4** | **Copy** creates a duplicate that **appears in the list** and **syncs as its own record** (AC4) | **Tier-A** [CLI-auto] (+ [DEV] visual) | `mutateNotes.duplicate(note)` = new `crypto.randomUUID()` id, copied title/body/properties, fresh timestamps, version seeded as a **new note**, **current `accountId` stamped**, via the put-and-enqueue path. New id ⇒ new sync record, **no CAS conflict** | **[CLI-auto]** = SA-T3 (new id ≠ source id; both rows present in the list; the duplicate is enqueued as an insert). **[DEV]** = "Duplicated" toast + the copy shows in the list | **Lane 1** (devSys2) |
| **SA-5** | **Single-open invariant**; tap-outside / scroll closes the open row; tap on a **closed** row still opens the note; **`ConflictBadgeSlot` still renders and works** (AC5) | **Tier-B** [DEV] (+ [CLI-auto: render] partial) | one `openId` lifted to `HomeView`: opening a row closes any other; an outside pointerdown / scroll closes the open row; closed-row tap navigates (existing `<Link>`), open-row tap closes; button taps `stopPropagation()` so they don't bubble to tap-to-open; `ConflictBadgeSlot` keeps rendering and stays tappable on a swipeable row | **[DEV]** = interaction verdict on-device. **render-partial:** jsdom can assert "open B closes A" given two rows + the lifted `openId`, and that `ConflictBadgeSlot` still mounts inside `SwipeRow`; but the **outside-pointerdown / scroll-close** behavior is interaction-shaped → [DEV] | Lane 2 (gruntSys2) |
| **SA-6** | **Vertical list-scroll unaffected** by the gesture; a **left drag rubber-bands closed** (no action) (AC6) | **Tier-B** [DEV] | `touch-action: pan-y` + an ~8px dominant-axis horizontal-intent threshold before capture so a vertical scroll is **never hijacked**; a left drag rubber-bands back to closed (left is RESERVED — seam only, no action in v1) | **[DEV]** = the classic on-device-only: scroll a long list through rows without triggering swipe; drag left and confirm rubber-band + no action. No honest headless proof for scroll-not-hijacked | Lane 2 (gruntSys2) |
| **SA-7** | **No data loss** on delete / undo / duplicate **while a sync is in flight** (AC7) | **Tier-A** [CLI-auto] — **marquee gate** | a delete enqueued while an edit is in flight, or an undo mid-sync, must not drop the edit; respect the **accepted/conflict drain asymmetry** (accept=selective, conflict=blanket) and the **in-flight-edit survival guard** | **[CLI-auto]** = SA-T4 (delete-while-pending-edit keeps the edit; undo-mid-sync loses nothing). Carries `[[sync-pushqueued-drain-invariants]]` + `[[stream-b-conflict-audit]]` — **reference** those trip-wire suites, do not re-implement | **Lane 1** (devSys2) |
| **SA-8** | **Perf budget:** no new heavyweight dependency; **bundle delta small** (target low single-digit KB gzipped — report it); list-load feel **unchanged (still beats Apple Notes)** (AC8) | **measured = Tier-A-ish; felt = Tier-B** [DEV] | (a) **no framer-motion / no new animation or gesture dep** added to `packages/client`; (b) served-bundle gzipped delta is small; (c) list-load + scroll feel unchanged on-device | **measured:** `git diff` on `package.json` shows no new runtime dep; build before/after and diff the gzipped served-bundle size — **pilot reports the number at hand-back**. **felt:** [DEV] list-load + scroll still beats Apple Notes | pilot (report) + Lane 2 (keep it lean) — `[[performance-is-a-standing-value]]` |

---

## Tier-A regression scaffold — Lane 1 (`packages/client/test/`), 1:1 with the spec's §Lane 1 tests

These are the **automatable** rows the dogfood does **not** need to re-prove. They are written TDD against
`mutateNotes` (devSys2's data contract) and assert **shape**, not feel. SA-T1..T4 are the spec's four
named regression tests (§Lane 1).

| Test ID | Backs | Assertion (input → output shape) | Tier |
|---------|-------|----------------------------------|------|
| **SA-T1** | SA-3 (delete) | `delete(note)` → row has `deletedAt` set (hidden by `!n.deletedAt`, **still in store**) **and** a **delete-signal** sync-push entry is enqueued at the current version | [CLI-auto] |
| **SA-T2** | SA-3 (undo) | `undo` → `deletedAt` **omitted** (not `=undefined`), row re-put and a **restore-signal** sync-push entry enqueued; the note is back in the live list | [CLI-auto] |
| **SA-T3** | SA-4 (duplicate) | `duplicate(note)` → a row with a **fresh id** (≠ source), same title/body/properties, current `accountId`; **both** rows present; the new row enqueued as an insert (no CAS conflict) | [CLI-auto] |
| **SA-T4** | SA-7 (no-loss) | a delete (or undo) issued **while a push for an edit is in flight** drops **neither** the edit nor the delete; drain asymmetry honored | [CLI-auto] |
| **SA-T5** | SA-3 (delete, real round-trip) | drive **push → server → pull** for a delete through the **new sync-push delete branch** (NOT REST `deleteNote`) on the **real worker on real D1** → the `deletedAt` CAS `UPDATE` (still gated `deletedAt IS NULL AND version = base`) **accepts** (asserts `rows_written>0`, NOT `===1`); it reports `rows_written>1` from the 4 `notes` indexes yet is **accepted, not a phantom conflict**; the subsequent pull returns the tombstone | **[SRV/real-D1]** — real-D1 harness required |
| **SA-T6** | SA-3 (restore, real round-trip) | drive **push → server → pull** for a restore through the **new sync-push restore branch** on the **real worker on real D1** → the restore CAS `UPDATE` **drops the `deletedAt IS NULL` guard** (the row IS tombstoned — it must match a deleted row) and instead keys on `version = base` (CAS), clearing `deletedAt`; it likewise reports `rows_written>1` yet **accepts** (not a phantom conflict); the subsequent pull returns the note **live again** | **[SRV/real-D1]** — real-D1 harness required |

> **SA-T5 + SA-T6 are an EXPLICIT planSys-directed Tier-A leg, not a sub-note — and they exercise the NEW
> sync-push delete/restore branch, not REST `deleteNote`.** devSys2 found the gap: the sync-push path does
> not carry a delete/restore signal today (the spec's "worker already supports deletedAt" was the REST
> path). devSys is extending `SyncPushEntry` + the worker push handler with delete + restore branches; this
> gate verifies the round-trip through *that* branch. Both branches are CAS `UPDATE`s on the multi-index
> `notes` table, so on real D1 each reports `rows_written>1` and the hit-test must read `rows_written>0`
> (NOT `===1`) to avoid a phantom conflict — the exact class fixed at `[[d1-rowswritten-index-inflation]]`
> (and a cousin of the temp-table `SQLITE_AUTH` landmine, `[[migration-d1-no-temp-table]]`). **Asymmetry to
> guard:** the **delete** branch keeps `deletedAt IS NULL` in its WHERE (only delete a live row); the
> **restore** branch **must drop that guard** (the target row IS deleted) and rely on `version` CAS alone —
> a restore that kept `deletedAt IS NULL` would match 0 rows and falsely conflict. It has bitten us
> **twice**, so: **the better-sqlite3 suite does NOT satisfy SA-T5/T6** — they require a **real-D1 harness**
> (`wrangler dev` + `d1:migrate:local` against a real D1, the prod-representative local worker per
> `[[dogfood-prod-worker-recipe]]`). These two rows are **hard merge gates** alongside SA-T1..T4.

---

## Coordination & owners

- **Tier-A / Lane 1 (data)** — **devSys2 lead, devSys consult.** Owns `mutateNotes.delete/undo/duplicate`
  + SA-T1..T5. Gates Lane 2's wiring, but the UI builds against stubbed callbacks in parallel (spec
  §Decomposition). **A merge requires all Tier-A rows green.**
- **Tier-B / Lane 2 (gesture-UI)** — **gruntSys2.** Owns `SwipeRow` + HomeView integration, stretchy
  delete, undo-toast wiring (**reuse `ToastHost`/`toastEvents`, do not build a new toast**),
  single-open/outside-close, and the left-drag rubber-band + future-Pin seam. SA-1/2/5/6 verdicts are
  on-device.
- **secSys** — light account-scope pass (spec §Security): confirm `duplicate` stamps the **current**
  `accountId` (no cross-account leak) and soft-delete/undo enqueue is account-scoped like every other
  write (`[[stream-d-accountid-readiness]]`). Not expected to block; asserted inside SA-T3.
- **render harness** — the `render`-partial sub-legs of SA-1/SA-5 reuse the **shared jsdom harness** the
  v1 matrix already depends on (same gate as P1-10-render / CAV-8). Until it lands they are gated, not
  failing; the **feel verdict stays [DEV]** regardless, so the harness is not on the critical path for
  this gate.
- **On-device tuning is mandatory** (spec §Decomposition): thresholds (`SNAP_OPEN`/`OPEN_RIGHT`/
  `FAR_RIGHT`) and the stretchy math are tuned against the real iPhone via the exploratory-relay pattern —
  user verifies feel, planSys relays. SA-1, SA-2, SA-5, SA-6, and AC8's felt half close there.
- **Reuse-discipline gate** (spec header / KICKOFF §Reuse): the TRKR packet
  (`_inbox/SWIPE_ACTIONS_EXPORT.md`) is a **behavioral reference only** — thresholds + stretchy math +
  §8 gotchas transfer; the React-18/framer-motion mechanism does **not**. SA-8(a) (no new dep) is the
  enforceable edge of that gate.
