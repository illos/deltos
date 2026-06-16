import { Hono } from 'hono';
import { z } from 'zod';
import {
  ChallengeRequestSchema,
  RegisterDeviceRequestSchema,
  SessionRequestSchema,
  StepUpRequestSchema,
  base64urlDecodeStrict,
} from '@deltos/shared';
import type { Resource } from '@deltos/shared';
import * as authCrypto from '../authCrypto.js';
import type { Env } from '../env.js';
import { apiError, guard, type AppContext } from '../http.js';
import { resolvePrincipal } from '../auth.js';
import { d1Adapter } from '../db/schema.js';
import { createAuthStore } from '../db/authStore.js';
import { entitlementFor, SESSION_GRANT_RESOURCE, SESSION_TTL_MS, DEVICE_REVOKE_STEP_UP } from '../authPolicy.js';

/**
 * Stream A — identity auth routes (the unauthenticated bootstrap that MINTS request auth).
 *
 * Built against the LOCKED per-route contract (`docs/design/stream-a-auth-contracts.md` §2). Routes
 * own request PARSING + HTTP STATUS only; every crypto decision is delegated to `authCrypto` (devSys)
 * and every storage decision to `authStore` (devSys2). No key handling, signature verification,
 * fingerprint computation, scope clamping, or freshness/single-use logic lives here.
 *
 * THE RULE THAT OVERRIDES EVERYTHING: no request-body field is trusted before its signature verifies.
 * Every verify RECONSTRUCTS the canonical TLV from SERVER-HELD values — the `nonce`/`keyId` returned
 * by the atomic `consumeChallenge`, the configured `audience` (env.AUTH_AUDIENCE, never the Host
 * header), the fixed tag + endpoint-constant `purpose` — plus only the request's INTENT fields.
 * `accountFingerprint` is COMPUTED from the submitted pubkey (F2), never trusted from the body.
 *
 * The challenge/register/session endpoints are deliberately NOT behind `guard()`: they have no
 * principal yet — they are the primitives that PRODUCE the grant a principal is later resolved from.
 * GET /devices and the device-revoke route carry their own auth (a guard, and a fresh F9 step-up).
 */

const auth = new Hono<{ Bindings: Env }>();

const CHALLENGE_TTL_MS = 60_000; // 60s — short freshness window (contract §3 / AUTH-PROP-2).

// Session-grant + device-revoke policy lives in ../authPolicy.ts (single source — devSys 1d0a2e7):
// entitlementFor(device), SESSION_GRANT_RESOURCE, SESSION_TTL_MS, DEVICE_REVOKE_STEP_UP.

/** Read a JSON body without throwing on empty/invalid input — schema validation reports the 400. */
async function readBody(c: AppContext): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

/** The configured signing audience, or a 503 if the deployment is misconfigured (fail-closed). */
function requireAudience(c: AppContext): string | Response {
  const audience = c.env.AUTH_AUDIENCE;
  if (!audience) return apiError(c, 503, 'auth_not_configured', 'AUTH_AUDIENCE is not configured');
  return audience;
}

const UNAUTHORIZED = 'the challenge or signature is invalid, expired, or already used';

// ---------------------------------------------------------------------------
// POST /api/auth/challenge  — { purpose, keyId? } → { challengeId, nonce, expiresAt, expiresAtMs }
// Mints a short-TTL, single-use, server-held challenge. Unauthenticated by design.
// ---------------------------------------------------------------------------
auth.post('/challenge', async (c) => {
  const parsed = ChallengeRequestSchema.safeParse(await readBody(c));
  if (!parsed.success) {
    return apiError(c, 400, 'invalid_request', 'request failed validation', parsed.error.format());
  }
  // Discriminated union: keyId is present (required) on session/step-up, absent on register.
  const keyId = parsed.data.purpose === 'register' ? null : parsed.data.keyId;

  // Anti-enumeration (secSys): a session/step-up challenge issues for ANY keyId — we do NOT look the
  // device up here, so the response is never a device-existence oracle. The session/step-up route
  // fails later (getDevice) if the keyId is unknown.
  // TODO(rate-limit, secSys): cap this unauthenticated row-creator — the TTL bounds row lifetime, not
  // creation rate. Mechanism is scopeSys/devSys2's; flagged so it is not dropped.
  const store = createAuthStore(d1Adapter(c.env.DB));
  const nowMs = Date.now();
  const expiresAtMs = nowMs + CHALLENGE_TTL_MS;
  const challengeId = authCrypto.randomToken(32);
  const nonce = authCrypto.randomToken(32);
  await store.createChallenge({
    challengeId,
    nonce,
    keyId,
    purpose: parsed.data.purpose,
    issuedAt: new Date(nowMs).toISOString(),
    expiresAtMs,
  });
  return c.json({ challengeId, nonce, expiresAt: new Date(expiresAtMs).toISOString(), expiresAtMs });
});

