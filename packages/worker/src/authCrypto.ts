import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes, randomBytes } from '@noble/hashes/utils.js';
import { base64urlEncode } from '@deltos/shared';

/**
 * The worker's reused auth-token primitives. After the 2026-06-17 password pivot the signed-challenge
 * verify layer (Ed25519 register/session/step-up verification, the F2 fingerprint, `clampScope`) was
 * DELETED with `routes/auth.ts` and `@deltos/shared`'s canonical-TLV / signed-request schemas. What
 * remains is credential-INDEPENDENT and reused by the password handlers + the chokepoint:
 *   - `hashToken` — the F6 at-rest hash for grant + refresh tokens (the raw token is never stored).
 *   - `randomToken` — CSPRNG opaque ids / tokens.
 */

/** `base64url(SHA-256(token))` — the at-rest grant/refresh-token hash (F6). The raw token is never stored. */
export function hashToken(token: string): string {
  return base64urlEncode(sha256(utf8ToBytes(token)));
}

/** A high-entropy opaque token / id as base64url of `byteLen` CSPRNG bytes (≥32 for session tokens). */
export function randomToken(byteLen: number): string {
  return base64urlEncode(randomBytes(byteLen));
}
