/**
 * v1 at-rest custody posture — Option-A (user-affirmed 2026-06-16; pilot + secSys ruled it a
 * BUILD/LAUNCH CONSTANT, never a per-user setting).
 *
 * `true` = device-local-for-ALL devices: the at-rest wrapping key is a random device-local key
 * (lock-screen-grade), so the signing key can be unwrapped SILENTLY with no gesture. This is what
 * delivers the north star — *"Auth is for syncing between devices and signing in on a new device.
 * Day-to-day cannot be locked behind a password. This is a Notes app, not a password manager."* —
 * i.e. ZERO day-to-day friction; gestures only at sync-trust / new-device-onboarding boundaries.
 *
 * Why a CONSTANT, not a client-persisted toggle (secSys): a client-writable custody flag is a
 * tamper / inconsistency surface — it could flip custody silently or diverge across a user's devices.
 * This constant is non-client-writable and matches the v1 default. The PRF custody path is kept
 * DORMANT behind it (secSys condition #6): flip to `false` to re-enable PRF-first wrapping for v2
 * E2EE — a one-line lever, with the PRF seam in `webAuthnKeyStore` retained, not deleted.
 */
export const OPTION_A_DEVICE_LOCAL = true;
