import { describe, it, expect } from 'vitest';
import {
  ChallengeRequestSchema,
  RegisterDeviceRequestSchema,
  SessionRequestSchema,
  StepUpRequestSchema,
} from '../src/auth/requests.js';
import { base64urlEncode, base64urlDecodeStrict } from '../src/auth/encoding.js';

/**
 * The wire auth schemas enforce secSys R3-4 — strict canonical base64url + EXACT byte lengths — so a
 * wrong-length pubkey/sig or a non-canonical blob rejects at the parse boundary, before any crypto.
 * `.strict()` rejects unknown keys (fail-closed). These tests are the R3-4 acceptance targets.
 */

const b64 = (n: number, fill = 1) => base64urlEncode(new Uint8Array(n).fill(fill));
const pub32 = b64(32);
const sig64 = b64(64);
const cid32 = b64(32);

const validSession = () => ({ challengeId: cid32, signature: sig64, keyId: 'KID-1', requestedScope: ['read'] });

describe('base64urlDecodeStrict (R3-4 canonicality)', () => {
  it('accepts canonical unpadded base64url', () => {
    expect(base64urlDecodeStrict('Zg')).toEqual(new Uint8Array([0x66]));
  });
  it('rejects non-canonical trailing bits (Zh decodes to the same byte as canonical Zg)', () => {
    expect(() => base64urlDecodeStrict('Zh')).toThrow();
  });
  it('rejects `=` padding', () => {
    expect(() => base64urlDecodeStrict('Zg==')).toThrow();
  });
  it('rejects non-URL-safe `+`/`/`', () => {
    expect(() => base64urlDecodeStrict('ab+/')).toThrow();
  });
  it('rejects an impossible mod-4 === 1 length', () => {
    expect(() => base64urlDecodeStrict('AAAAA')).toThrow();
  });
});

describe('SessionRequestSchema', () => {
  it('accepts a well-formed request', () => {
    expect(SessionRequestSchema.safeParse(validSession()).success).toBe(true);
  });
  it('rejects a 63-byte signature (exact 64 required)', () => {
    expect(SessionRequestSchema.safeParse({ ...validSession(), signature: b64(63) }).success).toBe(false);
  });
  it('rejects a 65-byte signature', () => {
    expect(SessionRequestSchema.safeParse({ ...validSession(), signature: b64(65) }).success).toBe(false);
  });
  it('rejects a non-canonical (padded) signature', () => {
    expect(SessionRequestSchema.safeParse({ ...validSession(), signature: sig64 + '==' }).success).toBe(false);
  });
  it('rejects a challengeId below the 32-byte floor', () => {
    expect(SessionRequestSchema.safeParse({ ...validSession(), challengeId: b64(16) }).success).toBe(false);
  });
  it('rejects an empty requestedScope', () => {
    expect(SessionRequestSchema.safeParse({ ...validSession(), requestedScope: [] }).success).toBe(false);
  });
  it('rejects an unknown scope', () => {
    expect(SessionRequestSchema.safeParse({ ...validSession(), requestedScope: ['superuser'] }).success).toBe(false);
  });
  it('rejects an unknown extra key (.strict)', () => {
    expect(SessionRequestSchema.safeParse({ ...validSession(), elevate: true }).success).toBe(false);
  });
});

describe('RegisterDeviceRequestSchema', () => {
  const valid = () => ({ challengeId: cid32, signature: sig64, signingPublicKey: pub32, deviceLabel: 'phone' });
  it('accepts a well-formed registration', () => {
    expect(RegisterDeviceRequestSchema.safeParse(valid()).success).toBe(true);
  });
  it('rejects a 31-byte public key (exact 32 required)', () => {
    expect(RegisterDeviceRequestSchema.safeParse({ ...valid(), signingPublicKey: b64(31) }).success).toBe(false);
  });
  it('rejects a 33-byte public key', () => {
    expect(RegisterDeviceRequestSchema.safeParse({ ...valid(), signingPublicKey: b64(33) }).success).toBe(false);
  });
  it('rejects an empty deviceLabel', () => {
    expect(RegisterDeviceRequestSchema.safeParse({ ...valid(), deviceLabel: '' }).success).toBe(false);
  });
});

describe('StepUpRequestSchema', () => {
  const valid = () => ({ challengeId: cid32, signature: sig64, keyId: 'KID-1', op: 'delete', resource: { kind: 'workspace' } });
  it('accepts a well-formed step-up', () => {
    expect(StepUpRequestSchema.safeParse(valid()).success).toBe(true);
  });
  it('rejects a note resource missing its id (discriminated union)', () => {
    expect(StepUpRequestSchema.safeParse({ ...valid(), resource: { kind: 'note' } }).success).toBe(false);
  });
  it('rejects an unknown op', () => {
    expect(StepUpRequestSchema.safeParse({ ...valid(), op: 'launch' }).success).toBe(false);
  });
});

describe('ChallengeRequestSchema', () => {
  it('accepts a session challenge with a keyId', () => {
    expect(ChallengeRequestSchema.safeParse({ keyId: 'KID-1', purpose: 'session' }).success).toBe(true);
  });
  it('accepts a register challenge with no keyId (none exists yet)', () => {
    expect(ChallengeRequestSchema.safeParse({ purpose: 'register' }).success).toBe(true);
  });
  it('rejects an unknown purpose', () => {
    expect(ChallengeRequestSchema.safeParse({ purpose: 'elevate' }).success).toBe(false);
  });
});
