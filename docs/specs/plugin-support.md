# Plugin Support — Design Spec

**Status:** DESIGN (planner: navSys). Un-parks task **#62** (the comprehensive-plugin
phase). Build-ordered, but design-altitude — pilot decomposes into build tasks.
**Date:** 2026-06-24.
**Supersedes / absorbs:** the per-notebook-scoping assumption in
`slash-palette-block-shard-architecture` and `ui-view-driven-architecture` (see §2),
and the `/`-palette + block-shard design notes (folds them in as §10 / §5).
**Sibling inputs:** `inline-formulas.md` (the formula framework = the seed of the
detect-and-transform registry), `custom-keyboard.md` (the Deck).

---

## 0. The one-line thesis

A **plugin** is a *manifest that bundles registrations across the editor's existing
contribution registries* — not just "an editor code-block." deltos already has the hard
seams (the `plugin_block` schema node, the island registry, the formula registry, the
tool-descriptor registry, the Deck adapter, `resolveNoteView`, lazy chunks). **Genuine
plugin support = the manifest + loader + lifecycle that feed those seams, plus the
durability and capability guarantees that make plugin-authored content safe to live in a
notes app forever.**

### The footprint at a glance

A plug-in is a **manifest** bundling a **client half** (view surfaces) + a **server half**
(host capabilities), any subset, around a **domain entity**. Host surface = narrow + fixed;
plug-in surface = broad + composed.

**SURFACES it can register** — block (in-doc shard) · inline entity (link/math/hex/card
detect-and-transform) · note-type (whole-note item-view, may have no editor) · collection-view
(kanban/gallery/calendar — *deferred*) · editor tool · Deck loadout · slash `/` entry (*to
build*) · new-note menu entry (*to build*).

**AXES it works under** — **scope** (`collection ⊃ note-type ⊃ block`, one view contract at
three scopes) · **half** (client views + server capabilities) · **activation** (content-presence
loads, caret-context surfaces UI; notebook = soft ranking hint, never a gate) · **capability/
offline** (offline default / online-only / collaborative; online-only degrades gracefully) ·
**lifecycle tier** (tiny always-present manifest vs load-on-demand runtime).

**RESOURCES it can call from deltos** — the spine (note body + properties bag; per-note
structured data syncs free) + 5 host capabilities: `blob` (R2 files/media, synced) · `records`
(D1 query API for cross-note/indexed data, *not raw SQL*) · `net` (SSRF-guarded egress +
secrets) · `compute` (Worker/AI/Queues: transcode/OCR/transcription) · `schedule`+`notify`
(Cron/DO + Web Push). Capability-scoped host handle enforces account-scope + cost caps.

---

## 1. What a plugin IS (the umbrella)

A plugin is a bundle that may contribute to any of these **extension points**, all of
which already exist as registries today:

| Extension point | Registry today | What a plugin adds |
|---|---|---|
| Inline content-shard (block in the doc) | `registerPluginIsland(pluginType, factory)` (`nodeviews/PluginIsland.ts`) | a `plugin_block` node-view + serialization |
| Inline formula/entity (detect-and-transform) | `createFormulaRegistry()` (`plugins/formula/formulaTypes.ts`) | a type: detect / bracket-resolve / render |
| Editor tool (toolbar / Deck / palette) | `EDITOR_TOOLS` descriptor list (`editor/editorTools.ts`) | a `ToolDescriptor` (command + isActive + surface) |
| Deck loadout / control surface | `DeckLoadoutRegistry` (context→component, `deck/types.ts`) | a loadout shown for a `DeckContext` |
| Note item-view (doc / voice / file / kanban) | `registerNoteView` / `resolveNoteView` (`editor/views.ts`) | a view that matches on note content |
| Slash/palette entry | **does not exist yet** (§10) | an insert/action entry |

A plugin's **manifest** is the single declaration that says *which of these it contributes
to* + its identity + its capabilities. The loader reads the manifest and performs the
registrations. This is the missing spine — everything below it already exists.

---

## 1A. Two contribution SHAPES — block AND note-type (Jim 2026-06-24)

A plugin contributes capabilities around a **domain entity** (a task, a file, a formula),
and that entity can surface at **two scopes**:

- **BLOCK** — embedded *inside* a composition (a checklist item in meeting notes, a file
  mid-doc). The note is still "a document"; the block is one element. → the inline-shard /
  formula / `plugin_block` path.
- **NOTE-TYPE** — the *whole-note* item-view (a dedicated to-do list, a file artifact with
  preview/download). The whole note IS the thing; it may have **no rich editor at all**. →
  the `resolveNoteView` / `registerNoteView` item-view seam (`editor/views.ts`).

**REFRAME (the deltos-vs-Notion distinction):** the rich-text block editor is **itself just
one note-type** — the default item-view — *not* the universal container. deltos is not
doc-only. Some note-types (to-do checklist, file artifact, voice memo) are bespoke surfaces
where a rich editor would be *wrong*. Note-types are NOT a new mechanism: they're the
item-view scope of `ui-view-driven-architecture`, whose seam shipped in v1 with only the doc
view wired in.

