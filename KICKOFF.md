# deltos — Build Kickoff

> **Note (v1 shipped 2026-06-24):** Two superseded items: (1) Identity = passkey/signed-challenge was abandoned 2026-06-17 in favour of username+password (see `auth-pivot-scope-map.md`). (2) Editor engine resolved = ProseMirror. Stack, architecture, and process sections otherwise accurate.

**Status:** design phase complete (2026-06-15). This document is the **build plan** —
what deltos is, the locked architecture, the reuse rules, and the ordered roadmap. The
next session starts with a **composer (orchestrator) + a full team** to begin building.

**Doc map**
- **`KICKOFF.md`** (this file) — build plan, roadmap, process. Read first.
- **`brainstorm.md`** — full design rationale (the *why* behind every decision). Reference.
- **`_inbox/OFFLINE_SYNC_HANDOFF.md`** — trkr extraction packet (server-readable sync stack).
- **`_inbox/SECURITY-STORAGE-SYNC-EXTRACTION.md`** — full-beans packet (passkey/recovery/QR
  custody + zero-knowledge crypto).

---

## What deltos is

A private, multi-surface notes framework. **One thesis:** every notes app couples its UI
to its data model, so the model can only be as flexible as one UI stays usable (Notion =
powerful but heavy; Simplenote = effortless but shallow). deltos **decouples them** — one
shared substrate (DB + sync + search + schema), many purpose-built **surfaces** (routes in
a single PWA, each pinnable as a home-screen icon), with **notebooks** carrying capabilities
and **plugins** extending data + UI. One database, many paths in.

*deltos* (δέλτος): the Greek wax tablet — one reusable surface you write anything onto.

---

## Locked architecture (one-line each; full rationale in `brainstorm.md`)

- **Platform:** local-first **PWA**, home-screen installed. Render-before-data + SW precache
  → launch feels ~native. Portable to a native shell later if ever needed (no rewrite; long-term
  native target = Android).
- **One PWA, surfaces = routes**, each optionally pinned via Add-to-Home-Screen at its route.
  `/new` route = instant-capture icon. Not multiple PWAs.
- **Sync:** online-first (~95%). **Optimistic write buffer + stale-while-revalidate reads**
  on every notebook. Offline notebooks = read-only whole-notebook cache. **Fork only on
  actual conflict** (version-counter check on flush) — no CRDT/merge.
- **Spine (data model):** every note = **identity + property bag (loose, optional schema) +
  nestable block body**. A note is simultaneously a record and a document. `relation` is a
  core property type. Plugins extend via exactly two seams: **property types & block types**.
- **Search:** one uniform index (title + indexable properties + each block's `searchText()`).
- **Embeds & storage:** owned media = core block types; remote embeds = pointers. Blobs live
  behind a **pluggable, content-addressed blob-store interface** (R2 cloud / OPFS local) —
  notes reference blobs by hash, never a vendor URL.
- **Data ownership** is a first-class principle: Markdown export, pluggable/self-host storage,
  local replicas, open documented API. **Backup-via-replica:** local store is a first-class
  restorable replica, not a throwaway cache.
- **Plugins:** one **manifest = capability flags + contribution registry**. Six UI slots
  (block/property/command/panel/full-view/settings). Host owns chrome, plugins fill slots.
  Plugin block = opaque **island** (= the same seam for editing, collab, and Markdown export).
  **Isolation: sandbox-shaped boundary, in-process to start, tightenable later.**
- **API-first substrate:** the API *is* the product; every surface (UI, MCP agent, Shortcut)
  is a client. Makes deltos MCP/agent-friendly for free.
- **Auth = one grant primitive** `{principal, resource, scope, constraints}` through one
  `can()` check. Share links, agent tokens, plugin scopes are the same grant, different
  delivery. Opaque tokens + grants registry (revocable). **Offline auth must not block launch.**
- **Identity: passkey + 24-word recovery phrase + QR cross-device join. NO EMAIL ANYWHERE.**
  All access-granting is capability-based; guests bring their own passkey or use capability URLs.
- **Encryption is a per-notebook capability:** server-readable (default, full features) vs.
  zero-knowledge E2EE (opt-in, reduced features). Encrypted notes reuse the blob store as
  opaque ciphertext. E2EE zone deferred to v2.
- **Cloudflare:** default path = **D1 + Worker** (trkr proves no DO needed). **Durable Objects
  only where needed** (live collaboration's promote-to-DO seam; the E2EE relay). R2 for blobs.

---

## Tentative stack (confirm/seed in Phase 0)

- **Frontend:** React + Vite + TypeScript; `vite-plugin-pwa` (injectManifest); Zustand;
  Dexie over IndexedDB; OPFS for large blobs.
- **Backend:** Cloudflare Worker + Hono + D1; R2 for blobs; Durable Objects reserved for
  collab/E2EE-relay.
- **Identity/crypto:** WebAuthn passkey + BIP39 recovery phrase + QR (mined from full-beans).
- **Editor engine:** OPEN — ProseMirror / Lexical / TipTap. Decide early in Phase 1 (it
  implements the nestable block spine). Treat as a Phase-0/1 decision spike.

---

## ⚖️ Reuse discipline (HARD RULE — every spec carries it as acceptance criteria)

Prior projects (trkr, full-beans) are **reference & adaptation sources, NEVER a base to
patch.** deltos is authored fresh and clean. We extract *understanding* and *known-good
patterns* — not files to copy-and-bend. Anything "almost right but not quite" is **rewritten
until it reads as if authored for deltos from day one** (naming, types, assumptions,
structure all native). No vestigial `trkr`/`full-beans` shapes, no task/service leftovers,
no Evolu-isms in non-Evolu files. Grab only what's needed, when needed — no speculative
wholesale imports.

**Litmus test (acceptance gate):** *would a stranger reading the file cold guess it was
lifted from another project?* If yes, it's not done. The packets give velocity of
*understanding* (skip rediscovering the `/api` SW denylist bug, the sync timestamp-clamp,
the SLIP-21 key-separation) — not velocity of paste.

---

## Build sequencing — there is NO "extraction" phase

Extraction is a **mode within feature work**, not a phase (a standalone extraction step
invites port-then-patch, which the discipline forbids — you can't rewrite trkr's sync engine
to deltos-native quality before the deltos spine exists to rewrite it *into*). Only two
things legitimately come first, and neither is "extract code":

1. **Phase 0 — deltos's own thin foundation** (authored fresh; prior projects only inform
   config & save gotchas).
2. **A throwaway de-risking spike batch** (learn-and-discard; sizes/shapes specs, not kept code).

Everything else is just-in-time inside the relevant feature slice, each carrying the
rewrite-to-native gate.

---

## Roadmap

### Phase 0 — Foundation (deltos's own skeleton)
Repo structure, TS/build tooling, `vite-plugin-pwa` shell (incl. `/api/` SW navigation
denylist), Worker+Hono+D1 scaffold, core spine TypeScript types, the API-contract stub.
**Done when:** an empty-but-clean app boots offline as an installed PWA and the API contract
+ spine types exist to build against. *Reference: trkr shell/tooling config.*

### Spike batch (parallel, throwaway — runs alongside Phase 0)
- **S1 — full-beans custody extractability:** is passkey + recovery-phrase + QR cleanly
  liftable *independent of Evolu's `AppOwner`*? (Decides identity build + E2EE option (b)
  feasibility. **Highest value — identity is load-bearing and email-free.**)
