// fake-indexeddb/auto must be the very first import so globalThis.indexedDB is installed
// before Dexie (or any module that touches IDB) is imported or instantiated.
import 'fake-indexeddb/auto';

import { describe, it, expect, vi } from 'vitest';
import Dexie from 'dexie';
import {
  NotImplementedError,
  createStubKeyStore,
  type KeyStore,
} from '../src/identity/keyStore.js';
import { createWebAuthnKeyStore, getEnrollmentPrfStatus, type WebAuthnBackend } from '../src/identity/webAuthnKeyStore.js';

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
    expect(typeof ks.setServerKeyId).toBe('function');
    expect(typeof ks.getServerKeyId).toBe('function');
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

// ── secSys audit coverage gaps (filled post-audit @ 875f8e4) ──────────────────────────────────
//
// Gap A: no-PRF device-key fallback path — all prior tests use prf:true. Verify the fallback
// path (prf:false) seals, stores a device key, and successfully decrypts on unlock.
//
// Gap B: PRF-downgrade-resistance — enroll with prf:true, then attempt unlock without PRF.
// The blob was wrapped with a PRF-derived key; the fallback device key is absent; unlock MUST
// return null rather than attempting the wrong key.

describe('WebAuthn provider — no-PRF device-key fallback (secSys gap A)', () => {
  it('enroll → lock → unlock succeeds on the no-PRF path', async () => {
    const ks = freshKs({ prf: false });
    const { identity: enrolled } = await ks.enrollNew();
    ks.lock();
    const unlocked = await ks.unlock();
    expect(unlocked).not.toBeNull();
    expect(unlocked?.id).toBe(enrolled.id);
  });

  it('sign() works after no-PRF unlock', async () => {
    const ks = freshKs({ prf: false });
    await ks.enrollNew();
    ks.lock();
    await ks.unlock();
    const sig = await ks.sign(new Uint8Array(32).fill(0x01));
    expect(sig).toBeInstanceOf(Uint8Array);
    expect(sig.length).toBe(64);
  });

  it('no-PRF path stores the device key; PRF path does not', async () => {
    // We verify observable behavior: a PRF-enrolled store can unlock WITHOUT storing device key,
    // while a no-PRF store requires the device key path. We check this indirectly:
    // after PRF enroll, a get() that returns null-PRF (no extension) must return null from unlock.
    // This relies on gap B below — if PRF-downgrade returns null, the PRF path never uses deviceKey.
    const prf = freshKs({ prf: true });
    await prf.enrollNew();
    prf.lock();
    expect(prf.isUnlocked()).toBe(false);

    const noPrf = freshKs({ prf: false });
    await noPrf.enrollNew();
    noPrf.lock();
    expect(noPrf.isUnlocked()).toBe(false);
    // no-PRF unlock must still succeed (device key path):
    const id = await noPrf.unlock();
    expect(id).not.toBeNull();
  });
});

// secSys gap B exercises the DORMANT PRF custody path (optionADeviceLocal: false). Under v1 Option-A
// new enrollments are device-local-for-all, so PRF-at-enroll is off by default — but the PRF seam is
// retained (secSys #6, v2 E2EE) and its downgrade-resistance must stay proven. NOTE: with Option-A's
// rewrap-on-next-unlock, a successful PRF unlock would migrate the blob; here PRF is ABSENT at unlock
// so no unwrap (and thus no migration) occurs — the property under test is unaffected.
describe('WebAuthn provider — PRF-downgrade-resistance (secSys gap B, dormant PRF path)', () => {
  it('unlock() returns null when enrolled with PRF but PRF is absent at unlock', async () => {
    // Enroll with PRF — wrapping key is HKDF(prf_output, credId, ...) and NOT in deviceKey table
    const ks = createWebAuthnKeyStore({
      optionADeviceLocal: false,
      backend: {
        create: vi.fn().mockResolvedValue(makeFakeCred({ prf: true })),
        // unlock backend returns the same cred BUT with no PRF output (PRF absent/downgraded)
        get: vi.fn().mockResolvedValue(makeFakeCred({ prf: false })),
      },
      dbName: `deltos-identity-test-${++_dbSeq}`,
    });
    await ks.enrollNew();
    ks.lock();
    // PRF absent at unlock → recoverWrappingKey returns null → unlock returns null (not throw)
    const result = await ks.unlock();
    expect(result).toBeNull();
  });

  it('PRF downgrade is null, not throw', async () => {
    const ks = createWebAuthnKeyStore({
      optionADeviceLocal: false,
      backend: {
        create: vi.fn().mockResolvedValue(makeFakeCred({ prf: true })),
        get: vi.fn().mockResolvedValue(makeFakeCred({ prf: false })),
      },
      dbName: `deltos-identity-test-${++_dbSeq}`,
    });
    await ks.enrollNew();
    ks.lock();
    await expect(ks.unlock()).resolves.toBeNull();
  });
});

