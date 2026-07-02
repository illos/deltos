# OAuth consent — separate the auth surface from the editor app (cleanup plan)

> Status: **PLANNED cleanup** (Jim, 2026-07-02). Roll back the PWA-mediated OAuth consent + the client-side
> entanglement; rebuild consent (and auth ceremonies generally) as a **separate surface** from the
> notes/editor client. The worker/backend OAuth stack is DONE + verified and stays. This doc is the runbook
> for the next session to execute.

## Principle (the decision — see brain DEC-0005)

Auth ceremonies (OAuth consent) and account / connected-apps management belong on a **separate surface** —
the "settings side" — **NOT** wired into the client/editor app's shell, router, or service worker. The
client side (editor/notes) and the settings/auth side are distinct surfaces; keep them distinct. This is a
standing architectural line, not a one-off.

## Why (what went wrong)

The PWA-mediated consent (`oauth-provider.md §2b`) put the consent screen *inside* the notes SPA. The
premised benefit — reuse the user's live in-app session so they don't re-auth — **rarely materializes**: the
OAuth client (Claude) opens consent in a browser context that usually isn't the logged-in deltos session
(different browser/tab, iOS webclip storage isolation, or a dead cookie). So consent almost always
authenticates on its own anyway, and we paid the full coupling cost for little:

- **Service-worker cache** served a stale consent screen — a manual hard-refresh was needed after each deploy.
- **The desktop/mobile shell fork:** the authed shell branches into `ThreeRegionShell` (desktop) vs the
  mobile `<Routes>`; a route must be registered in BOTH + the signed-out auth-gate, and each has a catch-all
  → home. Consent was missing from the desktop shell → silent redirect to home.
- **Ungated-shell "revoked" coupling:** `isAuthed` persisted-true with no live bearer → consent POST 503
  dead-end; needed a `requireReauth()` hack in the auth store to unstick it.

Every late bug was an **integration** bug, not an OAuth bug. That is the signal the surface is wrong.

## KEEP — clean, done, verified (do NOT roll back)

The entire **worker/backend** OAuth stack is surface-agnostic and proven end-to-end (curl on live + 436
worker tests):

- migration `0017_oauth-provider.sql` (`oauthClient`, `oauthAuthCode`, `grants.clientId`) — applied local + **remote**.
- `packages/shared/src/api/oauth.ts` (schemas, discovery builders, `OAUTH_V1_SCOPES`, PKCE constants).
- `packages/worker/src/oauth.ts` (redirect exact-match + loopback rule, PKCE S256).
- `packages/worker/src/routes/oauth.ts` (discovery, DCR, authorize-mint, token, connected-apps) + the
  adversarial-review fixes (`/token` rate-limit, client prune, validate-before-step-up) + `no-store` on discovery.
- `packages/worker/src/db/authStore.ts` OAuth methods + `pruneOauthClients`.
- The MCP 401 → `resource_metadata` discovery pointer (`routes/mcp.ts`).
- `packages/worker/test/oauth.routes.test.ts` + `oauth.test.ts` (the headless gate).

**One backend touch on rebuild:** `buildAuthServerMetadata.authorization_endpoint` currently points at the
PWA route `${origin}/oauth/authorize` — re-point it at the NEW separate surface's URL.

## ROLL BACK — the client-side entanglement (revert these)

Do it as a **clean forward revert** on `main` (the trunk, CONV-0005) — NOT a history rewrite. Cherry-pick the
two genuine keeps (see below) back out of the revert.

- `packages/client/src/App.tsx` — remove `ShellOrConsent`, the `/oauth/authorize` routes in the auth-gate +
  mobile shell, the lazy `OAuthAuthorizeRoute` import.
- `packages/client/src/routes/OAuthAuthorizeRoute.tsx` — **delete** (rebuilt on the separate surface).
- `packages/client/src/components/ConnectedAppsSection.tsx` — **move** to the separate/settings surface (not
  wired into the in-app `SettingsRoute`).