// ---------------------------------------------------------------------------
// POST /api/auth/register  — { challengeId, signingPublicKey, deviceLabel, signature }
//                          → { keyId, accountFingerprint }
// Proof of key control (anti-squat): the submitted pubkey's own key must sign the register-TLV.
// ---------------------------------------------------------------------------
auth.post('/register', async (c) => {
  const parsed = RegisterDeviceRequestSchema.safeParse(await readBody(c));
  if (!parsed.success) {
    return apiError(c, 400, 'invalid_request', 'request failed validation', parsed.error.format());
  }
  const audience = requireAudience(c);
  if (typeof audience !== 'string') return audience;

  const { challengeId, signingPublicKey, deviceLabel, signature } = parsed.data;
  const store = createAuthStore(d1Adapter(c.env.DB));
  const nowMs = Date.now();

  // Single-use + freshness live entirely in the atomic consume (server-held nonce comes back here).
  const consumed = await store.consumeChallenge(challengeId, 'register', nowMs);
  if (!consumed) return apiError(c, 401, 'unauthorized', UNAUTHORIZED);

  const verified = authCrypto.verifyRegister({
    audience,
    challengeId,
    nonce: consumed.nonce, // SERVER-HELD, never the body
    signingPublicKey,
    deviceLabel,
    signature,
  });
  if (!verified) return apiError(c, 401, 'unauthorized', UNAUTHORIZED);

  // F2 — the server COMPUTES the fingerprint from the (signature-proven) pubkey; never trusts a body copy.
  const accountFingerprint = authCrypto.computeFingerprint(base64urlDecodeStrict(signingPublicKey));
  const keyId = authCrypto.randomToken(16);
  await store.registerDevice({
    keyId,
    signingPublicKey,
    // v1: device key == account key (strawman F1). Populate the option-(b)/D5 per-device-key seam
    // column with the verified account key now so Phase-2 can fill it with a real device key
    // non-breakingly; leaving it NULL would lose the seam.
    deviceSigningPublicKey: signingPublicKey,
    accountFingerprint,
    deviceLabel,
    createdAt: new Date(nowMs).toISOString(),
  });
  return c.json({ keyId, accountFingerprint }, 201);
});

// ---------------------------------------------------------------------------
// POST /api/auth/session  — { challengeId, keyId, requestedScope, signature } → { token, expiresAt }
// Signed challenge → opaque grant token (PIN-ID-2). Token stored HASHED (F6); scope CLAMPED (F5).
// ---------------------------------------------------------------------------
auth.post('/session', async (c) => {
  const parsed = SessionRequestSchema.safeParse(await readBody(c));
  if (!parsed.success) {
    return apiError(c, 400, 'invalid_request', 'request failed validation', parsed.error.format());
  }
  const audience = requireAudience(c);
  if (typeof audience !== 'string') return audience;

  const { challengeId, keyId, requestedScope, signature } = parsed.data;
  const store = createAuthStore(d1Adapter(c.env.DB));
  const nowMs = Date.now();

  const consumed = await store.consumeChallenge(challengeId, 'session', nowMs);
  if (!consumed) return apiError(c, 401, 'unauthorized', UNAUTHORIZED);
  // CF-2 / R3-2: the challenge is bound to its keyId. Assert request==stored, then use the
  // SERVER-HELD keyId as the single source for BOTH the TLV and the pubkey resolution.
  if (consumed.keyId === null || consumed.keyId !== keyId) return apiError(c, 401, 'unauthorized', UNAUTHORIZED);
  const serverKeyId = consumed.keyId;

  // CF-1 / PROP-3: the pubkey is the SERVER-RESOLVED device key — never a request/body field.
  const device = await store.getDevice(serverKeyId);
  if (!device || device.revokedAt !== null) return apiError(c, 401, 'unauthorized', UNAUTHORIZED);

  const verified = authCrypto.verifySession({
    audience,
    challengeId,
    nonce: consumed.nonce, // SERVER-HELD
    keyId: serverKeyId, // SERVER-HELD
    requestedScope,
    signature,
    signingPublicKey: device.signingPublicKey, // SERVER-RESOLVED, never the body
  });
  if (!verified) return apiError(c, 401, 'unauthorized', UNAUTHORIZED);

  const granted = authCrypto.clampScope(requestedScope, entitlementFor(device)); // F5 — never verbatim
  const token = authCrypto.randomToken(32);
  const expiresAtMs = nowMs + SESSION_TTL_MS;
  await store.mintGrant({
    grantId: authCrypto.randomToken(16),
    tokenHash: authCrypto.hashToken(token), // F6 — only the hash is stored
    principal: { kind: 'owner', id: device.accountFingerprint },
    mintedByKeyId: serverKeyId, // scopes revokeByKeyId to THIS device's tokens (devSys2)
    resource: SESSION_GRANT_RESOURCE,
    scope: granted,
    expiresAtMs,
    createdAt: new Date(nowMs).toISOString(),
  });
  return c.json({ token, expiresAt: new Date(expiresAtMs).toISOString() }); // raw token leaves the server once
});

