# Account-identity model — strawman (D6 expanded, task 12)

**Authors:** devSys (model + frozen-contract + mapping + data-dimension) · secSys (security surfaces) ·
**Status:** STRAWMAN — design-first, **no build**; routes to **planSys** for sign-off before any fan-out.
**Refs:** `DECISIONS.md` D6 (resolved 2026-06-16), memory `account-identity-model`,
`stream-a-identity-plan`, `tenancy-grant-account-relative`, `cross-account-data-layer-finding`;
`docs/design/secSys-cross-account-sweep.md`; `packages/shared/src/api/grant.ts` (the frozen contract);
`packages/worker/migrations/0002_stream-a-auth.sql` (devices/grants as built).

> **The one-line decision.** Separate **ACCOUNT** (a stable, random, credential-INDEPENDENT
> `accountId`) from **CREDENTIAL** (the signing key / `accountFingerprint`). The data layer keys
> ownership on `accountId`, so auth methods can be added or replaced without ever migrating note data
> — the exact pain that keying on `accountFingerprint` (= `hash(signingPublicKey)`) would cause the day
> auth changes. A unique **`username`** is a human-meaningful alias → `accountId`.

---

## 0. Why this is not greenfield (devSys2 intersection — load-bearing)

Migration `0002` already keys on the **credential**, not an account:

- `devices.accountFingerprint` = `base64url(SHA-256(signingPublicKey))`, server-computed (F2), `= Identity.id`.
- `grants.principalId` stores **`accountFingerprint`** for owner grants (session mint sets
  `principal{kind:'owner', id:accountFingerprint}`); `resolvePrincipal` → `principalForGrant` surfaces
  `principal.id = grant.principal.id = accountFingerprint`.
- The cross-account sweep's deferred fix keyed `notes.accountFingerprint`. **D6 rescopes that key to
  `accountId`.**

So the model must state **explicitly** how `devices` + `grants` relate to `accountId` vs
`accountFingerprint`. It does — see §3 (mapping) and §5 (data dimension). **The decision (adopted from
secSys + devSys2): re-point `grants.principalId` from `accountFingerprint` to `accountId`** — the grant
*becomes* account-keyed, so Stream-D sync scoping resolves the same `accountId` straight off the bearer
with no per-request lookup. The minting device is still tracked by `grants.mintedByKeyId` (already in
`0002`), so per-device revoke + the F2 credential binding are **preserved, not weakened** (§5).

Because nothing is deployed multi-account (dev backend only), the re-point is a low-stakes **pre-deploy**
migration over dev fixtures — but it still must be done with **no wrong-account window** (secSys S5, §5).

---

## 1. The three layers (and what is immutable)

```
  ACCOUNT            accountId   ── immutable, random, credential-INDEPENDENT.
   │                             THE data-ownership key. Never derived from a key.
   │                             Survives every auth-method change. Never re-issued.
   │
   ├── username      alias → accountId. Unique, normalized, server-arbitrated.
   │                 Human-facing handle. (Rename allowed; accountId is the true anchor — see §2.)
   │
   └── credentials   one-or-more auth methods bound to the account.
        └ v1: signing key → accountFingerprint = base64url(SHA-256(signingPublicKey)).
          future: passkey-resident / OIDC / etc. ADD or REPLACE without touching accountId/username.
```

