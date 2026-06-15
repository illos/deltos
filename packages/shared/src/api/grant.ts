import { z } from 'zod';
import { NoteIdSchema, NotebookIdSchema, TimestampSchema } from '../spine/ids.js';

/**
 * Authorization is one primitive through one chokepoint. A share link, an agent token, and a
 * plugin scope are all the *same* grant — they differ only in how they're delivered. Every
 * API call resolves a principal, names a resource and an op, and passes through a single
 * `can(principal, op, resource)` check. This module defines the shape of that primitive; the
 * worker owns the (eventually real) evaluation.
 */

export const PRINCIPAL_KINDS = [
  'owner',
  'device',
  'guest',
  'anonymous',
  'agent',
  'plugin',
] as const;
export const PrincipalKindSchema = z.enum(PRINCIPAL_KINDS);
export type PrincipalKind = z.infer<typeof PrincipalKindSchema>;

export const PrincipalSchema = z.object({
  kind: PrincipalKindSchema,
  /** Stable identifier for this principal (device id, agent name, plugin id, …). */
  id: z.string().min(1),
});
export type Principal = z.infer<typeof PrincipalSchema>;

/**
 * Resources form a coarse-to-fine hierarchy. A discriminated union keeps the id strongly
 * typed to the level it addresses — `workspace` carries none, `notebook`/`note` carry theirs.
 */
export const ResourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('workspace') }),
  z.object({ kind: z.literal('notebook'), id: NotebookIdSchema }),
  z.object({ kind: z.literal('note'), id: NoteIdSchema }),
]);
export type Resource = z.infer<typeof ResourceSchema>;

/** The verbs a grant can authorize. An `Op` passed to `can()` is exactly one of these. */
export const SCOPES = ['read', 'write', 'create', 'delete', 'share', 'search'] as const;
export const ScopeSchema = z.enum(SCOPES);
export type Scope = z.infer<typeof ScopeSchema>;

/** The single operation kind checked at the chokepoint. */
export const OpSchema = ScopeSchema;
export type Op = z.infer<typeof OpSchema>;

/**
 * Constraints narrow a grant beyond resource + scope (expiry today; rate, origin, and
 * row-level filters later). Kept open so the registry can grow without reshaping the grant.
 */
export const GrantConstraintsSchema = z
  .object({
    expiresAt: TimestampSchema.optional(),
  })
  .passthrough();
export type GrantConstraints = z.infer<typeof GrantConstraintsSchema>;

export const GrantSchema = z.object({
  principal: PrincipalSchema,
  resource: ResourceSchema,
  scope: z.array(ScopeSchema),
  constraints: GrantConstraintsSchema,
});
export type Grant = z.infer<typeof GrantSchema>;

/**
 * The one authorization signature the whole system funnels through. Implementations consult
 * the grants registry; the Phase-0 stub allows everything. Async because real evaluation will
 * read persisted grants.
 */
export type CanCheck = (principal: Principal, op: Op, resource: Resource) => Promise<boolean>;
