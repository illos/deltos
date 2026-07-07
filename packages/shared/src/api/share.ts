import { z } from 'zod';
import { TimestampSchema } from '../spine/ids.js';

/**
 * Read-only URL sharing (ROAD-0011 P2 §3) — the schema-first boundary contract for the owner-authed
 * mint/list/revoke surface (`/api/shares`) AND the shape the public render surface (`/s/<token>`) resolves
 * against. Both the worker (routes) and the client share-lane build their static types by DERIVING them
 * from these Zod schemas — the schema is the single source of truth, never a hand-written duplicate.
 *
 * A share is NOT a new credential kind: it is a row in the existing `grants` table with
 * `principalKind: 'anonymous'`, `scope: ['read']`, non-expiring, revocable — bearer = the URL token itself
 * (`dltos_share_<32-byte CSPRNG>`, HASH-stored only, F6). `share` scope is never grantable to an agent (guard
 * #8); only a human owner holding `share` over the resource can mint one (enforced at the route via `can()`).
 */

/** The two resource kinds a URL-share can target. A notebook share also exposes its notes read-only. */
export const ShareResourceTypeSchema = z.enum(['note', 'notebook']);
export type ShareResourceType = z.infer<typeof ShareResourceTypeSchema>;

/** The `dltos_share_` token prefix — the recognizable, greppable family marker (mirrors `dltos_agent_`). */
export const SHARE_TOKEN_PREFIX = 'dltos_share_' as const;

/** The public render surface mount path. A share URL is `<origin>/s/<token>`. */
export const SHARE_SURFACE_PREFIX = '/s' as const;

/** Build the canonical public share URL for a token against a request origin. */
export function buildShareUrl(origin: string, token: string): string {
  return `${origin}${SHARE_SURFACE_PREFIX}/${token}`;
}

/**
 * POST /api/shares — mint an anonymous read-only share for a note/notebook the CALLER OWNS (verified via
 * `can(principal, 'share', resource)` at the route). `.strict()` so no unknown field rides along. There is
 * deliberately NO step-up on a share mint (Jim's call) — unlike an agent-token mint.
 */
export const ShareMintRequestSchema = z
  .object({
    resourceType: ShareResourceTypeSchema,
    resourceId: z.string().min(1),
  })
  .strict();
export type ShareMintRequest = z.infer<typeof ShareMintRequestSchema>;

/**
 * The non-secret view of a live share (list rows + the metadata half of the mint response). NEVER carries
 * the token — only its hash is stored, and it is returned exactly once at mint. `revoked` is a literal
 * `false` because listing only ever returns LIVE shares (a revoked share is gone, not shown as revoked).
 */
export const ShareSummarySchema = z.object({
  shareId: z.string().min(1),
  resourceType: ShareResourceTypeSchema,
  resourceId: z.string().min(1),
  createdAt: TimestampSchema,
  revoked: z.literal(false),
});
export type ShareSummary = z.infer<typeof ShareSummarySchema>;

/**
 * Mint response. Carries the raw `token` + full `url` EXACTLY ONCE (the token is never persisted — only
 * SHA-256(token) — and never re-served). The client must capture it here or re-mint.
 */
export const ShareMintResponseSchema = ShareSummarySchema.extend({
  token: z.string().min(1),
  url: z.string().min(1),
});
export type ShareMintResponse = z.infer<typeof ShareMintResponseSchema>;

/** GET /api/shares?resourceType=&resourceId= — the owner-only live-share listing for one resource. */
export const ListSharesQuerySchema = z
  .object({
    resourceType: ShareResourceTypeSchema,
    resourceId: z.string().min(1),
  })
  .strict();
export type ListSharesQuery = z.infer<typeof ListSharesQuerySchema>;

/** GET /api/shares response — the resource's live (non-revoked) shares. */
export const ListSharesResponseSchema = z.object({
  shares: z.array(ShareSummarySchema),
});
export type ListSharesResponse = z.infer<typeof ListSharesResponseSchema>;

/** DELETE /api/shares/:shareId path-param — the share row to revoke (BOLA-scoped to the caller's account). */
export const RevokeShareRequestSchema = z.object({
  shareId: z.string().min(1),
});
export type RevokeShareRequest = z.infer<typeof RevokeShareRequestSchema>;

/** DELETE /api/shares/:shareId response. */
export const RevokeShareResponseSchema = z.object({
  shareId: z.string().min(1),
  revoked: z.literal(true),
});
export type RevokeShareResponse = z.infer<typeof RevokeShareResponseSchema>;

/** GET /s/<token>/live response — the heartbeat probe (viewer-facing liveness; no cookies, no owner state). */
export const ShareLiveResponseSchema = z.object({
  /** note version (note share) OR the notebook revision = max note syncSeq (notebook share). Monotonic. */
  version: z.number(),
  revoked: z.literal(false),
});
export type ShareLiveResponse = z.infer<typeof ShareLiveResponseSchema>;
