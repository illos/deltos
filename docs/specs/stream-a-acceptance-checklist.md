# Stream A (Identity) — consolidated build-ready acceptance checklist

> **Historical — v1 shipped 2026-06-24. This checklist was satisfied on ship; preserved as build record.**

**Status:** REFERENCE — derived, not a new decision · **Author:** secSys (consolidation task, pilot-assigned) ·
**Date:** 2026-06-16

Single flat checkable list of every Stream A *must*, each tagged with its authoritative spec ID.
This is the shared reference for the **gruntSys acceptance harness** and the **secSys audit**.

**Sources (read-only inputs):**
- `docs/specs/phase-1-vertical-slice.md` §Stream A — Acceptance + Hard requirements.
- `docs/specs/phase-1-constraints.md` — PIN-ID-1..9, sizing, E2EE seam.
- `docs/design/stream-a-auth-strawman.md` Rev 0/1/2 — the LOCKED construction (routes, TLV, F-findings).
- `docs/design/stream-a-auth-secSys-review.md` — F-finding rulings + lock checklist.
- Locked contract: `packages/shared/src/api/grant.ts` (`PrincipalVerificationSchema`, `OpSchema`,
  `ResourceSchema`); chokepoint: `packages/worker/src/auth.ts` (`can()`).

> **Naming note (read before using):** **AUTH-PROP-1..4** are an adopted, non-canon team handle for
> the **four core auth security properties** the signed-challenge construction must satisfy (the
> construction itself is captured as **F1..F13** + **PIN-ID-1..9**). planSys's original **AUTH-1..4**
> named four specific **build-MUSTs**, not the properties; per planSys's canon ruling those are
> **nested as named build-CHECKS under the property they serve** (mapping below), keeping the clean
> property handle while preserving the four implementation musts:
> AUTH-4 → PROP-1, AUTH-1 → PROP-2, AUTH-2 → PROP-3, AUTH-3 → PROP-4.

---

## §A — Core auth security properties (AUTH-PROP-1..4 — synthesis labels; real source tagged)

- [ ] **AUTH-PROP-1 — replay resistance.** A captured `/api/auth/session` (or step-up/register)
  signature cannot be reused: enforced by a random 32-byte `nonce` **+** atomic single-use challenge
  consume (rows-affected = 1; replay loses the race → 0 → reject). [strawman §3.2, §3 payload; PIN-ID-2;
  secSys Part C]
  - [ ] **AUTH-4 (build-check) — token/nonce entropy ≥ 32 bytes.** The challenge `nonce` and the
    minted opaque grant token are each ≥ 32 bytes of CSPRNG output. [planSys AUTH-1..4; strawman §3.2/§3.5]
- [ ] **AUTH-PROP-2 — challenge freshness.** Challenges carry a short TTL (~60s), are stored
  server-side UNCONSUMED, and expiry is checked against stored `expiresAt` vs server-now. [strawman §3.2;
  secSys F11]
  - [ ] **AUTH-1 (build-check) — ISO-8601 timestamp-freshness correctness.** Expiry compares
    **parsed instants** (`Date.parse` / epoch-ms), **NOT** a lexical/string comparison of the
    ISO-8601 `expiresAt` vs server-now. (PIN-SUBSTRATE-1 stores timestamps as ISO-8601 strings; they
    are lexically sortable only when same-zone/precision — freshness must not assume that.) [planSys
    AUTH-1..4; constraints PIN-SUBSTRATE-1]
    - [ ] **AUTH-1 storage-layer corollary [secSys].** The rule applies at the **SQL/storage layer
      too**: `auth_challenges.expiresAt` must be stored as an **epoch-int** (or strictly-normalized
      UTC-`Z` form) so the atomic-consume predicate `WHERE consumed = 0 AND expiresAt > :now`
      compares **instants, not lexical strings**. A raw mixed-zone/precision ISO string in that
      column would make the freshness gate lexical and unsound. [secSys; ties AUTH-PROP-1 consume +
      AUTH-PROP-2 freshness]
