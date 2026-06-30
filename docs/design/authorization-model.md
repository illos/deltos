# Authorization model — the canonical ACL (ROAD-0005 Phase 1)

> Status: **LOCKED design** (2026-06-30). This is the contract every credential in deltos conforms to —
> agent tokens (shipped), OAuth clients, share links, user-to-user shares, collaborators, plugin scopes,
> and write-tool grants. The point of Phase 1 is to ratify ONE model so each later capability is *a grant
> on this ACL*, never a parallel special-case. Source of truth in code: `packages/shared/src/api/grant.ts`
> + the `can()` chokepoint in `packages/worker/src/auth.ts`.

## 0. One primitive, one chokepoint (ratified)

Authorization is a single primitive evaluated at a single seam. A **grant** is `(principal, resource,
scope[], constraints)`; every API call resolves a **principal**, names a **resource** + an **op**, and
passes through exactly one check:

```
can(principal: RequestPrincipal, op: Op, resource: Resource): Promise<boolean>
```

A share link, an agent token, a plugin scope, an OAuth client, and a collaborator are the **same grant** —
they differ only in *how the bearer is delivered* and *which principalKind* they carry. This is already
the shipped design (`grant.ts:4-10`); Phase 1 ratifies it as canonical and forbids special-cases.

## 1. The axes (the locked vocabulary)

- **Principal** = `{ kind, id }` (`PrincipalSchema`). Server-derived from verified credentials, **NEVER**
  read from the request body. `id` is the **accountId** for owner/device (the stable, random,
  credential-independent ownership key — D6/migration 0003), or the capability/agent/plugin id otherwise.
  - `PRINCIPAL_KINDS = [owner, device, guest, anonymous, agent, plugin]`.
    - **owner** — the human account holder's session. LIVE.
    - **agent** — a minted API/MCP token acting AS the owner's account. LIVE (shipped).
    - **device** — per-device-keyed session. RESERVED (Phase-2 device keys; see §4).
    - **guest / anonymous** — share-link / public-link grantees. RESERVED (sharing phase).
    - **plugin** — capability-scoped plugin grant. RESERVED (plugin capability phase).
- **Resource** = discriminated union `workspace | notebook(id) | note(id)` (`ResourceSchema`) — a
  coarse-to-fine hierarchy. `resourceEquals` is structural (never reference) equality.
- **Scope / Op** = `[read, write, create, delete, share, search]` (`SCOPES`). The op passed to `can()` is
  exactly one of these. `share` is the meta-capability: it authorizes managing access (mint/list/revoke
  tokens, create shares) — an agent token is clamped to NOT hold it, so it can never widen access.
- **Constraints** = `GrantConstraintsSchema`, `.strict()` and **fail-closed**: an unrecognized key rejects
  at the parse boundary, so an evaluator predating a new constraint refuses the grant rather than honoring
  a strictly-more-permissive subset. Today: `expiresAt?` (note: agent tokens set none — non-expiring by
  design, `[[agent-tokens-non-expiring-by-design]]`). Future restrictions (rate, origin, row-filters) are
  versioned additions to THIS schema.
- **Verification** = `PrincipalVerificationSchema`, a `.strict()` discriminated union on `method` —
  *how the caller proved identity THIS request* (set by the auth middleware from what it actually verified;
  never from the body; a client cannot select `unverified`):
  - `grant-token` — steady-state opaque bearer → resolved grant row (`grantId`, never the raw token).
  - `capability` — share-link / agent / plugin capability grant (same resolved shape).
  - `signed-request` — a fresh per-request signed intent for SENSITIVE ops, carrying the `op`+`resource`
    the signature was verified for. **RESERVED, not dead** (see §4).
  - `unverified` — dev-only local stub; carries no proof; refused in production by the chokepoint tripwire.

## 2. The decision rule (the load-bearing output of P1)

**Every new credential is a grant on this ACL.** Before building any access-granting feature, map it onto
the axes above; if it doesn't fit, the gap is a *deliberate, versioned* extension to this model — never a
side-channel. The mapping for everything on the roadmap:

