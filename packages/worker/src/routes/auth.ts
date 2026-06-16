import { Hono } from 'hono';
import { z } from 'zod';
import {
  ChallengeRequestSchema,
  RegisterDeviceRequestSchema,
  SessionRequestSchema,
  StepUpRequestSchema,
} from '@deltos/shared';
import type { Resource } from '@deltos/shared';
import type { Env } from '../env.js';
import { apiError, guard, notImplemented, type AppContext } from '../http.js';
import { resolvePrincipal } from '../auth.js';
import { d1Adapter } from '../db/schema.js';
import { createAuthStore } from '../db/authStore.js';

/**
 * Stream A — identity auth routes (the unauthenticated bootstrap that MINTS request auth).
 *
 * SKELETON: routing surface + step-ordered orchestration is wired against the LOCKED per-route
 * contract (`docs/design/stream-a-auth-contracts.md` §2, committed by devSys at e3ebd75). Handler
 * bodies return `notImplemented` (501) until their two hard dependencies land, at which point each
 * step below becomes a delegated call and the 501 is removed:
 *   - devSys  `authCrypto` (Ed25519 verify, F2 fingerprint COMPUTE, TLV reconstruct, RNG, token
 *             hashing, scope clamp) + `requests.ts` Zod wire schemas (strict base64url + exact
 *             lengths — R3-4) + `canonical.ts` (TLV). CONFIRMED by devSys: `authCrypto` is
 *             WORKER-LOCAL → `import * as authCrypto from '../authCrypto.js'` (packages/worker/src/
 *             authCrypto.ts). The request schemas are re-exported from `@deltos/shared` (via
 *             auth/index.ts) → `import { ChallengeRequestSchema, RegisterDeviceRequestSchema,
 *             SessionRequestSchema, StepUpRequestSchema } from '@deltos/shared'`. (canonical/requests
 *             landing now; authCrypto next.)
 *   - devSys2 `authStore` (pure-D1 over the 0002_stream-a-auth migration: devices / authChallenges /
 *             grants). CONFIRMED by devSys2: `import { createAuthStore } from '../db/authStore.js'`,
 *             constructed `const store = createAuthStore(d1Adapter(c.env.DB))` (same DbAdapter as
 *             db/mutate.ts). Methods = contract §1 EXACTLY, PLUS `revokeByKeyId(keyId)` for the
 *             revoke route (signature pending devSys's ruling — see /devices/:keyId/revoke).
 *
 * SEAM DISCIPLINE (contract §2): routes own request PARSING + HTTP STATUS only. Every crypto and
 * policy decision is DELEGATED — no key handling, signature verification, fingerprint computation,
 * scope clamping, or freshness/single-use logic lives here.
 *
 * THE RULE THAT OVERRIDES EVERYTHING (contract): no request-body field is trusted before its
 * signature verifies. The server RECONSTRUCTS every TLV from SERVER-HELD values (stored
 * `nonce`/`keyId`/`purpose`, configured `audience`, fixed `tag`) plus the genuinely
 * request-supplied INTENT fields only. `nonce`/`keyId`/`purpose`/`audience` are never read from the
 * body; `accountFingerprint` is COMPUTED (F2), never trusted.
 *
 * These routes are deliberately NOT behind `guard()`: `guard` resolves a principal and runs
 * `can()`, but the bootstrap endpoints have no principal yet — they are the primitives that PRODUCE
 * the grant token a principal is later resolved from. The device-management routes (§ devices) are
 * the exception and carry their own auth, noted inline.
 */

const auth = new Hono<{ Bindings: Env }>();

