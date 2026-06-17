import {
  resourceEquals,
  type CanCheck,
  type Op,
  type PrincipalKind,
  type RequestPrincipal,
  type Resource,
} from '@deltos/shared';
import type { AppContext } from './context.js';
import { createAuthStore, type AuthStore } from './db/authStore.js';
import { d1Adapter } from './db/schema.js';
import { hashToken } from './authCrypto.js';

/**
 * The authorization chokepoint. `resolvePrincipal` now does REAL server-side resolution: it reads
 * the `Authorization: Bearer` token, hashes it (F6), and resolves the grant row — nothing is trusted
 * from the request body, and the raw token never leaves as anything but its hash. `can()` is the one
 * exhaustive per-method decision; its `grant-token`/`capability` branches enforce the resolved grant
 * (scope, resource coverage, expiry, revocation), `signed-request` binds a step-up to exactly its
 * (op, resource), and `unverified` is the dev stub the F13 tripwire refuses in production.
 */

/** Resolved grant data — exactly the shape authStore returns, kept on the principal out-of-band. */
type ResolvedGrant = NonNullable<Awaited<ReturnType<AuthStore['resolveGrantByTokenHash']>>>;

/**
 * The resolved grant for a request principal, attached out-of-band (the frozen verification union
 * carries only `grantId`, never scope/resource). Keyed by the principal OBJECT, which is unique per
 * request, so this is request-scoped and garbage-collected with the principal — no cross-request
 * bleed, and no change to the locked contract.
 */
const resolvedGrants = new WeakMap<RequestPrincipal, ResolvedGrant>();

/**
 * The dev-only stub principal — no bearer present. Refused in production by the F13 tripwire.
 *
 * ⚠ `id` = a sentinel ACCOUNT id (accountId), NOT a credential fingerprint. After the zero-delta
 * re-point (migration 0003), `principal.id` MEANS `accountId` everywhere. In dev this stub stands in
 * for "the local account"; data scopes to it. The credential id (accountFingerprint) is never carried
 * on a principal — it lives on `devices.accountFingerprint` / `grants.mintedByKeyId`.
 */
const LOCAL_OWNER: RequestPrincipal = {
  kind: 'owner',
  id: 'local-account',
  verification: { method: 'unverified' },
};

/** Extract the opaque token from an `Authorization: Bearer <token>` header; null if absent/malformed. */
export function parseBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/** owner/device session grants are bearer `grant-token`s; share-link / agent / plugin / guest are `capability`. */
function methodForPrincipalKind(kind: PrincipalKind): 'grant-token' | 'capability' {
  return kind === 'owner' || kind === 'device' ? 'grant-token' : 'capability';
}

/**
 * Build the live principal a resolved grant authenticates — never a bare claimed id.
 *
 * ⚠ `grant.principal.id` = the grant's `principalId`, which after the re-point (migration 0003) MEANS
 * `accountId` for owner/device grants — so `principal.id` = `accountId`, NOT `accountFingerprint`.
 * The session-mint route stamps `principalId = accountId` (resolved server-side from the credential),
 * and migration 0003 re-pointed any pre-existing owner grants. Credential identity is tracked
 * separately on `grants.mintedByKeyId` + `devices.accountFingerprint`; never read a fingerprint here.
 */
export function principalForGrant(grant: ResolvedGrant): RequestPrincipal {
  const grantId = grant.grantId;
  const verification =
    methodForPrincipalKind(grant.principal.kind) === 'capability'
      ? ({ method: 'capability', grantId } as const)
      : ({ method: 'grant-token', grantId } as const);
  return { kind: grant.principal.kind, id: grant.principal.id, verification };
}

/** Does a grant resource authorize the requested one? A workspace grant covers everything; else exact. */
function resourceCovers(granted: Resource, requested: Resource): boolean {
  // v1: a workspace grant authorizes any resource; finer grants match exactly. Notebook→note
  // hierarchy coverage needs a notebook lookup and is a deliberate follow-up, not v1.
  if (granted.kind === 'workspace') return true;
  return resourceEquals(granted, requested);
}

