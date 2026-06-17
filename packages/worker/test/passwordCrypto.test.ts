import { describe, it, expect } from 'vitest';
import {
  hashPassword,
  verifyPassword,
  dummyHash,
  constantTimeEqual,
  generateRecoveryPhrase,
  hashRecoveryPhrase,
  verifyRecoveryPhrase,
  normalizeRecoveryPhrase,
  base32Lower,
  isPhc,
  UNESTABLISHED_VERIFIER,
  DEFAULT_ARGON2_PARAMS,
} from '../src/passwordCrypto.js';

/**
 * AP-T6 (+ AP-T5 sibling, AP-T10 recovery): the password/recovery crypto contract. Argon2id PHC,
 * pepper-before-hash, constant-time compare, rehash-on-stale-params, recovery verifier keyed to
 * accountId. Uses the SMALLEST sane params so the suite stays fast — the production params + their
 * real-Workers cost are AP-M1's measured gate, not this unit test's concern.
 */

const FAST = { m: 256, t: 1, p: 1 } as const; // tiny — keep the unit suite snappy
const PEPPER = 'test-pepper-worker-secret';

describe('password hashing (Argon2id + pepper + PHC)', () => {
  it('produces a parseable argon2id PHC string with the requested params', () => {
    const phc = hashPassword('correct horse battery staple', PEPPER, FAST);
    expect(phc).toMatch(/^\$argon2id\$v=19\$m=256,t=1,p=1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
  });

  it('verifies a correct password and rejects a wrong one', () => {
    const phc = hashPassword('s3cret-password', PEPPER, FAST);
    expect(verifyPassword('s3cret-password', phc, PEPPER, FAST).ok).toBe(true);
    expect(verifyPassword('wrong-password', phc, PEPPER, FAST).ok).toBe(false);
  });

  it('is salted — the same password hashes to different PHC strings', () => {
    const a = hashPassword('same-password', PEPPER, FAST);
    const b = hashPassword('same-password', PEPPER, FAST);
    expect(a).not.toBe(b);
    expect(verifyPassword('same-password', a, PEPPER, FAST).ok).toBe(true);
    expect(verifyPassword('same-password', b, PEPPER, FAST).ok).toBe(true);
  });

  it('PEPPER is load-bearing — a D1-only leak (PHC, wrong/no pepper) does not verify', () => {
    const phc = hashPassword('p', PEPPER, FAST);
    expect(verifyPassword('p', phc, 'a-different-pepper', FAST).ok).toBe(false);
    expect(verifyPassword('p', phc, '', FAST).ok).toBe(false);
  });

  it('signals needsRehash ONLY when the stored params differ from the target', () => {
    const stale = hashPassword('pw', PEPPER, { m: 256, t: 1, p: 1 });
    // verify with a DIFFERENT target → ok + needsRehash
    const r1 = verifyPassword('pw', stale, PEPPER, { m: 512, t: 1, p: 1 });
    expect(r1.ok).toBe(true);
    expect(r1.needsRehash).toBe(true);
    // verify with the SAME target → ok, no rehash
    const r2 = verifyPassword('pw', stale, PEPPER, { m: 256, t: 1, p: 1 });
    expect(r2.ok).toBe(true);
    expect(r2.needsRehash).toBe(false);
    // a WRONG password never asks for a rehash (no leak of validity via the flag)
    expect(verifyPassword('nope', stale, PEPPER, { m: 512, t: 1, p: 1 })).toEqual({
      ok: false,
      needsRehash: false,
    });
  });

  it('a malformed PHC fails closed (false, never throws)', () => {
    for (const bad of ['', 'not-a-phc', '$argon2id$v=19$m=1$x$y', '$scrypt$v=19$m=256,t=1,p=1$a$b']) {
      expect(() => verifyPassword('x', bad, PEPPER, FAST)).not.toThrow();
      expect(verifyPassword('x', bad, PEPPER, FAST).ok).toBe(false);
    }
  });

  it('dummyHash runs without throwing (the unknown-user timing-parity path)', () => {
    expect(() => dummyHash('whatever', PEPPER, FAST)).not.toThrow();
  });
});

describe('isPhc / UNESTABLISHED_VERIFIER (Option-B sentinel invariant)', () => {
  it('the sentinel is NEVER a parseable PHC — recoveryEstablished can never falsely imply a verifier', () => {
    // secSys-required pin: parsePhc(sentinel) === null (asserted via the exported predicate).
    expect(isPhc(UNESTABLISHED_VERIFIER)).toBe(false);
    expect(isPhc('')).toBe(false);
    expect(isPhc('not-a-phc')).toBe(false);
    expect(isPhc('$scrypt$v=19$m=256,t=1,p=1$a$b')).toBe(false);
  });
  it('a real Argon2id verifier IS a parseable PHC', () => {
    expect(isPhc(hashPassword('pw', PEPPER, FAST))).toBe(true);
    expect(isPhc(hashRecoveryPhrase(generateRecoveryPhrase(), 'acct', PEPPER, FAST))).toBe(true);
  });
});

describe('constantTimeEqual', () => {
  it('is true only for equal-length, equal-content arrays', () => {
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });
});

describe('recovery phrase (Argon2id verifier keyed to accountId)', () => {
  it('mints a grouped, high-entropy, ≥128-bit phrase', () => {
    const phrase = generateRecoveryPhrase();
    expect(phrase).toMatch(/^[a-z2-7]{4}(-[a-z2-7]{4})+$/);
    // 160 bits / 5 bits-per-char = 32 base32 chars of entropy
    expect(normalizeRecoveryPhrase(phrase).length).toBe(32);
    expect(generateRecoveryPhrase()).not.toBe(generateRecoveryPhrase());
  });

  it('verifies the right phrase for the right account and is tolerant of casing/grouping', () => {
    const acct = 'acct-abc';
    const phrase = generateRecoveryPhrase();
    const phc = hashRecoveryPhrase(phrase, acct, PEPPER, FAST);
    expect(verifyRecoveryPhrase(phrase, acct, phc, PEPPER)).toBe(true);
    // re-typed UPPERCASE without hyphens still verifies (normalized)
    expect(verifyRecoveryPhrase(phrase.toUpperCase().replace(/-/g, ''), acct, phc, PEPPER)).toBe(true);
  });

  it('is KEYED to accountId — the same phrase does NOT verify under another account', () => {
    const phrase = generateRecoveryPhrase();
    const phc = hashRecoveryPhrase(phrase, 'acct-A', PEPPER, FAST);
    expect(verifyRecoveryPhrase(phrase, 'acct-A', phc, PEPPER)).toBe(true);
    expect(verifyRecoveryPhrase(phrase, 'acct-B', phc, PEPPER)).toBe(false);
  });

  it('rejects a wrong phrase', () => {
    const phc = hashRecoveryPhrase(generateRecoveryPhrase(), 'acct', PEPPER, FAST);
    expect(verifyRecoveryPhrase(generateRecoveryPhrase(), 'acct', phc, PEPPER)).toBe(false);
  });
});

describe('base32Lower', () => {
  it('matches RFC 4648 test vectors (lowercase, no padding)', () => {
    const enc = (s: string) => base32Lower(new TextEncoder().encode(s));
    expect(enc('')).toBe('');
    expect(enc('f')).toBe('my');
    expect(enc('fo')).toBe('mzxq');
    expect(enc('foo')).toBe('mzxw6');
    expect(enc('foob')).toBe('mzxw6yq');
    expect(enc('fooba')).toBe('mzxw6ytb');
    expect(enc('foobar')).toBe('mzxw6ytboi');
  });
});

void DEFAULT_ARGON2_PARAMS;
