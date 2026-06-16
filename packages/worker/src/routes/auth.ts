import { Hono } from 'hono';
import { z } from 'zod';
import {
  ChallengeRequestSchema,
  RegisterDeviceRequestSchema,
  SessionRequestSchema,
  StepUpRequestSchema,
  UsernameClaimRequestSchema,
  normalizeUsername,
  USERNAME_MIN_LENGTH,
  USERNAME_MAX_LENGTH,
  base64urlDecodeStrict,
} from '@deltos/shared';
import type { Resource, UsernameRejectReason } from '@deltos/shared';
import * as authCrypto from '../authCrypto.js';
import type { Env } from '../env.js';
import { apiError, guard, type AppContext } from '../http.js';
import type { AppEnv } from '../context.js';
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

const auth = new Hono<AppEnv>();

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

  // ENROLL into an ACCOUNT (D6 account-identity). Bind this credential (the fingerprint) to an account:
  //  - first time we see this fingerprint → enrollNew: mint a fresh, random, credential-INDEPENDENT
  //    `accountId` and bind the credential to it. accountId is the data-ownership key — server-assigned,
  //    IMMUTABLE, never client-supplied. It is NOT the fingerprint, so the account survives an auth-method
  //    change with no data migration.
  //  - fingerprint already bound → the SAME account re-enrolling a device (recovery / QR-join with the
  //    same signing key, PIN-ID-3): reuse its accountId, do NOT re-bind (bind-once / append-only).
  // (Binding a *different* credential to an existing account — add/replace auth method — is the Phase-2
  // flow gated on account-possession proof; this enrollNew path mints/reuses for the SAME credential only.)
  const existingAccountId = await store.resolveAccountIdByFingerprint(accountFingerprint);
  if (!existingAccountId) {
    const isoNow = new Date(nowMs).toISOString();
    const accountId = authCrypto.randomToken(16); // server-generated random >=16B (secSys S4)
    await store.createAccount({ accountId, createdAt: isoNow });
    await store.bindCredential({ accountFingerprint, accountId, credentialType: 'signing-key-v1', addedAt: isoNow });
  }

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

  // RE-POINT (D6): key the grant on the account, not the credential. Resolve the device's
  // accountFingerprint → accountId SERVER-SIDE (never a body field); stamp `principal.id = accountId`.
  // The minting device is still recorded via `mintedByKeyId`, so per-device revoke (PIN-ID-5) + the F2
  // credential binding are untouched — only the principal's IDENTITY moves from fingerprint to account.
  const accountId = await store.resolveAccountIdByFingerprint(device.accountFingerprint);
  if (!accountId) return apiError(c, 401, 'unauthorized', UNAUTHORIZED); // credential not bound to an account

  const granted = authCrypto.clampScope(requestedScope, entitlementFor(device)); // F5 — never verbatim
  const token = authCrypto.randomToken(32);
  const expiresAtMs = nowMs + SESSION_TTL_MS;
  await store.mintGrant({
    grantId: authCrypto.randomToken(16),
    tokenHash: authCrypto.hashToken(token), // F6 — only the hash is stored
    principal: { kind: 'owner', id: accountId }, // principalId = accountId (re-point), NOT the fingerprint
    mintedByKeyId: serverKeyId, // scopes revokeByKeyId to THIS device's tokens (devSys2)
    resource: SESSION_GRANT_RESOURCE,
    scope: granted,
    expiresAtMs,
    createdAt: new Date(nowMs).toISOString(),
  });
  return c.json({ token, expiresAt: new Date(expiresAtMs).toISOString() }); // raw token leaves the server once
});

// A username reject reason → a stable, user-helpful 400 message. The charset/length hints HELP the
// caller and reveal nothing about the account namespace (no holder identity, no taken/free signal —
// that lives ONLY in the authenticated claim below, F-acct-4). `reserved` is a flat message, not a
// reserved-vs-confusable distinction.
function usernameRejectMessage(reason: UsernameRejectReason): string {
  switch (reason) {
    case 'empty':
      return 'username is required';
    case 'too-short':
      return `username must be at least ${USERNAME_MIN_LENGTH} characters`;
    case 'too-long':
      return `username must be at most ${USERNAME_MAX_LENGTH} characters`;
    case 'charset':
      return 'username may use only a-z, 0-9, underscore and hyphen';
    case 'leading':
      return 'username must start with a letter or digit';
    case 'control':
      return 'username contains invalid characters';
    case 'reserved':
      return 'that username is not available';
    default: {
      const _exhaustive: never = reason;
      return 'invalid username';
    }
  }
}

