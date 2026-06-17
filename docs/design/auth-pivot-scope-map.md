# Auth Pivot — Scope Map (passkeys → username + password + optional TOTP)

**Author:** devSys (built the Stream-A auth layer). **Status:** SCOPE/DESIGN pass for planSys — NOT the
build. **Date:** 2026-06-17.

## Locked decision (recap)
- Drop **passkeys entirely** → **username + password** primary, **optional TOTP** 2FA.
- **Recovery phrase DEMOTED** → a forgot-password **reset token** (high-entropy; no longer the crypto root).
- **Contained to auth/identity.** notes / sync / editor / swipe+trash UNTOUCHED.
- **Retires entirely:** passkeys, WebAuthn, signed-challenge, QR-join (subsumes the QR-finish task),
  Option-A silent auto-unlock, PRF, the wrapped-blob at-rest custody.
- **3 user calls:** (1) day-to-day **UNGATED** — password only for sync / new-device / reset, NEVER an
  app-open prompt (north star preserved, mechanism swapped); (2) at-rest local notes rely on **device/OS +
  browser sandbox** for v1, **E2EE deferred to v2**; (3) recovery phrase = high-entropy **reset token**.
- **Migration = clean re-enroll** (dogfood-only, NO data migration).

## ⚠ THE load-bearing open question — routed to secSys (ruling pending, gates the architecture)
Passkeys gave **ungated-reload FREE**: a durable device key in IDB silently re-minted a session with NO
token at rest (F7). Password has **no durable device key**, so ungated-reload now needs a **durable
session/refresh mechanism** that survives reload + iOS eviction. Options put to secSys: **(A)** httpOnly +
Secure + SameSite refresh **cookie** (not JS-readable, XSS-resilient, same-origin PWA, access token stays
in-memory) — *my recommendation*; **(B)** refresh token in IDB (JS-readable, violates old F7); **(C)**
password-derived key unwrapping a stored token (reload friction). secSys also rules on: does **F7 relax**
now custody is device/OS-trust; refresh-credential at-rest protection; **password hashing on CF Workers**
(no native Argon2 — PBKDF2-WebCrypto vs WASM-Argon2id vs scrypt, with the **perf standing value** in play).
**The client reload path + the worker session model are built around whichever secSys picks.**

---

## (a) REUSED vs REWRITTEN

### ✅ KEEP — the account/authz spine is auth-method-INDEPENDENT (this is the D6 payoff)
The D6 split (separate **ACCOUNT** = stable random `accountId` from **CREDENTIAL**) was designed exactly so
the credential can change (signing-key → password) with **zero data migration**. So:
- **Account model** — `accountId` (server-random, immutable, the data-ownership key) + `createAccount`. KEEP.
- **Grant/session token** — opaque random token, stored **hashed** (F6), scope **clamped** (F5), TTL,
  `principal {kind:'owner', id:accountId}`, `mintedBy`, revoke. `mintGrant`/`resolveGrantByTokenHash`/
  `revokeGrant`/`revokeByKeyId` KEEP. **The session grant is independent of how you authenticated to mint it.**
- **`can()` chokepoint + `guard()`** — fully auth-method-independent. KEEP untouched.
- **`authCrypto`** partial: `hashToken` / `randomToken` / `clampScope` KEEP (token minting reused);
  `computeFingerprint` + `verifyRegister`/`verifySession`/`verifyStepUp` **RETIRE** (signed-challenge only).
