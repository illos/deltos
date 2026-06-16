# V1 done-gate — acceptance checklist (the "simple v1 done" definition)

**Owner:** scopeSys (planSys-assigned). **Status:** DRAFT — 2026-06-16. Pairs 1:1 with gruntSys's
e2e/integration harness `packages/worker/test/v1.donegate.test.ts` — **one shared definition of
done.** Scenario ids below are placeholders (`DGT-*`) pending gruntSys's confirmation of its scenario
list; finalize then.

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

---

## Criteria

### Leg 1 — Enroll / first unlock

| ID | Criterion | Tier | Proof / scenario | Pass condition | Spec ref |
|----|-----------|------|------------------|----------------|----------|
| DG-1a | Enroll a fresh account: register signing key → account minted (stable `accountId`) → session token issued | SRV | `DGT-enroll` (gruntSys) | register → 201 `{keyId,accountFingerprint}`; session → 200 `{token}`; an `accounts` row + `accountCredentials` map exist | PIN-ID-2, PIN-ID-8 |
| DG-1b | Fresh-account intent is guarded; recovery never silently orphans data | SRV/CLI | `enrollNew()` vs `enrollExisting()` | `enrollNew` requires explicit fresh-account intent; recovery routes through `enrollExisting(mnemonic)` | PIN-ID-8 |
| DG-1c | Local unlock via passkey/PIN (WebAuthn UV gates the at-rest blob; signing key authenticates to server — roles distinct) | CLI | client unlock UI test + on-device | unlock decrypts the Identity blob; no PRF dependency (UV-only baseline); honest no-PRF disclosure shown | PIN-ID-4, PIN-ID-6, [[keystore-noprf-ui-disclosure]] |
| DG-1d | 24-word recovery phrase shown once at enroll, guarded | CLI | client enroll UI test | phrase displayed once behind fresh-account intent | PIN-ID-8 |

### Leg 2 — Create / edit a note OFFLINE

| ID | Criterion | Tier | Proof / scenario | Pass condition | Spec ref |
|----|-----------|------|------------------|----------------|----------|
| DG-2a | Capture: `/new` → typing into a client-UUID note immediately; title is the first heading (one PM doc, no separate input) | CLI | client editor test + on-device | stable client UUID at creation; Enter title→body; single drag selects title+body | Stream C acceptance |
| DG-2b | Edits persist optimistically to the local store with NO network; reload restores from local | CLI | client offline-persistence test | create + edit fully offline; reload → note + edits intact (IndexedDB) | Goal, Stream C |
| DG-2c | Offline edits queue; on reconnect the atomic-CAS push accepts and version bumps (SERVER view of the offline path) | SRV | `DGT-offline-reconcile` | queued batched edits push → accepted, version increments; pull sees final state | PIN-SYNC-1 |
| DG-2d | Block IDs stay unique + stable across copy/paste/split/merge | CLI | client block-id plugin test | every block carries a stable unique `attrs.id` through all transforms | Stream C (block-ID plugin) |

### Leg 3 — Authenticated sync round-trip

| ID | Criterion | Tier | Proof / scenario | Pass condition | Spec ref |
|----|-----------|------|------------------|----------------|----------|
| DG-3a | Push then pull with a REAL bearer grant token; the created note returns byte-identical | SRV | `DGT-sync-roundtrip` (gruntSys scenario 1) | push 200; pull returns the note; title/properties/body match what was created | PIN-SYNC-1/2 |
| DG-3b | Every `/api/sync/*` call passes the `can(principal, op, resource)` chokepoint authenticated by the grant token; none authorize on `id` alone | SRV | `DGT-sync-roundtrip` + chokepoint | unauthenticated/`id`-only → denied; valid grant → allowed | PIN-ID-1/2 |
| DG-3c | Production auth gating: the dev-only `unverified` principal is REFUSED outside an explicit non-prod env; real bearer required | SRV | `DGT-prod-gating` (gruntSys scenario 4) | `unverified` + ENVIRONMENT∉{development,test,local} → 503; real bearer → 200 | F13 fail-closed |
| DG-3d | Client sends the in-memory grant token as the `Authorization` header on push/pull (token never persisted at rest) | CLI | client syncEngine test | push/pull carry `Authorization: Bearer <token>`; token F7 in-memory only | [[session-token-in-memory-only]] |
| DG-3e | Sync indicator reflects pending / syncing / offline / error | CLI | client indicator test | state model transitions correctly | Stream B acceptance |

### Leg 4 — Recover / join a second device

| ID | Criterion | Tier | Proof / scenario | Pass condition | Spec ref |
|----|-----------|------|------------------|----------------|----------|
| DG-4a | Recover on a fresh device via the 24-word phrase → SAME `accountId` → the account's notes are visible | SRV | `DGT-2nd-device` (gruntSys scenario 2) | same signing key/seed → same `accountId`; pull returns the prior device's notes | PIN-ID-3, D6 accountId-stability |
| DG-4b | QR-join a second device requires an out-of-band confirmation code (in-person threat model surfaced) | CLI | client QR-join test + on-device | join blocked without the OOB code; UI states in-person-only model | PIN-ID-7 |
| DG-4c | Device revocation is grant-based (revoke the opaque token); revoking one device cannot touch another account's devices | SRV | `DGT-revoke` + existing BOLA test | revoke by keyId idempotent; cross-account revoke → 404 | PIN-ID-5, revoke BOLA fix (9fee9f8) |

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
| DG-CAP | One end-to-end run: install PWA (Tailscale HTTPS, hostname RP ID) → unlock → create/edit a note offline → reconnect → sync → recover on a 2nd device → the note is PRESENT and its content matches | DEV | on-device manual + `DGT-note-present` capstone (server slice of it) | the done-sentence is literally true once on a real installed PWA; the [SRV] half (enroll→create→sync→2nd-device→pull→present+match) is automated in `v1.donegate.test.ts` | Stream D done-gate (line 193) |

---

## Out of gate (Phase-1 out-of-scope — explicitly NOT required for v1 done)

Second surface; notebooks-as-feature beyond the scoping column; universal search; plugin
registry; blob-store build (reference-by-hash only); E2EE; collaboration build (seam designed
only); Markdown export; history/trash; cross-notebook move (PIN-SYNC-5 ghost gap stated, not
handled). Source: `phase-1-vertical-slice.md` §Out of scope.

## Coordination

- **Pairs with** gruntSys's `packages/worker/test/v1.donegate.test.ts` (the [SRV] RED target). Every
  [SRV] criterion above must map to exactly one scenario id there; `DGT-*` placeholders are filled
  when gruntSys confirms its scenario list. gruntSys's proposed scenarios (1 round-trip, 2 2nd-device
  recovery, 3 offline reconcile, 4 prod gating) map to DG-3a/DG-4a/DG-2c/DG-3c; the requested adds
  are the DG-CAP note-present capstone + the DG-5c isolation reference.
- **[CLI] criteria** need a client-side harness owner — flagged to pilot (likely the client lane).
  Until then they are gated as client-verified/on-device, not server-automated.
- **[DEV] capstone** is a one-time on-device run over Tailscale, owner TBD by pilot at gate time.
