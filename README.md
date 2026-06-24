# deltos

**A private, local-first notes app — one substrate, many surfaces.**

deltos is a local-first, offline-first **PWA notes app** built to feel *instant*: it renders
your notes from the local store the moment it launches, then syncs in the background. On real
hardware it **beats Apple Notes on load** — that bar is a standing value, not a one-time win.
Under the hood it's a single shared substrate (database + sync + search + schema) that many
purpose-built **surfaces** read and write through, with **notebooks as contexts** and a
**view-driven** UI that's designed to grow without rewrites. Sync is real but never in your
way; your data stays yours.

> *deltos* (δέλτος): the Greek wax writing tablet — one reusable surface you write anything
> onto, then smooth and reuse.

It is live on **https://deltos.blackgate.studio** and in active on-device dogfood.

---

## Table of contents

- [Ethos / Philosophy](#ethos--philosophy)
- [Tech Stack](#tech-stack)
- [Architecture](#architecture)
- [Feature Specs](#feature-specs)
- [Project Status & Roadmap](#project-status--roadmap)
- [Repo Layout](#repo-layout)
- [Development](#development)

---

## Ethos / Philosophy

deltos's design is governed by a handful of standing values. They act as tie-breakers for
every feature decision.

### Local-first, render-before-data

The app paints its shell and renders notes from the **local store immediately** on launch;
auth and sync run in the background *after* the UI is up. A home-screen PWA reaches perceived
time-to-typing within ~100–300ms of native — the levers are render-before-data, a tiny critical
bundle with everything heavy lazy-loaded, and a service-worker precache so launch never hits the
network. Day-to-day use never blocks on the server.

### Performance is a standing value

After on-device testing the user's verdict was that load and upload times **beat Apple Notes**.
That set a permanent bar:

> *"make sure things don't get bloated and slow down as we layer features on"*

No feature ships if it regresses the load-feel. This is an explicit anti-bloat guardrail — e.g.
swipe actions were hand-rolled with Pointer Events rather than pulling in an animation library,
keeping the bundle delta to single-digit KB.

### Auth is friction only where it must be — the north star

> *"Auth is for syncing between devices and signing in on a new device. Day-to-day can't be
> locked behind a password. This is a Notes app, not a password manager."*

Authentication belongs **only** at the sync-trust boundary and new-device onboarding. Opening
and using the app day-to-day is **zero friction** — a cold boot silently rides a durable refresh
session and lands straight on your notes, never a prompt. This principle survived the auth
mechanism pivot (passkeys → username + password); only the *mechanism* changed, not the
philosophy.

### Own your software / data ownership

Your data is always extractable, never hostage to the service: Markdown + media export,
pluggable / self-hostable storage, and a first-class **local replica that is a real restorable
backup, not a throwaway cache**. Blobs are content-addressed (referenced by hash, never a vendor
URL). **No email anywhere.** The long-term native target is Android — for full surface control
and sideload freedom.

### Plugin-first / view-driven architecture

The core thesis: every notes app couples its **UI** to its **data model**, so the model can
only be as flexible as one UI stays usable (Notion is powerful but heavy; Simplenote is
effortless but shallow). deltos **decouples them** — one substrate, many surfaces. The UI is
**view-driven**: content is rendered through swappable *views* resolved at a seam. Notebooks are
low-overlap **contexts** that (eventually) carry their own plugin/view loadout. v1 ships the
*engine* (the view-resolution seam) wearing one outfit — one collection view (the note list) and
one item view (the doc editor) — so future views are *registrations*, not refactors.

---

## Tech Stack

Versions below are the actual pins from the workspace manifests.

### Frontend — `@deltos/client`

| Concern | Choice |
| --- | --- |
| Framework | **React 19** + **React Router 7** |
| Build / dev | **Vite 6**, **TypeScript 5.7** |
| PWA | **vite-plugin-pwa** (`injectManifest`) + **Workbox 7** custom service worker (precaches the app shell for offline boot; never caches `/api/*` into the shared cache) |
| Local storage | **Dexie 4** over IndexedDB (+ `dexie-react-hooks` live queries) |
| State | **Zustand 5** |
| Editor | **ProseMirror** (model / view / state / transform / commands / history / keymap / input-rules / schema-list / gap-cursor / drop-cursor) — title unified into the document |
| Crypto | **WebCrypto**, plus `@noble/hashes`, `@noble/ed25519`, `@scure/bip39` (BIP39 recovery phrase) |
| Misc | `qrcode.react` |

### Backend — `@deltos/worker`

| Concern | Choice |
| --- | --- |
| Runtime | **Cloudflare Workers** (Workers Paid; `cpu_ms: 30000`) |
| Framework | **Hono 4** |
| Database | **Cloudflare D1** (binding `DB`), schema-managed via `wrangler d1 migrations` |
| Hosting | Same-origin: the Worker serves the client build as static assets and runs first only for `/api/*` |
| Validation | **Zod 3** (schema-first; types are derived from schemas) |
| Password hashing | **Argon2id** via the pure-JS `@noble/hashes` (no extra dependency), gated before hashing |

### Auth & identity model

Username + password is the primary credential, with **optional TOTP 2FA** and a **24-word
recovery phrase as a high-entropy password-reset token**. (This is a deliberate pivot away from
the original passkey / signed-challenge / QR-join model, which the user found opaque.) The
account/authorization spine is credential-independent, so the swap required **zero data
migration**. Sessions use an `httpOnly + Secure + SameSite=Strict` refresh cookie (stateful,
server-hashed, with rotation, reuse-detection, and revoke-all on every credential-change event)
plus a short-TTL **in-memory** access token — so a cold boot opens ungated without any reusable
token persisted at rest.

### Build & test tooling

- **pnpm 11.5.3** workspaces (Node ≥ 22), via corepack.
- **Vitest 2** across all three packages (shared contract tests, worker chokepoint/route tests,
  client unit + render tests with `@testing-library/react`, `jsdom`, `fake-indexeddb`).
- **TypeScript 5.7** strict, **ESLint 9** (`typescript-eslint`, `eslint-plugin-react-hooks`),
  **Prettier 3**.
- **Wrangler 4** for D1 migrations + deploy. **better-sqlite3** backs local worker tests.

---

## Architecture

deltos is a pnpm monorepo of three packages: a **shared contract**, a **Cloudflare Worker
backend**, and a **PWA client**.

```
   ┌─────────────────────────────────────────────┐
   │  @deltos/client  (installable PWA, React 19) │
   │                                              │
   │  Surfaces / views ── view-resolution seam    │
   │      │                                       │
   │  ProseMirror editor   Zustand UI state       │
   │      │                                       │
   │  Dexie (IndexedDB)  ◄── local-first replica  │
   │      │   ▲                                    │
   │  optimistic write buffer / SWR reads         │
   │  Service Worker (precached shell, offline)   │
   └──────┼───┼───────────────────────────────────┘
          │   │  HTTPS  /api/*   (Bearer access token + httpOnly refresh cookie)
          ▼   │
   ┌──────────┴───────────────────────────────────┐
   │  @deltos/worker  (Cloudflare Worker + Hono)   │
   │                                              │
   │  every request ──► guard() ──► can()  ◄── the one authorization chokepoint
   │                                  │           │
   │                          account-scoped queries (by accountId)
   └──────────────────────────────────┼───────────┘
                                       ▼
                              ┌────────────────┐
                              │  Cloudflare D1 │  (SQLite; camelCase 1:1, no mapping layer)
                              └────────────────┘

        shared contract: @deltos/shared  ── Zod spine schemas + API contract,
                         consumed by BOTH client and worker.

        Reserved (locked, not wired): Durable Objects (collab promote-to-DO / E2EE relay), R2 (blob store).
```

### Sync model — account-scoped, conflict-as-version

Sync is **online-first and optimistic**. Writes hit the local store instantly and sync in the
background; reads always render the local copy first and revalidate from the server
(stale-while-revalidate). There is **no CRDT/merge**.

- The **sync boundary is the `accountId`** (a stable, credential-independent random ID), not the
  device or notebook. Every data and sync query filters by the authenticated principal's account,
  enforced through a per-query account-scope helper plus the `can()` ownership belt — so no
  account can read or write another's notes.
- Conflicts are resolved **as a version of the same note**, never as a lost write or a duplicate
  sibling note: an offline edit that diverges from a server copy that moved ahead is retained as
  a conflict version of the same note ID (so inbound relations stay valid), surfaced with a
  non-blocking toast + badge and keep-mine / keep-theirs / keep-both resolution. The server uses
  an atomic compare-and-swap on the note `version` (validated against real D1's `rows_written`
  semantics).

### The view-driven UI shell

The UI has three composable regions — **Nav** (notebook switcher, new notebook, Trash, settings)
· **Note list** (the current notebook's notes) · **Active note** (the editor) — rendered
differently per device class (desktop left pane; mobile bottom-nav sheet + pushed editor
sub-screen; cold-start fallback = nav rendered full-screen). Notebooks are **account-scoped
synced contexts**; the *current* notebook is a **per-device IndexedDB pointer** (never synced,
so a work phone and a laptop can each open to their own context). Collection views (note list,
search results, Trash) and item views (the doc editor) both resolve through the view seam, so a
second view is a later registration rather than a refactor.

### Substrate / spine

Every note is simultaneously a **record and a document** — three layers:

1. **Identity & metadata** (system-owned): branded IDs (`NoteId` / `NotebookId` / `BlockId`),
   `notebookId`, ISO-8601 timestamps, `version` (drives conflict-as-version), `accountId`,
   `title` (derived from the first heading).
2. **Property bag** — a loose, optional-schema `key → typed value` map (text, number, date,
   boolean, select/tag, **relation**, url). The trash flag rides here as a reserved `sys:`
   namespace key.
3. **Block body** — an ordered, nestable document of blocks (`id`, `type`, opaque `content`,
   optional `children`); core types map 1:1 to Markdown.

The contract is **schema-first** (Zod schemas are the source of truth; all TS types are derived)
and lives in `@deltos/shared`, consumed by both client and worker. D1 is **camelCase 1:1 with no
mapping layer**. Plugins (future) extend only at two data seams — property types and block types
— so the spine stays frozen and additive.

---

## Plugin architecture

> **Status: Phase 2 — designed (see [`docs/specs/plugin-support.md`](./docs/specs/plugin-support.md)), not yet built.** The editor seams below exist today; the manifest + loader + lifecycle on top is the upcoming work.

A **plugin** is a *manifest that bundles registrations across the editor's existing contribution
registries* — not just "an editor code-block." deltos already has the hard seams (`plugin_block`
schema node, the island registry, the formula registry, the tool-descriptor registry, the Deck
adapter, `resolveNoteView`, lazy chunks). **Genuine plugin support = the manifest + loader +
lifecycle that feed those seams**, plus the durability and capability guarantees that make
plugin-authored content safe to live in a notes app forever.

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
(D1 query API for cross-note/indexed data, *not raw SQL*) · `net` (SSRF-guarded egress + secrets)
· `compute` (Worker/AI/Queues: transcode/OCR/transcription) · `schedule`+`notify` (Cron/DO alarms
+ Web Push). Capability-scoped host handle enforces account-scope + cost caps.

Full design: [`docs/specs/plugin-support.md`](./docs/specs/plugin-support.md).

---

## Feature Specs

Each links to its spec under [`docs/specs/`](./docs/specs/).

### Notes & editor
- **Foundation skeleton** — installable offline PWA shell, Worker+D1 scaffold, the frozen spine
  contract and the single `can()` chokepoint. ✅ done. → [`phase-0-foundation.md`](./docs/specs/phase-0-foundation.md)
- **v1 vertical slice** — substrate + spine + sync + one capture surface (ProseMirror editor with
  the title unified into the document), end-to-end. ✅ done. → [`phase-1-vertical-slice.md`](./docs/specs/phase-1-vertical-slice.md), constraints in [`phase-1-constraints.md`](./docs/specs/phase-1-constraints.md)
- **Notes-list display** — list-row rendering polish. ✅ done. → [`notes-list-display.md`](./docs/specs/notes-list-display.md)
- **Editor tools + Markdown-light** — bold/italic/headings/lists/checkboxes via toolbar
  (`EditorControlStrip`) **and** inline ProseMirror input-rules (`# ` → heading), not stored-as-markdown. ✅ done.
- **Note history + undo/redo** — session-coalescing version capture (idle-settle + on-leave +
  big-change floor); History panel (tap → diff / +−char-count → restore); undo/redo on mobile via
  Deck buttons. ✅ done. → [`note-history-and-undo.md`](./docs/specs/note-history-and-undo.md)

### Notebooks & UI backbone
- **UI backbone + notebooks** — the view-driven shell: notebook CRUD, **All-Notes synthetic
  default** (`notebookId` nullable — no stored default row, duplicate-default structurally
  impossible), account-scoped notebook sync, move-note, delete→uncategorize, per-device
  current-notebook pointer, and the collection/item view-resolution seam. ✅ done. → [`ui-backbone-notebooks.md`](./docs/specs/ui-backbone-notebooks.md), [`all-notes-synthetic-default.md`](./docs/specs/all-notes-synthetic-default.md)
- **Bottom nav (mobile)** — a thumb-reachable, safe-area-aware bottom bar with an extensible
  action-slot row (New note + Search) and drag-up to the full nav menu; sidesteps the iOS
  edge-swipe conflict. Desktop keeps the left pane. ✅ done. → [`bottom-nav-mobile.md`](./docs/specs/bottom-nav-mobile.md), [`drag-gesture-hook.md`](./docs/specs/drag-gesture-hook.md)
- **Desktop 3-region shell + drag-and-drop** — nav pane + note list + editor; drag a note onto a
  notebook in the nav pane to move it. ✅ done.

### Search
- **Search v1** — full-screen, fully **local/offline**, **fuzzy** + **relevance-ranked**
  (title > body) search across the account, prioritizing the current notebook with other notebooks
  as collapsible accordions; rows show title + highlighted snippet; cross-notebook peek doesn't
  move the current notebook. ✅ done. → [`search.md`](./docs/specs/search.md)

### Trash & swipe
- **Swipe actions** — iOS-Mail-style swipe-right on note rows (mobile) revealing Copy + Delete,
  hard-fling to delete with stretchy feel; **swipe-left = Move** → notebook bottom sheet;
  sync-correct soft-delete + undo. Hand-rolled (no animation dependency). ✅ done. → [`swipe-actions-note-list.md`](./docs/specs/swipe-actions-note-list.md)
- **Trash** — delete is sticky + recoverable via an undo toast or a Trash view; built as a
  reserved `sys:trashedAt` property flag (no migration), riding the hardened update CAS path. ✅ done.

### Auth & identity
- **Auth pivot — username + password (+ optional TOTP), recovery phrase as reset** — ungated
  day-to-day, durable httpOnly refresh cookie + in-memory access token, Argon2id (gated before
  hashing), revoke-all on credential changes. ✅ done, user-verified on-device. → [`auth-pivot-password.md`](./docs/specs/auth-pivot-password.md), disclosure copy in [`auth-disclosure-copy.md`](./docs/specs/auth-disclosure-copy.md)

### Deck (custom keyboard)
- **Deck** — custom on-screen keyboard (`inputmode=none`) that reclaims the iOS accessory bar,
  predictive row, and emoji strip; hosts the editor toolbar in the keyboard footprint. Includes
  voice transcription (Whisper, server-side) · inline formulas (math + hex-color detection) ·
  rich embeds (link unfurl → `LinkCard`, `/api/unfurl`) · spellcheck + custom dictionary · editor
  loadout + nav loadout · native iOS key geometry. ✅ done. → [`custom-keyboard.md`](./docs/specs/custom-keyboard.md)

### UI & Settings
- **UI visual refresh** — themes (light / dark / system), Mono body font + δ brand mark, SVG icons,
  appearance picker, 3-dot global-nav overlay on mobile, δ mark in the top bar. ✅ done. → [`ui-visual-refresh.md`](./docs/specs/ui-visual-refresh.md)
- **Settings** — Account info / Security (sign-out, 2FA toggle, recovery-phrase regenerate) /
  Appearance picker / Custom dictionary / About. ✅ done. → [`settings-screen.md`](./docs/specs/settings-screen.md)

### Sync
- **v1 shell + conflict-as-version** — local-first boot (auth/sync in background) + conflict
  retained as a version of the same note, never a lost write or duplicate. ✅ done. → [`v1-shell-and-conflict-versions.md`](./docs/specs/v1-shell-and-conflict-versions.md)
- Cross-device sync boundary = `accountId`; remote changes appear live (pull on return-to-app +
  short pull cadence while visible). Sync blip indicator (solid green / ring / yellow / grey) +
  tap-flush-reload; idle/tab sync-pause. ✅ done.

> The `docs/specs/` directory also contains the per-feature **acceptance matrices** and
> **done-gate checklists** used during the build.

---

## Project Status & Roadmap

**v1 shipped 2026-06-24** — the "basic notes, day-to-day usable" milestone is complete. Now
broadening into plugin / extension work (Phase 2). See `docs/specs/plugin-support.md`.

**Status legend:** `PLANNED` → `SPEC-READY` → `IN-FLIGHT` → `LANDED` → `DONE` (audited & accepted).

### ✅ Done & live (on https://deltos.blackgate.studio)
- Installable offline PWA shell; local-first render-before-data boot.
- Cloudflare deploy (Worker + prod D1 + PWA, same-origin, production mode).
- **Auth pivot** — username + password + optional TOTP + recovery-phrase reset; ungated day-to-day.
- **Sync** — account-scoped (boundary = `accountId`), conflict-as-version, live remote updates;
  sync blip indicator + tap-flush-reload; idle/tab pause.
- **Notes** — create / edit / view / delete; ProseMirror editor with unified title; auto-focus on new note.
- **All-Notes synthetic default** — `notebookId` nullable, no stored default row; duplicate-default
  structurally impossible.
- **Notebooks + view-driven shell** — CRUD, notebook sync, move-note, delete→uncategorize,
  per-device current-notebook pointer, collection/item view seam.
- **Bottom-nav (mobile)** with drag-up full menu; desktop left pane.
- **Desktop drag-and-drop** — drag note → notebook in the nav pane.
- **Swipe actions + Trash** — swipe-RIGHT = Copy + Delete; **swipe-LEFT = Move → notebook sheet**;
  sync-correct soft-delete + undo, recoverable Trash view.
- **Search v1** — fuzzy + relevance-ranked, fully local/offline, notebook-aware with accordion.
- **Note history + undo/redo** — session-coalescing version capture; History panel; Deck undo/redo.
- **Editor tools + Markdown-light** — `EditorControlStrip` toolbar + inline ProseMirror input-rules.
- **Deck custom keyboard** — `inputmode=none`; voice (Whisper); inline formulas; rich embeds
  (unfurl → LinkCard); spellcheck + custom dictionary; editor + nav loadouts; native iOS geometry.
- **UI visual refresh** — themes (light/dark/system), Mono font, SVG icons, appearance picker, δ brand.
- **Settings** — Account / Security / Appearance / Custom dictionary / About.

### Forward roadmap
- **Plugin framework** — manifest + loader + lifecycle (two-tier). See `docs/specs/plugin-support.md`.
- **Attachment plugin** — first real block-shard; proves the `blob` storage capability (R2 +
  content-addressing + byte-sync).
- **Slash `/` palette** — unified insert/command surface over the manifest registry (#62).
- **Password-recovery polish** — copy/download/print the recovery phrase.

### Framed future (specced direction, not yet scheduled)
- **Per-notebook home-screen icons** + a straight-to-new-note shortcut (iOS webclips; per-webclip
  storage is isolated — confirmed on-device).
- **Realtime push sync** — a WebSocket/SSE channel replacing polling (the real "ASAP").
- **Location notes + map view** — always-on (by user decision) structured-coords capture with
  local proximity filtering, plus a later map / reverse-geocoded place view.
- **Phase 2** — a second surface (proving the surface/substrate decoupling), universal search,
  and the plugin manifest / contribution-registry MVP with one real plugin.
- **Phase 3** — embeds + blob store (R2/OPFS), capability-URL sharing, Markdown export,
  backup-via-replica.
- **v2** — opt-in per-notebook **E2EE** zone and **live collaboration** (promote-a-note-to-a-
  Durable-Object), plus import.

---

## Repo Layout

```
deltos/
├── KICKOFF.md            # the locked build plan (the WHAT + locked architecture)
├── PLAN.md               # living roadmap & status (current state + decision log)
├── brainstorm.md         # design rationale (the WHY: ethos, philosophy)
├── DECISIONS.md          # resolved user-facing decisions (D1–D6)
├── README.md             # this file
├── docs/
│   ├── specs/            # feature specs + acceptance matrices / done-gate checklists
│   ├── design/           # design notes (auth pivot scope, account-identity, security sweeps)
│   └── spikes/           # throwaway de-risking spike write-ups
└── packages/
    ├── shared/           # @deltos/shared — frozen spine schemas + API contract (Zod, schema-first)
    │   └── src/{spine, api, auth, index.ts}
    ├── worker/           # @deltos/worker — Cloudflare Worker + Hono + D1
    │   ├── src/{routes, db, auth.ts, can()/chokepoint, passwordCrypto.ts, totp.ts, ...}
    │   ├── migrations/   # 0000_baseline … 0012_custom-dictionary (D1, forward-only)
    │   └── wrangler.jsonc
    └── client/           # @deltos/client — the installable PWA (React 19 + Vite + ProseMirror)
        └── src/{routes, views, components, editor, auth, db, deck, theme, icons, plugins, styles, lib, sw.ts, App.tsx}
```

---

## Development

Prerequisites: **Node ≥ 22** and **pnpm 11.5.3** (via corepack). The worker uses **Wrangler**
(a dev dependency).

```bash
# Install all workspaces
pnpm install

# One-time (and after adding migrations): apply the D1 baseline to the local database
pnpm db:migrate:local

# Start the worker (http://127.0.0.1:8787) and the client (Vite) together
pnpm dev
```

Health check once the worker is up:

```bash
curl http://127.0.0.1:8787/api/health
```

### Quality gates

```bash
pnpm typecheck      # tsc --strict across shared, worker, client
pnpm test           # contract tests (shared) + worker route/chokepoint + client unit/render
pnpm lint           # eslint
pnpm build          # build shared, type-check + bundle the worker, build the PWA
pnpm format         # prettier --write   (format:check to verify)
```

### Database & deploy (worker package)

```bash
# from packages/worker
pnpm db:migrate:local      # apply migrations to the local miniflare D1
pnpm db:migrate:remote     # apply migrations to the production D1
pnpm deploy                # wrangler deploy
```

> Migrations are **forward-only** — D1 records them by filename and won't re-run a changed file,
> so an applied migration is never rewritten in place; a new numbered file is shipped instead.
> Always validate a migration against real D1 (`wrangler`), not just the better-sqlite3 test path.