- **`username.ts`** (`normalizeUsername` + NFKC/casefold + reserved denylist) KEEP — username is now MORE
  central (it's the login identifier).
- **Data-layer accountId scoping** (`accountScope`, notes keyed on accountId) — UNTOUCHED. The session still
  yields `accountId`; the data layer never sees the credential.

### ♻ REWRITE / REPLACE
- **Signed-challenge protocol** — `canonical.ts` TLV (`AUTH_TAG`/`AUTH_PURPOSES`/`canonicalAuthPayload`),
  `requests.ts` (`Challenge`/`Register`/`Session`/`StepUp` + `Nonce`/`Signature`/`SigningPublicKey` schemas):
  **RETIRE.** Replace `requests.ts` with password/login/refresh/TOTP/reset schemas (schema-first). The
  scope/resource canonical helpers survive only if a signed step-up persists (it does NOT under password —
  step-up becomes a password/TOTP re-prompt).
- **Worker `routes/auth.ts`** — `/challenge`, signed `/register`, signed `/session`, step-up
  `/devices/:keyId/revoke`: **REWRITTEN.** `/username` KEEP (folds into register). `/devices` KEEP (now lists
  sessions). New routes in §(b).
- **Worker `authStore`** — `createChallenge`/`consumeChallenge`/`sweepExpiredChallenges`: **RETIRE** (no
  challenges). `registerDevice`/`getDevice`/`listDevices` (keyed on pubkey/fingerprint): **REWRITE** to a
  credential record (username, passwordHash + params, totpSecretEnc, totpEnabled → accountId) + a
  session/refresh record (refreshTokenHash, accountId, expiresAt, revokedAt, label) per secSys's mechanism.
  `bindCredential`/`resolveAccountIdByFingerprint` → `resolveAccountIdByUsername` + bind (username,hash).
  `createAccount` / `mintGrant` / grant reads / `claimUsername` KEEP.
- **D1 migration** — new `credentials` + `sessions/refresh` tables (or columns); drop/ignore
  `devices`+`challenges` (clean re-enroll, fresh dogfood DB). LANDMINE: D1 no temp tables
  (`[[migration-d1-no-temp-table]]`); verify `db:migrate:local`.

### 🗑 CLIENT — the bulk of the deleted surface lives here
- **`identity/*` crypto/custody** — `keyDerivation` (SLIP-21/Ed25519 part), `keyStore`+`webAuthnKeyStore`
  (WebAuthn, PRF, wrapped blob, `autoUnlock`), `blob.ts`, `custodyPolicy`, `qrJoin`, `stepUp`, signed
  `register.ts`/`session.ts`: **RETIRE almost entirely.** Possible salvage: the BIP39 **entropy/wordlist
  generator** to MINT the recovery reset phrase (but it derives no keys now).
- **`auth/store.ts`** — REWRITE the actions: `enroll`/`enrollExisting`/`unlock`/`autoUnlock`/`mintSession`/
  `establishSession`/`register` → `register(u,p)`/`login(u,p,totp?)`/`refresh`/`logout`/`setupTotp`/
  `verifyTotp`/`resetWithPhrase`. **The P0 enrolling-latch + `finalizeEnroll` SHAPE survives conceptually**
  (don't gate day-to-day; latch a live ceremony so the gate can't short-circuit it) — preserve that lesson,
  but the impl is replaced. F7 + the e4 durable-keyId saga + cold-reload-rehydration are **superseded** by
  the durable-session mechanism (secSys ruling).
- **`shellGate.selectBootView`** — reworked: render the shell if a durable session can (re)establish
  silently, else the login gate. (Today keys on `isEnrolled` blob.)
- **Routes** — `EnrollRoute`→`RegisterRoute` (username+password, optional TOTP enrol, show recovery phrase
  once); `UnlockRoute`→`LoginRoute` (username+password +TOTP); `RecoverRoute`→`ResetRoute` (phrase→new
  password); `QrReceiveRoute` **RETIRE**; `MigrationNotice`/`Disclosure` (custody) RETIRE.

---

## (b) NEW surface
1. **POST /register** — {username, password} → create account + credential + mint session + return recovery
   reset phrase ONCE. (Username set at register; folds the atomic-unique `claimUsername` in.)
2. **POST /login** — {username, password, totp?} → verify hash (+TOTP) → mint session + set refresh.
3. **POST /session/refresh** — refresh credential → new access token. **THE ungated-reload path** (mechanism
   = secSys's A/B/C).
4. **POST /logout** — revoke refresh + grant.
5. **TOTP** — POST /totp/setup (authed) → secret + otpauth URI/QR; POST /totp/verify → enable. Secret stored
   **encrypted** at rest.
6. **Recovery reset** — POST /password/reset {recoveryPhrase, newPassword} → verify phrase (stored **hashed**,
   like a password) → set new hash + invalidate sessions.
7. **Client** — RegisterRoute / LoginRoute / ResetRoute / TOTP-setup UI; password actions in `auth/store`;
   `shellGate` keyed on durable-session.

---

## (c) Effort, sequencing, landmines

**Effort (relative):** Worker = medium (account/grant/username/`can` spine reused halves it); Client =
medium-large (cheap deletion of crypto/custody, but `auth/store` + 4 routes + `shellGate` are a real
rewrite); Shared = small-medium (swap `requests.ts`, retire `canonical` TLV). Net: a **focused multi-day
rewrite of one contained layer**, de-risked by the reused authz spine.

**Sequencing:**
1. **secSys ruling** (durable-session + password hashing) — BLOCKS the architecture.
2. **Shared contract** — new password/login/refresh/TOTP/reset request+response schemas (schema-first);
   retire signed-challenge schemas.
3. **Worker** — `authStore` rework + migration + routes; reuse grant/account/username/`can`.
4. **Client** — delete identity crypto/custody; rewrite `auth/store` + `shellGate`; new routes.
5. **Clean re-enroll** (dogfood) — fresh DB, no data migration.

**Landmines:**
- **Password hashing on CF Workers** — no native Argon2id; PBKDF2-WebCrypto (native, weaker) vs WASM-Argon2id
  (bundle cost — perf standing value) vs scrypt. secSys ruling.
- **Durable-session vs F7** — secSys's A/B/C choice reshapes the entire client reload path; load-bearing.
- **Username becomes a LOGIN credential** (not just a directory alias). `claimUsername` is already
  atomic-unique (reuse), but moves from an OPTIONAL post-session claim → REQUIRED at register, and becomes an
  **auth identifier** → **login anti-enumeration**: wrong-username vs wrong-password must be indistinguishable
  (uniform 401, constant-time-ish), in TENSION with register's necessary "username taken" signal. Reconcile
  with secSys + F-acct-4 (which made username existence a non-oracle).
- **D1 migration** — no temp tables; verify `db:migrate:local`.
- **TOTP** — RFC 6238 HMAC-SHA1 via WebCrypto (small); secret encryption at rest needed.
- **Preserve the P0 lesson** — the rebuilt gate must keep "ungated day-to-day + latch the live ceremony so
  the boot gate can't short-circuit it" (the enrolling-latch/`finalizeEnroll` shape), or the enroll-unmount
  class of bug returns in the register flow.
- **Confirm zero data-layer coupling** — notes/sync key on `accountId` from the session; the credential swap
  never reaches them. (Verified: data layer never sees the credential.)
