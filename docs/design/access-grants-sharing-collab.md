# Access grants, sharing, and realtime collaboration — the concrete plan

> Status: **DESIGN (2026-07-03)** — investigation deliverable for ROAD-0011. No code ships with this
> doc. Charge from Jim: *"bring us a concrete plan, so we don't build any new features on broken
> assumptions."* Builds on the LOCKED Phase-1 ACL (`docs/design/authorization-model.md`) — this doc
> does not re-litigate it; it extends it to four concrete features and picks architectures.
> Companion reading: `docs/specs/plugin-support.md` §14 (the access axis), ADR-0001.

## 0. Inventory — what already exists (verified in code, not from memory)

The model was front-loaded better than the "did we miss steps?" question feared. Verified today:

| Piece | State | Evidence |
|---|---|---|
| One grant primitive: `(principal, resource, scope[], constraints)` | SHIPPED | `packages/shared/src/api/grant.ts:161-167` |
| Resource hierarchy `workspace \| notebook(id) \| note(id)` | SHIPPED | `grant.ts:54-59` |
| Principal kinds incl. `guest`, `anonymous`, `agent`, `plugin` | RESERVED in the enum | `grant.ts:12-19` |
| `share` scope (meta-capability; agents can never hold it) | RESERVED | `grant.ts:83`, clamp at `authPolicy.ts` |
| One chokepoint `can(principal, op, resource)` | SHIPPED | `packages/worker/src/auth.ts:174-204` |
| Grants table with `resourceKind`/`resourceId` | SHIPPED | `migrations/0002_stream-a-auth.sql:90-100` |
| Notebook-scoped agent-token **mint** (API level) | SHIPPED but see §1 | `routes/agentTokens.ts` (`req.notebookId` → notebook resource) |
| Notebook→note **hierarchy coverage** in evaluation | **MISSING (deliberate v1 gap)** | `auth.ts:106-111` — "exact match; hierarchy … a deliberate follow-up" |
| Grantor/grantee split (cross-account grants) | **LOCKED DESIGN, unbuilt** | `authorization-model.md` §3; ownership belt plumbed but inert (`auth.ts:130-145`, never invoked with `resourceAccountId`) |
| OAuth consent carries an RFC-8707 `resource` field | pass-through, unused | `routes/oauth.ts:248` |
| Plugin capability enum incl. `collaborative` | SHIPPED (hint only) | `client/src/plugins/runtime/manifest.ts:35` |
| Plugin-declared agent tooling (worker aggregates) | SHIPPED | `shared/src/mcp/agentTools.ts` |
| Sync boundary = bearer accountId, per-account `accountSyncSeq` | SHIPPED | `routes/sync.ts:102-190`; client cursor per account `syncEngine.ts:94` |
| Note bodies stored **plaintext** in D1 | SHIPPED | `migrations/0000_baseline.sql:25` (`body TEXT` JSON) — see §3 honesty note |

**Conclusion of the inventory:** nothing needs *unwinding*. Everything below is an activation or an
extension of ratified seams. The one place a shipped surface is ahead of its evaluator: a
notebook-scoped agent token can be *minted* today but cannot actually read its notes — MCP tools name
`{kind:'note', id}` resources (`mcp/tools.ts:253,385,420,455`), and `resourceCovers` is exact-match, so
a notebook grant only ever matches notebook-addressed ops. That is the first thing to fix.

## 1. Feature: MCP/agent resource scoping (the v1 build)

**Goal:** a token grantable to selected notebooks/notes, enforced at `can()`, pickable at mint and at
OAuth consent, visible and revocable in Connected Apps.

**Design:**

