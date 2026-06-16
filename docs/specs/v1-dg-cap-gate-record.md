# DG-CAP gate-record — Tier-B iPhone dogfood capture template

**Owner:** scopeSys (scaffold). **Run owner:** planSys + the user. **Status:** SCAFFOLD — fill at gate time.

This is the **capture template** for the one on-device dogfood that constitutes the DG-CAP capstone.
It pairs 1:1 with the 8-step **Tier B `[CLI-device]` runbook** in
`v1-done-gate-acceptance-checklist.md`. Run the runbook once on a real installed PWA; record each step
here. **The gate closes only when every step is PASS** (and Tier-A `[CLI-auto]` is green in CI, and
[SRV] is 5/5 — both already true at scaffold time).

> **⚠ GATE-FIDELITY PREAMBLE (canon — planSys):** the RECORDED capstone MUST run against a
> **PROD-REPRESENTATIVE build** — a prod-mode worker (`ENVIRONMENT=production`, F13 **ACTIVE**, **NO**
> unverified `LOCAL_OWNER` fallback) + a prod client build, with **all 8 steps on ONE coherent
> build**. A **dev build FALSE-PASSES** the auth / F13-gating / QR-join-blocked legs (permissive auth)
> and **MUST NOT** be used for the recorded run. The refreshed **dev** build is ONLY for the early,
> **non-recorded** iOS-WebAuthn-UX smoke — never for the gate record.

> How to use: duplicate the "Run" block below per attempt (re-runs after a fix get a fresh block so
> the history is preserved, not overwritten). Mark each step **PASS / FAIL / BLOCKED / N-A**. A FAIL
> on any step fails the capstone — note the failure, route the fix, re-run with a new build SHA.

---

## Run 1 — metadata

_(build facts pre-filled by scopeSys from pilot's gate-record handoff; live fields filled by
planSys + the user at run time. Re-runs after a fix duplicate this block.)_

| Field | Value |
|-------|-------|
| Build SHA under test | client dist **`55e438d`** (client source unchanged through repo HEAD `2e421cb`; intervening commits worker-test-only — so the client bundle is coherent with HEAD) |
| Build mode (MUST be prod-representative) | ✅ **CONFIRMED prod-representative** — worker prod-mode singleton (`127.0.0.1:8787`, `ENVIRONMENT=production`, **F13 ACTIVE**, **no** unverified `LOCAL_OWNER` fallback; devSys validated live: enroll / session / recover-same-accountId / replay-401 / audience-401) + prod client build. **prod-MODE = YES.** |
| Run date | _YYYY-MM-DD (fill at run)_ |
| Tester | _(fill at run)_ |
| Device model | _(e.g. iPhone 15 Pro — fill at run)_ |
| iOS version | _(e.g. iOS 18.x — fill at run)_ |
| Browser / engine | _Safari (WebKit) — version (fill at run)_ |
| Install method | _Add-to-Home-Screen (standalone)_ |
| Serving URL | `https://devbox.tail41404c.ts.net:8451/` — hostname RP ID (PIN-ID-9) |
| 2nd device (steps 7–8) | _(model + iOS — fill at run)_ |

## Run 1 — per-step results

| # | Step (runbook) | Criterion | What to observe | Result | Notes / observations |
|---|----------------|-----------|-----------------|--------|----------------------|
| 1 | Install / A2HS | install | A2HS installs; launches standalone; SW shell loads | ✅ PASS | reached step 4 |
| 2 | Enroll | DG-1d | fresh-account intent; Secure-Enclave signing key; 24-word phrase shown **once** | ✅ PASS | reached step 4 |
| 3 | Lock → unlock | DG-1c | WebAuthn UV (FaceID) decrypts the Identity blob; honest no-PRF disclosure shown (or PRF used on iOS-18) | ✅ PASS | reached step 4 |
| 4 | Capture `/new` | DG-2a | typing into a client-UUID note; first heading becomes the title (single PM doc) | 🔴 **BLOCKED** | **UI-NAVIGATION GAP** — editor has **no exit/save affordance** (no done/back, no note list to return to) → user is **stuck in the editor**, cannot proceed. Capstone-blocking. |
| 5 | True offline | DG-2b (device) | airplane mode → create+edit → relaunch PWA → both notes + edits survive (real IndexedDB across reload) | ⛔ NOT REACHED | gated by the step-4 block |
| 6 | Reconnect & sync | DG-3e (device) | leave airplane → sync fires on the network transition; indicator syncing→idle; notes reach server | ⛔ NOT REACHED | gated by the step-4 block |
| 7 | QR-join 2nd device | DG-4b | join **blocked** without the out-of-band code; UI states the in-person model | ⛔ NOT REACHED | gated by the step-4 block |
| 8 | Recover / capstone | DG-CAP | 2nd device: recover via 24-word phrase → **same `accountId`** → pull → the note from step 4/5 is **PRESENT + content matches** | ⛔ NOT REACHED | gated by the step-4 block |

