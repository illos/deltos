import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import {
  RegisterRequestSchema,
  LoginRequestSchema,
  LogoutRequestSchema,
  PasswordResetRequestSchema,
  TotpSetupRequestSchema,
  TotpVerifyRequestSchema,
  TotpDisableRequestSchema,
  FinalizeRequestSchema,
  RecoveryRotateRequestSchema,
  normalizeUsername,
  SCOPES,
  type Resource,
} from '@deltos/shared';
import * as authCrypto from '../authCrypto.js';
import {
  hashPassword,
  verifyPassword,
  dummyHash,
  generateRecoveryPhrase,
  hashRecoveryPhrase,
  verifyRecoveryPhrase,
  dummyRecoveryHash,
  isPhc,
  UNESTABLISHED_VERIFIER,
} from '../passwordCrypto.js';
import {
  generateSecret,
  secretToBase32,
  otpauthUri,
  verifyTotp,
  encryptSecret,
  decryptSecret,
} from '../totp.js';
import {
  ACCESS_TOKEN_TTL_MS,
  REFRESH_TTL_MS,
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_PATH,
  ARGON2_PARAMS,
  LOGIN_BACKOFF,
  RESET_BACKOFF,
  TOTP_ISSUER,
  backoffDelayMs,
  type BackoffPolicy,
} from '../authPolicy.js';
import { apiError, guard, NON_PROD_ENVIRONMENTS, type AppContext } from '../http.js';
import type { AppEnv } from '../context.js';
import { d1Adapter } from '../db/schema.js';
import { createAuthStore, type AuthStore } from '../db/authStore.js';
import { deviceLabelFromUA } from '../deviceLabel.js';
import { audit } from '../audit.js';

/**
 * Password-auth routes — the 2026-06-17 pivot (`docs/specs/auth-pivot-password.md`). Username +
 * password primary, optional TOTP 2FA, recovery phrase = forgot-password reset. The D6 account/authz
 * spine (accountId / grant token / `can()` / `guard()` / `username` atomic-unique claim) is REUSED
 * WHOLESALE — this layer only swaps the *credential*. The data layer never sees a password.
 *
 * PATHS: mounted under `/api/auth` alongside the (still-live, being-retired) signed-challenge routes in
 * `auth.ts`. Collision-free names (`signup`/`login`/`refresh`/`logout`/`reset`/`totp/*`) so the pivot
 * lands ADDITIVELY and green; the signed-challenge deletion is a coordinated cutover once the client
 * lane cuts over (pilot orchestrates). `signup` (not `register`) avoids the one path that collides.
 *
 * SECURITY MODEL ([[auth-pivot-security-model]], secSys-reviewed):
 *  - Durable session = an httpOnly+Secure+SameSite=Strict refresh cookie (Path=/api/auth/refresh) →
 *    a short-TTL in-memory access token. Refresh is STATEFUL + server-HASHED (not a JWT): rotation-on-
 *    use, reuse-detection (revoke the family), revoke-all on the four credential-change events.
 *  - GATE-BEFORE-HASH on the unauthenticated login/reset endpoints: the cheap per-account exponential
 *    backoff runs BEFORE Argon2id, and the hash is UNIFORM real-or-dummy so there is no CPU-amplification
 *    DoS and no account-existence timing oracle. Turnstile is a FAILURE-TRIGGERED escalation layered on
 *    that same per-key bucket: a clean FIRST attempt is never challenged; the widget is demanded only once
 *    the bucket has recorded a failure (and only when TURNSTILE_SECRET is configured). A success clears the
 *    bucket, so the next attempt is unchallenged again.
 *  - Anti-enumeration: signup DISCLOSES "taken" (usability); login is UNIFORM; reset is NON-DISCLOSING.
 */

const passwordAuth = new Hono<AppEnv>();

const UNIFORM_LOGIN_ERROR = 'wrong username or password';
const UNIFORM_RESET_ERROR = 'reset could not be completed';


const iso = (ms: number) => new Date(ms).toISOString();
const store = (c: AppContext): AuthStore => createAuthStore(d1Adapter(c.env.DB));

/** Read a JSON body without throwing — schema validation reports the 400. */
async function readBody(c: AppContext): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

/** A required Worker secret, or a fail-CLOSED 503. Keeps the password/TOTP paths off a misconfigured deploy. */
function requireSecret(c: AppContext, name: 'AUTH_PEPPER' | 'TOTP_ENC_KEY'): string | Response {
  const value = c.env[name];
  if (!value) return apiError(c, 503, 'auth_not_configured', `${name} is not configured`);
  return value;
}

/** Best-effort client IP for the per-IP abuse bucket. */
function clientIp(c: AppContext): string {
  return c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? 'unknown';
}

