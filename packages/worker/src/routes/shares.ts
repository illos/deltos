import { Hono } from 'hono';
import {
  ShareMintRequestSchema,
  ListSharesQuerySchema,
  RevokeShareRequestSchema,
  buildShareUrl,
  SHARE_TOKEN_PREFIX,
  type Resource,
  type ShareResourceType,
} from '@deltos/shared';
import type { AppEnv } from '../context.js';
import { guard, apiError } from '../http.js';
import { createAuthStore } from '../db/authStore.js';
import { d1Adapter } from '../db/schema.js';
import { createResourceOwnerResolver } from '../db/resourceOwner.js';
import { hashToken, randomToken } from '../authCrypto.js';
import { stampAccountId } from '../db/accountScope.js';
import { audit, credentialRefOf } from '../audit.js';

/**
 * URL read-only sharing surface (ROAD-0011 P2 §3) — three OWNER-authed routes that mint / list / revoke an
 * ANONYMOUS-principal read-only share of a note or notebook. A share is a `grants` row (principalKind=
 * 'anonymous', scope=['read'], non-expiring), bearer = the URL token (`dltos_share_<32-byte CSPRNG>`,
 * HASH-stored only, F6). The public render surface (`/s/<token>`, routes/shareSurface.ts) resolves the token.
 *
 * AUTHZ — every route runs the SAME `guard()` chokepoint with op `'share'` (assumption guard #1 + #8):
 *   1. The owner's session grant carries the full scope (incl. 'share') over their workspace, so the human
 *      owner is authorized to mint a share of any of their OWN resources.
 *   2. An AGENT/capability token's scope is clamped to ['read',...] with NO 'share', so it 403s at the
 *      chokepoint — an agent can NEVER mint/list/revoke a share (managing access IS the 'share' capability).
 *      There is exactly ONE way to hold 'share': be the human owner. No step-up on a share mint (Jim's call).
 *
 * OWNERSHIP (guard #3) — a workspace 'share' grant authorizes 'share' over ANY resource id at the chokepoint
 * (exact-match workspace coverage), so the handler ADDITIONALLY resolves the resource's TRUE owner and
 * confirms it equals the caller's account before minting — a foreign/absent resource is a 404, never an inert
 * share. RESIDENCY: server — zero client bundle.
 */
export const shares = new Hono<AppEnv>();

/** Map a share resourceType to a can()/grant Resource (both kinds address by id). */
function toResource(resourceType: ShareResourceType, resourceId: string): Resource {
  return { kind: resourceType, id: resourceId } as Resource;
}

/** The public origin from the request URL — correct on any deploy (live/dogfood). */
function requestOrigin(url: string): string {
  return new URL(url).origin;
}

/**
 * POST /api/shares { resourceType, resourceId } — mint an anonymous read-only share of a note/notebook the
 * caller OWNS. Returns the raw token + full URL ONCE (only SHA-256(token) is persisted) + the shareId.
 */
