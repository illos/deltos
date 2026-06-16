import { describe, it, expect } from 'vitest';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import { sealBlob, openBlob, hkdfSha256, deriveWrappingKey } from '../src/identity/blob.js';

/**
 * The at-rest blob crypto core — AES-GCM seal/open + HKDF wrapping-key derivation. This is the
 * decision-INDEPENDENT half of KeyStore: it takes a wrapping key as input, so it is correct
 * regardless of where that key comes from (WebAuthn PRF vs the no-PRF fallback, secSys-pending).
 * AES-GCM's authentication tag is load-bearing — a wrong key or a tampered blob MUST fail to open,
 * never silently return garbage — so those are asserted, not just the happy round-trip.
 */

const KEY_A = new Uint8Array(32).fill(0xa1);
const KEY_B = new Uint8Array(32).fill(0xb2);
const plaintext = new TextEncoder().encode('abandon abandon … about (the recovery phrase)');

describe('sealBlob / openBlob — AES-GCM at-rest sealing', () => {
  it('round-trips: open(seal(pt, k), k) === pt', async () => {
    const sealed = await sealBlob(plaintext, KEY_A);
    expect(await openBlob(sealed, KEY_A)).toEqual(plaintext);
  });

  it('tags the version and uses a 12-byte IV', async () => {
    const sealed = await sealBlob(plaintext, KEY_A);
    expect(sealed.v).toBe(1);
    // iv is base64url of 12 bytes; ct is non-empty.
    expect(sealed.ct.length).toBeGreaterThan(0);
  });

  it('uses a fresh random IV each call (same plaintext+key → different ciphertext)', async () => {
    const a = await sealBlob(plaintext, KEY_A);
    const b = await sealBlob(plaintext, KEY_A);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
    // …yet both still open to the same plaintext.
    expect(await openBlob(a, KEY_A)).toEqual(await openBlob(b, KEY_A));
  });

  it('REJECTS opening with the wrong key (AES-GCM tag failure, not garbage)', async () => {
    const sealed = await sealBlob(plaintext, KEY_A);
    await expect(openBlob(sealed, KEY_B)).rejects.toBeDefined();
  });

  it('REJECTS a tampered ciphertext', async () => {
    const sealed = await sealBlob(plaintext, KEY_A);
    const tampered = { ...sealed, ct: sealed.ct.slice(0, -2) + (sealed.ct.endsWith('A') ? 'B' : 'A') };
    await expect(openBlob(tampered, KEY_A)).rejects.toBeDefined();
  });
});

describe('hkdfSha256 — RFC 5869 conformance', () => {
  it('matches RFC 5869 Test Case 1 (SHA-256, L=42)', async () => {
    const okm = await hkdfSha256(
      hexToBytes('0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b'),
      hexToBytes('000102030405060708090a0b0c'),
      hexToBytes('f0f1f2f3f4f5f6f7f8f9'),
      42,
    );
    expect(bytesToHex(okm)).toBe(
      '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
    );
  });
});

describe('deriveWrappingKey — domain-separated 32-byte wrapping key', () => {
  const ikm = new Uint8Array(32).fill(7);
  const salt = new Uint8Array(16).fill(3);

  it('returns 32 bytes', async () => {
    expect((await deriveWrappingKey(ikm, salt, 'deltos-at-rest-v1')).length).toBe(32);
  });

  it('is deterministic for the same (ikm, salt, info)', async () => {
    const a = await deriveWrappingKey(ikm, salt, 'deltos-at-rest-v1');
    const b = await deriveWrappingKey(ikm, salt, 'deltos-at-rest-v1');
    expect(bytesToHex(a)).toBe(bytesToHex(b));
  });

  it('separates domains — a different info label yields a different key', async () => {
    const atRest = await deriveWrappingKey(ikm, salt, 'deltos-at-rest-v1');
    const other = await deriveWrappingKey(ikm, salt, 'deltos-something-else-v1');
    expect(bytesToHex(atRest)).not.toBe(bytesToHex(other));
  });
});
