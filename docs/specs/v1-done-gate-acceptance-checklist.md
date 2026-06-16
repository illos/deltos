# V1 done-gate — acceptance checklist (the "simple v1 done" definition)

**Owner:** scopeSys (planSys-assigned). **Status:** LOCKED — 2026-06-16. Pairs 1:1 with gruntSys's
e2e/integration harness `packages/worker/test/v1.donegate.test.ts` — **one shared definition of
done.** Scenario ids below are LOCKED to gruntSys's confirmed list (`DGT-1`..`DGT-5`); the SRV/CLI
split and the conflict/isolation/revoke "reference, don't duplicate" rule are confirmed by gruntSys.

> **Pausable:** this is docs (contention-free). scopeSys remains the PRIORITY notes/`mutate.ts`
> fixer for secSys's audit — if the notes side is flagged, this doc is dropped, the fix lands, then
> this resumes.

---

## What "v1 done" means (the done-sentence — verbatim source of truth)

From `phase-1-vertical-slice.md` (Goal + Stream D done-gate):

> **install the PWA → unlock with a passkey → create/edit a note offline → reconnect → watch it
> sync; recover/join a second device via phrase/QR; a forced conflict produces a fork, not a lost
> write.** All on clean deltos-native code. **Done when that sentence is literally true on a device.**

This checklist turns that sentence into explicit, individually-verifiable criteria, each tagged with
**how** it is proven. Three proof tiers:

- **[SRV]** — provable in gruntSys's worker integration harness (`v1.donegate.test.ts`): the
  server slice of the journey (auth API, sync round-trip, accountId stability, conflict CAS,
  cross-account isolation).
- **[CLI]** — client/PWA-side, NOT runnable in a worker test: install, the passkey/PIN **unlock
  UI**, true offline IndexedDB persistence, the capture editor, WebAuthn RP-ID continuity. Proven by
  the client test suite and/or on-device.
- **[DEV]** — on-device manual capstone over Tailscale HTTPS (real installed PWA, hostname RP ID per
  PIN-ID-9): the single end-to-end run of the whole done-sentence.

A criterion is GREEN only when its proof passes in its tier. The gate is closed when **every** [SRV]
+ [CLI] criterion is green AND the [DEV] capstone has been run once on a real device.

### Locked [SRV] scenario map — `v1.donegate.test.ts` (gruntSys-confirmed)

The harness has exactly **5** scenarios; every [SRV] criterion maps 1:1 onto one of them.
Conflict, isolation, and revoke are **referenced** from their existing dedicated suites — NOT
duplicated in the donegate harness.

| Scenario | Covers | Status (per pilot, 2026-06-16) |
|----------|--------|--------------------------------|
| **DGT-1** — authenticated sync round-trip | DG-1a (enroll) + DG-3a | 🟢 GREEN |
| **DGT-2** — same-key 2nd-device recovery | DG-4a | 🟢 GREEN — foundation already had same-key reuse; devSys ground-truthed |
| **DGT-3** — CAS / offline reconcile | DG-2c | 🟢 GREEN |
| **DGT-4** — F13 prod auth gating | DG-3b + DG-3c | 🟢 GREEN |
| **DGT-5** — note-present capstone (server slice) | DG-CAP [SRV] half | 🟢 GREEN |
| _(referenced)_ conflict fork | DG-5a / DG-5b → `conflict.test.ts` (4/4) | 🟢 |
| _(referenced)_ cross-account isolation | DG-5c → `isolation.acceptance.test.ts` (10/10) | 🟢 |
| _(referenced)_ revoke BOLA | DG-4c → revoke BOLA test (9fee9f8) | 🟢 |

[SRV] gate state: **5/5 donegate scenarios green** (all DGT-1..DGT-5 + the three referenced suites).
The [SRV] half of the done-gate is CLOSED; what remains for v1 done is the [CLI] half (Tier A + B).

---

## Criteria

### Leg 1 — Enroll / first unlock

