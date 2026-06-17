# Swipe Actions (note list) — executable acceptance matrix

**Owner:** scopeSys (analyst). **Status:** DRAFT — 2026-06-17, **reworked to Fork P (trash-as-property).**
The spec-level **done-gate** for `docs/specs/swipe-actions-note-list.md`. Each row is an
individually-verifiable acceptance criterion drawn verbatim-in-intent from that spec's **Acceptance
criteria** (§AC1–8), plus a planSys-added v1 acceptance item (SA-9 reserved-key guardrail). Same shape as
the matrix I own at `v1-shell-conflict-acceptance-matrix.md`.

**Delete model — Fork P (planSys-decided 2026-06-17, supersedes the `deletedAt`-tombstone draft):** a user
delete sets a **`trashed` flag in the note's PropertyBag** and rides the **existing `op=upsert` /
`updateNote` push path** — the property travels in the push draft and is server-CAS'd like any content
edit. **No new sync-push op/branch, no new CAS surface, no `deletedAt` column** — it reuses the
**live-proven `rows_written>0` CAS** (`[[d1-rowswritten-index-inflation]]`). The list filters out notes
whose current version is `trashed`; **undo = unset the flag** (a further upsert). See
`[[trash-as-version-delete-model]]`.

**The Tier split (pilot's framing):**
- **Tier-A — automatable** = the **data-layer correctness** half (Lane 1): trash-toggle + undo, duplicate,
  and **no-data-loss-while-syncing**, plus the reserved-key guardrail (SA-9). Pure input→output contracts
  on `mutateNotes` + the push queue; written TDD (`tdd-cycle`), backed by `fake-indexeddb`. **A Tier-A row
  is a hard merge gate.**
- **Tier-B — on-device-only** = everything the gesture *feels* like: stretchy-delete, single-open,
  tap/scroll-outside close, and **scroll-not-hijacked**. No honest headless proof — tuned and verified on
  the real iPhone via the exploratory-relay pattern (user verifies feel; planSys relays). render-level legs
  that *can* run in jsdom are noted, but the **gesture/feel verdict stays [DEV]**.
- **AC8 perf** is its own gate: a **measurable** half (bundle delta, no-new-heavyweight-dep) + a **felt**
  half (list-load still beats Apple Notes). pilot reports the before/after served-bundle size at hand-back.

**Proof tiers** (same vocabulary as `v1-done-gate-acceptance-checklist.md` / the v1 matrix):
- **[CLI-auto]** — headless client suite (Vitest + jsdom; `fake-indexeddb`; fake timers where cadence
  applies). The Lane-1 regression tests live here. `render` sub-tag = needs the jsdom render harness.
- **[SRV / real-D1]** — the trash-toggle round-trip (set **and** unset `trashed`) must be proven against
  the **real worker on real D1** (not better-sqlite3). **Fork P makes this a properties-only round-trip
  confirm, NOT a new CAS leg:** the `trashed` flag travels in the **existing upsert draft** and is decided
  by the **existing `updateNote` CAS** — the same `rows_written>0`-not-`===1` hit-test that is already
  live-proven. The real-D1 leg still matters because that CAS is an `UPDATE` on the multi-index `notes`
  table: a single-row update reports `rows_written>1` (index writes) and better-sqlite3's `.changes`
  (=rows-changed=1) **masks** it — the class that bit us **twice**
  (`[[d1-rowswritten-index-inflation]]`, `[[migration-d1-no-temp-table]]`). So SA-T5/T6 stay first-class
  Tier-A rows with a **real-D1 harness requirement** (`wrangler dev` + `d1:migrate:local`, per
  `[[dogfood-prod-worker-recipe]]`) — but they now confirm "a properties patch carrying `trashed`
  round-trips through the existing path," **not** a bespoke delete/restore branch. A green better-sqlite3
  suite does **not** satisfy this leg.
- **[DEV]** — on-device dogfood capstone (real installed PWA over Tailscale HTTPS, the iPhone). Every
  feel/gesture leg is *only* fully provable here.

A row is GREEN when its proof passes in its tier. **The shipping-first delete slice closes when every
Tier-A [CLI-auto] + [SRV/real-D1] row is green — incl SA-T5/T6 (properties-only `trashed` set/unset
round-trip on real D1, reusing the `updateNote` CAS) and the SA-9 reserved-key guardrail — AND the [DEV]
dogfood confirms gesture feel, single-open, scroll-safety, and perf-feel — AND AC8's measured bundle delta
is reported within budget.** The minimal **trash view** (SA-V1/V2) is a **tracked IMMEDIATE-NEXT
fast-follow**, not a blocker for this slice.

---

## Acceptance matrix — one row per criterion (SA-1 … SA-9)

| ID | Criterion (spec AC) | Tier | What to test | How to verify | Owning lane |
|----|---------------------|------|--------------|---------------|-------------|
| **SA-1** | Drag-right reveals **Copy** + **Delete**; they're tappable and the row **stays open** until dismissed (AC1) | **Tier-B** [DEV] (+ [CLI-auto: render] partial) | a soft right-swipe snaps to `open-right` and rests there; both buttons are hit-testable and invoke their callbacks; the row does **not** auto-close | **[DEV]** on-device: swipe, confirm rest + both buttons tap. **render-partial:** in jsdom, drive a synthetic `pointerdown→move→up` past `SNAP_OPEN`≈60 and assert the open state + button click handlers fire (mechanism, not feel) | Lane 2 (gruntSys2) |
| **SA-2** | Hard right-fling **commits Delete directly** with the **stretchy-delete** feel; the row **leaves the list** (AC2) | **Tier-B** [DEV] | release past `FAR_RIGHT`≈240 commits delete without resting open; Copy shrinks→0 + fades while Delete grows to fill the gutter, driven off pointer-x; the row animates off as the **`trashed` flag is set** and `observeNotes` re-renders (the list filters trashed notes out) | **[DEV]** on-device feel verdict (stretchy math + fly-off tuned to deltos row size). The *delete result* (`trashed` set) is covered by SA-3/Tier-A; here it's the **gesture→commit threshold + animation** that is on-device-only | Lane 2 (gruntSys2) |
| **SA-3** | **Delete is sync-correct and undoable:** note disappears, an **undo toast** restores it, and the delete (and undo) **propagates to the server via the existing upsert path** on next sync (AC3) | **Tier-A** [CLI-auto] + **[SRV/real-D1]**; undo-toast UX = [DEV] | `mutateNotes.delete(note)` sets the reserved **`trashed`** property and persists+enqueues via the **existing put-and-enqueue (`upsert`) path** at the current `version` (CAS baseVersion); the row leaves the list via the **trashed filter** (not `!deletedAt`) but survives for undo. **Undo = unset `trashed`** (omit the key, not `=undefined` — `exactOptionalPropertyTypes`), re-put + re-enqueue as another upsert. **No new op/branch** — properties travel in the normal push draft | **[CLI-auto]** = SA-T1 + SA-T2 (shape: trashed-set + filtered + upsert-enqueued; trashed-cleared + back in list + upsert-enqueued). **[SRV/real-D1]** = SA-T5 (set) + SA-T6 (unset) — a properties patch carrying `trashed` round-trips **push→server→pull** through the existing `updateNote` CAS on **real D1**, accepts (`rows_written>0`, not a phantom conflict despite `rows_written>1`). **[DEV]** = undo-toast appears and restores on tap | **Lane 1** (devSys2 lead, devSys consult) |
| **SA-4** | **Copy** creates a duplicate that **appears in the list** and **syncs as its own record** (AC4) | **Tier-A** [CLI-auto] (+ [DEV] visual) | `mutateNotes.duplicate(note)` = new `crypto.randomUUID()` id, copied title/body/properties, fresh timestamps, version seeded as a **new note**, **current `accountId` stamped**, via the put-and-enqueue path. New id ⇒ new sync record, **no CAS conflict**. **Reserved keys (incl `trashed`) are NOT copied** — a duplicate is always a live note | **[CLI-auto]** = SA-T3 (new id ≠ source; both rows present; enqueued as an insert; reserved keys stripped). **[DEV]** = "Duplicated" toast + the copy shows in the list | **Lane 1** (devSys2) |
| **SA-5** | **Single-open invariant**; tap-outside / scroll closes the open row; tap on a **closed** row still opens the note; **`ConflictBadgeSlot` still renders and works** (AC5) | **Tier-B** [DEV] (+ [CLI-auto: render] partial) | one `openId` lifted to `HomeView`: opening a row closes any other; an outside pointerdown / scroll closes the open row; closed-row tap navigates (existing `<Link>`), open-row tap closes; button taps `stopPropagation()` so they don't bubble to tap-to-open; `ConflictBadgeSlot` keeps rendering and stays tappable on a swipeable row | **[DEV]** = interaction verdict on-device. **render-partial:** jsdom can assert "open B closes A" given two rows + the lifted `openId`, and that `ConflictBadgeSlot` still mounts inside `SwipeRow`; the **outside-pointerdown / scroll-close** behavior is interaction-shaped → [DEV] | Lane 2 (gruntSys2) |
| **SA-6** | **Vertical list-scroll unaffected** by the gesture; a **left drag rubber-bands closed** (no action) (AC6) | **Tier-B** [DEV] | `touch-action: pan-y` + an ~8px dominant-axis horizontal-intent threshold before capture so a vertical scroll is **never hijacked**; a left drag rubber-bands back to closed (left is RESERVED — seam only, no action in v1) | **[DEV]** = the classic on-device-only: scroll a long list through rows without triggering swipe; drag left and confirm rubber-band + no action. No honest headless proof for scroll-not-hijacked | Lane 2 (gruntSys2) |
| **SA-7** | **No data loss** on delete / undo / duplicate **while a sync is in flight** (AC7) | **Tier-A** [CLI-auto] — **marquee gate** | a **trash-toggle upsert** issued while an edit's push is in flight, or an undo mid-sync, must not drop the edit; since delete and edit are now **both upserts to the same note**, respect the **accepted/conflict drain asymmetry** (accept=selective, conflict=blanket) and the **in-flight-edit survival guard** | **[CLI-auto]** = SA-T4 (trash-toggle-while-pending-edit keeps the edit; undo-mid-sync loses nothing). Carries `[[sync-pushqueued-drain-invariants]]` + `[[stream-b-conflict-audit]]` — **reference** those trip-wire suites, do not re-implement | **Lane 1** (devSys2) |
| **SA-8** | **Perf budget:** no new heavyweight dependency; **bundle delta small** (target low single-digit KB gzipped — report it); list-load feel **unchanged (still beats Apple Notes)** (AC8) | **measured = Tier-A-ish; felt = Tier-B** [DEV] | (a) **no framer-motion / no new animation or gesture dep** added to `packages/client`; (b) served-bundle gzipped delta is small; (c) list-load + scroll feel unchanged on-device | **measured:** `git diff` on `package.json` shows no new runtime dep; build before/after and diff the gzipped served-bundle size — **pilot reports the number at hand-back**. **felt:** [DEV] list-load + scroll still beats Apple Notes | pilot (report) + Lane 2 (keep it lean) — `[[performance-is-a-standing-value]]` |
| **SA-9** | **Reserved-key guardrail for `trashed`** — the trash flag is a *system* property, not user content (planSys v1 acceptance item, Fork P) | **Tier-A** [CLI-auto] (+ [CLI-auto: render] for UI-hidden, [DEV] confirm) | (a) `trashed` lives under a **general reserved/system namespace** (one guarded namespace, not a bespoke column — so future system flags reuse it); (b) **hidden** from the property/frontmatter editor UI; (c) **excluded** from markdown / frontmatter **export**; (d) **not user-editable / not user-deletable** (a user cannot set, clear, or remove it by editing properties — only `delete`/`undo`/restore mutate it) | **[CLI-auto]** = SA-T7 (export of a trashed note omits the reserved namespace; a user property-edit cannot write/clear `trashed`; round-trips as reserved on real D1). **render** = the property editor does not list reserved keys. **[DEV]** = confirm on-device the flag is invisible + uneditable | **Lane 1** (devSys2) data guard + **Lane 2** (gruntSys2) UI-hide; **secSys** light pass |

---

## Tier-A regression scaffold — Lane 1 (`packages/client/test/`)

The **automatable** rows the dogfood does **not** need to re-prove. Written TDD against `mutateNotes`
(devSys2's data contract); assert **shape**, not feel.

| Test ID | Backs | Assertion (input → output shape) | Tier |
|---------|-------|----------------------------------|------|
| **SA-T1** | SA-3 (delete) | `delete(note)` → note's PropertyBag has reserved **`trashed`** set; the note is **filtered out of the list** (trashed filter) but **still in store**; an **upsert** sync-push entry is enqueued at the current version | [CLI-auto] |
| **SA-T2** | SA-3 (undo) | `undo` → `trashed` **omitted** (not `=undefined`); row re-put + an **upsert** entry enqueued; the note is back in the live list | [CLI-auto] |
| **SA-T3** | SA-4 (duplicate) | `duplicate(note)` → fresh id (≠ source), copied title/body/properties **with reserved keys (incl `trashed`) stripped** (copy is live), current `accountId`; **both** rows present; enqueued as an insert (no CAS conflict) | [CLI-auto] |
| **SA-T4** | SA-7 (no-loss) | a trash-toggle upsert (or undo) issued **while a push for an edit is in flight** drops **neither** the edit nor the trash-toggle; drain asymmetry honored | [CLI-auto] |
| **SA-T5** | SA-3 (delete, real round-trip) | drive **push→server→pull** for a delete on **real D1**: a properties patch carrying **`trashed`** travels the **existing `upsert`/`updateNote` CAS** (no new branch) → accepts (asserts `rows_written>0`, NOT `===1`; reports `rows_written>1` from the 4 `notes` indexes yet is **accepted, not a phantom conflict**); pull returns the note with `trashed` set | **[SRV/real-D1]** — real-D1 harness required |
| **SA-T6** | SA-3 (undo, real round-trip) | drive **push→server→pull** for an undo on **real D1**: a properties patch **clearing `trashed`** travels the same `updateNote` CAS → accepts (`rows_written>0`); pull returns the note **live again** (no `trashed`). **No `deletedAt`-guard nuance** — it's an ordinary property update | **[SRV/real-D1]** — real-D1 harness required |
| **SA-T7** | SA-9 (guardrail) | export of a trashed note **omits** the reserved namespace; a user property-edit **cannot set or clear `trashed`** (write rejected/ignored at the mutate boundary); `trashed` round-trips as a **reserved** key on real D1 | [CLI-auto] (+ real-D1 for round-trip) |

> **SA-T5 + SA-T6 stay an EXPLICIT planSys-directed real-D1 Tier-A leg — but Fork P SIMPLIFIES them from a
> bespoke delete/restore branch to a properties-only round-trip confirm.** The `trashed` flag rides the
> **existing `upsert`/`updateNote` CAS** (the live-proven `rows_written>0` path), so there is **no new op,
> no new branch, no `deletedAt` column, no guard-drop asymmetry** to verify. What survives — and why these
> are still hard merge gates on a **real-D1 harness** (`wrangler dev` + `d1:migrate:local`, per
> `[[dogfood-prod-worker-recipe]]`) — is the `rows_written`-index-inflation class
> (`[[d1-rowswritten-index-inflation]]`, cousin of the temp-table `SQLITE_AUTH` landmine
> `[[migration-d1-no-temp-table]]`): the CAS is still an `UPDATE` on the multi-index `notes` table, and
> better-sqlite3's `.changes` masks `rows_written>1`. The better-sqlite3 suite does **not** satisfy SA-T5/T6.

---

## Trash view — tracked IMMEDIATE-NEXT fast-follow (NOT deferred, NOT a blocker for the delete slice)

planSys ruling: the shipping-first slice is **delete (trash-toggle) + list-filter + undo-toast**. The
minimal **trash view** is a **tracked fast-follow** (gruntSys2), built right after — not deferred to a
later milestone. It rides the same Fork-P primitives (it's the inverse list filter + the unset-trash
mutation already proven by SA-T2/SA-T6), so it adds **no new data/CAS surface**.

| Test ID | Item | Assertion | Tier | Status |
|---------|------|-----------|------|--------|
| **SA-V1** | Trash view lists trashed notes | a "Trash" view lists exactly the notes whose current version has `trashed` set (the **inverse** of the home filter) | [CLI-auto] + [DEV] | fast-follow |
| **SA-V2** | Restore from trash view | restore in the trash view **unsets `trashed`** via the same upsert path as undo (SA-T2/SA-T6); the note returns to the home list | [CLI-auto] + [DEV] | fast-follow |

**Explicitly LATER (deferred, not in the fast-follow):** empty-trash and permanent (hard) delete.

---

## Coordination & owners

- **Tier-A / Lane 1 (data)** — **devSys2 lead, devSys consult.** Owns `mutateNotes.delete/undo/duplicate`
  (Fork P: trash-toggle via the existing upsert path), the reserved-namespace + guardrail (SA-9 data half),
  and SA-T1..T7. Gates Lane 2's wiring, but the UI builds against stubbed callbacks in parallel. **A merge
  requires all Tier-A rows green.** devSys's feasibility-spike conclusion (trash-as-property rides the
  existing version push path, no new op branch) is the basis for this slice.
- **Tier-B / Lane 2 (gesture-UI)** — **gruntSys2.** Owns `SwipeRow` + HomeView integration, stretchy
  delete, undo-toast wiring (**reuse `ToastHost`/`toastEvents`, do not build a new toast**),
  single-open/outside-close, the left-drag rubber-band + future-Pin seam, the SA-9 **UI-hide** of reserved
  keys, and the **trash view fast-follow** (SA-V1/V2). SA-1/2/5/6 verdicts are on-device.
- **secSys** — light pass (spec §Security): confirm `duplicate` stamps the **current** `accountId` (no
  cross-account leak), the trash-toggle upsert is account-scoped like every other write
  (`[[stream-d-accountid-readiness]]`), and the **reserved-key guardrail** holds (a client cannot forge or
  clear `trashed` via an ordinary property write — confirm the mutate boundary enforces the reserved
  namespace, not just the UI). Not expected to block; asserted inside SA-T3 + SA-T7.
- **render harness** — the `render`-partial sub-legs of SA-1/SA-5/SA-9 reuse the **shared jsdom harness**
  the v1 matrix already depends on (same gate as P1-10-render / CAV-8). Until it lands they are gated, not
  failing; the **feel verdict stays [DEV]** regardless, so the harness is not on the critical path.
- **On-device tuning is mandatory** (spec §Decomposition): thresholds (`SNAP_OPEN`/`OPEN_RIGHT`/
  `FAR_RIGHT`) and the stretchy math are tuned against the real iPhone via the exploratory-relay pattern —
  user verifies feel, planSys relays. SA-1, SA-2, SA-5, SA-6, and AC8's felt half close there.
- **Reuse-discipline gate** (spec header / KICKOFF §Reuse): the TRKR packet
  (`_inbox/SWIPE_ACTIONS_EXPORT.md`) is a **behavioral reference only** — thresholds + stretchy math +
  §8 gotchas transfer; the React-18/framer-motion mechanism does **not**. SA-8(a) (no new dep) is the
  enforceable edge of that gate.
