# Part 1b — Option-A silent auto-unlock: EXECUTION PLAN (non-committal)

> **Historical — pre-pivot passkey/signed-challenge design, abandoned 2026-06-17, superseded by username+password (see auth-pivot-scope-map.md).**

**Status:** PLAN ONLY — **no code until the user's Option-A "yes" lands** (pilot relay).
**Author:** devSys2 (shell lane). **Date:** 2026-06-16. **Routed for pre-review:** pilot + secSys.
**Spec:** `docs/specs/v1-shell-and-conflict-versions.md` §At-rest custody; builds on Part 1a (shell
decouple, committed `cd61fae`). **secSys ruling basis:** Option-A 6 conditions (see
`cold-reload-rehydration-guard`, `e4-cold-reload-fix`).

**Goal:** make the background re-auth fully silent — an enrolled device cold-starts straight into a
live session with **no gesture, no nudge** — while honoring every secSys custody condition and the
Part-1a launch-path line. This plan exists so that, the moment the yes lands, execution is near-instant.

---

## 0. What "Option-A" means in code

Today (`webAuthnKeyStore.ts`, wrapping policy from `a73752e`) the at-rest blob (`{id, sk, pk}` — the
**device signing key only**, never the mnemonic) is wrapped **PRF-first**:

- **PRF available** → `wrappingKey = HKDF(PRF_output, credId, 'deltos-at-rest-v1')`, **re-derived
  from the passkey on every unlock — never stored at rest**. `IdentityBlobRow.prf = true`, no
  `deviceKey` row.
- **PRF absent** → `wrappingKey = random 32 bytes` stored device-locally in the `deviceKey` IDB
  table. `IdentityBlobRow.prf = false`.

A **silent** unwrap is impossible for a PRF blob: there is no at-rest key to read — recovering it
requires a WebAuthn `get()` to produce the PRF output (a gesture). Option-A therefore converts
wrapping to **device-local-for-ALL devices** (the no-PRF scheme becomes the only scheme for v1),
which secSys ruled acceptable (device-local custody, lock-screen-grade) on 6 conditions.

The crypto stays identical (AES-GCM-256 sealed blob, `blob.ts` untouched). **Only the wrapping-key
custody changes**: PRF-derived-on-demand → random-key-at-rest-in-IDB.

---

## 1. Wrapping conversion + MIGRATION  ⚠️ riskiest — read this first

### 1a. New-enrollment policy (easy half)
`computeWrappingKey()` stops selecting the PRF branch for new enrollments: `enrollNew` /
`enrollExisting` always seal under a fresh device-local random key (`prf = false`, write `deviceKey`
row). The PRF branch is **kept, not deleted** (§4). Cleanest shape: a single policy decision point —
e.g. `computeWrappingKey(prfOutput, credId, { deviceLocalForAll: OPTION_A })` — so v2 E2EE flips it
back in one line.

### 1b. Migration of ALREADY-enrolled PRF devices (the risk)
An existing PRF device has `prf = true` and **no `deviceKey` row**; its blob is sealed under a key
that exists only transiently after a passkey ceremony. Three migration approaches:

| Approach | Mechanism | Verdict |
|---|---|---|
| **(A) Rewrap-on-next-unlock** | Inside `unlock()` (post-plaintext, PRF output in hand + `sk` in memory): if `OPTION_A && blobRow.prf`, generate a fresh device-local random key, **re-seal the SAME payload** under it, `blob.put({prf:false})` + `deviceKey.put(...)`. One gesture — the unlock they were already doing. After it, auto-unlock is silent forever. Idempotent; payload/`id`/`keyId`/relations untouched. | ✅ **RECOMMENDED** |
| (B) Re-enroll via mnemonic | `enrollExisting(mnemonic)` reseals device-local — but needs the mnemonic, **mints a NEW credential + new `keyId`** (server device-row churn), worse UX. | ❌ manual fallback only |
| (C) Forced rewrap at launch | Would require a gesture on the launch path → **violates the Part-1a no-unwrap-on-launch line.** | ❌ reject |

**Decision: (A) rewrap-on-next-unlock.** The migration rides the one unlock gesture a returning
PRF user performs anyway (today's nudge path, until they're migrated). It is a pure re-encryption —
**no change to `sk/pk/id`, `keyId`, `accountId`, notes, or relations** — so it is safe to run on a
device that already has live notes.

**Migration trigger gating:** a single capability flag (`OPTION_A` build/launch constant, on once the
user says yes), **not** a per-user toggle — device-local-for-all is the v1 product default.

### 1d. secSys migration-security conditions (pre-flagged) — design-confirmed

The PRF→device-local conversion is the new security surface; the rewrap is designed to these five:

1. **Bare signing key never hits disk.** The rewrap is **in-memory only**: `unlock()` already holds
   the plaintext payload (`{id,sk,pk}`) in `_state` after `openBlob`; the rewrap re-seals **that
   in-memory payload** under the new device-local key. The **plaintext `sk` is never written** — only
   the AES-GCM-**sealed** blob + the random wrapping key go to IDB. No code path serialises the bare
   private key.
