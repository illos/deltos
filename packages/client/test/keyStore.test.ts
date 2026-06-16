// fake-indexeddb/auto must be the very first import so globalThis.indexedDB is installed
// before Dexie (or any module that touches IDB) is imported or instantiated.
import 'fake-indexeddb/auto';

import { describe, it, expect, vi } from 'vitest';
import {
  NotImplementedError,
  createStubKeyStore,
  type KeyStore,
} from '../src/identity/keyStore.js';
import { createWebAuthnKeyStore, type WebAuthnBackend } from '../src/identity/webAuthnKeyStore.js';

/**
 * Characterization tests for the pinned KeyStore interface.
 *
 * There is no concrete implementation yet — these tests lock down the interface contracts
 * so that:
 *   (a) the stub doesn't silently change shape while gruntSys2 builds UI against it, and
 *   (b) devSys has a runnable contract spec to satisfy when the real KeyStore lands.
 *
 * The stub's safe-default sync accessors (isUnlocked / currentIdentity) are load-bearing:
 * the UI uses them for render decisions without a gesture, so they must never become async
 * or throw. When the real implementation lands, swap createStubKeyStore() for it in the
 * tests below — the interface contracts must all still hold.
 */

describe('NotImplementedError', () => {
  it('is an instance of Error', () => {
    expect(new NotImplementedError('someMethod')).toBeInstanceOf(Error);
  });

  it('has name "NotImplementedError" (not the default "Error")', () => {
    expect(new NotImplementedError('someMethod').name).toBe('NotImplementedError');
  });

  it('includes the method name in the message', () => {
    const err = new NotImplementedError('enrollNew');
    expect(err.message).toContain('enrollNew');
  });
});

// Structural type check — the stub must satisfy the full KeyStore interface.
// TypeScript enforces this at compile time; the runtime cast below documents the intent.
describe('createStubKeyStore — interface shape', () => {
  it('returns an object assignable to KeyStore (all methods present)', () => {
    const ks: KeyStore = createStubKeyStore();
    expect(typeof ks.isEnrolled).toBe('function');
    expect(typeof ks.enrollNew).toBe('function');
    expect(typeof ks.enrollExisting).toBe('function');
    expect(typeof ks.unlock).toBe('function');
    expect(typeof ks.lock).toBe('function');
    expect(typeof ks.isUnlocked).toBe('function');
    expect(typeof ks.currentIdentity).toBe('function');
    expect(typeof ks.sign).toBe('function');
    expect(typeof ks.getSigningPublicKey).toBe('function');
  });
});

describe('createStubKeyStore — async methods reject with NotImplementedError', () => {
  // Each async method must reject (not return a value, not throw synchronously) with a
  // NotImplementedError that names the method — so the caller can identify which gate is
  // still a stub without inspecting the stack trace.

  it('isEnrolled() rejects with NotImplementedError naming the method', async () => {
    const ks = createStubKeyStore();
    await expect(ks.isEnrolled()).rejects.toBeInstanceOf(NotImplementedError);
    await expect(ks.isEnrolled()).rejects.toMatchObject({ message: expect.stringContaining('isEnrolled') });
  });

  it('enrollNew() rejects with NotImplementedError naming the method', async () => {
    const ks = createStubKeyStore();
    await expect(ks.enrollNew()).rejects.toBeInstanceOf(NotImplementedError);
    await expect(ks.enrollNew()).rejects.toMatchObject({ message: expect.stringContaining('enrollNew') });
  });

  it('enrollExisting() rejects with NotImplementedError naming the method', async () => {
    const ks = createStubKeyStore();
    await expect(ks.enrollExisting('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about')).rejects.toBeInstanceOf(NotImplementedError);
    await expect(ks.enrollExisting('')).rejects.toMatchObject({ message: expect.stringContaining('enrollExisting') });
  });

  it('unlock() rejects with NotImplementedError naming the method', async () => {
    const ks = createStubKeyStore();
    await expect(ks.unlock()).rejects.toBeInstanceOf(NotImplementedError);
    await expect(ks.unlock()).rejects.toMatchObject({ message: expect.stringContaining('unlock') });
  });

  it('sign() rejects with NotImplementedError naming the method', async () => {
    const ks = createStubKeyStore();
    const bytes = new Uint8Array(32).fill(0xff);
    await expect(ks.sign(bytes)).rejects.toBeInstanceOf(NotImplementedError);
    await expect(ks.sign(bytes)).rejects.toMatchObject({ message: expect.stringContaining('sign') });
  });
});