- [ ] **AUTH-PROP-3 — pubkey↔account binding (no confused deputy).** Server resolves
  `signingPublicKey` for `keyId` **server-side** (never from the request body); `keyId` is inside the
  signed TLV. A signature made with the attacker's own key for a victim's `keyId` fails verification.
  [strawman §3.3–3.4, §3 binding; PIN-ID-2]
  - [ ] **AUTH-2 (build-check) — server-COMPUTED accountFingerprint (= F2 canon).** At registration
    the server **computes** `accountFingerprint = base64url(SHA-256(signingPublicKey))` from the
    submitted pubkey and never trusts a client-supplied fingerprint; a client-sent value must equal
    the computed one or the request is rejected. [planSys AUTH-1..4 = secSys **F2**; strawman Rev1/Rev2]
- [ ] **AUTH-PROP-4 — intent / scope / audience binding.** The signed TLV binds `purpose`
  (`session`/`step-up`/`register`), `audience` (deployment origin / RP-ID), and the operation's
  fields (`requestedScope` for session; `op`+`resource` for step-up) so a signature cannot be
  repurposed across operations or deployments. [strawman §3 payload, F4, F8, Rev2 item-1; secSys F4/F8]
  - [ ] **AUTH-3 (build-check) — per-endpoint constant `purpose`.** Each endpoint reconstructs the
    TLV with a **fixed, hardcoded `purpose` constant** (`session` / `step-up` / `register`) — never a
    client-supplied purpose — so a signature minted for one endpoint cannot satisfy another. [planSys
    AUTH-1..4; strawman §3 payload, Rev2 reconstruct-and-verify rule]

---

## §B — PIN-ID-1..9 (the pinned hard requirements)

- [ ] **PIN-ID-1 — `id` is an identifier, NEVER an authenticator.** No endpoint authorizes any
  read/write on `Identity.id` alone; every mutating request carries cryptographic proof of account
  possession (the opaque grant token, not `id`). [constraints PIN-ID-1; slice §Stream A]
- [ ] **PIN-ID-2 — signed-challenge → opaque grant token.** Account signing keypair derived as a
  SLIP-21 **sibling** of the root seed; pubkey registered server-side; device signs a server
  challenge → server mints the opaque grant token. Signing keypair is a Phase-1 requirement (also
  authorizes QR-joined enroll). [constraints PIN-ID-2]
- [ ] **PIN-ID-3 — `id` deterministic + stable across devices.** `Identity.id` =
  `base64url(SHA-256(signing public key))`, a deterministic SLIP-21-rooted derivation; same recovery
  phrase → same `id` on every joined device. [constraints PIN-ID-3; strawman §1]
- [ ] **PIN-ID-4 — distinct roles: passkey gates LOCAL UNLOCK; signing key authenticates to SERVER.**
  WebAuthn/passkey assertion unlocks the at-rest encrypted Identity blob on-device; the signing key
  proves identity to the server. The server never sees a passkey assertion for request auth.
  [constraints PIN-ID-4; strawman §0]
- [ ] **PIN-ID-5 — per-device revocation is grant-based.** A device is revoked by revoking its opaque
  token / registry row, without rotating the whole account; account-level signing key acceptable for
  v1. [constraints PIN-ID-5]
  - [ ] **PIN-ID-5/F1 limitation stated honestly in UI:** "revoke device" = revoke cached grant +
    registry handle (immediate), **NOT** cryptographic lockout — a mnemonic holder can `enrollExisting`
    and re-mint; recovery from a compromised mnemonic is account re-key. [strawman Rev1 F1; DECISIONS D5]
- [ ] **PIN-ID-6 — PRF is an enhancement, not a dependency.** Baseline = UV-only + encrypted-IndexedDB
  blob; PRF used only where available, never required. Conservative floor **iOS 18**; confirm matrix,
  don't hard-depend. [constraints PIN-ID-6]
- [ ] **PIN-ID-7 — QR join requires an out-of-band confirmation code.** Receiving device displays a
  confirmation code the sender verifies before trust; UI states the in-person-only threat model. QR
  join runs `enrollExisting(mnemonic)`. [constraints PIN-ID-7; strawman §7]
