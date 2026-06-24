# Spec P0 — Foundation skeleton

> **Historical — v1 shipped 2026-06-24. This is the spec as of 2026-06-15; preserved as record, not current status.**

**Phase:** 0 · **Proposed owner:** devSys (spine types + API contract are load-bearing) ·
**Runs parallel with:** S1/S2/S3 spikes · **Audit:** secSys on landing.

## Goal
Stand up deltos's own clean, empty-but-real skeleton: an installed PWA that boots **offline**,
a Worker+Hono+D1 backend scaffold, and — the load-bearing deliverable — the **core spine
TypeScript types** + the **API-contract stub** that every later slice builds against. No
features. The point is a foundation that reads as authored-for-deltos from line one.

## Context (read before building)
- `KICKOFF.md` §Locked architecture, §Tentative stack, §Roadmap→Phase 0.
- `brainstorm.md` §Spine (data model), §Platform, §Cross-cutting (API-first; Auth grant model).
- The spine is the frozen core; plugins extend only at **property types & block types**. Get
  these types right and precise — they are the contract the whole system leans on.

## Scope
1. **Repo structure + tooling** — monorepo-or-clean layout (client / worker / shared types),
   TypeScript strict, Vite, lint/format, the `packageManager` pin (corepack/pnpm). One clean
   `pnpm install && pnpm build && pnpm dev` story.
2. **PWA shell** — React + Vite + `vite-plugin-pwa` (injectManifest). SW precaches the app
   shell so launch never hits network. **Must include the `/api/` SW navigation denylist** so
   API routes are never served the SPA fallback (the trkr lesson — reference, don't copy).
   Render-before-data shell (paints before any data). Installable; boots with network off.
3. **Backend scaffold** — Cloudflare Worker + Hono + D1. Health route + migration runner +
   an empty D1 schema placeholder. `wrangler` config (use the `wrangler` skill for syntax).
   Worker binds D1; **no DO, no R2 yet** (reserved per architecture).
4. **Core spine types** (`shared/`, imported by both client & worker) — the three layers:
   - **Identity/metadata** (system-owned): `id` (client-generated UUID, stable from creation),
     `notebookId`, `createdAt`, `updatedAt`, `version` (integer counter → fork-on-conflict),
     `syncStatus` (`synced|pending|failed|local-only`), `title`.
   - **Property bag** — `key → typed value`; value types: `text, number, date, boolean,
     select/tag, relation, url`. Loose by default; representation must allow a notebook to
     later declare a schema over it. `relation` is a **core** type (carries note-id refs).
   - **Block body** — ordered, **nestable**: block = `{ id, type, content, children? }`. Core
     block types enumerated: `heading, paragraph, list, quote, code, todo, divider, image,
     audio, video, file, table`. Plugin blocks store `content` **opaquely** (type is an open
     string; core never inspects plugin content).
5. **API-contract stub** — the API *is* the product. Define (types + route signatures +
   request/response shapes; **stub handlers, not full impl**): notes `create / get / update /
   delete`, `search` (over title + indexable props + block searchText), block `append`,
   property `set`. Plus the **auth chokepoint shape**: the grant primitive
   `{ principal, resource, scope, constraints }` and a single `can(principal, op, resource)`
   signature every route routes through (stub returns allow). Principals enumerated
   (`owner|device|guest|anonymous|agent|plugin`); resources (`workspace|notebook:id|note:id`);
   scopes (`read|write|create|delete|share|search`).

## Acceptance criteria
- [ ] `pnpm install && pnpm dev` boots client + worker locally; documented in a short README.
- [ ] App **installs as a PWA and boots with the network disabled** (SW precache works).
- [ ] Navigating an `/api/*` path is **not** served the SPA shell (denylist verified).
- [ ] Worker responds on a health route; D1 migration runner applies an empty baseline.
- [ ] Spine types compile under `strict`, are exported from `shared/`, and are consumed by
      both client and worker (no duplication of the note shape).
- [ ] API-contract stub: every listed op has a typed signature and a stub handler reachable
      through the single `can()` check. Request/response types derive from the spine types.
- [ ] **Schema-first** (use the `schema-first` skill): the spine + API payloads are defined as
      runtime-validated schemas at the boundary, with static types **derived** from them — not
      hand-written types validated nowhere. Schema is the single source of truth.
- [ ] **No DO, no R2** wired (reserved). No feature logic beyond the stubs.

## Reuse-discipline gate (HARD — acceptance)
Reference `trkr` **only** for: shell/tooling config shape, the `vite-plugin-pwa` setup, and the
`/api/` SW denylist lesson. **Rewrite everything to deltos-native.** No `trkr` names, schema
shapes, LWW assumptions, cookie-auth leftovers, or task/service vestiges anywhere. Litmus: a
stranger reading any file cold must not be able to guess it came from another project. The
handoff packet `_inbox/OFFLINE_SYNC_HANDOFF.md` is for *understanding*, not paste.

## Out of scope
Real sync, real auth/identity, any editor engine, any surface beyond an empty shell, blob
store, plugins. Those are Phase 1+.

## Deliverable
Working skeleton on a branch + short README (run story + what's stubbed) + a one-paragraph note
back to the planner on anything the spine types forced a decision on (so it lands in the
decision log).
