import type { Context } from 'hono';
import type { CanCheck, RequestPrincipal } from '@deltos/shared';

/**
 * The two halves of the authorization chokepoint, both deliberately stubbed for Phase 0.
 *
 * `resolvePrincipal` will, in Phase 1, verify a passkey assertion / signed request and return
 * the proven caller. Today it returns a single local owner marked `unverified` so that the
 * absence of real auth is explicit in every request rather than silently assumed. NOTE: the
 * `unverified` marker is the seam — nothing downstream may treat an `unverified` principal as
 * trusted once real verification lands.
 *
 * `can` will, in Phase 1, consult the grants registry and validate the verification proof.
 * Today it allows everything. It already receives the full {@link RequestPrincipal} (with its
 * verification), so the signature never has to change when real policy arrives.
 */

const LOCAL_OWNER: RequestPrincipal = {
  kind: 'owner',
  id: 'local-owner',
  verification: { method: 'unverified' },
};

export function resolvePrincipal(_c: Context): RequestPrincipal {
  return LOCAL_OWNER;
}

export const can: CanCheck = async (_principal, _op, _resource) => {
  // Phase 0: allow. Phase 1: look up grants for (_principal, _resource), check _op ∈ scope,
  // honour constraints, and require an acceptable _principal.verification.method.
  return true;
};
