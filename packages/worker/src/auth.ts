import { resourceEquals, type CanCheck, type RequestPrincipal } from '@deltos/shared';
import type { AppContext } from './context.js';

/**
 * The authorization chokepoint. `resolvePrincipal` is still the Stream-A-pending stub;
 * `can()` is now the real exhaustive per-method switch (it gains real branches as the Stream-A
 * backend lands).
 *
 * `resolvePrincipal` will, in Stream A, verify a grant token / signed request and return the
 * proven caller. Today it returns a single local owner marked `unverified`, so the absence of
 * real auth is explicit in every request rather than silently assumed — and the chokepoint
 * tripwire refuses an `unverified` principal in production, so the stub can never serve prod.
 */

const LOCAL_OWNER: RequestPrincipal = {
  kind: 'owner',
  id: 'local-owner',
  verification: { method: 'unverified' },
};

export function resolvePrincipal(_c: AppContext): RequestPrincipal {
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
    case 'capability':
      // Fail-CLOSED until the Stream-A grants registry lands: resolve `v.grantId`, check
      // `op ∈ grant.scope`, honour constraints (deny on any unrecognized one). Not reachable
      // yet — `resolvePrincipal` only ever sets `unverified` today — so denying here is the
      // safe default, not a behaviour change.
      return false;
    case 'signed-request':
      // Step-up: the signature was VERIFIED for `v.op` + `v.resource`. Bind it to THIS request
      // at the chokepoint — a step-up signed for one (op, resource) can never authorize another,
      // and there is no trust in middleware having matched them.
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