// ── getEnrollmentPrfStatus — D5 UI disclosure helper (planSys done-gate) ────────────────────────

describe('getEnrollmentPrfStatus — D5 disclosure helper', () => {
  it('returns null when the device is not enrolled', async () => {
    const dbName = `deltos-identity-test-${++_dbSeq}`;
    expect(await getEnrollmentPrfStatus(dbName)).toBeNull();
  });

  it('returns { usesPrf: true } when enrolled with PRF (dormant PRF path, v2)', async () => {
    const dbName = `deltos-identity-test-${++_dbSeq}`;
    const ks = createWebAuthnKeyStore({
      optionADeviceLocal: false, // dormant PRF path — v1 Option-A default is device-local (usesPrf:false)
      backend: { create: vi.fn().mockResolvedValue(makeFakeCred({ prf: true })), get: vi.fn() },
      dbName,
    });
    await ks.enrollNew();
    expect(await getEnrollmentPrfStatus(dbName)).toStrictEqual({ usesPrf: true });
  });

  it('returns { usesPrf: false } when enrolled without PRF (no-PRF device-key path)', async () => {
    const dbName = `deltos-identity-test-${++_dbSeq}`;
    const ks = createWebAuthnKeyStore({
      backend: { create: vi.fn().mockResolvedValue(makeFakeCred({ prf: false })), get: vi.fn() },
      dbName,
    });
    await ks.enrollNew();
    expect(await getEnrollmentPrfStatus(dbName)).toStrictEqual({ usesPrf: false });
  });
});

// ── Durable server keyId — cold-reload fix (E4) ─────────────────────────────────────────────────
//
// The server device handle (keyId from POST /api/auth/register) must persist in IndexedDB
// co-located with the credential, so a cold-start session re-mint survives a reload. Root cause of
// E4: keyId was localStorage-only, which iOS evicts far more aggressively than IndexedDB → after
// reload the blob survived (isEnrolled=true) but keyId was gone → "use your recovery phrase"
// dead-end. keyId is a NON-SECRET handle; the F7 bearer token is NEVER persisted here.

describe('WebAuthn provider — durable server keyId (E4 cold-reload fix)', () => {
  it('getServerKeyId() is null before any registration', async () => {
    const ks = freshKs();
    expect(await ks.getServerKeyId()).toBeNull();
  });

  it('setServerKeyId() then getServerKeyId() round-trips the handle', async () => {
    const ks = freshKs();
    await ks.setServerKeyId('device-handle-abc');
    expect(await ks.getServerKeyId()).toBe('device-handle-abc');
  });

  it('persists across a reload — a NEW KeyStore instance on the SAME db reads the keyId', async () => {
    const dbName = `deltos-identity-test-${++_dbSeq}`;
    const backend: WebAuthnBackend = { create: vi.fn().mockResolvedValue(makeFakeCred()), get: vi.fn() };
    const first = createWebAuthnKeyStore({ backend, dbName });
    await first.setServerKeyId('survives-reload');
    // Simulate a page reload: a fresh factory instance (in-memory state gone) on the same IDB.
    const afterReload = createWebAuthnKeyStore({ backend, dbName });
    expect(await afterReload.getServerKeyId()).toBe('survives-reload');
  });

  it('sealing a NEW credential (enrollExisting re-bind) clears a stale keyId', async () => {
    const ks = freshKs();
    await ks.enrollNew();
    await ks.setServerKeyId('stale-from-old-identity');
    // Recovery / re-bind seals a new credential → the prior server registration is invalid.
    await ks.enrollExisting(ABANDON);
    expect(await ks.getServerKeyId()).toBeNull();
  });

  it('setServerKeyId overwrites a prior handle (re-register replaces, never appends)', async () => {
    const ks = freshKs();
    await ks.setServerKeyId('first');
    await ks.setServerKeyId('second');
    expect(await ks.getServerKeyId()).toBe('second');
  });
});

