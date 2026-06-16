import * as ed from '@noble/ed25519';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { utf8ToBytes, randomBytes } from '@noble/hashes/utils.js';
import {
  base64urlEncode,
  base64urlDecodeStrict,
  canonicalAuthPayload,
  SCOPES,
  type Scope,
  type Op,
  type Resource,
} from '@deltos/shared';

/**
 * The worker's auth crypto primitives — the security-critical half of the chokepoint. The server
 * NEVER signs (the signing key lives only on the device); it VERIFIES, COMPUTES the F2 fingerprint,
 * hashes tokens at rest (F6), and mints randomness. Every verify RECONSTRUCTS the canonical TLV from
 * server-held values + the request's intent fields (via `@deltos/shared`'s `canonicalAuthPayload`)
 * and checks the signature over it — no request-supplied payload blob is ever trusted.
 *
 * `@noble/ed25519` v3 ships no hash to stay zero-dependency, so wire its SHA-512 once (mirrors the
 * client's `keyDerivation.ts`). Using noble for verify — not WebCrypto raw-public import — is secSys's
 * Rev-3 call: noble's strict branch rejects non-canonical S and small-order points, and verifying with
 * the SAME library the client signs with removes any cross-implementation agreement risk.
 */
if (!ed.hashes.sha512) ed.hashes.sha512 = sha512;

/** RFC8032 strict branch (`zip215: false`) — reject non-canonical S / small-order points (secSys Rev-3). */
const VERIFY_OPTS = { zip215: false } as const;

/**
 * `base64url(SHA-256(signingPublicKey))` — the F2 `accountFingerprint`, byte-identical to the client's
 * `Identity.id` (PROP-3 cross-boundary invariant). The input MUST be the raw 32-byte Ed25519 public
 * key. A frozen vector pins this against the client derivation in the tests.
 */
export function computeFingerprint(signingPublicKey: Uint8Array): string {
  return base64urlEncode(sha256(signingPublicKey));
}

/** `base64url(SHA-256(token))` — the at-rest grant-token hash (F6). The raw token is never stored. */
export function hashToken(token: string): string {
  return base64urlEncode(sha256(utf8ToBytes(token)));
}

/** A high-entropy opaque token / id as base64url of `byteLen` CSPRNG bytes (≥32 for tokens + nonces). */
export function randomToken(byteLen: number): string {
  return base64urlEncode(randomBytes(byteLen));
}

/**
 * F5 — clamp a client `requestedScope` to what the principal is actually entitled to. Returns the
 * intersection in canonical {@link SCOPES} order, de-duplicated; never the client's request verbatim.
 */
export function clampScope(requestedScope: readonly Scope[], entitlement: readonly Scope[]): Scope[] {
  const requested = new Set(requestedScope);
  const allowed = new Set(entitlement);
  return SCOPES.filter((s) => requested.has(s) && allowed.has(s));
}

/** Verify `signature` over `message` under `publicKey`; any malformed input fails CLOSED (false). */
function verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  try {
    return ed.verify(signature, message, publicKey, VERIFY_OPTS);
  } catch {
    return false;
  }
}

/** Decode the three base64url binary fields a verify needs; null if any is malformed (fail closed). */
function decodeProof(
  nonce: string,
  signingPublicKey: string,
  signature: string,
): { nonce: Uint8Array; publicKey: Uint8Array; signature: Uint8Array } | null {
  try {
    return {
      nonce: base64urlDecodeStrict(nonce),
      publicKey: base64urlDecodeStrict(signingPublicKey),
      signature: base64urlDecodeStrict(signature),
    };
  } catch {
    return null;
  }
}

/**
 * Verify a registration proof. The signature is checked against the SUBMITTED public key — proof the
 * registrant controls the private key for the key being registered (anti-squat). `nonce`/`audience`
 * are server-held; only `signingPublicKey`/`deviceLabel` are request-supplied (and signature-authenticated).
 */
export function verifyRegister(a: {
  audience: string;
  challengeId: string;
  nonce: string;
  signingPublicKey: string;
  deviceLabel: string;
  signature: string;
}): boolean {
  const p = decodeProof(a.nonce, a.signingPublicKey, a.signature);
  if (!p) return false;
  const message = canonicalAuthPayload({
    purpose: 'register',
    audience: a.audience,
    challengeId: a.challengeId,
    nonce: p.nonce,
    signingPublicKey: p.publicKey,
    deviceLabel: a.deviceLabel,
  });
  return verify(p.signature, message, p.publicKey);
}

/**
 * Verify a session-mint proof against the SERVER-RESOLVED device public key (never one from the body).
 * `nonce`/`keyId`/`audience` are server-held; the only signed request-supplied field is `requestedScope`.
 */
export function verifySession(a: {
  audience: string;
  challengeId: string;
  nonce: string;
  keyId: string;
  requestedScope: readonly Scope[];
  signature: string;
  signingPublicKey: string;
}): boolean {
  const p = decodeProof(a.nonce, a.signingPublicKey, a.signature);
  if (!p) return false;
  const message = canonicalAuthPayload({
    purpose: 'session',
    audience: a.audience,
    challengeId: a.challengeId,
    nonce: p.nonce,
    keyId: a.keyId,
    requestedScope: a.requestedScope,
  });
  return verify(p.signature, message, p.publicKey);
}

/** The verified facts a step-up yields — exactly what flows onto the `signed-request` principal. */
export interface StepUpVerified {
  keyId: string;
  challengeId: string;
  op: Op;
  resource: Resource;
}

/**
 * Verify an F9 step-up proof; returns the verified `(keyId, challengeId, op, resource)` on success or
 * null. `can()` then asserts `op`/`resource` against its own chokepoint arguments — the step-up is
 * bound to exactly the request it was signed for.
 */
export function verifyStepUp(a: {
  audience: string;
  challengeId: string;
  nonce: string;
  keyId: string;
  op: Op;
  resource: Resource;
  signature: string;
  signingPublicKey: string;
}): StepUpVerified | null {
  const p = decodeProof(a.nonce, a.signingPublicKey, a.signature);
  if (!p) return null;
  const message = canonicalAuthPayload({
    purpose: 'step-up',
    audience: a.audience,
    challengeId: a.challengeId,
    nonce: p.nonce,
    keyId: a.keyId,
    op: a.op,
    resource: a.resource,
  });
  return verify(p.signature, message, p.publicKey)
    ? { keyId: a.keyId, challengeId: a.challengeId, op: a.op, resource: a.resource }
    : null;
}
