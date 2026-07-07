import { Hono } from 'hono';
import { z } from 'zod';
import {
  RegisterClientRequestSchema,
  AuthorizeConsentRequestSchema,
  TokenGrantRequestSchema,
  clampAgentScopes,
  clampAgentResources,
  buildAuthServerMetadata,
  buildProtectedResourceMetadata,
  type RegisterClientResponse,
  type AuthorizeConsentResponse,
  type TokenResponse,
  type Resource,
  type Scope,
} from '@deltos/shared';
import type { AppEnv } from '../context.js';
import type { Context } from 'hono';
import { guard, apiError } from '../http.js';
import { createAuthStore, type AuthStore } from '../db/authStore.js';
import { d1Adapter } from '../db/schema.js';
import { createResourceOwnerResolver } from '../db/resourceOwner.js';
import { hashToken, randomToken } from '../authCrypto.js';
import { stampAccountId } from '../db/accountScope.js';
import { verifyStepUp } from '../stepUp.js';
import { audit, credentialRefOf } from '../audit.js';
import { principalRateAllow } from '../rateLimit.js';
import { MINT_BACKOFF, backoffDelayMs, REFRESH_TTL_MS } from '../authPolicy.js';
import { isRegisterableRedirectUri, matchRedirectUri, verifyPkceS256 } from '../oauth.js';

/** The concrete deltos resource an OAuth v1 grant authorizes: the whole workspace, read-only. */
const OAUTH_V1_RESOURCE: Resource = { kind: 'workspace' };
/** Authorization codes live 60s — long enough for a token exchange, short enough to bound theft/replay. */
const AUTH_CODE_TTL_MS = 60_000;
/**
 * OAuth access-token lifetime — SHORT (1h). v1-rotating (oauth-provider.md §5 follow-up): the durable session
 * lives in the rotating refresh token, so the access bearer is short-lived (smaller theft window) and resolved
 * as expired by the existing agent path (auth.ts freshness gate) once its TTL elapses.
 */
const OAUTH_ACCESS_TTL_MS = 60 * 60 * 1000;
/** OAuth refresh-token window — the durable (sliding) session horizon; each rotation issues a fresh expiry. */
const OAUTH_REFRESH_TTL_MS = REFRESH_TTL_MS;

/**
 * OAuth 2.1 provider — deltos as the Authorization Server for its own MCP resource (`/api/mcp`). See
 * docs/design/oauth-provider.md. This module owns the WORKER endpoints; the consent SCREEN is a lazy PWA
 * route (§2b) and the token itself is a `grants` row (principalKind='agent' + clientId) issued through the
 * already-hardened agent path. Nothing here is on the mobile first-load — pure backend plumbing (CONV-0004).
 *
 * Split into two mount points (index.ts): `oauthWellKnown` at `/.well-known` (public discovery docs, also
 * listed in wrangler `run_worker_first` so the SPA shell can't shadow them) and `oauth` at `/api/oauth`.
 */

/** Derive the public origin from the actual request URL — correct on any deploy (live/dogfood/red-team). */
function requestOrigin(url: string): string {
  return new URL(url).origin;
}

/**
 * OAuth endpoints return RFC-shaped errors — `{ error, error_description }` (RFC 6749 §5.2 / RFC 7591
 * §3.2.2) — NOT deltos's `{ code, message }` apiError shape, because OAuth clients parse the `error` field.
 * `error` is a plain string so both the 6749 token codes and the DCR-specific codes (invalid_redirect_uri,
 * invalid_client_metadata) can be expressed.
 */
function oauthError(c: Context<AppEnv>, status: number, error: string, description?: string): Response {
  return c.json(description ? { error, error_description: description } : { error }, status as never);
}

// --- Discovery documents (RFC 8414 + RFC 9728), public, mounted at /.well-known -------------------

export const oauthWellKnown = new Hono<AppEnv>();

/** RFC 8414 Authorization Server Metadata — endpoints + hard constraints (S256-only, code-only, public). */
oauthWellKnown.get('/oauth-authorization-server', (c) => {
  // no-store: the doc is derived per-deploy/origin and MUST reflect a redeploy immediately — edge-caching it
  // once served a stale authorization_endpoint after a fix and 404'd the client's connect. It's tiny and
  // fetched once per connect, so skipping the cache costs nothing.
  c.header('Cache-Control', 'no-store');
  return c.json(buildAuthServerMetadata(requestOrigin(c.req.url)));
});