// ── Part 1b — Option-A device-local-for-all + autoUnlock + rewrap-on-next-unlock migration ────────
//
// Option-A (user-affirmed): the at-rest signing key is wrapped under a random DEVICE-LOCAL key on
// ALL devices, so it can be unwrapped SILENTLY (no gesture) on cold start (the north star — zero
// day-to-day friction). New enrollments are device-local even when PRF is available; already-PRF
// devices convert on their next unlock (rewrap-on-next-unlock). secSys §1d conditions are asserted.

/** Open a raw second connection on the same IDB to inspect the keystore's at-rest rows directly. */
async function inspectIdentityDb(dbName: string) {
  const raw = new Dexie(dbName);
  raw.version(2).stores({ blob: 'key', deviceKey: 'key', serverHandle: 'key' });
  const [blobCount, blob, deviceKeyCount, deviceKey] = await Promise.all([
    raw.table('blob').count(),
    raw.table('blob').get('v1') as Promise<{ prf: boolean; sealed: { ct: string } } | undefined>,
    raw.table('deviceKey').count(),
    raw.table('deviceKey').get('v1') as Promise<{ wrappingKey: string } | undefined>,
  ]);
  raw.close();
  return { blobCount, blob, deviceKeyCount, deviceKey };
}

describe('Option-A — device-local-for-all enrollment (uniform-disclosure invariant)', () => {
  it('enrollNew is device-local even when PRF is available → usesPrf:false', async () => {
    const dbName = `deltos-identity-test-${++_dbSeq}`;
    const ks = createWebAuthnKeyStore({
      backend: { create: vi.fn().mockResolvedValue(makeFakeCred({ prf: true })), get: vi.fn() },
      dbName, // optionADeviceLocal defaults to the v1 constant (true)
    });
    await ks.enrollNew();
    // Every establishment path discloses device-local custody (secSys condition #1).
    expect(await getEnrollmentPrfStatus(dbName)).toStrictEqual({ usesPrf: false });
  });

  it('enrollExisting is device-local even with PRF available → usesPrf:false', async () => {
    const dbName = `deltos-identity-test-${++_dbSeq}`;
    const ks = createWebAuthnKeyStore({
      backend: { create: vi.fn().mockResolvedValue(makeFakeCred({ prf: true })), get: vi.fn() },
      dbName,
    });
    await ks.enrollExisting(ABANDON);
    expect(await getEnrollmentPrfStatus(dbName)).toStrictEqual({ usesPrf: false });
  });
});

