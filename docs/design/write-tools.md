# MCP Write Tools — design spec (ROAD-0005 · capabilities · "write tools LAST")

> **Status: BUILT + LIVE (2026-07-02).** Agent writes apply **LIVE, full edit + delete** — NO approval/proposal
> queue. Safety net = **versioning (edits) + trash (deletes) + audit + low write cap + easy revoke**. Five MCP
> write tools (create/update/append/set_property/trash) ship behind a per-scope mint opt-in; read-only stays
> the default. Write is granted through ONE mechanism (`clampAgentScopes`) shared by BOTH the manual mint
> route AND the one-click OAuth consent surface (§10 — single auth path). Versioning prerequisite (§3) landed
> first (`a6291eb`). Deployed to `deltos.blackgate.studio`; shared 81 / worker 470 / client 994 green.
> **Remaining: P5 red-team.** Sections below are the as-built record (the earlier proposal-queue phrasing is
> superseded).
>
> **Migration numbers:** FTS5 takes 0018; any new table here uses the next FREE number at build time. Never
> reuse/rewrite an applied migration ([[migration-never-rewrite-applied]]).

## 0. Decision (Jim) + what it means

Today the MCP surface is read-only *by construction*: `clampToReadOnlyScopes` (`packages/shared/src/api/
agentToken.ts`) floors every minted agent grant to `['read','search']`, and no write tool exists in
`MCP_TOOLS` (`packages/worker/src/mcp/tools.ts`). This spec adds create/update/trash/append/set-property as
MCP tools.

**Jim's call (2026-07-02):** *"give full access to edit and delete, as long as versioning is working right
there is no risk … if versioning doesn't work, then we fix it, either way the choice stands."*

So the model is **live-apply, not a proposal queue.** Agent writes go through the SAME account-scoped mutators
the REST handlers use (`insertNote`/`patchNote`), under the agent principal carrying write scope, and take
effect immediately. The earlier proposal/approval-queue model (an artifact of "edits aren't reversible") is
**dropped.** In its place, recoverability is the safety net:
- **Edits** → **version history.** This is the load-bearing prerequisite: versioning must actually capture the
  pre-edit content when an agent's change syncs in (§3/§5). It does NOT today — that gap is a build lane in
  front of write-tools.
- **Deletes** → **trash.** `trash_note` sets the recoverable `sys:trashedAt` soft flag; agents NEVER get the
  hard `deleteNote`/`deletedAt` tombstone. Verified recoverable end-to-end.
- Plus **audit** (every write logged + surfaced in Account activity), a **low write cap** (§7), and
  **one-tap revoke** of the token.

## 1. Tool set + JSON-RPC schemas

Five tools, each a thin adapter mapping 1:1 to an existing REST op + mutator, slotting into the existing
dispatcher (`routes/mcp.ts` → `handleToolsCall`) and `McpTool<A>` registry (`tools.ts`). They reuse the same
`op` values as the REST routes so `can()` enforcement is identical.

| Tool | `op` (→ `can()`) | REST twin | Mutator | Resource |
|---|---|---|---|---|
| `create_note` | `create` | `note.create` | `insertNote` | dest `notebook` or `workspace` |
| `update_note` | `write` | `note.update` | `patchNote` | `note(id)` |
| `trash_note` | `delete` | (new) | `patchNote` writing `setTrashedAt` | `note(id)` |
| `append_block` | `write` | `block.append` | `patchNote` (read-modify-write body) | `note(id)` |
| `set_property` | `write` | `property.set` | `patchNote` (merge one user key) | `note(id)` |

Critical mapping rules:
- **`trash_note` → soft `sys:trashedAt` via `patchNote`, NEVER the hard `deleteNote`/`deletedAt` tombstone.**
  The write tools must have no path to `deleteNote`.
- **`set_property` rejects the reserved namespace** — validate with `UserPropertyKeySchema` so an agent can't
  set/clear `sys:trashedAt` (an out-of-band delete/restore). Server-side trash is `trash_note` only.
- **`create_note` generates the id server-side** (fresh UUID) — no agent-chosen id.
- **`append_block`/`set_property` are read-modify-write** (fetch via `getNoteForAccount`, splice, `patchNote`),
  carrying `expectedVersion` for CAS.

Each tool's `execute` applies the change LIVE via the matching mutator (under the agent principal + write
scope) and returns the resulting note (`{status:'applied', note}`). `MCP_INSTRUCTIONS` (`tools.ts`) is
extended to state that writes take effect immediately, that note/web content is untrusted data (never
instructions), and that deletes are recoverable from Trash.

