// fake-indexeddb/auto first — must precede any Dexie import
import 'fake-indexeddb/auto';

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { base64urlEncode } from '@deltos/shared';
import { buildStepUpRequest } from '../src/identity/stepUp.js';
import { createWebAuthnKeyStore } from '../src/identity/webAuthnKeyStore.js';
import type { KeyStore } from '../src/identity/keyStore.js';
import type { Op, Resource } from '@deltos/shared';

/**
 * Tests for buildStepUpRequest — the client-side step-up ceremony.
 *
 * Uses a lightweight stub KeyStore (not the full WebAuthn provider) for most tests to keep
 * focus on the stepUp orchestration logic. The integration test at the end uses the real
 * WebAuthn provider with a fake backend to verify the end-to-end signature is valid.
 */

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────────

// 32-byte values — minimum required by NonceSchema / ChallengeIdSchema
const FAKE_NONCE = base64urlEncode(new Uint8Array(32).fill(0xaa));
const FAKE_CHALLENGE_ID = base64urlEncode(new Uint8Array(32).fill(0xbb));

const FAKE_CHALLENGE_RESP = {
  challengeId: FAKE_CHALLENGE_ID,
  nonce: FAKE_NONCE,
  expiresAt: '2099-01-01T00:00:00.000Z',
  expiresAtMs: 4102444800000,
};

const STEP_UP_OP: Op = 'delete';
const STEP_UP_RESOURCE: Resource = { kind: 'workspace' };
const TEST_KEY_ID = 'test-key-id-1';
const TEST_AUDIENCE = 'test.deltos.local';

// ── Minimal stub KeyStore for stepUp unit tests ──────────────────────────────────────────────────

const FAKE_SIG = new Uint8Array(64).fill(0xee);

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
    getSigningPublicKey: () => new Uint8Array(32).fill(0xff),
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

describe('buildStepUpRequest — locked KeyStore', () => {
  it('throws immediately without fetching a challenge', async () => {
    const fetchFn = mockChallengeOk();
    await expect(
      buildStepUpRequest(
        { keyStore: makeLockedStub(), keyId: TEST_KEY_ID, op: STEP_UP_OP, resource: STEP_UP_RESOURCE, audience: TEST_AUDIENCE },
        fetchFn,
      ),
    ).rejects.toMatchObject({ message: expect.stringMatching(/unlocked/i) });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

// ── Tests: challenge fetch ───────────────────────────────────────────────────────────────────────

describe('buildStepUpRequest — challenge fetch', () => {
  it('POSTs to /api/auth/challenge with purpose:step-up and the keyId', async () => {
    const fetchFn = mockChallengeOk();
    await buildStepUpRequest(
      { keyStore: makeUnlockedStub(), keyId: TEST_KEY_ID, op: STEP_UP_OP, resource: STEP_UP_RESOURCE, audience: TEST_AUDIENCE },
      fetchFn,
    );
    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/auth/challenge');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as unknown;
    expect(body).toMatchObject({ purpose: 'step-up', keyId: TEST_KEY_ID });
  });

  it('throws on a non-2xx challenge response', async () => {
    await expect(
      buildStepUpRequest(
        { keyStore: makeUnlockedStub(), keyId: TEST_KEY_ID, op: STEP_UP_OP, resource: STEP_UP_RESOURCE, audience: TEST_AUDIENCE },
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
      buildStepUpRequest(
        { keyStore: makeUnlockedStub(), keyId: TEST_KEY_ID, op: STEP_UP_OP, resource: STEP_UP_RESOURCE, audience: TEST_AUDIENCE },
        badFetch,
      ),
    ).rejects.toBeDefined();
  });
});

// ── Tests: output shape ──────────────────────────────────────────────────────────────────────────

describe('buildStepUpRequest — output', () => {
  it('returns a StepUpRequest with the challenge ID from the server response', async () => {
    const result = await buildStepUpRequest(
      { keyStore: makeUnlockedStub(), keyId: TEST_KEY_ID, op: STEP_UP_OP, resource: STEP_UP_RESOURCE, audience: TEST_AUDIENCE },
      mockChallengeOk(),
    );
    expect(result.challengeId).toBe(FAKE_CHALLENGE_ID);
  });

  it('returns the correct keyId, op, and resource', async () => {
    const result = await buildStepUpRequest(
      { keyStore: makeUnlockedStub(), keyId: TEST_KEY_ID, op: STEP_UP_OP, resource: STEP_UP_RESOURCE, audience: TEST_AUDIENCE },
      mockChallengeOk(),
    );
    expect(result.keyId).toBe(TEST_KEY_ID);
    expect(result.op).toBe(STEP_UP_OP);
    expect(result.resource).toEqual(STEP_UP_RESOURCE);
  });

  it('signature is a 64-byte base64url string (Ed25519 output length)', async () => {
    const result = await buildStepUpRequest(
      { keyStore: makeUnlockedStub(), keyId: TEST_KEY_ID, op: STEP_UP_OP, resource: STEP_UP_RESOURCE, audience: TEST_AUDIENCE },
      mockChallengeOk(),
    );
    // base64url of 64 bytes = 86 chars (no padding)
    expect(result.signature.length).toBe(86);
    expect(/^[A-Za-z0-9_-]+$/.test(result.signature)).toBe(true);
  });

  it('StepUpRequest output passes its own Zod schema (belt-and-suspenders)', async () => {
    const { StepUpRequestSchema } = await import('@deltos/shared');
    const result = await buildStepUpRequest(
      { keyStore: makeUnlockedStub(), keyId: TEST_KEY_ID, op: STEP_UP_OP, resource: STEP_UP_RESOURCE, audience: TEST_AUDIENCE },
      mockChallengeOk(),
    );
    expect(() => StepUpRequestSchema.parse(result)).not.toThrow();
  });
});

// ── Integration: real Ed25519 signature is verifiable ────────────────────────────────────────────

describe('buildStepUpRequest — integration (real KeyStore + canonical payload)', () => {
  // Uses the concrete WebAuthn provider with a fake backend so we can verify the
  // real Ed25519 signature over the real canonicalAuthPayload output.

  const FAKE_CRED_ID = new Uint8Array(16).fill(0x11);
  const FAKE_PRF_OUTPUT = new Uint8Array(32).fill(0x22);
  let _dbSeq = 100; // offset from keyStore.test.ts counter to avoid name collisions

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
      dbName: `deltos-identity-stepup-test-${++_dbSeq}`,
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
      purpose: 'step-up',
      audience: TEST_AUDIENCE,
      challengeId: FAKE_CHALLENGE_ID,
      nonce,
      keyId: TEST_KEY_ID,
      op: STEP_UP_OP,
      resource: STEP_UP_RESOURCE,
    });

    const result = await buildStepUpRequest(
      { keyStore: ks, keyId: TEST_KEY_ID, op: STEP_UP_OP, resource: STEP_UP_RESOURCE, audience: TEST_AUDIENCE },
      mockChallengeOk(),
    );

    const sigBytes = base64urlDecodeStrict(result.signature);
    const pubKey = await crypto.subtle.importKey('raw', pub, { name: 'Ed25519' }, false, ['verify']);
    expect(await crypto.subtle.verify({ name: 'Ed25519' }, pubKey, sigBytes, expectedPayload)).toBe(true);
  });
});