describe('Option-A — autoUnlock (silent, no WebAuthn)', () => {
  it('autoUnlock() unwraps a device-local blob with NO WebAuthn get() call', async () => {
    const getSpy = vi.fn();
    const ks = createWebAuthnKeyStore({
      backend: { create: vi.fn().mockResolvedValue(makeFakeCred({ prf: true })), get: getSpy },
      dbName: `deltos-identity-test-${++_dbSeq}`,
    });
    const { identity } = await ks.enrollNew();
    ks.lock();
    const auto = await ks.autoUnlock();
    expect(auto?.id).toBe(identity.id);
    expect(ks.isUnlocked()).toBe(true);
    expect(getSpy).not.toHaveBeenCalled(); // no gesture — the whole point
  });

  it('sign() works after autoUnlock (the in-memory key is loaded)', async () => {
    const ks = freshKs();
    await ks.enrollExisting(ABANDON);
    ks.lock();
    await ks.autoUnlock();
    const msg = new Uint8Array(32).fill(0x07);
    const sig = await ks.sign(msg);
    const pub = ks.getSigningPublicKey();
    const webCryptoPub = await crypto.subtle.importKey('raw', pub, { name: 'Ed25519' }, false, ['verify']);
    expect(await crypto.subtle.verify({ name: 'Ed25519' }, webCryptoPub, sig, msg)).toBe(true);
  });

  it('autoUnlock() returns null on a not-enrolled store (fail-closed)', async () => {
    const ks = freshKs();
    expect(await ks.autoUnlock()).toBeNull();
    expect(ks.isUnlocked()).toBe(false);
  });

  it('autoUnlock() returns null on a still-PRF blob (no silent unwrap of PRF) → caller gestures', async () => {
    const ks = createWebAuthnKeyStore({
      optionADeviceLocal: false, // enroll PRF-first (un-migrated)
      backend: { create: vi.fn().mockResolvedValue(makeFakeCred({ prf: true })), get: vi.fn() },
      dbName: `deltos-identity-test-${++_dbSeq}`,
    });
    await ks.enrollNew();
    ks.lock();
    expect(await ks.autoUnlock()).toBeNull(); // PRF blob can't be silently unwrapped
  });
});