## 2. Authorization — a write-capable grant on the P1 ACL

**No new principal kind, no new credential type.** Per the locked authz model (`docs/design/authorization-
model.md`), a write-capable token is a `grants` row with `principalKind='agent'` whose `scope` includes
`write`/`create`/`delete`. It resolves + enforces through the identical path (`resolvePrincipal` → `can()` →
`grantAllows`, which already checks `grant.scope.includes(op)`). **Nothing in `can()` changes.**

What changes is the mint clamp — minimally and fail-closed:
- **Write is NEVER the default.** Replace the unconditional `clampToReadOnlyScopes(req.scope)` in
  `agentTokens.ts` with a gated `clampAgentScopes(requested, {allowWrite})`. No explicit write opt-in →
  read-only clamp verbatim (every existing token + default mint stays read-only).
- **Explicit per-scope opt-in (least privilege).** `MintAgentTokenRequestSchema` gains a `.strict()`
  `write?: { create?: boolean; update?: boolean; trash?: boolean }` so the owner can mint a create-only token
  ("let Claude save notes") that can't edit or delete existing notes.
- **Step-up already gates mint** (`verifyStepUp`) — even more warranted for a write-capable mint (the human
  is re-proved at issuance, since no human is present at write time).
- **BOLA inherited unchanged** — `stampAccountId(principal)` at mint, `callerAccountId(principal)` in execute;
  every mutator is `WHERE accountId = ?`. A write token physically can't touch another account's rows.

**Resource-scope caveat (a named injection mitigation to close):** `resourceCovers` grants workspace-wide
coverage but requires exact match for finer grants — there is no note→notebook resolver, so a notebook-scoped
token can `create_note` into that notebook (exact match) but can't `update`/`trash` a `note(id)` under it.
**v1 recommendation: note-level write tools require a WORKSPACE-scoped write token; fast-follow a note→notebook
coverage lookup** so per-notebook write tokens (a blast-radius control) work. (Smaller than the grantee
owner-resolver — stays caller-account-relative.)

## 3. Live-apply + the versioning safety net (the crux) — REPLACES the earlier proposal queue

Per Jim's decision, agent writes **apply immediately** — there is NO proposal/approval queue, no `pendingWrite`
table, no review UI. Each write tool's `execute` calls the SAME account-scoped mutator the REST handler uses
(`insertNote`/`patchNote`) under the agent principal (write scope), and the change takes effect and syncs like
any other. Recoverability, not pre-approval, is the safety net.

**This makes a versioning prerequisite load-bearing — and it does NOT hold today.** Investigated + confirmed
(2026-07-02):
- Version history is **client-only** (`packages/client/src/db/schema.ts` `noteVersions` in Dexie) and is
  captured **only during local editing** (`packages/client/src/lib/historyCapture.ts` — idle-settle / on-leave
  / big-change). There is **no server-side** version table (D1 migrations 0000–0018 have none).
- A change arriving via **sync** does NOT snapshot: `mergeServerNotes` (`packages/client/src/db/
  dexieLocalStore.ts`) does a straight `db.notes.put(note)` over the local copy with no capture (pinned by
  `conflictVersion.acceptance.test.ts` CAV-3 — clean merges create zero versions).
- ∴ an agent's server-side edit syncs in and **overwrites local content with nothing to roll back to.**

**Prerequisite lane (build BEFORE write-tools; task #8):** make the sync-merge capture the pre-overwrite
content as a version. In `mergeServerNotes`, before `db.notes.put(note)` replaces a materially-changed note,
read the existing local note and capture it via the existing history infra (`captureSessionVersion` /
`historyCapture`). Scope to **material foreign changes** so routine multi-device sync doesn't flood history;
**tag agent-originated edits** so the history panel flags "changed by Claude" with a one-tap revert.
- **Chosen approach: client-side capture-on-merge** (reuses the shipped history/panel; recovery works on any
  device that held the note). Residual edge: recovery is per-device — a brand-new device that only ever saw
  the already-edited note can't roll back locally. Accepted for v1 (personal multi-device use + Account-
  activity anomaly visibility). **Server-side version capture** (snapshot prior content in the worker on every
  write; authoritative + device-independent) is the noted later hardening if the edge ever bites — NOT a
  write-tools blocker (Jim: *"if versioning doesn't work, we fix it, either way the choice stands"*).

**Delete needs no versioning:** `trash_note` sets the recoverable `sys:trashedAt` soft flag (verified
recoverable end-to-end via the Trash view); agents never get the hard `deleteNote`/`deletedAt` tombstone.