1. **Hierarchy coverage (the missing evaluator half).** `resourceCovers(granted, requested)` gains the
   notebook→note rule: a `notebook(X)` grant covers `note(N)` iff N currently belongs to X **in the
   grant's owning account**. This needs a resolver the chokepoint doesn't have (`can()` takes no DB
   handle today — `auth.ts:126`). Extension: the MCP/REST route resolves the principal, and passes an
   injected `resolveResourceOwner(resource) → { accountId, notebookId|null } | null` into an extended
   `canWith(ctx, principal, op, resource)`; `can()` without a resolver keeps today's exact-match
   behavior (fail-closed: a notebook grant + note resource + no resolver = deny). Semantics are **live**:
   coverage follows the note's *current* notebook — move a note out of a granted notebook and the token
   loses it; `notebookId = null` (All-Notes pool) is covered only by a workspace grant. This same
   resolver is the §2 owner-resolver — building it here is deliberate groundwork, one implementation.
2. **Grant sets (multiple selections per token).** The grants table holds one resource per row. "Selected
   notes/notebooks" = **N grant rows sharing one `tokenHash`** (same principal, same scope, same mint
   event); `resolveGrantByTokenHash` becomes resolve-all, and evaluation is any-of over live rows.
   Rejected alternative: a JSON `resources[]` column — it breaks the one-row-one-grant audit/revocation
   grain and complicates the belt. Per-row revocation falls out free (revoke one notebook from a token
   without re-minting).
3. **Mint UX.** Connected Apps manual mint gains a resource picker (workspace / pick notebooks / pick
   notes); the OAuth consent screen gains the same picker, seeded from the already-transported RFC-8707
   `resource` parameter (`oauth.ts:248`) when the client requests one. Both continue through the ONE
   clamp path (`clampAgentScopes` — `agentTokens.ts:108`, `oauth.ts:240`); the clamp is extended to also
   clamp the resource set (a client-requested resource the user unchecks does not survive).
4. **Display/audit.** Connected Apps rows show the resource set ("2 notebooks · 1 note"); audit events
   already carry grantId — add the resource set to the mint event detail.
5. **Least-privilege visibility already generalizes:** the tools/list filter keys on scope
   (`mcp/tools.ts:572-579`); optionally ALSO hide notebook-list results outside the grant — v1 keeps
   list_notebooks workspace-gated (a notebook-scoped token sees only its granted notebooks' metadata via
   the same coverage check).

**Why this is v1 of the whole program:** zero cross-account risk, immediately useful (scoped AI access),
and it forces the owner/notebook resolver + any-of grant evaluation that sharing (§2) and RTC (§4) sit on.

## 2. Feature: 1:1 read+write sharing (user↔user, inside the UI)

**Goal:** account B sees account A's shared notebook/note inside B's deltos UI, reads and writes it,
alongside B's own notes.

**The collision (why this is the deep one):** the sync boundary is the bearer's accountId — push CAS,
pull, and seq are all account-scoped (`routes/sync.ts:102-190`), the client store is being
account-isolated (#52), and every reader is caller-account-relative (`authorization-model.md` §3:
no resource→owner resolver exists; the ownership belt is inert).

**Architecture pick: a SECOND, grant-scoped sync feed ("shared-with-me"), not a widened main feed and
not a projection.**

