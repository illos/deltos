# OAuth provider — deltos as an MCP Authorization Server (ROAD-0005, first capability)

> Status: **DESIGN — under review** (2026-06-30). First capability slotted behind the now-complete
> P0–P4 security spine. Consumer: Claude's MCP client (and any OAuth 2.1 MCP client). It upgrades today's
> manual agent-token paste (`ConnectClaudeSection.tsx`) into a one-click OAuth connector.
> Grounding: `authorization-model.md` (the ACL this rides), `api-access-security-model.md §3` (the threats),
> and the live-code recon (paths cited inline). Source-of-truth once built: `packages/worker/src/routes/oauth/`.

## 0. Decisions already locked (do not re-litigate)

- **Client-identity axis = `clientId` COLUMN on `grants`, principalKind stays `agent`** (Jim, 2026-06-30 —
  authorization-model.md §2a fork resolved). An OAuth access token IS an agent grant that happens to carry a
  `clientId`. Decisive reason: the H3 revoke-all sweep is `WHERE principalKind IN ('owner','agent')`
  (`authStore.ts:1035`) — keeping OAuth tokens as `agent` means revoke-all covers them *by construction*,
  while `WHERE clientId=?` still gives per-client revoke for the Connected-apps UI. A separate
  `oauth_client` principalKind would silently fall out of every `'agent'`-keyed sweep/belt = latent regression.
- **v1 scope = READ-ONLY** (`[read,search]`, clamped at issuance exactly like agent tokens). Write-tools stay
  LAST (master doc). No `share`, ever.
- **Headless-testability is a GATE, not a nicety.** The full DCR → `/authorize` → `/token`(PKCE) → `/api/mcp`
  flow must be drivable in CI without the Claude app (Playwright drives the consent page). Ship gate.
- deltos is **both** the Authorization Server (AS) and the Resource Server (RS). `/api/mcp` is the only
  protected resource. Single-RS makes audience-binding (RFC 8707) trivially satisfiable.

## 1. The handshake (OAuth 2.1 + MCP auth, end to end)

```
Claude MCP client                         deltos worker (AS + RS)
   │  POST /api/mcp  (no token)                │
   │ ───────────────────────────────────────► │  401 + WWW-Authenticate: Bearer
   │                                           │    resource_metadata="…/.well-known/oauth-protected-resource"
   │  GET /.well-known/oauth-protected-resource│   ← (RFC 9728) lists the AS
   │  GET /.well-known/oauth-authorization-server│ ← (RFC 8414) endpoints + S256 + supported scopes
   │  POST /register  {redirect_uris,name}     │   ← (RFC 7591 DCR) issues client_id (PUBLIC, no secret)
   │  ── opens browser ──►  GET /authorize      │   ← consent screen; user logs in + approves (verifyStepUp)
   │       ?client_id&redirect_uri&state        │      issues single-use auth code (60s), bound to
   │       &code_challenge=S256&scope&resource   │      (clientId, redirectUri, codeChallenge, accountId, scope)
   │  ◄── 302 redirect_uri?code=…&state=… ───── │
   │  POST /token  {code, code_verifier,        │   ← verify PKCE + redirect match + single-use;
   │       redirect_uri, client_id}             │      issue access token = agent grant w/ clientId set
   │  POST /api/mcp  Authorization: Bearer <at> │   ← resolves through the EXISTING agent path → can()
```

Everything downstream of `/token` (resolve, `can()`, scope-clamp, P4 rate-limit, audit tagging) is the
**already-hardened agent path** — recon §3–§6. OAuth adds only the *front* of the pipe.

## 2. Endpoints (all net-new; mounts beside the existing `app.route(...)` in `index.ts`)