/** Read a JSON body without throwing on empty/invalid input — schema validation reports the 400. */
async function readBody(c: AppContext): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// POST /api/auth/challenge  — { keyId?, purpose } → { challengeId, nonce, expiresAt, expiresAtMs }
// Unauthenticated row-creator. Mints a short-TTL, single-use, server-held challenge.
// ---------------------------------------------------------------------------
auth.post('/challenge', async (c) => {
  // SLICE (a) LIVE — boundary validation (R3-4). Crypto tail awaits authCrypto.
  const parsed = ChallengeRequestSchema.safeParse(await readBody(c));
  if (!parsed.success) {
    return apiError(c, 400, 'invalid_request', 'request failed validation', parsed.error.format());
  }
  // Cross-field rule (contract §2 step 1): a non-register challenge must name the keyId it is for.
  // (Field-presence only — the UNKNOWN-keyId anti-enumeration response is the crypto/store tail,
  // which needs a device lookup.)
  if (parsed.data.purpose !== 'register' && parsed.data.keyId === undefined) {
    return apiError(c, 400, 'invalid_request', "keyId is required unless purpose is 'register'");
  }
  // FLIP (authCrypto) — contract §2 /challenge:
  // 1. UNKNOWN keyId → still return a constant-shape challenge (NEVER a device-enumeration oracle —
  //    issue regardless; do not branch the response on device existence). [secSys note]
  // 2. challengeId = authCrypto.randomToken(32); nonce = authCrypto.randomToken(32);
  //    expiresAtMs = serverNowMs() + 60_000 (SERVER clock; no client time ever enters);
  //    await store.createChallenge({ challengeId, nonce, keyId: parsed.data.keyId ?? null,
  //                                  purpose: parsed.data.purpose, issuedAt: nowIso, expiresAtMs });
  //    return c.json({ challengeId, nonce, expiresAt: nowIso(+60s), expiresAtMs });
  // 3. RATE-LIMIT + CAP this unauthenticated creator — the TTL bounds row lifetime, NOT creation
  //    rate. [secSys note — mechanism TBD with devSys2; flagged so it is not dropped]
  return notImplemented(c, 'auth.challenge');
});

// ---------------------------------------------------------------------------
// POST /api/auth/register  — RegisterDeviceRequest { challengeId, signingPublicKey, deviceLabel,
//                            signature } → { keyId, accountFingerprint }
// Proof of key control (anti-squat): the submitted pubkey's own key must sign the register-TLV.
// ---------------------------------------------------------------------------
auth.post('/register', async (c) => {
  // SLICE (a) LIVE — boundary validation: 32B pubkey / 64B sig / ≥32B challengeId, strict base64url
  // (R3-4). Consume/verify/register tail awaits authCrypto.
  const parsed = RegisterDeviceRequestSchema.safeParse(await readBody(c));
  if (!parsed.success) {
    return apiError(c, 400, 'invalid_request', 'request failed validation', parsed.error.format());
  }
  // FLIP (authCrypto + authStore) — contract §2 /register:
  // 2. c = await store.consumeChallenge(challengeId, 'register', serverNowMs());
  //    null → 401 (freshness + single-use are IN the consume — no separate expiry check).
  // 3. authCrypto.verifyRegister({ challengeId, nonce: c.nonce, signingPublicKey, deviceLabel,
  //    signature }) — reconstructs the register-TLV from SERVER-HELD nonce + configured audience +
  //    fixed tag + purpose='register' + the INTENT fields signingPublicKey/deviceLabel; verifies
  //    against the SUBMITTED pubkey. Fail → 401.
  // 4. accountFingerprint = authCrypto.computeFingerprint(signingPublicKey)  (F2 — server COMPUTES;
  //    a client-sent fingerprint is never trusted).
  // 5. keyId = authCrypto.randomToken(16);
  //    await authStore.registerDevice({ keyId, signingPublicKey, accountFingerprint, deviceLabel,
  //                                     createdAt: nowIso });
  //    return c.json({ keyId, accountFingerprint });
  return notImplemented(c, 'auth.register');
});

// ---------------------------------------------------------------------------
// POST /api/auth/session  — SessionRequest { challengeId, keyId, requestedScope, signature }
//                          → { token, expiresAt }   (raw token returned ONCE)
// Signed challenge → opaque grant token (PIN-ID-2). Token stored HASHED (F6); scope CLAMPED (F5).
// ---------------------------------------------------------------------------
auth.post('/session', async (c) => {
  // SLICE (a) LIVE — boundary validation (R3-4): challengeId/signature/keyId + non-empty
  // requestedScope. Consume/verify/clamp/mint tail awaits authCrypto.
  const parsed = SessionRequestSchema.safeParse(await readBody(c));
  if (!parsed.success) {
    return apiError(c, 400, 'invalid_request', 'request failed validation', parsed.error.format());
  }
  // FLIP (authCrypto + authStore) — contract §2 /session:
  // 1. c = await store.consumeChallenge(challengeId, 'session', serverNowMs()); null → 401.
  //    ASSERT c.keyId === request.keyId (R3-2: challenge is bound to its keyId) else 401.
  // 2. d = await authStore.getDevice(keyId); missing or d.revokedAt != null → 401.
  // 3. authCrypto.verifySession({ challengeId, nonce: c.nonce, keyId: c.keyId, requestedScope,
  //    signature, signingPublicKey: d.signingPublicKey }) — reconstruct from SERVER-HELD nonce/keyId
  //    (stored, not body) + audience + tag + purpose='session'; the ONLY signed request-supplied
  //    field is requestedScope; verify against the SERVER-RESOLVED pubkey. Fail → 401.
  // 4. granted = authCrypto.clampScope(requestedScope, entitlementFor(d))  (F5 — never verbatim).
  // 5. token = authCrypto.randomToken(32);
  //    await store.mintGrant({ grantId: authCrypto.randomToken(16),
  //      tokenHash: authCrypto.hashToken(token),
  //      principal: { kind: 'owner', id: d.accountFingerprint }, resource, scope: granted,
  //      mintedByKeyId: keyId,   // ← devSys2: scopes revokeByKeyId(keyId) to THIS device's tokens
  //      expiresAtMs, createdAt: nowIso });
  //    return c.json({ token, expiresAt });   // raw token leaves the server exactly once
  return notImplemented(c, 'auth.session');
});