/** RFC 9728 Protected Resource Metadata for /api/mcp — points clients at this AS + names the audience. */
oauthWellKnown.get('/oauth-protected-resource', (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json(buildProtectedResourceMetadata(requestOrigin(c.req.url)));
});

// --- Separate OAuth authorization SURFACE (served at /oauth/*) ------------------------------------

/**
 * The dedicated OAuth authorization surface (oauth-consent-surface-separation.md / DEC-0005). Mounted at
 * `/oauth` and listed in wrangler `run_worker_first`, so a top-level navigation to /oauth/authorize reaches
 * the worker instead of the SPA fallback (which would return the notes index.html — the wrong surface). We
 * serve the standalone `oauth.html` entry with `Cache-Control: no-store`, so a redeploy is reflected
 * immediately and the surface can never be served stale; it is ALSO excluded from the notes SW precache and
 * its navigation is passed through to the network by the SW (client sw.ts denylist). oauth.html's own hashed
 * JS/CSS live under /assets/ and serve statically (not worker-first). The advertised authorization_endpoint
 * stays /oauth/authorize — the same public URL, now backed by this dedicated surface instead of a route
 * inside the notes SPA (so no discovery-doc change is needed).
 */
export const oauthConsentSurface = new Hono<AppEnv>();

oauthConsentSurface.get('/*', async (c) => {
  const assets = c.env.ASSETS;
  // ASSETS is unbound in unit tests (and only there); in every real deploy it resolves to the client build.
  if (!assets) return apiError(c, 503, 'unavailable', 'oauth surface not available');
  const res = await assets.fetch(new Request(`${requestOrigin(c.req.url)}/oauth.html`));
  // Re-wrap so WE own the response headers: force the HTML content-type (the request path is extension-less)
  // and no-store (freshness is the whole point of the separation). The built oauth.html always exists.
  return new Response(res.body, {
    status: res.status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
});

// --- /api/oauth ----------------------------------------------------------------------------------

export const oauth = new Hono<AppEnv>();

/**
 * POST /api/oauth/register — Dynamic Client Registration (RFC 7591). PUBLIC, but registering grants ZERO
 * access on its own: a client can read nothing until the logged-in owner completes the /authorize consent.
 * So the only abuse is row-spam → rate-limited (native Tier-1 binding, keyed by IP) + cron-pruned. The one
 * field that confers a control is `redirect_uris` (the exact-match allow-list); every entry must be
 * registerable (https or http-loopback, {@link isRegisterableRedirectUri}) — a plaintext non-loopback
 * redirect is refused so a code can never leak over http to an arbitrary host. Public client → no secret
 * (`token_endpoint_auth_method: 'none'`); PKCE is the proof at /token.
 */
oauth.post('/register', async (c) => {
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  const underRate = await principalRateAllow(c.env.API_RATE_LIMITER, `oauth-register:${ip}`);
  if (!underRate) return oauthError(c, 429, 'temporarily_unavailable', 'too many registration attempts');

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return oauthError(c, 400, 'invalid_request', 'request body must be JSON');
  }
  const parsed = RegisterClientRequestSchema.safeParse(body);
  if (!parsed.success) return oauthError(c, 400, 'invalid_client_metadata', 'invalid client metadata');

  for (const uri of parsed.data.redirect_uris) {
    if (!isRegisterableRedirectUri(uri)) {
      // RFC 7591 §3.2.2 error code for a rejected redirect.
      return oauthError(c, 400, 'invalid_redirect_uri', `redirect_uri not allowed: ${uri}`);
    }
  }

  const { redirect_uris, client_name, software_id, ...rest } = parsed.data;
  const clientId = randomToken(16);
  const nowMs = Date.now();
  const store = createAuthStore(d1Adapter(c.env.DB));
  await store.registerOauthClient({
    clientId,
    clientName: client_name ?? 'Unnamed client',
    redirectUris: redirect_uris,
    softwareId: software_id ?? null,
    // Remaining DCR metadata is non-authoritative (authority comes from consent) — stashed, never trusted.
    metadata: Object.keys(rest).length > 0 ? JSON.stringify(rest) : null,
    createdAt: new Date(nowMs).toISOString(),
  });

  const resp: RegisterClientResponse = {
    client_id: clientId,
    client_id_issued_at: Math.floor(nowMs / 1000),
    redirect_uris,
    ...(client_name !== undefined ? { client_name } : {}),
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code'],
    response_types: ['code'],
  };
  return c.json(resp, 201);
});

/**
 * POST /api/oauth/authorize — the consent-approval mint (§2b). The PWA consent screen POSTs here after the
 * user approves; it is BEARER-authed through `guard` op:`share` (so an agent token can NEVER self-consent —
 * it lacks `share`) and re-proves the human with `verifyStepUp` (the H1 consent gate). On success it mints a
 * single-use authorization code bound to (client, redirect, PKCE challenge, account, scope) and returns
 * `{ code, redirect_uri, state? }`; the PWA then navigates the browser to `redirect_uri?code&state`. NO
 * token is issued here — the code is exchanged at /token. Deny is pure client-side navigation (no call).
 */
oauth.post(
  '/authorize',
  guard({
    op: 'share',
    schema: AuthorizeConsentRequestSchema,
    input: async (c) => {
      try {
        return await c.req.json();
      } catch {
        return {};
      }
    },
    // OAuth consent grants the whole workspace (read by default, write per opt-in); authorize the owner
    // against it. A workspace-scoped grant is what the note-level write tools require (write-tools.md §2).
    resource: (): Resource => OAUTH_V1_RESOURCE,
    handle: async (req, c, principal) => {
      const store = createAuthStore(d1Adapter(c.env.DB));
      const accountId = stampAccountId(principal); // server-derived owner; never the body
      const nowMs = Date.now();

      // Rate-limit gate BEFORE the Argon2 step-up (gate-before-hash) — same backoff bucket discipline as
      // agent-token mint, so a borrowed session can't brute the password / amplify Argon2 CPU at consent.
      const bucket = `oauth-consent:${accountId}`;
      const throttle = await store.getThrottle(bucket);
      if (throttle && nowMs < throttle.nextAllowedMs) {
        return oauthError(c, 429, 'temporarily_unavailable', 'too many attempts — try again shortly');
      }

      // Validate the client + redirect FIRST — a cheap D1 read that fails fast BEFORE spending an Argon2
      // step-up on a request whose redirect we'd never honor (adversarial-review INFO). matchRedirectUri is
      // THE anti-phishing gate: exact-match, loopback port-exception only. The caller is already an
      // authenticated owner (guard), so ordering this ahead of step-up discloses nothing to an attacker.
      const client = await store.getOauthClient(req.client_id);
      if (!client) return oauthError(c, 400, 'invalid_request', 'unknown client_id');
      if (!matchRedirectUri(req.redirect_uri, client.redirectUris)) {
        return oauthError(c, 400, 'invalid_request', 'redirect_uri is not registered for this client');
      }

      // H1 STEP-UP — re-prove the human at consent (fail-closed). verifyStepUp returns its own Response on
      // failure (401 wrong factor / 503 config); a wrong factor counts toward the backoff + is audited.
      const stepUp = await verifyStepUp(c, store, accountId, { password: req.password, totp: req.totp }, nowMs);
      if (stepUp) {
        if (stepUp.status === 401) {
          const failures = ((await store.getThrottle(bucket))?.failures ?? 0) + 1;
          await store.recordThrottleFailure(
            bucket,
            failures,
            nowMs + backoffDelayMs(MINT_BACKOFF, failures),
            new Date(nowMs).toISOString(),
          );
          await audit(c, {
            surface: 'auth',
            action: 'oauth.consent',
            result: 'deny',
            principalKind: principal.kind,
            accountId,
            detail: 'step-up-failed',
          });
        }
        return stepUp;
      }
      await store.clearThrottle(bucket);

      // Scope is clamped through the SAME path as the manual mint route (ONE auth path for write): READ is
      // the floor; WRITE verbs are added ONLY for the explicit per-scope opt-in in `req.write` (fail-closed —
      // no opt-in ⇒ read-only). `share` can never appear. The step-up above already re-proved the human,
      // doubly-warranted for a write-capable consent.
      const scope = clampAgentScopes(undefined, req.write ? { allowWrite: req.write } : undefined);
      // CLAMP the RESOURCE SET the user approved (grant sets, ROAD-0011 P1 §1.3) — the SAME clamp + ownership
      // validation as manual mint, so a client-requested resource the user unchecked never survives, and a
      // foreign selection is rejected. Absent picker ⇒ the whole workspace (today's OAuth default).
      const resources = clampAgentResources(req.resources);
      const resolveOwner = createResourceOwnerResolver(d1Adapter(c.env.DB));
      for (const r of resources) {
        if (r.kind === 'workspace') continue;
        const owner = await resolveOwner(r);
        if (!owner || owner.accountId !== accountId) {
          return oauthError(c, 400, 'invalid_request', 'a selected resource was not found in your account');
        }
      }
      const rawCode = `dltos_code_${randomToken(32)}`;
      await store.insertOauthCode({
        codeHash: hashToken(rawCode), // only the hash is stored (F6)
        clientId: req.client_id,
        accountId,
        redirectUri: req.redirect_uri,
        codeChallenge: req.code_challenge,
        scope,
        resource: req.resource ?? null, // RFC-8707 audience url (distinct from the resource-scope set below)
        resources, // the approved resource-scope SET, carried to /token to mint the matching grant set
        expiresAtMs: nowMs + AUTH_CODE_TTL_MS,
        createdAt: new Date(nowMs).toISOString(),
      });

      await audit(c, {
        surface: 'auth',
        action: 'oauth.consent',
        result: 'allow',
        principalKind: principal.kind,
        accountId,
        detail: `client:${req.client_id}`,
      });

      const resp: AuthorizeConsentResponse = {
        code: rawCode,
        redirect_uri: req.redirect_uri,
        ...(req.state !== undefined ? { state: req.state } : {}),
      };
      return c.json(resp, 200);
    },
  }),
);

/**
 * Mint one rotation of OAuth tokens: a SHORT-lived access grant set (an `agent` grant carrying clientId +
 * familyId) PLUS a rotating refresh token in the SAME `familyId`, both bound to the identical (clientId,
 * accountId, scope, resources, audience) — carried UNCHANGED from the original consent through every rotation
 * (a refresh can never widen scope). Shared by the authorization-code exchange and the refresh rotation so
 * the two paths issue byte-identical response shapes. Returns the RFC 6749 §5.1 token response.
 */
async function issueOauthTokens(
  c: Context<AppEnv>,
  store: AuthStore,
  nowMs: number,
  grant: {
    familyId: string;
    clientId: string;
    clientName: string;
    accountId: string;
    scope: Scope[];
    resources: Resource[];
    resource: string | null; // RFC-8707 audience url
    action: 'oauth.token' | 'oauth.refresh';
  },
): Promise<TokenResponse> {
  const resources = grant.resources.length > 0 ? grant.resources : [OAUTH_V1_RESOURCE];
  const accessToken = `dltos_oauth_${randomToken(32)}`;
  const refreshToken = `dltos_refresh_${randomToken(32)}`;
  const tokenGroupId = randomToken(16);
  const createdAt = new Date(nowMs).toISOString();

  await store.insertAgentGrantSet({
    tokenGroupId,
    tokenHash: hashToken(accessToken),
    accountId: grant.accountId,
    label: grant.clientName, // display name for the Connected-apps surface
    scope: grant.scope,
    createdAt,
    clientId: grant.clientId,
    expiresAtMs: nowMs + OAUTH_ACCESS_TTL_MS, // SHORT-lived (1h); the durable session is the refresh token
    familyId: grant.familyId, // links this access grant to its family so a theft-nuke revokes it too
    rows: resources.map((resource) => ({ grantId: randomToken(16), resource })),
  });
  await store.insertOauthRefreshToken({
    tokenHash: hashToken(refreshToken), // F6 — only the hash is stored
    familyId: grant.familyId,
    clientId: grant.clientId,
    accountId: grant.accountId,
    scope: grant.scope,
    resources,
    resource: grant.resource,
    issuedAtMs: nowMs,
    expiresAtMs: nowMs + OAUTH_REFRESH_TTL_MS,
  });

  const primaryResource = resources[0] ?? OAUTH_V1_RESOURCE;
  await audit(c, {
    surface: 'auth',
    action: grant.action,
    result: 'allow',
    principalKind: 'agent',
    accountId: grant.accountId,
    credentialRef: tokenGroupId,
    resourceKind: primaryResource.kind,
    resourceId: primaryResource.kind === 'workspace' ? null : primaryResource.id,
    detail: `client:${grant.clientId}`,
  });

  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: Math.floor(OAUTH_ACCESS_TTL_MS / 1000),
    refresh_token: refreshToken,
    scope: grant.scope.join(' '),
  };
}

