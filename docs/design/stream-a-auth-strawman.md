# Stream A — auth construction strawman (for secSys early read)

**Author:** devSys · **Status:** STRAWMAN — not locked, awaiting secSys pressure-test before
anything enters `@deltos/shared` · **Refs:** `phase-1-vertical-slice.md` §Stream A,
`phase-1-constraints.md` PIN-ID-1..9, S1 findings, secSys's `stream-a-readiness` audit angle.

Purpose: give secSys a concrete target to attack (replay / challenge-freshness / pubkey-account
binding / intent binding / downgrade) **before** I lock the discriminated-union
`PrincipalVerification` + build `can()`'s per-method switch. Nothing here is committed to the
frozen contract yet.

---

## 0. Correction surfaced while drafting (needs secSys ruling)

My P0-era strawman listed **`passkey`** and **`signed-request`** as request-auth verification
methods. Re-reading **PIN-ID-4** (passkey gates *local unlock*; the *signing key* authenticates to
the server) I believe that was wrong: **the server never sees a passkey assertion for request
auth.** The passkey unlocks the at-rest Identity blob on-device; the SLIP-21 **signing key** then
proves account possession to the server. So the corrected server-side model is:

- **Session establishment** (mint): device signs a server challenge with the signing key → server
  mints an **opaque grant token** (PIN-ID-2).
- **Steady-state requests**: carry the **opaque grant token**, not `id`, not a passkey.

→ The `PrincipalVerification` union members are therefore about *how a request proved identity to
the server*: **`grant-token`**, **`capability`**, **`unverified`** (dev-only). The signed-challenge
is the **input to the mint endpoint**, validated there — not a per-request `can()` method. **Does
secSys agree, or do we also want a per-request `signed-request` method for high-value ops?** (PIN-ID-2
recommends the token model: "device caches a long-lived grant; only sync re-validates.")

---

## 1. Key hierarchy (SLIP-21 siblings of the root seed)

```
24-word BIP39 mnemonic
  └─ seed = PBKDF2-HMAC-SHA512(mnemonic, "mnemonic", 2048)      [BIP39 — real KDF hardening]
       └─ SLIP-21 master node = HMAC-SHA512("Symmetric key seed", seed)
            ├─ atRestKey      = SLIP-21(["deltos","at-rest-key","v1"])   → local blob wrap
            ├─ accountSigning = SLIP-21(["deltos","account-signing","v1"]) → Ed25519 keypair
            └─ encryptionKey  = SLIP-21(["deltos","enc-key","v1"])       → Phase-2 (reserved)
```

- **Siblings, never children** (domain separation per S1 §4 / PIN-ID-2). Collapsing any two
  re-opens the full-beans domain-separation finding.
- **Signing keypair = Ed25519** (proposed): the private key IS the 32-byte sibling output — clean
  deterministic derivation, no rejection sampling; WebCrypto Ed25519 is available on the iOS-18
  floor (PIN-ID-6) and in Workers. *secSys: Ed25519 vs P-256 ECDSA — preference? P-256 is broader
  but needs scalar-in-range handling for deterministic derivation.*
- **`Identity.id` = base64url(SHA-256(signing public key))** (PIN-ID-3) — deterministic, stable
  across every device that derives from the same mnemonic. It is a *pseudonymous identifier only*
  (PIN-ID-1) — it authorizes nothing on its own.

`Identity` (what the app touches): `{ id, mnemonic (in-memory while unlocked only) }`;
`encryptionKey` reserved for Phase 2. `KeyStore` interface = `enrollNew / enrollExisting / unlock /
lock / isEnrolled` (S1 §3, rewritten deltos-native).

## 2. Enrollment / device registration

- `enrollNew()` (guarded behind explicit fresh-account intent — PIN-ID-8): generate mnemonic →
  derive hierarchy → register `{ keyId, signingPublicKey, accountFingerprint, deviceLabel }` in the
  D1 **DeviceRegistry**. `keyId` = a server-assigned handle for this device's signing pubkey.
- `enrollExisting(mnemonic)` (recovery / QR join): re-derive the same hierarchy → register a **new
  device row** under the same `accountFingerprint` (= `Identity.id`). Never silently orphan
  existing data (PIN-ID-8).
- The **public key** is registered; the private key never leaves the device.

## 3. Session establishment — signed challenge → opaque grant token

Two endpoints (deltos-native, unauthenticated-until-proven):

**`POST /api/auth/challenge`** — request `{ keyId }`. Server:
1. resolves the registered `signingPublicKey` for `keyId` (server-side, from DeviceRegistry).
2. mints `challenge = { challengeId (random), nonce (32 random bytes), keyId, issuedAt, expiresAt }`
   with a **short TTL (~60s)**; stores it server-side **UNCONSUMED** (D1 `auth_challenges`).
