# Spike S3 — iOS multi-webclip storage

**Type:** THROWAWAY research spike (written finding, **not kept code** — may include a tiny
throwaway probe page to observe behaviour). · **Proposed owner:** a grunt (sonnet). ·
**Parallel with:** P0, S1, S2. **Not blocking** — informs the one-storage-clip-per-notebook
lean; downgraded from make-or-break to optimization (online-first makes it non-fatal either way).

## Question to answer
On iOS, with the deltos "multiple home-screen icons = Add-to-Home-Screen at different routes of
one origin" model:
1. Do **same-origin webclips share storage** (IndexedDB/OPFS/Cache), or is each webclip an
   isolated storage partition?
2. Does **in-scope navigation stay standalone** (no Safari-chrome bounce) when a webclip opens a
   route and the user navigates within scope?
3. **Quota model:** per-origin or per-webclip? What's the rough ceiling, and does the installed-
   PWA IndexedDB **7-day eviction exemption** hold across webclips?
4. Given the above — is **one storage clip per notebook** feasible and worth it?

## Why it matters
The brainstorm leans toward one storage clip per notebook (symmetry with "the notebook is the
unit of everything"). The tension: isolated clips make **offline universal search + cross-
notebook transport** harder — but both run online in the common case, so this is an optimization
call, not a blocker. We want the facts before Phase 2/3 design leans on an assumption.

## Investigate
- `brainstorm.md` §Platform→"One PWA, surfaces-as-routes, multiple icons" and the storage-
  sharing paragraph (states the lean + the tension to test).
- Determine empirically where possible: a **throwaway probe** — a minimal page on one origin
  that writes a keyed value to IndexedDB/OPFS/Cache, added to home screen at two different
  routes, then read back from each clip to see if they observe each other's writes. (Throwaway —
  not kept in the tree.) Note: needs a real iOS device over the tailnet (`tailscale serve`,
  HTTPS — required for installable PWA + secure-context storage APIs).
- If a live device isn't available this round, give the best-evidenced answer from current iOS
  WebKit behaviour and **flag what needs on-device confirmation**.

## Deliverable (written finding — `docs/spikes/S3-findings.md`)
- Answers to the four questions, each marked **confirmed-on-device** vs **best-evidence**.
- A recommendation on the **one-clip-per-notebook** lean: pursue / drop / defer, with the trade
  spelled out (offline search + cross-notebook transport cost vs. the symmetry gain).
- Any follow-up that needs a real device if this round couldn't get one.

## Reuse-discipline gate
Research only — the probe page is throwaway and **not kept**. No production code lands from this
spike.

## Out of scope
Building the storage layer, the blob store, or any notebook scoping. This only de-risks an
assumption.
