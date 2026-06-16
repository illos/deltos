import { describe, it, expect } from 'vitest';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { canonicalAuthPayload, base64urlEncode, base64urlDecodeStrict, type Scope } from '@deltos/shared';
import {
  computeFingerprint,
  hashToken,
  randomToken,
  clampScope,
  verifyRegister,
  verifySession,
  verifyStepUp,
} from '../src/authCrypto.js';

/**
 * authCrypto is the security-critical verify half of the chokepoint. These tests pin the two
 * must-match cross-boundary invariants (PROP-3 fingerprint vector, audience binding) and prove the
 * verify path fails CLOSED on every tampering: wrong key, wrong audience, mutated scope, bad bytes.
 */

if (!ed.hashes.sha512) ed.hashes.sha512 = sha512;

const fromHex = (h: string) => new Uint8Array(h.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
const b64 = base64urlEncode;

// A deterministic test signing keypair (any 32 bytes is a valid Ed25519 secret).
const priv = new Uint8Array(32).fill(5);
const pub = ed.getPublicKey(priv);
const pubB64 = b64(pub);

const AUD = 'deltos.test';
const nonceBytes = new Uint8Array(32).fill(9);
const nonce = b64(nonceBytes);
const challengeId = b64(new Uint8Array(32).fill(1));
const sign = (message: Uint8Array) => b64(ed.sign(message, priv));

describe('computeFingerprint (F2 / PROP-3)', () => {
  it('matches the frozen client Identity.id vector byte-for-byte', () => {
    const pubkey = fromHex('d72f09afbc5466596b386cc67c3e1e59baf30f21a329faf3c5ccd3cadac8f3ce');
    expect(computeFingerprint(pubkey)).toBe('ZIqDVWjXSdI6CQ_HTSFmx0mRGM1LIzgEFMpspKdW11Q');
  });
});

describe('hashToken (F6)', () => {
  it('is deterministic and distinguishes inputs', () => {
    expect(hashToken('tok-1')).toBe(hashToken('tok-1'));
    expect(hashToken('tok-1')).not.toBe(hashToken('tok-2'));
  });
});

describe('randomToken', () => {
  it('decodes to the requested byte length and is unique per call', () => {
    const a = randomToken(32);
    const b = randomToken(32);
    expect(a).not.toBe(b);
    expect(base64urlDecodeStrict(a).length).toBe(32);
  });
});

describe('clampScope (F5)', () => {
  it('returns the intersection in canonical order, de-duplicated', () => {
    expect(clampScope(['write', 'read', 'read'], ['read', 'write', 'delete'])).toEqual(['read', 'write']);
  });
  it('drops any scope outside the entitlement (never verbatim)', () => {
    expect(clampScope(['delete', 'share'], ['read'])).toEqual([]);
  });
});

describe('verifySession', () => {
  const scope: Scope[] = ['read', 'write'];
  const sessionMsg = (s: Scope[], audience = AUD) =>
    canonicalAuthPayload({ purpose: 'session', audience, challengeId, nonce: nonceBytes, keyId: 'KID-1', requestedScope: s });
  const valid = (over: Partial<Parameters<typeof verifySession>[0]> = {}) => ({
    audience: AUD,
    challengeId,
    nonce,
    keyId: 'KID-1',
    requestedScope: scope,
    signature: sign(sessionMsg(scope)),
    signingPublicKey: pubB64,
    ...over,
  });

  it('accepts a correctly signed session', () => {
    expect(verifySession(valid())).toBe(true);
  });
  it('rejects a tampered scope (signed for {read,write}, presented as {read})', () => {
    expect(verifySession(valid({ requestedScope: ['read'] }))).toBe(false);
  });
  it('rejects a mismatched audience (cross-deployment replay, F8)', () => {
    expect(verifySession(valid({ audience: 'evil.example' }))).toBe(false);
  });
  it('rejects verification against a different public key', () => {
    const otherPub = b64(ed.getPublicKey(new Uint8Array(32).fill(6)));
    expect(verifySession(valid({ signingPublicKey: otherPub }))).toBe(false);
  });
  it('fails closed on a malformed (non-canonical) signature', () => {
    expect(verifySession(valid({ signature: 'not!base64url' }))).toBe(false);
  });
});

describe('verifyRegister', () => {
  it('accepts a registration signed by the submitted key (key-control proof)', () => {
    const msg = canonicalAuthPayload({
      purpose: 'register',
      audience: AUD,
      challengeId,
      nonce: nonceBytes,
      signingPublicKey: pub,
      deviceLabel: 'phone',
    });
    expect(
      verifyRegister({ audience: AUD, challengeId, nonce, signingPublicKey: pubB64, deviceLabel: 'phone', signature: sign(msg) }),
    ).toBe(true);
  });
  it('rejects a register signature made for a different device label', () => {
    const msg = canonicalAuthPayload({
      purpose: 'register',
      audience: AUD,
      challengeId,
      nonce: nonceBytes,
      signingPublicKey: pub,
      deviceLabel: 'phone',
    });
    expect(
      verifyRegister({ audience: AUD, challengeId, nonce, signingPublicKey: pubB64, deviceLabel: 'laptop', signature: sign(msg) }),
    ).toBe(false);
  });
});

describe('verifyStepUp', () => {
  const note = { kind: 'note', id: '00000000-0000-4000-8000-000000000001' } as const;
  const stepUpMsg = (op: 'read' | 'delete', resource = note) =>
    canonicalAuthPayload({ purpose: 'step-up', audience: AUD, challengeId, nonce: nonceBytes, keyId: 'KID-1', op, resource });

  it('returns the verified facts on a correct step-up', () => {
    const v = verifyStepUp({ audience: AUD, challengeId, nonce, keyId: 'KID-1', op: 'delete', resource: note, signature: sign(stepUpMsg('delete')), signingPublicKey: pubB64 });
    expect(v).toEqual({ keyId: 'KID-1', challengeId, op: 'delete', resource: note });
  });
  it('returns null when the op was signed for a different value (cross-op)', () => {
    // signed for op=read, presented as op=delete
    const v = verifyStepUp({ audience: AUD, challengeId, nonce, keyId: 'KID-1', op: 'delete', resource: note, signature: sign(stepUpMsg('read')), signingPublicKey: pubB64 });
    expect(v).toBeNull();
  });
});