- [ ] **PIN-ID-8 — enroll guard.** `enrollNew()` gated behind explicit "fresh account" intent;
  recovery goes through `enrollExisting(mnemonic)`; never silently orphan existing data. [constraints
  PIN-ID-8; strawman §2]
- [ ] **PIN-ID-9 — iOS WebAuthn rules.** (a) WebAuthn call is the **first `await`** in any gesture
  flow; (b) **RP ID = hostname** (served by hostname over Tailscale HTTPS / domain, never IP); (c)
  passkey RP ID **matches across Safari ↔ installed PWA** (test explicitly). [constraints PIN-ID-9;
  strawman §6]
- [ ] **KDF accuracy note.** Implementer must NOT claim "no KDF hardening": BIP39 mnemonic→seed **is**
  PBKDF2-HMAC-SHA512 ×2048; SLIP-21 derives from that seed. [constraints NIT-a]
- [ ] **E2EE seam open.** Keys derived as SLIP-21 **siblings** (`atRestKey`, `accountSigning`,
  `encryptionKey` reserved) — never collapse the hierarchy; Phase-2 encryption drops in without rework.
  [slice §Stream A; constraints E2EE option-b; strawman §1]

---

## §C — F13: tripwire env-allowlist (fail-CLOSED)

- [ ] **F13 — `unverified` allowed ONLY when `ENVIRONMENT` ∈ exact-match `{development, test, local}`.**
  No substring/prefix matching; unset or unrecognized ⇒ **refuse** (fail-closed). A misconfigured
  deploy denies rather than serves the stub. [strawman §5, Rev1 F13; secSys F13]
- [ ] **`method` is server-set, never client-selectable.** Auth middleware sets `verification.method`
  from what it actually verified; a client cannot select `unverified`. [strawman §4; grant.ts;
  secSys Part C]
- [ ] **`can()` is exhaustive + default-DENY.** Per-method `switch` ends in `assertNever(method)`
  (compile-time) **and** a runtime default-deny branch. [strawman F10; worker/src/auth.ts]

---

## §D — Auth route list (the endpoints to build)

