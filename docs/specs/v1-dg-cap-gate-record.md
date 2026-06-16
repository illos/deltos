# DG-CAP gate-record — Tier-B iPhone dogfood capture template

**Owner:** scopeSys (scaffold). **Run owner:** planSys + the user. **Status:** SCAFFOLD — fill at gate time.

This is the **capture template** for the one on-device dogfood that constitutes the DG-CAP capstone.
It pairs 1:1 with the 8-step **Tier B `[CLI-device]` runbook** in
`v1-done-gate-acceptance-checklist.md`. Run the runbook once on a real installed PWA; record each step
here. **The gate closes only when every step is PASS** (and Tier-A `[CLI-auto]` is green in CI, and
[SRV] is 5/5 — both already true at scaffold time).

> How to use: duplicate the "Run" block below per attempt (re-runs after a fix get a fresh block so
> the history is preserved, not overwritten). Mark each step **PASS / FAIL / BLOCKED / N-A**. A FAIL
> on any step fails the capstone — note the failure, route the fix, re-run with a new build SHA.

---

## Run metadata

| Field | Value |
|-------|-------|
| Build SHA under test | `b98bf3d` _(or the refreshed build — record the actual `git rev-parse --short HEAD` at run time)_ |
| Run date | _YYYY-MM-DD_ |
| Tester | _(name)_ |
| Device model | _(e.g. iPhone 15 Pro)_ |
| iOS version | _(e.g. iOS 18.x)_ |
| Browser / engine | _Safari (WebKit) — version_ |
| Install method | _Add-to-Home-Screen (standalone)_ |
| Serving URL | _Tailscale HTTPS `https://<host>.<tailnet>.ts.net[:port]/` — hostname RP ID (PIN-ID-9)_ |
| 2nd device (steps 7–8) | _(model + iOS)_ |

## Per-step results

| # | Step (runbook) | Criterion | What to observe | Result | Notes / observations |
|---|----------------|-----------|-----------------|--------|----------------------|
| 1 | Install / A2HS | install | A2HS installs; launches standalone; SW shell loads | ☐ PASS / FAIL | |
| 2 | Enroll | DG-1d | fresh-account intent; Secure-Enclave signing key; 24-word phrase shown **once** | ☐ PASS / FAIL | |
| 3 | Lock → unlock | DG-1c | WebAuthn UV (FaceID) decrypts the Identity blob; honest no-PRF disclosure shown (or PRF used on iOS-18) | ☐ PASS / FAIL | _record PRF available? Y/N_ |
| 4 | Capture `/new` | DG-2a | typing into a client-UUID note; first heading becomes the title (single PM doc) | ☐ PASS / FAIL | |
| 5 | True offline | DG-2b (device) | airplane mode → create+edit → relaunch PWA → both notes + edits survive (real IndexedDB across reload) | ☐ PASS / FAIL | |
| 6 | Reconnect & sync | DG-3e (device) | leave airplane → sync fires on the network transition; indicator syncing→idle; notes reach server | ☐ PASS / FAIL | |
| 7 | QR-join 2nd device | DG-4b | join **blocked** without the out-of-band code; UI states the in-person model | ☐ PASS / FAIL | |
| 8 | Recover / capstone | DG-CAP | 2nd device: recover via 24-word phrase → **same `accountId`** → pull → the note from step 4/5 is **PRESENT + content matches** | ☐ PASS / FAIL | |

## Capstone verdict

- [ ] **DG-CAP PASS** — all 8 steps PASS on this build → the done-sentence is literally true on a real
  device. Combined with Tier-A green + [SRV] 5/5, **v1 done-gate is CLOSED.**
- [ ] **DG-CAP FAIL** — step(s) ______ failed. Fix routed to ______; re-run on a new build.

**Recorded by:** ______   **Date:** ______   **Result relayed to:** scopeSys (checklist flip) + pilot.
