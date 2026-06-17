import { describe, it, expect } from 'vitest';
import {
  generateSecret,
  secretToBase32,
  base32ToBytes,
  otpauthUri,
  stepAt,
  codeAtStep,
  verifyTotp,
  encryptSecret,
  decryptSecret,
  TOTP_PERIOD_SEC,
} from '../src/totp.js';

/**
 * AP-T9 / AP-14: TOTP correctness, ±1-skew + replay guard, and secret-at-rest encryption.
 */

describe('TOTP RFC-6238 vectors', () => {
  // RFC 6238 Appendix B uses an ASCII secret "12345678901234567890" with SHA-1.
  const SECRET = new TextEncoder().encode('12345678901234567890');
  // T (seconds) → expected 8-digit code; we use 6 digits, so take the last 6.
  const cases: Array<[number, string]> = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
  ];
  for (const [seconds, eight] of cases) {
    it(`matches the RFC vector at t=${seconds}s`, () => {
      const step = stepAt(seconds * 1000);
      expect(codeAtStep(SECRET, step)).toBe(eight.slice(-6));
    });
  }
});

describe('base32 secret round-trip', () => {
  it('encodes uppercase no-padding and decodes back', () => {
    const secret = generateSecret();
    const b32 = secretToBase32(secret);
    expect(b32).toMatch(/^[A-Z2-7]+$/);
    expect(Array.from(base32ToBytes(b32))).toEqual(Array.from(secret));
  });
  it('tolerates lowercase + spaces on decode', () => {
    const secret = generateSecret();
    const b32 = secretToBase32(secret);
    const messy = b32.toLowerCase().match(/.{1,4}/g)!.join(' ');
    expect(Array.from(base32ToBytes(messy))).toEqual(Array.from(secret));
  });
});

describe('otpauth URI', () => {
  it('embeds the secret, issuer, and RFC defaults', () => {
    const uri = otpauthUri({ secretBase32: 'JBSWY3DPEHPK3PXP', account: 'alice', issuer: 'deltos' });
    expect(uri).toContain('otpauth://totp/deltos%3Aalice?');
    expect(uri).toContain('secret=JBSWY3DPEHPK3PXP');
    expect(uri).toContain('issuer=deltos');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
  });
});

describe('verifyTotp — skew + replay guard', () => {
  const secret = generateSecret();
  const now = 1_700_000_000_000;

  it('accepts the current code', () => {
    const code = codeAtStep(secret, stepAt(now));
    expect(verifyTotp(secret, code, now).ok).toBe(true);
  });

  it('accepts ±1 step (clock drift) but not ±2', () => {
    const step = stepAt(now);
    expect(verifyTotp(secret, codeAtStep(secret, step - 1), now).ok).toBe(true);
    expect(verifyTotp(secret, codeAtStep(secret, step + 1), now).ok).toBe(true);
    expect(verifyTotp(secret, codeAtStep(secret, step + 2), now).ok).toBe(false);
    expect(verifyTotp(secret, codeAtStep(secret, step - 2), now).ok).toBe(false);
  });

  it('rejects a wrong code', () => {
    expect(verifyTotp(secret, '000000', now).ok).toBe(false);
  });

  it('returns the matched step so the caller advances lastAcceptedStep', () => {
    const step = stepAt(now);
    expect(verifyTotp(secret, codeAtStep(secret, step), now).step).toBe(step);
  });

  it('REPLAY GUARD: a code at or below lastAcceptedStep is rejected', () => {
    const step = stepAt(now);
    const code = codeAtStep(secret, step);
    // first accept advances the guard to `step`
    const first = verifyTotp(secret, code, now, null);
    expect(first.ok).toBe(true);
    // replaying the SAME code with lastAcceptedStep=step → rejected
    expect(verifyTotp(secret, code, now, step).ok).toBe(false);
    // a previous step's code is also rejected once the guard has moved forward
    expect(verifyTotp(secret, codeAtStep(secret, step - 1), now, step).ok).toBe(false);
  });
});

describe('TOTP secret-at-rest (AES-256-GCM)', () => {
  const KEY = 'totp-enc-worker-secret';

  it('round-trips through encrypt/decrypt', async () => {
    const secret = generateSecret();
    const blob = await encryptSecret(secret, KEY);
    expect(Array.from(await decryptSecret(blob, KEY))).toEqual(Array.from(secret));
  });

  it('ciphertext != plaintext and is non-deterministic (random IV)', async () => {
    const secret = generateSecret();
    const b1 = await encryptSecret(secret, KEY);
    const b2 = await encryptSecret(secret, KEY);
    expect(b1).not.toBe(b2);
    expect(b1).not.toContain(secretToBase32(secret));
  });

  it('fails closed on the wrong key (tamper/leak resistance)', async () => {
    const blob = await encryptSecret(generateSecret(), KEY);
    await expect(decryptSecret(blob, 'wrong-key')).rejects.toBeDefined();
  });
});

void TOTP_PERIOD_SEC;
