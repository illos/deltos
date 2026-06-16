/**
 * Client-side device registration ceremony — used for both brand-new account enrolment and
 * recovery via `enrollExisting(mnemonic)`.
 *
 * Flow (mirrors buildStepUpRequest but for the 'register' purpose):
 *   1. POST /api/auth/challenge  { purpose:'register' }   → ChallengeResponse
 *      (no keyId — the device has no server handle yet before registration)
 *   2. canonicalAuthPayload({ purpose:'register', audience, challengeId, nonce,
 *                             signingPublicKey, deviceLabel })
 *   3. keyStore.sign(payload)   → Ed25519 signature over the TLV bytes
 *   4. return RegisterDeviceRequest { challengeId, signingPublicKey, deviceLabel, signature }
 *
 * The caller is responsible for enrolling the KeyStore FIRST (enrollNew or enrollExisting)
 * and ensuring it is unlocked before calling this function.  The returned request body is
 * then POSTed to /api/auth/register to mint a server keyId and accountFingerprint.
 *
 * Audience (F8): same as the WebAuthn RP ID — location.hostname, bare hostname, no port.
 * Server reconstructs with AUTH_AUDIENCE (the configured deployment hostname); both sides
 * must agree byte-for-byte (PROP-4, confirmed by devSys).
 *
 * AUTH-1 carry-forward: freshness is checked via expiresAtMs (epoch number), never expiresAt.
 */

import {
  base64urlDecodeStrict,
  base64urlEncode,
  canonicalAuthPayload,
  ChallengeResponseSchema,
  RegisterDeviceRequestSchema,
  type RegisterDeviceRequest,
} from '@deltos/shared';
import type { KeyStore } from './keyStore.js';

export interface RegisterParams {
  keyStore: KeyStore;
  deviceLabel: string;
  /** Audience bound into the TLV signature (F8). Defaults to location.hostname. */
  audience?: string;
}

export async function buildRegisterRequest(
  { keyStore, deviceLabel, audience }: RegisterParams,
  fetchFn: typeof fetch = globalThis.fetch,
  nowMs: () => number = () => Date.now(),
): Promise<RegisterDeviceRequest> {
  const aud = audience ?? (typeof location !== 'undefined' ? location.hostname : 'localhost');

  if (!keyStore.isUnlocked()) {
    throw new Error('KeyStore must be unlocked before registering a device');
  }

  // Signing public key is needed before building the canonical payload — read it now.
  const signingPublicKey = keyStore.getSigningPublicKey();

  // ── 1. Fetch a single-use 'register' challenge (no keyId — device has no handle yet) ─────────
  const resp = await fetchFn('/api/auth/challenge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ purpose: 'register' }),
  });

  if (!resp.ok) {
    throw new Error(`register challenge fetch failed: ${resp.status} ${resp.statusText}`);
  }

  const challengeResp = ChallengeResponseSchema.parse(await resp.json());

  // AUTH-1: freshness via expiresAtMs; expiresAt is display-only, never compared.
  if (nowMs() >= challengeResp.expiresAtMs) {
    throw new Error('register challenge already expired — retry to obtain a fresh challenge');
  }

  // ── 2. Decode nonce; sign over raw bytes, not the base64url encoding ────────────────────────
  const nonce = base64urlDecodeStrict(challengeResp.nonce);

  // ── 3. Build the canonical register TLV ─────────────────────────────────────────────────────
  const payload = canonicalAuthPayload({
    purpose: 'register',
    audience: aud,
    challengeId: challengeResp.challengeId,
    nonce,
    signingPublicKey,
    deviceLabel,
  });

  // ── 4. Sign ─────────────────────────────────────────────────────────────────────────────────
  const sig = await keyStore.sign(payload);

  // ── 5. Assemble the wire request ─────────────────────────────────────────────────────────────
  return RegisterDeviceRequestSchema.parse({
    challengeId: challengeResp.challengeId,
    signingPublicKey: base64urlEncode(signingPublicKey),
    deviceLabel,
    signature: base64urlEncode(sig),
  });
}
