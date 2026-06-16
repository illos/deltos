# DG-CAP gate-record — Tier-B iPhone dogfood capture template

**Owner:** scopeSys (scaffold). **Run owner:** planSys + the user. **Status:** SCAFFOLD — formal Run
held; exploratory dogfooding in progress.

This is the **capture template** for the one on-device dogfood that constitutes the DG-CAP capstone.
It pairs 1:1 with the 8-step **Tier B `[CLI-device]` runbook** in
`v1-done-gate-acceptance-checklist.md`. **The gate closes only when every step is PASS on one
prod-representative build** (and Tier-A `[CLI-auto]` is green in CI, and [SRV] is 5/5 — both already
true at scaffold time).

> **⚠ GATE-FIDELITY PREAMBLE (canon — planSys):** the RECORDED capstone MUST run against a
> **PROD-REPRESENTATIVE build** — a prod-mode worker (`ENVIRONMENT=production`, F13 **ACTIVE**, **NO**
> unverified `LOCAL_OWNER` fallback) + a prod client build, with **all 8 steps on ONE coherent
> build**. A **dev build FALSE-PASSES** the auth / F13-gating / QR-join-blocked legs (permissive auth)
> and **MUST NOT** be used for the recorded run. The refreshed **dev** build is ONLY for the early,
> **non-recorded** iOS-WebAuthn-UX smoke — never for the gate record.

> **⚠ MODE (planSys):** the current phase is **EXPLORATORY dogfooding** — rapid on-device UI-gap squash
> via HMR. **Do NOT formally capture per-step PASS/FAIL verdicts mid-squash.** Log what the dogfood
> surfaces in the **Exploratory findings log** below (these are the durable record of what the
> on-device capstone caught that the automated gate could not). The single **Formal capstone Run**
> block is **HELD** until planSys signals the build is stable; it captures once, on the final fixed
> build SHA.

---

## Exploratory dogfooding findings log (current phase)

What the real-device dogfood surfaced that the automated gate ([SRV] 14/14 + Tier-A 13/13) did not.
Append as gaps surface; each is routed to a fix + (where possible) a new headless test that closes the
class. **Not** formal capstone verdicts.

| # | Finding | Why the automated gate missed it | Fix owner / status |
|---|---------|-----------------------------------|--------------------|
| E1 | **Editor not autosaving** — the editor→store persistence wiring is broken: typed notes never reach the store, so they don't list / sync / recover. (Navigation is fine — swipe-back + note list both work; the earlier "nav gap" read was WRONG.) | The suites drove the **store programmatically** (`mutateNotes.put` + everything downstream green) and **structurally bypassed the editor→store wiring** — the seam where the UI writes what the user typed. Store/sync/auth all correct; the editor silently didn't persist. | gruntSys2 — fix **addressed `@a7d32e2`** (per planSys); durable coverage **essentially CLOSED `@3d26228`** (9 navList tests, suite 145/145). The 3 new PM-pipeline tests cover the editor→store **data path**: text-insert → `docChanged` → title-extract → `onSave` → `mutateNotes.put` → list emission. **Only uncovered link = PM's own `EditorView`→`dispatchTransaction`** (ProseMirror-internal, correctly trusted, not our code — exercised by the on-device test). **TEST-BAR MET.** 🟡 still **PENDING USER ON-DEVICE PASS.** |
| E2 | **Dynamic Island safe-area occlusion** — content occluded by the Dynamic Island / safe-area inset on device. | Headless jsdom has no device viewport / safe-area insets — no notion of the Dynamic Island. | gruntSys2 — **FIXED `@329eb17`**: `env(safe-area-inset-top)` padding on `.shell__bar` (inline critical CSS + `styles.css`) + `.auth` container; `viewport-fit=cover` + `black-translucent` already present. Deployed `:8451`. 🟡 **fixed — pending user re-confirm.** |
| _…_ | _(append findings as the squash surfaces them)_ | | |

