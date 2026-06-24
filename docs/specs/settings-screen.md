# Spec — Settings & Account screen v1

**Status:** SHIPPED — v1 live 2026-06-24.
**Design basis:** the "basic notes, day-to-day usable" milestone (user, 2026-06-17 — settings named as
*account/username + sign-out + appearance + app-info, minimal*). Governs: `[[auth-friction-philosophy]]`,
`[[performance-is-a-standing-value]]`.
**Depends on:** nothing new — wires existing auth-store primitives + the nav `Settings & account` button
that is currently a `/* TODO */` stub (`packages/client/src/views/NavContent.tsx`).

## Goal
A real, reachable **Settings & Account** screen that lets a day-to-day user see who they're signed in as,
sign out, manage their recovery phrase and 2FA, and read basic app info. This is mostly **assembly of
primitives that already exist** in `packages/client/src/auth/store.ts` — low-risk, no new design system.

## Entry & shape
- **Entry point:** the existing **"Settings & account"** button in `NavContent` (footer, next to Trash).
  Replace the `onClick={() => { /* TODO: settings */ }}` stub with navigation to a new **`/settings`** route.
  Surfaces automatically on both desktop (left drawer) and mobile (bottom-sheet) since both render `NavContent`.
- **Route:** add `/settings` to the authed shell routes in `App.tsx` (alongside `/trash`, `/search`).
- **Layout:** a **full-screen scrollable settings view**, sectioned. Native back / a clear back affordance
  returns to where the user came from (consistent with how `/trash` and `/search` dismiss). Reuse the
  existing list/section visual language — **do not invent new chrome or a theming system.**

## Sections (v1)

### 1. Account
- Show **username** (`useAuthStore(s => s.username)`).
- Show **account ID** (`accountId`) — secondary/muted, monospace; it's the data-ownership key, fine to
  surface but not the headline. Truncate/wrap gracefully.
- Show **sync/session status** derived from `sessionState` (`active` → "Synced / Online", `offline` →
  "Offline — changes saved locally", `unauthed`/`booting` handled gracefully). Read-only.

### 2. Security
- **Sign out** — calls `logout()` (already implemented; revokes server sessions + clears the in-memory
  bearer), then routes to `/login`. Use a **confirm step** (sign-out drops the durable session; on this
  device the user would re-enter username+password to sync again). Honors `[[auth-friction-philosophy]]`:
  signing out is deliberate, not incidental.
- **Recovery phrase** — a **"View / regenerate recovery phrase"** action. Regenerate calls
  `establishRecovery()` (mints a FRESH phrase server-side, updates the verifier) and shows it **once** via
  the existing `PhraseStep` component (copy/save affordances reused). Copy MUST warn that regenerating
  **invalidates the previous phrase** (anti-footgun). There is no "view the existing phrase" — phrases are
  one-way (shown once, never stored); the only operation is regenerate-and-show-once. Word the UI honestly
  to that effect.
- **Two-factor authentication (TOTP)** — show current **on/off state** and let the user toggle it:
  - **Enable:** reuse the register flow's `setupTotp()` → show QR/secret → `verifyTotp(code)` to confirm
    (enable only on a confirmed code — anti-lockout, matches register).
  - **Disable:** a new `disableTotp()` client action → a new/confirmed `/totp/disable` route. The DB layer
    already supports it (`authStore` nulls `totpSecretEnc` + sets `totpEnabled=0`). **Require a confirm**
    (and per secSys's call, consider requiring a current TOTP code or password to disable — flag to secSys).
  - Copy: 2FA is prompted **only at new-device login + reset**, never on day-to-day app open (state the
    scope so users understand what it protects).

### 3. About
- App **version + build info** (note: package version is currently `0.0.0` — expose a real build/version
  string to the client via the build, even if just the short git SHA / a `__APP_VERSION__` define).
- Short app description / "own your software" one-liner + a link to the repo/README if cheap.

## Backend / store gaps to close (small, in-scope)
These two additions are required for the **2FA** section; everything else uses existing primitives:
1. **Surface `totpEnabled` to the client.** Today no session/identity response carries it
   (`login`/`refresh`/`signup` return `accountId`/`username`/`recoveryEstablished` only). Add `totpEnabled`
   to the auth response (or a small authed `GET` settings/identity endpoint) so the screen can render 2FA
   state. Server stays authoritative; client never infers it.
2. **2FA disable path.** Add a `/totp/disable` route (DB support already exists in `authStore`) + a
   `disableTotp()` action + `totpEnabled` field on the client auth store. secSys reviews the disable
   authorization (confirm-with-code-or-password vs bare authed call).

## Explicitly OUT of scope (v1) — deferred, tracked
- **Change password (logged-in)** — needs a *new* backend endpoint; recovery-phrase reset covers
  forgot-password for now. Its own small slice later. (User-confirmed defer, 2026-06-20.)
- **Appearance / theme toggle** — ~~there is no theming system yet~~ SHIPPED: the Appearance picker
  (theme palette, font, dark/light/system mode) lives in Settings and was delivered in Deploy 2 of
  the UI visual refresh. This "out of scope" note is no longer accurate.
- **Session/device management** (list/revoke individual sessions), **account deletion / data export** —
  later surfaces.

## Constraints
- Holds `[[performance-is-a-standing-value]]`: settings is a lightweight route, no heavy deps, no bundle
  regression; lazy-load if it pulls in anything non-trivial.
- Holds `[[auth-friction-philosophy]]`: nothing here gates day-to-day note use; these are
  sync/new-device/recovery controls living in one deliberate place.
- `[[reuse-discipline]]`: reuse `PhraseStep`, the `setupTotp`/`verifyTotp` ceremony, and the existing
  section/list styles — rewrite to deltos quality, no patch-and-paste from the auth routes.
- No cross-account leakage by construction (all state is the signed-in account's).

## Acceptance
- `/settings` route exists and is reachable from the nav button on **both** desktop drawer and mobile sheet.
- Account section shows username + accountId + a correct session/sync status string.
- Sign out: confirm → `logout()` → lands on `/login`; in-memory token cleared.
- Recovery phrase: regenerate → shows a fresh phrase once via `PhraseStep`; previous-phrase-invalidated
  warning present.
- 2FA: screen reflects real `totpEnabled` state; enable (setup→verify) and disable both work end-to-end
  against the worker; lockout-safe (enable only on confirmed code).
- About: shows a real version/build string (not `0.0.0`).
- **Gate** (per `[[ui-features-need-rendered-ui-gate]]`): render tests that mount the real screen and assert
  each section renders + actions fire (sign-out calls logout & redirects; regenerate calls
  establishRecovery & shows PhraseStep; 2FA toggle reflects state & calls setup/verify/disable) + a thin
  on-device smoke (nav button → settings → sign-out round-trip, 2FA enable/disable on real iOS) before deploy.
- Tests green + prod typecheck clean (`[[green-gate-needs-prod-typecheck]]`).

## Suggested lanes (orchestrator's call)
- **Backend:** `totpEnabled` surfaced on the auth/identity response + `/totp/disable` route (+ secSys review
  of disable authz).
- **Store:** `totpEnabled` state + `disableTotp()` action in `auth/store.ts`.
- **UI:** the `/settings` route + sectioned view + nav button wire-up, reusing `PhraseStep` / TOTP ceremony.
- **secSys:** light pass — disable-2FA authorization + confirm-sign-out + recovery-regenerate footgun copy.
