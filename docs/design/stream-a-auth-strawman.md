# Stream A — auth construction strawman (for secSys early read)

> **Historical — pre-pivot passkey/signed-challenge design, abandoned 2026-06-17, superseded by username+password (see auth-pivot-scope-map.md).**

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

---

# Revision 1 — resolving secSys early-read findings (bounce-back before lock)

Resolves `stream-a-auth-secSys-review.md`. Nothing is locked into `@deltos/shared` yet — this is
the second-pass target. secSys ruling requested on the F1 decision + the final shapes below.

## F1 (HIGH design call) — DECISION: account-level signing key for v1, with the seam shaped for per-device keys
**Call: option (a) — one mnemonic-derived account signing key for v1**, honoring PIN-ID-2/PIN-ID-5
(planner pinned account-level as acceptable for v1) and the 5–7d budget. **Recorded limitation,
stated precisely** (and surfaced in the UI per PIN-ID-7's threat-model discipline):

> "Revoke device" revokes the device's **cached grant token + registry handle** — it takes effect
> immediately for that token (registry-resolved, F6). It is **NOT** cryptographic device lockout:
> because every device derives the same signing key from the mnemonic, a holder of the **mnemonic**
> can `enrollExisting` and mint a fresh token. Recovery from a **compromised mnemonic/device** is
> **account re-key (rotate the mnemonic)** — the irreducible floor for any mnemonic-rooted system.

**Seam shaped so option (b) is a non-breaking add later:** `DeviceRegistry` rows carry a
`deviceSigningPublicKey` column from day one (v1 stores the account pubkey there); the enrollment
endpoint already takes a per-device authorization signature slot. Upgrading to per-device
non-extractable keys later changes *what fills those columns*, not the frozen contract (the
verification union is model-agnostic). **Flagging up to pilot/planSys:** secSys rates (b) the
stronger model and "expensive to change later," and it touches PIN-ID-2's "account key signs the
challenge" wording + the user-facing meaning of "revoke device" (a product dimension) — so this
v1=(a) call wants a conscious confirm, not just my say-so.

## Lock-blocker resolutions
- **F2 (CRITICAL) — fingerprint↔key binding enforced server-side.** The registration endpoint does
  NOT trust a client-supplied fingerprint: it **computes** `accountFingerprint =
  base64url(SHA-256(signingPublicKey))` from the submitted pubkey and uses that. If the client also
  sends one, it must equal the computed value or the request is **rejected**. → an attacker can only
  ever register under their OWN fingerprint; the §3 mint-binding guarantee now actually holds.
  **Tested** (registration rejects a mismatched fingerprint).
- **F4 — unambiguous canonicalization.** The signed message is a **length-prefixed TLV**: for each
  field, `uint32-BE(len) || bytes`, concatenated in fixed field order, then Ed25519-signed directly.
  No raw `||`; a variable-length field (scope, label) can never shift bytes across a boundary.
- **F5 — scope clamped at mint.** `granted = intersection(requestedScope, entitlement)`, never
  `requestedScope` verbatim. Entitlement upper bound: a **device** principal under its own account =
  full account scope on its own resources; a **capability** = exactly its granted scope.
- **F6 — token stored hashed.** Registry persists `SHA-256(token)` (token is high-entropy → no
  salt); lookup hashes the presented token and compares. Same for capability tokens. A DB/backup
  read yields no usable bearer.

## Other findings
- **F7 — plugin/token isolation.** The device grant-token lives **in memory only** (never
  localStorage/IndexedDB, so no in-page script — including a plugin — can read it). Plugins
  authenticate with their **own** `method:'capability'` narrow grants, never the device token.
- **F8 — audience binding.** The TLV signed payload includes an **`audience`** field = the canonical
  deployment origin / RP-ID, so a signature for one deltos deployment can't be replayed at another.
- **F9 — sensitive-op step-up.** Enumerated sensitive set: **device add/revoke, change recovery
  phrase, delete account, export-all / bulk-read, create or widen a share/capability grant.** These
  require a fresh **`signed-request`** (op + resource + fresh challenge + audience, signing key),
  regardless of bearer scope. Implemented as a **4th union member** (below). Normal CRUD = bearer.
- **F10 — can() switch.** Per-method `switch` ends in `default: assertNever(method)` (compile-time
  exhaustiveness) **and** a runtime **default-DENY** in that branch.
- **F12 — Ed25519 verified.** WebCrypto Ed25519 sign/verify confirmed present (Node 22; Safari
  ≥17 / Workers per secSys). **Raw 32-byte private-key import is NOT supported by WebCrypto**
  (verified: "Unsupported key usage"), so deterministic keygen+sign uses **`@noble/ed25519`**
  (raw-seed private key; audited, zero-dep, browser+Workers); server verify via WebCrypto
  raw-**public**-key import (supported) or noble. Empirical iOS-18 device confirm is a build-time
  pre-lock gate. (`@noble/ed25519` is generic crypto, not full-beans — reuse-clean.)
- **F13 — tripwire allowlist.** `unverified` allowed ONLY when `ENVIRONMENT` ∈ exact-match set
  `{development, test, local}` (no substring/prefix); unset/unknown ⇒ refuse. Noted: a dev instance
  on the tailnet = no auth → keep dev off real data.
- **F11 / F3 / D1-consume / hierarchy / iOS-QR** — kept as endorsed; consume-before-verify ordering
  retained; single-use enforced ONLY by rows-affected of the atomic conditional write, expiry
  checked against stored `expiresAt` vs server-now; per-label SLIP-21 HMAC chaining (no joined path).

## Final shapes for the lock (second-pass target)

**(1) Server-set verification union** — what `can()` switches on (NOT read from the request body;
set by auth middleware from what it actually verified):
```ts
export const PrincipalVerificationSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('grant-token'),    grantId: z.string().min(1) }), // resolved bearer
  z.object({ method: z.literal('capability'),     grantId: z.string().min(1) }), // share-link / agent / plugin
  z.object({ method: z.literal('signed-request'), keyId: z.string().min(1), challengeId: z.string().min(1) }), // step-up
  z.object({ method: z.literal('unverified') }),                                  // dev-only (refused in prod)
]);
```
- No `.passthrough()`; `grantId` is the resolved registry-row id, never the raw token. `can()`
  requires a freshly-verified `signed-request` for the F9 sensitive set; `grant-token` for CRUD.

**(2) Wire proof bodies** (separate request schemas — the actual proofs, validated at their endpoints):
```ts
// POST /api/auth/register  (F2: server computes the fingerprint; never trusts a client one)
RegisterDeviceRequest = { signingPublicKey: bytes, deviceLabel: string,
                          deviceAuthorization: bytes /* seam for option (b); = account self-sig in v1 */ }
// POST /api/auth/challenge
ChallengeRequest  = { keyId }                      → { challengeId, nonce, expiresAt }
// POST /api/auth/session   (mint bearer)          signature over TLV(tag,audience,purpose='session',challengeId,nonce,keyId,requestedScope)
SessionRequest    = { challengeId, keyId, signature, requestedScope }   → { token, expiresAt }
// step-up for F9 sensitive ops                    signature over TLV(tag,audience,purpose='step-up',challengeId,nonce,keyId,op,resource)
StepUpRequest     = { challengeId, keyId, op, resource, signature }
```
TLV = ordered `uint32-BE(len)||bytes` per field. `tag='deltos-auth-v1'`, `audience`=deployment origin.

**Ready to lock pending your second-pass OK on:** (1) the union shape, (2) the TLV field sets for
session vs step-up, (3) the F1 v1=(a) call. On your OK I lock the union into `@deltos/shared` +
build `can()`'s exhaustive switch (with F2 registration enforcement + its test).

---

# Revision 2 — secSys second-pass pre-lock items (final pre-freeze)

Second pass cleared the 4 blockers + TLV sets + F1(a); two pre-lock items remain, resolved here.

## Pre-lock item 1 (touches the FROZEN union) — RESOLVED via option (A): bind op+resource into signed-request
`signed-request` was a bare `{keyId, challengeId}` "a step-up happened" marker — `can()` could not
verify the signature was for THIS request's op+resource without trusting the middleware (unstated
authority, the chokepoint anti-pattern). Fix: the member now carries the **verified** `op` + `resource`,
and `can()` asserts them against its own arguments. **FINAL union — the lock target:**
```ts
export const PrincipalVerificationSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('grant-token'), grantId: z.string().min(1) }),
  z.object({ method: z.literal('capability'),  grantId: z.string().min(1) }),
  z.object({ method: z.literal('signed-request'),
    keyId: z.string().min(1), challengeId: z.string().min(1),
    op: OpSchema, resource: ResourceSchema }),   // the (op,resource) the step-up signature was verified for
  z.object({ method: z.literal('unverified') }),
]);
```
`can()` for `signed-request`: **deny unless** `member.op === op` **and** `resourceEquals(member.resource,
resource)` (its own chokepoint args). A step-up signed for `(opP, resourceP)` is structurally rejected
on a request for `(opQ, resourceQ)` — checkable AT the chokepoint, no middleware trust. **Test:** that
exact cross-(op,resource) rejection, alongside the assertNever + default-deny.

