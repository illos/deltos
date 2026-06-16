# Stream A auth — implementation contracts (authStore + per-route)

**Author:** devSys (chokepoint owner) · **For:** devSys2 (authStore + D1 migrations), scopeSys
(routes/auth.ts) · **Status:** STABLE — secSys Rev-3 cleared the approach; R3-1..R3-4 folded; the 3
open reconcile points are RULED below. Field-level wire encodings live in `canonical.ts`/`requests.ts`
(landing now, routed to secSys); the table shapes, function signatures, step ordering, and security
invariants here are final — build against them. Refs: `stream-a-auth-strawman.md` (Rev 1–3),
`stream-a-auth-secSys-review.md` (Rev 3), `stream-a-d1-auth-schema-proposal.md` (devSys2).

## Ownership seam (who builds what)
- **devSys (me):** `canonical.ts` (TLV), `requests.ts` (wire schemas), `authCrypto` (Ed25519
  verify, F2 fingerprint COMPUTE, TLV reconstruct, RNG, token hashing, UTC-Z instant parse), the
  chokepoint (`resolvePrincipal` + `grant-token`/`capability`/`signed-request` verification +
  `can()` + F13).
- **devSys2:** D1 migrations + `authStore` (§1).
- **scopeSys:** `routes/auth.ts` plumbing (§2). Routes call INTO my `authCrypto` + devSys2's
  `authStore`; routes own request parsing + status codes, NOT crypto/policy logic.

**The rule that overrides everything:** no request body field is trusted before the signature
verifies. The server RECONSTRUCTS every TLV from SERVER-HELD values (stored `nonce`/`keyId`/
`purpose`, configured `audience`, fixed `tag`) plus the genuinely request-supplied INTENT fields
only, then verifies. `nonce`/`keyId`/`purpose`/`audience` are never trusted from the body;
`accountFingerprint` is COMPUTED, never trusted (F2).

## Open-reconcile rulings (devSys2's 4 points)
1. **Binary repr → base64url TEXT** (not BLOB) for `nonce`, `signing_public_key`, `token_hash`.
   Rationale: one canonical repr across wire + storage — `Identity.id`/`accountFingerprint` ARE
   base64url strings compared byte-for-byte (F2), and `encoding.ts` is the single codec; TEXT avoids
   BLOB↔base64url conversion at every boundary. Volumes are tiny (challenges are short-lived, devices
   few), so BLOB's ~33% saving isn't worth the repr split.