| Capability | principalKind | verification | resource | scope | notes |
|---|---|---|---|---|---|
| Agent/MCP token (shipped) | `agent` | `capability` | workspace/notebook | clamped `[read,search]` | acts AS owner account |
| OAuth client (P-cap) | `agent`* | `capability` | per consent | per consent (read-only v1) | the issued token IS a grant (reuses the agent-credential path) — *but needs a **client-identity axis** the model lacks; see §2a |
| Share link (sharing) | `guest`/`anonymous` | `capability` | notebook/note | `[read]` (+`write` later) | bearer = the link; grantee ≠ resource owner → §3 |
| User-to-user share | `guest` (a B account) | `capability`/`grant-token` | notebook/note | per share | grantee B, data-scope = owner A → §3 |
| Collaboration | as share | as share | notebook | `[read,write]` + realtime | same grant + a Durable-Object transport (deferred-designed) |
| Plugin scope | `plugin` | `capability` | per manifest | per manifest | capability-scoped, host-enforced |
| Write tools (P-cap, LAST) | `agent` | `capability` | as token | widen to `[…,write,create]` | a scope widening on the agent grant, gated by human-in-loop + audit |
| Step-up (sensitive ops) | n/a | `signed-request` | exact op+resource | n/a | **FUTURE/F9 only** — step-up TODAY is inline `verifyStepUp` (password/TOTP), NOT routed through `can()`; the `signed-request` branch is currently dead (§4) |

### 2a. OAuth needs a client-identity axis (flagged now — OAuth comes first)

"OAuth client → `agent` + `capability`" is achievable for the *authorization decision* (the issued token is
a grant row, bearer-resolved through `can()` exactly like an agent token). But an OAuth deployment has a
**client-identity dimension the grant model does not carry**: *which registered OAuth client* a token
belongs to — needed for per-client revocation, consent/audit records, per-client rate limits, and the
connected-apps kill-switch UI (P2). The grant schema is `principal{kind,id} + resource + scope +
constraints`; agent tokens have only a cosmetic `label`, no structured client identity. So before OAuth
builds, the model needs a **deliberate, versioned extension** — either a `clientId` column on `grants` or a
distinct `oauth_client` principalKind — decided in the OAuth design, NOT improvised as a side-channel (§0).
This is the same *class* of gap as §3's grantee split: the primitive holds, but a capability needs one more
ratified axis.

## 3. The grantor/grantee extension (the ONE structural gap — locked design, deferred impl)

**The gap (from the cross-account recon):** today a grant fuses *actor identity* and *data-scope* into a
single `principal.id`. Even an agent token sets `principal.id = the OWNER's accountId` — it acts *as* the
owner. Every reader keys `WHERE accountId = caller.id`, and the ownership belt asserts
`resourceAccountId === grant.principal.id` (`auth.ts`). This is correct for self-access but **cannot express
"account B may read account A's notebook X."**

**The locked extension** (for sharing/collab; implementation deferred to the sharing phase):
1. A grant's `principal` becomes the **grantee** (the actor, B) — distinct from the **resource owner** (A).
2. The data-scope resolves from the **resource's owner account**, looked up from the resource id —
   **not** the caller's `principal.id`. So "read notebook X" means "read X's owner's rows for X," gated by
   a grant that authorizes B on X.
3. `resourceCovers()` / the ownership belt must allow `resourceOwner ≠ caller` **when a covering grant
   exists**, and deny otherwise (fail-closed).
4. The ~6 single-owner readers (`getNoteForAccount`, `pullSince`, sync CAS, `notebooks.*`, `dictionary.*`,
   MCP tools) re-scope to *resource owner* — enumerated in `docs/design/secSys-cross-account-sweep.md`.

**Reality check — the deferred impl is BIGGER than a reader re-scope.** The current data layer has **no
resource-id→owner-account resolver**: every ownership query is caller-account-relative
(`getNoteForAccount(db, id, accountId)`; `notebooks.ts:21` `WHERE id=? AND accountId=?`). There is no
"given a note id, who owns it?" lookup. And the `resourceAccountId` ownership belt in `grantAllows`
(`auth.ts:130-143`) that step 3 relies on is **plumbed but never invoked** — `can()` calls
`grantAllows(grant, op, resource, now)` with no `resourceAccountId` (`auth.ts:184`), and no route calls
`grantAllows` directly. So the sharing-phase impl is **net-new infrastructure** — build an owner-resolver,
ACTIVATE the currently-inert belt, AND re-scope the readers — not merely "flip ~6 `WHERE accountId=?`
clauses." Locking the *design* here is right; the *effort/estimate* is larger than the recon implied, and
activating the belt is a fail-OPEN risk if done wrong (it must deny when no covering grant exists).

**What P1 does NOT do:** it does NOT ship an unused grantee schema column or flip any reader (YAGNI + no
speculative migration). The column + resolver + belt-activation + reader re-scoping land *with* the sharing
feature, which is the only consumer. P1 LOCKS the design above so OAuth and write-tools (which come first)
are built knowing the grantee split is coming, and don't bake in `caller.id == data-owner` assumptions that
sharing would then have to unwind.

## 4. Dead-but-retained vs orphaned (the reconciled truth)