| Endpoint | RFC | Auth | Notes |
|---|---|---|---|
| `GET /.well-known/oauth-protected-resource` | 9728 | public | advertises the RS + its AS + `scopes_supported` + the `resource` id `…/api/mcp` |
| `GET /.well-known/oauth-authorization-server` | 8414 | public | `registration/authorization/token` endpoints; `code_challenge_methods_supported:["S256"]`; `grant_types:["authorization_code"]`; `response_types:["code"]` |
| `POST /api/oauth/register` | 7591 | public (rate-limited) | DCR. Returns `client_id`. **Public client → no `client_secret`** (PKCE is the proof). Validates `redirect_uris`. |
| `GET /oauth/authorize` (PWA route) | 6749/PKCE | **owner session (in-app)** | the `authorization_endpoint`. A LAZY PWA route (not server-rendered HTML) — see §2b. Validates `code_challenge` (S256) + params, ensures the user is logged in (app's normal ungated-reload), renders the consent screen. |
| `POST /api/oauth/authorize` (mint code) | — | `guard` op:`share` (bearer) + **`verifyStepUp`** | JSON. Approve → mint auth code bound to (clientId, redirectUri, challenge, accountId, scope), return `{ redirect_uri, code, state }`; the PWA then navigates the browser there. Deny → PWA navigates to `redirect_uri?error=access_denied`. |
| `POST /api/oauth/token` | 6749/PKCE | public + PKCE | exchange code → access token. Verifies `code_verifier` vs stored `code_challenge`, single-use, redirect match, not expired. |

`.well-known` lives at the ROOT (Hono `app.get('/.well-known/...')`), not under `/api`. The `401` change is a
one-liner in `mcp.ts:83` — add the `resource_metadata` param so a tokenless `/api/mcp` *triggers* discovery.

### 2b. Consent is PWA-mediated, not server-rendered HTML (architecture refinement, 2026-07-01)

The `authorization_endpoint` a browser lands on is a **lazy PWA route** (`/oauth/authorize`), NOT a
worker-rendered HTML page. Rationale: deltos authenticates with an **in-memory bearer** (+ httpOnly refresh
cookie for ungated reload), and a top-level server-rendered consent page would need a brand-new
cookie-authenticated-HTML-page auth path (+ its own CSRF story) that exists nowhere else in the app. Instead:
the OAuth client opens `…/oauth/authorize?client_id&redirect_uri&code_challenge&…`; the PWA loads, does its
normal reload-auth (→ bearer), renders a consent screen reusing the existing login + step-up UI, and on
**Approve** calls the JSON `POST /api/oauth/authorize` (bearer-authed through `guard` op:`share`, so agent
tokens can't self-consent + step-up applies) which mints the code and returns `{ redirect_uri, code, state }`.
The PWA then does a top-level `window.location` navigation to `redirect_uri?code&state` — that navigation IS
the OAuth redirect, invisible to and fully conformant for the OAuth client. CSRF is a non-issue (bearer, not
an ambient cookie). This keeps auth in one model, puts the consent UI on a lazy off-first-load route
(CONV-0004), and lands the consent screen in the client lane where it belongs.

## 3. Storage (migration 0017 — additive, the 0013/0014 pattern)

- **`oauthClient`** (registry / DCR records):
  `clientId` PK · `clientName` · `redirectUris` (JSON string[]) · `createdAt` · `softwareId?`/`metadata?`.
  No secret column — public PKCE clients only.
- **`oauthAuthCode`** (the authorization-code grant, single-use, short-lived):
  `codeHash` (UNIQUE, SHA-256 of the code — never store raw, mirror `tokenHash` F6) · `clientId` ·
  `accountId` · `redirectUri` · `codeChallenge` · `scope` (JSON) · `resource` · `expiresAtMs` (~60s) ·
  `consumedAt` (single-use latch). Pruned by the existing `scheduled()` cron (Tier-3) alongside the other
  D1 mirrors.
- **`grants` + `clientId` TEXT NULL** — `null` = first-party agent token (Settings-minted); set = OAuth-issued.
  `insertAgentGrant` (`authStore.ts:733`) gains an optional `clientId` arg; nothing else in the grant path moves.

All three are schema-first (Zod at the boundary, `/schema-first`); `oauthAuthCode` parses fail-closed on a
malformed row exactly like `resolveGrantByTokenHash`.

## 4. The security controls (= the §3 master-doc threat list, answered)

1. **Open DCR is fine — registration grants ZERO access.** Anyone can `POST /register` and get a `client_id`;
   that alone reads nothing. Access exists only after the *logged-in owner* completes `/authorize` consent.
   So DCR spam just makes client rows → **rate-limit `/register`** (reuse the P4 binding) + cron-prune
   unused clients. The consent gate is the real control, not registration.
2. **`redirect_uri` exact-match is THE anti-phishing control.** Token/code only ever go to a `redirect_uri`
   that **exact-string-matches** one registered for that `client_id`. No wildcards, no prefix match, no
   substring. **Loopback exception** (RFC 8252): `http://127.0.0.1:<any-port>/…` and `http://[::1]:…` match
   on everything *except* port (native clients pick an ephemeral port). `https://claude.ai/...`-style
   redirects are exact. Validated at BOTH `/authorize` (before showing consent) and `/token` (must equal the
   value bound into the code).
3. **PKCE mandatory, S256 only.** `/authorize` REQUIRES `code_challenge` + `code_challenge_method=S256`;
   `plain` is rejected. `/token` recomputes `BASE64URL(SHA256(code_verifier))` and rejects on mismatch.
   No PKCE → no flow (there are no confidential clients).
4. **Consent can't be silent or phished.** `/authorize` renders a consent screen that names the *client*
   (`clientName` + the `redirect_uri` it will return to) and the *exact scope* (`read`, `search` — read-only).
   Approval requires an authenticated owner session AND **`verifyStepUp`** (fresh password / TOTP — the seam
   `stepUp.ts` was *built anticipating this*, recon §8). First-party (Settings) flows already step-up to mint;
   OAuth consent is the same bar.
5. **Audience binding (RFC 8707).** Client sends `resource=…/api/mcp`; the issued token records it; the
   protected-resource metadata advertises it. Single-RS deployment means a deltos token is structurally
   useless elsewhere, but we record `resource` so the invariant survives a future second RS.
6. **Auth code: single-use, 60s, fully bound.** Bound to `(clientId, redirectUri, codeChallenge, accountId,
   scope)`; `consumedAt` latches on first `/token` use; replay → deny. Stored hashed.
7. **Issued token inherits the whole spine** — scope clamped to `[read,search]` at issuance; resolves through
   `can()`; counts against the P4 per-account daily MCP quota (per OWNING account, so more OAuth clients can't
   multiply budget — recon §5); every `tools/call` audited with `clientId` now in the trail.

## 5. Token lifetime — LOCKED: non-expiring, no refresh token (Jim, 2026-07-01)

The non-expiring-by-design decision ([[agent-tokens-non-expiring-by-design]]) was made for **Settings-minted**
agent tokens: "revocability is the control, a TTL is theater." OAuth raises the question again because the
ecosystem *has* a refresh pattern. Two coherent options:

- **(v1-simple) Non-expiring access token, NO refresh token.** Consistent with the agent-token decision;
  per-client revoke + revoke-all already give immediate kill; least code. The client holds one bearer
  forever (until revoked). `/token` returns no `expires_in`, no `refresh_token`.
- **(v1-rotating) Short access token + rotating refresh token.** Standard OAuth 2.1; the rotation gives
  refresh-reuse *theft detection* — and we already have the exact machinery: refresh **families**
  (`grants.familyId`, migration 0014) where reusing a revoked refresh nukes the family. More code, more
  ecosystem-conformant.

**DECISION (Jim, 2026-07-01): v1-simple — non-expiring access token, NO refresh token.** Keeps faith with the
standing no-TTL stance; the consent gate + per-client revoke + revoke-all bound the blast radius. `/token`
returns an access token with **no `expires_in` and no `refresh_token`**. The `familyId` substrate stays
available so rotation is a clean additive follow-up if a real user or client ever demands it. **Gate watch:**
if the real Claude MCP client *refuses to connect* without `expires_in`/`refresh_token`, that surfaces at the
headless gate / first live dogfood — escalate to Jim then, do NOT silently add rotation.

## 6. Build plan (crew-driven, CONV-0009 — after this doc is approved)

1. **Foundation (solo, inert-safe):** migration 0017 (`oauthClient`, `oauthAuthCode`, `grants.clientId`);
   Zod schemas in `packages/shared` (client metadata, token/authorize/register request+response, the
   discovery docs); `insertAgentGrant` gains optional `clientId`. No endpoint wired yet → zero behavior change.
2. **Parallel worktree lanes** (each lands behind the inert foundation):
   - **A — discovery + DCR:** the two `.well-known` docs + `POST /register` + the `mcp.ts:83`
     `resource_metadata` one-liner.
   - **B — authorize + consent:** `GET/POST /api/oauth/authorize`, the consent page, `verifyStepUp` wiring,
     auth-code mint, `redirect_uri` exact-match + loopback rule.
   - **C — token:** `POST /api/oauth/token`, PKCE S256 verify, single-use code latch, issue agent grant w/
     `clientId`.
   - **D — client UI:** upgrade `ConnectClaudeSection.tsx` — keep manual-token as fallback, surface the
     Connected-apps list (clients + per-client revoke via `WHERE clientId=?`).
3. **Adversarial security review agent** (the §3 list as its checklist) — PASS gate before deploy.
4. **Headless CI gate:** a test that runs the entire flow programmatically (Playwright on the consent page) +
   asserts read works / write denied / replayed code denied / wrong `redirect_uri` denied / `plain` PKCE denied.
5. Deploy to live; dogfood a real Claude connect; checkpoint + brain.

## 7. Out of scope for v1 (named so they're not silently dropped)

- Write scopes (LAST, separate phase). · Confidential clients / `client_secret`. · Refresh-token rotation
  (designed-for, deferred — §5). · Per-client rate-limit *tiers* (P4 binding applies per-principal already;
  per-`clientId` tiers are a later knob). · Multi-RS / external resource servers. · Consent *management* UI
  beyond list+revoke (e.g. re-consent, scope editing).