**Same entity, two surfaces — register whichever fit, often both:**
- **Task** → inline checkbox block *and* a "to-do note" (checklist + sorting + reminders).
- **File** → inline `[file]` embed *and* a standalone file-artifact note. Same R2 blob /
  content-addressing underneath.

**DECISION RULE:** block when the thing is naturally *part of* a note; note-type when it's
naturally *the whole* note (esp. when a rich editor would be wrong); both when the entity is
meaningful at both scopes. The difference is purely *which surfaces are exposed* — the entity
data/logic is defined ONCE.

**ONE storage substrate (confirmed):** spine = body blocks + open `properties` bag. Item-views
are pure view/interaction layers over it — **no parallel note storage model.** A to-do note =
`task` blocks in the body + `type:todo` discriminator, rendered as a checklist; a file note =
R2 metadata in `properties` + a thin viewer (possibly empty body). Sync / durability / search
stay unchanged.

**What note-types ADD beyond blocks:**
1. **Note item-view = a first-class plugin surface** (not just a row in the §1 table).
2. **A `type` (item-view) discriminator in the note's `properties` bag**; `registerNoteView`
   keys on it → deterministic resolution, not content-sniffing. (Open bag = no schema upheaval.)
3. **Plugins extend the NEW-NOTE creation menu** — not just the slash palette. Blocks are
   *inserted* via `/`; note-types are *created* ("new to-do note", "new file note").
4. The §4/§5/§6 guarantees generalize: render-only previews (a to-do note's search peek = its
   checklist summary; a file note's = a thumbnail), capabilities (a file note is online-only
   for the blob, shows cached metadata offline), and unknown-type durability (an unrecognized
   note-type falls back to showing raw `properties`, never bricks the note).

**THREE nested axes** (full picture): **collection-view (set of notes) ⊃ note-type (item) ⊃
block.** A plugin could touch all three.

