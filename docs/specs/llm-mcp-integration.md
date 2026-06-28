# LLM / MCP Integration — Design Spec

**Status:** DESIGN (no implementation scheduled — planning artifact). 
**Date:** 2026-06-28. 
**Author context:** worked out with Jim, 2026-06-28. 
**Sibling to:** `plugin-support.md` — this doc **expands §14 (the access axis)** of that
spec into a buildable design, and realizes §9 (API-first / MCP-drivable) and §9A (the agent
guide, backend-resident locality). 
**Grounded in:** the worker backend as mapped 2026-06-28 (routes, auth, schema cited below —
verify file:line against current code before building; this is a point-in-time map).

---

## 0. The one-line thesis

"Hey Claude, add eggs to my shopping list" and "send this note to Claude" are **not two
plugins**. They are the same thing your plugin spec already named: **§14's access axis —
*who or what can reach the data, and in what mode*.** That axis is **shared core
substrate**, not a plugin. We build the substrate once, deliberately plugin-extensible,
then each feature (share URL, MCP, deep-links, backlinks) is a thin surface on top — some
a core route, some a genuine plugin.

The headline capability — *talk to Claude about your notes* — is achievable with **no
Anthropic SDK and no API key on our side**: it's a **remote MCP server** hosted on the
Worker and consumed by the first-party Claude apps (claude.ai connectors, Claude Desktop,
Claude Code). The user authorizes it once; their own Claude subscription pays inference.
deltos never runs an LLM in this flow — it just serves clean data and validated writes.

---

## 1. The two directions

| Direction | User experience | What it needs |
|---|---|---|
| **Deltos → Claude** ("send to Claude") | A share/export of a note as LLM-friendly **Markdown**, or a public share URL. | Addressability + a server-side `spine→markdown` / `spine→HTML` serializer + a public render route. |
| **Claude → Deltos** (search / pull / push) | Talk to Claude in its own app; it reads and writes your notes. *"summarize my to-do", "add eggs to my shopping list", "summarize this and file it in Ideas".* | A **remote MCP server** over existing routes + an **agent credential**. |

These two are **independent tracks** that share one deep foundation (addressability). The
Claude→Deltos track does **not** depend on share URLs — its tools operate on note **IDs**,
which already exist (`notes.id` = stable client UUID). Share URLs are their own feature.

The "summarize" itself is always done by **Claude** (the consumer). deltos provides the
data and the write target; it does not summarize. That is what makes the MCP path so cheap.

---

## 2. The access axis as shared core substrate

Per §14, API · share · collaboration are **one grant model, not three systems**:

> **`(principal, capabilities, data-scope, mode) → token`**
> - **principal** — the user · an external agent (Claude) · an anonymous link-holder · another account
> - **capabilities** — read / append / create / upload / invoke-plugin-command — *the SAME vocabulary as plugin host-capabilities (plugin-spec §4/§7)*
> - **data-scope** — a note · a notebook · the account
> - **mode** — preview (read) · contribute (scoped write) · collaborate (future)

Three **core** primitives realize this axis. They are core (not plugins) because plugins
*consume* them:

1. **Addressability** — stable, deep-linkable identity for note / notebook / **element**.
   IDs already exist; what's missing is URL routing and intra-note (block-level) anchoring.
2. **The grant / access layer** — the tuple above, minted into a token. The `grants` table
   is already most of this (see §5).
3. **The render-only contract** — `spine → output`, block-type-agnostic. Already on the
   plugin roadmap as Track A item **A2**. The bridge between the plugin framework and this axis.

---

## 3. The core / plugin cut

| Thing | Layer | Rationale |
|---|---|---|
| **Addressability** (URL identity for note / notebook / element) | **Core** | Everything addresses *through* it; plugins consume it. "Deep linking for element integration" = extending this to block IDs. |
| **Grant / access layer** (`principal · capabilities · data-scope · mode → token`) | **Core** | The data boundary + security chokepoint; backend-resident (§9A). Extends the `grants` table. |
| **Render-only contract** (`spine → markdown / HTML`, type-agnostic) | **Core** (= plugin Track A **A2**) | Shared by share-preview, search-peek, history-diff, *and* markdown-for-Claude. |
| Share URL (public preview) | thin **core route** | Exposes render-only over a `mode: preview` grant. No content contributed → not a plugin. |
| MCP server (surface + transport) | **core** access surface | §14: "Plugins EXTEND the API." Server + first tools (notes/notebooks) are core; plugins append their own tool schemas. |
| Deep-link **resolution** (open app at note/element) | **core** (routing) | Pure routing/identity. |
| Note↔note links / **backlinks** | **plugin** | §14: wikilink = inline-entity (detect-and-transform); backlinks = a `records` reverse-index. Needs addressability; doesn't provide it. |
| A specific block being shareable / agent-drivable | **plugin** | The plugin ships its own §5 render-only component + §9 call-schema; core just routes to them. |

