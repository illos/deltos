# v1 Course-Correction — executable acceptance matrix (Part 1 shell + Part 2 conflict-as-version)

> **Historical — v1 shipped 2026-06-24. This acceptance matrix was satisfied on ship; preserved as build record.**

**Owner:** scopeSys (analyst). **Status:** DRAFT — 2026-06-16. The spec-level **v1 gate** for
`docs/specs/v1-shell-and-conflict-versions.md`. Each row is an individually-verifiable acceptance
criterion drawn verbatim-in-intent from that spec's **Behavior** + **Acceptance** sections.

**Pairing:** Part-2 rows (`CAV-*`) are **1:1 with gruntSys's conflict-as-version tests**
(`packages/client/test/`), written against devSys2's data-model contract (`hasConflict`,
conflict-version record shape, read-hook signature). Part-1 rows (`P1-*`) are the local-first shell
gate. Cadence (`CAV-1`) is the planSys-blessed **2 s idle-settle + 5 s max-wait**.

**Proof tiers** (same vocabulary as `v1-done-gate-acceptance-checklist.md`):
- **[SRV]** — worker harness (the CAS conflict-detection half already exists: PIN-SYNC-1).
- **[CLI-auto]** — headless client suite (Vitest + jsdom; `fake-indexeddb`; fake timers for cadence;
  PM harness). gruntSys owns the Part-2 conflict tests; the shell lane owns Part-1.
- **[DEV]** — on-device dogfood capstone (real installed PWA over Tailscale HTTPS, PIN-ID-9). The
  reload / offline-cold-start / conflict-UX legs are only *fully* provable here (see the dogfood
  scope-limit lesson in the done-gate checklist).

A row is GREEN when its proof passes in its tier. The gate closes when every [SRV]+[CLI-auto] row is
green AND the [DEV] capstone confirms the shell + conflict UX on a real device.

---

## Part 1 — Local-first shell (load decoupled from auth)

| ID | Criterion | Tier | Pass condition | Spec ref |
|----|-----------|------|----------------|----------|
| P1-1 | **Render-before-data** — launch reads the local store and renders the notes UI **before any session/auth await** | [CLI-auto] + [DEV] | first paint of the notes list occurs with **no awaited** session/auth call on the path; local `accountId` + durable wrapped key + `keyId` read from durable storage | Part 1 §Behavior 1 |
| P1-2 | **Enrolled plain reload → straight into notes** | [DEV] + [CLI-auto] | enrolled device, plain reload → lands directly in notes; **no recovery-phrase prompt; no perceptible auth wait** (E4 closed *properly*, not just the keyId patch) | Part 1 §Acceptance |
| P1-3 | **Silent background re-auth** after first paint | [CLI-auto] + [DEV] | signed-challenge re-auth from the stored key runs **after** first paint; success is invisible; user never "re-authorizes" | Part 1 §Behavior 2 |
| P1-4 | **Failure stays non-blocking** — offline / lost key / server down | [CLI-auto] + [DEV] | UI keeps working on local data; quiet **non-blocking** offline/not-synced status; retry w/ backoff; **no eviction to a recovery screen** | Part 1 §Behavior 3 |
| P1-5 | **Offline cold start** (airplane) | [DEV] + [CLI-auto] | notes render and are editable; status shows offline; **no gate** | Part 1 §Acceptance |
| P1-6 | **Blocking auth ONLY for the two real logout paths** | [CLI-auto] + [DEV] | a blocking screen appears **only** for (a) genuine first-run (no local account/data) → enroll, or (b) no local key (cleared data) → recovery; nothing else gates | Part 1 §Behavior 4 |
| P1-7 | **Clear browsing data → recovery path** | [DEV] + [CLI-auto] | after clearing data, next load → recovery-phrase re-register (expected; the only logout) | Part 1 §Acceptance, §Behavior 4b |
| P1-8 | **E4 full-screen removed as a boot gate** | [CLI-auto] | "device hasn't been registered" no longer appears on launch with a surviving local key; it survives **only** as the no-local-key recovery path (4b) | Part 1 §Behavior 5 |
| P1-9 | **F7 token in-memory only** | [CLI-auto] | session/grant token never written at rest (no Dexie row, no `localStorage`, no cold-start cache); survives reload as *gone-then-re-minted*, never *persisted* | Constraints (F7), [[session-token-in-memory-only]] |
| P1-10 | **Disclosure at enroll/recovery, OUT of the launch path** | [CLI-auto: node + **render**] + [DEV] | **node-level (devSys, provable now):** the placement *logic* — disclosure fires at enroll/recovery, **not** on a silent background re-auth (Option-A invariant). **render-level (gruntSys2, ⛔ jsdom-harness-gated):** the disclosure component actually renders, correct copy, in those routes only | §At-rest custody, [[keystore-noprf-ui-disclosure]] |

