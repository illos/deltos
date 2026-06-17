import { hmac } from '@noble/hashes/hmac.js';
import { sha1 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { base64urlEncode, base64urlDecodeStrict } from '@deltos/shared';
import { base32Lower, constantTimeEqual } from './passwordCrypto.js';

/**
 * Optional TOTP 2FA (RFC 6238) for the auth pivot — prompted at new-device login + reset ONLY, never
 * day-to-day (`[[auth-friction-philosophy]]`). secSys rulings baked in (`[[auth-pivot-security-model]]`,
 * AP-14 / AP-T9):
 *
 *  - **20-byte secret**, HMAC-SHA1, 6 digits, 30s period — the RFC-6238 defaults every authenticator app
 *    (Google Authenticator / 1Password / Aegis) speaks.
 *  - **Confirm-before-activate:** setup returns a secret but does NOT enable 2FA; the user must return a
 *    valid code first (anti-lockout). That ordering lives in the route; this module just verifies.
 *  - **±1 step skew, constant-time** code compare (no digit-by-digit timing leak).
 *  - **Replay guard:** the caller persists `lastAcceptedStep`; {@link verifyTotp} rejects any candidate
 *    step `<= lastAcceptedStep`, so a code (or a ±1 neighbour) can never be replayed within its window.
 *  - **Secret encrypted at rest** ({@link encryptSecret}/{@link decryptSecret}, AES-256-GCM under a
 *    Worker-secret key) — a D1 leak alone does not defeat 2FA.
 */

export const TOTP_PERIOD_SEC = 30;
export const TOTP_DIGITS = 6;
export const TOTP_SECRET_BYTES = 20;
const TOTP_SKEW_STEPS = 1; // accept the code one step either side of now (clock drift tolerance)

/** Mint a fresh 20-byte TOTP secret (CSPRNG). */
export function generateSecret(): Uint8Array {
  return randomBytes(TOTP_SECRET_BYTES);
}

/** Uppercase RFC-4648 base32 (no padding) — the form authenticator apps expect in the otpauth URI. */
export function secretToBase32(secret: Uint8Array): string {
  return base32Lower(secret).toUpperCase();
}

/** Decode an upper/lowercase, possibly-spaced base32 secret back to bytes. Throws on a stray character. */
export function base32ToBytes(b32: string): Uint8Array {
  const clean = b32.toLowerCase().replace(/[\s=-]/g, '');
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) throw new Error('invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

/**
 * The otpauth:// provisioning URI for a QR code. `account` is the user-facing label (the username);
 * `issuer` brands it in the authenticator app. The secret is embedded base32.
 */
export function otpauthUri(opts: { secretBase32: string; account: string; issuer: string }): string {
  const label = encodeURIComponent(`${opts.issuer}:${opts.account}`);
  const params = new URLSearchParams({
    secret: opts.secretBase32,
    issuer: opts.issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SEC),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** The TOTP time-step index for an epoch-millis instant (RFC 6238 `T = floor(unixSeconds / period)`). */
export function stepAt(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SEC);
}

/** The 6-digit code for a secret at a given step (HMAC-SHA1 + RFC-4226 dynamic truncation). */
export function codeAtStep(secret: Uint8Array, step: number): string {
  // 8-byte big-endian counter. Bit-ops top out at 32 bits, so build the two halves separately.
  const counter = new Uint8Array(8);
  let lo = step >>> 0;
  let hi = Math.floor(step / 0x100000000) >>> 0;
  for (let i = 7; i >= 0; i--) {
    counter[i] = (i >= 4 ? lo : hi) & 0xff;
    if (i >= 4) lo = Math.floor(lo / 256);
    else hi = Math.floor(hi / 256);
  }
  const digest = hmac(sha1, secret, counter);
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    (((digest[offset + 1] ?? 0) & 0xff) << 16) |
    (((digest[offset + 2] ?? 0) & 0xff) << 8) |
    ((digest[offset + 3] ?? 0) & 0xff);
  return (binary % 10 ** TOTP_DIGITS).toString().padStart(TOTP_DIGITS, '0');
}

export interface TotpVerifyResult {
  ok: boolean;
  /** The step the code matched (caller persists it as the new `lastAcceptedStep` for the replay guard). */
  step: number;
}

/**
 * Verify a submitted code against the secret within ±1 step. REPLAY GUARD: any candidate step
 * `<= lastAcceptedStep` is rejected, so a code already accepted (or its skew neighbours) cannot be
 * reused. Compares constant-time. On success returns the matched step so the caller advances the guard.
 */
export function verifyTotp(
  secret: Uint8Array,
  code: string,
  nowMs: number,
  lastAcceptedStep: number | null = null,
): TotpVerifyResult {
  const now = stepAt(nowMs);
  // Highest step first so the returned/persisted step is the furthest forward we accept.
  for (let delta = TOTP_SKEW_STEPS; delta >= -TOTP_SKEW_STEPS; delta--) {
    const step = now + delta;
    if (lastAcceptedStep !== null && step <= lastAcceptedStep) continue; // replay guard
    const expected = codeAtStep(secret, step);
    if (constantTimeEqual(utf8ToBytes(expected), utf8ToBytes(code))) return { ok: true, step };
  }
  return { ok: false, step: now };
}

// ── Secret-at-rest encryption (AES-256-GCM under a Worker-secret key) ───────────────────────────────

/** Derive a stable 32-byte AES key from the Worker-secret string (SHA-256 so any-length secret works). */
async function importKey(encKey: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', sha256(utf8ToBytes(encKey)), { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/** Encrypt the raw TOTP secret → base64url(iv ‖ ciphertext+tag). The plaintext secret never hits D1. */
export async function encryptSecret(secret: Uint8Array, encKey: string): Promise<string> {
  const key = await importKey(encKey);
  const iv = randomBytes(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, secret));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return base64urlEncode(out);
}

/** Decrypt a stored TOTP secret; throws (fail-closed) on a tampered/garbage blob or wrong key. */
export async function decryptSecret(blob: string, encKey: string): Promise<Uint8Array> {
  const key = await importKey(encKey);
  const raw = base64urlDecodeStrict(blob);
  const iv = raw.subarray(0, 12);
  const ct = raw.subarray(12);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct));
}