- `packages/client/src/lib/oauthClient.ts`, `oauthReturn.ts` — move/rebuild on the separate surface.
- `packages/client/src/auth/store.ts` — **remove `requireReauth()`** (the hack existed only to unstick the
  ungated-shell coupling; the separate surface does its own auth, no hack needed).
- `packages/client/src/routes/LoginRoute.tsx` — revert the `consumeOAuthReturn()` consumption.
- `packages/client/src/routes/SettingsRoute.tsx` — revert the `ConnectedAppsSection` wiring.
- `packages/client/src/components/ConnectClaudeSection.tsx` — revert copy (or keep a minimal MCP-URL mention).
- Tests: remove `OAuthAuthorizeRoute.render.test.tsx` + `ConnectedAppsSection.render.test.tsx` (rebuild on
  the new surface). The worker `oauth.routes.test.ts` **stays**.

### The two KEEPS (genuine fixes unrelated to the OAuth surface — do NOT revert)
- `packages/client/src/styles.css` — the `.auth__input` / `.auth__confirm-code` / `.auth__phrase` /
  `.auth__qr` → `var(--list)` change. Pre-existing bug: those hardcoded a dark `#1a1d2a`, so inputs rendered
  dark on any LIGHT theme across ALL auth screens. Keep. (Remove only the `.oauth-consent__*` styles — those
  move to the new surface.)
- `packages/client/index.html` — the added `mobile-web-app-capable` meta (deprecation fix). Keep.

Commits in scope: `718b7be` (client UI) + the App.tsx shell-fork fix + the store/consent revoked-session fix
+ the theming/meta commit (split the keeps out).

## REBUILD — the separate surface

A dedicated OAuth authorization surface, decoupled from the notes PWA:

- Served at `/oauth/*` (worker `run_worker_first`), `Cache-Control: no-store`, and **excluded from the notes
  service-worker precache** — this is the key property: never SW-cached → never stale, no hard-refresh.
- Its own minimal mount (**recommended: a separate Vite entry `oauth.html` + a tiny React app** that mounts
  ONLY the login/consent flow — NOT `AppRoutes`/the shell/the boot store). Reuse the **theme tokens** (shared
  CSS) for a consistent look and the **auth API layer**; do NOT reuse the app router / shell / ungated-boot.
- **Self-contained auth:** on load, try `POST /api/auth/refresh` (the cookie is `Path=/api/auth/refresh`,
  same-origin → sent → works) for a bearer; if none, show an inline login (username + password + Turnstile +
  TOTP); then consent → step-up → `POST /api/oauth/authorize` → top-level redirect. Deny = terminal screen
  (never navigate to an unvalidated `redirect_uri`).
- Re-point `buildAuthServerMetadata.authorization_endpoint` at this surface.
- Keep the reviewed security posture: PKCE S256, exact redirect match. **Consider** a small
  `GET /api/oauth/authorize-info?client_id&redirect_uri` that validates the pair server-side + returns the
  registered `clientName` — so the consent screen shows the real app name AND `deny` can redirect safely
  (validated) too. (Deferred in v1; the separate surface is the natural place for it.)
- Connected-apps management: put on the settings/separate surface as well, per the client/settings split.

## Open question for the rebuild (flag to Jim)

Is this OAuth surface the **first tenant of a general "settings side"** surface, separate from the
client/editor (the distinction Jim invoked)? If so, scope a separate settings/auth surface broadly (account,
active sessions, connected apps, account-activity, OAuth consent all live there) and OAuth consent is just
its first occupant. Recommendation: **start with the OAuth consent surface, structure it so the settings
sections graft on**, and confirm the broader split with Jim before migrating existing in-app settings.

## Testability (gate unchanged)

The backend headless gate stays (`oauth.routes.test.ts` proves the full DCR→authorize→token→MCP handshake
with no browser + no Claude). Add render/E2E coverage for the new surface. UI-features-need-rendered-ui gate
still applies to the rebuilt surface.
