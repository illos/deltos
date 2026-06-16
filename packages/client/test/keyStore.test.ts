import { describe, it, expect } from 'vitest';
import {
  NotImplementedError,
  createStubKeyStore,
  type KeyStore,
} from '../src/identity/keyStore.js';

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