2. **Flip `usedPrf` → false on conversion** so the disclosure is honest: a now-device-local device
   shows the **lock-screen-grade** variant, never "protected by your passkey." `blob.put({prf:false})`
   drives `getEnrollmentPrfStatus` → the disclosure copy switches automatically (§3).
3. **Replace, not append — single source of truth.** The new sealed blob **overwrites** the `'v1'`
   blob row (`put`, same key); the old PRF-wrapped ciphertext does not linger. No second blob row.
4. **One-time conversion, NOT a per-reload prompt.** The single UV gesture needed to unwrap the
   existing PRF blob is the **migration-time gesture only** — the unlock the user is already doing.
   Once `prf=false`, every subsequent launch is silent `autoUnlock` with **no gesture**. There is no
   per-reload prompt; the rewrap is idempotent and runs at most once per device.
5. **F7 + #4 preserved.** No token touched (F7 unchanged). The resealed device-local blob holds
   **`{id,sk,pk}` only — never the mnemonic** (#4 mnemonic-out intact through the re-wrap).

**Atomicity:** the rewrap writes the new sealed `blob` row **and** the `deviceKey` row in a **single
Dexie transaction over `[blob, deviceKey]`**, so a crash can never leave a half-migrated device
(prf-flag-flipped-without-device-key, or device-key-without-resealed-blob). On any failure the old
PRF blob is left intact and the device stays on the gesture-nudge path — fail-safe, never fail-open.

### 1c. Dogfood device specifically  (flag explicitly, per pilot)
**Verify first:** run `getEnrollmentPrfStatus()` on the dogfood iPhone before assuming a path.
- `usesPrf === true` (enrolled PRF-first under `a73752e`) → needs **one** rewrap-on-next-unlock.
  After 1b ships: the user unlocks once (riding the existing nudge gesture) → migrated → silent
  thereafter. **Document this as the dogfood migration step.**
- `usesPrf === false` (PRF was unavailable at enroll) → **already device-local → auto-unlock works
  immediately, no migration.**
- Either way the rewrap never touches the payload, so the dogfood device's existing notes / session
  continuity are unaffected. Worst case during the migration window = today's `needs-unlock` nudge.

---

## 2. `autoUnlock()` + the `establishSession` swap

### 2a. New KeyStore method `autoUnlock(): Promise<Identity | null>`
Silent, **no WebAuthn**:
1. `blobRow = await db.blob.get('v1')`; if absent → `null`.
2. If `blobRow.prf === true` → return `null` (an un-migrated PRF blob can't be auto-unlocked; caller
   falls back to the gesture nudge, which then migrates it via §1b-A).
3. `prf === false` → read `deviceKey`, `recoverWrappingKey`, `openBlob`, load `sk/pk/id` into the
   in-memory `_state`. Return the `Identity`.
- secSys #3: blob stays **AES-GCM sealed** (no bare key); the subsequent mint uses a **fresh
  single-use server challenge** (already true in `mintSession`).

### 2b. Swap at the Part-1a plug-in point
`auth/store.ts` `establishSession()`, the `!keyStore.isUnlocked()` branch (today → `needs-unlock`):
```
const id = await keyStore.autoUnlock();       // background only — NEVER on the render path
if (id) { set({ isUnlocked: true, identity: id }); /* fall through to mint → 'active' */ }
else    { set({ sessionState: 'needs-unlock' }); }   // graceful degrade during migration window
```
- **Launch-path line honored:** `autoUnlock` runs inside `establishSession`, which `init()` fires
  **after first paint and does not await**. The signing key is never unwrapped on the render path.
- Graceful degradation: a not-yet-migrated PRF device keeps the Part-1a nudge until its one rewrap.

---

## 3. Uniform-disclosure wiring (where it shows)

Device-local-for-all ⇒ `usesPrf` is **always false** ⇒ the honest D5 disclosure applies to **every**
establishment path. I wire the **mount points** (copy comes from gruntSys2 → planSys copy-approval):
- **EnrollRoute** — already mounts `<Disclosure prf={usesPrf} />` (universal, `a73752e`). ✅ verify copy.
- **RecoverRoute** — mounts `<Disclosure />` on the no-PRF branch; under Option-A it's always shown. ✅ verify.
- **QrReceiveRoute** — **AUDIT ITEM:** confirm it mounts the disclosure at the join confirmation step.
- **NOT on the launch path / silent re-auth** — Part 1a already keeps disclosure out of boot; auto-unlock
  shows nothing. (secSys: disclosure lives at enroll/recovery, never on background re-auth.)

---

## 4. Keep the PRF seam DORMANT (secSys #6 — do NOT delete)

v2 E2EE wants PRF custody back, so **nothing PRF is removed**, only de-selected:
- KEEP: `PRF_EVAL_INPUT`, `extractPrf`, the `prf` extension in `makeCreateOptions`/`makeGetOptions`,
  and the **PRF branches** of `computeWrappingKey` / `recoverWrappingKey`.
- KEEP: `IdentityBlobRow.prf` flag + `recoverWrappingKey`'s prf-true path (still needed to **read**
  un-migrated blobs during the rewrap, and for v2).