- **S2 — trkr sync-engine sizing:** how much changes for the block-tree spine + LWW→fork-on-
  conflict? (Sizes the substrate slice.)
- **S3 — iOS multi-webclip storage:** do same-origin webclips share storage? in-scope nav
  stays standalone? per-origin vs per-webclip quota? feasibility of one-storage-clip-per-
  notebook? (Not blocking — informs the storage-clip lean.)

### Phase 1 — v1 vertical slice (the thesis-prover)
Substrate + spine + sync (server-readable, D1) + **one capture surface** + passkey/recovery/QR
identity, end-to-end. Pick the editor engine here. **Done when:** you can install the PWA,
unlock with a passkey, create/edit a note offline, and watch it sync — all on clean
deltos-native code.

### Phase 2 — prove the decoupling
A **second surface** (the moment the surface/substrate thesis proves out) + notebooks +
universal search + the plugin **manifest/contribution-registry MVP** (one real plugin).

### Phase 3 — breadth
Embeds + blob store (R2/OPFS), capability-URL sharing (publish-as-read), data ownership
(Markdown export), backup-via-replica, more surfaces/plugins, history/trash.

### v2 / later (deferred, framed)
E2EE zone (decide option (a) Evolu vs (b) encrypt-on-trkr-stack), live collaboration
(promote-to-DO), import (Notion/Apple Notes/Obsidian/Evernote), notifications/reminders,
schema/data migration.

---

## Team & process

- **Planner (me)** holds the durable design thread, turns roadmap into specs, and hands each
  ready spec to the **composer/orchestrator** (`coord msg <composer> "<spec>"`). User-facing
  questions bounce back up to the planner.
- **Composer/orchestrator** decomposes specs across subordinates and integrates.
- **Suggested shape:** composer on a strong model (Opus); 2–4 subordinates on Sonnet for
  implementation. Scale subordinates to phase width (spike batch + Phase 1 wants ~3 parallel).
- **Every spec includes the reuse-discipline gate** and names exactly what prior-art it may
  reference.

## First actions for the build session
1. Launch composer + subordinates on `deltos`; confirm `coord team`.
2. Planner drafts + hands the **Phase 0 foundation spec** and the **three spike specs** (run
   in parallel).
3. On spike results, planner finalizes the **Phase 1 vertical-slice spec** (incl. editor-engine
   choice) and hands it down.

## Still-open (decide at the relevant slice — not blockers)
- Editor engine (Phase 1). Organization within a notebook: flat+tags+relations lean (Phase 2).
- Offline cache text-only vs full media (Phase 3). E2EE option (a) vs (b) (v2).
