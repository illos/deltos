import { describe, it, expect } from 'vitest';
import { can } from '../src/auth.js';
import { ResourceSchema, type RequestPrincipal, type Resource, type Op } from '@deltos/shared';

/**
 * can() per-method authorization. The load-bearing case is the signed-request step-up binding:
 * a signature verified for one (op, resource) must NEVER authorize a different one — asserted at
 * the chokepoint, not trusted from middleware.
 */

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const noteRes = (n: number): Resource => ResourceSchema.parse({ kind: 'note', id: uuid(n) });
const notebookRes = (n: number): Resource => ResourceSchema.parse({ kind: 'notebook', id: uuid(n) });

const signedFor = (op: Op, resource: Resource): RequestPrincipal => ({
  kind: 'device',
  id: 'device-1',
  verification: { method: 'signed-request', keyId: 'k1', challengeId: 'ch1', op, resource },
});

const owner = (verification: RequestPrincipal['verification']): RequestPrincipal => ({
  kind: 'owner',
  id: 'o',
  verification,
});

describe('can() — signed-request step-up is bound to exactly this (op, resource)', () => {
  it('allows when BOTH op and resource match the verified signature', async () => {
    expect(await can(signedFor('delete', noteRes(1)), 'delete', noteRes(1))).toBe(true);
  });
  it('DENIES when the op differs', async () => {
    expect(await can(signedFor('delete', noteRes(1)), 'read', noteRes(1))).toBe(false);
  });
  it('DENIES when the resource id differs', async () => {
    expect(await can(signedFor('delete', noteRes(1)), 'delete', noteRes(2))).toBe(false);
  });
  it('DENIES when the resource kind differs (note vs notebook, same id)', async () => {
    expect(await can(signedFor('delete', noteRes(1)), 'delete', notebookRes(1))).toBe(false);
  });
});

describe('can() — per-method posture', () => {
  it('grant-token is fail-CLOSED until the Stream-A grants registry lands', async () => {
    expect(await can(owner({ method: 'grant-token', grantId: 'g' }), 'read', noteRes(1))).toBe(false);
  });
  it('capability is fail-CLOSED until the registry lands', async () => {
    expect(await can(owner({ method: 'capability', grantId: 'c' }), 'read', noteRes(1))).toBe(false);
  });
  it('unverified allows (dev stub; production refuses it at the chokepoint tripwire)', async () => {
    expect(await can(owner({ method: 'unverified' }), 'read', noteRes(1))).toBe(true);
  });
});