## Pre-lock item 2 (F3 enrollment proof) — CONFIRMED: v1 SERVER-VERIFIES deviceAuthorization
Not a reserved column — v1 verifies it as replay-resistant proof of key control (anti-squatting):
- `POST /api/auth/challenge` with `purpose='register'` issues a fresh challenge.
- `deviceAuthorization` = Ed25519 signature, by the **submitted signingPublicKey's** private key, over
  `TLV(tag, audience, purpose='register', challengeId, nonce, signingPublicKey, deviceLabel)`.
- Server: reconstruct the TLV from the STORED challenge (nonce/challengeId) + configured audience + fixed
  tag + submitted (signingPublicKey, deviceLabel); **verify against the submitted signingPublicKey**;
  atomically consume the challenge (rows-affected=1); **compute** `accountFingerprint =
  base64url(SHA-256(signingPublicKey))` (F2). → proves the registrant holds the private key for the
  pubkey being registered (you can only register a key you control); the fresh consumed challenge makes
  it replay-resistant.

## Explicit reconstruct-and-verify rule (secSys TLV ask)
For challenge / session / step-up / register: the server **reconstructs the TLV from server-held values**
(stored `nonce`/`challengeId`/`keyId`, its own configured `audience`, fixed `tag`, `purpose`) **plus the
request-supplied fields** (`requestedScope` for session; `op`+`resource` for step-up; `signingPublicKey`+
`deviceLabel` for register) and **rejects on signature mismatch**. The signature verification IS what
validates those request-supplied fields — **no body field is trusted before the signature check**, and
`nonce` is never client-sent (looked up by `challengeId`).

