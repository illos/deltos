# deltos — design rationale

The *why* behind deltos's locked architecture. The **build plan, roadmap, and process**
live in `KICKOFF.md`; this document is the reference for how each decision was reached.

> *deltos* (δέλτος): the Greek wax writing tablet — one reusable surface you write anything
> onto, then smooth and reuse.

---

## Core thesis

Every notes app couples the **surface (UI)** to the **substrate (data model)**, so the model
can only ever be as flexible as one UI stays usable. Notion: model wins, UI drowns.
Simplenote: UI wins, model can't grow. No single interface is both as powerful as Notion and
as effortless as Simplenote.

**deltos decouples them:** one substrate (shared DB + schema + sync + search), many
purpose-built surfaces (each a home-screen entry), with notebooks carrying capabilities and
plugins. One database, many paths in. This also dissolves fast-vs-powerful — a notebook can
be offline/local-first or online/cloud per its needs.

### The layered model (vocabulary)
- **Substrate** — local-first store + sync + schema/type system + universal search + transport.
- **Notebooks (vaults)** — scoped note collections; each carries a capability profile
  (online/offline, encryption) + enabled plugins. TTRPG, recipes, fiber-work are notebooks.
- **Surfaces** — UIs tuned per use case, each a **route in the single PWA**, optionally pinned
  as a home-screen icon. The "many paths into one database."
- **Plugins** — feature modules that extend both data types and UI.

The recurring theme that signals the design is coherent: **the notebook is the unit of
everything** — sync authority, storage clip, backup replica, encryption key, capability scope.

---

## Platform: local-first PWA

A home-screen PWA reaches **perceived launch / time-to-typing within ~100–300ms of native** —
reads as instant most of the time. Levers: static iOS splash masks WebView spawn;
**render-before-data** (paint editor shell, hydrate async, persist optimistically); tiny
critical bundle with everything heavy lazy-loaded; SW precache so launch never hits network.

iOS in our favor: home-screen PWAs get JIT (Safari-class JS); the 7-day IndexedDB eviction
doesn't apply to installed PWAs. Irreducible gaps: cold WebView spawn, more frequent cold
starts, no background execution.

**Escape hatch:** Capacitor wraps the same codebase in a native shell later — improves launch
consistency + background work, no rewrite. "PWA now, Capacitor later" de-risks committing to web.

### One PWA, surfaces-as-routes, multiple icons
**One PWA = one app = one origin = one substrate** (multiple PWAs would fragment storage). A
surface = a route + UI config; one SW precaches the shell, each route lazy-loads its bundle.
Multiple home-screen icons = **Add-to-Home-Screen at a specific route** (each webclip keeps its
`start_url`). A `/new` route mints a client-UUID note on load → tap icon, already typing.

iOS caveats: can't add icons programmatically (A2HS is a manual gesture — app guides it);
manifest `shortcuts` long-press actions are unreliable on iOS → lean on pinned route-icons.

**Storage-sharing is an optimization, not a requirement.** Online-first means even if
same-origin webclips *don't* share storage, each icon is an independent client converging
through the cloud (and each isolated cache doubles as a backup replica). Only degradation:
a note created *offline* in one icon isn't visible in another until both sync. **Lean: one
storage clip per notebook** (symmetry with one-unit-per-notebook everywhere) — the tension to
weigh in the spike is that isolated clips make offline universal search + cross-notebook
transport harder, but both run online in the common case.

**S3 RESOLVED (2026-06-15, secSys-audited) — one-clip-per-notebook endorsed, with a hard
invariant.** On iOS the storage surfaces split: **Cache Storage and the SW registration are
SHARED across all same-origin webclips; IndexedDB is per-webclip ISOLATED** (OPFS now also
confirmed ISOLATED on-device, 2026-06-15 — D2 probe). So the per-notebook IndexedDB silo is a real confidentiality
boundary **only under an unconditional invariant: the Service Worker must NEVER runtime-cache
`/api/*` responses** (note bodies, search, property bags) into the shared Cache Storage — only the
origin-global app shell may live there. Otherwise notebook A's content (CLEARTEXT in the
server-readable default) lands in the shared bucket where notebook B's clip reads it via
`caches.match()`. Two further consequences: **OPFS turned out ISOLATED on-device**, so content-addressed blobs
do **NOT** need per-notebook encryption on a storage-sharing basis (had OPFS been shared, a hidden
pointer would be no boundary — any clip guessing the hash reads the bytes — forcing blob
encryption; that branch did not fire; only E2EE, v2, would mandate it); and all clips share **one
origin quota + one eviction domain**, so a media-heavy
notebook can evict another's offline data — **isolation governs read-access, not durability; UX
must not promise per-icon offline-safety.** Full pins: `docs/specs/phase-1-constraints.md`
§Storage isolation (PIN-STORAGE-1/2/3).

