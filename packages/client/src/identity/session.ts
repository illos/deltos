/**
 * Client-side session-mint ceremony — the third and final piece of the client auth trio:
 *   register.ts   (device registration — no prior keyId)
 *   session.ts    (THIS — mints a bearer session token with a declared scope)
 *   stepUp.ts     (per-operation sensitive-op proof)
 *
 * Flow:
 *   1. POST /api/auth/challenge  { purpose:'session', keyId }   → ChallengeResponse
 *      (keyId required — the device is already registered; the challenge is keyId-bound so
 *      the server can assert challenge.keyId === request.keyId at consume time)
 *   2. canonicalAuthPayload({ purpose:'session', audience, challengeId, nonce, keyId,
 *                             requestedScope })
 *      Scope set is SORTED BY ENUM ORDER and DE-DUPLICATED in canonical.ts so {read,write}
 *      and {write,read} produce byte-identical payloads (R3-3 scope canonicalisation).
 *   3. keyStore.sign(payload)  → Ed25519 signature over the TLV bytes
 *   4. return SessionRequest { challengeId, keyId, requestedScope, signature }
 *
 * The caller holds the keyId (obtained at registration or from persistent client storage).
 * The KeyStore must be unlocked before calling. The returned request body is then POSTed to
 * /api/auth/session to receive a scoped bearer token.
 *
 * Audience (PROP-4): location.hostname, bare, no port — matches the WebAuthn RP ID and the
 * server's configured AUTH_AUDIENCE (confirmed devSys e64dc9e).
 *
 * AUTH-1 carry-forward: freshness is checked via expiresAtMs (epoch number), never expiresAt.
 */

import {
  base64urlDecodeStrict,
  base64urlEncode,
  canonicalAuthPayload,
  ChallengeResponseSchema,
  SessionRequestSchema,
  type Scope,
  type SessionRequest,
} from '@deltos/shared';
import type { KeyStore } from './keyStore.js';

export interface SessionParams {
  keyStore: KeyStore;
  keyId: string;
  requestedScope: readonly Scope[];
  /** Audience bound into the TLV signature (PROP-4). Defaults to location.hostname. */
  audience?: string;
}

export async function buildSessionRequest(
  { keyStore, keyId, requestedScope, audience }: SessionParams,
  fetchFn: typeof fetch = globalThis.fetch,
  nowMs: () => number = () => Date.now(),
): Promise<SessionRequest> {
  const aud = audience ?? (typeof location !== 'undefined' ? location.hostname : 'localhost');

  if (!keyStore.isUnlocked()) {
    throw new Error('KeyStore must be unlocked before minting a session');
  }

  // ── 1. Fetch a single-use 'session' challenge (keyId bound at mint) ──────────────────────────
  const resp = await fetchFn('/api/auth/challenge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ purpose: 'session', keyId }),
  });

  if (!resp.ok) {
    throw new Error(`session challenge fetch failed: ${resp.status} ${resp.statusText}`);
  }

  const challengeResp = ChallengeResponseSchema.parse(await resp.json());

  // AUTH-1: freshness via expiresAtMs; expiresAt is display-only, never compared.
  if (nowMs() >= challengeResp.expiresAtMs) {
    throw new Error('session challenge already expired — retry to obtain a fresh challenge');
  }

  // ── 2. Decode nonce; sign over raw bytes, not the base64url encoding ─────────────────────────
  const nonce = base64urlDecodeStrict(challengeResp.nonce);

  // ── 3. Build the canonical session TLV ──────────────────────────────────────────────────────
  // The scope set is sorted and de-duplicated inside canonicalAuthPayload (R3-3), so the caller
  // need not pre-sort — {read,write} and {write,read} produce identical bytes.
  const payload = canonicalAuthPayload({
    purpose: 'session',
    audience: aud,
    challengeId: challengeResp.challengeId,
    nonce,
    keyId,
    requestedScope,
  });

  // ── 4. Sign ──────────────────────────────────────────────────────────────────────────────────
  const sig = await keyStore.sign(payload);

  // ── 5. Assemble the wire request ─────────────────────────────────────────────────────────────
  return SessionRequestSchema.parse({
    challengeId: challengeResp.challengeId,
    keyId,
    requestedScope: Array.from(requestedScope),
    signature: base64urlEncode(sig),
  });
}
