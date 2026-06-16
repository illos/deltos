# secSys targeted sweep — account-ownership on object-scoped routes (bug-class root-cause)

**Author:** secSys · **Trigger:** the revoke BOLA (cross-account device revocation) + planSys root-cause
propagation ask — audit EVERY object-scoped route for account-ownership, not just revoke. · **Date:** 2026-06-16

## Verdict

The revoke BOLA was **one instance of a systemic bug-class**: **no object-scoped route enforces
account-ownership**, because the **data layer has no account dimension** while the **auth layer is
multi-account** and the v1 session grant is **workspace-wide** (covers every resource).

## Structural facts (definitive, code-verified)

1. **Data model carries no owner/account column.** `notes` = (id, notebookId, title, properties, body,
   version, createdAt, updatedAt, deletedAt) — no `accountFingerprint`. There is **no `notebooks`
   registry**: `notebookId` is a bare client-supplied string bound to no account. `notebookSyncSeq`
   has no account either. (migrations 0000/0001.)
2. **The grant covers everything.** A v1 session grant is `resource = {kind:'workspace'}`,
   `scope = all SCOPES`. `can()` → `grantAllows` → `resourceCovers(workspace, X) === true` for ALL X.
   So ANY authenticated principal is authorized for ANY note/notebook id.
3. **Handlers filter by id/notebookId only — never by the principal's account.** The principal's
   `id` (= accountFingerprint) is **never used to scope a data query** in any note/sync handler.
4. **The smoking gun (asymmetry):** `GET /api/auth/devices` IS account-scoped —
   `listDevices(principal.id)`, and its test asserts "excludes other accounts." EVERY other
   object-route omits the same scoping. The correct pattern exists; it wasn't applied.

## Affected routes (the whole class)

| Route | Object id | Account-scoped? | Impact if multi-account |
|---|---|---|---|
| `GET /notes/:id` | note UUID | NO | read any account's note |
| `PATCH /notes/:id` | note UUID | NO | overwrite any account's note |
| `DELETE /notes/:id` | note UUID | NO | delete any account's note |
| `POST /notes/:id/blocks` (block.append) | note UUID | NO | mutate any account's note |
| `PUT /notes/:id/props/:key` (property.set) | note UUID | NO | mutate any account's note |
| `GET /notes/search` (no notebookId) | — | NO | **search ALL accounts' note titles/content** (disclosure + enumeration) |
| `POST /sync/push` | notebookId | NO | write into any account's notebook |
| `GET /sync/pull` | notebookId | NO | read any account's notebook |
| `POST /auth/devices/:keyId/revoke` | device keyId | NO | cross-account device revoke (the found BOLA) |
| `GET /auth/devices` | — | **YES** (`principal.id`) | correctly scoped — the model to copy |

## Conditional severity — depends on TENANCY (escalated, not unilaterally resolved)

- The `devices` table is **multi-account**: `accountFingerprint` column **+ a `devices_byAccount`
  INDEX**. An index on accountFingerprint only makes sense with multiple accounts to filter among →
  strong evidence the backend is a **shared multi-account D1**.
- **Under a shared multi-account backend → CRITICAL:** any authenticated account can
  read/write/delete/search every other account's notes. Far worse than the revoke DoS (this is data
  disclosure + tampering, not just denial).
- **IF deployment is strictly single-tenant-per-account** (one isolated D1 each — **not evidenced
  anywhere**; phase-1-vertical-slice.md:217 even flags an unresolved "deeper question" to scopeSys),
  it is a non-issue for data, and the device-registry account columns are vestigial.
- **Tenancy is NOT explicitly documented.** This is an architectural fork for pilot/planSys/user to
  confirm before fix scope is set.

## Fix shape (architectural — NOT per-route 404s) — devSys-scoped + secSys-reviewed

The revoke one-line 404 guard fixes only the device instance. The CLASS fix is structural but
**well-bounded — NOT a rebuild** (cost note for the tenancy cost/benefit):

**devSys's framing (grant/can() owner), confirmed sound:** the grant ALREADY carries the CALLER's
account — `resolvePrincipal` surfaces `principal{kind:'owner', id:accountFingerprint}`, so `can()` has
the caller account in hand. The ONLY missing piece is the **RESOURCE's owning account** (notes carry no
account column today). `grantAllows`/`resourceCovers` is account-BLIND: a workspace grant returns
`resourceCovers = true` for ANY resource, so under multi-account a grant for account A authorizes B's
notes. Clean split: **(data layer)** add an owner column + scope every query; **(grant)** `grantAllows`
adds "grant.account must own the resource" once resources report their account.

The bounded fix:
1. **One data-layer column:** `notes.accountFingerprint`. A SEPARATE notebooks→account registry is NOT
   required — with a per-note account column + universal per-query filtering, `(accountFingerprint,
   notebookId)` becomes the effective key: A's and B's `notebook-X` are distinct rows, each invisible to
   the other. (A notebooks-ownership table is an optional nicety, not a prerequisite.)