---

## Sync: online-first, optimistic, fork-only-on-conflict

Reality is ~95% online; the server is source of truth and search runs server-side. **No
CRDT/merge.** Two mechanisms, the second nearly disappearing:

- **A — optimistic write buffer + read cache (always on).** Writes hit local instantly, sync
  in background, queue if offline/failed. **Read inversion:** always render the local copy
  instantly, revalidate from server in background, swap if changed (stale-while-revalidate).
  Never "try online, fall back when slow" — detecting slow is itself slow.
- **B — offline notebooks = read-only whole-notebook cache** (the common need is reading).

**Editing offline → fork only on actual conflict.** Offline edits use the A queue; on
reconnect, compare the note's **version counter** to the server's. Unchanged (common) → applies
cleanly, no copy. Moved → write our version as a **copy** ("… (offline edit, date)"), leave the
original. Copies are the rare safety net; there's no separate offline-editing subsystem — just
the queue + a version check on flush. **Cost: one version counter per note.**

Residual items to nail: freshness signal on cached notebooks; a "needs attention / conflicts"
view + visible per-note sync status (synced/pending/failed/local-only); stable
client-generated UUIDs at creation (prevents dup-on-sync); tolerate edit-while-syncing
(versioning + debounce); offline cache text-only vs full media; communicate that offline
access + search silently shrink; forked copies are relationally lossy (new ID).

**Knock-on:** the spine no longer has to enable *merge* — only search, transport, plugin
extension.

---

## Spine (data model)

Every note has the same three layers. This is what makes search, transport, and
agent-legibility nearly free.

1. **Identity & metadata** (system-owned): `id` (client UUID, stable from creation),
   `notebookId`, `createdAt`/`updatedAt`, `version` (→ fork-on-conflict), `syncStatus`,
   `title`. Fixed for every note → notes are *addressable* (agents, share URLs, transport).
2. **Property bag** (structured record, **loose by default**): `key → typed value` (text,
   number, date, boolean, select/tag, **relation**, url). Any note can carry any properties
   (frontmatter-style); a notebook *may* declare a schema → validation + typed DB views. The
   Notion-database half.
3. **Block body** (ordered, **nestable** document): blocks with `id`, `type`, `content`,
   optional `children`. Core block types (heading/paragraph/list/quote/code/todo/divider/
   image/audio/video/file/table) map 1:1 to Markdown. The prose/Simplenote half.

**A note is simultaneously a record and a document** — that duality is the entire spine.

**Plugins extend at exactly two seams: property types & block types.** Core stores a plugin
block's `content` opaquely and only asks the plugin (via manifest): render, Markdown export,
`searchText()`, collaborative? Core never learns plugin internals → plugins are additive,
spine stays frozen.

- **Search:** one index over title + indexable properties + each block's `searchText()`;
  properties become filterable facets (`type:recipe time<30`).
- **Transport:** body always travels; properties map where the target understands them
  (schema match → maps; unknown → rides along if loose, else stash). Lossy-but-safe.
- `relation` is a **core** property type (backlinks, graph, Notion-relations, smarter
  transport). `title` defaults to first heading. **No formal note type** — behavior emerges
  from a notebook's plugins + the note's own properties/blocks.

---

## Embeds & file storage

- **Embeds, two kinds:** *owned media* (uploaded — file in your storage, core block types,
  durable, backup-able) vs *remote service embeds* (YouTube/tweet — a URL, not yours, can rot).
  Surface the distinction: attach-don't-link for durability.
- **Blob store is a separate, pluggable subsystem.** Notes reference a blob by **content-
  addressed ID (hash) + kind, never a vendor URL** — the layer resolves where bytes live.
  Backends: R2 (cloud), OPFS (local; better than IndexedDB for big blobs), later S3/own server.
  This one indirection buys pluggable storage *and* portability/backup.
- Pitfalls banked: orphan-blob GC; content-hash gives free dedup + integrity; blob sync is its
  own queue ("note synced, file pending"); **offline quota → text/metadata replicate fully,
  media per device policy** (phone text-complete, desktop full).