**THE SYMMETRY (Jim 2026-06-24):** these are not three mechanisms — they are **ONE
scope-agnostic VIEW CONTRACT instantiated at three scopes.** At every scope a view = *a
renderer + its own properties/config, resolved by a discriminator, registered by a plugin,
with a render-only + edit pair, capabilities, and durability.* Build the contract ONCE; apply
it at block / item / collection. The default at each scope is the general fallback:
collection → **ordered list**, item → **doc editor**, block → **text**; plugins register the
specialized alternatives (kanban / gallery / calendar; to-do / file / voice; table / image).
A plugin bundles surfaces around its entity at whatever scopes it touches — e.g. the **task**
entity → checklist block + to-do note-type + kanban collection-view; the **file** entity →
`[file]` block + file-artifact note-type + gallery collection-view ("special view properties"
= the collection's own config bag, e.g. gallery grid size + sort).

**Collection-view coupling + OPEN FORKS (exploratory — Jim flagged more exploration needed):**
- A collection-view is **parameterized by which note-properties it arranges on** (kanban
  groups on `status`, calendar on a `date`, gallery sorts on …) → depends on **note-types
  declaring queryable properties.** The to-do note-type declares `status`; its kanban groups
  on it. Note-type and collection-view plugins COMPOSE around the shared entity.
- **Collection = SOURCE (notebook / query / manual ordered set) + view + config** — collections
  are NOT only notebooks (search results, all-notes, saved filters, manual sets are collections
  too; cf. `ui-view-driven-architecture`). The view is decoupled from the source.
- **Config home:** notebooks need a **`properties` bag** for view config (today: only `name` +
  `defaultCollectionView`). Source-less collections remember the view per-session.
- **Heterogeneous collections:** what a gallery does with a non-photo note → lean **graceful
  degrade** (render what it understands, list-card the rest), per durability philosophy. Decide.
- **Collection-views EDIT, not just display:** a kanban drag = a write to a note's `status`
  property. The view contract includes edit-affordances at the collection scope too.
- **Perf:** gallery/kanban over a large notebook → many previews → leans hard on the
  render-only lightweight component (§5 fork b) + virtualization.

**DECISION:** lock the **scope-agnostic view-contract principle now** (so collection-views are
a later *registration*, not a refactor); keep collection-view **specifics DEFERRED** for v1
plugin build. **v1 plugin work = block + note-type.**

**Activation (ties to §2):** a note-type activates by the same content-presence principle —
the note's `type` discriminator declares it, the item-view runtime lazy-loads on note-open.
The whole note is the surface, so caret-context UI is secondary (the note-type owns its frame).

---

## 2. Activation & scoping — the model (DECIDED, Jim 2026-06-24)

**Plugins are GLOBALLY available. There is NO per-notebook capability boundary.**
Relevance is enforced by two finer-grained filters that post-date the original model and
do the job better:

- **CONTENT-PRESENCE → loading & rendering.** A note carries its blocks; each
  `plugin_block` self-describes its `pluginType`; the runtime **lazy-loads on demand** when
  that block is present (caret-enter or first render). Cross-context surfaces (all-notes,
  search peek, shared URL, history diff) render **for free** — there is no scope to break.
- **CARET-CONTEXT (the Deck) → UI surfacing.** Plugin controls appear when the caret
  *enters* the block and vanish when it leaves. This is a **per-block** relevance filter —
  strictly better than per-notebook: no notebook-wide clutter no matter how many block
  types *could* appear. The context-aware Deck (`deriveDeckContext` → loadout) is what
  makes notebook-UI-scoping unnecessary.

**Notebook demotes to a SOFT RANKING HINT** (alongside recency + favorites) in the slash
palette's candidate ordering — **never a gate**. A gaming stat-block in a work note isn't
*ranked first* there, but isn't *forbidden*. Zero hard walls + tidy discovery at scale.

> Consequence: **per-notebook plugin-enablement wiring is removed from the build list.**
> No notebook field listing "enabled plugins." Notebooks stay pure organizing contexts.

Rationale + the full reasoning: memory `plugin-activation-content-presence`.

---

## 3. The manifest — two tiers

Un-scoping makes a two-tier split the clean answer (the palette must list a plugin
*before* any block of it exists, yet the heavy code must stay out of first paint per
`plugins-lazy-past-first-paint`):

- **Tier 1 — Manifest (always present, tiny).** `id`, `name`, palette entry (label /
  icon / keywords for autosuggest), **capabilities** (§4), trigger chars / bracket head /
  paste-matchers, the block `type` key(s) it owns, declared storage needs (§7). This is the
  **discovery layer** — cheap enough to register every plugin's manifest at startup without
  touching the entry bundle.
- **Tier 2 — Runtime (load-on-demand).** The node-view factory, the engine, assets,
  the edit/render components (§5). Loaded via dynamic `import()` on **caret-enter-block**
  or **palette-insert**. Rides the deferred editor chunk pattern that already ships.

**Perf gate (binding):** adding a plugin must NOT grow the entry bundle
(`plugins-lazy-past-first-paint`). Manifests are tiny + may live in the entry; runtimes
never do.

---

## 4. Capabilities — declared, enforced by degradation

Each manifest declares a capability set. **Offline-capable is the local-first DEFAULT;**
anything stronger is the declared exception that must degrade gracefully — because in the
un-scoped world (§2) *any block can land in any note / context*.

- `offline` (default) — fully functional with no network.
- `online-only` — needs the network to function; **must ship a degraded/cached render**
  for offline / read-only / shared-URL contexts (never a broken block).
- `collaborative` — opts into real-time collab (future; today's hint: a `collaborative:true`
  manifest upgrades an atom to a Durable-Object-backed block — `PluginIsland.ts:24`).
- `storage` — needs out-of-band, account-scoped, synced storage (§7).
- `network` — makes outbound fetches (gates a future trust/sandbox review, §8).

Enforcement is by **render-context**: the render-only path (§5) passes the context
(`live-edit | read-only-preview | offline | shared`) so a block can pick its degraded form.

> **🔒 secSys forward-watch (A3, #679/#677):** `capabilities` drive **RENDER DEGRADATION ONLY**,
> never ACCESS CONTROL. A3 is the first code to *read* `capabilities` (to pick a degraded render
> form) — that stays a presentation choice. "`online-only` → degraded render" must NOT drift into
> "`online-only` → client-side allow/deny the fetch." **The access decision always stays
> server-side** (HC-A1-1). secSys watches when A3 (#125) lands.

---

## 5. The block presentation contract (edit / render / render-only)

A block ships its presentation **once**; the same definition drives both an **edit view**
(interactive, mounted in ProseMirror) and a **render-only view** (read-only, mounted
*outside* an editor — search peek, list preview, history diff, share/publish).

**DECIDED FORK (b):** the block exposes a **pure render component** (`spine block →
component`), which the in-editor node-view wraps, and read-only paths use **directly — no
ProseMirror in preview/search/share**. Lighter (holds `performance-is-a-standing-value`),
and deltos already has the spine↔PM serializer that makes a spine-driven render component
natural. (Rejected: fork (a), a non-editable PM view — exact but drags PM into every
read-only path.)

So the block contract = **node + serialization + (render-only component, edit view) pair +
manifest entry**. The render-only component receives the block payload + the render-context
(§4) and returns display DOM/React; the edit view is the node-view that wraps it and adds
interaction.

---

## 6. Durability, unknown blocks, versioning

A note's doc may carry a block whose runtime is **not present** here (not yet loaded, code
absent on this device/build, a version skew). This must be **lossless** — non-negotiable in
a notes app.

- **Already solved at the seam:** an unrecognized spine block type round-trips back through
  `plugin_block` (`serializer.ts:425-429`) and renders via `UnknownPluginIslandView` as a
  `[pluginType]` placeholder rather than being dropped (`PluginIsland.ts:50-67`). The opaque
  `pluginContent` payload survives a full edit/save/sync cycle untouched.
- **To build:** (a) a friendlier placeholder (named, "loading…" vs "unavailable", with the
  raw payload preserved); (b) **versioning** — the manifest declares a payload `schemaVersion`;
  the runtime provides a forward-migration `migrate(payload, fromVersion)` so a v1-authored
  block upgrades when a v2 plugin opens it. Migration is lazy (on open), never a bulk pass.

---

## 7. The server half — host CAPABILITIES (not enumerated plugin features)

**PRINCIPLE (Jim 2026-06-24):** plugin needs are unbounded — do NOT enumerate them.
Enumerate the **host's capabilities** (a small fixed primitive set) and let arbitrary plugin
needs *compose* from them. The host surface is narrow + fixed; the plugins' is broad +
composed. The manifest declares which capabilities it requests (extends §4); the host grants
a **capability-scoped handle** (§8) and **enforces account-scoping + cost caps itself, never
the plugin.**

**A plugin = manifest + a CLIENT half (the views, §1A) + a SERVER half (these capabilities)
— any subset.** Client-only (formula/math); both halves (attachment = embed + `blob`; to-do =
checklist + `schedule`/`notify`; TTRPG = stat-block + `net`).

### The primitive set (v1 frame)

| Capability | Covers | Backed by | Offline |
|---|---|---|---|
| **`blob`** | files / photos / video / voice memos | R2, content-addressed, byte-synced | ✅ cached |
| **`records`** | queryable structured data: search index, "all-tasks" aggregate, reminder index, table-plugin store | D1, namespaced per-plugin, account-synced | ✅ synced |
| **`net`** | remote pulls (TTRPG stat-block API, unfurl) | host-guarded egress (SSRF, per #71) + per-plugin secret storage (API tokens) | ❌ online-only |
| **`compute`** | HEIC/JPEG/PNG↔WebP, OCR, transcription (Whisper, built), business-card→CSV | Worker routes / Workers AI / Queues (heavy→async) | ❌ online-only |
| **`schedule` + `notify`** | to-do reminders firing note-closed | Cron / DO alarms + Web Push | ❌ online-only |

**`records` vs the spine (keeps the surface small):** per-NOTE structured data (a table's
cells) rides the **spine block payload for FREE** — syncs like everything else. `records` is
ONLY for data that must be **queryable across notes / indexed / aggregate**. Most "I need a
database" cases stay on the free path. **`records` is a host-mediated query API, NOT raw SQL**
— account-isolation, sync, and migration are host concerns, never trusted to plugin SQL.

**Offline characteristic (ties §4):** `blob` + `records` are syncable / offline-capable;
`net` / `compute` / `schedule` / `notify` are **online-only → the client degrades gracefully**
(queue the job, "will process when online", show the cached last result).

**Maps onto our stack with NO new infra category:** R2 (`blob`) · D1 (`records`) · guarded
Worker fetch + Secrets Store (`net`) · Worker routes / Workers AI / Queues (`compute`) · Cron
Triggers / DO alarms + Web Push (`schedule`/`notify`). We *expose* what Cloudflare already
gives us as capabilities, not build a platform.

**Trust (extends §8):** the server half is where security + cost live (`net`=SSRF,
`compute`=cost/DoS, `records`=tenant isolation). v1 first-party still routes THROUGH the host
handle (host enforces scope + caps — cf. the transcribe-throttle ruling). Future untrusted /
AI compute → a real sandbox (CF sandbox-sdk / isolated Workers / Queue limits); the handle
makes it additive. **A genuinely new primitive = a rare, deliberate host extension — not the
per-plugin default.**

**First consumer:** the **attachment plugin** (§10) forces `blob` concretely (byte-sync /
content-addressing / R2); other capabilities are built as their first real consumer needs
them, never speculatively.

---

## 8. Trust / sandbox posture

Plugins ship **code**. v1 posture (Jim-only, first-party — `build-for-the-actual-user`):
**trusted, full main-thread access. No sandbox.** But because §9 (MCP/AI-drivable) points
at eventually-untrusted or AI-generated plugin code, **the registration API must not bake in
unlimited ambient trust** — plugins receive an explicit, capability-scoped host handle
(storage / commands / doc access granted per manifest, §4), not a free grab of the global
store. That keeps a future sandbox boundary (iframe/worker for `network`/untrusted plugins)
addable without a rewrite. **secSys gates this section** before any third-party/AI path.

---

## 9. API-first / MCP-drivable

The same registries the UI drives must be expressible as tool calls so plugins are drivable
by MCP / AI agents later. Foundations already present: the Deck `KeyActions` are abstract
(insert/enter/backspace/moveCaret), `ToolDescriptor` is data-driven (command + isActive),
the island factory accepts any renderer. **To build:** an explicit **plugin-call contract** —
structured input/output schemas per command (schema-first, per the `schema-first` skill) so
an agent can enumerate a plugin's commands and invoke them with validated payloads. The
manifest's command list IS the agent-facing surface.

### 9A. The AGENT GUIDE — domain competence ships with the plugin (Jim 2026-06-24)

**The missing half of API-first.** A call-schema tells an agent the *shape* of an operation
(`addSplice(fromCable, fromTube, fromFiber, …)`) but NOTHING about what it MEANS or the STRATEGY
to use it. Handed a domain artifact cold, an agent must reverse-engineer the domain — and guesses
wrong. So every MCP-accessible plugin ships a **first-class agent guide / playbook** in its
manifest: the agent-facing analog of the views humans get.

**THREE AUDIENCES, one definition:** human-viewer → render-only component (§5) · human-editor →
edit view + UI · **agent-driver → MCP tools + the agent guide** (the new piece).

**The guide's four parts:**
1. **Ontology / glossary** — domain vocabulary + conventions (the semantics that turn shorthand
   into structure). *Fiber example: the TIA-598 color order → "Aqua tube" = tube 12, "pink fiber"
   = Rose = 11, "Y,V,R,A" = the last four tubes; can/cable/tube/fiber hierarchy; "spliced through"
   = a pass-through range mapping.* None of this lives in a JSON schema.
2. **Playbook** — intent → operation recipe (the worked procedure for translating a request into a
   sequence of plugin calls).
3. **Worked examples** — sample input → exact tool-call sequence → result. Few-shot, so the agent
   pattern-matches instead of theorizing.
4. **Conventions & ambiguity rules** — defaults + *when to ask the human vs. assume*.

**Static guide + dynamic state:** the static guide = *how to drive me*; an MCP **resource** exposes
*what's here now* (e.g. the cables already in this note) for the agent to read before acting.

**THE 90% PRINCIPLE (why partial is safe):** the guide need only get the agent to ~90% via guided
tools — **the plugin's own UI is the human's last-10% correction surface.** Agent drafts → human
verifies/fixes in the UI → exports. Agent-driven bulk + human-UI verification COMPOSE; that
composition is what makes "even if it isn't perfect" acceptable. (Maps onto MCP-native delivery:
rich tool descriptions + a per-plugin server-instructions/prompt + example prompts + ontology as a
resource.)

**Why it's strategic:** without it every agent re-educates itself on every domain every time; with
it, **domain competence ships with the tool** (author the fiber guide once → any agent is instantly
fluent). Doubles as the plugin's human documentation. This is the headline that makes AI-drivable
plugins work in PRACTICE, not just principle. Delivered over the access axis (§14).

**LOCALITY — the agent surface is BACKEND-RESIDENT (Jim 2026-06-24), and that's a gift.** The three
audiences map to three locality tiers: human-viewer + human-editor = **CLIENT** (lazy past first
paint, bundle-cost-sensitive, MUST work offline per [[offline-never-gate-on-network]]); agent-driver
= **BACKEND-ONLY** (the guide + runbooks + MCP tool defs are served by the Worker to a connecting
agent; the LLM consumer lives OUTSIDE the device, never in the client bundle). The human half and
the agent half therefore have **OPPOSITE constraint profiles**, and the heaviest complexity (rich
ontologies, large few-shot sets, elaborate playbooks) sits entirely on the side that is NEITHER
bundle-sensitive NOR offline-constrained. Three consequences:
1. **Zero client-bundle cost** — the perf gate ([[performance-is-a-standing-value]]) CANNOT be
   regressed by agent complexity, by construction.
2. **No offline burden** — agent control is STRUCTURALLY online (remote consumer ↔ backend over the
   network), not a dropped feature; the offline case can't arise, so there's no degradation matrix.
3. **Author it rich** — no size budget, iterate freely; the cost of making the AI story GOOD is low.

Robust even if **in-app AI** is added later (a "summarize" button inside deltos) — that's a thin
client caller of the same backend MCP surface; the guides still live in the backend, never the
bundle. **So the two things deltos cares most about — load-feel and offline — are exactly what the
agent layer cannot threaten.**

---

## 10. First consumers (prove the API against real needs, not speculation)

Two concrete first consumers pull the runtime API into existence:

1. **Slash `/` palette** (does not exist yet). The unified insert/command surface, fed by
   the manifest registry. Lists insertable block types + format tools + actions; autosuggest
   filter; notebook/recency/favorites as soft ranking (§2). Desktop-primary (slash fights
   the mobile soft keyboard; mobile already has the grouped Deck tray). Shares a
   caret-anchored-popup primitive with the deferred link popover.
2. **Attachment plugin** (image/file embed). The **first real block-shard** AND the first
   real consumer of: the runtime registration API, the block presentation contract (§5), the
   storage capability (§7, R2 blobs / content-addressing), and capability declaration (§4).
   Designed *with* the framework, against a concrete need.

These two + the manifest/loader are the minimum that turns "we have seams" into "we have
plugins."

---

## 11. What already exists (inventory, ui-refresh @ 2026-06-24)

| Seam | Status | Ref |
|---|---|---|
| `plugin_block` node (id / pluginType / pluginContent, atom) | ✅ exists | `editor/schema.ts:185` |
| Opaque round-trip + unknown-type fallback | ✅ exists | `serializer.ts:425`, `PluginIsland.ts:50` |
| Inline-shard registry (in use: link_card) | ✅ exists | `nodeviews/PluginIsland.ts:34` |
| Formula registry (per-view instance; math/hex) | ✅ exists | `plugins/formula/formulaTypes.ts:90` |
| Tool-descriptor registry | ✅ exists (read-only) | `editor/editorTools.ts` |
| Deck framework + adapter seam (PM-free core) | ✅ exists | `deck/`, `editor/deckAdapter.ts` |
| Note item-view resolution seam | ✅ exists (one view) | `editor/views.ts` |
| Lazy routes + dynamic chunks + SW precache | ✅ exists | `App.tsx`, `sw.ts` |
| **Plugin manifest + loader + lifecycle** | ❌ design-only | §1, §3 |
| **Capability declarations** | ❌ design-only | §4 |
| **Render-only component contract (fork b)** | ❌ design-only | §5 |
| **Versioning/migration** | ❌ design-only | §6 |
| **Plugin storage capability (R2 byte-sync)** | ❌ design-only | §7 |
| **Slash palette** | ❌ does not exist | §10 |
| **Plugin-call schema (MCP)** | ❌ design-only | §9 |

---

## 12. Build decomposition — TWO TRACKS

The work splits into two independent tracks. **Track A = the plugin framework + plugins
(build NOW).** **Track B = the access/AI/agent story (deferred; starts with addressability).**
Track A does NOT depend on Track B — a content-addressed blob embedded in a doc needs no
note-URLs — so the framework can start immediately.

**Every Track-A slice is independently shippable and holds these gates:** the **perf gate**
(entry bundle must NOT grow — §3, [[plugins-lazy-past-first-paint]], enforced by the #72 strict
build + entry-bundle check, which lands FIRST); the **rendered-UI gate** (DOM-assert tests +
Jim on-device smoke before deploy — [[ui-features-need-rendered-ui-gate]]); and **deploy holds
for the planner's go → Jim feel-tests on live** ([[review-on-live-never-local-preview]]).

### Track A — the framework (build now)

- **A0 — land #72** (strict prod build + entry-bundle-size check in the pre-flight gate) FIRST,
  so the perf gate self-enforces on every plugin PR.
- **A1 — Manifest + loader + two-tier registration spine** (§1, §3). Pin the manifest shape
  (§13 leans: built-in array; manifest *aggregates* the existing registries). Loader registers
  manifests at startup (tier-1, in entry), lazy-loads runtimes on demand (tier-2). **Re-home the
  existing formula/embeds/tools behind it as the first "internal plugins" — behavior-preserving;
  this IS the de-risking proof.** Formalize the friendlier unknown-block placeholder (§6).
  *Accept:* existing plugins work unchanged through the manifest; entry bundle does not grow.
  **🔒 secSys HARD CONDITIONS (gate #662, 2026-06-24 — bake in from the start, the load-bearing
  one is HC-A1-1):**
  - **HC-A1-1** — capability ENFORCEMENT lives **SERVER-SIDE** at each capability's Worker route,
    keyed on **server-derived `accountId`** (`requireAccountId`) + **host-attested `pluginId`** —
    NEVER in the client handle alone. The client handle = ergonomics + the future-sandbox seam;
    the server route IS the boundary. (In v1 a trusted plugin can bypass the client handle —
    import raw Dexie, call `fetch()` — so client-only enforcement is insecure the moment a plugin
    is untrusted OR a first-party plugin has a bug.)
  - **HC-A1-2** — data-scope is ALWAYS the calling session's `accountId` (BOLA); `pluginId` is
    HOST-ASSIGNED at registration, never client-claimed (cross-plugin isolation rests on this).
  - **HC-A1-3** — NO raw-SQL / NO raw-egress escape hatch; capabilities are bounded STRUCTURED
    APIs (a plugin-supplied SQL/filter fragment or arbitrary fetch URL reopens injection/SSRF).
- **A2 — Render-only component contract** (§5, fork b). Spine→shared render component; retrofit
  `link_card` as the proving case. *Accept:* link_card renders read-only OUTSIDE an editor;
  search/preview paths don't pull prosemirror-view.
- **A3 — Capability model + degraded render** (§4). Manifest declares capabilities; render-context
  plumbed. *Accept:* an online-only block shows a cached/degraded form offline, never broken.
- **A4 — Attachment plugin + `blob` capability** (§7, §10.2) — first real NEW block-shard; forces
  R2 content-addressing + byte-sync + the capability-scoped host handle. **secSys-gated** (trust
  handle + R2 quota/abuse + account-scoping, §8). *Accept:* drop image/file → stored in R2
  content-addressed, syncs across devices, renders inline + render-only, offline shows cached.
  **⛔ BLOB GATE — secSys HARD CONDITIONS (gate #662); these ARE A4's acceptance criteria, secSys
  re-audits the A4 build before its deploy-go:**
  - **HC-A4-1** — blob ACCESS boundary = **the R2 KEY CONSTRUCTION** (secSys #667 refinement of the
    `{accountId}/{hash}` decision below): the Worker builds the key as
    `{server-derived-session-accountId}/{hash}`, NEVER from a client-supplied accountId — so account
    B requesting hash-X gets `{B}/{hash-X}` → 404 (A's blob lives at `{A}/{hash-X}`). The prefix
    structure ITSELF enforces isolation + kills the existence oracle; **never serve a blob by hash
    alone.** A refs/metadata table then exists only for LISTING/GC, NOT as the access gate.
  - **HC-A4-2** — server **recomputes + verifies** the content hash on upload; reject a
    client-claimed-hash mismatch (else a poisoned CAS store serves X for hash-of-Y).
  - **HC-A4-3** — stored-XSS: NEVER serve user blobs as inline `text/html` or `image/svg+xml` on
    the app origin; force `Content-Disposition: attachment` for non-displayable types and/or serve
    from a separate sandboxed origin; use the stored/sniffed type, not a client-claimed one.
  - **HC-A4-4** — per-account storage **quota** + per-upload **size cap** + upload **rate-limit**,
    server-enforced. Generous for v1-solo; durable per-account quota HARD before multi-user.
  - **HC-A4-5** — R2 bucket NOT public/listable; ALL access via the Worker (checks the ownership table).
  - **DECISION (navSys, 2026-06-24; secSys-endorsed #667 as cleaner+stronger than a global-hash +
    ownership-table): R2 key = `{accountId}/{hash}`** (accountId always SERVER-DERIVED) — within-account
    dedup, cross-account isolation, the key construction IS the access gate (HC-A4-1). Kills the
    file-existence oracle at zero cost to v1-solo + avoids a pre-multi-user migration. (Global
    hash-only keys rejected — they leak a "someone else holds this file" oracle on dedup hit.)
    HC-A4-2 still required even per-account: a client could poison its OWN namespace.
  - **TYPE-CONTRACT (secSys #679, folded into the A4 gate — NOT an A1 blocker):** the capability
    type splits so a **backend-resource capability** (`blob`/`records`/`net`/`compute`/`schedule`/
    `notify`) is a DISTINCT kind from a client-only one (`offline`/`online-only`), and the
    backend-resource kind STRUCTURALLY implies a server-enforced route + host-attested `pluginId` at
    the declaration site (so a backend cap can't be added client-only-enforced by accident). It is
    BELT (a guardrail making accidental client-only-enforcement visible), NOT enforcement — the
    runtime check is suspenders. **devSys-2's choice WHERE to land the split: in A1 now** (natural
    home, cheap — `storage`/`network` already exist as §4 values) **OR with A4** (shaped by the
    concrete `blob` need). Either satisfies; **A4's re-audit gates BOTH (a) the type encodes
    backend-resource ⇒ server-route + host-attested pluginId AND (b) the runtime blob route actually
    enforces server-side.** Don't let "we typed it" substitute for the runtime check.
  - **BUILD-GATE:** A4 implementation HOLDS for secSys RE-AUDIT before deploy-go (#129 cleared the
    DESIGN; the build still needs eyes). Re-audit checklist (secSys #667/#679): server-derived
    accountId in every key · server-side hash-verify on upload · safe-serving content-type +
    Content-Disposition · quota/size/rate server-enforced · private R2 bucket · enforcement in the
    Worker route not the client wrapper (HC-A1-1) · the backend-resource type-contract (a). Ping
    secSys when A4 lands.
- **A5 — Slash `/` palette** (§10.1) — discovery surface over the manifest registry; desktop-primary.
  Can follow A1 in parallel with A2–A4.
- **A6 — Versioning/migration** (§6) — manifest `schemaVersion` + lazy migrate-on-open. Hardening.

### Track B — access / AI (deferred; designed-for, §14 + §9A)

Starts with **addressability** (its own focused mini-spec: note/collection URL shape, routing,
access control, interaction with the synthetic-default/notebookStore model), then the grant /
access-token layer, then the MCP surface + per-plugin agent guides, then share, then collab.
Gated on secSys throughout (most security-sensitive axis).

---

## 13. Open questions for the build phase

- **One unified registry with typed entry-kinds** (`insert-block | format-tool | action |
  note-view | loadout`) vs the manifest *aggregating* the several registries that exist. (Lean:
  manifest aggregates — don't collapse the working registries into one.)
- **Render component framework:** React component vs framework-agnostic render fn. (deltos is
  React; lean React component receiving `(payload, context)`.)
- **blockId re-mint rules** on copy/paste/split for plugin blocks (stable-id semantics).
- **Manifest source:** a static built-in array (v1, first-party) vs a loadable manifest format
  (later, for third-party/AI). Lean: built-in array now, shaped so a loadable format is additive.
- **Migration trigger:** lazy-on-open only, or also a background sweep? (Lean: lazy-only — no
  bulk passes, per the disposable/clean-state posture and perf.)

---

## 14. The ACCESS axis — API / shareable URLs / collaboration (designed-for, DEFERRED)

A **fourth orthogonal axis** beyond surface / scope / client-vs-server / capability: **who or
what can reach the data, and in what MODE** — deltos's boundary to the outside. Jim's headline
direction (2026-06-24): *the API + sharing + collaboration are what make deltos more than an
everyday notes app — the substrate becomes a system other tools and agents plug into.*
Stress-tested 2026-06-24; the locked architecture **survives and is reinforced** (below).

**UNIFYING MODEL — API, share, and collab are ONE grant, not three systems:**

> **`(principal, capabilities, data-scope, mode) → token`**
> - **principal** — the user · an external agent (API token) · an anonymous link-holder (share
>   token) · another account (collaborator)
> - **capabilities** — read / write / append / upload / invoke-plugin-command — *the SAME
>   vocabulary as plugin host-capabilities (§4/§7)*
> - **data-scope** — a note · a collection · a notebook · the account
> - **mode** — preview (read) · contribute (scoped write) · collaborate (write + realtime)

**Instantiations:**
- **API (agent-drivable, MCP)** — grants to agent-principals over an MCP surface; realizes §9.
  **Plugins EXTEND the API** — a plugin's call-schemas (§9) become agent-callable operations.
  Bidirectional: inbound (Claude/Gemini/IFTTT call deltos) + outbound (deltos triggers external
  via `net`/webhooks). E.g. "summarize my to-dos" = query+read; "add summary to ideas notebook"
  = scoped write.
- **Shareable URLs** — grants to (often anonymous) link-holders. Preview-only = the **render-only
  component (§5 fork b)**, already designed with publish/share in mind, served from a public
  Worker route, no auth. Contribute = a scoped write grant (the document-capture **dropzone** =
  a `blob`-append grant to one collection, size/count-capped, expirable, revocable — the grant
  IS the enforcement+throttle point, reusing host-handle caps §7/§8).
- **Collaboration** — a PERSISTENT write-grant to another authenticated account, write+realtime
  mode, **DO-backed** (the `collaborative` capability; DOs already the named substrate).
  **Deferred-as-a-plugin is SOUND** — collab is just this grant model + DO realtime, so the grant
  layer is the seam that makes it additive. The plugin Jim plans to build plugs in here.

**TWO foundational prerequisites this surfaces:**
1. **ADDRESSABILITY / routing** — notes + collections need stable, deep-linkable identity (today
   a notebook lives in `currentNotebookId`, NOT the URL). Prerequisite for **backlinks, share
   URLs, AND API targeting** — one layer unblocks four features (also unblocks per-notebook
   icons, [[per-notebook-homescreen-icons]]). **Highest-leverage foundational piece — worth
   pulling EARLIER than the rest of the access axis.**
2. **The GRANT / access-token layer** — `(principal, capabilities, data-scope, mode)`. A new
   **external-auth surface** (API tokens / share tokens / OAuth) beyond the PWA session cookie.

**SECURITY (most sensitive axis — secSys-gated throughout):** anonymous write (dropzone) =
unauth-upload abuse/DoS → bounded by the grant (caps/expiry/revoke, cf. transcribe ruling).
Public preview = data-exposure (assume shared = leaked; render-only must leak NOTHING beyond the
note). **Reconciles with the auth-friction north star** ([[auth-friction-philosophy]]): it gates
EXTERNAL principals; the day-to-day USER stays ungated — no violation.

**RELATED FEATURE — note-linking + backlinks (not a core need; fits as a plugin):** note→note
linking = another **inline-entity type** (`[[note]]` in the detect-and-transform family); the
**backlink reverse-index = a `records` consumer**; "linked references" = a view contribution. So
backlinks need no new primitive and could ship as a wikilink/backlinks PLUGIN, not core — gated
on the **addressability** prerequisite above. Product question (open): how far to lean
networked-thought vs clean-notes.

**STATUS:** DEFERRED (designed-for). The grant model + addressability are captured so foundation
work doesn't paint them out; **addressability is the one piece worth sequencing early** because
four features depend on it.