---

## Part 2 — Sync + conflict-as-version (option A) · `CAV-*` (1:1 with gruntSys tests)

| ID | Criterion | Tier | Pass condition | Owner / lane |
|----|-----------|------|----------------|--------------|
| CAV-1 | **Push cadence** — online edits debounce-push at the blessed cadence | [CLI-auto] (fake timers) | a push fires **~2 s after typing settles**, and **at least every 5 s** during continuous typing (max-wait cap); not per-keystroke | shell/sync (devSys2) |
| CAV-2 | **Offline buffer → flush on reconnect** | [CLI-auto] + [DEV] | offline edits accumulate in local store + push queue; flushed on the `online` event | gruntSys / sync |
| CAV-3 | **Fast-forward, no conflict** | [CLI-auto] + [SRV] | offline edit → reconnect, **server unchanged** → CAS fast-forwards; no conflict, **no toast** | gruntSys (lane 1) |
| CAV-4 | **Conflict retained as a version on the SAME note** (data-model anchor) | [CLI-auto] + [SRV] | server advanced beyond device base → conflict; divergent edit retained as a conflict-version (`NoteVersion`) keyed to the same note ID; **server content stays live**; note gains `hasConflict` + ≥1 retained snapshot; nothing overwritten. **Record shape pinned `@eab2ab5`**; `body`+`properties` present = whole-note grain (subsumes CAV-13). **`NoteVersion` carries `accountId`** — secSys-ruled YES (D6 scoping belt-and-suspenders; compound `[noteId+accountId]` index) — asserted in CAV-4's 3rd test | gruntSys (lane 2) |
| CAV-5 | **No second note, ever** | [CLI-auto] | a conflict **never** produces a second note in the list | gruntSys (lane 3) |
| CAV-6 | **Relations stay valid** | [CLI-auto] | the note keeps its ID → inbound relations still resolve (no relation-repair); `forkedFromId` retired for the conflict path (revises **PIN-SYNC-4**) | gruntSys (lane 4) |
| CAV-7 | **Offline-edit vs server-delete (PIN-SYNC-3)** | [CLI-auto] | live state may be a tombstone, but the divergent offline edit is **retained as a conflict version**; *keep mine* resurrects it | gruntSys (lane 5) |
| CAV-8 | **Conflict surface — toast + persistent badge** | [CLI-auto: **render**] + [DEV] | on conflict (during background sync) a **non-blocking toast** *"Sync conflict on '<title>' — your version was kept"*; the note shows a **persistent badge** until resolved | gruntSys2 / UI (⛔ jsdom-harness-gated) |
| CAV-9 | **Resolve: keep mine** | [CLI-auto] | the divergent local version becomes live (pushed as the new top version); badge clears | gruntSys (lane 6a) |
| CAV-10 | **Resolve: keep theirs** | [CLI-auto] | discard the retained divergent version; server content stays live; badge clears | gruntSys (lane 6b) |
| CAV-11 | **Resolve: keep both** | [CLI-auto] | retain **both as versions of the one note** (no auto second note); an explicit "duplicate to new note" is the only split (planner ruling; overridable) | gruntSys (lane 6c) |
| CAV-12 | **Stream-B no-lost-edit invariants still hold** | [CLI-auto] (REFERENCE) | re-run the existing trip-wire tests — both sides retained; no silent loss. Do **not** duplicate; reference the Stream-B suite | gruntSys (reference) |
| CAV-13 | **Whole-note snapshot grain** | — (design invariant) | conflict versions are whole-note snapshots (per S2-findings); per-block history stays Phase 3 (block-IDs already preserved) | spec §Behavior 7/8 |

