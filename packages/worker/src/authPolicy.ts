import { SCOPES, type Resource, type Scope } from '@deltos/shared';

/**
 * Auth POLICY — the small set of mint-time decisions devSys owns and the session/sensitive routes
 * consume (kept out of the chokepoint `auth.ts` and the pure crypto `authCrypto.ts`). Lifting these
 * out of the route's inlined constants gives one place to tune entitlement, lifetime, and the
 * sensitive-op set as the model grows.
 */

/**
 * The scopes a device principal acting for its OWN account may be granted at session mint. v1: a
 * device under its own account gets the FULL account scope on its own resources — the upper bound the
 * F5 clamp intersects `requestedScope` against (`clampScope(requestedScope, entitlementFor(device))`).
 * The `device` arg is the option-(b) seam: per-device entitlement narrowing slots in here later
 * without touching the route or the clamp.
 */
export function entitlementFor(_device: { accountFingerprint: string }): Scope[] {
  return [...SCOPES];
}

/** A v1 session grant targets the whole workspace (account-level); finer grants come from capabilities. */
export const SESSION_GRANT_RESOURCE: Resource = { kind: 'workspace' };

/**
 * Session grant-token lifetime — 30 days (secSys-confirming). A long lifetime is acceptable under the
 * registry-resolved model precisely because revocation is IMMEDIATE: every request re-resolves the
 * grant row, so `revokeByKeyId` denies on the next request with no validity window to wait out.
 */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The F9 sensitive-op step-up binding for device revocation (v1): a `POST /api/auth/devices/:keyId/
 * revoke` requires a fresh step-up signed for this (op, resource). The `:keyId` path param selects the
 * target device; a tighter per-device resource binding is a tracked follow-up.
 */
export const DEVICE_REVOKE_STEP_UP = { op: 'delete', resource: { kind: 'workspace' } as Resource } as const;