| ID | Criterion | Tier | Proof / scenario | Pass condition | Spec ref |
|----|-----------|------|------------------|----------------|----------|
| DG-1a | Enroll a fresh account: register signing key → account minted (stable `accountId`) → session token issued | SRV | **DGT-1** (enroll half of the round-trip) | register → 201 `{keyId,accountFingerprint}`; session → 200 `{token}`; an `accounts` row + `accountCredentials` map exist | PIN-ID-2, PIN-ID-8 |
| DG-1b | Fresh-account intent is guarded; recovery never silently orphans data | SRV/CLI | `enrollNew()` vs `enrollExisting()` | `enrollNew` requires explicit fresh-account intent; recovery routes through `enrollExisting(mnemonic)` | PIN-ID-8 |
| DG-1c | Local unlock via passkey/PIN (WebAuthn UV gates the at-rest blob; signing key authenticates to server — roles distinct) | CLI | client unlock UI test + on-device | unlock decrypts the Identity blob; no PRF dependency (UV-only baseline); honest no-PRF disclosure shown | PIN-ID-4, PIN-ID-6, [[keystore-noprf-ui-disclosure]] |
| DG-1d | 24-word recovery phrase shown once at enroll, guarded | CLI | client enroll UI test | phrase displayed once behind fresh-account intent | PIN-ID-8 |

### Leg 2 — Create / edit a note OFFLINE

| ID | Criterion | Tier | Proof / scenario | Pass condition | Spec ref |
|----|-----------|------|------------------|----------------|----------|
| DG-2a | Capture: `/new` → typing into a client-UUID note immediately; title is the first heading (one PM doc, no separate input) | CLI | client editor test + on-device | stable client UUID at creation; Enter title→body; single drag selects title+body | Stream C acceptance |
| DG-2b | Edits persist optimistically to the local store with NO network; reload restores from local | CLI | client offline-persistence test | create + edit fully offline; reload → note + edits intact (IndexedDB) | Goal, Stream C |
| DG-2c | Offline edits queue; on reconnect the atomic-CAS push accepts and version bumps (SERVER view of the offline path) | SRV | **DGT-3** (offline create/edit reconciliation) | queued batched edits push → accepted, version increments; pull sees final state | PIN-SYNC-1 |
| DG-2d | Block IDs stay unique + stable across copy/paste/split/merge | CLI | client block-id plugin test | every block carries a stable unique `attrs.id` through all transforms | Stream C (block-ID plugin) |

### Leg 3 — Authenticated sync round-trip

| ID | Criterion | Tier | Proof / scenario | Pass condition | Spec ref |
|----|-----------|------|------------------|----------------|----------|
| DG-3a | Push then pull with a REAL bearer grant token; the created note returns byte-identical | SRV | **DGT-1** (authenticated sync round-trip) | push 200; pull returns the note; title/properties/body match what was created | PIN-SYNC-1/2 |
| DG-3b | Every `/api/sync/*` call passes the `can(principal, op, resource)` chokepoint authenticated by the grant token; none authorize on `id` alone | SRV | **DGT-4** (F13 auth gating) | unauthenticated/`id`-only → denied; valid grant → allowed | PIN-ID-1/2 |
| DG-3c | Production auth gating: the dev-only `unverified` principal is REFUSED outside an explicit non-prod env; real bearer required | SRV | **DGT-4** (F13 auth gating) | `unverified` + ENVIRONMENT∉{development,test,local} → 503; real bearer → 200 | F13 fail-closed |
| DG-3d | Client sends the in-memory grant token as the `Authorization` header on push/pull (token never persisted at rest) | CLI | client syncEngine test | push/pull carry `Authorization: Bearer <token>`; token F7 in-memory only | [[session-token-in-memory-only]] |
| DG-3e | Sync indicator reflects pending / syncing / offline / error | CLI | client indicator test | state model transitions correctly | Stream B acceptance |

### Leg 4 — Recover / join a second device

| ID | Criterion | Tier | Proof / scenario | Pass condition | Spec ref |
|----|-----------|------|------------------|----------------|----------|
| DG-4a | Recover on a fresh device via the 24-word phrase → SAME `accountId` → the account's notes are visible | SRV | **DGT-2** (2nd-device recovery) | same signing key/seed → same `accountId`; pull returns the prior device's notes | PIN-ID-3, D6 accountId-stability |
| DG-4b | QR-join a second device requires an out-of-band confirmation code (in-person threat model surfaced) | CLI | client QR-join test + on-device | join blocked without the OOB code; UI states in-person-only model | PIN-ID-7 |
| DG-4c | Device revocation is grant-based (revoke the opaque token); revoking one device cannot touch another account's devices | SRV | existing revoke BOLA test — REFERENCE, not a donegate scenario | revoke by keyId idempotent; cross-account revoke → 404 | PIN-ID-5, revoke BOLA fix (9fee9f8) |

### Leg 5 — Correctness invariants the journey must hold