---

## Coordination & owners

- **Part 2 / `CAV-*`** — gruntSys writes the conflict-as-version tests in `packages/client/test/`,
  **1:1 with these row IDs** (aligned + committed `@2526f71`; **22 RED / 163 GREEN** — correct TDD
  state), against devSys2's data-model contract. gruntSys's six pilot-assigned lanes map exactly:
  lane 1→CAV-3, 2→CAV-4, 3→CAV-5, 4→CAV-6, 5→CAV-7, 6→CAV-9/10/11. Final owner split of my added rows:
  **CAV-1** (cadence) + **CAV-2** (offline buffer/flush) — **claimed by gruntSys**, go GREEN when
  devSys2 wires the debounced push + `online` listener; **CAV-8** (toast/badge UI) → **gruntSys2**;
  **CAV-12** (trip-wire) → a reference comment in `syncEngine.test.ts`, no duplication; **CAV-13**
  (grain) → folded inline into CAV-4.
- **Part 1 / `P1-*`** — **test owner = devSys** (the shell owner; pilot 2026-06-16). devSys writes the
  **automatable shell-logic legs TDD as it builds**: the gating logic (first-run vs no-local-key vs
  enrolled → which UI; P1-6/P1-8), **render-before-data ordering** (P1-1, P1-3), the **F7
  token-in-memory-only** assertion (P1-9), and the non-blocking-failure / disclosure-placement logic
  (P1-4, P1-10). The **inherently-manual legs stay [DEV]-tier** in planSys's on-device capstone:
  **P1-2** (real plain reload), **P1-5** (airplane offline cold start), **P1-7** (clear-browsing-data).
  Implementer-writes-tests is acceptable here because **independent verification** = this spec-level
  matrix + **secSys's F7 audit** + the [DEV] capstone. (devSys2 owns the sync core / cadence, not the
  shell.)
- **[SRV]** conflict detection — the worker CAS (PIN-SYNC-1, `expectedVersion`) already decides
  fast-forward vs conflict; CAV-3/CAV-4 reference it, no new server mechanism.
- **Shared jsdom render harness (gruntSys adding; devSys flagged the gap):** node-level CLI-auto
  tests (logic, no DOM) run today; the **render-level** legs need a shared jsdom harness not yet
  installed. It unblocks exactly two rows: **P1-10 render leg** (the disclosure *component* renders in
  the right routes) and **CAV-8** (toast + badge render). **Owner note (flagged to pilot):** the
  disclosure component is gruntSys2's ([[keystore-noprf-ui-disclosure]]), so P1-10 splits **node-level →
  devSys** (Option-A placement logic, proven now) vs **render-level → gruntSys2** (harness-gated);
  CAV-8 was already gruntSys2. No pass-condition changes — only a tier/owner clarification on P1-10's
  render sub-leg. Until the harness lands, those two render legs are gated, not failing.
- **Reuse / don't rebuild** (spec): the audited **Stream-B no-lost-edit core** (both sides already
  retained — the hard correctness half is done), the version-counter / `expectedVersion` CAS, the
  autosave debounce (extended to the debounced server push). This is a **representation change**
  (fork → version on same note), not a new conflict-detection engine.
