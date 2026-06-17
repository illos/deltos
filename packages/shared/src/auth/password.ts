import { z } from 'zod';

/**
 * Password-auth contract (the 2026-06-17 pivot — `docs/specs/auth-pivot-password.md`). Username +
 * password primary, optional TOTP 2FA, recovery phrase = forgot-password reset. Both client and worker
 * build against EXACTLY these shapes. This SUPERSEDES the signed-challenge contract (`requests.ts` +
 * `canonical.ts`), which is retired once no code references it (additive landing keeps the tree green).
 *
 * Design notes that the SHAPES encode (security model — secSys, spec §Security):
 *  - The **access token** the client holds is the SAME opaque grant token as before (in-memory only,
 *    `Authorization: Bearer`); login/refresh return `{ token, expiresAt, accountId }` — identical to the
 *    old session response, so the grant/`can()` spine is reused wholesale. Field name is `token`.
 *  - The **refresh** credential is NOT in any of these bodies: it is an httpOnly+Secure+SameSite=Strict
 *    cookie the server sets / rotates / clears. JS never sees it; there is no refresh field on the wire.
 *  - **Anti-enumeration (planSys):** REGISTER discloses "username taken" (409); LOGIN returns a UNIFORM
 *    error on any failure (never reveals whether the username exists); RESET is NON-DISCLOSING (a uniform
 *    response whether or not the username/phrase were valid). The schemas carry no field that would leak
 *    existence; the uniform-response discipline lives in the worker handlers.
 */

// ── Field schemas ─────────────────────────────────────────────────────────────────────────────────

/**
 * Raw username as typed by the user. NORMALIZED + fully validated SERVER-SIDE via `normalizeUsername`
 * (NFKC + casefold + charset + reserved denylist) — this wire schema only bounds length so an oversized
 * body is rejected at the edge. Keep generous; the real rule is the shared normalizer.
 */
export const UsernameInputSchema = z.string().min(1).max(128);

/**
 * Password. NIST-style: min 8, allow any characters (no composition rules), bounded max so a megabyte
 * password can't be used as an Argon2id CPU/memory amplifier. Never logged, never returned.
 */
export const PasswordSchema = z.string().min(8).max(256);

/** A TOTP code — exactly 6 decimal digits (RFC 6238 default). */
export const TotpCodeSchema = z.string().regex(/^\d{6}$/, 'a 6-digit code');

/** The recovery phrase as re-typed at reset. Validated server-side against the Argon2id verifier. */
export const RecoveryPhraseSchema = z.string().min(1).max(512);

/** Optional Cloudflare Turnstile token (anti-abuse on the unauthenticated register/login/reset paths). */
export const TurnstileTokenSchema = z.string().min(1).max(2048);

// ── Access-token response (shared by login + refresh) ───────────────────────────────────────────────

/**
 * The minted session/access token — opaque bearer, in-memory ONLY on the client (`Authorization` header).
 * Identical in shape to the retired signed-challenge session response, so the grant/`can()` spine is
 * unchanged. The durable refresh credential rides a Set-Cookie header, NOT this body.
 */
export const AccessTokenResponseSchema = z.object({
  token: z.string(),
  expiresAt: z.string(), // ISO
  accountId: z.string(),
  /** The account's claimed username (display form), or null if none. */
  username: z.string().nullable(),
});
export type AccessTokenResponse = z.infer<typeof AccessTokenResponseSchema>;

// ── Register ───────────────────────────────────────────────────────────────────────────────────────

export const RegisterRequestSchema = z
  .object({
    username: UsernameInputSchema,
    password: PasswordSchema,
    turnstileToken: TurnstileTokenSchema.optional(),
  })
  .strict();
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;

/**
 * Register response. The recovery phrase leaves the server EXACTLY ONCE here (the user must record it);
 * it is stored only as an Argon2id verifier and never returned again. Also returns the access token so
 * register flows straight into a session (and the server Set-Cookies the refresh).
 */