2. **TTL compare form → epoch-millis INTEGER** for comparison-critical `expires_at_ms` on BOTH
   `auth_challenges` and `grants` (CONFIRMED — devSys2's own resolution; aligns with secSys's
   epoch-int lean and Stream B's monotonic-INT precedent). Integer compare in the atomic-consume CAS
   and in grant-resolution is INSTANT-correct, never lexical (satisfies AUTH-1 × R3-1). Audit-only
   `issued_at`/`created_at`/`revoked_at` stay ISO-Z TEXT (spine-consistent, never compared).
3. **consumeChallenge return shape → `UPDATE … RETURNING` the consumed row** (§1) — single atomic
   statement, not boolean-then-separate-load (a second read reopens a window). rows=1 ⇒ proceed with
   returned server-held fields; 0 rows ⇒ `null` ⇒ reject.
4. **deviceAuthorization → verify-only, NO persisted column** (CONFIRMED, Rev2 item-2). It is an
   Ed25519 signature checked at register time as proof of key control; never stored.

---

## 1. authStore contract (devSys2)

### D1 schema (3 tables — migration owner devSys2; committed camelCase in migration 0002 @ b835804).
Columns are **camelCase 1:1 with the spine (PIN-SUBSTRATE-1 — no camel-snake mapping layer)**. All
binary = base64url TEXT (ruling 1). Comparison-critical expiry = epoch-millis INTEGER (ruling 2).
```sql
-- devices (DeviceRegistry). v1 account-level signing key (F1 option a): every device of an account
-- shares signingPublicKey + accountFingerprint; keyId is the per-device handle for revocation.
CREATE TABLE devices (
  keyId              TEXT PRIMARY KEY,             -- server-ASSIGNED handle (random, >=16B base64url)
  signingPublicKey   TEXT NOT NULL,               -- base64url(Ed25519 pubkey, 32B)
  accountFingerprint TEXT NOT NULL,               -- base64url(SHA-256(signingPublicKey)) — server-COMPUTED (F2)
  deviceLabel        TEXT NOT NULL,
  createdAt          TEXT NOT NULL,               -- ISO-Z, audit-only
  revokedAt          TEXT                         -- ISO-Z, audit-only; presence (IS NOT NULL) = revoked
);
CREATE INDEX devices_byAccount ON devices(accountFingerprint);

-- authChallenges. Short-TTL, single-use. nonce = server-held authoritative copy.
CREATE TABLE authChallenges (
  challengeId  TEXT PRIMARY KEY,                  -- random, >=32B base64url
  nonce        TEXT NOT NULL,                     -- random, >=32B base64url; server-held
  keyId        TEXT,                              -- NULL for purpose='register' (no key yet)
  purpose      TEXT NOT NULL,                     -- 'register' | 'session' | 'step-up'
  issuedAt     TEXT NOT NULL,                     -- ISO-Z, audit-only
  expiresAtMs  INTEGER NOT NULL,                  -- epoch-millis — THE freshness gate (instant compare)
  consumed     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX authChallenges_byExpiry ON authChallenges(expiresAtMs);

-- grants registry. Token stored HASHED (F6) — never raw.
CREATE TABLE grants (
  grantId       TEXT PRIMARY KEY,                 -- random row id (base64url)
  tokenHash     TEXT NOT NULL UNIQUE,             -- base64url(SHA-256(token)) — F6
  principalKind TEXT NOT NULL,                    -- 'owner' | 'device' | ...
  principalId   TEXT NOT NULL,                    -- accountFingerprint (owner) | keyId (device)
  mintedByKeyId TEXT,                             -- the device keyId whose session minted this grant;
                                                  --   NULL for capability grants. Enables revokeByKeyId
                                                  --   without re-keying the principal (PIN-ID-5).
  resourceKind  TEXT NOT NULL,                    -- 'workspace' | 'notebook' | 'note'
  resourceId    TEXT,                             -- NULL for workspace
  scope         TEXT NOT NULL,                    -- JSON array, CLAMPED at mint (F5)
  expiresAtMs   INTEGER,                          -- epoch-millis, nullable — instant compare at resolve
  revokedAt     TEXT,                             -- ISO-Z; presence = instant deny (PIN-ID-5)
  createdAt     TEXT NOT NULL                     -- ISO-Z, audit-only
);
CREATE INDEX grants_byToken ON grants(tokenHash);
CREATE INDEX grants_byMintedKey ON grants(mintedByKeyId);
```

### authStore functions (pure D1, no crypto)
```ts
createChallenge(row: { challengeId, nonce, keyId: string|null, purpose, issuedAt, expiresAtMs: number }): Promise<void>

// R3-1 + R3-2: THE single authority on single-use AND freshness, in ONE indivisible write.
//   UPDATE authChallenges SET consumed=1
//   WHERE challengeId=?1 AND consumed=0 AND purpose=?2 AND expiresAtMs > ?3   -- ?3 = serverNowMs
//   RETURNING nonce, keyId;
// rows-affected=1 => fresh AND first-consumer => proceed with the returned SERVER-HELD nonce/keyId
// (purpose is pinned by the WHERE = the endpoint's fixed purpose constant; no need to return it).
// 0 rows => null => REJECT (expired OR already-spent OR wrong-purpose — indistinguishable, all reject).
// HARD RULES: single-use+freshness decided ONLY by this write's rows-affected — NEVER by a prior
// SELECT of `consumed` or `expiresAtMs` (a stale-replica read reopens the window). serverNowMs is
// the SERVER clock; no client timestamp ever enters. Do NOT add a getChallenge() that reads these.
consumeChallenge(challengeId: string, purpose: AuthPurpose, serverNowMs: number): Promise<{ nonce: string, keyId: string|null } | null>

registerDevice(row: { keyId, signingPublicKey, accountFingerprint, deviceLabel, createdAt }): Promise<void>
getDevice(keyId: string): Promise<{ signingPublicKey, accountFingerprint, revokedAt: string|null } | null>
listDevices(accountFingerprint: string): Promise<Array<{ keyId, deviceLabel, createdAt, revokedAt }>>

// principal STAYS {kind:'owner', id: accountFingerprint}; mintedByKeyId records the minting device.
mintGrant(row: { grantId, tokenHash, principal, mintedByKeyId: string|null, resource, scope, expiresAtMs: number|null, createdAt }): Promise<void>
// Resolve by HASH; caller passes authCrypto.hashToken(presentedToken). Returns row incl. expiresAtMs
// + revokedAt so the chokepoint applies freshness (instant compare) + revocation (presence) itself.
resolveGrantByTokenHash(tokenHash: string): Promise<{ grantId, principal, resource, scope, expiresAtMs: number|null, revokedAt: string|null } | null>
revokeGrant(grantId: string): Promise<void>            // capability/single-grant revoke; sets revokedAt = now
// PIN-ID-5 device revocation. Batch: (a) UPDATE devices SET revokedAt=now WHERE keyId=? (blocks future
// mints via getDevice revoked-check) AND (b) UPDATE grants SET revokedAt=now WHERE mintedByKeyId=? AND
// revokedAt IS NULL (immediate deny on that device's outstanding tokens — resolvePrincipal row-resolves
// every request). F1 honest-limit: re-enroll re-mints under a NEW keyId (revoke != cryptographic lockout).
revokeByKeyId(keyId: string): Promise<void>

sweepExpiredChallenges(serverNowMs: number): Promise<void>   // DELETE WHERE expiresAtMs < serverNowMs
```
Invariants devSys2 holds: (a) `consumeChallenge` is the atomic CAS above — single-use+freshness live
entirely in that one statement; (b) `mintGrant`/`resolveGrant` touch `token_hash` only, never a raw
token; (c) gate compares are on the INTEGER `expires_at_ms`; (d) `deviceAuthorization` has no column.

---

## 2. Per-route policy contract (scopeSys)

Routes parse with my `requests.ts` Zod schema (which enforces R3-4: strict base64url + exact lengths
— pubkey 32B, sig 64B, nonce/token ≥32B — rejecting at the boundary), then orchestrate `authStore` +
`authCrypto`. Routes own HTTP status + parsing; they DELEGATE every crypto/policy decision.

### POST /api/auth/challenge — `{ keyId?, purpose }` → `{ challengeId, nonce, expiresAt, expiresAtMs }`
1. If `purpose !== 'register'`: `keyId` required. **Uniform response for unknown `keyId`** (issue a
   challenge regardless / constant-shape) — not a device-enumeration oracle (secSys note).
2. `challengeId = authCrypto.randomToken(32)`, `nonce = authCrypto.randomToken(32)`. Server clock →
   `expiresAtMs = nowMs + 60_000`. `authStore.createChallenge({...})`. Return the challenge.
3. **Rate-limit + cap** this unauthenticated row-creator (secSys note) — the TTL bounds lifetime, not
   creation rate. (Mechanism is scopeSys/devSys2's; flagged here so it isn't dropped.)

### POST /api/auth/register — `RegisterDeviceRequest { challengeId, signingPublicKey, deviceLabel, signature }` → `{ keyId, accountFingerprint }`
1. `c = authStore.consumeChallenge(challengeId, 'register', nowMs)`; null → 401. (Freshness is IN the
   consume — no separate expiry check.)
2. `authCrypto.verifyRegister({ challengeId, nonce: c.nonce, signingPublicKey, deviceLabel, signature })`
   — reconstructs the register-TLV from SERVER-HELD `nonce` + configured `audience` + fixed `tag`/
   `purpose='register'` + the request INTENT fields `signingPublicKey`/`deviceLabel`; verifies against
   the SUBMITTED pubkey (proof of key control / anti-squat). Fail → 401.
3. `accountFingerprint = authCrypto.computeFingerprint(signingPublicKey)` (F2 — server COMPUTES).
4. `keyId = authCrypto.randomToken(16)`; `authStore.registerDevice({...})`. Return `{ keyId, accountFingerprint }`.

### POST /api/auth/session — `SessionRequest { challengeId, keyId, requestedScope, signature }` → `{ token, expiresAt }`
1. `c = authStore.consumeChallenge(challengeId, 'session', nowMs)`; null → 401.
   **`c.keyId !== keyId` → 401** (R3-2: challenge bound to its keyId; assert stored==request).
2. `d = authStore.getDevice(keyId)`; missing/revoked → 401.
3. `authCrypto.verifySession({ challengeId, nonce: c.nonce, keyId: c.keyId, requestedScope, signature,
   signingPublicKey: d.signingPublicKey })` — reconstruct from SERVER-HELD `nonce`/`keyId` (stored,
   not body) + audience + tag + `purpose='session'`; the only signed request-supplied field is
   `requestedScope`. Verify against the SERVER-RESOLVED pubkey. Fail → 401.
4. F5 clamp: `granted = authCrypto.clampScope(requestedScope, entitlementFor(d))` — never verbatim.
5. `token = authCrypto.randomToken(32)`; `authStore.mintGrant({ grantId, tokenHash:
   authCrypto.hashToken(token), principal:{kind:'owner', id: d.accountFingerprint}, mintedByKeyId:
   keyId, resource, scope: granted, expiresAtMs, createdAt })`. Return `{ token, expiresAt }` (raw
   token returned ONCE). `mintedByKeyId` is what later lets `revokeByKeyId` find this device's tokens.

### GET /api/auth/devices, POST /api/auth/devices/:keyId/revoke — list / revoke
- `GET /api/auth/devices` → `authStore.listDevices(caller's accountFingerprint)`.
- `POST /api/auth/devices/:keyId/revoke` ∈ F9 SENSITIVE set ⇒ requires a fresh **step-up** bound for
  v1 to `op='delete'`, `resource={kind:'workspace'}` (an account-level destructive op; the `:keyId`
  path param selects the target device). On success → `authStore.revokeByKeyId(keyId)` (sets
  `devices.revokedAt` + revokes that device's outstanding grants). *Follow-up (tracked, not v1): a
  tighter per-device resource binding once the resource model carries a device kind.*

### Step-up verification (F9) — SEAM
- **gruntSys2 (client):** builds `StepUpRequest { challengeId, keyId, op, resource, signature }`.
- **scopeSys (route):** extracts those fields (validate w/ `requests.ts`), passes to
  `authCrypto.verifyStepUp({...})` → returns verified `{ keyId, challengeId, op, resource }` or throws.
  Route does NOT implement the verify.
- **devSys (me):** `verifyStepUp` consumes the `'step-up'` challenge, reconstructs+verifies the
  step-up TLV against the server-resolved pubkey; the resulting `{ method:'signed-request', keyId,
  challengeId, op, resource }` flows to `can()`, which asserts `member.op===op &&
  resourceEquals(member.resource, resource)` (already in the LOCKED switch).

`entitlementFor`, the resource a session grant targets, and the sensitive-route enum are policy I
(devSys) own and hand scopeSys as a small enum + helper so routes stay declarative.

## Endpoint/authStore-layer notes (banked from secSys; not in the 2 schema files)
- **Audience = ONE canonical server constant** = the **deployment HOSTNAME** (= WebAuthn RP ID =
  client `location.hostname`, bare — no scheme, no port). Held server-side as `env.AUTH_AUDIENCE`,
  configured per-deployment to that hostname; the server uses THIS when reconstructing the canonical
  TLV, **never the request Host header** and never a multi-valued accept-set (a set reopens the
  cross-deployment replay F8 closes). Client (gruntSys2) uses `location.hostname` in both the WebAuthn
  `rpId` and the step-up `audience`, so the two match byte-for-byte (PROP-4). Confirmed aligned.
- **No replay-dedup on signature bytes** — Ed25519 is malleable; single-use is the `challengeId`
  consume (R3-1). Use `@noble/ed25519` strict verify (rejects non-canonical S / small-order points).
- **resolvePrincipal must copy ONLY verified facts onto the principal** — never `signature`, `nonce`,
  `audience`, RAW `requestedScope` (only CLAMPED `granted` lands on the grant row), `signingPublicKey`,
  or `deviceLabel`. The locked union has nowhere to put them; a no-extra-fields test pins it (mine).
