# secSys pressure-test — account-identity model (D6 expanded: accountId + usernames)

> **Historical — pre-pivot passkey/signed-challenge design, abandoned 2026-06-17, superseded by username+password (see auth-pivot-scope-map.md).**

**Author:** secSys · **Sibling of:** `account-identity-strawman.md` (devSys leads the model) · **Carries
forward:** `secSys-cross-account-sweep.md` (the data-layer cross-account finding + load-bearing-control
call this model fixes). · **Status:** PRE-SIGN-OFF pressure-test for planSys. **Build-audit (two-account
test class + fail-closed scope review) handed to a fresh secSys at the strawman boundary.**

D6 resolved MULTI-TENANT; ownership keys on a stable random **credential-INDEPENDENT `accountId`** (NOT
`accountFingerprint` — credential-derived would force data migration on any auth-method change). Usernames
added. devSys's adopted no-reopen answer: **`Principal.id` BECOMES `accountId`** (re-point, ZERO schema
delta — `PrincipalSchema` + the `PrincipalVerification` union byte-for-byte unchanged; only resolution
semantics + `grants.principalId` + worker DB change + a docstring on `Principal.id`).

## The load-bearing framing: TWO layers, never conflated (self-sovereignty separation)
- **DIRECTORY layer** — `username → accountId`. Server-arbitrated, mutable, public-ish, uniqueness-enforced.
- **OWNERSHIP/AUTH layer** — `accountId` (stable random) + the seed-sovereign signing key. Self-sovereign
  (rooted in the mnemonic), `accountId` IMMUTABLE.
- **INVARIANT:** data ownership + authorization key on the OWNERSHIP layer ONLY, NEVER the directory layer.
  So the blast radius of username arbitration/change/compromise (even server-side directory poisoning) is
  bounded to the directory — it CANNOT steal an account, its data, or its grants. This is what makes
  server-arbitrated usernames acceptable atop self-sovereign accounts.

## S1 — username namespace integrity & arbitration
- **username = identifier, NEVER an authenticator** (PIN-ID-1 analog). Authz keys on `accountId`; EVERY
  reference resolves via `accountId`, never the username string — a released+re-claimed username inherits
  NOTHING from the prior owner.
- **Atomic-unique claim:** UNIQUE on the normalized form + INSERT-or-fail (rows-affected=1), NEVER
  check-then-insert (registration-race TOCTOU). Same CAS discipline as the auth-challenge consume.
- **Normalization:** NFC + casefold; uniqueness on the FOLDED form; trim whitespace; reject zero-width /
  control chars. ("Alice"/"alice"/"ALICE" must collide.)
- **Confusables/homoglyphs:** v1 = conservative charset (e.g. `[a-z0-9_-]`), reject out-of-charset at the
  boundary. (Future: Unicode TR39 skeleton for the uniqueness key.)
- **Reserved-name denylist** (admin/root/system/support/official/…).
- **Enumeration — F-acct-4 (planSys-ruled, secSys owns the exact shape):** PREFER an
  **authenticated-claim-only** free/taken check — there is NO standalone unauthenticated availability
  endpoint, so no public existence oracle; the free/taken signal is revealed ONLY inside an authenticated
  claim attempt (the caller is already an authenticated account when claiming). If a pre-claim availability
  hint is wanted for UX, gate it behind auth + **rate-limit + uniform timing** + return a BOOLEAN only (never
  an `accountId`, never a reserved-vs-taken-vs-confusable distinction). Concrete v1 shape: fold availability
  into the authenticated claim endpoint (claim returns taken → pick another); skip a separate `/available`
  route unless UX forces it, and if so apply the gated form above.

## S2 — recovery + QR-join re-association (NO re-association attack surface)
- Deterministic chain: mnemonic → signing key → `accountFingerprint` → (map) → `accountId` → username; the
  map lookup is the ONLY path to `accountId`, each link server-resolved.
- An attacker WITHOUT the mnemonic cannot produce the `accountFingerprint`, so cannot reach the `accountId`
  (mnemonic = irreducible floor, F1). QR-join encodes the mnemonic + REQUIRES the OOB confirmation code
  (PIN-ID-7) against join-hijack MITM.
- **No re-association:** an attacker must NOT (a) re-point an existing `accountFingerprint→accountId` entry,
  (b) re-point `username→accountId` to an account they do not control, or (c) bind their credential to a
  victim's `accountId`. All require account-possession proof the attacker lacks. Existing map entries are
  append-only / immutable-once-set; re-pointing is forbidden or a gated sensitive op needing current-control.

