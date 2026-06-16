// fake-indexeddb/auto first — must precede any Dexie import
import 'fake-indexeddb/auto';

import { describe, it, expect, vi } from 'vitest';
import { base64urlEncode } from '@deltos/shared';
import { buildRegisterRequest } from '../src/identity/register.js';
import { createWebAuthnKeyStore } from '../src/identity/webAuthnKeyStore.js';
import type { KeyStore } from '../src/identity/keyStore.js';

/**
 * Tests for buildRegisterRequest — the client-side device registration ceremony.
 *
 * The 'register' purpose differs from 'step-up' in two key ways:
 *   - No keyId in the challenge request (discriminated union member with no keyId field)
 *   - signingPublicKey + deviceLabel bound into the signed payload instead of op/resource
 *
 * Most tests use a lightweight stub KeyStore to focus on the orchestration logic.
 * The integration test at the end uses the real WebAuthn provider to verify the real
 * Ed25519 signature over the real canonicalAuthPayload output.
 */

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────────

// 32-byte values — minimum required by NonceSchema / ChallengeIdSchema
const FAKE_NONCE = base64urlEncode(new Uint8Array(32).fill(0xcc));
const FAKE_CHALLENGE_ID = base64urlEncode(new Uint8Array(32).fill(0xdd));

const FAKE_CHALLENGE_RESP = {
  challengeId: FAKE_CHALLENGE_ID,
  nonce: FAKE_NONCE,
  expiresAt: '2099-01-01T00:00:00.000Z',
  expiresAtMs: 4102444800000,
};

const TEST_DEVICE_LABEL = 'iPhone 17 Pro';
const TEST_AUDIENCE = 'test.deltos.local';

// ── Minimal stub KeyStore ──────────────────────────────────────────────────────────────────────

const FAKE_SIG = new Uint8Array(64).fill(0xfe);
const FAKE_PUB_KEY = new Uint8Array(32).fill(0x11);

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
    getSigningPublicKey: () => FAKE_PUB_KEY,
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

