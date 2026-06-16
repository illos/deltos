/**
 * Client-side step-up ceremony — orchestrates the signed-challenge flow for F9-sensitive ops.
 *
 * Flow:
 *   1. POST /api/auth/challenge  { purpose:'step-up', keyId }  → ChallengeResponse
 *   2. canonicalAuthPayload({ purpose:'step-up', audience, challengeId, nonce, keyId, op, resource })
 *   3. keyStore.sign(payload)   — Ed25519 over the TLV bytes; the KeyStore owns the private key
 *   4. return StepUpRequest     { challengeId, signature, keyId, op, resource }
 *
 * The caller passes the returned StepUpRequest as the body (or merged into the body) of the
 * endpoint that requires step-up.  No separate /auth/step-up exchange — the proof is embedded
 * in the sensitive-operation request so the signature binds exactly one (op, resource, challenge).
 *
 * Audience (F8 / AUTH-3): the audience string is bound into every signature.  The server
 * reconstructs with its own configured audience; the client uses location.hostname (the same value
 * as the WebAuthn RP ID).  Pass `audience` explicitly when the default is wrong (e.g. tests).
 *
 * KeyStore must be UNLOCKED before calling — the function rejects fast if it is not.
 *
 * `fetchFn` defaults to globalThis.fetch; inject a mock in unit tests.
 */

import {
  base64urlDecodeStrict,
  base64urlEncode,
  canonicalAuthPayload,
  ChallengeResponseSchema,
  StepUpRequestSchema,
  type ChallengeRequest,
  type StepUpRequest,
} from '@deltos/shared';
import type { Op, Resource } from '@deltos/shared';
import type { KeyStore } from './keyStore.js';

export interface StepUpParams {
  keyStore: KeyStore;
  keyId: string;
  op: Op;
  resource: Resource;
  /** Audience bound into the TLV signature (F8). Defaults to location.hostname. */
  audience?: string;
}

export async function buildStepUpRequest(
  { keyStore, keyId, op, resource, audience }: StepUpParams,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<StepUpRequest> {
  const aud = audience ?? (typeof location !== 'undefined' ? location.hostname : 'localhost');

  if (!keyStore.isUnlocked()) {
    throw new Error('KeyStore must be unlocked before building a step-up request');
  }

  // ── 1. Fetch a single-use challenge ────────────────────────────────────────────────────────────
  const challengeReq: ChallengeRequest = { purpose: 'step-up', keyId };
  const resp = await fetchFn('/api/auth/challenge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(challengeReq),
  });

  if (!resp.ok) {
    throw new Error(`step-up challenge fetch failed: ${resp.status} ${resp.statusText}`);
  }

  const challengeResp = ChallengeResponseSchema.parse(await resp.json());

  // ── 2. Decode nonce to bytes (signs over raw entropy, not the base64url form) ─────────────────
  const nonce = base64urlDecodeStrict(challengeResp.nonce);

  // ── 3. Build the canonical TLV payload ─────────────────────────────────────────────────────────
  const payload = canonicalAuthPayload({
    purpose: 'step-up',
    audience: aud,
    challengeId: challengeResp.challengeId,
    nonce,
    keyId,
    op,
    resource,
  });

  // ── 4. Sign — KeyStore owns the Ed25519 private key; payload bytes are opaque to the UI ────────
  const sig = await keyStore.sign(payload);

  // ── 5. Assemble the wire request (strict parse catches any accidental encoding error) ──────────
  return StepUpRequestSchema.parse({
    challengeId: challengeResp.challengeId,
    signature: base64urlEncode(sig),
    keyId,
    op,
    resource,
  });
}