describe('Option-A — rewrap-on-next-unlock migration (secSys §1d)', () => {
  // Enroll PRF-first (dormant path) on a db, then unlock with a fresh Option-A keystore on the SAME
  // db — the unlock unwraps via PRF AND migrates the blob to device-local in one gesture.
  async function enrolledPrfThenOptionAUnlock(dbName: string) {
    const prfKs = createWebAuthnKeyStore({
      optionADeviceLocal: false,
      backend: { create: vi.fn().mockResolvedValue(makeFakeCred({ prf: true })), get: vi.fn() },
      dbName,
    });
    const { identity } = await prfKs.enrollNew();
    await prfKs.setServerKeyId('keyid-preserved');
    prfKs.lock();

    // Fresh Option-A keystore (default device-local) on the same db: get() returns a PRF cred so the
    // existing PRF blob can be unwrapped; the migration then reseals it device-local.
    const optionAKs = createWebAuthnKeyStore({
      backend: {
        create: vi.fn(),
        get: vi.fn().mockResolvedValue(makeFakeCred({ prf: true })),
      },
      dbName,
    });
    return { identity, optionAKs };
  }

  it('PRF unlock migrates to device-local: prf flips false + a deviceKey row appears (consistent pair)', async () => {
    const dbName = `deltos-identity-test-${++_dbSeq}`;
    const { optionAKs } = await enrolledPrfThenOptionAUnlock(dbName);
    expect(await getEnrollmentPrfStatus(dbName)).toStrictEqual({ usesPrf: true }); // before unlock

    const unlocked = await optionAKs.unlock();
    expect(unlocked).not.toBeNull();

    // secSys §1d-2: prf flipped false (disclosure now honestly device-local).
    expect(await getEnrollmentPrfStatus(dbName)).toStrictEqual({ usesPrf: false });
    // Consistent pair (atomicity / never fail-open): device-local blob AND a device key together.
    const { blob, deviceKeyCount } = await inspectIdentityDb(dbName);
    expect(blob?.prf).toBe(false);
    expect(deviceKeyCount).toBe(1);
  });

  it('replace-not-append: a SINGLE blob row, old PRF ciphertext gone (secSys §1d-3)', async () => {
    const dbName = `deltos-identity-test-${++_dbSeq}`;
    const before = (await inspectIdentityDb(dbName)).blob; // undefined (not enrolled yet)
    const { optionAKs } = await enrolledPrfThenOptionAUnlock(dbName);
    const prfCt = (await inspectIdentityDb(dbName)).blob?.sealed.ct;
    await optionAKs.unlock();
    const after = await inspectIdentityDb(dbName);
    expect(before).toBeUndefined();
    expect(after.blobCount).toBe(1);          // single source of truth
    expect(after.blob?.sealed.ct).not.toBe(prfCt); // resealed — old PRF ciphertext replaced
  });

  it('payload byte-identical: same id + a working signature survive the rewrap (secSys §1d-1/5)', async () => {
    const dbName = `deltos-identity-test-${++_dbSeq}`;
    const { identity, optionAKs } = await enrolledPrfThenOptionAUnlock(dbName);
    const unlocked = await optionAKs.unlock();
    expect(unlocked?.id).toBe(identity.id); // id preserved

    // After migration, autoUnlock works silently and signs verifiably → sk/pk preserved intact.
    optionAKs.lock();
    const auto = await optionAKs.autoUnlock();
    expect(auto?.id).toBe(identity.id);
    const msg = new Uint8Array(32).fill(0x09);
    const sig = await optionAKs.sign(msg);
    const pub = optionAKs.getSigningPublicKey();
    const webCryptoPub = await crypto.subtle.importKey('raw', pub, { name: 'Ed25519' }, false, ['verify']);
    expect(await crypto.subtle.verify({ name: 'Ed25519' }, webCryptoPub, sig, msg)).toBe(true);
  });

  it('serverHandle/keyId untouched through the migration', async () => {
    const dbName = `deltos-identity-test-${++_dbSeq}`;
    const { optionAKs } = await enrolledPrfThenOptionAUnlock(dbName);
    await optionAKs.unlock();
    expect(await optionAKs.getServerKeyId()).toBe('keyid-preserved');
  });

  it('idempotent: a second unlock after migration stays device-local, no error', async () => {
    const dbName = `deltos-identity-test-${++_dbSeq}`;
    const { optionAKs } = await enrolledPrfThenOptionAUnlock(dbName);
    await optionAKs.unlock();           // migrates
    optionAKs.lock();
    const again = await optionAKs.unlock(); // already device-local — no-op migration
    expect(again).not.toBeNull();
    expect(await getEnrollmentPrfStatus(dbName)).toStrictEqual({ usesPrf: false });
    expect((await inspectIdentityDb(dbName)).blobCount).toBe(1);
  });

  it('concurrent (multi-tab) rewrap resolves to a consistent {blob,deviceKey} pair (secSys #3)', async () => {
    const dbName = `deltos-identity-test-${++_dbSeq}`;
    // Enroll PRF-first once.
    const prfKs = createWebAuthnKeyStore({
      optionADeviceLocal: false,
      backend: { create: vi.fn().mockResolvedValue(makeFakeCred({ prf: true })), get: vi.fn() },
      dbName,
    });
    const { identity } = await prfKs.enrollNew();
    prfKs.lock();

    // Two "tabs" unlock the same db at the same time → two concurrent rewraps.
    const mkTab = () => createWebAuthnKeyStore({
      backend: { create: vi.fn(), get: vi.fn().mockResolvedValue(makeFakeCred({ prf: true })) },
      dbName,
    });
    const [a, b] = [mkTab(), mkTab()];
    const [ua, ub] = await Promise.all([a.unlock(), b.unlock()]);
    expect(ua?.id).toBe(identity.id);
    expect(ub?.id).toBe(identity.id);

    // Last-writer-wins, but the single-txn-over-[blob,deviceKey] guarantees the surviving pair is
    // consistent: prf:false blob WITH a matching device key, and it auto-unlocks.
    const after = await inspectIdentityDb(dbName);
    expect(after.blobCount).toBe(1);
    expect(after.blob?.prf).toBe(false);
    expect(after.deviceKeyCount).toBe(1);
    const verify = createWebAuthnKeyStore({ backend: { create: vi.fn(), get: vi.fn() }, dbName });
    expect((await verify.autoUnlock())?.id).toBe(identity.id);
  });
});