describe('createStubKeyStore — sync methods that throw', () => {
  // lock() and getSigningPublicKey() are documented as sync throws (not async rejects).
  // This distinction is load-bearing: the caller uses try/catch, not .catch().

  it('lock() throws NotImplementedError synchronously (not a rejected Promise)', () => {
    const ks = createStubKeyStore();
    expect(() => ks.lock()).toThrowError(NotImplementedError);
  });

  it('lock() throw names the method', () => {
    const ks = createStubKeyStore();
    expect(() => ks.lock()).toThrow(expect.objectContaining({ message: expect.stringContaining('lock') }));
  });

  it('getSigningPublicKey() throws NotImplementedError synchronously', () => {
    const ks = createStubKeyStore();
    expect(() => ks.getSigningPublicKey()).toThrowError(NotImplementedError);
  });

  it('getSigningPublicKey() throw names the method', () => {
    const ks = createStubKeyStore();
    expect(() => ks.getSigningPublicKey()).toThrow(expect.objectContaining({ message: expect.stringContaining('getSigningPublicKey') }));
  });
});

describe('createStubKeyStore — safe-default sync accessors (UI render path)', () => {
  // These two must NEVER become async or throw — the UI calls them outside a gesture
  // (no transient activation), at render time, to decide which screen to show.

  it('isUnlocked() returns false (the safe pre-unlock default)', () => {
    const ks = createStubKeyStore();
    expect(ks.isUnlocked()).toBe(false);
  });

  it('isUnlocked() returns a boolean, not a Promise', () => {
    const ks = createStubKeyStore();
    const result = ks.isUnlocked();
    expect(typeof result).toBe('boolean');
  });

  it('currentIdentity() returns null (no identity until real unlock)', () => {
    const ks = createStubKeyStore();
    expect(ks.currentIdentity()).toBeNull();
  });

  it('currentIdentity() returns synchronously (not a Promise)', () => {
    const ks = createStubKeyStore();
    const result = ks.currentIdentity();
    // A Promise would be an object with a .then; null is not.
    expect(result).not.toBeInstanceOf(Promise);
  });

  it('repeated calls are idempotent — the stub carries no state', () => {
    const ks = createStubKeyStore();
    expect(ks.isUnlocked()).toBe(ks.isUnlocked());
    expect(ks.currentIdentity()).toBe(ks.currentIdentity());
  });
});

// ── Concrete WebAuthn provider — secSys custody-security bar ────────────────────────────────────
//
// These tests verify the real KeyStore semantics using an injected fake WebAuthn backend and
// fake-indexeddb (imported above). Each test calls freshKs() which creates a factory instance
// backed by a unique IndexedDB name — no cross-test contamination, no beforeEach clear needed.
//
// ABANDON mnemonic is the canonical BIP39 test vector also used in keyDerivation.test.ts.
// Its frozen Identity.id confirms the F2 accountFingerprint alignment: both client and server
// compute base64urlEncode(SHA-256(signingPublicKey)) using the shared encoding from @deltos/shared.

const ABANDON =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const FROZEN_ID = 'ZIqDVWjXSdI6CQ_HTSFmx0mRGM1LIzgEFMpspKdW11Q';

// Stable fake credential values reused across all fake-backend calls.
const FAKE_CRED_ID = new Uint8Array(16).fill(0xab);
const FAKE_PRF_OUTPUT = new Uint8Array(32).fill(0xcd);

function makeFakeCred(opts: { prf?: boolean } = {}): Credential {
  const { prf = true } = opts;
  return {
    rawId: FAKE_CRED_ID.buffer.slice(0, 16), // clean ArrayBuffer, no byteOffset
    type: 'public-key',
    id: '',
    getClientExtensionResults: () =>
      prf ? { prf: { results: { first: FAKE_PRF_OUTPUT.buffer.slice(0, 32) } } } : {},
  } as unknown as Credential;
}

let _dbSeq = 0;

function freshKs(opts: { prf?: boolean; nullOnGet?: boolean } = {}): KeyStore {
  const { prf = true, nullOnGet = false } = opts;
  const fakeCred = makeFakeCred({ prf });
  const backend: WebAuthnBackend = {
    create: vi.fn().mockResolvedValue(fakeCred),
    get: vi.fn().mockResolvedValue(nullOnGet ? null : fakeCred),
  };
  return createWebAuthnKeyStore({
    backend,
    dbName: `deltos-identity-test-${++_dbSeq}`,
  });
}