**Build the substrate once, plugin-extensible.** Three invariants prevent rework (all
already asserted in plugin-spec):
1. **One capability vocabulary** — the grant layer's `capabilities` = plugin host-capabilities
   (§4/§7). Never grow a second permission language.
2. **Render-only is block-type-agnostic from day one** — a plugin block in a shared note or
   an MCP `get_note` response must serialize even if its runtime isn't loaded (§5 + §6
   durability). Never special-case the built-in types.
3. **MCP tool surface is registry-driven** — a plugin's command list *is* its agent-facing
   surface (§9). Core ships note/notebook tools; plugins append theirs without touching the server.

Get these right and a plugin block is automatically shareable, deep-linkable, and
agent-drivable the day it's written — no per-feature wiring.

---

## 4. Residency — protect the mobile first-load (HARD guardrail)

The sensitive thing is the **main interface's render layer and the mobile first-load
bundle**. This is **not** "never touch the client" — client code off the main track is
fine. Every component carries a residency tag with **three** buckets:

| Bucket | Meaning | Examples |
|---|---|---|
| **server** | Plumbing the user never directly modifies. Never in the client bundle. | MCP server (transport/dispatch/tool handlers), agent guides / tool schemas / ontologies / runbooks (§9A), grant mint/enforce/revoke, the `spine→markdown` / `spine→static-HTML` serializers, the **public share page** (server-rendered static HTML → recipient loads ZERO app bundle). |
| **lazy off-track route** | Genuine UI that loads on request — fine to be client code. | "Connect to Claude" / revoke **Settings** page; in-app share-viewer; the search / history render-only surfaces; lazy plugins. |
| **main first-load** | The shell + editor. The bar to protect (esp. mobile). | *Nothing in this effort lands here.* |

**Decision rule:** would it load on the main / first-load (mobile) path? If yes, push it
off — to the **server** (no direct manipulation) or to a **lazy route** (UI). 

**Guardrail (binding):** *this whole effort adds ~zero to the mobile first-load bundle.*
Same self-enforcing posture as the plugin framework's A0/#72 entry-bundle check — with two
valid escape hatches (server, lazy route) instead of one. See
[[backend-resident-plumbing-default]], [[plugins-lazy-past-first-paint]],
[[performance-is-a-standing-value]].

**Design consequence (sharpens §5):** the **outbound** render (public share HTML,
markdown-for-Claude, MCP `get_note` output) is a **pure `spine → output` serializer on the
server** — *not* the React render-only component. The React render-only component is for
**in-app** read-only surfaces (search peek, history diff) and is itself lazy. Same single
source of truth (the `Block[]` body), two emitters; the heavy/public one never enters the client.

---

## 5. The agent credential — the one genuinely-new primitive

Today the only tokens are **rolling user sessions**: a 15-min access grant +
a sliding-60-day refresh session (rotation-on-use; the 60 days resets on every refresh, so
a daily user never re-logs in — the window only lapses after 60 *consecutive* idle days,
and even then the local-first shell still opens, only sync is gated). That model suits a
cold-booting PWA but is **wrong for a headless connector**, which doesn't cold-boot-and-refresh.

So we add a **different kind of credential** — not "more secure," a *different shape*:

- **A new `principalKind`** (e.g. `'agent'`) in the existing `grants` table.
- **`expiresAtMs: NULL`** — non-expiring. The grants table already treats null as no-expiry
  (`auth.ts`: `grant.expiresAtMs !== null && grant.expiresAtMs <= nowMs`).
- **Scope-clamped** at mint via the existing `scope: Scope[]` — e.g. a read-only token, or
  one scoped to a single notebook via `resourceKind: 'notebook'` / `resourceId`.
- **Independently revocable** — revoke Claude's access without touching your own sessions,
  and vice-versa. (Distinct from `revokeAll()`, which is per-account credential-change blast.)

