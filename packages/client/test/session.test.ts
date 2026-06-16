// fake-indexeddb/auto first — must precede any Dexie import
import 'fake-indexeddb/auto';

import { describe, it, expect, vi } from 'vitest';
import { base64urlEncode } from '@deltos/shared';
import { buildSessionRequest } from '../src/identity/session.js';
import { createWebAuthnKeyStore } from '../src/identity/webAuthnKeyStore.js';
import type { KeyStore } from '../src/identity/keyStore.js';
import type { Scope } from '@deltos/shared';

/**
 * Tests for buildSessionRequest — the client-side session-mint ceremony.
 *
 * The 'session' purpose: requires a keyId (device is registered), declares a requested scope
 * set. Scope canonicalisation (R3-3 sort+dedup) happens inside canonicalAuthPayload, so the
 * client need not pre-sort.
 */

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────────

const FAKE_NONCE = base64urlEncode(new Uint8Array(32).fill(0x55));
const FAKE_CHALLENGE_ID = base64urlEncode(new Uint8Array(32).fill(0x66));

const FAKE_CHALLENGE_RESP = {
  challengeId: FAKE_CHALLENGE_ID,
  nonce: FAKE_NONCE,
  expiresAt: '2099-01-01T00:00:00.000Z',
  expiresAtMs: 4102444800000,
};

const TEST_KEY_ID = 'key-abc-123';
const TEST_AUDIENCE = 'test.deltos.local';
const TEST_SCOPE: Scope[] = ['read', 'write'];

// ── Minimal stub KeyStore ──────────────────────────────────────────────────────────────────────

const FAKE_SIG = new Uint8Array(64).fill(0xab);

function makeLockedStub(): KeyStore {
  return {
    isEnrolled: () => Promise.resolve(false),
    enrollNew: () => Promise.reject(new Error('stub')),
    enrollExisting: () => Promise.reject(new Error('stub')),
    unlock: () => Promise.reject(new Error('stub')),
    lock: () => undefined,
    isUnlocked: () => false,
    currentIdentity: () => null,
    sign: () => Promise.reject(new Error('locked')),
    getSigningPublicKey: () => { throw new Error('locked'); },
  };
}

function makeUnlockedStub(signResult?: Uint8Array): KeyStore {
  return {
    isEnrolled: () => Promise.resolve(true),
    enrollNew: () => Promise.reject(new Error('stub')),
    enrollExisting: () => Promise.reject(new Error('stub')),
    unlock: () => Promise.reject(new Error('stub')),
    lock: () => undefined,
    isUnlocked: () => true,
    currentIdentity: () => ({ id: 'stub-id' }),
    sign: (_challenge) => Promise.resolve(signResult ?? FAKE_SIG),
    getSigningPublicKey: () => new Uint8Array(32).fill(0x77),
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────

function mockChallengeOk(body = FAKE_CHALLENGE_RESP): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: () => Promise.resolve(body),
  } as unknown as Response);
}

function mockChallengeError(status = 503): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    statusText: 'Service Unavailable',
    json: () => Promise.resolve({}),
  } as unknown as Response);
}

// ── Tests: guard rails ───────────────────────────────────────────────────────────────────────────

