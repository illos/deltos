import { Hono } from 'hono';
import type { Env } from '../env.js';
import { apiError, notImplemented, type AppContext } from '../http.js';

/**
 * Stream A — identity auth routes (the unauthenticated bootstrap that MINTS request auth).
 *
 * SKELETON: routing surface + step-ordered orchestration is wired against the LOCKED per-route
 * contract (`docs/design/stream-a-auth-contracts.md` §2, committed by devSys at e3ebd75). Handler
 * bodies return `notImplemented` (501) until their two hard dependencies land, at which point each
 * step below becomes a delegated call and the 501 is removed:
 *   - devSys  `authCrypto` (Ed25519 verify, F2 fingerprint COMPUTE, TLV reconstruct, RNG, token
 *             hashing, scope clamp) + `requests.ts` Zod wire schemas (strict base64url + exact
 *             lengths — R3-4) + `canonical.ts` (TLV). [specifier TBD — confirm import at flip]
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
  await readBody(c);
  // FLIP — contract §2 /challenge:
  // 1. Parse with ChallengeRequestSchema (requests.ts). If `purpose !== 'register'`, `keyId` is
  //    required. UNKNOWN keyId → still return a constant-shape challenge (NEVER a device-enumeration
  //    oracle — issue regardless; do not branch the response on device existence). [secSys note]
  // 2. challengeId = authCrypto.randomToken(32); nonce = authCrypto.randomToken(32);
  //    expiresAtMs = serverNowMs() + 60_000 (SERVER clock; no client time ever enters);
  //    await authStore.createChallenge({ challengeId, nonce, keyId: keyId ?? null, purpose,
  //                                      issuedAt: nowIso, expiresAtMs });
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
  await readBody(c);
  // FLIP — contract §2 /register:
  // 1. Parse with RegisterDeviceRequestSchema (requests.ts — enforces 32B pubkey / 64B sig / ≥32B
  //    fields at the boundary, R3-4).
  // 2. c = await authStore.consumeChallenge(challengeId, 'register', serverNowMs());
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
  await readBody(c);
  // FLIP — contract §2 /session:
  // 1. c = await authStore.consumeChallenge(challengeId, 'session', serverNowMs()); null → 401.
  //    ASSERT c.keyId === request.keyId (R3-2: challenge is bound to its keyId) else 401.
  // 2. d = await authStore.getDevice(keyId); missing or d.revokedAt != null → 401.
  // 3. authCrypto.verifySession({ challengeId, nonce: c.nonce, keyId: c.keyId, requestedScope,
  //    signature, signingPublicKey: d.signingPublicKey }) — reconstruct from SERVER-HELD nonce/keyId
  //    (stored, not body) + audience + tag + purpose='session'; the ONLY signed request-supplied
  //    field is requestedScope; verify against the SERVER-RESOLVED pubkey. Fail → 401.
  // 4. granted = authCrypto.clampScope(requestedScope, entitlementFor(d))  (F5 — never verbatim).
  // 5. token = authCrypto.randomToken(32);
  //    await authStore.mintGrant({ grantId: authCrypto.randomToken(16),
  //      tokenHash: authCrypto.hashToken(token),
  //      principal: { kind: 'owner', id: d.accountFingerprint }, resource, scope: granted,
  //      expiresAtMs, createdAt: nowIso });
  //    return c.json({ token, expiresAt });   // raw token leaves the server exactly once
  return notImplemented(c, 'auth.session');
});

// ---------------------------------------------------------------------------
// GET /api/auth/devices  — list the caller's account devices.
// Authenticated READ: at flip this is wrapped in guard({ op: 'read', resource: <account/workspace>,
// … }) once resolvePrincipal resolves a grant-token principal; the handler then lists for the
// resolved principal's accountFingerprint. Kept as a plain 501 until grant-token resolution is live
// so the skeleton never returns a misleading allow/deny.
// ---------------------------------------------------------------------------
auth.get('/devices', async (c) => {
  // FLIP — contract §2 /devices (GET):
  //   const principal = resolvePrincipal(c);   // grant-token → { kind:'owner', id: accountFingerprint }
  //   return c.json({ devices: await authStore.listDevices(principal.id) });
  return notImplemented(c, 'auth.devices.list');
});

// ---------------------------------------------------------------------------
// POST /api/auth/devices/:keyId/revoke  — revoke a device (F9 SENSITIVE ⇒ step-up required).
// PATH CONFIRMED (devSys, via pilot): RESTful POST /api/auth/devices/:keyId/revoke stands. The
// keyId→grant resolution gap is resolved by devSys2 adding `authStore.revokeByKeyId(keyId)` — exact
// semantics (grants revoked + whether devices.revokedAt is set) pending devSys's ruling; devSys2
// confirms the signature when it lands. Revoking a device must (a) verify a fresh step-up bound to
// this op+resource and (b) call revokeByKeyId for the target device.
// ---------------------------------------------------------------------------
auth.post('/devices/:keyId/revoke', async (c) => {
  await readBody(c);
  // FLIP — contract §2 /devices (revoke), F9 step-up seam:
  // 1. Parse the StepUpRequest fields with requests.ts (R3-4 strict validation).
  // 2. verified = authCrypto.verifyStepUp({ challengeId, keyId, op, resource, signature }) — consumes
  //    the 'step-up' challenge, reconstructs+verifies the step-up TLV against the server-resolved
  //    pubkey; returns { method:'signed-request', keyId, challengeId, op, resource } or throws → 401.
  //    can() then asserts member.op===op && resourceEquals(member.resource, resource) (LOCKED switch).
  // 3. await store.revokeByKeyId(c.req.param('keyId'))  (devSys2 — resolves the keyId→grant gap;
  //    exact semantics pending devSys's ruling).
  // 4. return c.json({ keyId, revoked: true });
  if (!c.req.param('keyId')) return apiError(c, 400, 'invalid_request', 'missing device keyId');
  return notImplemented(c, 'auth.devices.revoke');
});

export { auth };