## Run 1 — verdict: 🔴 BLOCKED

- [x] **DG-CAP BLOCKED** — step **4** blocked by a **UI-navigation/shell gap** (editor exit/save +
  note list missing). Steps 5–8 not reached. Fix in progress — **gruntSys2**. **Re-run** the full
  capstone on the fixed `:8451` build (new build SHA), fresh Run block below.

### Run 1 — instructive finding (why the automated gates didn't catch this)

The automated gate — **server `v1.donegate.test.ts` 14/14** + **Tier-A `[CLI-auto]` 13/13** — proved
the **data / sync / auth** journey by driving the store and sync engine **programmatically**. It
**structurally cannot** catch a missing **UI-navigation / shell affordance** (no exit/save button, no
note list), because it never renders or navigates the shell — it calls the engine directly. This gap
is **exactly the class the on-device Tier-B capstone exists to catch**: real-user reachability of the
journey through the actual UI. Automated green ≠ usable; the capstone is the usability backstop.

---

## Run 2 — metadata (re-run on gruntSys2's fix `a7d32e2`)

_(staged by scopeSys; live fields filled by planSys + the user at re-run. Fix under test: HomeView
note-list + editor "← Notes" back link — the step-4 UI-nav gap from Run 1.)_

| Field | Value |
|-------|-------|
| Build SHA under test | client fix **`a7d32e2`** (HomeView note-list + editor back link) — record the actual `git rev-parse --short HEAD` of the coherent build served at run time |
| Build mode (MUST be prod-representative) | _re-confirm prod-representative on the fixed `:8451` build before recording — prod-mode worker (`ENVIRONMENT=production`, F13 ACTIVE, no `LOCAL_OWNER` fallback) + prod client build. (Worker prod singleton was validated for Run 1; re-confirm it still fronts the fixed build.)_ |
| Run date | _YYYY-MM-DD (fill at run)_ |
| Tester | _(fill at run)_ |
| Device model | _(fill at run)_ |
| iOS version | _(fill at run)_ |
| Browser / engine | _Safari (WebKit) — version (fill at run)_ |
| Install method | _Add-to-Home-Screen (standalone)_ |
| Serving URL | `https://devbox.tail41404c.ts.net:8451/` — hostname RP ID (PIN-ID-9) |
| 2nd device (steps 7–8) | _(model + iOS — fill at run)_ |

## Run 2 — per-step results

| # | Step (runbook) | Criterion | What to observe | Result | Notes / observations |
|---|----------------|-----------|-----------------|--------|----------------------|
| 1 | Install / A2HS | install | A2HS installs; launches standalone; SW shell loads | ☐ PASS / FAIL | |
| 2 | Enroll | DG-1d | fresh-account intent; Secure-Enclave signing key; 24-word phrase shown **once** | ☐ PASS / FAIL | |
| 3 | Lock → unlock | DG-1c | WebAuthn UV (FaceID) decrypts the Identity blob; honest no-PRF disclosure shown (or PRF used on iOS-18) | ☐ PASS / FAIL | _record PRF available? Y/N_ |
| 4 | Capture `/new` | DG-2a | typing into a client-UUID note; first heading becomes the title; **can exit via "← Notes" + see it in the note list** (Run-1 gap) | ☐ PASS / FAIL | |
| 5 | True offline | DG-2b (device) | airplane mode → create+edit → relaunch PWA → both notes + edits survive (real IndexedDB across reload) | ☐ PASS / FAIL | |
| 6 | Reconnect & sync | DG-3e (device) | leave airplane → sync fires on the network transition; indicator syncing→idle; notes reach server | ☐ PASS / FAIL | |
| 7 | QR-join 2nd device | DG-4b | join **blocked** without the out-of-band code; UI states the in-person model | ☐ PASS / FAIL | |
| 8 | Recover / capstone | DG-CAP | 2nd device: recover via 24-word phrase → **same `accountId`** → pull → the note from step 4/5 is **PRESENT + content matches** | ☐ PASS / FAIL | |

## Run 2 — verdict: _pending_

- [ ] **DG-CAP PASS** — all 8 steps PASS → done-sentence literally true on device.
- [ ] **DG-CAP BLOCKED/FAIL** — step(s) ______ ; fix routed to ______ ; re-run.

---

## Capstone verdict (overall)

- [ ] **DG-CAP PASS** — all 8 steps PASS on one prod-representative build → the done-sentence is
  literally true on a real device. Combined with Tier-A green + [SRV] 5/5, **v1 done-gate is CLOSED.**
- [x] **DG-CAP not yet passed** — Run 1 BLOCKED at step 4 (UI-nav gap, gruntSys2 fixing); awaiting a
  re-run on the fixed build.

**Recorded by:** scopeSys (from pilot's Run-1 report)   **Date:** 2026-06-16   **Result relayed to:**
scopeSys (checklist) + pilot + gruntSys2 (fix).