/**
 * POST /api/oauth/token — the token endpoint (RFC 6749). PUBLIC (no bearer); the proof is the PKCE
 * `code_verifier` + single-use code (authorization_code) or the opaque refresh token (refresh_token). Accepts
 * form-encoded (the spec default) or JSON. `grant_type` discriminates the two flows (fail-closed at the
 * schema — any other grant is rejected). v1-rotating (oauth-provider.md §5 follow-up): both flows issue a
 * 1h access token + a rotating refresh token in a shared family; reusing a spent/revoked refresh nukes the
 * family (theft detection). The issued access token is an `agent` grant carrying clientId — inheriting the
 * whole hardened agent path.
 */
oauth.post('/token', async (c) => {
  // IP rate-limit (Tier-1 native binding) — /token is UNAUTHENTICATED and does a D1 write per call
  // (consumeOauthCode's UPDATE runs even on a zero-row miss), so without this an attacker could flood
  // garbage codes to drive D1 write load / billing (adversarial-review MED-1). Mirrors /register.
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  if (!(await principalRateAllow(c.env.API_RATE_LIMITER, `oauth-token:${ip}`))) {
    return oauthError(c, 429, 'temporarily_unavailable', 'too many token requests');
  }

  let raw: unknown;
  const contentType = c.req.header('content-type') ?? '';
  try {
    if (contentType.includes('application/json')) {
      raw = await c.req.json();
    } else {
      const body = await c.req.parseBody();
      raw = Object.fromEntries(
        Object.entries(body).map(([k, v]) => [k, typeof v === 'string' ? v : String(v)]),
      );
    }
  } catch {
    return oauthError(c, 400, 'invalid_request', 'unparseable token request');
  }

  const parsed = TokenGrantRequestSchema.safeParse(raw);
  if (!parsed.success) return oauthError(c, 400, 'invalid_request', 'invalid token request');
  const req = parsed.data;

  const store = createAuthStore(d1Adapter(c.env.DB));
  const nowMs = Date.now();

  const client = await store.getOauthClient(req.client_id);
  if (!client) return oauthError(c, 401, 'invalid_client', 'unknown client');

  // --- refresh_token grant: verify → ROTATE (new access + new refresh in the same family) ---------
  if (req.grant_type === 'refresh_token') {
    const session = await store.getOauthRefreshToken(hashToken(req.refresh_token));
    // Bind the refresh to the presenting client — a token issued to another client is not this client's.
    if (!session || session.clientId !== req.client_id) {
      return oauthError(c, 400, 'invalid_grant', 'refresh token is invalid');
    }
    // THEFT DETECTION: a spent (rotated) OR revoked refresh presented again ⇒ nuke the WHOLE family (every
    // refresh row + every outstanding access grant sharing familyId). After this the family is fully dead.
    if (session.rotatedAt !== null || session.revokedAt !== null) {
      await store.revokeOauthRefreshFamily(session.familyId, new Date(nowMs).toISOString());
      return oauthError(c, 400, 'invalid_grant', 'refresh token is invalid');
    }
    if (session.expiresAtMs <= nowMs) {
      return oauthError(c, 400, 'invalid_grant', 'refresh token has expired');
    }

    // Rotate: ATOMICALLY CLAIM this refresh (latch rotatedAt) BEFORE issuing anything. Claim-first is the
    // correct security ordering: if two concurrent refreshes race, only ONE wins the claim; the loser gets
    // `claimed === false` and is treated EXACTLY like the reuse branch above (family-nuke → invalid_grant), so
    // two live successors can never exist. The consciously-accepted tradeoff (LOW-1): if issuance below fails
    // after a successful claim the client is briefly locked out and heals on reconnect — strictly safer than an
    // issue-first ordering that would risk two live tokens. Do NOT reorder to issue-first.
    const claimed = await store.markOauthRefreshRotated(hashToken(req.refresh_token), new Date(nowMs).toISOString());
    if (!claimed) {
      // The row was rotated out from under us between the reuse check and the claim (concurrent-or-replay reuse)
      // → treat it as theft: nuke the whole family, deny. Same handling as the spent/revoked branch above.
      await store.revokeOauthRefreshFamily(session.familyId, new Date(nowMs).toISOString());
      return oauthError(c, 400, 'invalid_grant', 'refresh token is invalid');
    }
    // Scope + resources + audience are carried UNCHANGED from the stored session — a refresh can never widen
    // (nor narrow) scope.
    const resp = await issueOauthTokens(c, store, nowMs, {
      familyId: session.familyId,
      clientId: session.clientId,
      clientName: client.clientName,
      accountId: session.accountId,
      scope: session.scope,
      resources: session.resources,
      resource: session.resource,
      action: 'oauth.refresh',
    });
    return c.json(resp, 200);
  }

  // --- authorization_code grant: PKCE exchange, single-use ----------------------------------------
  // ATOMIC single-use claim — see consumeOauthCode. Burning first prevents PKCE retry brute-forcing.
  const claimed = await store.consumeOauthCode(hashToken(req.code), nowMs);
  if (!claimed) return oauthError(c, 400, 'invalid_grant', 'code is invalid, expired, or already used');
  if (claimed.clientId !== req.client_id) {
    return oauthError(c, 400, 'invalid_grant', 'code was not issued to this client');
  }
  // Exact equality against the redirect bound at consent (the concrete URI the client used) — RFC 6749 §4.1.3.
  if (claimed.redirectUri !== req.redirect_uri) {
    return oauthError(c, 400, 'invalid_grant', 'redirect_uri does not match the authorization request');
  }
  if (!verifyPkceS256(req.code_verifier, claimed.codeChallenge)) {
    return oauthError(c, 400, 'invalid_grant', 'PKCE verification failed');
  }

  // Fresh rotation family for this connection: the access grant set + the first refresh token share it, so a
  // later theft-nuke or per-client disconnect reaches both. The resource set was clamped + ownership-validated
  // at consent and carried on the code; a legacy/absent set ⇒ [{workspace}].
  const resp = await issueOauthTokens(c, store, nowMs, {
    familyId: randomToken(16),
    clientId: claimed.clientId,
    clientName: client.clientName,
    accountId: claimed.accountId,
    scope: claimed.scope,
    resources: claimed.resources,
    resource: claimed.resource,
    action: 'oauth.token',
  });
  return c.json(resp, 200);
});