| ID | Criterion | Tier | Proof / scenario | Pass condition | Spec ref |
|----|-----------|------|------------------|----------------|----------|
| DG-5a | A forced concurrent push on the same base version produces a fork (`forkedFromId`), not a lost write; both copies survive | SRV | `conflict.test.ts` (exists, 4/4) + `DGT-conflict` | CAS raises conflict; fork created; no silent loss | PIN-SYNC-1/3/4 |
| DG-5b | Delete-vs-edit: an offline edit against a server tombstone is preserved as a labeled resurrection fork, not dropped | SRV | `conflict.test.ts` | conflict with `serverNote.deletedAt` set; edit kept as copy | PIN-SYNC-3 |
| DG-5c | Cross-account isolation holds through the whole journey: account A's sync/search/CRUD never reaches account B's notes | SRV | `isolation.acceptance.test.ts` (exists, 10/10) — REFERENCE, do not duplicate | all 8 cross-account rows green | D6 fix (303db9a/dd86704) |
| DG-5d | All on clean deltos-native code (reuse-discipline) | — | code review | no trkr/full-beans/Evolu vestiges past `KeyDerivation` | Reuse-discipline gate |

### Capstone — the done-sentence on a real device

| ID | Criterion | Tier | Proof | Pass condition | Spec ref |
|----|-----------|------|-------|----------------|----------|
| DG-CAP | One end-to-end run: install PWA (Tailscale HTTPS, hostname RP ID) → unlock → create/edit a note offline → reconnect → sync → recover on a 2nd device → the note is PRESENT and its content matches | DEV | on-device manual + **DGT-5** (note-present capstone, server slice) | the done-sentence is literally true once on a real installed PWA; the [SRV] half (enroll→create→sync→2nd-device→pull→present+match) is automated in `v1.donegate.test.ts` | Stream D done-gate (line 193) |

---

## Out of gate (Phase-1 out-of-scope — explicitly NOT required for v1 done)

Second surface; notebooks-as-feature beyond the scoping column; universal search; plugin
registry; blob-store build (reference-by-hash only); E2EE; collaboration build (seam designed
only); Markdown export; history/trash; cross-notebook move (PIN-SYNC-5 ghost gap stated, not
handled). Source: `phase-1-vertical-slice.md` §Out of scope.

## [CLI] proof method (scopeSys-owned definition)

[SRV] is gruntSys's automated worker harness. The **[CLI] half has no server-runnable proof** — it
lives in the browser/PWA — so it is proven in **two tiers**, both required for the gate:

> **Scope limit the two tiers must respect (learned from the exploratory dogfood):** the automated gates
> ([SRV] `v1.donegate.test.ts` + Tier-A `[CLI-auto]`) drive the **store programmatically**
> (`mutateNotes.put` and everything downstream of it) — they prove the **data / sync / auth** journey
> but **structurally bypass the editor→store wiring**: the seam where the UI actually writes what the
> user typed into the store. The exploratory dogfood caught the suites staying green while the
> **editor silently didn't persist** — store/sync/auth all correct, but typed notes never reached the
> store, so nothing listed, synced, or recovered. A suite that calls the engine directly **never proves
> the UI reaches the engine.** Automated green ≠ usable. This is the sharpest case of why the on-device
> **Tier B** capstone exists (it caught exactly this — finding E1 in `v1-dg-cap-gate-record.md`).
>
> **Gap-narrowing (post-dogfood) — now closed to the sensible limit:** gruntSys2's durable coverage
> landed in two steps — first the store→list reactive layer (`@86afece`), then the **editor→store data
> path** (`@3d26228`, 9 navList tests, suite 145/145): the 3 PM-pipeline tests assert text-insert →
> `docChanged` → title-extract → `onSave` → `mutateNotes.put` → list emission. So the seam that
> actually broke is now **headless-covered**. The **only** link still outside the suite is ProseMirror's
> own `EditorView → dispatchTransaction` (PM-internal, correctly trusted as a dependency — not our
> code), which the on-device dogfood exercises. Net: the editor→store wiring is covered to the sensible
> limit; the residual dogfood-only bit is third-party-internal, not a coverage hole in our code. Lesson
> stands — a test that calls `put` directly never proves the editor calls `put`, so we now test the
> editor calling `put`.

### Tier A — `[CLI-auto]`: headless client test suite (the regression floor)

Runnable in CI without a device. Lives in the client package (Vitest + jsdom; `fake-indexeddb` for
storage; the ProseMirror test harness for the editor). Each maps 1:1 to a [CLI] criterion:

| Criterion | `[CLI-auto]` proof | Asserts |
|-----------|--------------------|---------|
| DG-1b | `enrollNew()` vs `enrollExisting()` unit test | fresh-account intent required; recovery routes through `enrollExisting(mnemonic)` — no silent orphan |
| DG-2b | offline-persistence test over `fake-indexeddb` | create+edit with no network → reload → note+edits restored from IndexedDB |
| DG-2d | block-id plugin test | every block keeps a stable unique `attrs.id` through copy/paste/split/merge |
| DG-3d | syncEngine test | push/pull carry `Authorization: Bearer <token>`; token never written to storage (F7 in-memory, [[session-token-in-memory-only]]) |
| DG-3e | sync-indicator state-model test | pending / syncing / offline / error transitions |

### Tier B — `[CLI-device]`: on-device dogfood (the things only a real PWA can prove)

Capabilities a headless suite **cannot** exercise — they require a real installed PWA over Tailscale
HTTPS with a hostname RP ID (PIN-ID-9) and a real platform authenticator. Run as a scripted manual
pass on the **iPhone dogfood that planSys coordinates**, and they constitute the **DG-CAP capstone**:

| Criterion | `[CLI-device]` step (on the real PWA) |
|-----------|---------------------------------------|
| (install) | Add-to-Home-Screen installs; launches standalone; service worker serves the shell offline |
| DG-1c | passkey/PIN unlock decrypts the Identity blob via WebAuthn UV (no PRF dependency); honest no-PRF disclosure shown ([[keystore-noprf-ui-disclosure]]) |
| DG-1d | 24-word recovery phrase shown once at enroll behind fresh-account intent |
| DG-2a | capture: `/new` → type into a client-UUID note; first heading is the title (single PM doc) |
| (true offline) | airplane-mode create/edit persists, then syncs on reconnect (real IndexedDB + SW, not `fake-indexeddb`) |
| DG-4b | QR-join a 2nd device is blocked without the out-of-band confirmation code; UI states the in-person model |

A `[CLI-device]` checklist is a numbered runbook (one tap-path per row) executed once and recorded
(pass/fail + build SHA + device/iOS version) in the gate record.

### Owners (RESOLVED — pilot, 2026-06-16)

- **Tier A `[CLI-auto]`** — owner: **devSys2** (coordinating with gruntSys2 for enroll/storage). It is
  the client-side sibling of `v1.donegate.test.ts` and must be green in CI before the gate closes.
  Covers DG-1b / 2b / 2d / 3d / 3e. **Status: ✅ 13/13 GREEN — COMPLETE.** Worker-pkg
  `v1.donegate.client.test.ts` 12/13 (`708d476`→`2e421cb`) + client-pkg
  `packages/client/test/blockId.donegate.test.ts` 3 green for DG-2d (`aa9e40c`). The automatable
  [CLI] half of v1-done is closed.
  - **Tier-A spans two packages (scopeSys [CLI]-method ruling, pilot-ratified):** the split is **by
    what each row exercises.** App-coupled + identity/persistence rows (DG-1b/2b/3d/3e + the sync-bridge
    rows DG-3a/2c/5c-echo) live in the **worker** test pkg; the lone **pure-editor** row **DG-2d** lives
    in **`packages/client/test/`**.
  - **Host package — worker pkg (scopeSys ruling — wiring LIVE @b98bf3d):** the worker test package, with
    `@deltos/client` added as a test-only devDep + `fake-indexeddb`. Safe — `client` and `worker` both depend only on
    `@deltos/shared`, neither on the other, so the worker→client devDep is no prod cycle; and it
    co-locates the app-coupled [CLI] suite with `v1.donegate.test.ts` (one harness, one package).
  - **DG-2d → client pkg (scopeSys ruling, pilot-ratified):** DG-2d is a pure-editor test (block-id
    stability through copy/paste/split/merge over the PM harness + the EXISTING `uniqueBlockIdPlugin`,
    test-only, no plugin change) and needs **no worker app**. `prosemirror-state`/`prosemirror-model`
    are pnpm-isolated to `client` and do **not** resolve from the worker pkg (`ERR_MODULE_NOT_FOUND`);
    adding the PM stack as worker devDeps would put editor deps in the backend test pkg (smell) + force
    another shared-tree install. So it hosts client-side with clean `../src/...` imports.
    **Writer = devSys2** (owns the Tier-A suite + the criterion + offered). ✅ **LANDED `aa9e40c`** —
    `packages/client/test/blockId.donegate.test.ts`, 3 green (mints fresh ids for null-id blocks,
    re-mints duplicate ids preserving the prior owner, leaves unique ids stable), test-only, no plugin
    change → **Tier-A 13/13**.
  - **The sync subset** (DG-3a round-trip / DG-3d auth header + token-never-persisted / DG-2c offline
    reconcile / DG-5c client-side isolation echo) is proven by driving the **real** client
    `syncEngine` against the **real** worker Hono app via a `global.fetch → app.request` bridge over
    better-sqlite3 + migrations 0000-0003, bearer from a real enroll (`dgRegister`+`dgSession`).
    `fake-indexeddb` proves the queue/store/restore **logic** only — true persistence-across-reload
    is Tier B. The DG-5c client echo does **not** replace the canonical `isolation.acceptance.test.ts`
    (10/10), which stays server-authoritative.
  - **pnpm-lock:** devSys2 runs the single `pnpm install`, announces it on coord first (shared tree),
    and commits `packages/worker/package.json` + `pnpm-lock.yaml` by explicit path.