**The grants table already models everything this needs** — `principalKind`, `scope`,
`resourceKind`/`resourceId`, `expiresAtMs`, `revokedAt`. We add one enum value + a small
mint/revoke surface; we do **not** harden the existing auth (it's already strong).

This directly *is* §14's grant model: `principal=agent`, `capabilities=scope`,
`data-scope=resource`, `mode=read|contribute`.

### 5.1 Credential delivery — two options (OPEN)

| Option | UX | Effort | When |
|---|---|---|---|
| **Pasted long-lived token** | User generates a token in Settings, pastes it into claude.ai's custom-connector config (bearer). | Small — one mint route + Settings UI + revoke. | **v1.** |
| **OAuth 2.1** | "Connect" → authorize → done. MCP's spec'd remote-server flow (PKCE, authorize + token endpoints). | Larger. | Later polish; same grant primitive underneath. |

**Lean: pasted token for v1, shaped so OAuth is additive.** ⚠️ Never have Claude log in with
the user's username/password or hold the httpOnly refresh cookie — the agent credential is
purpose-minted and independently revocable.

---

## 6. The MCP server — thin adapter over existing routes

The MCP server speaks JSON-RPC over Streamable HTTP and dispatches to **routes that already
exist**. It is almost entirely a protocol adapter — the business logic is already built.

| MCP tool | Existing route | Mode | New work |
|---|---|---|---|
| `search_notes` | `GET /api/search` (FTS over title + properties + blocks) | read | none |
| `get_note` | `GET /api/notes/:id` | read | none |
| `list_notebooks` | (thin list, or derive from sync/pull) | read | tiny |
| `create_note` | `POST /api/notes` | contribute | none |
| `append_to_note` | `POST /api/notes/:id/blocks` | contribute | none |
| `set_property` | `PUT /api/notes/:id/properties/:key` | contribute | none |

Worked examples decompose cleanly:
- *"summarize my to-do"* → `search_notes` + `get_note`; Claude summarizes.
- *"add eggs to my shopping list"* → `search_notes("shopping")` + `append_to_note`.
- *"summarize this convo and add it to my Ideas notebook"* → Claude summarizes → `create_note(notebookId: ideas)`.

PATCH's CAS versioning gives write tools optimistic concurrency for free. The MCP path runs
through the **same `guard()` chokepoint** as the PWA, so account isolation is inherited
(see §8).

### 6.1 The agent guide (§9A) — the magic-vs-mechanical difference

Each MCP tool ships rich, prescriptive descriptions, plus a server-instructions prompt that
teaches Claude deltos conventions: what a notebook is, how to pick the right one (e.g. soft
ranking by name/recency), when to append vs create, the property bag's shape. A dynamic MCP
**resource** can expose "what's here now" (the user's notebook list) for Claude to read
before acting. This is **backend-resident** (residency: server) — author it rich, it never
touches the bundle and the offline case can't arise (§9A).

---

## 7. How much is "SDK-only"?

| Capability | Mechanism | Anthropic API key on our side? | Who pays inference |
|---|---|---|---|
| User talks to Claude; Claude reads/writes notes | **Remote MCP server** (claude.ai connector / Desktop / Code) | **No** | User's Claude sub |
| Send a note to Claude | **Share URL + markdown export** | No | n/a |
| In-app AI ("summarize" button *inside* deltos) | **Claude Messages API** (`client.messages.create` + tools, or the MCP connector `mcp-client-2025-11-20`) | **Yes** | We do |
| Hosted stateful agent w/ container | Managed Agents | Yes | We do |

**Headline:** the robust search/pull/push needs **no SDK and no API key** — it's the remote
MCP server. The SDK/API only enters for AI *inside* deltos (deferred — a thin client of the
same backend MCP surface, per §9A). **Managed Agents is overkill — out of scope.**

---

## 8. Security

The enforcement chokepoint that protects the PWA protects the MCP path unchanged:
`resolvePrincipal` → `can()` (revoke / expiry / scope / resource / ownership) →
`requireAccountId(c)` returns the **server-derived** `principal.id` → every query is
`WHERE accountId = ?`. After migration 0003, `principal.id` *is* the accountId.

- **HC-A1-1 (server-side enforcement on server-derived accountId, never client-claimed)** is
  satisfied by construction the moment an MCP route runs through `guard()`. See
  [[plugin-capability-security-model]].
- An MCP **write** tool is an externally-reachable write path → **secSys gates the write
  tools** before deploy. The read-only slice (§9, Phase 1) ships first to de-risk.
- Scope-clamping (read-only / single-notebook grants) bounds blast radius per §14's grant model.
- Reconciles with the auth-friction north star ([[auth-friction-philosophy]]): the grant
  gates *external* principals; the day-to-day user stays ungated.

---

## 9. Sequencing (build later; this is the plan)

```
Phase 0 — substrate (build once; unlocks everything):
   addressability + element deep-links · grant/access layer (extend `grants`) · render-only contract (A2)
Phase 1 — thin surfaces (parallel):
   share URL (core route) · agent credential + read-only MCP server (core) · markdown export
Phase 2 — writes + plugins:
   MCP write tools (secSys-gated) · backlinks/wikilinks plugin · per-plugin agent tools as plugins mature
```

- **Phase 0 is the real investment;** Phases 1–2 are cheap consumers.
- Phase 0 does **not** block on the full plugin framework (A1's manifest/loader). Addressability,
  grants, and render-only are useful and shippable before A1 — pull them forward exactly as
  §14 recommends ("addressability is the one piece worth sequencing early").
- **Critical path for "talk to Claude about my notes":** agent credential → read-only MCP
  server → write tools. Share URL is a sibling, not a blocker.
- Each slice ships independently and is reviewed **on the live site** ([[review-on-live-never-local-preview]]).

---

## 10. What already exists (inventory — backend map 2026-06-28)

| Seam | Status | Ref (verify before building) |
|---|---|---|
| Note CRUD routes | ✅ | `POST /api/notes`, `GET/PATCH/DELETE /api/notes/:id` (`packages/worker/src/index.ts`) |
| Block append | ✅ | `POST /api/notes/:id/blocks` |
| Property set | ✅ | `PUT /api/notes/:id/properties/:key` |
| Search (FTS) | ✅ | `GET /api/search` (title + properties + blocks) |
| Stable note IDs | ✅ | `notes.id` = client UUID (migration 0010 schema) |
| Account-scoped isolation | ✅ | `requireAccountId` / `callerAccountId` (`accountScope.ts`); `principal.id` = accountId post-0003 |
| Grant model (principal/scope/resource/expiry/revoke) | ✅ | `grants` table (migration 0002); `can()` (`auth.ts`) |
| Null-expiry grants | ✅ | `auth.ts` expiry check skips `expiresAtMs === null` |
| Sync substrate (per-account seq) | ✅ | `/api/sync/{push,pull}`, `accountSyncSeq` (migration 0006) |
| **Agent `principalKind` + mint/revoke route** | ❌ design-only | §5 |
| **MCP server (transport + tools)** | ❌ design-only | §6 |
| **Addressability / URL routing / element anchors** | ❌ design-only | §2.1 |
| **`spine → markdown/HTML` serializer (server)** | ❌ design-only | §4 |
| **Render-only contract** | ❌ design-only (= plugin A2) | plugin-spec §5 |
| **Public share route + preview grant** | ❌ design-only | §1, §3 |

---

## 11. Open questions for the build phase

- **Credential delivery:** pasted long-lived token (v1) vs OAuth 2.1 (later) — §5.1. Lean: token now.
- **Addressability URL shape** + its interaction with the synthetic-default "All Notes" model
  and `currentNotebookId` (today notebook lives in `currentNotebookId`, not the URL — cf.
  [[all-notes-synthetic-default]]).
- **Element-level anchors:** expose block IDs in the address space; re-mint semantics on
  copy/paste/split (ties to plugin-spec §13 blockId rules).
- **MCP server placement:** a route group in the existing Worker vs a separate Worker (transport
  isolation, separate rate limits).
- **Scope vocabulary unification:** exact mapping of grant `capabilities` ↔ plugin host-capabilities
  (§4/§7) so there is one language, not two.
- **Markdown dialect / fidelity** for plugin blocks — lean on render-only graceful degradation
  (§6 durability): an unknown block degrades to a labelled placeholder, never breaks the export.
- **Rate-limiting / cost caps** on agent-token writes (cf. [[transcribe-ai-cost-ruling]] — bound
  external-principal write volume; HARD before any multi-user exposure).

---

## 12. Relationship to `plugin-support.md`

This doc is the buildable expansion of that spec's **Track B** (§12). It does not change
Track A. When this lands, fold a one-line pointer into plugin-spec §14 ("realized in
`llm-mcp-integration.md`"). The two stay decoupled: Track A (the plugin framework) does not
depend on Track B, and Track B's substrate (addressability + grants + render-only) is useful
to Track A but shippable independently.