/**
 * GET /api/oauth/clients — the owner's "Connected apps" list (OAuth-issued grants only; first-party agent
 * tokens are a separate surface). Owner-authed (`guard` op:`share` → agents 403), BOLA-scoped on principalId,
 * non-secret metadata only. Server-resident: this and the consent screen are the only OAuth client-facing UI.
 */
oauth.get(
  '/clients',
  guard({
    op: 'share',
    schema: z.object({}).strict(),
    input: () => ({}),
    resource: (): Resource => OAUTH_V1_RESOURCE,
    handle: async (_req, c, principal) => {
      const store = createAuthStore(d1Adapter(c.env.DB));
      const apps = await store.listOauthGrantsForAccount(stampAccountId(principal));
      return c.json({ apps });
    },
  }),
);

/**
 * DELETE /api/oauth/clients/:clientId — disconnect an app: revoke EVERY live OAuth grant this account holds
 * for that client (the kill-switch behind the Connected-apps UI). BOLA-checked in the store (account match +
 * principalKind='agent' + clientId IN the WHERE) — a non-match revokes zero rows → 404 (no cross-account
 * existence disclosure). Immediate: the next request bearing any of that client's tokens 403s at `can()`.
 */
oauth.delete(
  '/clients/:clientId',
  guard({
    op: 'share',
    schema: z.object({ clientId: z.string().min(1) }),
    input: (c) => ({ clientId: c.req.param('clientId') }),
    resource: (): Resource => OAUTH_V1_RESOURCE,
    handle: async (req, c, principal) => {
      const store = createAuthStore(d1Adapter(c.env.DB));
      const accountId = stampAccountId(principal);
      const revoked = await store.revokeOauthGrantsForClient(req.clientId, accountId);
      if (revoked === 0) {
        return apiError(c, 404, 'not_found', 'no connected app for that client');
      }
      await audit(c, {
        surface: 'auth',
        action: 'oauth.revoke',
        result: 'allow',
        principalKind: principal.kind,
        accountId,
        credentialRef: credentialRefOf(principal),
        detail: `client:${req.clientId}`,
      });
      return c.json({ clientId: req.clientId, revoked: true });
    },
  }),
);
