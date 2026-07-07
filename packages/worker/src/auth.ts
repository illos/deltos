import {
  resourceEquals,
  type CanCheck,
  type Op,
  type PrincipalKind,
  type RequestPrincipal,
  type Resource,
} from '@deltos/shared';
import type { AppContext } from './context.js';
import { createAuthStore, type AuthStore, type ResolvedGrantRow } from './db/authStore.js';
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

/** Resolved grant data — exactly the row shape authStore returns, kept on the principal out-of-band. */
type ResolvedGrant = ResolvedGrantRow;

/**
 * The resolved grant SET for a request principal, attached out-of-band (the frozen verification union
 * carries only `grantId`, never scope/resource). A token may resolve to MANY rows (grant sets, ROAD-0011
 * P1) — evaluation is ANY-OF over them. Keyed by the principal OBJECT, which is unique per request, so this
 * is request-scoped and garbage-collected with the principal — no cross-request bleed, no contract change.
 */
const resolvedGrants = new WeakMap<RequestPrincipal, ResolvedGrant[]>();

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

/**
 * Token LIVENESS — the two fail-closed gates that do not depend on the requested (op, resource):
 *   - revoked (revokedAt present)  → not live (PIN-ID-5, no validity window)
 *   - expired (expiresAtMs <= now) → not live. NUMERIC instant compare, NEVER lexical (AUTH-1).
 * Shared by {@link grantAllows} (the per-op chokepoint) and the transport-level auth gate of the MCP
 * route, so "is this bearer still usable at all" is decided ONE way. `nowMs` is the SERVER clock.
 */
export function grantIsLive(
  grant: Pick<ResolvedGrant, 'revokedAt' | 'expiresAtMs'>,
  nowMs: number,
): boolean {
  if (grant.revokedAt !== null) return false;
  if (grant.expiresAtMs !== null && grant.expiresAtMs <= nowMs) return false;
  return true;
}

/**
 * The grant a `resolvePrincipal` call attached to this principal (the resolved row, out-of-band in the
 * request-scoped WeakMap), or undefined if the principal carries no resolved grant (the dev `unverified`
 * stub, or a principal built outside the real resolution path). The MCP transport gate reads this to
 * reject a revoked/expired bearer at the door (401) using {@link grantIsLive}, instead of leaking the
 * decision into a per-tool `can()` deny.
 */
export function resolvedGrantFor(principal: RequestPrincipal): ResolvedGrant[] | undefined {
  return resolvedGrants.get(principal);
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
  if (!grantIsLive(grant, nowMs)) return false;
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
    const principal = await resolveTokenPrincipal(authStore, token);
    // Present but unrecognized token: fall through to the unverified stub (prod refuses it; dev has
    // no real auth anyway), so a bad bearer is never silently honored as an authenticated principal.
    if (principal) return principal;
  }
  return LOCAL_OWNER;
}

/**
 * Resolve a RAW token (a `Authorization: Bearer` value OR a `/s/<token>` URL-share token) to a live grant-set
 * principal, stashing the resolved grant SET out-of-band so `can()`/`canWith` can evaluate it. Returns null
 * when the token matches NO grant row (caller decides the failure surface). This is the ONE token→principal
 * resolution used by every bearer path — the header path ({@link resolvePrincipal}) and the URL-token share
 * surface (ROAD-0011 P2) — so an anonymous share grant flows through the exact same chokepoint as an agent
 * token (assumption guard #1). Grant SETS: all rows sharing the hash carry the same principal + scope (one
 * mint event); evaluation is any-of; the first row represents the principal.
 */
export async function resolveTokenPrincipal(
  store: AuthStore,
  token: string,
): Promise<RequestPrincipal | null> {
  const grants = await store.resolveGrantsByTokenHash(hashToken(token));
  const [first] = grants;
  if (!first) return null;
  const principal = principalForGrant(first);
  resolvedGrants.set(principal, grants);
  return principal;
}

// ── Extended coverage: the notebook→note hierarchy resolver (ROAD-0011 P1 §1) ────────────────────────

/** The owning account + current notebook of a resolved resource — the resolver's return (null = unresolvable). */
export interface ResourceOwner {
  accountId: string;
  /** For a `note`, the note's CURRENT notebook (null = uncategorized / All-Notes pool). For a `notebook`, itself. */
  notebookId: string | null;
}