// ---------------------------------------------------------------------------
// GET /api/auth/devices  — list the caller's account devices (authStore-backed READ).
// Behind the chokepoint guard: prod tripwire (refuses the dev-only `unverified` stub, F13) +
// can(op:'read'). Lists for the resolved principal's accountFingerprint; once grant-token resolution
// lands in resolvePrincipal this lists the real account with no change here.
// ---------------------------------------------------------------------------
auth.get(
  '/devices',
  guard({
    op: 'read',
    schema: z.object({}).strict(),
    input: () => ({}),
    resource: (): Resource => ({ kind: 'workspace' }),
    handle: async (_req, c) => {
      const principal = await resolvePrincipal(c);
      const store = createAuthStore(d1Adapter(c.env.DB));
      return c.json({ devices: await store.listDevices(principal.id) });
    },
  }),
);

// ---------------------------------------------------------------------------
// POST /api/auth/devices/:keyId/revoke  — revoke a device. F9 SENSITIVE ⇒ a fresh step-up gates it.
// The step-up (signed for op='delete', resource={kind:'workspace'}) proves account possession;
// the :keyId path param is the target. revokeByKeyId sets devices.revokedAt (blocks future mints)
// AND revokes that device's outstanding grants (mintedByKeyId) — immediate deny. Idempotent.
// ---------------------------------------------------------------------------
auth.post('/devices/:keyId/revoke', async (c) => {
  const parsed = StepUpRequestSchema.safeParse(await readBody(c));
  if (!parsed.success) {
    return apiError(c, 400, 'invalid_request', 'request failed validation', parsed.error.format());
  }
  const audience = requireAudience(c);
  if (typeof audience !== 'string') return audience;

  const targetKeyId = c.req.param('keyId');
  const { challengeId, keyId, op, resource, signature } = parsed.data;

  // v1 F9 binding: device-revoke is authorized ONLY by a step-up signed for exactly (delete, workspace).
  // A step-up signed for any other (op, resource) cannot be replayed to revoke a device.
  if (op !== DEVICE_REVOKE_STEP_UP.op || resource.kind !== DEVICE_REVOKE_STEP_UP.resource.kind) {
    return apiError(c, 403, 'forbidden', 'step-up is not authorized for device revocation');
  }

  const store = createAuthStore(d1Adapter(c.env.DB));
  const nowMs = Date.now();

  const consumed = await store.consumeChallenge(challengeId, 'step-up', nowMs);
  if (!consumed) return apiError(c, 401, 'unauthorized', UNAUTHORIZED);
  // CF-2 / R3-2: assert request keyId == server-held, then use the SERVER-HELD keyId as the single source.
  if (consumed.keyId === null || consumed.keyId !== keyId) return apiError(c, 401, 'unauthorized', UNAUTHORIZED);
  const serverKeyId = consumed.keyId;

  // The AUTHENTICATING device proves account possession via its signing key; CF-1: resolve its pubkey
  // server-side from the server-held keyId — never a body field.
  const authDevice = await store.getDevice(serverKeyId);
  if (!authDevice || authDevice.revokedAt !== null) return apiError(c, 401, 'unauthorized', UNAUTHORIZED);

  const verified = authCrypto.verifyStepUp({
    audience,
    challengeId,
    nonce: consumed.nonce, // SERVER-HELD
    keyId: serverKeyId, // SERVER-HELD
    op,
    resource,
    signature,
    signingPublicKey: authDevice.signingPublicKey, // SERVER-RESOLVED
  });
  if (!verified) return apiError(c, 401, 'unauthorized', UNAUTHORIZED);

  // Target must exist — distinguishes an unknown device (404) from an already-revoked one (idempotent 200).
  const target = await store.getDevice(targetKeyId);
  if (!target) return apiError(c, 404, 'not_found', 'no such device');

  await store.revokeByKeyId(targetKeyId);
  return c.json({ keyId: targetKeyId, revoked: true });
});

export { auth };