// ---------------------------------------------------------------------------
// POST /api/auth/username  — claim a unique DIRECTORY alias for the caller's ACCOUNT (D6).
//
// DIRECTORY layer: username → accountId. Behind guard() so it is AUTHENTICATED-CLAIM-ONLY (F-acct-4):
// there is deliberately NO standalone availability endpoint / existence oracle — "taken" is revealed
// ONLY inside this authenticated claim (409). INVARIANT (i): the alias binds to the AUTHENTICATED
// `principal.id` (= accountId, the re-point), NEVER a body field — the `.strict` schema rejects a body
// accountId and we read `principal.id` server-side. The username is a LABEL, never an authenticator:
// nothing here keys authorization on it; a re-claimed name inherits nothing (everything resolves via
// accountId). Atomic-unique claim lives in the store (INSERT-or-fail, no check-then-insert TOCTOU).
// ---------------------------------------------------------------------------
auth.post(
  '/username',
  guard({
    op: 'create',
    schema: UsernameClaimRequestSchema,
    input: (c) => readBody(c),
    resource: (): Resource => ({ kind: 'workspace' }),
    handle: async (req, c, principal) => {
      // ONE normalization rule — the SHARED `normalizeUsername` (NFKC + casefold + conservative charset
      // + reserved denylist). The client hints with the same function, so "taken" can never diverge.
      // INVARIANT (i), fail-closed: ONLY an account-bearing principal may claim. For owner/device the
      // re-pointed `principal.id` IS the accountId; for capability/guest/agent/plugin it is a
      // capability/agent id, NOT an account — binding a directory alias to one would corrupt the
      // namespace. The chokepoint already authorizes the op; this pins the claim to an actual account.
      if (principal.kind !== 'owner' && principal.kind !== 'device') {
        return apiError(c, 403, 'forbidden', 'only an account may claim a username');
      }

      const norm = normalizeUsername(req.username);
      if (!norm.ok) return apiError(c, 400, 'invalid_username', usernameRejectMessage(norm.reason));

      const accountId = principal.id; // = accountId; the ONLY account a claim can bind to (invariant i).
      const store = createAuthStore(d1Adapter(c.env.DB));

      // v1: one username per account (rename OFF). A same-account re-claim of the SAME name is
      // idempotent (200); a different existing name → 409. This is an account-vs-ITSELF check, never a
      // cross-account security boundary — that boundary is the store's atomic-unique claim below.
      const existing = await store.getUsernameByAccount(accountId);
      if (existing) {
        if (existing.usernameNormalized === norm.value.normalized) {
          return c.json({ username: existing.usernameDisplay });
        }
        return apiError(c, 409, 'username_exists', 'this account already has a username');
      }

      const result = await store.claimUsername({
        usernameNormalized: norm.value.normalized,
        accountId,
        usernameDisplay: norm.value.display,
        createdAt: new Date(Date.now()).toISOString(),
      });
      if (!result.claimed) {
        // The store's atomic claim lost. If WE already hold it (a racing duplicate of our own first
        // claim), that is idempotent success; otherwise another account holds it → 409. F-acct-4: the
        // 409 carries NO holder identity, so it is not a cross-account existence oracle.
        if (result.ownerAccountId === accountId) return c.json({ username: norm.value.display });
        return apiError(c, 409, 'username_taken', 'that username is taken');
      }
      return c.json({ username: norm.value.display }, 201);
    },
  }),
);

// ---------------------------------------------------------------------------
// GET /api/auth/devices  — list the caller's account devices (authStore-backed READ).
// Behind the chokepoint guard: prod tripwire (refuses the dev-only `unverified` stub, F13) +
// can(op:'read'). guard() supplies the resolved principal (3rd arg); principal.id = accountId
// (the re-point), so we list by ACCOUNT — across all the account's credentials, NOT by a fingerprint.
// ---------------------------------------------------------------------------
auth.get(
  '/devices',
  guard({
    op: 'read',
    schema: z.object({}).strict(),
    input: () => ({}),
    resource: (): Resource => ({ kind: 'workspace' }),
    handle: async (_req, c, principal) => {
      const store = createAuthStore(d1Adapter(c.env.DB));
      // principal.id = accountId (NOT accountFingerprint). listDevicesByAccount joins via accountCredentials.
      return c.json({ devices: await store.listDevicesByAccount(principal.id) });
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

  // v1 F9 binding: device-revoke is authorized ONLY by a step-up signed for exactly (delete,
  // workspace). A step-up signed for any other (op, resource) cannot be replayed to revoke a device.
  // (Direct-gate is cryptographically sound for v1 — secSys-cleared. Routing this through can()'s
  // signed-request branch is a tracked devSys follow-up; that branch stays unused in v1.)
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

  // BOLA guard: the target must EXIST and belong to the AUTHENTICATING account. Without this, any
  // account holder with a valid step-up for THEIR account could revoke ANY device of ANY account
  // (cross-tenant DoS). 404 — not 403 — so a cross-account keyId is indistinguishable from a
  // non-existent one (no cross-account existence oracle); collapses with the unknown-target case.
  const target = await store.getDevice(targetKeyId);
  if (!target || target.accountFingerprint !== authDevice.accountFingerprint) {
    return apiError(c, 404, 'not_found', 'no such device');
  }

  await store.revokeByKeyId(targetKeyId);
  return c.json({ keyId: targetKeyId, revoked: true });
});

export { auth };