2. **Every query filters by the caller's `principal.accountFingerprint`** — id-keyed (CRUD) AND
   notebookId-keyed (sync push/pull, search). secSys: this DATA-LAYER scope is the **LOAD-BEARING**
   control — physical DB isolation, fail-CLOSED (wrong/blind account ⇒ no rows ⇒ 404), and it cannot be
   bypassed by a handler forgetting a `can()` argument. Route all data access through ONE helper that
   REQUIRES the caller account, so no handler can omit it (the split's only gap-risk is a route covered
   by neither layer).
3. **Write path stamps ownership server-side:** `note.create`/`insertNote` set `accountFingerprint` from
   the authenticated `principal`, NEVER a client/body field (same F2 discipline — owner is computed, not
   trusted). Otherwise A could write a note tagged as B's.
4. **`grantAllows` account-relative ownership check** (defense-in-depth): once the resolved resource
   reports its owning account, deny unless `grant.account === resource.account`. secSys note: this is
   only as strong as resources reporting their account at `can()` time (resource currently = `{kind,id}`
   with no owner; surfacing it needs a lookup or a resource-account field), so it is the BELT, not the
   primary — the data-layer scope (2) is the load-bearing control.

Net cost: one column + a per-query scope helper + a write-path stamp + one `can()` assertion + the
two-account test class. Bounded, mechanical, no architectural rebuild.

## Standing test class (make the bug-class non-recurring)

Root cause of the blind spot: **every existing test seeds ONE account.** The fixture must seed TWO.

- **Harness fixture (gruntSys):** a reusable "two-account" fixture — enroll accounts A and B, seed
  B-owned objects (note, notebook, device), then for EVERY object-scoped route assert that a principal
  for account A is **denied** (404/403) on B's object and that B's object is unchanged.
- **Stream-D checklist item:** "Every object-id route has a cross-account-deny test." No object-route
  ships without one.
- This converts the cross-tenant negative into a permanent regression class.

## Routing

Tenancy confirmation → pilot/planSys/user FIRST (sets fix scope). Class fix → devSys (substrate +
grant model) + scopeSys (route queries). Standing test class → gruntSys harness + Stream-D checklist.

---

# Security Surfaces — account-identity model (D6 resolved + EXPANDED: accountId + usernames)

**Status:** secSys section of the account-identity strawman (devSys leads `account-identity-strawman.md`;
this is the durable secSys half + pre-sign-off pressure-test). D6 resolved MULTI-TENANT; ownership keys on
a stable random **credential-INDEPENDENT `accountId`** (NOT `accountFingerprint` — credential-derived
would force migration on auth-method change). Usernames added. **Pressure-test targets for planSys sign-off.**

## The load-bearing framing: TWO layers, never conflated (self-sovereignty separation)
- **DIRECTORY layer** — `username → accountId`. Server-arbitrated, mutable, public-ish, uniqueness-enforced.
- **OWNERSHIP/AUTH layer** — `accountId` (stable random) + the seed-sovereign signing key. Self-sovereign
  (rooted in the mnemonic; exists without server permission), `accountId` IMMUTABLE.
- **INVARIANT:** data ownership + authorization key on the OWNERSHIP layer ONLY, NEVER on the directory
  layer. Consequence: the blast radius of username arbitration/change/compromise (even server-side
  directory poisoning) is bounded to the directory — it CANNOT steal an account, its data, or its grants
  (those key on `accountId` + the signing key, which a username re-point does not touch). This is what
  makes server-arbitrated usernames acceptable atop self-sovereign accounts.

## S1 — username namespace integrity & arbitration
- **username = identifier, NEVER an authenticator** (PIN-ID-1 analog). Authz keys on `accountId` only;
  EVERY reference resolves via `accountId`, never the username string — so a released+re-claimed username
  inherits NOTHING from the prior owner.
- **Atomic-unique claim:** UNIQUE constraint on the normalized form + INSERT-or-fail (rows-affected=1),
  NEVER check-then-insert (registration-race TOCTOU). Same CAS discipline as the auth challenge consume.
- **Normalization:** NFC + casefold; uniqueness on the FOLDED form; trim whitespace; reject
  zero-width/control chars. ("Alice"/"alice"/"ALICE" must collide.)
- **Confusables/homoglyphs:** v1 robust defense = a conservative charset (e.g. `[a-z0-9_-]`), reject
  out-of-charset at the boundary. (Heavier future option: Unicode TR39 skeleton for the uniqueness key.)
- **Reserved-name denylist** (admin/root/system/support/official/…) to prevent authority impersonation.
- **Enumeration:** an availability/registration endpoint is inherently a taken/available oracle — acceptable
  (the directory is public by design) but rate-limit it and leak nothing beyond taken/available (no
  `accountId`, no timing distinction). Knowing a username authorizes nothing (it is a label).

