import { SCOPES, type Resource, type Scope } from '@deltos/shared';
import { DEFAULT_ARGON2_PARAMS, type Argon2Params } from './passwordCrypto.js';

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

// ── Password-auth policy (the 2026-06-17 pivot) ─────────────────────────────────────────────────────

/**
 * Access-token lifetime — SHORT (15 min). The pivot decouples durability from the access token: the
 * httpOnly refresh cookie re-mints a fresh access token on cold boot / expiry, so the access bearer can
 * be short-lived (smaller theft window) without re-prompting the user. Supersedes the 30-day session TTL
 * for the password path (signed-challenge sessions keep SESSION_TTL_MS).
 */
export const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;

/** Durable refresh-session window (60d sliding) — the cold-boot ungated-reload horizon. */
export const REFRESH_TTL_MS = 60 * 24 * 60 * 60 * 1000;

/** The httpOnly refresh cookie: name + the Path it is scoped to (the refresh endpoint only). */
export const REFRESH_COOKIE_NAME = 'deltos_rt';
export const REFRESH_COOKIE_PATH = '/api/auth/refresh';

/** otpauth issuer label shown in authenticator apps. */
export const TOTP_ISSUER = 'deltos';

/**
 * Argon2id params used to hash NEW passwords/phrases. AP-M1 (the one build dependency) measures the
 * real-CF-Workers CPU/memory cost and TUNES these to budget via the ladder (rung 1 = step these down on
 * pure-JS `@noble`, free; WASM only as a logged dep exception). The algorithm is fixed. A login under
 * stale params auto-rehashes to whatever this is (rehash-on-login).
 *
 * READY TOGGLE — AP-M1 ladder rung-1 step-down (DO NOT enable without a secSys nod). The full-strength
 * default is ~290ms CPU/hash on real workerd, which sits at the Workers FREE-plan CPU edge. For free-plan
 * MARGIN, swap to one of these measured-on-workerd alternatives (each ~halves the CPU, stays at/above the
 * OWASP interactive floor); irrelevant if the account moves to Workers Paid (full params + limits.cpu_ms):
 *   { m: 19456, t: 1, p: 1 } // ~152ms (half the time cost)
 *   { m: 12288, t: 2, p: 1 } // ~189ms (lower memory)
 *   { m: 9216,  t: 2, p: 1 } // ~139ms (lower memory)
 */
export const ARGON2_PARAMS: Argon2Params = DEFAULT_ARGON2_PARAMS; // {19456,2,1} — full strength, ~290ms

/**
 * Per-account exponential backoff — the cheap GATE that runs BEFORE Argon2id (AP-4, the CPU-amplification
 * DoS + brute-force defense). NO hard lockout (a hard lockout is a victim-DoS): backoff grows then CAPS.
 * The first few failures are free (legit fat-finger), then each failure pushes the next-allowed instant
 * out exponentially. `reset` is gated AT LEAST as hard as `login` (a phrase guess = full takeover, AP-15)
 * — fewer free attempts, same cap reached sooner.
 */
export interface BackoffPolicy {
  /** Failures allowed with no delay before backoff engages. */
  freeAttempts: number;
  /** Base delay (ms) once backoff engages. */
  baseMs: number;
  /** Maximum delay (ms) — backoff never exceeds this (no permanent lockout). */
  capMs: number;
}

export const LOGIN_BACKOFF: BackoffPolicy = { freeAttempts: 5, baseMs: 1000, capMs: 5 * 60 * 1000 };
export const RESET_BACKOFF: BackoffPolicy = { freeAttempts: 2, baseMs: 2000, capMs: 15 * 60 * 1000 };

/**
 * The next-allowed delay (ms from the failing instant) after `failures` total failures under a policy.
 * Returns 0 while within the free-attempt budget, else `min(cap, base * 2^(failures-free-1))`.
 */
export function backoffDelayMs(policy: BackoffPolicy, failures: number): number {
  if (failures <= policy.freeAttempts) return 0;
  const exp = failures - policy.freeAttempts - 1;
  return Math.min(policy.capMs, policy.baseMs * 2 ** exp);
}
