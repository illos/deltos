import { z } from 'zod';
import { ScopeSchema, ResourceSchema } from './grant.js';
import { AgentWriteOptSchema, AgentGrantResourceSchema } from './agentToken.js';
import { TimestampSchema } from '../spine/ids.js';

/**
 * OAuth 2.1 provider surface — deltos as the Authorization Server for its own MCP resource
 * (`/api/mcp`). See docs/design/oauth-provider.md. This module is the schema-first source of truth for
 * every OAuth boundary (discovery / DCR / authorize / token); the worker derives its types from here and
 * validates each wire crossing against these schemas (`/schema-first`).
 *
 * Locked shape (authorization-model.md §2a; Jim 2026-06-30/07-01):
 *   * an OAuth access token IS an `agent` grant carrying a `clientId` — NOT a new principalKind.
 *   * READ is the default; WRITE is a per-scope opt-in at consent ({@link AgentWriteOptSchema} →
 *     clampAgentScopes) — the SAME mechanism the manual mint route uses, so both are ONE auth path for
 *     write. Tokens are NON-EXPIRING (no expires_in, no refresh token — the standing no-TTL stance; revoke
 *     is the control).
 *   * PUBLIC PKCE clients only (no client_secret); PKCE S256 is mandatory; redirect_uri is exact-match
 *     (loopback port-exception per RFC 8252). These are the anti-phishing controls, not niceties.
 */

/** The ONLY scopes an OAuth token may hold in v1 — same read-only surface as agent tokens. */
export const OAUTH_V1_SCOPES = ['read', 'search'] as const;

// --- PKCE + redirect-uri: the two load-bearing security primitives (pure, tested) -----------------

/** PKCE S256 is the only challenge method deltos accepts. `plain` is refused — there are no confidential clients. */
export const PKCE_METHOD = 'S256' as const;

// NOTE: the URL-based redirect-uri validators (matchRedirectUri / loopbackIdentity / isRegisterableRedirectUri)
// and the PKCE S256 verifier live in the WORKER (`packages/worker/src/oauth.ts`), not here — they are
// server-only security logic and depend on the `URL` global / WebCrypto, which the environment-minimal
// shared package deliberately does not pull into its lib. This module stays the pure schema + string layer.

// --- Dynamic Client Registration (RFC 7591) ------------------------------------------------------

/**
 * DCR request. `redirect_uris` is the only field that confers a control (the allow-list); the rest is
 * non-authoritative metadata, so `.passthrough()` tolerates the many optional DCR fields a client may send
 * (grant_types, response_types, token_endpoint_auth_method, scope, software_version…) without rejecting the
 * registration — authority comes from the owner's consent, never from a metadata field. Every registered
 * redirect must be registerable (https or loopback), enforced in the route via {@link isRegisterableRedirectUri}.
 */
export const RegisterClientRequestSchema = z
  .object({
    redirect_uris: z.array(z.string().url()).min(1),
    client_name: z.string().max(200).optional(),
    software_id: z.string().max(200).optional(),
  })
  .passthrough();
export type RegisterClientRequest = z.infer<typeof RegisterClientRequestSchema>;

/** DCR response (RFC 7591 §3.2.1). `token_endpoint_auth_method: 'none'` = public PKCE client (no secret). */
export const RegisterClientResponseSchema = z.object({
  client_id: z.string().min(1),
  client_id_issued_at: z.number().int(),
  redirect_uris: z.array(z.string().url()).min(1),
  client_name: z.string().optional(),
  token_endpoint_auth_method: z.literal('none'),
  grant_types: z.array(z.literal('authorization_code')),
  response_types: z.array(z.literal('code')),
});
export type RegisterClientResponse = z.infer<typeof RegisterClientResponseSchema>;

// --- Authorization request (RFC 6749 §4.1.1 + PKCE), carried as GET query params ------------------

export const AuthorizeRequestSchema = z
  .object({
    response_type: z.literal('code'),
    client_id: z.string().min(1),
    redirect_uri: z.string().url(),
    code_challenge: z.string().min(1),
    code_challenge_method: z.literal(PKCE_METHOD), // S256 only; 'plain' rejected at the boundary
    state: z.string().optional(),
    scope: z.string().optional(), // space-delimited; clamped read-only regardless of what's asked
    resource: z.string().url().optional(), // RFC 8707 audience (…/api/mcp)
  })
  .strip();
export type AuthorizeRequest = z.infer<typeof AuthorizeRequestSchema>;

/**
 * The consent-approval body the PWA consent screen POSTs to `POST /api/oauth/authorize` (§2b). It carries
 * the authorize params the browser arrived with PLUS the step-up factors (the consent gate re-proves the
 * human, like agent-token mint). Bearer-authed through `guard` op:`share`, so an agent token can never
 * self-consent. `.strict()` rejects any ride-along field. There is NO server GET `/authorize` — the browser
 * lands on the PWA route, which reads the query params and renders consent client-side.
 */