## Build-time notes banked (not blockers, not contract)
`@noble/ed25519`: pin a current audited version; wire the SHA-512 hook correctly (v2 API needs
`etc.sha512Sync`/async); confirm noble-sign ↔ WebCrypto raw-public-verify agree on **pure** Ed25519
(no prehash/ctx) in **Workers AND the iOS-18 device gate** before the device build ships.

## Lock readiness
F1(a) — both secSys conditions met: (i) the revoke≠lockout limitation goes into the UI copy honestly
(DECISIONS D5), (ii) the product-meaning confirm landed (pilot + planSys, D5). On secSys's
SECOND-PASS-CLEAR I lock this FINAL union into `@deltos/shared` + build `can()`'s exhaustive switch
with the signed-request (op,resource) assertion, the F2 registration test, and the item-1
cross-(op,resource) rejection test.

---

# Revision 3 — WIRE proof-bodies strawman (pre-build, for secSys) — wire-vs-verified-output split made explicit

**Status:** the FINAL union of Rev 2 is **LOCKED** — committed at `1cfaf3e` and live in
`packages/shared/src/api/grant.ts` (byte-identical to Rev 2's lock target; `can()` switch landed
with it). So `PrincipalVerification` is **closed; not reopened here.** What is **still absent in
source** (only stale `dist/auth/canonical.*` + `requests.*` orphans exist — being purged, src
deleted) and is the **next build surface** is the pair of WIRE proof-body modules:
`packages/shared/src/auth/canonical.ts` (the TLV codec) + `requests.ts` (the signed wire requests).
Per pilot's sequencing this Revision is the **concrete strawman secSys pressure-tests BEFORE I
build those two files** — replay-resistance, challenge-freshness, pubkey↔account binding all live in
*these* shapes, not in the (already-closed) union.