## S2 — recovery + QR-join re-association (NO re-association attack surface)
- Deterministic chain: same mnemonic → same signing key → same `accountFingerprint` → (map) → same
  `accountId` → same username. Each link server-resolved; the map lookup is the ONLY path to `accountId`.
- An attacker WITHOUT the mnemonic cannot produce the `accountFingerprint`, so cannot reach the `accountId`
  (mnemonic = irreducible floor, F1). QR-join encodes the mnemonic + REQUIRES the OOB confirmation code
  (PIN-ID-7) to defeat join-hijack MITM.
- **No re-association:** an attacker must NOT be able to (a) re-point an existing `accountFingerprint→
  accountId` map entry, (b) re-point a `username→accountId` to an account they do not control, or (c) bind
  their own credential to a victim's `accountId`. All require account-possession proof (mnemonic-derived
  signature / OOB) the attacker lacks. Existing map entries are append-only / immutable-once-set;
  re-pointing is forbidden, or a heavily-gated sensitive op requiring current-account-control proof.

## S3 — add/replace-credential authz + last-credential lockout guard
- Binding a NEW credential to an EXISTING `accountId` MUST require proof of CURRENT account control — a
  fresh signed-challenge with the existing account signing key (F9 step-up). Else anyone adds their
  credential to your account.
- **Lockout guard:** removing/revoking the LAST credential that can authenticate = permanent lockout.
  v1 (account-level key from the mnemonic): the mnemonic is the floor → revoke ≠ lockout (F1/D5 honest
  limit), re-`enrollExisting` always works. As this evolves to per-device keys (option b) the guard becomes
  load-bearing: enforce "at least one recovery path (a credential the mnemonic re-derives, or an explicit
  recovery credential) ALWAYS exists." State it now so the per-device-key future cannot introduce lockout.
- Replace = add-then-remove: current-control proof on add + the lockout guard on remove.

## S4 — accountId properties
Server-assigned random **≥16B**, **IMMUTABLE**, **never client-supplied**, resolved SERVER-SIDE from the
credential→account map. (Enumerable/forgeable `accountId` + any client-trusted use ⇒ cross-account.)

## S5 — migration safety (re-point existing accountFingerprint keys → accountId; devSys2's surface)
Existing migration 0002 binds on `accountFingerprint` (devices.accountFingerprint, grants.principalId for
owner grants). Re-pointing to `accountId` must have NO wrong-account window:
- 1:1 `fingerprint→accountId` map, UNIQUE on BOTH columns, built in ONE migration tx WITH the
  grants.principalId re-point → resolvePrincipal sees old-world OR new-world, never mixed.
- Migration + the accountId-aware resolvePrincipal DEPLOY TOGETHER — no window where old code
  (principalId-as-fingerprint) reads migrated data (principalId-as-accountId) and resolves the wrong account.
- New mints stamp `grant.principalId = accountId` resolved server-side (`keyId→fingerprint→map→accountId`),
  never a body field ⇒ cannot forge or cross-bind.
- **notes back-fill CAVEAT:** notes carry no owner column today, so back-filling `notes.accountId` for
  EXISTING notes is AMBIGUOUS (no recorded owner). Safe only if data is empty/single-account (Phase-1
  pre-deploy). Any real multi-account data needs an explicit owner-assignment decision — flag, never
  silently assign.

## S6 — per-query accountId scope = LOAD-BEARING (carry-forward, now keyed on accountId)
The data-layer per-query account scope (from the sweep above) is the PRIMARY fail-closed control; it now
keys on the stable `accountId`, so it SURVIVES a credential/auth-method rekey with no data migration (the
whole point of the rescope). Must cover notebookId-keyed queries (sync push/pull, search), not just
id-keyed CRUD; writes stamp `accountId` from the principal, never a body field. `grantAllows` ownership
check = defense-in-depth belt.

## S7 — frozen-contract: ADDITIVE, no reopen
New tables/endpoints (accounts, username registry, credential→account map) + `Principal.id` now populated
with `accountId` (same `{kind,id:string}` shape — a semantic change in how it is filled, not a schema
change). **`PrincipalVerificationSchema` union stays CLOSED — NO new method** (username is a directory
label, not an auth method; auth stays credential→grant-token). Confirm every site that used
`accountFingerprint` as the principal id moves to `accountId` consistently.

## Pre-sign-off verdict (secSys → planSys)
The expanded model is sound and the accountId rescope is the right call (strengthens S6 — ownership key is
now rekey-stable). CONDITIONAL on the strawman honoring S1–S7, with the two highest-stakes invariants being:
**(i)** authz/data ownership key on `accountId`/signing-key ONLY, never the username (S-framing/S1), and
**(ii)** binding/re-association to an existing account ALWAYS requires account-possession proof (S2/S3).
The migration (S5) is the one-time risk window — atomic 1:1 re-point + deploy-together, and the notes
back-fill caveat must be answered before the data-dimension migration runs.
