import { describe, it, expect } from 'vitest';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import {
  generateMnemonic,
  validateMnemonic,
  mnemonicToSeed,
  slip21Key,
  deriveSigningKeypair,
  accountId,
  deriveKeyHierarchy,
  SIGNING_KEY_PATH,
  AT_REST_KEY_PATH,
} from '../src/identity/keyDerivation.js';

/**
 * KeyDerivation is the root of the whole identity stream — every device that types the same
 * recovery phrase MUST land on the same account signing key and the same `Identity.id`, and the
 * SLIP-21 siblings MUST stay domain-separated (collapsing them re-opens the custody finding S1
 * flagged). So this is pinned end to end by published vectors (BIP39 + SLIP-0021) plus frozen
 * deltos-specific vectors, not just round-trip properties.
 */

// Canonical 24→12-word vectors use the same wordlist; the BIP39 spec vector below is the Trezor
// "abandon … about" entropy=0 case, also used as the frozen deltos derivation fixture.
const ABANDON =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('mnemonicToSeed — BIP39 PBKDF2-HMAC-SHA512', () => {
  it('matches the canonical Trezor vector (passphrase "TREZOR")', async () => {
    const seed = await mnemonicToSeed(ABANDON, 'TREZOR');
    expect(bytesToHex(seed)).toBe(
      'c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a698' +
        '7599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04',
    );
  });

  it('defaults to an empty passphrase (the deltos convention — the phrase is the only secret)', async () => {
    const withDefault = await mnemonicToSeed(ABANDON);
    const withEmpty = await mnemonicToSeed(ABANDON, '');
    expect(bytesToHex(withDefault)).toBe(bytesToHex(withEmpty));
  });
});

describe('slip21Key — SLIP-0021 symmetric-key derivation', () => {
  // The official SLIP-0021 example seed and its two derived keys.
  const S = hexToBytes(
    'c76c4ac4f4e4a00d6b274d5c39c700bb4a7ddc04fbc6f78e85ca75007b5b495f' +
      '74a9043eeb77bdd53aa6fc3a0e31462270316fa04b8c19114c8798706cd02ac8',
  );

  it('derives the published "Master encryption key" (right-half key material)', () => {
    expect(bytesToHex(slip21Key(S, ['SLIP-0021', 'Master encryption key']))).toBe(
      'ea163130e35bbafdf5ddee97a17b39cef2be4b4f390180d65b54cf05c6a82fde',
    );
  });

  it('derives the published "Authentication key"', () => {
    expect(bytesToHex(slip21Key(S, ['SLIP-0021', 'Authentication key']))).toBe(
      '47194e938ab24cc82bfa25f6486ed54bebe79c40ae2a5a32ea6db294d81861a6',
    );
  });

  it('returns 32 bytes of key material', () => {
    expect(slip21Key(S, ['SLIP-0021', 'Authentication key']).length).toBe(32);
  });
});

describe('deriveSigningKeypair — Ed25519 over a SLIP-21 sibling seed', () => {
  it('produces a 32-byte private seed and 32-byte public key', async () => {
    const seed = await mnemonicToSeed(ABANDON);
    const kp = deriveSigningKeypair(seed);
    expect(kp.privateKey.length).toBe(32);
    expect(kp.publicKey.length).toBe(32);
  });

  it('is deterministic — same seed yields the same keypair', async () => {
    const seed = await mnemonicToSeed(ABANDON);
    expect(bytesToHex(deriveSigningKeypair(seed).publicKey)).toBe(
      bytesToHex(deriveSigningKeypair(seed).publicKey),
    );
  });

  it('signs with noble and verifies with WebCrypto raw-public import (the F12 client↔server gate)', async () => {
    const seed = await mnemonicToSeed(ABANDON);
    const kp = deriveSigningKeypair(seed);
    const ed = await import('@noble/ed25519');
    const msg = new TextEncoder().encode('deltos-auth-v1 challenge');
    const sig = ed.sign(msg, kp.privateKey);
    // Server path: import the raw public key into WebCrypto and verify the noble signature.
    const pub = await crypto.subtle.importKey('raw', kp.publicKey, { name: 'Ed25519' }, false, [
      'verify',
    ]);
    expect(await crypto.subtle.verify({ name: 'Ed25519' }, pub, sig, msg)).toBe(true);
  });
});

describe('accountId — Identity.id = base64url(SHA-256(signing public key))', () => {
  it('is the F2-consistent fingerprint of the public key', () => {
    const pub = hexToBytes('d72f09afbc5466596b386cc67c3e1e59baf30f21a329faf3c5ccd3cadac8f3ce');
    expect(accountId(pub)).toBe('ZIqDVWjXSdI6CQ_HTSFmx0mRGM1LIzgEFMpspKdW11Q');
  });
});

describe('deriveKeyHierarchy — the full account derivation', () => {
  it('matches the frozen deltos vectors for the canonical phrase (empty passphrase)', async () => {
    const h = await deriveKeyHierarchy(ABANDON);
    expect(h.id).toBe('ZIqDVWjXSdI6CQ_HTSFmx0mRGM1LIzgEFMpspKdW11Q');
    expect(bytesToHex(h.signing.publicKey)).toBe(
      'd72f09afbc5466596b386cc67c3e1e59baf30f21a329faf3c5ccd3cadac8f3ce',
    );
    expect(bytesToHex(h.signing.privateKey)).toBe(
      '9ca4f2d2121992edf46875c32fbf6758ed9f0f838c69a8eec1fee821b057a90f',
    );
    expect(bytesToHex(h.atRestKey)).toBe(
      '512589f9da9e03dc9085edc4ce467a1d1bfe87f8dcc463cbede766dfeb86b321',
    );
  });

  it('keeps the SLIP-21 siblings domain-separated (signing seed ≠ at-rest key)', async () => {
    const seed = await mnemonicToSeed(ABANDON);
    const signSeed = slip21Key(seed, SIGNING_KEY_PATH);
    const atRest = slip21Key(seed, AT_REST_KEY_PATH);
    expect(bytesToHex(signSeed)).not.toBe(bytesToHex(atRest));
  });

  it('is stable across re-derivation — recovery on a new device lands the same id', async () => {
    const a = await deriveKeyHierarchy(ABANDON);
    const b = await deriveKeyHierarchy(ABANDON);
    expect(a.id).toBe(b.id);
  });
});

describe('mnemonic generation + validation', () => {
  it('generates a valid 24-word phrase (256-bit entropy)', () => {
    const m = generateMnemonic();
    expect(m.split(' ')).toHaveLength(24);
    expect(validateMnemonic(m)).toBe(true);
  });

  it('rejects a tampered phrase (checksum failure)', () => {
    expect(validateMnemonic('abandon abandon abandon')).toBe(false);
  });
});