/**
 * The grant-token authorization decision (CF-5). Fail-closed at every gate, in order:
 *   - revoked (revokedAt present)  → deny immediately (PIN-ID-5, no validity window)
 *   - expired (expiresAtMs <= now) → deny. NUMERIC instant compare, NEVER lexical (AUTH-1).
 *   - op not in the granted scope  → deny (the F5 clamp at mint is upheld here)
 *   - resource not covered         → deny
 * `nowMs` is the SERVER clock supplied by the caller (`can()` passes `Date.now()`).
 *
 * OWNERSHIP BELT (defense-in-depth, secSys S6 — the cross-account dimension). When the caller can supply
 * the resource's owning account (`resourceAccountId`, looked up server-side), the grant's account
 * (`grant.principal.id` = accountId after the re-point) MUST match it — a workspace-wide grant for
 * account A can never reach account B's note. This is the BELT; the PRIMARY control is the per-query
 * `accountId` scope in the data layer (`db/accountScope.ts`), which physically excludes other accounts'
 * rows and cannot be bypassed by a forgotten arg. `can()` (no DB handle) omits it; a db-bound caller
 * that has resolved the resource owner passes it. A null/absent owner with a check requested = DENY
 * (fail-closed — an unstamped row is owned by no one).
 */
export function grantAllows(
  grant: ResolvedGrant,
  op: Op,
  resource: Resource,
  nowMs: number,
  resourceAccountId?: string | null,
): boolean {
  if (grant.revokedAt !== null) return false;
  if (grant.expiresAtMs !== null && grant.expiresAtMs <= nowMs) return false;
  if (!grant.scope.includes(op)) return false;
  if (!resourceCovers(grant.resource, resource)) return false;
  if (resourceAccountId !== undefined) {
    // Belt requested: the resource must belong to the grant's account. Fail-closed on a null owner.
    return resourceAccountId !== null && resourceAccountId === grant.principal.id;
  }
  return true;
}

/**
 * Resolve the live principal for this request. With a valid bearer it returns a real grant-token
 * principal and stashes the resolved grant for `can()`; with no bearer (or an unrecognized one) it
 * returns the dev stub — which production refuses at the tripwire, so an unknown token can never act
 * as a real principal. `store` is injectable for tests; production builds it from the D1 binding.
 */
export async function resolvePrincipal(c: AppContext, store?: AuthStore): Promise<RequestPrincipal> {
  const token = parseBearerToken(c.req.header('Authorization'));
  if (token) {
    const authStore = store ?? createAuthStore(d1Adapter(c.env.DB));
    const grant = await authStore.resolveGrantByTokenHash(hashToken(token));
    if (grant) {
      const principal = principalForGrant(grant);
      resolvedGrants.set(principal, grant);
      return principal;
    }
    // Present but unrecognized token: fall through to the unverified stub (prod refuses it; dev has
    // no real auth anyway), so a bad bearer is never silently honored as an authenticated principal.
  }
  return LOCAL_OWNER;
}

/**
 * The one authorization decision, switching exhaustively on the verified `verification.method`
 * — authority keys STRICTLY on the method (never on an incidental field). Each branch is
 * fail-closed: an unimplemented or unrecognized method DENIES, never allows.
 */
export const can: CanCheck = async (principal, op, resource) => {
  const v = principal.verification;
  switch (v.method) {
    case 'grant-token':
    case 'capability': {
      // Authority comes from the SERVER-RESOLVED grant attached at resolvePrincipal time — never from
      // the principal's claimed id. A principal without a resolved grant (e.g. built outside the real
      // resolution path) denies. The resolved grant gates scope/resource/expiry/revocation (CF-5).
      const grant = resolvedGrants.get(principal);
      if (!grant) return false;
      return grantAllows(grant, op, resource, Date.now());
    }
    case 'signed-request':
      // DEAD post-pivot: the 2026-06-17 password pivot deleted the signed-challenge stack, so NOTHING
      // constructs a `signed-request` principal any more (step-up is now a password/TOTP re-prompt). The
      // branch is KEPT (the frozen PrincipalVerification union still carries the member; can.test.ts
      // covers it) and stays fail-closed-by-construction. Removing the union member is a separate authz
      // cleanup. Its binding semantics, were it ever revived: the signature was verified for `v.op` +
      // `v.resource`, bound to THIS request so one (op, resource) can never authorize another.
      return v.op === op && resourceEquals(v.resource, resource);
    case 'unverified':
      // Dev-only local stub; refused in production by the chokepoint tripwire.
      return true;
    default: {
      // Compile-time exhaustiveness (a new union member fails to compile here) + runtime
      // default-DENY (belt-and-suspenders if an unexpected value ever reaches it).
      const _exhaustive: never = v;
      return false;
    }
  }
};