### Data ownership + backup-via-replica
**Your data is always extractable, never hostage to the service** — via Markdown+media export,
pluggable/self-host storage, local replicas, and an API-first documented format. The Obsidian
"it's just my folder" confidence, reconstructed for a structured cloud app.

**Backup-via-replica:** every install already caches locally → commit (today's decision) to the
local store being a **first-class restorable replica, not an ephemeral cache** (complete,
documented, integrity-checked) + a restore/export path. A future dedicated backup server is
just another API client. Constraints: replica is only as fresh as last sync; iOS quota →
reliably text-complete; ownership has gradients (owned files backup-able, remote embeds aren't).

---

## Plugins: manifest + UI boundary

A plugin declares one **manifest = capability flags + contribution registry**:
- `collaborative` (default false → read-only shard), `markdownExport` (clean/fenced/none),
  `offline`, and the block/property types it registers.

**Six UI slots**, increasing power: block renderer+editor → property widget → commands
(slash/palette/menu) → panels → full views → settings. **Host owns chrome; plugins fill slots,
never seize layout** (VSCode/Obsidian model).

**Block "island" model:** a plugin block is opaque to the core editor — host owns everything
*between* blocks (cursor, selection, reorder), plugin owns *inside* its block. This is the
**same seam for editing, collaboration, and Markdown export** (one seam, three uses).

**Isolation — sandbox-shaped boundary, in-process to start, tightenable later.** Build plugins
as in-process components now (fast, native, fine for personal use), but the boundary is shaped
*as if* sandboxed: plugins talk to the host only via the registry + a scoped API, never
internals. Dropping in an iframe/Worker sandbox later (for shared/agent-generated plugins) needs
no rewrite. A plugin gets data only through the substrate API, scoped by capability → **a plugin
is a principal, like an agent or a share link** (no fourth auth case).

Smaller: host ships theme tokens / a design system so plugins keep the "one app" feel; the
plugin↔surface line is a **gradient** (a surface ≈ chrome + arranged plugin contributions;
"full view" is the bridge). Cost to accept: the registry + scoped API + tokens are a **stable
contract that must be versioned** — the real tax of extensibility.

---

## Cross-cutting principles

### API-first substrate → agents are just another surface (MCP-friendly)
The API *is* the product; every surface (UI, MCP server, Shortcut, Ollama) is a client, none
bypass it. An MCP server becomes a thin adapter (resources = notes by stable ID; tools = the
same search/create/append/set ops the UI uses). The hybrid spine makes notes machine-legible.
Nearly free now, brutal to retrofit — the highest-leverage decision.

### Markdown as first-class export/import (not storage)
Properties → YAML frontmatter; core blocks → Markdown 1:1; plugin blocks degrade to fenced
typed blocks or best-effort. Keep the internal model structured — Markdown is export/import,
not the source of truth (going full-Obsidian would starve property/search/transport).

### Shareable now, collaborative later
- **Publish-as-URL (read):** cheap, fully compatible — a public read-only surface; build now.
- **Real-time collaboration (write)** reintroduces merge → scope it: a note is **promoted to
  its own Durable Object** running collab just for itself, isolated from the fork-on-conflict
  majority. Design the seam now, defer the build.
  - Collaborative note = **online-only** (kills the offline×collab cross-product).
  - "Read-only shard" = **live one-way** (collaborator sees the owner's edits stream in on
    non-collab blocks, can't originate there).
  - **CRDT scoped to opted-in blocks only**; core text + document structure is the one real
    CRDT investment; every plugin defaults to read-only-shard and opts in.

### Auth — one grant primitive
```
grant = { principal, resource, scope, constraints }
  principal: owner | device | guest | anonymous | agent | plugin
  resource : workspace | notebook:id | note:id
  scope    : [read, write, create, delete, share, search]
```
Every API call passes through **one check: `can(principal, op, resource)?`** — that chokepoint
is the spine. Token types are the same grant, different delivery:
- **Share-link** = a capability URL (`/s/<token>`), anonymous, read or read+write; revoke =
  delete grant.
- **Agent** = handed to an automation, named principal, scoped resource/ops, delivered via MCP,
  revocable + audit-logged.
- **Plugin scope** = system-issued from `(manifest requests) ∩ (user approves)`.

Mechanism: **opaque tokens + a grants registry** (not JWTs) — revocability is first-class.
**Offline auth must not block launch:** device caches a long-lived grant; only *sync*
re-validates server-side (revoked device → sync fails → optional remote-wipe).

**Identity — NO EMAIL ANYWHERE:** passkey (WebAuthn) + 24-word recovery phrase + QR
cross-device join (the full-beans flow). This is the **general identity layer, used always**,
decoupled from E2EE. All access-granting is capability-based; a guest brings their own passkey
or uses a capability URL. (Dropping email removes Resend/magic-links/verification — cleaner,
more private, less infra.)

### Privacy — encryption is a per-notebook capability
Like offline mode, a per-notebook toggle (default convenient, opt into paranoid). This is the
upstream decision that lets auth be concrete.
- **Server-readable (default):** encrypted at rest + transit, server can read → full search,
  AI/agents, sharing, collaboration.
- **Zero-knowledge (opt-in):** true E2EE; accept reduced features — client-side-only search,
  no server AI, key-in-`#fragment` sharing, no collaboration, no dedup, no fine-grained sync.

**Encrypted notes reuse the blob store** (server sees opaque bytes either way; encryption mode
flows to a notebook's notes *and* attachments). Address by `hash(ciphertext)` / note-id+version,
never `hash(plaintext)` (would leak via dedup) → E2EE trades dedup away by design.
Whole-note-blob granularity → naturally uses version-based fork-on-conflict; immutable old
versions ≈ free history. **The hard half is key management, not storage** (notebook key wrapped
by master key; multi-device delivery; sharing = wrap key to recipient). **Notebook-level keys
first**, per-note encryption as a later refinement. E2EE zone deferred to v2.

---

## Prior art / code reuse (packets in `_inbox/`)

The user's two prior Cloudflare projects map onto deltos's two encryption zones and together
cover both backend patterns (D1-direct + DO-as-authority). **Reuse discipline (the hard rule)
and the per-zone reuse plan now live in `KICKOFF.md`.** Summary:

- **trkr** (Dexie + Worker+Hono+D1, LWW) = the **server-readable path**, basically deltos's
  Mechanism A already built. Reuse (rewritten clean): PWA shell + the `/api/` SW denylist
  lesson, the atomic write+enqueue queue, cursor pull, online-only read-mirror, sync indicator,
  timestamp-clamp security lesson. Must change: schema→spine, **LWW→fork-on-conflict**, cookie
  auth→capability/passkey spine. Uses D1 directly (no DO) → justifies DO-only-where-needed.
- **full-beans** (Evolu + passkey + recovery phrase + QR + zero-knowledge DO relay) = the
  **zero-knowledge path**, mined for knowledge. **Adopt the custody flow now** (passkey +
  recovery + QR = our identity layer; answers multi-device key delivery by reference). Mine
  later for E2EE: SLIP-21 key hierarchy, HMAC owner-delete, at-rest on/off migration, DO
  hibernation-WS + DO-SQLite atomicity (also the foundation for collab's promote-to-DO).
- **The E2EE fork (decide at v2):** server-readable and zero-knowledge are mutually exclusive
  at the storage layer on incompatible foundations (Dexie vs Evolu). Options: (a) Evolu as a
  2nd engine, or **(b) lean** — encrypt note payloads → opaque blobs on the same trkr stack
  (one engine, fits fork-on-conflict, mine full-beans for concepts not its engine).

---

## Open items (deferred — not blockers)

- **iOS multi-webclip storage spike (S3) — RESOLVED 2026-06-15** (was: do same-origin webclips
  share storage? quota model? one-clip-per-notebook feasible?). Finding: shared Cache Storage + SW,
  isolated IndexedDB; one-clip-per-notebook endorsed under the SW-never-caches-`/api` invariant.
  See §Platform "S3 RESOLVED" + `docs/specs/phase-1-constraints.md` §Storage isolation. **Fully
  resolved 2026-06-15 (D2 on-device probe): OPFS + IndexedDB both ISOLATED** — webclips don't share
  storage on either backend, so per-notebook blob encryption is NOT forced (PIN-STORAGE-2 trigger
  doesn't fire; only E2EE/v2 would mandate it). Cache Storage remains shared → PIN-STORAGE-1 stands.
- **Gaps framed for later:** history/trash/recovery (make every mutation recoverable);
  organization within a notebook (lean flat+tags+relations); import (Notion/Apple Notes/
  Obsidian/Evernote); editor engine choice (ProseMirror/Lexical/TipTap — decide early in
  Phase 1); notifications/reminders (iOS web push, likely plugin); schema/data migration.
- **E2EE zone option (a) vs (b)** — decide at v2 build time.