- **Rejected — widen the main feed:** interleaving A's rows into B's `accountSyncSeq` stream corrupts
  the per-account cursor contract (B's cursor would have to advance on A's writes), makes revocation
  un-expressible (you can't un-send a seq), and re-opens the exact class of cross-account leak the
  Option-B boundary fix closed. The main feed stays **owner-only forever** (assumption guard #2).
- **Rejected — server projection (copy into B's account):** duplicates truth, requires write-back
  reconciliation between copies, and turns revocation into a data-deletion problem. Conflict-as-version
  would fork per-copy. No.
- **Picked — per-grant share feed:** a share = a grant row `{principal: {kind:'guest', id: B's
  accountId}, resource: notebook(X)|note(N), scope: [read(,write,create)], grantingAccountId: A}` (the
  §3-locked grantee split, activated: one new column `grantingAccountId` on grants — the resource's
  owner; the belt check becomes `resourceOwner === grant.grantingAccountId` instead of `=== principal.id`).
  New endpoints: `GET /api/sync/shared` — for each live share grant of the caller, pull the covered rows
  from **A's** stream using **A's `accountSyncSeq`** as the cursor basis, returned per-grant
  (`{grantId, rows, nextCursor}`); `POST /api/sync/shared` — write-scoped pushes, CAS against the note's
  own version exactly as today (`updateNote` CAS is note-row-relative, so it composes), stamped into
  **A's** seq so A's devices and every other grantee converge through their normal feeds. Conflict-as-
  version stays the safety net unchanged — a losing write becomes a version on the note, in A's account.
- **Client store:** shared rows land in the same Dexie tables with a **provenance key**
  `{ownerAccountId, grantId}` (additive schema version; own rows get `ownerAccountId = self` on
  migration). The #52 isolation rule generalizes: *partition by owner account*, not "one account owns
  the store." liveQuery merges own + shared for the UI; per-grant cursors persist beside the main cursor
  (`deltos.sync.shared.<grantId>`).
- **Revocation = FORK, not purge (DECIDED, Jim 2026-07-04 — supersedes the purge-on-revoke draft):**
  granting read+write is effectively giving the recipient a copy of the data, so un-sharing cannot
  claw it back. A revokes the grant row (or B "leaves the share"); the next `GET /api/sync/shared`
  returns `revoked: [grantId]` and the client **converts** that grant's local rows into
  recipient-owned copies — re-keyed to new note identities under B's account (a snapshot fork at
  revocation time) — instead of deleting them. The live link is broken: no further sync in either
  direction; both sides keep a full copy. Provenance (`forkedFromGrant`) is recorded on the copy.
- **Version attribution (required by the fork model):** every version row is tagged with the
  principal that made the edit (owner / recipient accountId / agent token), the same model as
  LLM-agent edit attribution. Both parties' histories stay honest across the fork boundary.
- **UI (DECIDED, Jim 2026-07-04 — supersedes the "Shared with me" section draft):** shared notebooks
  and notes appear **inline** among the recipient's own, marked with a **"shared" pill**. At the
  notebook level the pill is a marker only (no behavioral change); at the note level "shared" also
  becomes a **filter facet** when the planned filters system lands. Recipient edits ride the normal
  editor; **write access includes creating new notes** in a shared notebook (no separate opt-in bit).
- **Invitation flow:** A shares to `@username` (D6 directory lookup → accountId), which mints the grant;
  B sees the share appear (share feed lists grants where `principalId = B`). No accept step in v1
  (revocable both ways is the control; an accept ceremony is additive later).

## 3. Feature: read-only URL sharing (anyone with the link)

**Goal:** a note/notebook rendered read-only to any holder of a URL.

**Design:** a capability grant + a server-rendered public surface.

- **The grant:** `{principal: {kind:'anonymous', id: <grantId>}, resource, scope: [read], constraints}`,
  bearer = the URL token itself (`dltos_share_<32-byte CSPRNG>`; hash-stored like every credential,
  F6). Default **non-expiring, revocable** — consistent with [[agent-tokens-non-expiring-by-design]];
  expiry stays available via the existing `expiresAt` constraint for "share for a week" later.
- **The surface:** `GET /s/<token>` on the Worker — **server-rendered spine→output** (CONV-0004: the
  outbound render is `spine→output` on the server, never the client bundle), mounted like the OAuth
  consent surface as a separate, SW-independent surface (DEC-0005). Renders title + body read-only;
  notebook shares render a note list + per-note pages under the same token. Attachment blocks resolve
  through the existing hash-gated blob serving, access-checked against the same grant.
- **Enforcement:** the route resolves the token → capability principal → `can(principal,'read',
  resource)` — the SAME chokepoint; no parallel checker. Rate-limiting rides DEC-0004's two-tier
  model with a per-token bucket (a leaked URL can be throttled and then revoked; revocation is
  immediate — resolution is per-request).
- **Custody honesty (the part to say plainly):** note bodies are **stored server-readable today**
  (`0000_baseline.sql:25` — plaintext JSON in D1; server-side search and MCP reads already depend on
  this). URL sharing therefore adds **no custody regression** — it changes *authorization*, not
  *visibility to the server*. The E2E-sounding copy in older design material refers to credential/key
  custody, not note-body encryption. If deltos ever moves bodies to E2E, public URL sharing must switch
  to key-in-fragment links (`/s/<token>#<key>`) and server rendering of those notes stops being
  possible — that is a program-level fork to decide *then*; nothing in this design forecloses it, but
  no feature should half-adopt E2E assumptions now (assumption guard #7).
- **Exposure posture:** assume shared = leaked (plugin-support §14): the render includes nothing beyond
  the note — no owner identifiers beyond a display name A opts into, no notebook structure outside the
  grant, no api tokens/session state (it's a cookie-less static render).

## 4. Feature: realtime collaboration (the endgame — design now, build last)

**Current plan (confirmed):** Durable Objects as the substrate; collaboration gated per plugin — the
manifest already carries `PluginCapability = 'offline' | 'online-only' | 'collaborative'`
(`manifest.ts:35`), and plugin-support §14 maps collab to "a persistent write-grant + DO realtime."
Jim's sync directive already names RTC the endgame ("eventual = realtime push").

**Pressure-tested design:**

- **Authorization:** a DO session begins with a WebSocket upgrade to `/collab/note/<id>`; the upgrade
  handler resolves the bearer and requires `can(principal,'write',note(id))` — the SAME grant that §2
  minted; there is no DO-specific credential. The DO caches the decision with a short TTL and
  **re-validates periodically and on reconnect**; revocation also actively kicks: the revoke route
  RPCs the note's DO to drop that principal's sessions. (Grant re-check + kick = revocation is
  immediate even mid-session.)
- **Topology:** one DO per note (`idFromName(noteId)`) — the sequencer for that note's live session.
  Notebook-level collab is just per-note DOs; no notebook DO in v1.
- **Convergence model (v1 = sequencer, not CRDT):** the DO is the single writer while a session is
  live: clients send block-level ops; the DO orders them, applies to the spine, broadcasts, and
  **persists through the normal write path** (CAS into the owner's rows + `accountSyncSeq` stamp) so
  every non-live device — the owner's other devices, other grantees, agents — converges through the
  ordinary feeds of §2. Offline/disconnected edits keep today's conflict-as-version path; a live
  session simply makes conflicts rare rather than impossible. Full CRDT (per-block Yjs or similar) is
  a **per-plugin upgrade** later — which is exactly why collaboration is plugin-gated.
- **Per-plugin capability registration:** the manifest grows from the capability *hint* to a declared
  feature set per block type: `{ agentTooling?: …existing…, collaboration: 'realtime' | 'render-only' }`
  — mirroring the shipped plugin-declared-agent-tooling seam (`shared/src/mcp/agentTools.ts`; the
  worker/DO aggregates declarations, never hardcodes plugins). In a live session, blocks whose plugin
  declares `realtime` accept remote ops; `render-only` blocks broadcast whole-block replaces (viewers
  see updates; no intra-block merging). Core text blocks are the first `realtime` registrants.
- **What §2 must provide so RTC needs NO rework (the "build in accordance" list):** (1) grant
  evaluation reusable at WS upgrade — satisfied by using `can()` itself; (2) the resource→owner
  resolver so the DO persists into the owner's rows/seq — built in §1; (3) share-feed consumers
  tolerating server-authored writes (a DO write is just a write with A's seq) — inherent in §2's pick;
  (4) client store provenance-keyed — §2's Dexie change. No other prerequisites surfaced.

## 5. Phasing (each phase independently shippable; later phases never unwind earlier ones)

1. **P1 — agent resource scoping** (§1): hierarchy coverage + resolver, grant sets, mint/consent
   pickers, Connected Apps display. *Validated as the right v1:* no cross-account exposure, and it
   builds the resolver + any-of evaluation everything else uses.
2. **P2 — addressability + URL read-only sharing** (§3): stable share routes + the public render
   surface. Sequenced before 1:1 because it needs **no sync changes at all** and addressability is the
   long-flagged highest-leverage foundation (plugin-support §14 — also unblocks deep links/backlinks).
3. **P3 — the grantee split + 1:1 sharing** (§2): `grantingAccountId` column, belt activation
   (fail-closed review gate — secSys pass mandatory), share feed + client provenance + Shared-with-me UI.
4. **P4 — RTC** (§4): the DO transport + per-plugin collaboration registration, on the P3 grant.

## 6. ASSUMPTION GUARDS — binding on every feature built from today onward

1. **Every access decision goes through `can()`** with a real `(op, resource)` — no route or tool may
   check scopes/bearers ad hoc, and no new credential may bypass the grants table.
2. **The main sync feed is owner-only, forever.** Never interleave another account's rows into an
   `accountSyncSeq` stream; cross-account visibility is only ever a *separate, grant-scoped feed*.
3. **Never write a new reader that assumes `caller accountId == data-owner accountId`.** Take the owner
   as an explicit parameter; the grantee split will make them diverge. (Existing single-owner readers
   are enumerated in `secSys-cross-account-sweep.md` — that list must not grow.)
4. **Client-store code partitions by owner account** (provenance `{ownerAccountId, grantId}` on shared
   rows); nothing may assume "everything in Dexie is mine."
5. **Sync consumers must tolerate rows appearing without local edits (grant) and rows changing
   ownership in place (revoke → fork).** Revocation converts shared rows into recipient-owned copies
   under new note identities — it is neither note deletion nor a normal edit; UI and queue logic must
   not conflate it with either, and nothing may assume a row's owner is immutable for its lifetime.
6. **Plugins declare capabilities in the manifest; core aggregates.** MCP tooling, collaboration mode,
   render-only — never a hardcoded per-plugin branch in a core surface (the shipped agentTools seam is
   the pattern).
7. **Note bodies are server-readable by design today.** Features may rely on that (server render,
   FTS5, DO sequencing) — but no feature may *half-adopt* E2E (e.g., encrypt one surface's copies);
   flipping custody is a single program-level decision that revisits §3 and §4 wholesale.
8. **One clamp path for every mint surface** (`clampAgentScopes` + the resource clamp); `share` scope
   is never grantable to agents/capabilities — only a step-up'd human widens access.
9. **Unauthenticated surfaces are separate surfaces** (DEC-0005): SW-independent mounts, server-rendered
   via spine→output (CONV-0004) — never the app shell serving strangers.
10. **Revocation is immediate everywhere:** per-request resolution for HTTP, TTL + active kick for DO
    sessions; nothing may cache authority beyond its request/session re-check window.

## 7. Open decisions for Jim (each with a recommendation)

1. **v1 mint-picker granularity:** notebook-level only, or notes too? — **DECIDED (Jim, 2026-07-03):
   BOTH in v1, with picker shape matched to collection size — notebooks = list select (bounded set),
   notes = search select (unbounded set, search is the picker).** This shape is the standing pattern
   for every grant-resource picker (mint UX, OAuth consent, and the later share-sheet).
2. **Shared-with-me presentation — DECIDED (Jim, 2026-07-04): INLINE + "shared" pill.** No dedicated
   nav section. Shared notebooks/notes sit among the recipient's own with a shared pill; notebook
   pill is a marker only; note-level "shared" becomes a filter facet when the filters system lands.
3. **URL-share defaults — DECIDED (Jim, 2026-07-04): permanent until revoked.** No expiry in v1 at
   all (not even optional); add expiration later only if it proves desirable.
4. **Recipient `create` rights — DECIDED (Jim, 2026-07-04): YES.** Write access to a shared notebook
   includes creating new notes; no separate opt-in bit.
5. **RTC convergence v1:** DO-sequencer with conflict-as-version fallback (this doc) vs. jumping
   straight to CRDT — **OPEN: Jim wants further discussion before ruling.** *Recommendation stands:
   the sequencer; CRDT arrives per-plugin where it earns its complexity.*
6. **Un-share semantics (added by Jim, 2026-07-04) — DECIDED: revoke = FORK.** Read+write sharing is
   effectively giving the recipient a copy; on revoke the link breaks and a full copy stays with BOTH
   users (recipient's copy re-keyed as their own data). Corollary requirement: version history is
   attributed per editing principal (same model as LLM-agent edits) so both forks carry an honest
   record of who wrote what. See §3 P3 revocation + assumption guard 5.