export const RegisterResponseSchema = z.object({
  accountId: z.string(),
  username: z.string(),
  recoveryPhrase: z.string(),
  token: z.string(),
  expiresAt: z.string(),
});
export type RegisterResponse = z.infer<typeof RegisterResponseSchema>;

// ── Login ──────────────────────────────────────────────────────────────────────────────────────────

export const LoginRequestSchema = z
  .object({
    username: UsernameInputSchema,
    password: PasswordSchema,
    /** Required only if the account has TOTP enabled; the handler returns a uniform error if missing/wrong. */
    totp: TotpCodeSchema.optional(),
    turnstileToken: TurnstileTokenSchema.optional(),
  })
  .strict();
export type LoginRequest = z.infer<typeof LoginRequestSchema>;
/** Login success = an access token (+ Set-Cookie refresh). Failure = a UNIFORM 401, never enumerating. */
export const LoginResponseSchema = AccessTokenResponseSchema;
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

// ── Refresh / Logout ─────────────────────────────────────────────────────────────────────────────────

/**
 * Refresh carries NO body — the httpOnly refresh cookie is the sole input. The server verifies +
 * ROTATES it (new cookie, prior invalidated; a presented-already-rotated token = reuse → revoke the whole
 * family) and returns a fresh access token. This is the cold-boot ungated-reload path.
 */
export const RefreshRequestSchema = z.object({}).strict();
export type RefreshRequest = z.infer<typeof RefreshRequestSchema>;
export const RefreshResponseSchema = AccessTokenResponseSchema;
export type RefreshResponse = z.infer<typeof RefreshResponseSchema>;

export const LogoutRequestSchema = z.object({}).strict();
export type LogoutRequest = z.infer<typeof LogoutRequestSchema>;

// ── Recovery-phrase reset ────────────────────────────────────────────────────────────────────────────

/**
 * Single-shot, NON-DISCLOSING reset: username + recovery phrase + new password. The response is UNIFORM
 * regardless of whether the username existed or the phrase matched (no existence oracle) — the handler
 * runs the cheap gate BEFORE the Argon2id verifier and hashes uniformly (real-or-dummy). On success it
 * sets the new password, CLEARS/re-enrolls 2FA (phrase is the single master recovery — planSys), and
 * REVOKE-ALLs refresh sessions.
 */
export const PasswordResetRequestSchema = z
  .object({
    username: UsernameInputSchema,
    recoveryPhrase: RecoveryPhraseSchema,
    newPassword: PasswordSchema,
    turnstileToken: TurnstileTokenSchema.optional(),
  })
  .strict();
export type PasswordResetRequest = z.infer<typeof PasswordResetRequestSchema>;

// ── TOTP (optional 2FA) ────────────────────────────────────────────────────────────────────────────

/** Setup is authenticated (no body); returns a fresh secret + provisioning URI for the authenticator app. */
export const TotpSetupRequestSchema = z.object({}).strict();
export type TotpSetupRequest = z.infer<typeof TotpSetupRequestSchema>;
export const TotpSetupResponseSchema = z.object({
  /** base32 secret (also embedded in the URI) — shown once so the user can key it in manually. */
  secret: z.string(),
  /** otpauth:// provisioning URI for QR display. */
  otpauthUri: z.string(),
});
export type TotpSetupResponse = z.infer<typeof TotpSetupResponseSchema>;

/** Verify-and-enable: the user proves they keyed the secret in by returning a current code. */
export const TotpVerifyRequestSchema = z.object({ code: TotpCodeSchema }).strict();
export type TotpVerifyRequest = z.infer<typeof TotpVerifyRequestSchema>;

/** Disable 2FA: re-prove with a current code (a credential-change → triggers revoke-all). */
export const TotpDisableRequestSchema = z.object({ code: TotpCodeSchema }).strict();
export type TotpDisableRequest = z.infer<typeof TotpDisableRequestSchema>;
