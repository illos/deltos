/**
 * Password-auth contract shapes (the 2026-06-17 pivot). Locks the request schemas the worker + client
 * both build against: field bounds, `.strict()` (no extra fields ride through), and the no-refresh-on-the-
 * wire invariant (the refresh credential is an httpOnly cookie, never a body field).
 */
import { describe, it, expect } from 'vitest';
import {
  RegisterRequestSchema,
  LoginRequestSchema,
  RefreshRequestSchema,
  LogoutRequestSchema,
  PasswordResetRequestSchema,
  TotpVerifyRequestSchema,
  AccessTokenResponseSchema,
  PasswordSchema,
  TotpCodeSchema,
} from '../src/auth/password.js';

describe('password-auth contract', () => {
  it('register accepts username+password, rejects short password + unknown fields (strict)', () => {
    expect(RegisterRequestSchema.safeParse({ username: 'ada', password: 'hunter2!' }).success).toBe(true);
    expect(RegisterRequestSchema.safeParse({ username: 'ada', password: 'short' }).success).toBe(false);
    // .strict(): a stray field (e.g. a body-supplied accountId) is rejected, never silently trusted.
    expect(RegisterRequestSchema.safeParse({ username: 'ada', password: 'hunter2!', accountId: 'x' }).success).toBe(false);
  });

  it('login accepts optional totp; PasswordSchema bounds (>=8, <=256) stop empty + amplifier inputs', () => {
    expect(LoginRequestSchema.safeParse({ username: 'ada', password: 'hunter2!' }).success).toBe(true);
    expect(LoginRequestSchema.safeParse({ username: 'ada', password: 'hunter2!', totp: '123456' }).success).toBe(true);
    expect(LoginRequestSchema.safeParse({ username: 'ada', password: 'hunter2!', totp: '12x' }).success).toBe(false);
    expect(PasswordSchema.safeParse('a'.repeat(257)).success).toBe(false); // amplifier guard
    expect(PasswordSchema.safeParse('a'.repeat(8)).success).toBe(true);
  });

  it('refresh + logout carry NO body (the refresh credential is an httpOnly cookie, never on the wire)', () => {
    expect(RefreshRequestSchema.safeParse({}).success).toBe(true);
    expect(LogoutRequestSchema.safeParse({}).success).toBe(true);
    // a refresh token smuggled into the body is rejected — there is no such field, by design.
    expect(RefreshRequestSchema.safeParse({ refreshToken: 'x' }).success).toBe(false);
  });

  it('reset is single-shot {username, recoveryPhrase, newPassword}; strict', () => {
    expect(
      PasswordResetRequestSchema.safeParse({ username: 'ada', recoveryPhrase: 'one two three', newPassword: 'newpass12' }).success,
    ).toBe(true);
    expect(PasswordResetRequestSchema.safeParse({ username: 'ada', recoveryPhrase: 'x' }).success).toBe(false);
  });

  it('TOTP code = exactly 6 digits; verify is strict', () => {
    expect(TotpCodeSchema.safeParse('000000').success).toBe(true);
    expect(TotpCodeSchema.safeParse('12345').success).toBe(false);
    expect(TotpVerifyRequestSchema.safeParse({ code: '123456' }).success).toBe(true);
    expect(TotpVerifyRequestSchema.safeParse({ code: '123456', extra: 1 }).success).toBe(false);
  });

  it('access-token response shape = token + expiresAt + accountId + nullable username + recoveryEstablished + totpEnabled', () => {
    const ok = { token: 't', expiresAt: '2026-01-01T00:00:00.000Z', accountId: 'a', username: null, recoveryEstablished: true, totpEnabled: false };
    expect(AccessTokenResponseSchema.safeParse(ok).success).toBe(true);
    expect(AccessTokenResponseSchema.safeParse({ ...ok, username: 'ada', recoveryEstablished: false, totpEnabled: true }).success).toBe(true);
    // username required (nullable, not optional)
    expect(AccessTokenResponseSchema.safeParse({ token: 't', expiresAt: 'x', accountId: 'a', recoveryEstablished: true, totpEnabled: false }).success).toBe(false);
    // recoveryEstablished (P0 belt) is required
    expect(AccessTokenResponseSchema.safeParse({ token: 't', expiresAt: 'x', accountId: 'a', username: null, totpEnabled: false }).success).toBe(false);
    // totpEnabled (#41 — server-authoritative 2FA state) is required
    expect(AccessTokenResponseSchema.safeParse({ ...ok, totpEnabled: undefined }).success).toBe(false);
  });
});