describe('buildRegisterRequest — locked KeyStore', () => {
  it('throws without fetching a challenge when the KeyStore is locked', async () => {
    const fetchFn = mockChallengeOk();
    await expect(
      buildRegisterRequest(
        { keyStore: makeLockedStub(), deviceLabel: TEST_DEVICE_LABEL, audience: TEST_AUDIENCE },
        fetchFn,
      ),
    ).rejects.toMatchObject({ message: expect.stringMatching(/unlocked/i) });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

// ── Tests: challenge request ─────────────────────────────────────────────────────────────────────

describe('buildRegisterRequest — challenge fetch', () => {
  it('POSTs to /api/auth/challenge with purpose:register and NO keyId', async () => {
    const fetchFn = mockChallengeOk();
    await buildRegisterRequest(
      { keyStore: makeUnlockedStub(), deviceLabel: TEST_DEVICE_LABEL, audience: TEST_AUDIENCE },
      fetchFn,
    );
    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/auth/challenge');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as unknown;
    expect(body).toStrictEqual({ purpose: 'register' }); // no keyId — strict equality
  });

  it('throws on a non-2xx challenge response', async () => {
    await expect(
      buildRegisterRequest(
        { keyStore: makeUnlockedStub(), deviceLabel: TEST_DEVICE_LABEL, audience: TEST_AUDIENCE },
        mockChallengeError(503),
      ),
    ).rejects.toMatchObject({ message: expect.stringMatching(/503/) });
  });

  it('throws when challenge response body fails schema validation', async () => {
    const badFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.resolve({ challengeId: 'too-short', nonce: 'also-short', expiresAt: '', expiresAtMs: 0 }),
    } as unknown as Response);
    await expect(
      buildRegisterRequest(
        { keyStore: makeUnlockedStub(), deviceLabel: TEST_DEVICE_LABEL, audience: TEST_AUDIENCE },
        badFetch,
      ),
    ).rejects.toBeDefined();
  });
});

// ── Tests: AUTH-1 freshness ─────────────────────────────────────────────────────────────────────

describe('buildRegisterRequest — freshness guard (AUTH-1)', () => {
  it('throws when the challenge is already expired (expiresAtMs in the past)', async () => {
    const expiredResp = { ...FAKE_CHALLENGE_RESP, expiresAtMs: 1 };
    await expect(
      buildRegisterRequest(
        { keyStore: makeUnlockedStub(), deviceLabel: TEST_DEVICE_LABEL, audience: TEST_AUDIENCE },
        mockChallengeOk(expiredResp),
        () => 1000,
      ),
    ).rejects.toMatchObject({ message: expect.stringMatching(/expired/i) });
  });

  it('proceeds when expiresAtMs is in the future', async () => {
    const futureResp = { ...FAKE_CHALLENGE_RESP, expiresAtMs: 9_000_000_000_000 };
    await expect(
      buildRegisterRequest(
        { keyStore: makeUnlockedStub(), deviceLabel: TEST_DEVICE_LABEL, audience: TEST_AUDIENCE },
        mockChallengeOk(futureResp),
        () => 1000,
      ),
    ).resolves.toBeDefined();
  });

  it('does NOT compare expiresAt (string) — only expiresAtMs triggers expiry', async () => {
    const mixedResp = { ...FAKE_CHALLENGE_RESP, expiresAt: '2000-01-01T00:00:00.000Z', expiresAtMs: 9_000_000_000_000 };
    await expect(
      buildRegisterRequest(
        { keyStore: makeUnlockedStub(), deviceLabel: TEST_DEVICE_LABEL, audience: TEST_AUDIENCE },
        mockChallengeOk(mixedResp),
        () => 1000,
      ),
    ).resolves.toBeDefined();
  });
});

// ── Tests: output shape ──────────────────────────────────────────────────────────────────────────

describe('buildRegisterRequest — output', () => {
  it('returns the challengeId from the server response', async () => {
    const result = await buildRegisterRequest(
      { keyStore: makeUnlockedStub(), deviceLabel: TEST_DEVICE_LABEL, audience: TEST_AUDIENCE },
      mockChallengeOk(),
    );
    expect(result.challengeId).toBe(FAKE_CHALLENGE_ID);
  });

  it('returns the deviceLabel verbatim', async () => {
    const result = await buildRegisterRequest(
      { keyStore: makeUnlockedStub(), deviceLabel: TEST_DEVICE_LABEL, audience: TEST_AUDIENCE },
      mockChallengeOk(),
    );
    expect(result.deviceLabel).toBe(TEST_DEVICE_LABEL);
  });

  it('signingPublicKey is a 32-byte base64url string (Ed25519 public key length)', async () => {
    const result = await buildRegisterRequest(
      { keyStore: makeUnlockedStub(), deviceLabel: TEST_DEVICE_LABEL, audience: TEST_AUDIENCE },
      mockChallengeOk(),
    );
    // base64url of 32 bytes = 43 chars (no padding)
    expect(result.signingPublicKey.length).toBe(43);
    expect(/^[A-Za-z0-9_-]+$/.test(result.signingPublicKey)).toBe(true);
  });

  it('signature is a 64-byte base64url string (Ed25519 output length)', async () => {
    const result = await buildRegisterRequest(
      { keyStore: makeUnlockedStub(), deviceLabel: TEST_DEVICE_LABEL, audience: TEST_AUDIENCE },
      mockChallengeOk(),
    );
    // base64url of 64 bytes = 86 chars (no padding)
    expect(result.signature.length).toBe(86);
    expect(/^[A-Za-z0-9_-]+$/.test(result.signature)).toBe(true);
  });

  it('RegisterDeviceRequest output passes its own Zod schema (belt-and-suspenders)', async () => {
    const { RegisterDeviceRequestSchema } = await import('@deltos/shared');
    const result = await buildRegisterRequest(
      { keyStore: makeUnlockedStub(), deviceLabel: TEST_DEVICE_LABEL, audience: TEST_AUDIENCE },
      mockChallengeOk(),
    );
    expect(() => RegisterDeviceRequestSchema.parse(result)).not.toThrow();
  });
});

// ── Integration: real Ed25519 signature is verifiable ────────────────────────────────────────────

describe('buildRegisterRequest — integration (real KeyStore + canonical payload)', () => {
  const FAKE_CRED_ID = new Uint8Array(16).fill(0x33);
  const FAKE_PRF_OUTPUT = new Uint8Array(32).fill(0x44);
  let _dbSeq = 200; // offset from other test files to avoid name collisions

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
      dbName: `deltos-identity-register-test-${++_dbSeq}`,
    });
  }

  it('produces a signature verifiable against the KeyStore signing public key', async () => {
    const ks = makeRealKs();
    await ks.enrollNew();
    const pub = ks.getSigningPublicKey();

    // Reconstruct the same canonical payload the client sends
    const { canonicalAuthPayload, base64urlDecodeStrict } = await import('@deltos/shared');
    const nonce = base64urlDecodeStrict(FAKE_NONCE);
    const expectedPayload = canonicalAuthPayload({
      purpose: 'register',
      audience: TEST_AUDIENCE,
      challengeId: FAKE_CHALLENGE_ID,
      nonce,
      signingPublicKey: pub,
      deviceLabel: TEST_DEVICE_LABEL,
    });

    const result = await buildRegisterRequest(
      { keyStore: ks, deviceLabel: TEST_DEVICE_LABEL, audience: TEST_AUDIENCE },
      mockChallengeOk(),
    );

    const { base64urlDecodeStrict: decode2 } = await import('@deltos/shared');
    const sigBytes = decode2(result.signature);
    const pubKey = await crypto.subtle.importKey('raw', pub, { name: 'Ed25519' }, false, ['verify']);
    expect(await crypto.subtle.verify({ name: 'Ed25519' }, pubKey, sigBytes, expectedPayload)).toBe(true);
  });

  it('signingPublicKey in the request matches the enrolled KeyStore public key', async () => {
    const ks = makeRealKs();
    await ks.enrollNew();
    const pub = ks.getSigningPublicKey();

    const result = await buildRegisterRequest(
      { keyStore: ks, deviceLabel: TEST_DEVICE_LABEL, audience: TEST_AUDIENCE },
      mockChallengeOk(),
    );

    const { base64urlEncode: encode } = await import('@deltos/shared');
    expect(result.signingPublicKey).toBe(encode(pub));
  });
});