/**
 * Resolve a resource to its owning account + current notebook — injected by the DB-bound caller (the MCP/REST
 * route) so the account-less chokepoint (`auth.ts` holds no DB handle) can decide hierarchy coverage. Returns
 * null when the resource does not exist / has no owner (fail-closed at {@link canWith}). This is the SAME
 * owner-resolver §2/§3 (sharing) and §4 (RTC) build on — one implementation (see db/resourceOwner.ts).
 */
export type ResolveResourceOwner = (resource: Resource) => Promise<ResourceOwner | null>;

/** The context the extended evaluator needs beyond the principal — just the injected owner-resolver today. */
export interface CanContext {
  resolveResourceOwner: ResolveResourceOwner;
}

/**
 * The EXTENDED authorization decision (ROAD-0011 P1 §1): like {@link can} for grant-token/capability
 * principals, but with the injected owner-resolver so a NOTEBOOK grant covers its notes. ANY-OF over the
 * resolved grant set; the requested resource's owner is resolved LAZILY and at most once (only when a finer
 * grant needs it). Non-grant verification methods (signed-request / unverified) delegate to {@link can}.
 *
 * Coverage per grant (fail-closed):
 *   - WORKSPACE grant → covers any resource. The per-query `accountId` data-layer scope is the PRIMARY
 *     cross-account control (a workspace token for A physically can't read B's rows), so — exactly as
 *     today's `can()` — the owner-resolver/belt is NOT applied here; a nonexistent note stays a data-layer
 *     "not found", never a spurious "forbidden".
 *   - NOTEBOOK/NOTE grant → needs the resolved owner. OWNERSHIP BELT: owner.accountId MUST equal the grant's
 *     account (a notebook grant for A can never reach B's note, even on a matching notebookId). A notebook(X)
 *     grant covers note(N) IFF N currently lives in X (live) — move it out and coverage is lost; a
 *     `notebookId = null` note is covered ONLY by a workspace grant. Unresolvable resource → deny.
 *
 * `can()` WITHOUT a resolver keeps exact-match — a notebook grant + note resource on the plain path is a
 * DENY (the deliberate fail-closed default the DB-bound caller upgrades by using this).
 */
export async function canWith(
  ctx: CanContext,
  principal: RequestPrincipal,
  op: Op,
  resource: Resource,
): Promise<boolean> {
  const v = principal.verification;
  if (v.method !== 'grant-token' && v.method !== 'capability') {
    // signed-request / unverified / exhaustive default — identical to the plain chokepoint.
    return can(principal, op, resource);
  }
  const grants = resolvedGrants.get(principal);
  if (!grants || grants.length === 0) return false;
  const nowMs = Date.now();

  // Resolve the requested resource's owner at most once, and only if a finer grant actually needs it.
  let ownerResolved = false;
  let owner: ResourceOwner | null = null;
  const getOwner = async (): Promise<ResourceOwner | null> => {
    if (!ownerResolved) {
      owner = resource.kind === 'workspace' ? null : await ctx.resolveResourceOwner(resource);
      ownerResolved = true;
    }
    return owner;
  };

  for (const g of grants) {
    if (!grantIsLive(g, nowMs)) continue;
    if (!g.scope.includes(op)) continue;
    const granted = g.resource;
    if (granted.kind === 'workspace') return true; // covers everything in its account (data-layer scoped)
    if (resource.kind === 'workspace') continue; // a finer grant never covers a workspace request
    const o = await getOwner();
    if (!o || o.accountId !== g.principal.id) continue; // unresolvable or cross-account → belt deny
    if (granted.kind === 'notebook') {
      if (resource.kind === 'notebook' ? granted.id === resource.id : o.notebookId === granted.id) return true;
    } else if (granted.kind === 'note') {
      if (resource.kind === 'note' && granted.id === resource.id) return true;
    }
  }
  return false;
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
      // Authority comes from the SERVER-RESOLVED grant SET attached at resolvePrincipal time — never from
      // the principal's claimed id. A principal with no resolved set denies. Evaluation is ANY-OF over the
      // set (grant sets, ROAD-0011 P1); each grant gates scope/resource/expiry/revocation (CF-5). This plain
      // path uses exact-match coverage (no resolver) — a notebook grant + note resource is a fail-closed DENY
      // (the hierarchy rule lives in canWith, which a DB-bound caller uses).
      const grants = resolvedGrants.get(principal);
      if (!grants || grants.length === 0) return false;
      const nowMs = Date.now();
      return grants.some((g) => grantAllows(g, op, resource, nowMs));
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
