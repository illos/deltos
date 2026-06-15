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

/**
 * A principal is the actor an operation runs as.
 *
 * INVARIANT: a Principal is established by the authentication layer on the server, NEVER
 * trusted from the request body. No API request carries a principal field; the server derives
 * it from verified credentials (see {@link RequestPrincipal}). Treating a client-supplied id as
 * a principal would make `id` a bearer username — the exact failure this contract forecloses.
 */
export const PrincipalSchema = z.object({
  kind: PrincipalKindSchema,
  /** Stable identifier for this principal (device id, agent name, plugin id, …). */
  id: z.string().min(1),
});
export type Principal = z.infer<typeof PrincipalSchema>;

/**
 * How the live caller proved its identity on THIS request. A Grant names *who* may act; this
 * names *how* the actor was authenticated right now. An `id` on its own is only a claimed
 * bearer username, so authorization (and the audit log) must be able to see the proof and
 * refuse, say, a write from an unproven principal.
 *
 * Phase 1 fills in real `passkey` assertions, `signed-request` HMACs, and `capability-token`
 * checks. Phase 0 ships only the deliberately-named `unverified` local-dev stub, so "no real
 * auth yet" can never be mistaken for the real thing. `passthrough()` lets each method carry
 * its own proof fields without reshaping this seam.
 */
export const VERIFICATION_METHODS = [
  'unverified',
  'passkey',
  'signed-request',
  'capability-token',
] as const;
export const PrincipalVerificationSchema = z
  .object({ method: z.enum(VERIFICATION_METHODS) })
  .passthrough();
export type PrincipalVerification = z.infer<typeof PrincipalVerificationSchema>;

/**
 * The live caller: a principal plus proof of how it was authenticated this request. This is
 * what flows into `can()` — never a bare claimed id. A persisted {@link Grant} keeps the
 * plain {@link Principal} (it records intent, not a live authentication).
 *
 * `verification` is the credential-binding marker: a RequestPrincipal is unconstructable
 * without declaring HOW it was authenticated. Even the local-dev `unverified` method is an
 * explicit, auditable declaration — there is no way to assert a live principal while staying
 * silent about its proof, which is what keeps an unauthenticated caller from masquerading.
 */
export const RequestPrincipalSchema = PrincipalSchema.extend({
  verification: PrincipalVerificationSchema,
});
export type RequestPrincipal = z.infer<typeof RequestPrincipalSchema>;

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
 * row-level filters later). Because every constraint is a RESTRICTION, the schema is
 * fail-CLOSED: `.strict()` makes an unrecognized key reject at the boundary rather than ride
 * along silently. An evaluator that predates a new constraint therefore refuses to parse the
 * grant instead of honoring a strictly-more-permissive subset of it — no fail-open privilege
 * escalation. Adding a constraint is a deliberate, versioned change to THIS schema, never an
 * ad-hoc extra key. See {@link CanCheck} for the matching runtime obligation.
 */
export const GrantConstraintsSchema = z
  .object({
    expiresAt: TimestampSchema.optional(),
  })
  .strict();
export type GrantConstraints = z.infer<typeof GrantConstraintsSchema>;

export const GrantSchema = z.object({
  principal: PrincipalSchema,
  resource: ResourceSchema,
  scope: z.array(ScopeSchema),
  constraints: GrantConstraintsSchema,
});
export type Grant = z.infer<typeof GrantSchema>;

/**
 * The one authorization signature the whole system funnels through. It takes the live
 * {@link RequestPrincipal} (carrying verification proof, never a bare claimed id), consults
 * the grants registry, and returns a decision. The Phase-0 stub allows everything; it is async
 * because real evaluation will read persisted grants and validate the verification proof.
 *
 * FAIL-CLOSED OBLIGATION: a conforming `can()` MUST deny if it encounters any grant constraint
 * it does not recognize or cannot evaluate. {@link GrantConstraintsSchema} enforces this at the
 * parse boundary (unknown keys reject), and the runtime check must uphold the same default —
 * unknown or unevaluable restriction ⇒ deny, never allow.
 */
export type CanCheck = (
  principal: RequestPrincipal,
  op: Op,
  resource: Resource,
) => Promise<boolean>;