// ── Custody bar 1 + 2: lock-state transitions ──────────────────────────────────────────────────

describe('WebAuthn provider — lock-state transitions (custody bar 1 + 2)', () => {
  it('isUnlocked() is false before any enrollment', async () => {
    const ks = freshKs();
    expect(ks.isUnlocked()).toBe(false);
  });

  it('isEnrolled() is false on a fresh store', async () => {
    const ks = freshKs();
    expect(await ks.isEnrolled()).toBe(false);
  });

  it('after enrollNew, the store is unlocked', async () => {
    const ks = freshKs();
    await ks.enrollNew();
    expect(ks.isUnlocked()).toBe(true);
  });

  it('after enrollNew, currentIdentity() returns an Identity with an id', async () => {
    const ks = freshKs();
    await ks.enrollNew();
    expect(ks.currentIdentity()).not.toBeNull();
    expect(typeof ks.currentIdentity()?.id).toBe('string');
  });

  it('lock() flips isUnlocked() to false', async () => {
    const ks = freshKs();
    await ks.enrollNew();
    ks.lock();
    expect(ks.isUnlocked()).toBe(false);
  });

  it('lock() makes currentIdentity() return null', async () => {
    const ks = freshKs();
    await ks.enrollNew();
    ks.lock();
    expect(ks.currentIdentity()).toBeNull();
  });

  it('lock() makes sign() reject (custody bar 2)', async () => {
    const ks = freshKs();
    await ks.enrollNew();
    ks.lock();
    await expect(ks.sign(new Uint8Array(32))).rejects.toBeDefined();
  });

  it('lock() makes getSigningPublicKey() throw synchronously (custody bar 2)', async () => {
    const ks = freshKs();
    await ks.enrollNew();
    ks.lock();
    expect(() => ks.getSigningPublicKey()).toThrow();
  });

  it('unlock() re-enters unlocked state', async () => {
    const ks = freshKs();
    await ks.enrollNew();
    ks.lock();
    const identity = await ks.unlock();
    expect(identity).not.toBeNull();
    expect(ks.isUnlocked()).toBe(true);
  });

  it('unlock() restores the same Identity.id as at enrollment', async () => {
    const ks = freshKs();
    const { identity: enrolledIdentity } = await ks.enrollNew();
    ks.lock();
    const unlockedIdentity = await ks.unlock();
    expect(unlockedIdentity?.id).toBe(enrolledIdentity.id);
  });
});

// ── Custody bar 3: enrollNew footgun guard ─────────────────────────────────────────────────────

describe('WebAuthn provider — enrollNew rejects if already enrolled (custody bar 3)', () => {
  it('second enrollNew() rejects (PIN-ID-8 footgun guard)', async () => {
    const ks = freshKs();
    await ks.enrollNew();
    await expect(ks.enrollNew()).rejects.toBeDefined();
  });

  it('rejection message mentions enrollment state', async () => {
    const ks = freshKs();
    await ks.enrollNew();
    await expect(ks.enrollNew()).rejects.toMatchObject({
      message: expect.stringMatching(/enrolled/i),
    });
  });
});

// ── Custody bar 4: unlock returns null, never throws, on no-match ──────────────────────────────

describe('WebAuthn provider — unlock() returns null on no-match, never throws (custody bar 4)', () => {
  it('unlock() returns null when the WebAuthn ceremony returns null (user cancelled)', async () => {
    const ks = freshKs();
    await ks.enrollNew();
    ks.lock();

    // Backend on get() now returns null (user dismissed the passkey prompt)
    const ksNoMatch = createWebAuthnKeyStore({
      backend: {
        create: vi.fn().mockResolvedValue(makeFakeCred()),
        get: vi.fn().mockResolvedValue(null),
      },
      dbName: `deltos-identity-test-${++_dbSeq}`,
    });
    await ksNoMatch.enrollNew();
    ksNoMatch.lock();
    const result = await ksNoMatch.unlock();
    expect(result).toBeNull();
  });

  it('unlock() returns null on an uninitialized store (no blob)', async () => {
    const ks = freshKs();
    // Never enrolled — unlock must return null, not throw
    const result = await ks.unlock();
    expect(result).toBeNull();
  });

  it('unlock() does not throw — returns null, never rejects', async () => {
    const ks = freshKs({ nullOnGet: true });
    await ks.enrollNew();
    ks.lock();
    // Must resolve (not reject)
    await expect(ks.unlock()).resolves.toBeNull();
  });
});

