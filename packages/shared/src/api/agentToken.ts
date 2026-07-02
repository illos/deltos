import { z } from 'zod';
import { NotebookIdSchema, TimestampSchema } from '../spine/ids.js';
import { ScopeSchema, type Scope } from './grant.js';

/**
 * The agent-token surface (llm-mcp-integration.md §5). An agent token is NOT a new credential kind — it
 * is a row in the existing `grants` table with `principalKind: 'agent'`, non-expiring (`expiresAtMs:
 * null`), scope-CLAMPED at mint, and independently revocable. This module is the schema-first source of
 * truth for the three owner-authed routes (mint / list / revoke); the worker derives its types from here.
 *
 * READ is the FLOOR, WRITE is OPT-IN (ROAD-0005 write-tools §2): every agent token carries at least
 * `['read', 'search']`, and `share` is NEVER grantable (managing tokens is the owner-only capability the
 * agent-token routes gate on). The write verbs (`write`/`create`/`delete`) are added ONLY when the owner
 * explicitly opts in PER-SCOPE at mint ({@link clampAgentScopes} with `allowWrite`); with no opt-in the
 * grant floors to read-only, fail-closed ({@link clampToReadOnlyScopes}). accountId/principalId is ALWAYS
 * the authenticated owner's `principal.id`, derived server-side, NEVER taken from the body.
 */

/** The read-only floor every agent token holds. */
export const AGENT_TOKEN_SCOPES = ['read', 'search'] as const;
export const AgentTokenScopeSchema = z.enum(AGENT_TOKEN_SCOPES);
export type AgentTokenScope = z.infer<typeof AgentTokenScopeSchema>;

/**
 * The FULL set of scopes an agent grant may hold — the read-only floor PLUS the opt-in write verbs.
 * `share` is deliberately EXCLUDED: token management is the owner-only capability the agent-token routes
 * key on, so an agent grant can never widen into it. This is the enum the non-secret token views validate.
 */
export const AGENT_GRANT_SCOPES = ['read', 'search', 'create', 'write', 'delete'] as const;
export const AgentGrantScopeSchema = z.enum(AGENT_GRANT_SCOPES);
export type AgentGrantScope = z.infer<typeof AgentGrantScopeSchema>;

/**
 * Per-scope write opt-in at mint (least-privilege). Each flag maps to exactly one `can()` op the write
 * tools check, so an owner can mint (say) a create-only token that cannot edit or delete existing notes:
 *   - `create` → the `create` op (create_note)
 *   - `update` → the `write` op   (update_note / append_block / set_property)
 *   - `trash`  → the `delete` op   (trash_note — soft `sys:trashedAt`, never a hard tombstone)
 * `.strict()` so no unknown key can ride along and widen the grant.
 */
export const AgentWriteOptSchema = z
  .object({
    create: z.boolean().optional(),
    update: z.boolean().optional(),
    trash: z.boolean().optional(),
  })
  .strict();
export type AgentWriteOpt = z.infer<typeof AgentWriteOptSchema>;

/** The op each write opt-in flag unlocks — the single mapping the clamp keys on. */
const WRITE_OPT_TO_OP = { create: 'create', update: 'write', trash: 'delete' } as const;

/**
 * Clamp a minted agent grant's scope, fail-closed. READ is the floor (`['read','search']` always kept
 * when present, defaulting to the full read-only surface when nothing is requested); WRITE verbs are added
 * ONLY for the flags explicitly set in `allowWrite`. `share` can never appear (it is not in the source
 * allow-lists). Order is canonical, duplicates collapse, and an all-dropped request floors to `['read']`
 * so a grant is never scope-less. This is THE security control that keeps write off by default.
 */
export function clampAgentScopes(
  requested?: Scope[],
  opts?: { allowWrite?: AgentWriteOpt },
): AgentGrantScope[] {
  // Read floor: exactly today's read-only clamp behavior.
  const readSource: readonly Scope[] = requested ?? AGENT_TOKEN_SCOPES;
  const read = AGENT_TOKEN_SCOPES.filter((s) => readSource.includes(s)) as AgentGrantScope[];

  // Write verbs: added ONLY per explicit opt-in flag (never inferred from `requested`).
  const write: AgentGrantScope[] = [];
  const allow = opts?.allowWrite;
  if (allow) {
    for (const [flag, op] of Object.entries(WRITE_OPT_TO_OP) as [keyof AgentWriteOpt, AgentGrantScope][]) {
      if (allow[flag]) write.push(op);
    }
  }

  // Canonical order + dedupe; floor to ['read'] so the grant is never empty.
  const merged = AGENT_GRANT_SCOPES.filter((s) => read.includes(s) || write.includes(s));
  return merged.length > 0 ? [...merged] : ['read'];
}

/**
 * Clamp a requested scope array down to the read-only floor — the write-free path (no opt-in). Kept as a
 * named helper for the read-only callers (OAuth consent, default mint); delegates to {@link clampAgentScopes}
 * so there is ONE clamp implementation and the read floor can never drift between the two.
 */
export function clampToReadOnlyScopes(requested?: Scope[]): AgentTokenScope[] {
  return clampAgentScopes(requested) as AgentTokenScope[];
}

/**
 * Mint request. `scope` accepts any valid {@link ScopeSchema} verb (a disallowed verb is DROPPED at the
 * clamp, not rejected at the boundary). `write` is the explicit per-scope opt-in for the write tools —
 * ABSENT ⇒ a read-only token (every existing caller stays read-only). `.strict()` rejects unknown keys —
 * no silent ride-along field can influence the mint.
 */
export const MintAgentTokenRequestSchema = z
  .object({
    label: z.string().max(200).optional(),
    scope: z.array(ScopeSchema).optional(),
    notebookId: NotebookIdSchema.optional(),
    // Per-scope write opt-in (least-privilege). Omit for a read-only token; set flags to grant write tools.
    write: AgentWriteOptSchema.optional(),
    // H1 STEP-UP (ROAD-0005 P0): minting a long-lived, non-expiring credential requires fresh re-auth — a
    // live session bearer is not enough. `password` always; `totp` when 2FA is enabled. These are verified
    // + discarded server-side (never stored). See worker `verifyStepUp`. Even more warranted for a
    // write-capable mint (the human is re-proved at issuance; no human is present at write time).
    password: z.string().min(1).optional(),
    totp: z.string().optional(),
  })
  .strict();
export type MintAgentTokenRequest = z.infer<typeof MintAgentTokenRequestSchema>;

/** The non-secret view of an agent token (list rows + the metadata half of the mint response). */
export const AgentTokenSchema = z.object({
  grantId: z.string().min(1),
  label: z.string().nullable(),
  scope: z.array(AgentGrantScopeSchema),
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
