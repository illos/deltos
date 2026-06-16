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