- The single `OPTION_A` policy point (§1a) is the one lever; flipping it re-enables PRF-first for v2.

---

## 5. secSys 6-condition compliance map

| # | Condition | How this plan meets it |
|---|---|---|
| #1 | Universal honest D5 disclosure | §3 — `usesPrf=false` always → disclosure at every establishment path |
| #2 | F7 token never persisted; cold-start RE-MINTS via silent unwrap → signed challenge | autoUnlock → `mintSession` (in-memory token, Part-1a `authStore.test` asserts no localStorage write). **HARD-fail if violated.** |
| #3 | Keep AES-GCM even device-local + fresh single-use challenge | §2a — blob stays sealed; server challenge is per-mint |
| #4 | Blast radius = device signing key only, NOT mnemonic | blob payload `{id,sk,pk}`; mnemonic in-memory-once at enroll, never at rest (verified) |
| #5 | Optional power-user passphrase (wrapKey = KDF(passphrase)) | **future opt-in, not v1** — §1a policy point leaves room; not built |
| #6 | Re-examine for v2 / E2EE; keep PRF | §4 — PRF seam kept dormant |

**#4 v1 carry-forward (not a blocker):** `sk` is mnemonic-derived, so an at-rest read of the
device-local-wrapped blob ≈ persistent auth compromise until recovery/re-key. Intent still met
(attacker gets the signing credential, not the SLIP-21 root; per-device revoke cuts it server-side).
The per-device-key model is the forward custody improvement — flag when that chunk comes.

---

## 6. Test plan (TDD when execution opens)

- **autoUnlock unit** (keyStore.test.ts): prf=false → unwraps silently, no backend.get call;
  prf=true → returns null (no silent unwrap of a PRF blob); not-enrolled → null.
- **Migration** (covers secSys §1d): enroll prf=true → unlock() once with OPTION_A → blob flips
  prf=false (§1d-2), `deviceKey` row appears, **single blob row — old PRF ciphertext gone** (§1d-3,
  assert `blob` count == 1 and `ct` changed), **payload byte-identical** (same `id/sk/pk`),
  `serverHandle`/`keyId` untouched; second unlock is now auto-unlockable with **no backend call**
  (§1d-4 one-time); **idempotent** (rewrap twice = no-op); **atomic** (simulated mid-rewrap failure
  leaves the original PRF blob fully intact + no `deviceKey` row — fail-safe). Negative: assert no
  test ever observes the bare `sk` written outside the sealed blob (§1d-1).
- **establishSession swap** (authStore.test.ts): key-not-in-mem + auto-unlock succeeds → `active`
  with no gesture; auto-unlock returns null → `needs-unlock` (degradation path).
- **F7 regression**: re-run Part-1a token-in-memory assertions through the silent path.
- **Disclosure**: `usesPrf=false` renders the disclosure at enroll/recover/QR (component-level).
- **PRF dormancy**: existing PRF keyStore tests stay green (seam intact).

---

## 7. Execution sequence (near-instant on the relay)

1. `OPTION_A` policy point + device-local-for-all in `computeWrappingKey` (§1a).
2. Rewrap-on-next-unlock migration inside `unlock()` (§1b-A) + tests.
3. `autoUnlock()` method (§2a) + tests.
4. `establishSession` swap (§2b) + authStore tests.
5. Disclosure mount audit at QR-join (§3).
6. Verify dogfood device prf flag (§1c) → document its one-time unlock.

**Open questions — RESOLVED by pilot rulings (CONTINGENT on secSys security pre-review + the user
Option-A "yes"; NO code until BOTH land):**
- (a) **CONFIRMED: rewrap-on-next-unlock (A)** over re-enroll (B). A is the only option consistent
  with the user's model (the only logout is clearing browsing data); B mints a new `keyId` and reads
  as a surprise logout. Pure re-encryption riding the existing gesture is right.
- (b) **CONFIRMED: `OPTION_A` is a BUILD/LAUNCH CONSTANT, not a persisted setting** — for v1 it is a
  permanent posture, no user-configurable custody surface; the PRF seam stays dormant behind the
  constant for v2.
- (c) **CONFIRMED: ride-the-next-unlock, NO forced migration** — a forced path near the launch
  gesture would violate the launch-path-no-unwrap line + secSys's one-time-gesture-not-per-reload
  condition.

**Final go = (1) secSys security pre-review of this plan + (2) planSys relaying the user's Option-A
yes. Both pending — execution-ready, on HOLD until then.**
