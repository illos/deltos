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

## ✅ THE load-bearing question — RESOLVED (secSys ruling, build to this)
Passkeys gave ungated-reload FREE (durable device key → silent re-mint, no token at rest, F7). Password has
no durable device key. secSys's ruling (matches my A/B/C framing):
- **MECHANISM = (A) httpOnly + Secure + SameSite=Strict refresh COOKIE**, Path-scoped to the refresh
  endpoint, `Max-Age` = durable window (30–90d sliding/idle). Rejects (B) IDB token (JS-readable, XSS-
  exfiltratable — strictly worse than the old in-memory token, a long-lived bearer in the same plaintext IDB
  as the notes) and (C) password-derived unwrap (reload friction, violates ungated-reload). (A) reproduces
  the passkey property: the cookie auto-rides the first refresh on cold boot → silent re-mint, survives
  reload + iOS eviction (the cookie jar is not the evicted localStorage).
- **F7 SUPERSEDED, not abandoned** → re-stated: *no JS-readable bearer at rest*. The **access token stays
  in-memory** (short-TTL, `Authorization` header), the **sole durable credential is the httpOnly refresh
  cookie** (never IDB/localStorage/sessionStorage). Stronger against XSS than the old in-memory token.
- **Refresh-credential protection (hard conditions):** store only the **HASH** of the refresh token
  server-side (reuse the existing **F6 `hashToken`** path — never raw), keyed account+device.
  **Rotation-on-use + reuse-detection** (a presented-already-rotated token = theft → revoke the whole token
  FAMILY + force re-login). **Revoke-all-families** on password reset/change, logout, 2FA enable/disable
  (this is why refresh state is **server-side/stateful, NOT a stateless JWT**). Anti-CSRF belt
  (origin/Referer check) on mutations even with SameSite=Strict; access path stays CSRF-immune (custom header).
- **Password hashing = Argon2id via `@noble/hashes` argon2id** (CONFIRMED already a dep on worker+client
  @2.2.0 — pure-JS, Workers-compatible, **no WASM, no new dependency, reuse-clean**). Params m=19456 KiB
  (19 MiB), t=2, p=1 (OWASP floor); per-user random 16B salt; store the full **PHC string** (rehash-on-login
  to upgrade params); add an app **PEPPER** as a Worker secret (HMAC before hash → a D1-only leak can't be
  cracked offline). **Reality-check (mine, done):** Argon2id@those-params ≈ **325 ms/hash** on this devbox
  CPU (pure-JS) — within the paid Workers CPU budget for a single login; **authoritative measure is on real
  Workers** at build time (V8 isolate CPU accounting differs). Fallback ladder if real-Workers concurrency
  CPU-cost bites: step params DOWN, or scrypt (N=2^16–2^17) from the same `@noble` lib (document the
  downgrade); PBKDF2-HMAC-SHA256 ≥600k is the last-resort native floor. Algorithm choice (Argon2id) is fixed;
  only params may tune.
- **Same-origin CONFIRMED** (my check): `packages/worker/wrangler.jsonc` serves the client build via the
  `assets` binding with `run_worker_first: ["/api/*"]` + SPA fallback — so SameSite=Strict + the same-origin
  refresh work with NO CORS. (Full security model — TOTP-secret encryption, recovery-phrase reset binding,
  breach posture — lands with pilot from secSys.)

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
2. **POST /login** — {username, password, totp?} → verify Argon2id hash (+TOTP) → mint session + Set-Cookie
   refresh. Per-account exponential backoff + Turnstile (no hard lockout); uniform 401 (anti-enumeration).
3. **POST /session/refresh** — the httpOnly cookie auto-rides → verify hashed refresh + **rotate** (issue
   new, invalidate prior; reuse-detection revokes the family) → new in-memory access token. **THE
   ungated-reload path** (cookie scoped here only).
4. **POST /logout** — revoke refresh family + grant; clear cookie.
5. **TOTP** — POST /totp/setup (authed) → secret + otpauth URI/QR; POST /totp/verify → enable. Secret stored
   **encrypted** at rest.
6. **Recovery reset** — POST /password/reset {recoveryPhrase, newPassword} → verify phrase (stored as an
   **Argon2id verifier**, like a password) → set new hash + **revoke all refresh families** + sessions.
   (TOTP-secret encryption, recovery-phrase binding details, breach posture: secSys's security model —
   reference, don't re-derive.)
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
- **Password hashing on CF Workers** — RESOLVED: Argon2id via the already-vendored `@noble/hashes` (pure-JS,
  no WASM/new dep). The remaining item is a **build-phase-1 CPU MEASUREMENT on real Workers** (tunes params
  only; early local datapoint ≈325 ms/hash). Ladder: param step-down → `@noble` scrypt → PBKDF2 floor.
- **Durable-session** — RESOLVED: (A) httpOnly refresh cookie + in-memory access token (see the resolved
  section). F7 superseded → "no JS-readable bearer at rest". Refresh is **stateful server-side** (hashed,
  rotated, family-revoked) — NOT a stateless JWT.
- **Login rate-limiting / abuse** — CF WAF + **per-account exponential backoff** + Turnstile; **no hard
  lockout** (a hard lockout is a DoS-on-the-victim vector). secSys ruling.
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