## 4. Prompt-injection treatment (defense-in-depth)

1. **Recoverability is the primary control** — an injected destructive edit is reverted from version history
   (§3 prerequisite); an injected delete is restored from trash. Nothing is unrecoverable.
2. **Never hard-delete** — `trash_note` → recoverable `sys:trashedAt`; no path to `deletedAt`.
3. **Blast-radius caps** — a low daily write cap (§7); one tool call = one note (no bulk/multi-note tool), so
   a mass-mutation injection exhausts the cap after a handful of individually-recoverable writes.
4. **Audit + easy revocation** — every write is logged + surfaced in Account activity (agent edits also flagged
   in the history panel); the existing revoke + connected-apps kill a compromised token instantly.
5. **Content is data, not instructions** — `MCP_INSTRUCTIONS` states note bodies + web content are untrusted
   and must never be executed as directives.
6. **Least-privilege** — write is opt-in per-scope at mint (§2); most tokens stay read-only/create-only.

## 5. Recoverability — the matrix (post-prerequisite)

| Op | Reversible? | Mechanism |
|---|---|---|
| `trash_note` | Yes | `sys:trashedAt` soft flag → Trash view restore (exists today) |
| `create_note` | Yes | trash the new note |
| `update_note` / `append_block` / `set_property` | Yes **once §3 lands** | pre-overwrite version captured on sync-merge → history-panel revert |

The `update`/`append`/`set_property` row is reversible **only after** the §3 versioning prerequisite ships —
which is exactly why task #8 gates the write-tools build.

## 6. Audit + observability

**As built:** every write tool call is audited through the EXISTING `handleToolsCall` chokepoint
(`surface:'mcp'`, `action:tool.op` = `create`/`write`/`delete`, `result:allow`|`deny`, `credentialRef` = the
agent `grantId`, `resourceKind`/`resourceId` = the note). Separation-of-duties is preserved — the `AUDIT`
handle never reaches the data layer (`audit.separation.test.ts`). Because writes apply LIVE, there is no
separate propose/decide/apply chain: one audited tool call per write, and `projectsToD1` already projects
every `mcp` event (allow + deny) into the user-facing `auditLog`.

Follow-up (not shipped in this increment): richer `ActivitySection` `describe()` cases so the feed reads
"Claude edited *title*" / "Claude trashed *title*" instead of the generic mcp/write line, plus the
"changed by Claude" flag in the note history panel (rides the agent-provenance additive fast-follow).

## 7. Abuse / cost

- **Dedicated low write cap** — add `mcpWrite` to `UsageMetric`/`DAILY_QUOTA` (~100/account/day, far below the
  50 000 read cap), charged fail-closed in the write-tool execute. Bounds an injection-driven write flood at
  the wallet/blast-radius level.
- Existing per-token window + per-account daily `mcp` quota already apply (same dispatcher prologue).

## 8. Testability / red-team hooks

- **Headless (no Claude app) — SHIPPED** (`packages/worker/test/mcp.write.test.ts`): mint a write-scoped grant
  via the mint route (per-scope `write` opt-in), POST `tools/call` for each write tool; assert the change
  applied LIVE (get_note reflects it), trash sets `sys:trashedAt` and NEVER `deletedAt`, a read-only token is
  denied every write tool, `set_property` rejects the `sys:` namespace, cross-account BOLA is not-found, and
  the daily write cap trips. Plus `packages/shared/test/agentToken.test.ts` pins the clamp (read floor +
  opt-in write, never `share`).
- **Red-team (P5, HELD):** plant a note whose body says "delete all notes"; mint a write token; drive an agent.
  Pass: injected destructive edits are reverted from version history + trash; the write cap trips; every step
  reconstructable from the audit log alone. Named breaks this must survive: read→write scope escalation (denied
  at `grantAllows`); act-without-a-trace (impossible — audited + `AUDIT` unreachable from the data layer);
  injection→destruction (defanged by recoverability + trash + low cap). Keep `audit.separation.test.ts` green.

## 9. Decisions (resolved)