## The boundary secSys asked to see explicit: WIRE request ≠ verified-OUTPUT principal

There are **two distinct schema families** and signature material crosses **exactly one** of them:

| Layer | Module | What it carries | Signature bytes? | Trust |
|---|---|---|---|---|
| **WIRE request** (input, pre-verify) | `auth/requests.ts` + `auth/canonical.ts` | the raw proof a caller presents: pubkey, challengeId, requestedScope/op/resource, **and the Ed25519 `signature`** over the canonical TLV | **YES — lives ONLY here** | **untrusted** until the signature verifies |
| **Verified OUTPUT** (post-verify) | `api/grant.ts` → `PrincipalVerification` (LOCKED) | only the **facts the server already verified**: `method`, resolved `grantId` **or** `{keyId, challengeId, op, resource}` | **NEVER** — no `signature`, no `nonce`, no payload bytes | the auth middleware SETS it from what it verified; `can()` switches on it |

**The rule (secSys's note, made structural):** the auth middleware verifies a WIRE request, and on
success **constructs** a `PrincipalVerification` carrying *only the verified facts* — it copies the
`keyId/challengeId/op/resource` it checked, and **drops the signature on the floor.** Signature
material can never ride into `can()` because the verified-output schema has nowhere to put it. The
locked union already honours this (no `signature` field anywhere) — Rev 3 just makes the
*why* explicit so the lock review reads clean and the wire modules can't accidentally leak signature
bytes back onto the principal.

## Per-method proof shapes — verified-output member ⇐ wire proof ⇐ canonical signed payload

| `method` (verified output, LOCKED) | Wire proof presented (`requests.ts`) | Canonical payload signed (`canonical.ts` TLV) |
|---|---|---|
| `grant-token` `{grantId}` | `Authorization: Bearer <opaque token>`; resolved by **hashed** lookup (F6) to the registry row → `grantId`. **No per-request signature** (bearer capability). | none |
| `capability` `{grantId}` | `Authorization: Bearer <capability token>` (share-link / agent / plugin); same hashed-lookup resolution. **No per-request signature.** | none |
| `signed-request` `{keyId, challengeId, op, resource}` | **`StepUpRequest`** `{challengeId, keyId, op, resource, signature}` — the `signature` is the proof; the 4 verified facts are echoed into the union only AFTER it verifies. | `TLV(tag, audience, 'step-up', challengeId, nonce, keyId, op, resourceCanonical)` |
| `unverified` `{}` | none — dev-only stub; F13 fail-CLOSED env allowlist. | none |

Session **mint** is the third signed flow but it is **not a `can()` method** — it is the input to
`POST /api/auth/session` that *produces* a `grant-token`. Its signature lives on the wire
`SessionRequest`, is verified once at the mint endpoint, and never appears on any principal.

## Concrete shapes — the secSys pre-build target

**`auth/canonical.ts`** — the one TLV codec both sides share (client signs over it, server
**reconstructs** it from server-held values + request-supplied variable fields, then verifies):
```ts
const TAG = 'deltos-auth-v1';                 // version tag, NOT an audience (F8 keeps them separate)
type AuthPurpose = 'register' | 'session' | 'step-up';
// TLV framing (F4): each field => uint32-BE(byteLength) || bytes, concatenated in FIXED order.
// NEVER a raw `||` join — no variable-length field (scope, label, resource id) can shift a boundary.
// Fixed field order per purpose (purpose is itself a TLV field, so cross-purpose reuse is impossible):
//   register : TAG, audience, 'register', challengeId, nonce, signingPublicKey, deviceLabel
//   session  : TAG, audience, 'session',  challengeId, nonce, keyId,            requestedScopeCanonical
//   step-up  : TAG, audience, 'step-up',  challengeId, nonce, keyId,            op, resourceCanonical
// `nonce` and `audience` are SERVER-held — never sent in the request body; the server supplies them
// from the stored challenge + its own config when reconstructing. Signature verifies over THAT.
export function canonicalAuthPayload(purpose: AuthPurpose, fields: {...}): Uint8Array
```

**`auth/requests.ts`** — the WIRE bodies (Zod schemas, validated at their endpoints). A shared
`SignedRequest` base carries the signature material; **none of this is ever copied onto
`PrincipalVerification`:**
```ts
// base: every signed auth request carries the challenge handle + the signature over the TLV.
SignedRequestBase = { challengeId: z.string().min(1), signature: base64urlBytes /* Ed25519 over canonical TLV */ }

RegisterDeviceRequest = SignedRequestBase.extend({
  signingPublicKey: base64urlBytes, deviceLabel: z.string().min(1),
})                                              // deviceAuthorization === the SignedRequestBase.signature (Rev2 item-2: v1 server-VERIFIES it)
ChallengeRequest = { keyId?: z.string().min(1), purpose: AuthPurposeSchema }   // keyId omitted for 'register' (no key yet)
                                                // → { challengeId, nonce, expiresAt }
SessionRequest = SignedRequestBase.extend({ keyId: z.string().min(1), requestedScope: z.array(ScopeSchema) })
                                                // → { token, expiresAt };  mint CLAMPs scope to entitlement (F5)
StepUpRequest  = SignedRequestBase.extend({ keyId: z.string().min(1), op: OpSchema, resource: ResourceSchema })
```
Carried-forward invariants these shapes must keep (already secSys-cleared, restated so the wire build
can't regress them): **AUTH/F2** server COMPUTES `accountFingerprint = base64url(SHA-256(signingPublicKey))`,
never trusts a client one; **AUTH/F-consume** atomic single-use challenge consume by rows-affected +
freshness vs **stored** `expiresAt` on UTC-Z; **AUTH/F6** tokens stored hashed; **nonces/tokens ≥ 32
bytes**; the server **reconstructs** every TLV from server-held values and rejects on signature
mismatch — **no body field is trusted before the signature check.**

## secSys asks for Rev 3 (the pre-build pressure-test)
1. **Wire-vs-verified split** — is the boundary above the one you wanted explicit? Anything on the
   WIRE side that must NOT survive onto the verified-output principal beyond `signature`/`nonce`?
2. **`SignedRequest` base shape** — `{challengeId, signature}` shared, purpose-specific fields in the
   extension, signature always over the matching canonical TLV. Sound, or do you want the `purpose`
   echoed in the body (it is already a TLV field, so the signature binds it regardless)?
3. **canonical.ts field sets** — register/session/step-up orders above: anything mis-ordered,
   missing, or that should be server-held-only that I've shown as request-supplied?

On secSys's Rev-3 OK I build `canonical.ts` + `requests.ts` to these shapes (TDD), then outward:
authCrypto → authStore (D1 challenges/devices/grants) → routes/auth.ts → real `resolvePrincipal` +
the `grant-token`/`capability` branches of the already-locked `can()` switch.