## S3 — add/replace-credential authz + last-credential lockout guard
- Binding a NEW credential to an EXISTING `accountId` MUST require proof of CURRENT account control — a
  fresh signed-challenge with the existing account signing key (F9 step-up). Else anyone adds their
  credential to your account.
- **Lockout guard:** removing the LAST authenticating credential = permanent lockout. v1 (account-level key
  from the mnemonic): mnemonic = floor → revoke ≠ lockout (F1/D5), re-`enrollExisting` always works. As this
  evolves to per-device keys (option b) the guard becomes load-bearing: enforce "≥1 recovery path ALWAYS
  exists." Replace = add (current-control proof) + remove (lockout guard).

## S4 — accountId properties
Server-assigned random **≥16B**, **IMMUTABLE**, **never client-supplied**, resolved SERVER-SIDE via the
credential→account map. (Enumerable/forgeable `accountId` + any client-trusted use ⇒ cross-account.)

## S5 — migration safety (re-point existing accountFingerprint keys → accountId)
Migration 0002 binds on `accountFingerprint` (devices.accountFingerprint, grants.principalId for owner
grants). Re-pointing to `accountId` must have NO wrong-account window:
- 1:1 `fingerprint→accountId` map, UNIQUE on BOTH columns, built in ONE migration tx WITH the
  grants.principalId re-point → resolvePrincipal sees old-world OR new-world, never mixed.
- Migration + the accountId-aware resolvePrincipal DEPLOY TOGETHER — no window where old code resolves a
  migrated row to the wrong account.
- New mints stamp `grant.principalId = accountId` resolved server-side (`keyId→fingerprint→map→accountId`),
  never a body field ⇒ no forge / cross-bind.
- F2 binding + per-device revoke RELOCATE to `mintedByKeyId` + `devices.accountFingerprint` (preserved, not
  weakened); `listDevices` re-scopes to the account (devices gains an accountId association).
- **notes back-fill CAVEAT:** existing notes carry no owner column, so back-filling `notes.accountId` is
  AMBIGUOUS. Safe ONLY if data is empty/single-account (Phase-1 pre-deploy); any real multi-account data
  needs an explicit owner-assignment decision — flag, never silently assign.

## S6 — per-query accountId scope = LOAD-BEARING (carry-forward, now keyed on accountId)
The data-layer per-query account scope is the PRIMARY fail-closed control; keyed on the stable `accountId`
it SURVIVES a credential/auth-method rekey with no data migration (the point of the rescope). Must cover
notebookId-keyed queries (sync push/pull, search), not just id-keyed CRUD; writes stamp `accountId` from
the principal, never a body field. `grantAllows` ownership check = defense-in-depth belt.

## S7 — frozen-contract: ADDITIVE, no reopen
ZERO schema delta — `PrincipalSchema` + `PrincipalVerification` union byte-for-byte unchanged; only
`Principal.id` semantics (now `accountId`) + resolution + `grants.principalId` + DB change. **No new auth
method** (username is a directory label). Confirm EVERY former `accountFingerprint`-as-principal-id site
moves to `accountId` consistently.

## Pre-sign-off verdict (secSys → planSys)
SOUND; the accountId rescope is the right call (strengthens S6 — rekey-stable ownership key). CONDITIONAL on
S1–S7, the two highest-stakes invariants: **(i)** authz/data ownership key on `accountId`/signing-key ONLY,
never the username (framing/S1); **(ii)** binding/re-association to an existing account ALWAYS requires
account-possession proof (S2/S3). One-time risk = S5 migration (atomic 1:1 re-point + deploy-together; answer
the notes back-fill caveat before the data-dimension migration runs).

## Open audit angles for the fresh secSys (the BUILD audit — bigger lift, full window)
1. **Two-account cross-account-negative test class** — seed accounts A+B, assert A is denied (404/403) on
   B's every object route (notes CRUD, sync push/pull, search, device list/revoke) AND B's object unchanged.
   The root-cause blind spot was that every existing test seeds ONE account.
2. **Fail-closed per-query accountId scope review** — confirm the LOAD-BEARING data-layer scope is applied to
   EVERY object query incl. notebookId-keyed (sync/search), routed through ONE helper that REQUIRES the
   caller `accountId` so no handler can omit it; writes stamp owner from the principal.
3. **Migration audit** — verify S5 lands atomic + deploy-together + the notes back-fill decision.
4. **Username + credential-map build audit** — verify S1 atomic-unique claim + normalization, S2/S3
   possession-proof on bind/re-associate + the lockout guard, S4 accountId properties — against the code.
5. **Re-confirm S7** — `PrincipalVerification` untouched; all principal-id sites moved fingerprint→accountId.