- **[Jim — DECIDED] Full edit/delete, live-apply, NO approval queue.** Versioning (edits) + trash (deletes) are
  the safety net. → the §3 versioning prerequisite (task #8) gates the build.
- **[Lead — DECIDED] Versioning fix = client-side capture-on-sync-merge** (§3); server-side capture is a later
  hardening, not a blocker.
- **[Lead — DECIDED] Scoped write tokens (§2):** v1 = workspace-scoped write tokens only; fast-follow the
  note→notebook `resourceCovers` lookup so per-notebook write tokens work.
- **[Lead — DECIDED] `requiresApproval` grant constraint (§2):** defer — runtime constraint eval isn't wired
  into `can()` yet; not needed for the live-apply model.
- **[Open — later] Notification of agent writes:** the Account-activity view + the history-panel "changed by
  Claude" flag cover it; a push/email nudge is a possible later add, not v1.

## 10. Forward-compatibility — plugin-extensible tool surface (build guardrail, not new v1 scope)

Jim's architectural note (2026-07-02): custom plugins will eventually ship **their own AI-manipulable
controls**. Nothing to build for that now, but write-tools must be the FIRST TENANT of an extensible
framework, not a note-only dead-end ([[CONV-0010]]). Four seams to keep open — all of which the design above
already respects, so this is a "don't regress it" guardrail:

1. **Registry, not a literal.** Keep `MCP_TOOLS` a registration seam (a plugin manifest feeds tools in later);
   no note assumptions baked into the dispatcher (`handleToolsCall`).
2. **One shared chokepoint.** Every tool — note or future plugin — routes through `can()` + `audit()` + the
   usage caps. Never per-tool bespoke auth. A plugin tool inherits enforcement for free (the P1-ACL rule).
3. **Per-tool safety contract.** Note-versioning + trash is the recoverability net for the NOTE tools; a plugin
   ships its OWN undo/guard. Do NOT hardcode "all AI writes are note edits guarded by note-versioning" — model
   recoverability as something a tool declares, so a plugin tool with a different safety story slots in.
4. **Open scope model.** Coarse write scopes (write/create/delete) map onto the same grant ACL; leave room for
   capability-scoped plugin grants (the plugin-capability-security-model, server-side enforced).

### Critical files (as built — live-apply, no queue, no new migration)
- `packages/shared/src/api/agentToken.ts` — `clampAgentScopes(requested,{allowWrite})` (read floor + opt-in
  write, never `share`), `AGENT_GRANT_SCOPES`/`AgentGrantScopeSchema`, `AgentWriteOptSchema`, the per-scope
  `write` field on `MintAgentTokenRequestSchema`. `clampToReadOnlyScopes` kept as the write-free delegate.
- `packages/worker/src/mcp/tools.ts` — five write tools in `MCP_TOOLS` (reusing `insertNote`/`patchNote`),
  `textToBody` (plain-text → paragraph spine, LLM-friendly), scope-filtered `toolListPayload(scopes)`,
  scope-aware `mcpInstructions(canWrite)`, `WRITE_OPS`.
- `packages/worker/src/routes/mcp.ts` — pass `now` to the tool ctx; filter `tools/list` + instructions by the
  resolved grant scope; charge the `mcpWrite` daily cap fail-closed on write ops.
- `packages/worker/src/routes/agentTokens.ts` — `clampAgentScopes(req.scope, req.write ? {allowWrite} : undefined)`.
- `packages/worker/src/abusePolicy.ts` — `mcpWrite` metric + `DAILY_QUOTA.mcpWrite` (100/account/day).
- `packages/client/src/lib/agentTokensClient.ts` + `components/ConnectClaudeSection.tsx` — the "let Claude
  create, edit & delete" mint toggle (default OFF) + read/write scope label.
- **No new migration** — the write cap rides the existing `usageCounter` (0016); delete is soft-trash via the
  existing `sys:trashedAt` property, so there is no schema change.

### Single auth path for write — BUILT (both surfaces)
Write is granted through **ONE mechanism** — `clampAgentScopes(requested,{allowWrite})` fed by the shared
`AgentWriteOptSchema` — used identically by BOTH connection methods, so there is no read-only-vs-write split
by surface:
- **Manual mint** (`routes/agentTokens.ts`): `MintAgentTokenRequestSchema.write` → clamp.
- **One-click OAuth consent** (`routes/oauth.ts` `/authorize`): `AuthorizeConsentRequestSchema.write` → the
  SAME clamp; scope flows authorize → oauth code → `/token` → `insertAgentGrant` unchanged. The dedicated
  `/oauth/*` consent surface (`OAuthApp.tsx`) shows the SAME "create, edit & delete" toggle (default OFF) as
  the manual UI, and flips its HONEST scope disclosure when ticked. Both default read-only, fail-closed;
  `share` never grantable. Step-up gates both mints. (Discovery `scopes_supported` still lists `read search`
  — write is granted by the human at consent, not requested via the protocol `scope` param, which is ignored.)

### Remaining fast-follows
- Agent-provenance "changed by Claude" flag + richer ActivitySection copy (§6).