shares.post(
  '/',
  guard({
    op: 'share',
    schema: ShareMintRequestSchema,
    input: (c) => c.req.json().catch(() => ({})),
    resource: (req): Resource => toResource(req.resourceType, req.resourceId),
    handle: async (req, c, principal) => {
      const db = d1Adapter(c.env.DB);
      const store = createAuthStore(db);
      const accountId = stampAccountId(principal);
      const resource = toResource(req.resourceType, req.resourceId);

      // OWNERSHIP VALIDATION (fail-closed, guard #3): the resource's TRUE owner MUST be the caller's account.
      // A workspace 'share' grant authorized the op at the chokepoint for ANY id; this stops a share of a
      // foreign/nonexistent resource (which would be an inert grant the surface could never serve anyway).
      const owner = await createResourceOwnerResolver(db)(resource);
      if (!owner || owner.accountId !== accountId) {
        return apiError(c, 404, 'not_found', `${req.resourceType} not found`);
      }

      const now = new Date().toISOString();
      const shareId = randomToken(16);
      // Recognizable prefix + 32 bytes CSPRNG. Only SHA-256(token) is stored; the raw token is returned once.
      const token = `${SHARE_TOKEN_PREFIX}${randomToken(32)}`;
      // Stamp the owner's theme (ROAD-0011 P2) — both axes or neither (the client sends both). Already
      // strict-enum validated by ShareMintRequestSchema, so no arbitrary string reaches the render CSS.
      const theme = req.palette && req.voice ? { palette: req.palette, voice: req.voice } : null;
      await store.insertShareGrant({ grantId: shareId, tokenHash: hashToken(token), accountId, resource, theme, createdAt: now });

      await audit(c, {
        surface: 'auth',
        action: 'share.mint',
        result: 'allow',
        principalKind: principal.kind,
        accountId,
        credentialRef: credentialRefOf(principal),
        resourceKind: resource.kind,
        resourceId: req.resourceId,
        detail: `share ${shareId}`,
      });

      return c.json(
        {
          shareId,
          resourceType: req.resourceType,
          resourceId: req.resourceId,
          createdAt: now,
          revoked: false as const,
          token, // returned EXACTLY once — never persisted, never re-served
          url: buildShareUrl(requestOrigin(c.req.url), token),
        },
        201,
      );
    },
  }),
);

/**
 * GET /api/shares?resourceType=&resourceId= — owner-only list of the LIVE (non-revoked) shares for one
 * resource. NEVER returns the token (hash-only stored).
 */
shares.get(
  '/',
  guard({
    op: 'share',
    schema: ListSharesQuerySchema,
    input: (c) => ({ resourceType: c.req.query('resourceType'), resourceId: c.req.query('resourceId') }),
    resource: (req): Resource => toResource(req.resourceType, req.resourceId),
    handle: async (req, c, principal) => {
      const db = d1Adapter(c.env.DB);
      const store = createAuthStore(db);
      const accountId = stampAccountId(principal);

      // Ownership (guard #3) — same as mint: only list shares of a resource the caller actually owns.
      const owner = await createResourceOwnerResolver(db)(toResource(req.resourceType, req.resourceId));
      if (!owner || owner.accountId !== accountId) {
        return apiError(c, 404, 'not_found', `${req.resourceType} not found`);
      }

      const rows = await store.listSharesForResource(accountId, req.resourceType, req.resourceId);
      return c.json({
        shares: rows.map((r) => ({
          shareId: r.shareId,
          resourceType: r.resourceKind,
          resourceId: r.resourceId,
          createdAt: r.createdAt,
          revoked: false as const,
        })),
      });
    },
  }),
);

/**
 * DELETE /api/shares/:shareId — owner-only immediate revoke (guard #10). BOLA-scoped in the store (account
 * match IN the WHERE + principalKind='anonymous'); a non-match revokes zero rows → 404 (no existence oracle).
 */
shares.delete(
  '/:shareId',
  guard({
    op: 'share',
    schema: RevokeShareRequestSchema,
    input: (c) => ({ shareId: c.req.param('shareId') }),
    // Revoke targets a shareId, not a resource — authorize at workspace level (the human owner holds 'share'
    // over their workspace); the store's BOLA scope is the ownership control. Mirrors agent-token revoke.
    resource: (): Resource => ({ kind: 'workspace' }),
    handle: async (req, c, principal) => {
      const store = createAuthStore(d1Adapter(c.env.DB));
      const accountId = stampAccountId(principal);
      const revoked = await store.revokeShareForAccount(req.shareId, accountId);
      if (revoked === 0) {
        return apiError(c, 404, 'not_found', 'share not found');
      }
      await audit(c, {
        surface: 'auth',
        action: 'share.revoke',
        result: 'allow',
        principalKind: principal.kind,
        accountId,
        credentialRef: credentialRefOf(principal),
        detail: req.shareId,
      });
      return c.json({ shareId: req.shareId, revoked: true as const });
    },
  }),
);