- **Tier B `[CLI-device]` + DG-CAP capstone** — owner: **planSys's iPhone dogfood** (the one
  end-to-end on-device run, scheduled with the user). scopeSys supplies the numbered runbook (below);
  the run is executed once at gate time and its result recorded. Until both tiers pass, [CLI]
  criteria are gated as **not yet proven**.

### Tier B `[CLI-device]` runbook (for planSys's iPhone dogfood)

One scripted pass on a real installed PWA over Tailscale HTTPS (hostname RP ID per PIN-ID-9). Record
pass/fail + build SHA + device/iOS version per step in the **gate-record capture template**
(`v1-dg-cap-gate-record.md`, scopeSys scaffold — one fillable block per attempt). This run **is** the
DG-CAP capstone.

> **Gate fidelity (canon — planSys):** the RECORDED capstone MUST run against a **prod-representative
> build** — prod-mode worker (`ENVIRONMENT=production`, F13 ACTIVE, no unverified `LOCAL_OWNER`
> fallback) + prod client build, all 8 steps on ONE coherent build. A dev build **false-passes** the
> auth / F13-gating / QR-join-blocked legs (permissive auth) and must NOT be used for the record. The
> refreshed **dev** build is ONLY for the early, non-recorded iOS-WebAuthn-UX smoke.

1. **Install / A2HS** — open the Tailscale HTTPS URL in Safari → Add to Home Screen → launch
   standalone; the service-worker shell loads. *(install criterion)*
2. **Enroll** — fresh-account intent → signing key registered in the Secure Enclave; the 24-word
   recovery phrase is shown **once** behind that intent. *(DG-1d)*
3. **Unlock** — lock, reopen → passkey/PIN unlock via WebAuthn UV (FaceID); the Identity blob
   decrypts; the honest no-PRF disclosure is shown (or PRF used on iOS-18). *(DG-1c, [[keystore-noprf-ui-disclosure]])*
4. **Capture** — `/new` → type a note; the first heading becomes the title (single PM doc, no
   separate title field). *(DG-2a)*
5. **True offline** — airplane mode → create + edit another note → relaunch the PWA → both notes and
   their edits survive (real IndexedDB across reload/PWA-reinstall). *(DG-2b on-device half)*
6. **Reconnect & sync** — leave airplane mode → sync fires on the network transition → the indicator
   reflects syncing→idle; notes reach the server. *(DG-3e on-device, real network)*
7. **QR-join a 2nd device** — attempt join; it is **blocked** without the out-of-band confirmation
   code; the UI states the in-person threat model. *(DG-4b)*
8. **Recover / capstone** — on the 2nd device, recover via the 24-word phrase → same `accountId` →
   pull → the note from step 4/5 is **PRESENT and its content matches**. *(DG-CAP)*

## Coordination

- **Pairs with** gruntSys's `packages/worker/test/v1.donegate.test.ts` (the [SRV] RED target). The
  [SRV] scenario map is now **locked** (see "Locked [SRV] scenario map" above): DGT-1..DGT-5, with
  conflict / isolation / revoke referenced from their existing suites, not duplicated.
- **[SRV] gate state**: DGT-1/3/4 green; DGT-2 (same-key 2nd-device recovery) is RED with devSys
  fixing, and DGT-5 (capstone server slice) auto-greens once DGT-2 lands.
- **[CLI] proof** is now defined above (Tier A headless suite + Tier B on-device dogfood). Open
  handoffs: pilot to name the Tier-A client-suite session; planSys to schedule the Tier-B dogfood.