- [ ] **`POST /api/auth/register`** — `RegisterDeviceRequest { signingPublicKey, deviceLabel,
  deviceAuthorization }`. Server **computes** `accountFingerprint = base64url(SHA-256(signingPublicKey))`
  (never trusts a client-sent one; rejects on mismatch — **F2**); verifies `deviceAuthorization` (a
  signature by the submitted pubkey's key over the register-TLV) against a fresh consumed challenge
  (**Rev2 item-2**). [strawman Rev1/Rev2; secSys F2]
- [ ] **`POST /api/auth/challenge`** — `ChallengeRequest { keyId }` → `{ challengeId, nonce, expiresAt }`.
  Mints a random `challengeId` + 32-byte `nonce`, short TTL, stored UNCONSUMED in `auth_challenges`.
  (Also issues `purpose='register'` challenges for registration.) [strawman §3.1, Rev2]
- [ ] **`POST /api/auth/session`** — `SessionRequest { challengeId, keyId, signature, requestedScope }`
  → `{ token, expiresAt }`. Loads challenge; rejects if missing/expired/consumed/keyId-mismatch;
  **atomically consumes**; resolves pubkey server-side; verifies signature over the session-TLV; clamps
  `granted = intersection(requestedScope, entitlement)` (**F5**); mints opaque grant token (stored
  **hashed**, **F6**). [strawman §3, F5, F6]
- [ ] **Device management — list / revoke devices** (the "devices" route). Lists registered devices
  for the account; revoke = revoke the device's grant/registry row (PIN-ID-5). Device add/revoke is in
  the **F9 sensitive-op set** → requires `signed-request` step-up. [slice §Stream A acceptance; strawman F9]
- [ ] **Step-up proof for sensitive ops (F9).** `StepUpRequest { challengeId, keyId, op, resource,
  signature }` over the step-up-TLV. Enumerated sensitive set: **device add/revoke, change recovery
  phrase, delete account, export-all / bulk-read, create or widen a share/capability grant.** Normal
  CRUD uses the bearer grant-token. [strawman F9, Rev2 item-1]

---

## §E — D1 table list

- [ ] **`devices` (DeviceRegistry).** Rows: `keyId`, `signingPublicKey` (registered pubkey),
  `deviceSigningPublicKey` column present from day one (v1 stores the account pubkey — option-(b) seam),
  `accountFingerprint` (= `Identity.id`), `deviceLabel`. Public key registered; private key never
  leaves the device. [strawman §2, Rev1 F1 seam; constraints sizing]
- [ ] **`auth_challenges`.** Server-stored challenges: `challengeId`, `nonce`, `keyId`, `issuedAt`,
  `expiresAt`, `consumed` flag. Single-use enforced by the atomic consume (rows-affected = 1). [strawman §3]
- [ ] **`grants` (grants registry).** Opaque grant tokens stored **hashed** (`SHA-256(token)`, no salt)
  with `{ principal {kind,id}, resource, scope, expiresAt }`. Lookup hashes the presented token;
  revoke the row = immediate deny (instant revocation, PIN-ID-5). [strawman §3.5, F6; secSys Part C]

---

## §F — Acceptance semantics: authorized / rejected / revoked

- [ ] **AUTHORIZED.** A request bearing a valid, unrevoked, unexpired grant token whose resolved
  `principal` + clamped `scope` satisfy `can(principal, op, resource)` is permitted. The opaque token
  (not `id`) is the proof; `method` is server-verified. [slice §Stream A acceptance; PIN-ID-1/2; grant.ts]
- [ ] **REJECTED.** Any of the following denies, fail-closed:
  - [ ] request authorizing on `id` alone, or carrying no cryptographic proof (PIN-ID-1);
  - [ ] session/step-up/register signature failing TLV reconstruct-and-verify against the
    server-resolved pubkey (wrong key, tampered field, wrong audience/purpose) (strawman Rev2);
  - [ ] replayed signature (challenge already consumed → rows-affected 0) or expired challenge
    (AUTH-PROP-1/2);
  - [ ] step-up signed for `(opP, resourceP)` presented on a request for `(opQ, resourceQ)` —
    structurally rejected at the chokepoint (strawman Rev2 item-1);
  - [ ] registration where computed fingerprint ≠ client-sent fingerprint (F2);
  - [ ] `unverified` method outside the exact env-allowlist (F13);
  - [ ] any unrecognized/unimplemented `method` (default-DENY, F10).
- [ ] **REVOKED.** Revoking a device's grant row makes the next request bearing that token deny
  **immediately** (every request resolves the registry row — no token-validity window). Account-level
  key means re-`enrollExisting` with the mnemonic can mint a fresh token; full lockout needs account
  re-key (PIN-ID-5/F1 limitation). [strawman Rev1 F1; secSys Part C]

---

## §G — Reuse-discipline gate (HARD — audited on Stream A)

- [ ] Litmus on every file: would a stranger reading it cold guess it was lifted from
  trkr/full-beans? If yes, not done. **No `AppOwner`/Evolu-isms past `KeyDerivation`**; no cookie-auth
  leftovers. If `@evolu/common` is used, **zero Evolu-isms leak past `KeyDerivation`**; `@noble/ed25519`
  is generic crypto (reuse-clean). [slice §Reuse-discipline; constraints sizing; strawman F12]

---

## §H — End-to-end acceptance (the Stream A done-sentence, slice §Stream A "Acceptance")

- [ ] Enroll new account: passkey + 24-word phrase shown **once**, guarded behind fresh-account intent.
- [ ] Lock / unlock via passkey (local unlock of the at-rest blob).
- [ ] Recover on a **fresh device** via the recovery phrase (`enrollExisting`).
- [ ] **QR-join** a second device **with confirmation code** (out-of-band, in-person threat model).
- [ ] Every authenticated request carries a verifiable signed-challenge grant; **none authorize on
  `id` alone**.
- [ ] Revoke a device by revoking its grant (immediate deny on next request).
