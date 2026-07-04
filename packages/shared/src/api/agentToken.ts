import { z } from 'zod';
import { TimestampSchema } from '../spine/ids.js';
import { ScopeSchema, ResourceSchema, type Scope, type Resource } from './grant.js';

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
 * The upper bound on how many resources one token may be scoped to (grant sets, ROAD-0011 P1). A generous
 * ceiling — it bounds a runaway/abusive mint (N grant rows in one event) without limiting real use; the
 * picker never approaches it. Enforced by {@link clampAgentResources}, not rejected at the boundary.
 */
export const MAX_GRANT_RESOURCES = 100;

/**
 * Clamp a requested RESOURCE SET to the canonical, minimal set a token is minted against (ROAD-0011 P1 §1.2
 * — the second half of the ONE mint clamp path). Fail-closed + normalizing:
 *   - absent / empty        ⇒ `[{workspace}]` — the whole account, backward-compatible with today's mint.
 *   - workspace anywhere    ⇒ collapses to `[{workspace}]` — a workspace grant already covers every notebook
 *     and note, so any finer selection alongside it is redundant (and confusing to display/revoke).
 *   - otherwise             ⇒ the de-duplicated notebook/note selection, capped at {@link MAX_GRANT_RESOURCES}.
 * This is the CLAMP the security model leans on: only what survives this call is persisted, so a
 * client-requested (e.g. RFC-8707-seeded) resource the user did not keep never becomes a grant row.
 * Ownership of each selection is validated separately at the route (against the minter's account).
 */
export function clampAgentResources(requested?: Resource[]): Resource[] {
  if (!requested || requested.length === 0) return [{ kind: 'workspace' }];
  if (requested.some((r) => r.kind === 'workspace')) return [{ kind: 'workspace' }];
  const seen = new Set<string>();
  const out: Resource[] = [];
  for (const r of requested) {
    const key = `${r.kind}:${'id' in r ? r.id : ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
    if (out.length >= MAX_GRANT_RESOURCES) break;
  }
  return out;
}

/**
 * Mint request. `scope` accepts any valid {@link ScopeSchema} verb (a disallowed verb is DROPPED at the
 * clamp, not rejected at the boundary). `resources` is the RESOURCE SET (ROAD-0011 P1 §1) — pick notebooks
 * and/or notes, or omit for the whole workspace; it is clamped ({@link clampAgentResources}) and each
 * selection's ownership is validated against the minter before N grant rows (one per resource, sharing one
 * tokenGroupId) are persisted. `write` is the explicit per-scope opt-in for the write tools — ABSENT ⇒ a
 * read-only token. `.strict()` rejects unknown keys — no silent ride-along field can influence the mint.
 */
export const MintAgentTokenRequestSchema = z
  .object({
    label: z.string().max(200).optional(),
    scope: z.array(ScopeSchema).optional(),
    // The resource SET (grant sets). Each entry is a {@link ResourceSchema} (workspace | notebook | note).
    resources: z.array(ResourceSchema).optional(),
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

/** The allowed resource kinds a grant row can name (agent tokens can now scope to notes, not just notebooks). */
export const AGENT_RESOURCE_KINDS = ['workspace', 'notebook', 'note'] as const;

/**
 * One resource a token is scoped to, in the non-secret token view (ROAD-0011 P1 §1.4). Each carries its own
 * `grantId` — the per-resource grant row — so the UI can revoke ONE resource from a token without re-minting
 * (per-row revocation), while `id` is null for a workspace grant.
 */
export const AgentGrantResourceSchema = z.object({
  grantId: z.string().min(1),
  kind: z.enum(AGENT_RESOURCE_KINDS),
  id: z.string().nullable(),
});
export type AgentGrantResource = z.infer<typeof AgentGrantResourceSchema>;

/**
 * The non-secret view of an agent token (list rows + the metadata half of the mint response). A token is a
 * GRANT SET: `tokenId` (the shared tokenGroupId) is the whole-token identity — the target of whole-token
 * revoke — and `resources` is the per-resource set it authorizes ("2 notebooks · 1 note"). `scope` is uniform
 * across the set (one mint event, one scope).
 */
export const AgentTokenSchema = z.object({
  tokenId: z.string().min(1),
  label: z.string().nullable(),
  scope: z.array(AgentGrantScopeSchema),
  resources: z.array(AgentGrantResourceSchema).min(1),
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
