# deltos

A private, multi-surface notes framework — one substrate (DB + sync + search + schema), many
purpose-built surfaces. See [`KICKOFF.md`](./KICKOFF.md) for the build plan and locked
architecture, and [`brainstorm.md`](./brainstorm.md) for the design rationale.

This repo is currently a **Phase 0 skeleton**: empty of features, but a real installable PWA, a
real Worker+D1 backend, and the frozen substrate contract everything else builds against.

## Layout

```
packages/
  shared/   @deltos/shared — the frozen contract: spine schemas (identity + property bag +
            nestable block tree) and the API contract (grant primitive, can() chokepoint,
            typed operations). Schema-first: Zod schemas are the source of truth, all types
            are derived. Consumed by both the client and the worker.
  worker/   @deltos/worker — Cloudflare Worker + Hono + D1. Every route passes through the one
            can() authorization chokepoint. D1 only (no Durable Objects, no R2 yet).
  client/   @deltos/client — the installable PWA shell (React + Vite + vite-plugin-pwa). Custom
            service worker precaches the app shell for offline boot.
```

## Prerequisites

- Node 22+, and `pnpm` via corepack (the repo pins `pnpm@11.5.3`).
- For the worker: `wrangler` (installed as a dev dependency).

## Run

```bash
pnpm install

# One-time (and after adding migrations): apply the D1 baseline to the local database.
pnpm db:migrate:local

# Start the worker (http://127.0.0.1:8787) and the client (Vite) together.
pnpm dev
```

The client dev server binds `127.0.0.1` and, when launched via the control dashboard, listens on
`$DEVBOX_PORT` so it is reachable over Tailscale; it allows `.ts.net` hosts and proxies `/api` to
the worker. Outside the dashboard it falls back to Vite's default port.

Health check once the worker is up:

```bash
curl http://127.0.0.1:8787/api/health
# {"status":"ok","service":"deltos","db":"ok","spineContractVersion":"0"}
```

## Verify / quality gates

```bash
pnpm typecheck   # tsc --strict across shared, worker, client
pnpm test        # contract tests (shared) + chokepoint tests (worker)
pnpm lint        # eslint (no-explicit-any, consistent-type-imports)
pnpm build       # build shared, type-check + bundle the worker, build the PWA
```

## What's real vs stubbed in Phase 0

**Real**

- The installable PWA shell: precaches offline (verified — the shell boots with the server
  down), with the load-bearing `/api/` service-worker navigation denylist so API URLs are never
  served the cached SPA shell.
- `/api/health` (probes the D1 binding + applied migration) and a JSON 404 for unknown API paths.
- The single `can()` authorization chokepoint: every operation validates its request against the
  shared schema, resolves a principal, and passes through `can()` before any handler runs.
- The D1 migration baseline (shapes the `(id, notebookId, version)` atomic compare-and-swap that
  fork-on-conflict will use; no handler reads it yet).

**Stubbed (Phase 1)**

- All seven note operations (`create / get / update / delete / search`, `block.append`,
  `property.set`) are wired and authorized but return `501` — no persistence or sync yet.
- Auth is a local-dev stub: `resolvePrincipal` returns an `unverified` local owner and `can()`
  allows everything. A mechanical tripwire refuses any unverified principal when
  `ENVIRONMENT=production`, so the stub can never silently serve real traffic.
- No editor engine, no surfaces beyond the empty shell, no blob store, no plugins, no real
  identity/passkey flow — all Phase 1+.
