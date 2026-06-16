/**
 * authCrypto ADVERSARIAL vectors — beyond devSys's authCrypto.test.ts (separate file, placement
 * approved by devSys + pilot). These prove two security properties bite under *crafted* input that a
 * happy-path test never exercises:
 *
 *  (i)  S+L signature malleability — take a VALID signature R||S and replace the scalar S with S+L
 *       (L = the Ed25519 group order). The result is still 64 well-formed bytes (NOT a base64url/length
 *       decode failure), but S+L >= L is non-canonical. noble's STRICT branch (zip215:false) enforces
 *       0 <= S < L always, so this is rejected at the scalar check — proving the strict branch, not the
 *       byte-decode guard, is what defends signature malleability. (Construction from devSys.)
 *  (ii) step-up intent binding — a signature made for (op, resourceA) presented for a DIFFERENT
 *       resource or op returns null. The canonical TLV binds op + resource (AUTH-3), so a step-up is
 *       usable only for the exact (op, resource) it was signed over — no cross-operation reuse.
 */

import { describe, it, expect } from 'vitest';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { canonicalAuthPayload, base64urlEncode, ResourceSchema, type Op, type Scope } from '@deltos/shared';
import { verifySession, verifyStepUp } from '../src/authCrypto.js';

// noble v3 ships no hash — wire SHA-512 once (mirrors authCrypto.ts / the client signer).
if (!ed.hashes.sha512) ed.hashes.sha512 = sha512;

const b64 = base64urlEncode;

// Deterministic test signing keypair (any 32 bytes is a valid Ed25519 secret).
const priv = new Uint8Array(32).fill(7);
const pub = ed.getPublicKey(priv);
const pubB64 = b64(pub);

const AUD = 'deltos.test';
const nonceBytes = new Uint8Array(32).fill(9);
const nonce = b64(nonceBytes);
const challengeId = b64(new Uint8Array(32).fill(1));
const KEY_ID = 'dev-1';

// Ed25519 group order L = 2^252 + 27742317777372353535851937790883648493.
const L = (1n << 252n) + 27742317777372353535851937790883648493n;

const leToBig = (bytes: Uint8Array): bigint => {
  let x = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) x = (x << 8n) | BigInt(bytes[i]);
  return x;
};
const bigToLe = (x: bigint, len: number): Uint8Array => {
  const out = new Uint8Array(len);
  let v = x;
  for (let i = 0; i < len; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
};
const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
};

describe('verifySession — S+L signature malleability (strict zip215:false)', () => {
  const scope: Scope[] = ['read'];
  const message = canonicalAuthPayload({
    purpose: 'session',
    audience: AUD,
    challengeId,
    nonce: nonceBytes,
    keyId: KEY_ID,
    requestedScope: scope,
  });
  const sig = ed.sign(message, priv); // 64 raw bytes: R (32) || S (32, little-endian scalar)

  const session = (signature: string) =>
    verifySession({
      audience: AUD,
      challengeId,
      nonce,
      keyId: KEY_ID,
      requestedScope: scope,
      signature,
      signingPublicKey: pubB64,
    });

  it('sanity: the canonical signature verifies (positive control)', () => {
    expect(session(b64(sig))).toBe(true);
  });

  it('REJECTS a non-canonical S = S + L — 64 well-formed bytes but S >= L (the strict-branch proof)', () => {
    const R = sig.slice(0, 32);
    const S = leToBig(sig.slice(32, 64));
    const malleated = concat(R, bigToLe(S + L, 32)); // S+L < 2^254 → fits 32 LE bytes, but is >= L
    // It is NOT a decode failure — exactly 64 bytes; the strict 0<=S<L scalar check is what rejects it.
    expect(malleated.length).toBe(64);
    expect(session(b64(malleated))).toBe(false);
  });
});

describe('verifyStepUp — intent binding (op + resource), AUTH-3', () => {
  const NOTE_A = ResourceSchema.parse({ kind: 'note', id: '00000000-0000-4000-8000-00000000000a' });
  const NOTE_B = ResourceSchema.parse({ kind: 'note', id: '00000000-0000-4000-8000-00000000000b' });

  const sigFor = (op: Op, resource: typeof NOTE_A) =>
    b64(
      ed.sign(
        canonicalAuthPayload({ purpose: 'step-up', audience: AUD, challengeId, nonce: nonceBytes, keyId: KEY_ID, op, resource }),
        priv,
      ),
    );

  const stepUp = (op: Op, resource: typeof NOTE_A, signature: string) =>
    verifyStepUp({ audience: AUD, challengeId, nonce, keyId: KEY_ID, op, resource, signature, signingPublicKey: pubB64 });

  it('sanity: a step-up verifies for the exact (op, resource) it was signed for (positive control)', () => {
    const v = stepUp('delete', NOTE_A, sigFor('delete', NOTE_A));
    expect(v).not.toBeNull();
    expect(v!.resource).toEqual({ kind: 'note', id: '00000000-0000-4000-8000-00000000000a' });
    expect(v!.op).toBe('delete');
  });

  it('cross-RESOURCE: a step-up signed for note A presented for note B → null', () => {
    expect(stepUp('delete', NOTE_B, sigFor('delete', NOTE_A))).toBeNull();
  });

  it('cross-OP: a step-up signed for op=delete presented as op=read → null', () => {
    expect(stepUp('read', NOTE_A, sigFor('delete', NOTE_A))).toBeNull();
  });
});