3. returns `{ challengeId, nonce, expiresAt }`.

**`POST /api/auth/session`** — request `{ challengeId, keyId, signature }`. Server:
1. load challenge by `challengeId`; reject if **missing / expired / consumed / keyId-mismatch**.
2. **CONSUME atomically** — `DELETE FROM auth_challenges WHERE challengeId=? AND consumed=0`
   (or CAS `UPDATE … SET consumed=1 WHERE consumed=0`); proceed only if **rows-affected = 1**
   (single-use; a replay loses the race and gets 0 → reject). *(Same CAS discipline as PIN-SYNC-1.)*
3. resolve `signingPublicKey` for `keyId` **server-side** (never from the request body).
4. verify `signature` over the **canonical signed payload** (below) using that pubkey.
5. on success → mint an **opaque grant token** (random 32B, stored in the **grants registry** with
   `{ principal: {kind:'device', id: keyId} / {kind:'owner', id: accountFingerprint}, resource,
   scope, expiresAt }`); return `{ token, expiresAt }`.

**Canonical signed payload** (binds intent + prevents replay/cross-use):
```
deltos-auth-v1 || purpose="session" || challengeId || nonce || keyId || requestedScope
```
- `nonce` + single-use consume → **replay resistance**; short TTL + server store → **freshness**.
- `keyId` in the payload + server-side pubkey resolution → **pubkey↔account binding** (an attacker
  signing with their own key for someone else's `keyId` fails verification — no confused deputy).
- `purpose` + `requestedScope` in the payload → a session-mint signature **cannot be repurposed**
  to mint a broader grant or to satisfy a different operation. *secSys: is binding scope at mint
  sufficient, or do you want per-request intent (op+resource) signing for sensitive ops?*

## 4. Steady-state request auth + the discriminated union

Requests carry the opaque token (`Authorization: Bearer <token>`). The server resolves it via the
grants registry to a `principal` + `scope`; `can(principal, op, resource)` enforces the scope.
**The token is a capability** — replay/expiry/revocation are first-class at the registry (revoke
the row → PIN-ID-5 device revocation). Proposed `@deltos/shared` shape (replaces the P0
`object({method}).passthrough()`):

```ts
export const PrincipalVerificationSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('grant-token'), grantId: z.string().min(1) }),   // resolved bearer
  z.object({ method: z.literal('capability'),  grantId: z.string().min(1) }),   // share-link/agent
  z.object({ method: z.literal('unverified') }),                                // dev-only stub
]);
```
- **No `.passthrough()`** — closes the banked obligation structurally: authority keys strictly on
  the `method` literal + a strictly-validated proof; `can()` switches **exhaustively**. The raw
  secret token is never stored on the principal (only the resolved `grantId`, for audit).
- **Downgrade protection**: `method` is set by the *server's* auth middleware from what it actually
  verified — it is **never read from the request body**. A client cannot select `unverified`
  (which is, additionally, refused in production — §5).

## 5. Tripwire inversion → fail-CLOSED (carry-forward from secSys P0 close)

P0's tripwire refuses `unverified` only when `ENVIRONMENT === 'production'` → **fail-OPEN** on a
missing/typo'd var. Invert: **allow the `unverified` stub ONLY when `ENVIRONMENT` explicitly names a
known non-prod env** (`development` / `test` / `local`); unset or unrecognized ⇒ **refuse**. A
misconfigured deploy denies rather than serves the stub.

## 6. iOS / WebAuthn rules carried into KeyStore (PIN-ID-9, S1 §5)

WebAuthn call is the **first `await`** in any gesture flow; **RP ID = hostname** (served over
Tailscale HTTPS by hostname, never IP); RP ID matches Safari ↔ installed PWA (test explicitly); PRF
is enhancement-only over a UV + encrypted-IndexedDB baseline (PIN-ID-6).

## 7. QR join (PIN-ID-7)

QR encodes the raw mnemonic = full takeover → **out-of-band confirmation code REQUIRED** on the
receiving device, verified by the sender before trust; UI states the in-person-only threat model.
Join runs `enrollExisting(mnemonic)`.

---

## Questions for secSys (the early-read asks)

1. **The §0 correction** — agree `passkey` is local-unlock-only and the server-side union is
   `grant-token` / `capability` / `unverified`? Or add a per-request `signed-request` method?
2. **§3 canonical payload** — does it bind enough (replay/freshness/keyId/scope/purpose)? Is
   scope-at-mint sufficient or do you want per-request op+resource signing for sensitive ops?
3. **Ed25519 vs P-256** for the signing key (§1).
4. **Challenge store**: D1 row with atomic single-use consume (proposed) vs a Durable Object — any
   concern with D1 for the freshness/single-use guarantee at v1 scale?
5. Anything in the **key hierarchy / derivation** (§1) that weakens domain separation.
