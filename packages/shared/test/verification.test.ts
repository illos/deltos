import { describe, it, expect } from 'vitest';
import {
  PrincipalVerificationSchema,
  RequestPrincipalSchema,
  ResourceSchema,
  resourceEquals,
} from '../src/index.js';

/**
 * Contract tests for the locked discriminated-union PrincipalVerification (Stream A) and the
 * resourceEquals helper that backs can()'s step-up binding. These pin the frozen union shape:
 * a later loosening (re-adding passthrough, dropping a proof field, weakening resourceEquals)
 * must fail CI.
 */

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('PrincipalVerification discriminated union', () => {
  it('accepts each well-formed member', () => {
    expect(PrincipalVerificationSchema.safeParse({ method: 'grant-token', grantId: 'g1' }).success).toBe(true);
    expect(PrincipalVerificationSchema.safeParse({ method: 'capability', grantId: 'c1' }).success).toBe(true);
    expect(PrincipalVerificationSchema.safeParse({ method: 'unverified' }).success).toBe(true);
    expect(
      PrincipalVerificationSchema.safeParse({
        method: 'signed-request',
        keyId: 'k1',
        challengeId: 'ch1',
        op: 'delete',
        resource: { kind: 'note', id: uuid(1) },
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown method', () => {
    expect(PrincipalVerificationSchema.safeParse({ method: 'passkey', assertion: 'x' }).success).toBe(false);
    expect(PrincipalVerificationSchema.safeParse({ method: 'bearer', grantId: 'g' }).success).toBe(false);
  });

  it('requires each member’s proof fields', () => {
    expect(PrincipalVerificationSchema.safeParse({ method: 'grant-token' }).success).toBe(false); // no grantId
    // signed-request without the op+resource binding must reject — that binding is load-bearing.
    expect(
      PrincipalVerificationSchema.safeParse({ method: 'signed-request', keyId: 'k', challengeId: 'c' }).success,
    ).toBe(false);
    // op must be a real scope; resource must be a real resource.
    expect(
      PrincipalVerificationSchema.safeParse({
        method: 'signed-request',
        keyId: 'k',
        challengeId: 'c',
        op: 'frobnicate',
        resource: { kind: 'note', id: uuid(1) },
      }).success,
    ).toBe(false);
  });

  it('a live principal still requires a verification marker (P0 parity)', () => {
    expect(RequestPrincipalSchema.safeParse({ kind: 'owner', id: 'o' }).success).toBe(false);
    expect(
      RequestPrincipalSchema.safeParse({ kind: 'owner', id: 'o', verification: { method: 'unverified' } }).success,
    ).toBe(true);
  });
});

describe('resourceEquals — structural, never reference equality', () => {
  const note = (n: number) => ResourceSchema.parse({ kind: 'note', id: uuid(n) });
  const notebook = (n: number) => ResourceSchema.parse({ kind: 'notebook', id: uuid(n) });
  const workspace = ResourceSchema.parse({ kind: 'workspace' });

  it('equal when same kind and same id (distinct objects)', () => {
    expect(resourceEquals(note(1), note(1))).toBe(true);
    expect(resourceEquals(notebook(1), notebook(1))).toBe(true);
    expect(resourceEquals(workspace, ResourceSchema.parse({ kind: 'workspace' }))).toBe(true);
  });

  it('different id ⇒ not equal', () => {
    expect(resourceEquals(note(1), note(2))).toBe(false);
    expect(resourceEquals(notebook(1), notebook(2))).toBe(false);
  });

  it('different kind (even same id) ⇒ not equal', () => {
    expect(resourceEquals(note(1), notebook(1))).toBe(false);
    expect(resourceEquals(note(1), workspace)).toBe(false);
  });
});
