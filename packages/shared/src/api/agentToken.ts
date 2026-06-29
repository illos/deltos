import { z } from 'zod';
import { NotebookIdSchema, TimestampSchema } from '../spine/ids.js';
import { ScopeSchema, type Scope } from './grant.js';

/**
 * The agent-token surface (llm-mcp-integration.md §5). An agent token is NOT a new credential kind — it
 * is a row in the existing `grants` table with `principalKind: 'agent'`, non-expiring (`expiresAtMs:
 * null`), scope-CLAMPED at mint, and independently revocable. This module is the schema-first source of
 * truth for the three owner-authed routes (mint / list / revoke); the worker derives its types from here.
 *
 * v1 is READ-ONLY ONLY: an agent token may carry at most `['read', 'search']`. Any write/create/delete/
 * share verb is CLAMPED OUT at mint ({@link clampToReadOnlyScopes}), fail-closed — the request body can
 * never widen an agent token beyond reading. accountId/principalId is ALWAYS the authenticated owner's
 * `principal.id`, derived server-side, NEVER taken from the body.
 */

/** The ONLY scopes an agent token may hold in v1. A strict read-only surface. */
export const AGENT_TOKEN_SCOPES = ['read', 'search'] as const;
export const AgentTokenScopeSchema = z.enum(AGENT_TOKEN_SCOPES);
export type AgentTokenScope = z.infer<typeof AgentTokenScopeSchema>;

/**
 * Clamp a requested scope array down to the read-only allow-list — the single security control that
 * keeps an agent token from ever holding a write verb (fail-closed). Order is canonical (read, search),
 * duplicates collapse, and an empty/all-dropped request floors to `['read']` (never an empty,
 * scope-less grant). `undefined` (no scope requested) defaults to the full read-only surface.
 */
export function clampToReadOnlyScopes(requested?: Scope[]): AgentTokenScope[] {
  const source: readonly Scope[] = requested ?? AGENT_TOKEN_SCOPES;
  const clamped = AGENT_TOKEN_SCOPES.filter((s) => source.includes(s));
  return clamped.length > 0 ? [...clamped] : ['read'];
}

/**
 * Mint request. `scope` accepts any valid {@link ScopeSchema} verb (so a write verb is DROPPED at the
 * clamp rather than rejected at the boundary), but the minted grant is always read-only. `.strict()`
 * rejects unknown keys — no silent ride-along field can influence the mint.
 */
export const MintAgentTokenRequestSchema = z
  .object({
    label: z.string().max(200).optional(),
    scope: z.array(ScopeSchema).optional(),
    notebookId: NotebookIdSchema.optional(),
    // H1 STEP-UP (ROAD-0005 P0): minting a long-lived, non-expiring read-all credential requires fresh
    // re-auth — a live session bearer is not enough. `password` always; `totp` when 2FA is enabled. These
    // are verified + discarded server-side (never stored). See worker `verifyStepUp`.
    password: z.string().min(1).optional(),
    totp: z.string().optional(),
  })
  .strict();
export type MintAgentTokenRequest = z.infer<typeof MintAgentTokenRequestSchema>;

/** The non-secret view of an agent token (list rows + the metadata half of the mint response). */
export const AgentTokenSchema = z.object({
  grantId: z.string().min(1),
  label: z.string().nullable(),
  scope: z.array(AgentTokenScopeSchema),
  resourceKind: z.enum(['workspace', 'notebook']),
  resourceId: z.string().nullable(),
  createdAt: TimestampSchema,
});
export type AgentToken = z.infer<typeof AgentTokenSchema>;

/**
 * Mint response. Carries the raw `token` exactly ONCE — it is never persisted (only SHA-256(token) is
 * stored) and never returned again by any route. The client must capture it here or re-mint.
 */
export const MintAgentTokenResponseSchema = AgentTokenSchema.extend({
  token: z.string().min(1),
});
export type MintAgentTokenResponse = z.infer<typeof MintAgentTokenResponseSchema>;

/** List response — active (non-revoked) agent tokens for the caller's account. NEVER includes a token. */
export const ListAgentTokensResponseSchema = z.object({
  tokens: z.array(AgentTokenSchema),
});
export type ListAgentTokensResponse = z.infer<typeof ListAgentTokensResponseSchema>;

/** Revoke path-param. The grantId of the agent token to revoke (scoped to the caller's account at the store). */
export const RevokeAgentTokenRequestSchema = z.object({
  grantId: z.string().min(1),
});
export type RevokeAgentTokenRequest = z.infer<typeof RevokeAgentTokenRequestSchema>;