- **`accountId`** is the only thing the data layer keys on. It is **random** (≥16 bytes, base64url),
  minted server-side at first registration, and **never changes** — not on recovery, not on QR-join, not
  on an auth-method swap. This is the property that makes usernames + future auth flexibility possible
  (D6's stated rationale).
- **`accountFingerprint`** keeps its current meaning unchanged: the **credential** identifier and the F2
  cross-account binding for the *signing-key* method. It is **demoted from "the account id" to "one
  credential's id"**. We do **not** remove it.
- **`username`** is a server-side directory alias. The cryptographic account identity (the signing key)
  stays seed-sovereign; the username is a convenience handle the server arbitrates (§2, and secSys §7).

---

## 2. Username registry — namespace arbitration

`usernames(usernameNormalized PK, accountId FK, usernameDisplay, createdAt)` — a **separate table**, not
a column on `accounts`, so rename history and (later) multiple aliases per account drop in without a
schema change.

**Normalization (uniqueness is decided on the normalized form, display preserves the user's casing):**
- `usernameDisplay` — exactly what the user typed (within charset), shown in UI.
- `usernameNormalized` — `NFKC` → casefold (lowercase) → trim. The **UNIQUE** key. So `Alice`, `alice`,
  and `ＡＬＩＣＥ` (fullwidth) collapse to one claim.
- **Charset (strawman):** `[a-z0-9_-]`, 3–32 chars, must start alphanumeric. ASCII-only for v1 keeps the
  confusable surface small; Unicode handles are a deliberate later expansion (secSys §7 flags the
  homoglyph cost of opening it).
- **Reserved names:** a denylist (`admin`, `root`, `system`, `support`, `api`, `deltos`, `me`, `self`,
  …) refused at claim time.

**Uniqueness / collision:** claiming is an atomic `INSERT` on `usernameNormalized` (UNIQUE) — first writer
wins, the loser gets a deterministic "taken" rejection. **No read-then-write** (TOCTOU); the DB constraint
is the arbiter, mirroring the challenge-consume discipline already in `0002`.

**Rename:** `accountId` is the immutable anchor; the **username MAY be renamed** (update the row's
`usernameNormalized`/`usernameDisplay`, same atomic-uniqueness rule). Old name is **not** auto-reserved →
flag to secSys (§7) for a cooldown / tombstone so a renamed-away handle can't be instantly squatted to
impersonate. Recommendation: keep v1 rename **off** (or admin-only) until the cooldown policy lands;
nothing in Phase-1 needs rename.

**Enumeration:** a "is this username free?" endpoint is an account-existence oracle. secSys owns the
mitigation shape (§7) — rate-limit + uniform timing, or fold the check into an authenticated claim only.

---

## 3. Credential → account mapping

```
accounts(accountId PK, createdAt, ...)                         ← the account record (random PK)
accountCredentials(accountFingerprint PK, accountId FK,        ← the credential→account map
                   credentialType, addedAt, revokedAt)
usernames(usernameNormalized PK, accountId FK, usernameDisplay, createdAt)
devices(... accountFingerprint ...)        ← + an accountId association for listDevices re-scope (§5)
grants(... principalId ...)                ← RE-POINTED: principalId now = accountId (was fingerprint) (§5)
```

- **v1 credential = the signing key.** At `/register`, the server computes `accountFingerprint` (F2,
  unchanged), then: if no `accountCredentials` row exists for it → this is a **new account**: mint a fresh
  random `accountId`, insert `accounts(accountId)`, insert `accountCredentials(fingerprint → accountId,
  type='signing-key-v1')`. If a row exists → recovery / QR-join of an existing account (§4): reuse its
  `accountId`. **`enrollNew` vs `enrollExisting` (PIN-ID-8) maps cleanly onto mint-new-account vs
  resolve-existing-account.**
- **devices** stays exactly as `0002` built it (keyed by `keyId`, carrying `accountFingerprint`). A device
  belongs to a credential; the credential belongs to an account. `listDevices` continues to scope by
  `accountFingerprint` (correct — devices are per-credential), but **note/sync data scopes by
  `accountId`** (§5), because data must survive a credential change.
- **future methods ADD or REPLACE:** a new auth method produces a new credential identifier (e.g. a new
  signing key → new `accountFingerprint`, or a non-signing credential type). An **authenticated
  add-credential flow** inserts a new `accountCredentials` row pointing at the **same `accountId`**.
  REPLACE = add-then-revoke (set the old row's `revokedAt`). **`accountId` and `username` never change.**

**Map invariants (secSys S2/S3/S4 — baked in):**
- **N:1** — many credentials → one `accountId` (the per-device-key future; v1 = one account-level
  fingerprint shared across a device family). UNIQUE on `accountFingerprint` (PK); index on `accountId`.
- **Bind-once / append-only** — a credential binds to exactly ONE `accountId`, set ONCE at first bind.
  **Re-pointing an existing credential to a different `accountId` is forbidden** (or a heavily-gated
  sensitive op) — this is what stops an attacker rebinding a victim's credential.
- **Possession-proof to bind an EXISTING account** — recovery / QR-join / add-credential into an existing
  `accountId` REQUIRES proof of current-account control: a fresh signed challenge from an active credential
  (F9 step-up) and/or the QR OOB confirmation code (PIN-ID-7). An attacker without the mnemonic can never
  reach the `accountId`, re-point a `username`, or bind their credential to a victim's account.
- **Last-active-credential lockout guard** — an account must always retain ≥1 credential that can
  authenticate (a recovery path the mnemonic re-derives). v1: the mnemonic is the floor, so revoke ≠
  lockout (F1/D5 honest limit). The guard is load-bearing for the per-device-key future — state it now.
- **`accountId` properties** — server-assigned **random ≥16B base64url, IMMUTABLE, never client-supplied**,
  resolved server-side from the credential→account map. (An enumerable/forgeable/client-trusted `accountId`
  ⇒ cross-account.)

---

## 4. Recovery + QR-join re-association

The key property: **same mnemonic → same signing key → same `accountFingerprint` → same `accountId` →
same `username`**, with **no explicit re-association step**.

- **Recovery (`enrollExisting(mnemonic)` on a fresh device):** re-derives the signing key →
  authenticates / registers a new device row under the same `accountFingerprint` → server resolves
  `accountFingerprint → accountId` via `accountCredentials` → returns `accountId` (and the current
  `username`) to the client. Local unlock crypto is **unchanged**; `accountId` is recovered *from the
  server mapping*, not re-derived on-device.
- **QR-join (PIN-ID-7):** the QR encodes the root mnemonic (full takeover; out-of-band confirmation code
  REQUIRED — unchanged). The joining device derives the same signing key → same `accountFingerprint` →
  same `accountId`. New `keyId`/device row, same account. **No username/account re-association needed.**
- **The only flow that re-associates is auth-method ADD/REPLACE** (§3) — and that is a *new* credential
  binding to an *existing* `accountId`, gated by proof of current-account control (secSys §7), not a v1
  path. The model leaves room for it without reshaping anything.

Client persistence: the client stores `accountId` alongside `keyId` (localStorage is fine — `accountId`
is not a secret and is not a bearer). **F7 unchanged: the session token stays in-memory-only**
(`session-token-in-memory-only`); `accountId`/`username`/`keyId` are non-secret identifiers.

---

## 5. The data dimension keyed on `accountId` (rescopes the deferred tenancy fix)

This **replaces** `tenancy-grant-account-relative`'s `accountFingerprint` key with `accountId`. Two-layer
control, unchanged in shape from secSys's sweep — only the key changes:

1. **PRIMARY (fail-closed, load-bearing): per-query `accountId` scope.** `notes.accountId` column; **every**
   data + sync query filters `WHERE accountId = principal.id` (= the caller's `accountId`, §6) — id-keyed CRUD **and** the
   `notebookId`-keyed paths (sync push/pull, `note.search`) that the sweep flagged. Physical row
   isolation: A's and B's "notebook-X" become distinct invisible rows under `(accountId, notebookId)`.
   Cannot be bypassed by a forgotten `can()` arg. **Routed through ONE helper that REQUIRES the caller
   `accountId`,** so no handler can omit it.
2. **BELT (defense-in-depth): `can()` ownership assertion.** The grant carries `accountId`; the resource
   reports its owning `accountId`; `can()` denies on mismatch. This is only as strong as resources
   reporting their account, so it is the belt — the data-layer scope is primary.
3. **WRITE path stamps server-side:** `note.create` / `insertNote` set `accountId` from the authenticated
   `principal.id` (the resolved `accountId`), **never** a body field (same F2 discipline) — else A writes a note tagged as B.

**The grant carries `accountId` (devSys2's hard constraint).** At `/session`, after verifying the signing
key, the server resolves `keyId → accountFingerprint → (map) → accountId` and stamps it on the grant row.
`resolveGrantByTokenHash` returns it; `resolvePrincipal` surfaces it onto the principal. **No per-request
`accountFingerprint → accountId` lookup** — Stream-D sync scoping reads the account straight off the
resolved grant.

> **`grants.principalId` — explicit decision (adopted from secSys S5 + S7 + devSys2):** **re-point
> `grants.principalId` from `accountFingerprint` to `accountId`.** The grant *becomes* account-keyed; this
> is what `resolvePrincipal` reads into `principal.id` (= `accountId`, §6). The minting **credential/device**
> is still tracked by `grants.mintedByKeyId` (already in `0002`), so **F2 binding + per-device revoke are
> preserved** — they key on the device key, not on the principal id. **No new `grants.accountId` column is
> needed** (principalId now *is* the account). For owner/device grants `principalId` = the owner's account;
> for **capability** grants `principalId` = the account that **owns the shared resource**, so the §5.1
> filter `WHERE accountId = principal.id` is **uniform across all principal kinds**.

**Migration safety (secSys S5 — mandatory, no wrong-account window):**
- **Atomic 1:1 re-point in ONE migration tx:** build the `accountFingerprint → accountId` map (UNIQUE on
  BOTH columns) **and** re-point `grants.principalId` (owner grants) in the **same transaction**, so
  `resolvePrincipal` ever sees old-world OR new-world rows, **never mixed**.
- **Deploy-together:** the migration and the `accountId`-aware `resolvePrincipal` ship as one unit. There
  must be **no window** where old code (treating `principalId` as a fingerprint) reads a migrated row
  (`principalId` = `accountId`) and resolves the **wrong account**.
- **New mints stamp server-side** (`keyId → fingerprint → map → accountId`), never a body field ⇒ cannot
  forge or cross-bind.
- **⚠ NOTES BACK-FILL CAVEAT (must be answered before the data migration runs):** notes carry **no owner
  column today**, so back-filling `notes.accountId` for EXISTING notes is **ambiguous** — there is no
  recorded owner. **Safe only if data is empty / single-account** (the Phase-1 pre-deploy reality). If any
  real multi-account data exists, this needs an **explicit owner-assignment decision — flag it, never
  silently assign.** (planSys flag F-acct-5, §8.)

**`listDevices` re-scope:** `GET /auth/devices` today scopes by `principal.id` (= fingerprint). With
`principal.id` = `accountId`, it re-scopes to the account — `devices` gains an `accountId` association
(a stamped column, or a join `devices.accountFingerprint → accountCredentials.accountId`). Devices are
*per-credential*, so the device list of an account = the devices of all its credentials.

---

## 6. Frozen-contract verdict — ADDITIVE, NOT a reopen ✅ (devSys; secSys S7 concurs)

The pilot's required check. **Confirmed additive — and stronger than "additive": ZERO schema delta.**

We considered two shapes and chose the one with no contract-schema change:

- **CHOSEN — re-point `Principal.id` to carry `accountId`.** `PrincipalSchema` stays
  `{ kind, id: z.string().min(1) }` — **byte-for-byte unchanged**. `id` is documented as the *"stable
  identifier for this principal"*; `accountId` (immutable, credential-independent) is the **truer** stable
  identifier than `accountFingerprint` (credential-derived, changes when auth changes). So this is a
  **semantic re-point of how `id` is filled, not a schema change**. Only `resolvePrincipal`'s resolution
  logic, `grants.principalId`, the worker DB, and the `Principal.id` **docstring** change. secSys S7 reaches
  the same conclusion.
- **Alternative (rejected) — add a new `accountId` field to `PrincipalSchema`.** A clean additive field,
  but it (a) touches the frozen schema + every constructor + the freeze fixtures, and (b) leaves `id`
  holding the *less*-stable credential fingerprint — odd for a field literally named "stable identifier."
  The re-point is less invasive to the contract and makes `id`'s documented meaning *true*.

**Why the union is not reopened, either way:**
- **`PrincipalVerificationSchema` is byte-for-byte UNTOUCHED.** The discriminated union keyed on `method`
  (`grant-token` | `capability` | `signed-request` | `unverified`) does not change. The proof model is
  unchanged: a request still proves identity by the **signed-challenge → opaque grant-token** path
  (PIN-ID-2). **`username` is a directory label, not an auth method; `accountId` is an attribute of the
  *already-verified* principal — neither is a verification method.** Authority still keys **strictly on
  `verification.method`** + the server-resolved grant. **No new union member.**
- The `Principal` authn-only invariant is preserved verbatim: `id` (now `accountId`) is *established by the
  auth layer, NEVER trusted from the request body* — and `accountId` is server-assigned random, never
  client-supplied (§3, secSys S4), so the invariant is if anything **strengthened**.

**Work this implies (no shared-contract schema edit):**
- Update the `Principal.id` **docstring** in `grant.ts` to state it carries the account's stable
  `accountId` (server-resolved), with `accountFingerprint` demoted to the credential layer.
- `resolvePrincipal` / `principalForGrant` read `accountId` (from `grants.principalId`, re-pointed §5).
- `LOCAL_OWNER` dev stub: `id` = a fixed sentinel account (e.g. `'local-account'`); still refused in prod
  by the F13 tripwire.
- **Consistency sweep (secSys S7):** confirm **every** site that used `accountFingerprint` *as the principal
  id* moves to `accountId` — `listDevices` scoping (§5), any test fixture asserting `principal.id` = a
  fingerprint, the grant-mint principal construction.
- Add/adjust a **contract test** asserting `Principal.id` is server-set and rejected-from-body (the freeze
  fixtures already pin the union shape; this pins the invariant, not a new field).

**Verdict: ADDITIVE, NOT a reopen — in fact ZERO schema delta.** The `PrincipalVerification` union and
`PrincipalSchema` are both unchanged; the change is a semantic re-point of `Principal.id` + new worker
tables. secSys S7 concurs.

---

## 7. Security surfaces — secSys (S1–S7)

> **Authored + committed by secSys** at `1da0216`, in **`docs/design/secSys-cross-account-sweep.md`**
> under *"Security Surfaces — account-identity model"* (banked there to avoid editing this doc
> concurrently). That is the durable, load-bearing security half — read it in full. Summarized here so
> the invariants are captured in this strawman, not only in secSys's doc:

- **Framing — two layers, never conflated:** **DIRECTORY** (`username → accountId`; server-arbitrated,
  mutable) vs **OWNERSHIP/AUTH** (`accountId` + the seed-sovereign signing key; self-sovereign,
  immutable). **INVARIANT: data ownership + authz key on the OWNERSHIP layer ONLY, never the directory** —
  so the blast radius of username squatting/change/even server-side directory poisoning is bounded to the
  directory and **cannot steal an account, its data, or its grants.**
- **S1 — username integrity:** identifier-NEVER-authenticator; atomic-unique INSERT-or-fail (no
  check-then-insert TOCTOU); NFC + casefold uniqueness on the folded form; conservative charset for
  confusables; reserved-name denylist; enumeration acceptable (public directory) but rate-limited and
  leaking only taken/available. Every reference resolves via `accountId`, so a re-claimed name inherits
  nothing.
- **S2 — recovery/QR re-association:** deterministic `mnemonic → key → fingerprint → (map) → accountId →
  username`; the map lookup is the **only** path; entries append-only; QR requires the OOB code (PIN-ID-7);
  **no re-point of an existing fingerprint→account / username→account / credential→account binding** without
  account-possession proof.
- **S3 — add/replace-credential:** binding a NEW credential to an EXISTING account REQUIRES current-account-
  control proof (F9 step-up); **last-active-credential lockout guard** (v1 mnemonic floor softens it; load-
  bearing for the per-device-key future — always keep ≥1 recovery path).
- **S4 — `accountId`:** server-assigned random **≥16B, IMMUTABLE, never client-supplied**, resolved
  server-side.
- **S5 — migration safety:** atomic 1:1 fingerprint→accountId re-point + `grants.principalId` re-point in
  ONE tx; migration + accountId-aware `resolvePrincipal` **deploy together** (no mixed window); new mints
  stamp server-side; **notes back-fill caveat** (§5, F-acct-5).
- **S6 — per-query `accountId` scope = PRIMARY fail-closed control** (now rekey-stable); covers
  notebookId-keyed paths too; `grantAllows` ownership = belt.
- **S7 — frozen-contract ADDITIVE, no reopen:** new tables/endpoints + `Principal.id` now filled with
  `accountId` (same shape, semantic fill — not a schema change); union stays CLOSED, no new method.

**secSys pre-sign-off verdict → planSys: CONDITIONAL-PASS on honoring S1–S7.** The two highest-stakes
invariants: **(i)** authz/data ownership key on `accountId`/signing-key only, never the username; **(ii)**
binding/re-association to an existing account ALWAYS requires account-possession proof. The S5 migration is
the one-time risk window (atomic re-point + deploy-together), and the notes back-fill caveat must be
answered before the data-dimension migration runs.

---

## 8. planSys-assumption check (D6) — confirmations + flags (devSys)

**Confirmed:**
- **username = stable handle + anchor** — confirmed *with a refinement*: the immutable **anchor is
  `accountId`**; `username` is the human-facing alias that rides on it. If username rename is ever enabled,
  `accountId` is still the thing nothing points away from. Recommend v1 rename off until cooldown lands.
- **LOCAL passkey/phrase unlock UNCHANGED** — confirmed. `accountId`/`username` are server-side account
  constructs; the mnemonic → signing-key derivation, the KeyStore WebAuthn local-unlock, and the at-rest
  blob are all untouched. The client merely learns + stores its server-assigned `accountId` (non-secret).
- **credential-independent, methods add OR replace** — confirmed by the accounts ↔ `accountCredentials`
  split; `accountId`/`username` are invariant across add/replace.

**Flags for planSys:**
- **F-acct-1 (do-not-rip-out):** `accountFingerprint` is NOT removed — it's demoted to the credential id
  and keeps F2 binding + per-device revoke (via `mintedByKeyId`). We **re-point** `grants.principalId`
  (fingerprint → accountId) and **add** `accounts` + `accountCredentials` + `notes.accountId` + `usernames`
  + a `devices`↔account association. No `grants.accountId` column (principalId becomes the account).
- **F-acct-2 (self-sovereignty boundary):** the username namespace is server-arbitrated — a deliberate step
  from pure seed-only self-sovereign identity toward an account handle (the D6 tradeoff). The cryptographic
  account (signing key) stays seed-sovereign; only the human alias depends on the server. Acceptable for a
  shared multi-account service; surfaced so it's an explicit product call, not an accident.
- **F-acct-3 (frozen-contract route — confirm):** §6 chooses the **zero-schema-delta re-point** of
  `Principal.id` to `accountId` over adding a field. Confirm planSys ratifies the re-point (it makes `id`'s
  documented "stable identifier" meaning true) + the `Principal.id` docstring update + the consistency
  sweep (secSys S7), vs the rejected add-a-field alternative.
- **F-acct-4 (enumeration oracle):** the username uniqueness/availability check is an account-existence
  oracle; secSys S1 rules it acceptable (public directory) **with** rate-limit + leak-only-taken/available.
  Flagging so it's scoped as a real Phase-1 surface, not assumed-free.
- **F-acct-5 (notes back-fill — needs an answer before the data migration):** notes have **no owner column
  today**, so back-filling `notes.accountId` for existing rows is ambiguous. Safe **only** if data is
  empty / single-account (the Phase-1 pre-deploy reality — confirm). If any real multi-account data exists,
  an explicit owner-assignment decision is required — **never silently assign** (secSys S5).