A recon pass recommended removing `signed-request`, the `authChallenges` machinery, and the device-key
plumbing as "dead passkey residue." The recon was RIGHT that they are unused; it was wrong to recommend
*deleting* `signed-request`. The code-reconciled picture (an earlier draft of this section over-corrected
to "active reserved contract" — also wrong):

- **`signed-request` — DEAD in the live path, but deliberately RETAINED (do not delete the union member).**
  The chokepoint itself calls it dead: `auth.ts:187-192` — *"DEAD post-pivot: the 2026-06-17 password
  pivot deleted the signed-challenge stack, so NOTHING constructs a `signed-request` principal any more
  (step-up is now a password/TOTP re-prompt)."* No live path constructs it; the `can()` branch is
  unreached. YET `grant.ts:114-118` directs *"DO NOT delete in a dead-code sweep"* — the union MEMBER (the
  type slot) is kept on purpose so the F9 step-up-through-`can()` consolidation is non-breaking. Both
  comments are true: **unwired/dead today, contract-slot reserved.** Don't delete the type; don't describe
  it as active.
- **Device-key plumbing — ORPHANED by the pivot, retained on-spec only (NOT active contract).**
  `registerDevice`/`getDevice`/`revokeByKeyId` have **zero live callers** (`authStore.ts` interface+impl
  only; doc-comment mentions in `authPolicy.ts`). Session mint writes `mintedByKeyId: null` and never
  registers a device. It is genuinely dead today, kept against a Phase-2 per-device-key plan that has not
  started. **Keep-or-remove is an OPEN call** (removal = a migration dropping the `devices` table +
  `mintedByKeyId`/`signingPublicKey` columns + the grant-insert touch); P1 defers that call but records it
  as *orphaned*, not load-bearing.

**P1 removes nothing** — the `signed-request` member is keep-directed, and the device-key teardown is a
deferred, migration-heavy judgment call, not a clear win. But a maintainer must be able to tell
*reserved-on-a-real-plan* from *orphaned-by-the-pivot*; this section now draws that line. (Lesson cuts both
ways: "looks unused → delete" is unsafe against keep-directed slots, and "don't delete → it's active
reserved contract" is the opposite over-correction. Read the source; reconcile *all* the comments.)

## 5. Fail-closed invariants (the security spine — must hold for every capability)

1. **Parse-boundary only today:** `GrantConstraintsSchema.strict()` rejects an unrecognized constraint key
   when a grant is *parsed* (no fail-open superset). But note the runtime gap: `can()`/`grantAllows`
   evaluate expiry off the flat `expiresAtMs` column (`auth.ts:90,137`) and **never construct/inspect a
   `GrantConstraints` bag** — so the `CanCheck` "deny on unevaluable constraint" obligation is currently a
   *schema* property, not a live `can()` behavior. When rate/origin/row-filter constraints land, runtime
   constraint evaluation MUST be wired into `can()` (and that wiring re-asserts this invariant).
2. The verification union is `.strict()` — no `.passthrough()`, so an unrecognized field can never confer
   authority.
3. The principal is **server-derived**, never the request body.
4. `unverified` is refused in production.
5. A capability/agent grant's scope is **clamped at mint** (an agent token can never hold `share`).

Every Phase-2+ capability MUST preserve all five. Any new principalKind/verification method is a versioned
change to `grant.ts`, reviewed against these.

## 6. Phase 1 outcome

- **Locked (design-reviewed + corrected, 2026-06-30):** this document — the canonical ACL, the decision-rule
  mapping, the grantor/grantee design, the dead-but-retained record. A design pressure-test caught and fixed
  three over-optimistic claims: §3's grantee impl is *net-new infra* (no owner-resolver; ownership belt
  inert), §2 OAuth needs a *client-identity axis* (§2a), §4 *mislabeled dead code as active* (now reconciled).
  Invariants #2–5 verified true in code; #1 is parse-boundary-only today.
- **Carry-forwards into later phases (the real value of this lock):**
  - **OAuth (next capability):** ratify a client-identity axis (`clientId` column or an `oauth_client`
    principalKind) BEFORE building — §2a.
  - **Sharing:** budget *net-new owner-resolution* + activating the inert `resourceAccountId` belt
    (fail-OPEN risk if mis-done), not just a reader re-scope — §3.
  - **Constraints:** wire runtime constraint evaluation into `can()` when rate/origin/row-filters land — §5#1.
  - **Cleanup (open call):** keep-vs-remove the orphaned device-key plumbing — §4.
- **No code removed; no schema shipped.**
- **Next (P2):** credential lifecycle generalizes the H1 step-up seam (`verifyStepUp`) + the connected-apps
  kill-switch UI, both on this model. Then P3 audit, P4 abuse, then capabilities (OAuth → FTS5 → write
  tools), each mapped through §2.