export const AuthorizeConsentRequestSchema = z
  .object({
    client_id: z.string().min(1),
    redirect_uri: z.string().url(),
    code_challenge: z.string().min(1),
    code_challenge_method: z.literal(PKCE_METHOD),
    scope: z.string().optional(),
    resource: z.string().url().optional(),
    state: z.string().optional(),
    // Per-scope WRITE opt-in — the SAME mechanism as the manual mint route ({@link AgentWriteOptSchema} →
    // clampAgentScopes). ABSENT ⇒ read-only (fail-closed default). This is what makes OAuth consent and
    // manual mint ONE auth path for granting write; a write-capable consent is doubly gated by the step-up.
    write: AgentWriteOptSchema.optional(),
    // The RESOURCE SET the user approved in the consent picker (ROAD-0011 P1 §1.3) — notebooks and/or notes,
    // or omitted for the whole workspace. Clamped + ownership-validated through the SAME path as manual mint
    // ({@link clampAgentResources}); only what survives is bound to the auth code and later minted. This is
    // the picker SELECTION, distinct from the RFC-8707 `resource` audience url below (which binds the token's
    // audience, not its per-notebook scope).
    resources: z.array(ResourceSchema).optional(),
    // H1 step-up — re-prove the human at consent (password always; totp when 2FA on). Verified + discarded.
    password: z.string().min(1).optional(),
    totp: z.string().optional(),
  })
  .strict();
export type AuthorizeConsentRequest = z.infer<typeof AuthorizeConsentRequestSchema>;

/** The consent-mint response the PWA uses to perform the OAuth redirect: `window.location = redirect_uri?code&state`. */
export const AuthorizeConsentResponseSchema = z.object({
  code: z.string().min(1),
  redirect_uri: z.string().url(),
  state: z.string().optional(),
});
export type AuthorizeConsentResponse = z.infer<typeof AuthorizeConsentResponseSchema>;

// --- Token request (RFC 6749 §4.1.3 + PKCE) + response -------------------------------------------

export const TokenRequestSchema = z
  .object({
    grant_type: z.literal('authorization_code'),
    code: z.string().min(1),
    redirect_uri: z.string().url(),
    client_id: z.string().min(1),
    code_verifier: z.string().min(43).max(128), // PKCE verifier length bounds (RFC 7636 §4.1)
  })
  .strip();
export type TokenRequest = z.infer<typeof TokenRequestSchema>;

/**
 * Token response. v1 is NON-EXPIRING with NO refresh token (locked): there is deliberately no `expires_in`
 * and no `refresh_token` field — the bearer is durable until revoked. `scope` echoes the (clamped) grant.
 */
export const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.literal('Bearer'),
  scope: z.string(),
});
export type TokenResponse = z.infer<typeof TokenResponseSchema>;

// --- Connected apps (the owner-facing management surface for OAuth-issued grants) ----------------

/**
 * One OAuth-issued grant in the owner's "Connected apps" list. Non-secret metadata only (never a token or
 * hash). A single client can hold more than one connection (re-consent) — the UI groups by `clientId`, and
 * revoke is per-`clientId` (kills every grant for that app at once).
 */
export const ConnectedAppSchema = z.object({
  // The whole-token id (tokenGroupId) — a re-consent mints a fresh token, so a client may hold several.
  tokenId: z.string().min(1),
  clientId: z.string().min(1),
  clientName: z.string().nullable(),
  scope: z.array(ScopeSchema),
  // The per-resource set this connection authorizes (ROAD-0011 P1 §1.4). v1 OAuth consent defaults to the
  // whole workspace; the resource-picker (a later lane) narrows it. Each carries its per-resource grantId.
  resources: z.array(AgentGrantResourceSchema).min(1),
  createdAt: TimestampSchema,
});
export type ConnectedApp = z.infer<typeof ConnectedAppSchema>;

export const ListConnectedAppsResponseSchema = z.object({ apps: z.array(ConnectedAppSchema) });
export type ListConnectedAppsResponse = z.infer<typeof ListConnectedAppsResponseSchema>;

/** OAuth error response (RFC 6749 §5.2) — returned by /token and echoed to /authorize's redirect. */
export const OAuthErrorSchema = z.object({
  error: z.enum([
    'invalid_request',
    'invalid_client',
    'invalid_grant',
    'unauthorized_client',
    'unsupported_grant_type',
    'invalid_scope',
    'access_denied',
    'server_error',
  ]),
  error_description: z.string().optional(),
});
export type OAuthError = z.infer<typeof OAuthErrorSchema>;

// --- Discovery documents (built from the deployment origin; pure so route + tests agree) ----------

/**
 * RFC 8414 Authorization Server Metadata. Advertises the endpoints + the hard constraints (S256-only,
 * authorization_code-only, public clients). Built from the request origin so it is correct on any
 * deployment (live, dogfood, ephemeral red-team target) without a hardcoded host.
 */
export function buildAuthServerMetadata(origin: string) {
  return {
    issuer: origin,
    registration_endpoint: `${origin}/api/oauth/register`,
    // The authorization_endpoint is the address the CLIENT opens in a BROWSER — so it is the PWA consent
    // route (`/oauth/authorize`, served by the SPA), NOT the `/api/oauth/authorize` JSON mint endpoint the
    // consent screen POSTs to internally (oauth-provider.md §2b). Advertising the /api path here 404s the
    // client's top-level GET.
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/api/oauth/token`,
    scopes_supported: [...OAUTH_V1_SCOPES],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: [PKCE_METHOD],
    token_endpoint_auth_methods_supported: ['none'],
  } as const;
}

/**
 * RFC 9728 Protected Resource Metadata for `/api/mcp`. Points MCP clients at this AS and names the
 * `resource` identifier a token is bound to (audience binding, RFC 8707). Single-RS today, but recorded so
 * the binding survives a future second resource server.
 */
export function buildProtectedResourceMetadata(origin: string) {
  return {
    resource: `${origin}/api/mcp`,
    authorization_servers: [origin],
    scopes_supported: [...OAUTH_V1_SCOPES],
    bearer_methods_supported: ['header'],
  } as const;
}