### Durable lesson (the sharpest example yet of why the on-device capstone exists)

A suite that **calls the engine directly never proves the UI reaches the engine.** [SRV] +
Tier-A proved the data/sync/auth journey perfectly while the editor silently failed to persist —
**automated green ≠ usable.** The fixes are closing the testable seams headlessly (E1's
type→store→list component test), which **narrows** the gap; but full end-to-end on-device reachability
(real WebAuthn, install, device viewport/safe-area, the whole nav flow) is **only** provable by the
Tier-B capstone. This log is that backstop's record.

---

## Formal capstone Run — ⏸ HELD (capture once planSys signals the build STABLE)

> Fill this block **once**, on the final fixed build, after planSys signals the exploratory squash is
> done and the build is stable. Confirm prod-representative (preamble) before recording. If a formal
> run is itself blocked, duplicate this block per attempt so history is preserved.

| Field | Value |
|-------|-------|
| Build SHA under test | _final stable fixed build — `git rev-parse --short HEAD` of the coherent build served on `:8451`_ |
| Build mode (MUST be prod-representative) | _confirm: prod-mode worker (`ENVIRONMENT=production`, F13 ACTIVE, no `LOCAL_OWNER` fallback) + prod client build. (Worker prod singleton validated earlier; re-confirm it fronts the final build.)_ |
| Run date | _YYYY-MM-DD_ |
| Tester | _(fill at run)_ |
| Device model | _(fill at run)_ |
| iOS version | _(fill at run)_ |
| Browser / engine | _Safari (WebKit) — version_ |
| Install method | _Add-to-Home-Screen (standalone)_ |
| Serving URL | `https://devbox.tail41404c.ts.net:8451/` — hostname RP ID (PIN-ID-9) |
| 2nd device (steps 7–8) | _(model + iOS)_ |

| # | Step (runbook) | Criterion | What to observe | Result | Notes / observations |
|---|----------------|-----------|-----------------|--------|----------------------|
| 1 | Install / A2HS | install | A2HS installs; launches standalone; SW shell loads | ☐ PASS / FAIL | |
| 2 | Enroll | DG-1d | fresh-account intent; Secure-Enclave signing key; 24-word phrase shown **once** | ☐ PASS / FAIL | |
| 3 | Lock → unlock | DG-1c | WebAuthn UV (FaceID) decrypts the Identity blob; honest no-PRF disclosure shown (or PRF used on iOS-18) | ☐ PASS / FAIL | _PRF available? Y/N_ |
| 4 | Capture `/new` | DG-2a | typing into a client-UUID note; first heading becomes the title; **the typed note PERSISTS to the store and appears in the note list** (the E1 autosave bug — key re-check) | ☐ PASS / FAIL | |
| 5 | True offline | DG-2b (device) | airplane mode → create+edit → relaunch PWA → both notes + edits survive (real IndexedDB across reload) | ☐ PASS / FAIL | |
| 6 | Reconnect & sync | DG-3e (device) | leave airplane → sync fires on the network transition; indicator syncing→idle; notes reach server | ☐ PASS / FAIL | |
| 7 | QR-join 2nd device | DG-4b | join **blocked** without the out-of-band code; UI states the in-person model | ☐ PASS / FAIL | |
| 8 | Recover / capstone | DG-CAP | 2nd device: recover via 24-word phrase → **same `accountId`** → pull → the note from step 4/5 is **PRESENT + content matches** | ☐ PASS / FAIL | |

**Formal Run verdict:** _pending planSys stable signal_

---

## Capstone verdict (overall)

- [ ] **DG-CAP PASS** — all 8 steps PASS on one prod-representative build → the done-sentence is
  literally true on a real device. Combined with Tier-A green + [SRV] 5/5, **v1 done-gate is CLOSED.**
- [x] **DG-CAP not yet passed** — exploratory dogfooding in progress (UI-gap squash via HMR); formal
  Run held until planSys signals stable. Findings logged above.