describe('buildSessionRequest — locked KeyStore', () => {
  it('throws without fetching a challenge when the KeyStore is locked', async () => {
    const fetchFn = mockChallengeOk();
    await expect(
      buildSessionRequest(
        { keyStore: makeLockedStub(), keyId: TEST_KEY_ID, requestedScope: TEST_SCOPE, audience: TEST_AUDIENCE },
        fetchFn,
      ),
    ).rejects.toMatchObject({ message: expect.stringMatching(/unlocked/i) });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

// ── Tests: challenge request ─────────────────────────────────────────────────────────────────────

describe('buildSessionRequest — challenge fetch', () => {
  it('POSTs to /api/auth/challenge with purpose:session AND keyId', async () => {
    const fetchFn = mockChallengeOk();
    await buildSessionRequest(
      { keyStore: makeUnlockedStub(), keyId: TEST_KEY_ID, requestedScope: TEST_SCOPE, audience: TEST_AUDIENCE },
      fetchFn,
    );
    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/auth/challenge');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as unknown;
    expect(body).toStrictEqual({ purpose: 'session', keyId: TEST_KEY_ID });
  });

  it('throws on a non-2xx challenge response', async () => {
    await expect(
      buildSessionRequest(
        { keyStore: makeUnlockedStub(), keyId: TEST_KEY_ID, requestedScope: TEST_SCOPE, audience: TEST_AUDIENCE },
        mockChallengeError(503),
      ),
    ).rejects.toMatchObject({ message: expect.stringMatching(/503/) });
  });

  it('throws when challenge response body fails schema validation', async () => {
    const badFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.resolve({ challengeId: 'short', nonce: 'also-short', expiresAt: '', expiresAtMs: 0 }),
    } as unknown as Response);
    await expect(
      buildSessionRequest(
        { keyStore: makeUnlockedStub(), keyId: TEST_KEY_ID, requestedScope: TEST_SCOPE, audience: TEST_AUDIENCE },
        badFetch,
      ),
    ).rejects.toBeDefined();
  });
});

// ── Tests: AUTH-1 freshness ─────────────────────────────────────────────────────────────────────

describe('buildSessionRequest — freshness guard (AUTH-1)', () => {
  it('throws when the challenge is already expired (expiresAtMs in the past)', async () => {
    const expiredResp = { ...FAKE_CHALLENGE_RESP, expiresAtMs: 1 };
    await expect(
      buildSessionRequest(
        { keyStore: makeUnlockedStub(), keyId: TEST_KEY_ID, requestedScope: TEST_SCOPE, audience: TEST_AUDIENCE },
        mockChallengeOk(expiredResp),
        () => 1000,
      ),
    ).rejects.toMatchObject({ message: expect.stringMatching(/expired/i) });
  });

  it('proceeds when expiresAtMs is in the future', async () => {
    const futureResp = { ...FAKE_CHALLENGE_RESP, expiresAtMs: 9_000_000_000_000 };
    await expect(
      buildSessionRequest(
        { keyStore: makeUnlockedStub(), keyId: TEST_KEY_ID, requestedScope: TEST_SCOPE, audience: TEST_AUDIENCE },
        mockChallengeOk(futureResp),
        () => 1000,
      ),
    ).resolves.toBeDefined();
  });

  it('does NOT compare expiresAt (string) — only expiresAtMs triggers expiry', async () => {
    const mixedResp = { ...FAKE_CHALLENGE_RESP, expiresAt: '2000-01-01T00:00:00.000Z', expiresAtMs: 9_000_000_000_000 };
    await expect(
      buildSessionRequest(
        { keyStore: makeUnlockedStub(), keyId: TEST_KEY_ID, requestedScope: TEST_SCOPE, audience: TEST_AUDIENCE },
        mockChallengeOk(mixedResp),
        () => 1000,
      ),
    ).resolves.toBeDefined();
  });
});

// ── Tests: output shape ──────────────────────────────────────────────────────────────────────────

describe('buildSessionRequest — output', () => {
  it('returns the challengeId from the server response', async () => {
    const result = await buildSessionRequest(
      { keyStore: makeUnlockedStub(), keyId: TEST_KEY_ID, requestedScope: TEST_SCOPE, audience: TEST_AUDIENCE },
      mockChallengeOk(),
    );
    expect(result.challengeId).toBe(FAKE_CHALLENGE_ID);
  });

  it('returns the correct keyId', async () => {
    const result = await buildSessionRequest(
      { keyStore: makeUnlockedStub(), keyId: TEST_KEY_ID, requestedScope: TEST_SCOPE, audience: TEST_AUDIENCE },
      mockChallengeOk(),
    );
    expect(result.keyId).toBe(TEST_KEY_ID);
  });

  it('returns the requestedScope array', async () => {
    const result = await buildSessionRequest(
      { keyStore: makeUnlockedStub(), keyId: TEST_KEY_ID, requestedScope: TEST_SCOPE, audience: TEST_AUDIENCE },
      mockChallengeOk(),
    );
    expect(result.requestedScope).toEqual(expect.arrayContaining(TEST_SCOPE));
    expect(result.requestedScope.length).toBe(TEST_SCOPE.length);
  });

  it('signature is a 64-byte base64url string (Ed25519 output length)', async () => {
    const result = await buildSessionRequest(
      { keyStore: makeUnlockedStub(), keyId: TEST_KEY_ID, requestedScope: TEST_SCOPE, audience: TEST_AUDIENCE },
      mockChallengeOk(),
    );
    expect(result.signature.length).toBe(86); // base64url of 64 bytes = 86 chars, no padding
    expect(/^[A-Za-z0-9_-]+$/.test(result.signature)).toBe(true);
  });

  it('SessionRequest output passes its own Zod schema (belt-and-suspenders)', async () => {
    const { SessionRequestSchema } = await import('@deltos/shared');
    const result = await buildSessionRequest(
      { keyStore: makeUnlockedStub(), keyId: TEST_KEY_ID, requestedScope: TEST_SCOPE, audience: TEST_AUDIENCE },
      mockChallengeOk(),
    );
    expect(() => SessionRequestSchema.parse(result)).not.toThrow();
  });
});

// ── Tests: scope canonicalisation (R3-3) ─────────────────────────────────────────────────────────

describe('buildSessionRequest — scope set canonicalisation (R3-3)', () => {
  it('produces the same canonical payload bytes regardless of input scope order', async () => {
    // Capture the exact bytes the KeyStore.sign() receives for two orderings of the same scope set.
    let capturedPayload1: Uint8Array | undefined;
    let capturedPayload2: Uint8Array | undefined;

    const stubCapture1 = makeUnlockedStub();
    stubCapture1.sign = (payload) => { capturedPayload1 = payload; return Promise.resolve(FAKE_SIG); };

    const stubCapture2 = makeUnlockedStub();
    stubCapture2.sign = (payload) => { capturedPayload2 = payload; return Promise.resolve(FAKE_SIG); };

    await buildSessionRequest(
      { keyStore: stubCapture1, keyId: TEST_KEY_ID, requestedScope: ['write', 'read'], audience: TEST_AUDIENCE },
      mockChallengeOk(),
    );
    await buildSessionRequest(
      { keyStore: stubCapture2, keyId: TEST_KEY_ID, requestedScope: ['read', 'write'], audience: TEST_AUDIENCE },
      mockChallengeOk(),
    );

    expect(capturedPayload1).toBeDefined();
    expect(capturedPayload2).toBeDefined();
    expect(capturedPayload1).toEqual(capturedPayload2);
  });

  it('deduplicates repeated scopes in the canonical payload', async () => {
    let capturedNormal: Uint8Array | undefined;
    let capturedDuped: Uint8Array | undefined;

    const stub1 = makeUnlockedStub();
    stub1.sign = (p) => { capturedNormal = p; return Promise.resolve(FAKE_SIG); };

    const stub2 = makeUnlockedStub();
    stub2.sign = (p) => { capturedDuped = p; return Promise.resolve(FAKE_SIG); };

    await buildSessionRequest(
      { keyStore: stub1, keyId: TEST_KEY_ID, requestedScope: ['read', 'write'], audience: TEST_AUDIENCE },
      mockChallengeOk(),
    );
    await buildSessionRequest(
      { keyStore: stub2, keyId: TEST_KEY_ID, requestedScope: ['read', 'write', 'read', 'write'], audience: TEST_AUDIENCE },
      mockChallengeOk(),
    );

    expect(capturedNormal).toEqual(capturedDuped);
  });
});

// ── Integration: real Ed25519 signature is verifiable ────────────────────────────────────────────

describe('buildSessionRequest — integration (real KeyStore + canonical payload)', () => {
  const FAKE_CRED_ID = new Uint8Array(16).fill(0x55);
  const FAKE_PRF_OUTPUT = new Uint8Array(32).fill(0x66);
  let _dbSeq = 300; // offset from other test files to avoid name collisions

  function makeRealKs() {
    const fakeCred = {
      rawId: FAKE_CRED_ID.buffer.slice(0, 16),
      type: 'public-key',
      id: '',
      getClientExtensionResults: () => ({ prf: { results: { first: FAKE_PRF_OUTPUT.buffer.slice(0, 32) } } }),
      response: null,
    } as unknown as Credential;
    return createWebAuthnKeyStore({
      backend: {
        create: vi.fn().mockResolvedValue(fakeCred),
        get: vi.fn().mockResolvedValue(fakeCred),
      },
      dbName: `deltos-identity-session-test-${++_dbSeq}`,
    });
  }

  it('produces a signature verifiable against the KeyStore signing public key', async () => {
    const ks = makeRealKs();
    await ks.enrollNew();
    const pub = ks.getSigningPublicKey();

    const { canonicalAuthPayload, base64urlDecodeStrict } = await import('@deltos/shared');
    const nonce = base64urlDecodeStrict(FAKE_NONCE);
    const expectedPayload = canonicalAuthPayload({
      purpose: 'session',
      audience: TEST_AUDIENCE,
      challengeId: FAKE_CHALLENGE_ID,
      nonce,
      keyId: TEST_KEY_ID,
      requestedScope: TEST_SCOPE,
    });

    const result = await buildSessionRequest(
      { keyStore: ks, keyId: TEST_KEY_ID, requestedScope: TEST_SCOPE, audience: TEST_AUDIENCE },
      mockChallengeOk(),
    );

    const { base64urlDecodeStrict: decode } = await import('@deltos/shared');
    const sigBytes = decode(result.signature);
    const pubKey = await crypto.subtle.importKey('raw', pub, { name: 'Ed25519' }, false, ['verify']);
    expect(await crypto.subtle.verify({ name: 'Ed25519' }, pubKey, sigBytes, expectedPayload)).toBe(true);
  });
});