/**
 * CSRF belt (AP-11): the cookie-bearing mutations (refresh / logout) require the request `Origin`, when
 * present, to match the deployment host (`AUTH_AUDIENCE`). SameSite=Strict is the primary defense; this
 * is the suspenders. A missing Origin is allowed (same-origin navigations may omit it); the access path
 * stays CSRF-immune via the custom `Authorization` header.
 */
function originAllowed(c: AppContext): boolean {
  const origin = c.req.header('Origin');
  if (!origin) return true;
  const expected = c.env.AUTH_AUDIENCE;
  if (!expected) return false; // fail-closed: a cookie mutation with a cross-origin claim on a misconfigured deploy
  try {
    const url = new URL(origin);
    if (url.hostname !== expected) return false;
    // Defense-in-depth (#40): in prod a cookie mutation must arrive over https, so a same-host
    // http:// Origin (downgraded / misconfigured proxy hop) can't satisfy the belt. Relaxed in the
    // named non-prod environments where local dev servers run over http — same fail-closed
    // allowlist as the `secure` cookie flag below.
    if (url.protocol !== 'https:' && !NON_PROD_ENVIRONMENTS.has(c.env.ENVIRONMENT ?? '')) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * The cheap GATE — runs BEFORE any Argon2id (AP-4). FAILURE-TRIGGERED Turnstile, then the per-key
 * exponential backoff, off a SINGLE throttle fetch. Returns null when allowed, or the rejection Response.
 *
 * Turnstile is a per-bucket escalation, NOT an always-on tax: it is required only when TURNSTILE_SECRET is
 * configured AND this bucket has already recorded a failure (`failures > 0`). So a clean FIRST attempt is
 * never challenged; a missing token when one IS required is a distinct 403 `challenge_required` (tells the
 * client to render the widget and retry); a present-but-bad token is 403 `challenge_failed`. When NOT
 * required the supplied token is ignored entirely (no siteverify round-trip). login/reset clear the bucket
 * on success, so a solved-then-succeeded attempt is unchallenged next time. Recording the bucket for ANY
 * attempt (existing account or not) keeps it from being an existence oracle.
 */
async function gate(
  c: AppContext,
  s: AuthStore,
  bucket: string,
  turnstileToken: string | undefined,
  nowMs: number,
): Promise<Response | null> {
  const throttle = await s.getThrottle(bucket);
  if (c.env.TURNSTILE_SECRET && (throttle?.failures ?? 0) > 0) {
    if (!turnstileToken) return apiError(c, 403, 'challenge_required', 'anti-abuse challenge required');
    const ok = await verifyTurnstile(c.env.TURNSTILE_SECRET, turnstileToken, clientIp(c));
    if (!ok) return apiError(c, 403, 'challenge_failed', 'anti-abuse challenge failed');
  }
  if (throttle && nowMs < throttle.nextAllowedMs) {
    return apiError(c, 429, 'too_many_attempts', 'too many attempts — try again shortly');
  }
  return null;
}

/** Record one failed attempt under a backoff policy (advances the next-allowed instant). */
async function recordFailure(
  s: AuthStore,
  bucket: string,
  policy: BackoffPolicy,
  nowMs: number,
): Promise<void> {
  const prior = (await s.getThrottle(bucket))?.failures ?? 0;
  const failures = prior + 1;
  await s.recordThrottleFailure(bucket, failures, nowMs + backoffDelayMs(policy, failures), iso(nowMs));
}

/** Verify a Cloudflare Turnstile token via siteverify. Only called when TURNSTILE_SECRET is configured. */
async function verifyTurnstile(secret: string, token: string | undefined, ip: string): Promise<boolean> {
  if (!token) return false;
  try {
    const body = new FormData();
    body.append('secret', secret);
    body.append('response', token);
    body.append('remoteip', ip);
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body,
    });
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch {
    return false; // fail-closed on a siteverify outage
  }
}

/**
 * Mint a short-TTL in-memory access token (the reused opaque grant; stored HASHED, F6). `familyId` links
 * this access grant to the refresh SESSION family that minted it (Phase 2, migration 0014) so that
 * revoking that session ALSO kills this access token immediately — not only after the access-token TTL.
 */
async function mintAccessToken(
  s: AuthStore,
  accountId: string,
  familyId: string,
  nowMs: number,
): Promise<{ token: string; expiresAt: string }> {
  const token = authCrypto.randomToken(32);
  const expiresAtMs = nowMs + ACCESS_TOKEN_TTL_MS;
  await s.mintGrant({
    grantId: authCrypto.randomToken(16),
    tokenHash: authCrypto.hashToken(token), // F6 — only the hash is stored
    principal: { kind: 'owner', id: accountId }, // principal.id = accountId (the D6 re-point)
    mintedByKeyId: null, // password sessions are not device-key-scoped
    resource: { kind: 'workspace' },
    scope: [...SCOPES], // v1 account session = full workspace scope (clamped by can() per request)
    expiresAtMs,
    familyId, // Phase 2: the session this access token belongs to (revoke the session → revoke this grant)
    createdAt: iso(nowMs),
  });
  return { token, expiresAt: iso(expiresAtMs) };
}

/**
 * Issue a refresh token into `familyId` and Set-Cookie it (httpOnly+Secure+SameSite=Strict, Path-scoped
 * to the refresh endpoint, Max-Age = the durable window). Only the token HASH is persisted.
 */
async function issueRefresh(
  c: AppContext,
  s: AuthStore,
  accountId: string,
  familyId: string,
  label: string | null,
  nowMs: number,
): Promise<void> {
  const refreshToken = authCrypto.randomToken(32);
  await s.insertRefreshSession({
    tokenHash: authCrypto.hashToken(refreshToken),
    familyId,
    accountId,
    issuedAtMs: nowMs,
    expiresAtMs: nowMs + REFRESH_TTL_MS,
    // Phase 2: a fresh-device login passes deviceLabelFromUA(UA); a rotation carries the family's existing
    // label forward (uniform across a family) so "Active sessions" keeps the original device's name.
    label,
  });
  setRefreshCookie(c, refreshToken);
}

/** Set the durable refresh cookie (httpOnly+Secure+SameSite=Strict, Path-scoped to /refresh). */
function setRefreshCookie(c: AppContext, refreshToken: string): void {
  setCookie(c, REFRESH_COOKIE_NAME, refreshToken, {
    httpOnly: true,
    // `secure` only in production: local dev servers run over HTTP so the browser would silently
    // discard a `secure` cookie, making the durable-session flow unworkable in local smoke tests.
    // SameSite=Strict + the CSRF Origin belt are the real CSRF defenses; `secure` adds nothing
    // on a localhost-only dev server where there's no network eavesdropper.
    secure: NON_PROD_ENVIRONMENTS.has(c.env.ENVIRONMENT ?? '') ? false : true,
    sameSite: 'Strict',
    path: REFRESH_COOKIE_PATH,
    maxAge: Math.floor(REFRESH_TTL_MS / 1000),
  });
}

/** Clear the refresh cookie (must use the same Path it was set with so the browser matches it). */
function clearRefreshCookie(c: AppContext): void {
  deleteCookie(c, REFRESH_COOKIE_NAME, { path: REFRESH_COOKIE_PATH });
}

/**
 * Revoke-all (the four credential-change events). Kills every refresh family AND every outstanding
 * access grant for the account, so neither a durable cookie nor a stolen in-memory token survives.
 */
async function revokeAll(s: AuthStore, accountId: string, nowMs: number): Promise<void> {
  const at = iso(nowMs);
  await s.revokeAllRefreshForAccount(accountId, at);
  await s.revokeGrantsByAccount(accountId, at);
}

/**
 * After a 2FA credential-change: `revokeAll` above has just killed EVERY session + grant (so other
 * devices must re-authenticate — the security intent). Immediately re-mint a FRESH session for the
 * ACTING device so a Settings-screen toggle doesn't sign the user out of the device they're using
 * (the new grant + refresh family are created AFTER the revoke, so they survive it). The fresh access
 * token rides the response body; the durable refresh cookie is re-issued ONLY for a finalized account
 * (cookie-at-finalize / P0 suspenders — a pre-finalize session keeps an in-memory token only). secSys
 * #53: this is "revoke-others-+-reissue" — confirmed by pilot, reviewed as built code.
 */
async function reissueActingSession(
  c: AppContext,
  s: AuthStore,
  accountId: string,
  recoveryEstablished: boolean,
  nowMs: number,
): Promise<{ token: string; expiresAt: string }> {
  // Fresh family for the acting device (the credential-change revoke-all just killed the prior one).
  const familyId = authCrypto.randomToken(16);
  const access = await mintAccessToken(s, accountId, familyId, nowMs);
  if (recoveryEstablished) {
    await issueRefresh(c, s, accountId, familyId, deviceLabelFromUA(c.req.header('user-agent')), nowMs);
  } else {
    clearRefreshCookie(c); // defensive: a pre-finalize account has no durable cookie to keep
  }
  return access;
}

// ---------------------------------------------------------------------------
// POST /api/auth/signup  — { username, password, turnstileToken? }
//   → create account + claim username (atomic-unique) + password/recovery verifiers + session + cookie,
//     returning the recovery phrase EXACTLY ONCE. Register DISCLOSES "taken" (AP-1d); IP-gated.
// ---------------------------------------------------------------------------
passwordAuth.post('/signup', async (c) => {
  const parsed = RegisterRequestSchema.safeParse(await readBody(c));
  if (!parsed.success) {
    return apiError(c, 400, 'invalid_request', 'request failed validation', parsed.error.format());
  }
  const pepper = requireSecret(c, 'AUTH_PEPPER');
  if (typeof pepper !== 'string') return pepper;

  const norm = normalizeUsername(parsed.data.username);
  if (!norm.ok) return apiError(c, 400, 'invalid_username', 'that username is not allowed');

  const s = store(c);
  const nowMs = Date.now();

  // GATE before any Argon2id work (signup also hashes → CPU-amplification surface). Per-IP bucket.
  const gated = await gate(c, s, `signup:${clientIp(c)}`, parsed.data.turnstileToken, nowMs);
  if (gated) return gated;

  // Claim the username BEFORE hashing (cheap, atomic) so a taken name costs no Argon2id work.
  const accountId = authCrypto.randomToken(16); // server-random, immutable data-ownership key (D6, S4)
  await s.createAccount({ accountId, createdAt: iso(nowMs) });
  const claim = await s.claimUsername({
    usernameNormalized: norm.value.normalized,
    accountId,
    usernameDisplay: norm.value.display,
    createdAt: iso(nowMs),
  });
  if (claim.status !== 'claimed') {
    // Taken (or, defensively, a racing duplicate). DISCLOSE "taken" — the accepted L1 relax of F-acct-4,
    // mitigated by the IP gate + Turnstile. Reap the account row created moments ago inline so no
    // unreachable orphan accumulates (secSys hygiene; the delete is guarded to credential-less rows).
    await s.deleteOrphanAccount(accountId);
    await recordFailure(s, `signup:${clientIp(c)}`, LOGIN_BACKOFF, nowMs);
    return apiError(c, 409, 'username_taken', 'that username is taken');
  }

  // SINGLE Argon2id (password only) — the free-plan CPU ceiling can't afford a second hash. The recovery
  // verifier is established by the SEPARATE /recovery/rotate step (which mints the phrase + its Argon2id
  // verifier); here recoveryPhc is a non-PHC SENTINEL that fails CLOSED (parsePhc → null → verify false)
  // until rotate replaces it, so /reset against an un-established account can never succeed.
  await s.createPasswordCredential({
    accountId,
    passwordPhc: hashPassword(parsed.data.password, pepper, ARGON2_PARAMS),
    recoveryPhc: UNESTABLISHED_VERIFIER,
    createdAt: iso(nowMs),
  });

  // #58: NO default notebook is created. A new account starts with zero notebooks; its notes are
  // uncategorized (notebookId = null) and surface in the synthetic "All Notes" view the client composes.
  // Retiring the stored default makes a duplicate-default structurally impossible.

  // P0 SUSPENDERS (spec §P0): NO durable refresh cookie here. Signup returns only the IN-MEMORY access
  // token (carries the in-session register→rotate→show-phrase→ack flow). The cross-boot durable cookie is
  // set at FINALIZE, after the user save-acks the phrase — so a registration abandoned before the ack
  // never silently re-auths on next boot. `recoveryEstablished` stays false until finalize.
  // Phase 2: link the (in-memory, pre-finalize) access grant to a fresh family id. No refresh session
  // exists yet (the durable family is created at /finalize), so this family is currently session-less —
  // the access token simply expires on its TTL. It carries a familyId only so the grant is uniformly
  // shaped; it is never listed as an active session until a refresh session backs a family.
  const access = await mintAccessToken(s, accountId, authCrypto.randomToken(16), nowMs);
  return c.json(
    {
      accountId,
      username: norm.value.display,
      token: access.token,
      expiresAt: access.expiresAt,
    },
    201,
  );
});

// ---------------------------------------------------------------------------
// POST /api/auth/login  — { username, password, totp?, turnstileToken? }
//   → verify Argon2id (+TOTP if enabled) → access token + Set-Cookie refresh. UNIFORM 401 on any failure.
// ---------------------------------------------------------------------------
passwordAuth.post('/login', async (c) => {
  const parsed = LoginRequestSchema.safeParse(await readBody(c));
  if (!parsed.success) {
    return apiError(c, 400, 'invalid_request', 'request failed validation', parsed.error.format());
  }
  const pepper = requireSecret(c, 'AUTH_PEPPER');
  if (typeof pepper !== 'string') return pepper;

  const s = store(c);
  const nowMs = Date.now();
  const norm = normalizeUsername(parsed.data.username);
  // Bucket on the normalized name when valid, else the raw lowercased input — either way the attempt is
  // throttled regardless of whether the account exists (no oracle).
  const key = norm.ok ? norm.value.normalized : parsed.data.username.toLowerCase();
  const bucket = `login:${key}`;

  // GATE before the hash (AP-4). A throttled request is rejected WITHOUT reaching Argon2id.
  const gated = await gate(c, s, bucket, parsed.data.turnstileToken, nowMs);
  if (gated) return gated;

  const fail = async (auditAccountId: string | null): Promise<Response> => {
    await recordFailure(s, bucket, LOGIN_BACKOFF, nowMs);
    // P3 audit: a failed login (unknown user OR wrong password) — a brute-force / spray signal. accountId
    // is recorded only when the username resolved (wrong-password); empty for an unknown user. The 401
    // body stays UNIFORM (no oracle) — the audit log is internal, never an enumeration surface.
    await audit(c, {
      surface: 'auth',
      action: 'login',
      result: 'deny',
      principalKind: 'anonymous',
      accountId: auditAccountId ?? '',
      credentialRef: null,
      detail: 'invalid-credentials',
    });
    return apiError(c, 401, 'invalid_credentials', UNIFORM_LOGIN_ERROR);
  };

  const accountId = norm.ok ? await s.resolveAccountIdByUsername(norm.value.normalized) : null;
  const credential = accountId ? await s.getCredentialByAccount(accountId) : null;

  // UNIFORM real-or-DUMMY hash (AP-5): an unknown user still burns the same Argon2id work — NO early
  // return — so response timing never leaks account existence.
  if (!accountId || !credential) {
    dummyHash(parsed.data.password, pepper, ARGON2_PARAMS);
    return fail(accountId);
  }

  const verdict = verifyPassword(parsed.data.password, credential.passwordPhc, pepper, ARGON2_PARAMS);
  if (!verdict.ok) return fail(accountId);

  // Second factor (only if enabled). The PASSWORD IS ALREADY VERIFIED at this point, so signalling
  // "2FA required / invalid" leaks nothing about username existence — an unauthenticated attacker still
  // hits the uniform fail() above on any wrong username/password (anti-enumeration intact). Emitting a
  // DISTINCT signal here is the standard, REQUIRED 2FA handshake: without it the client cannot know to
  // prompt for the code, so a correct-password login on a 2FA-enabled account reads as "wrong password"
  // and the account is locked out (the P0). The client (auth/store.ts login) already maps these codes.
  if (credential.totpEnabled) {
    const encKey = requireSecret(c, 'TOTP_ENC_KEY');
    if (typeof encKey !== 'string') return encKey;
    if (!parsed.data.totp || !credential.totpSecretEnc) {
      // No code supplied yet → ask for it. NOT a failed attempt (the first factor passed): do not record
      // a backoff failure and do not clear the throttle — the user re-submits with password + code.
      return apiError(c, 401, 'totp_required', 'a two-factor code is required');
    }
    const secret = await decryptSecret(credential.totpSecretEnc, encKey);
    const totp = verifyTotp(secret, parsed.data.totp, nowMs, credential.totpLastStep);
    if (!totp.ok) {
      // Wrong code → a real second-factor failure; record it (brute-force protection on the 6-digit code).
      await recordFailure(s, bucket, LOGIN_BACKOFF, nowMs);
      await audit(c, {
        surface: 'auth',
        action: 'login',
        result: 'deny',
        principalKind: 'anonymous',
        accountId,
        credentialRef: null,
        detail: 'totp-invalid',
      });
      return apiError(c, 401, 'totp_invalid', 'that two-factor code is not valid');
    }
    await s.advanceTotpStep(accountId, totp.step, iso(nowMs)); // replay guard moves forward
  }

  // Success. Clear the throttle, rehash-on-login if params drifted, mint a fresh access token.
  await s.clearThrottle(bucket);
  if (verdict.needsRehash) {
    await s.updatePasswordHash(accountId, hashPassword(parsed.data.password, pepper, ARGON2_PARAMS), iso(nowMs));
  }
  const username = (await s.getUsernameByAccount(accountId))?.usernameDisplay ?? null;
  // Phase 2: ONE fresh family backs both the access grant and (for a recoverable account) the refresh
  // session, so revoking this session later kills both. The label is captured from this device's UA.
  const familyId = authCrypto.randomToken(16);
  const access = await mintAccessToken(s, accountId, familyId, nowMs);

  // P0 BELT (spec §P0): a durable refresh cookie + ungated entry are granted ONLY for a fully-recoverable
  // account. If `recoveryEstablished` is false (an abandoned signup — password set, phrase never saved),
  // issue NO durable cookie; the response flag tells the client to FORCE the recovery-phrase screen
  // (/recovery/rotate → save-ack → /finalize) before entry. A normal account gets the durable cookie.
  if (credential.recoveryEstablished) {
    await issueRefresh(c, s, accountId, familyId, deviceLabelFromUA(c.req.header('user-agent')), nowMs);
  }
  // P3 audit: a successful login. credentialRef = the new session family (so a later session.revoke /
  // access line ties back here); detail flags whether the second factor was exercised.
  await audit(c, {
    surface: 'auth',
    action: 'login',
    result: 'allow',
    principalKind: 'owner',
    accountId,
    credentialRef: familyId,
    detail: credential.totpEnabled ? '2fa' : 'password',
  });
  return c.json({
    token: access.token,
    expiresAt: access.expiresAt,
    accountId,
    username,
    recoveryEstablished: credential.recoveryEstablished,
    totpEnabled: credential.totpEnabled,
  });
});

// ---------------------------------------------------------------------------
// POST /api/auth/refresh  — the httpOnly cookie is the SOLE input. Verify + ROTATE → fresh access token.
//   Reuse-detection: an already-rotated (or revoked) token = theft → revoke the whole family. THE
//   cold-boot ungated-reload path. CSRF belt: Origin check (cookie-bearing mutation).
// ---------------------------------------------------------------------------
passwordAuth.post('/refresh', async (c) => {
  // No body — the httpOnly cookie is the sole input. CSRF belt first (cookie-bearing mutation).
  if (!originAllowed(c)) return apiError(c, 403, 'forbidden', 'cross-origin request rejected');

  const s = store(c);
  const nowMs = Date.now();
  const cookie = getCookie(c, REFRESH_COOKIE_NAME);
  const reject = () => {
    clearRefreshCookie(c);
    return apiError(c, 401, 'invalid_session', 'no valid session');
  };
  if (!cookie) return reject();

  const session = await s.getRefreshSession(authCrypto.hashToken(cookie));
  if (!session) return reject();
  // Reuse-detection: a revoked OR already-rotated token presented again = theft → revoke the family.
  if (session.revokedAt !== null || session.rotatedAt !== null) {
    await s.revokeRefreshFamily(session.familyId, iso(nowMs));
    await s.revokeGrantsByAccount(session.accountId, iso(nowMs));
    return reject();
  }
  if (session.expiresAtMs <= nowMs) return reject();

  // Rotate: spend this token, issue a fresh one in the SAME family, mint a fresh access token. Phase 2:
  // carry the family's existing label forward (uniform across the family) so the device name is preserved
  // across rotations, and link the new access grant to the SAME family so a later session-revoke kills it.
  await s.markRefreshRotated(authCrypto.hashToken(cookie), iso(nowMs));
  await issueRefresh(c, s, session.accountId, session.familyId, session.label, nowMs);
  const username = (await s.getUsernameByAccount(session.accountId))?.usernameDisplay ?? null;
  // Surface server-authoritative 2FA state on the cold-boot refresh so Settings renders correctly without
  // a separate fetch. One extra PK-indexed read on the (boot-only) refresh path — negligible.
  const totpEnabled = (await s.getCredentialByAccount(session.accountId))?.totpEnabled ?? false;
  const access = await mintAccessToken(s, session.accountId, session.familyId, nowMs);
  // A durable refresh session only ever exists post-finalize, so recoveryEstablished is necessarily true here.
  return c.json({
    token: access.token,
    expiresAt: access.expiresAt,
    accountId: session.accountId,
    username,
    recoveryEstablished: true,
    totpEnabled,
  });
});

// ---------------------------------------------------------------------------
// POST /api/auth/logout  — revoke ALL refresh families + access grants for the account; clear cookie.
//   Identifies the account from the access bearer, else the refresh cookie. Idempotent (always 200).
// ---------------------------------------------------------------------------
passwordAuth.post('/logout', async (c) => {
  if (!originAllowed(c)) return apiError(c, 403, 'forbidden', 'cross-origin request rejected');
  if (!LogoutRequestSchema.safeParse((await readBody(c)) ?? {}).success) {
    return apiError(c, 400, 'invalid_request', 'request failed validation');
  }
  const s = store(c);
  const nowMs = Date.now();

  // Prefer the access bearer; fall back to the refresh cookie (e.g. access already expired).
  let accountId: string | null = null;
  const bearer = /^Bearer\s+(\S+)$/i.exec(c.req.header('Authorization')?.trim() ?? '')?.[1];
  if (bearer) {
    const grant = await s.resolveGrantByTokenHash(authCrypto.hashToken(bearer));
    if (grant && grant.principal.kind === 'owner') accountId = grant.principal.id;
  }
  if (!accountId) {
    const cookie = getCookie(c, REFRESH_COOKIE_NAME);
    if (cookie) accountId = (await s.getRefreshSession(authCrypto.hashToken(cookie)))?.accountId ?? null;
  }
  if (accountId) await revokeAll(s, accountId, nowMs);
  clearRefreshCookie(c);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /api/auth/reset  — { username, recoveryPhrase, newPassword, turnstileToken? }
//   → verify the recovery verifier (gated >= login, uniform real-or-dummy) → set new password +
//     clear 2FA (phrase = single master recovery) + revoke-all. NON-DISCLOSING on any failure.
// ---------------------------------------------------------------------------
passwordAuth.post('/reset', async (c) => {
  const parsed = PasswordResetRequestSchema.safeParse(await readBody(c));
  if (!parsed.success) {
    return apiError(c, 400, 'invalid_request', 'request failed validation', parsed.error.format());
  }
  const pepper = requireSecret(c, 'AUTH_PEPPER');
  if (typeof pepper !== 'string') return pepper;

  const s = store(c);
  const nowMs = Date.now();
  const norm = normalizeUsername(parsed.data.username);
  const key = norm.ok ? norm.value.normalized : parsed.data.username.toLowerCase();
  const bucket = `reset:${key}`;

  // GATE before the hash (AP-4), with the STRICTER reset policy (a phrase guess = full takeover, AP-15).
  const gated = await gate(c, s, bucket, parsed.data.turnstileToken, nowMs);
  if (gated) return gated;

  // NON-DISCLOSING: unknown-username and known-username-wrong-phrase return the IDENTICAL response (AP-3).
  const fail = async (): Promise<Response> => {
    await recordFailure(s, bucket, RESET_BACKOFF, nowMs);
    return apiError(c, 401, 'reset_failed', UNIFORM_RESET_ERROR);
  };

  const accountId = norm.ok ? await s.resolveAccountIdByUsername(norm.value.normalized) : null;
  const credential = accountId ? await s.getCredentialByAccount(accountId) : null;

  // UNIFORM real-or-dummy recovery hash (no existence oracle). A non-PHC stored verifier (the Option-B
  // sentinel for an account whose recovery is not yet established) MUST also burn the dummy hash — else a
  // pending account returns ~0ms vs ~290ms for an established one = a persistent timing oracle for the
  // un-established state (secSys (a)). So route unknown-account AND sentinel-verifier through the dummy.
  if (!accountId || !credential || !isPhc(credential.recoveryPhc)) {
    dummyRecoveryHash(parsed.data.recoveryPhrase, pepper, ARGON2_PARAMS);
    return fail();
  }
  if (!verifyRecoveryPhrase(parsed.data.recoveryPhrase, accountId, credential.recoveryPhc, pepper)) {
    return fail();
  }

  // Success: new password, clear 2FA (phrase-clears-2FA default), revoke-all, clear throttle.
  await s.updatePasswordHash(accountId, hashPassword(parsed.data.newPassword, pepper, ARGON2_PARAMS), iso(nowMs));
  await s.disableTotp(accountId, iso(nowMs));
  await revokeAll(s, accountId, nowMs);
  await s.clearThrottle(bucket);
  clearRefreshCookie(c);
  // No session minted — the user logs in fresh with the new password (everything prior was revoked).
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Authenticated ceremony endpoints — the bearer resolves the account via guard().
// ---------------------------------------------------------------------------
const workspaceResource = (): Resource => ({ kind: 'workspace' });

// POST /api/auth/finalize — the CEREMONY-COMPLETE commit (after the user save-acks the recovery phrase).
// Sets recoveryEstablished=true (BELT) AND the durable refresh cookie (SUSPENDERS) together. Idempotent.
passwordAuth.post(
  '/finalize',
  guard({
    op: 'write',
    schema: FinalizeRequestSchema,
    input: () => ({}),
    resource: workspaceResource,
    handle: async (_req, c, principal) => {
      if (principal.kind !== 'owner') return apiError(c, 403, 'forbidden', 'only an account may finalize');
      const s = store(c);
      const nowMs = Date.now();
      // BELT GUARD (Option B): recoveryEstablished=true must IMPLY a real recovery verifier exists. Since
      // the verifier is now established at /recovery/rotate (not inline at /signup), REFUSE to finalize an
      // account whose recoveryPhc is still the sentinel — otherwise finalize-without-rotate would mark an
      // account "established" with no recoverable phrase + no re-prompt (the exact P0 the belt prevents).
      // Parse-based (secSys): refuse unless recoveryPhc is a REAL PHC verifier — robust to ANY non-PHC
      // placeholder, never dependent on client call-ordering. recoveryEstablished=true ⟹ a real verifier.
      const cred = await s.getCredentialByAccount(principal.id);
      if (!cred || !isPhc(cred.recoveryPhc)) {
        return apiError(c, 409, 'recovery_not_established', 'establish a recovery phrase before finalizing');
      }
      // ATOMIC (secSys (b)): flip recoveryEstablished=true AND insert the durable-session row in one
      // transaction, then set the cookie — the BELT flag and the SUSPENDERS cookie can never diverge.
      const refreshToken = authCrypto.randomToken(32);
      await s.finalizeRecovery({
        accountId: principal.id,
        tokenHash: authCrypto.hashToken(refreshToken),
        familyId: authCrypto.randomToken(16),
        issuedAtMs: nowMs,
        expiresAtMs: nowMs + REFRESH_TTL_MS,
        updatedAt: iso(nowMs),
      });
      setRefreshCookie(c, refreshToken);
      return c.json({ ok: true });
    },
  }),
);

// POST /api/auth/recovery/rotate — generate a FRESH recovery phrase + rotate the verifier, returning the
// phrase ONCE. Used by the forced-phrase screen when a login finds recoveryEstablished=false (the
// abandoned phrase can't be re-shown). Does NOT set recoveryEstablished — the following /finalize does.
passwordAuth.post(
  '/recovery/rotate',
  guard({
    op: 'write',
    schema: RecoveryRotateRequestSchema,
    input: () => ({}),
    resource: workspaceResource,
    handle: async (_req, c, principal) => {
      const pepper = requireSecret(c, 'AUTH_PEPPER');
      if (typeof pepper !== 'string') return pepper;
      if (principal.kind !== 'owner') return apiError(c, 403, 'forbidden', 'only an account may rotate recovery');
      const s = store(c);
      const recoveryPhrase = generateRecoveryPhrase();
      await s.updateRecoveryHash(
        principal.id,
        hashRecoveryPhrase(recoveryPhrase, principal.id, pepper, ARGON2_PARAMS),
        iso(Date.now()),
      );
      return c.json({ recoveryPhrase });
    },
  }),
);

// POST /api/auth/totp/setup — mint + stash an encrypted secret WITHOUT enabling; return secret + URI.
passwordAuth.post(
  '/totp/setup',
  guard({
    op: 'write',
    schema: TotpSetupRequestSchema,
    input: () => ({}),
    resource: workspaceResource,
    handle: async (_req, c, principal) => {
      const encKey = requireSecret(c, 'TOTP_ENC_KEY');
      if (typeof encKey !== 'string') return encKey;
      if (principal.kind !== 'owner') return apiError(c, 403, 'forbidden', 'only an account may set up 2FA');

      const s = store(c);
      const secret = generateSecret();
      await s.setTotpSecret(principal.id, await encryptSecret(secret, encKey), iso(Date.now()));
      const username = (await s.getUsernameByAccount(principal.id))?.usernameDisplay ?? principal.id;
      const secretBase32 = secretToBase32(secret);
      return c.json({
        secret: secretBase32,
        otpauthUri: otpauthUri({ secretBase32, account: username, issuer: TOTP_ISSUER }),
      });
    },
  }),
);

// POST /api/auth/totp/verify — confirm a code → ACTIVATE 2FA (confirm-before-activate). Revoke-all (2FA-change).
passwordAuth.post(
  '/totp/verify',
  guard({
    op: 'write',
    schema: TotpVerifyRequestSchema,
    input: (c) => readBody(c),
    resource: workspaceResource,
    handle: async (req, c, principal) => {
      const encKey = requireSecret(c, 'TOTP_ENC_KEY');
      if (typeof encKey !== 'string') return encKey;
      if (principal.kind !== 'owner') return apiError(c, 403, 'forbidden', 'only an account may enable 2FA');

      const s = store(c);
      const nowMs = Date.now();
      const credential = await s.getCredentialByAccount(principal.id);
      if (!credential?.totpSecretEnc) return apiError(c, 400, 'no_totp_setup', 'no TOTP secret to confirm');

      const secret = await decryptSecret(credential.totpSecretEnc, encKey);
      // Confirm against the fresh secret (no replay guard yet — it activates on the first accepted code).
      const totp = verifyTotp(secret, req.code, nowMs, null);
      if (!totp.ok) return apiError(c, 400, 'invalid_code', 'that code is not valid');

      await s.enableTotp(principal.id, totp.step, iso(nowMs));
      await revokeAll(s, principal.id, nowMs); // 2FA-change → revoke EVERY session (other devices re-auth)
      // ...then keep the ACTING device signed in (Settings toggle must not log the user out).
      const access = await reissueActingSession(c, s, principal.id, credential.recoveryEstablished, nowMs);
      return c.json({ enabled: true, token: access.token, expiresAt: access.expiresAt });
    },
  }),
);

// POST /api/auth/totp/disable — re-prove with a current code → disable 2FA. Revoke-all (2FA-change).
passwordAuth.post(
  '/totp/disable',
  guard({
    op: 'write',
    schema: TotpDisableRequestSchema,
    input: (c) => readBody(c),
    resource: workspaceResource,
    handle: async (req, c, principal) => {
      const encKey = requireSecret(c, 'TOTP_ENC_KEY');
      if (typeof encKey !== 'string') return encKey;
      if (principal.kind !== 'owner') return apiError(c, 403, 'forbidden', 'only an account may disable 2FA');

      const s = store(c);
      const nowMs = Date.now();
      const credential = await s.getCredentialByAccount(principal.id);
      if (!credential?.totpEnabled || !credential.totpSecretEnc) {
        return apiError(c, 400, 'totp_not_enabled', '2FA is not enabled');
      }
      const secret = await decryptSecret(credential.totpSecretEnc, encKey);
      const totp = verifyTotp(secret, req.code, nowMs, credential.totpLastStep);
      if (!totp.ok) return apiError(c, 400, 'invalid_code', 'that code is not valid');

      await s.disableTotp(principal.id, iso(nowMs));
      await revokeAll(s, principal.id, nowMs); // 2FA-change → revoke EVERY session (other devices re-auth)
      // ...then keep the ACTING device signed in (Settings toggle must not log the user out).
      const access = await reissueActingSession(c, s, principal.id, credential.recoveryEstablished, nowMs);
      return c.json({ enabled: false, token: access.token, expiresAt: access.expiresAt });
    },
  }),
);

export { passwordAuth };