// ---------------------------------------------------------------------------
// GET /api/auth/devices  — list the caller's account devices.
// SLICE (c) LIVE — authStore-backed READ behind the standard chokepoint: guard runs the prod
// tripwire (refuses the dev-only `unverified` stub in production, F13) + can(op:'read'), then the
// handler lists for the resolved principal's accountFingerprint. Until devSys's grant-token
// resolution lands in resolvePrincipal the principal is the dev stub (id 'local-owner'), so in a
// non-prod env this returns the (empty) device set for that id; once grant-token principals resolve
// it lists the real account devices with no further change here.
// ---------------------------------------------------------------------------
auth.get(
  '/devices',
  guard({
    op: 'read',
    schema: z.object({}).strict(),
    input: () => ({}),
    resource: (): Resource => ({ kind: 'workspace' }),
    handle: async (_req, c) => {
      const principal = resolvePrincipal(c);
      const store = createAuthStore(d1Adapter(c.env.DB));
      return c.json({ devices: await store.listDevices(principal.id) });
    },
  }),
);

// ---------------------------------------------------------------------------
// POST /api/auth/devices/:keyId/revoke  — revoke a device (F9 SENSITIVE ⇒ step-up required).
// PATH CONFIRMED (devSys): RESTful POST /api/auth/devices/:keyId/revoke. keyId→grant gap RESOLVED —
// `grants` gains a `mintedByKeyId` column (devSys2, folded into 0002) and `authStore.revokeByKeyId(keyId)`
// (a) sets `devices.revokedAt` (blocks future mints) AND (b) `UPDATE grants SET revokedAt WHERE
// mintedByKeyId=keyId AND revokedAt IS NULL` (immediate deny — resolvePrincipal row-resolves every
// request). It is `Promise<void>` and IDEMPOTENT (already-revoked stays revoked, no error — devSys2).
// F9 STEP-UP binding (v1): the step-up signature must be for `op='delete'`,
// `resource={kind:'workspace'}` (account-level destructive op); the `:keyId` path param selects the
// target device. Tighter per-device-resource binding is a tracked follow-up, not v1.
// ---------------------------------------------------------------------------
auth.post('/devices/:keyId/revoke', async (c) => {
  // SLICE (a) LIVE — boundary validation (R3-4): step-up proof shape. verify/revoke tail awaits authCrypto.
  const parsed = StepUpRequestSchema.safeParse(await readBody(c));
  if (!parsed.success) {
    return apiError(c, 400, 'invalid_request', 'request failed validation', parsed.error.format());
  }
  // FLIP (authCrypto + authStore) — contract §2 /devices (revoke), F9 step-up seam:
  // 2. verified = authCrypto.verifyStepUp({ challengeId, keyId, op, resource, signature }) — consumes
  //    the 'step-up' challenge, reconstructs+verifies the step-up TLV against the server-resolved
  //    pubkey; returns { method:'signed-request', keyId, challengeId, op, resource } or throws → 401.
  //    Assert the v1 binding: op === 'delete' && resource is { kind:'workspace' } (else 403); can()
  //    then asserts member.op===op && resourceEquals(member.resource, resource) (LOCKED switch).
  // 3. const store = createAuthStore(d1Adapter(c.env.DB));
  //    if (!(await store.getDevice(keyId))) → 404 (unknown device; distinguishes from already-revoked).
  //    await store.revokeByKeyId(keyId);   // void + idempotent (already-revoked → still 200)
  // 4. return c.json({ keyId, revoked: true });   // boolean, NOT a revoked-grant count: idempotent +
  //    no session-count info-leak (devSys2 ruling).
  if (!c.req.param('keyId')) return apiError(c, 400, 'invalid_request', 'missing device keyId');
  return notImplemented(c, 'auth.devices.revoke');
});

export { auth };