// ── Custody bar 5: determinism — enrollExisting yields the same Identity.id ───────────────────

describe('WebAuthn provider — determinism (custody bar 5)', () => {
  it('enrollExisting(ABANDON) yields the frozen F2 accountFingerprint (PIN-ID-3 / F2)', async () => {
    const ks = freshKs();
    const identity = await ks.enrollExisting(ABANDON);
    expect(identity.id).toBe(FROZEN_ID);
  });

  it('two fresh stores with the same mnemonic yield identical Identity.id', async () => {
    const ks1 = freshKs();
    const ks2 = freshKs(); // different db name — genuinely fresh
    const id1 = await ks1.enrollExisting(ABANDON);
    const id2 = await ks2.enrollExisting(ABANDON);
    expect(id1.id).toBe(id2.id);
  });

  it('unlock after enrollExisting returns the same Identity.id as enrollment', async () => {
    const ks = freshKs();
    const enrolledId = await ks.enrollExisting(ABANDON);
    ks.lock();
    const unlockedId = await ks.unlock();
    expect(unlockedId?.id).toBe(enrolledId.id);
  });

  it('sign() produces a signature verifiable against getSigningPublicKey()', async () => {
    const ks = freshKs();
    await ks.enrollExisting(ABANDON);
    const msg = new TextEncoder().encode('deltos-auth-v1 challenge');
    const sig = await ks.sign(msg);
    const pub = ks.getSigningPublicKey();

    // Verify via WebCrypto (the server-side verification path, F12)
    const webCryptoPub = await crypto.subtle.importKey(
      'raw', pub, { name: 'Ed25519' }, false, ['verify'],
    );
    expect(await crypto.subtle.verify({ name: 'Ed25519' }, webCryptoPub, sig, msg)).toBe(true);
  });
});

// ── Custody bar 6: no custody leak — only enrollNew returns the mnemonic ──────────────────────

describe('WebAuthn provider — custody-leak negative (custody bar 6)', () => {
  it('enrollNew() returns { identity, mnemonic } — no other fields', async () => {
    const ks = freshKs();
    const result = await ks.enrollNew();
    expect(Object.keys(result).sort()).toEqual(['identity', 'mnemonic']);
  });

  it('mnemonic is a non-empty string (the once-returned secret)', async () => {
    const ks = freshKs();
    const { mnemonic } = await ks.enrollNew();
    expect(typeof mnemonic).toBe('string');
    expect(mnemonic.length).toBeGreaterThan(0);
  });

  it('enrollExisting() returns only Identity (no mnemonic field)', async () => {
    const ks = freshKs();
    const result = await ks.enrollExisting(ABANDON);
    expect(Object.keys(result)).toEqual(['id']);
    expect((result as Record<string, unknown>)['mnemonic']).toBeUndefined();
  });

  it('currentIdentity() returns only { id } — no key material', async () => {
    const ks = freshKs();
    await ks.enrollNew();
    const identity = ks.currentIdentity();
    expect(identity).not.toBeNull();
    expect(Object.keys(identity!)).toEqual(['id']);
  });

  it('unlock() returns only { id } — no key material escapes the custody boundary', async () => {
    const ks = freshKs();
    await ks.enrollNew();
    ks.lock();
    const identity = await ks.unlock();
    expect(identity).not.toBeNull();
    expect(Object.keys(identity!)).toEqual(['id']);
  });

  it('getSigningPublicKey() returns a Uint8Array (not the private seed)', async () => {
    const ks = freshKs();
    await ks.enrollExisting(ABANDON);
    const pub = ks.getSigningPublicKey();
    expect(pub).toBeInstanceOf(Uint8Array);
    expect(pub.length).toBe(32);
    // Public key for ABANDON is the frozen vector — distinct from the private seed
    const { bytesToHex } = await import('@noble/hashes/utils.js');
    expect(bytesToHex(pub)).toBe('d72f09afbc5466596b386cc67c3e1e59baf30f21a329faf3c5ccd3cadac8f3ce');
  });
});
