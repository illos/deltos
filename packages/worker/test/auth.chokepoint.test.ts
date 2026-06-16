import { describe, it, expect } from 'vitest';
import { ResourceSchema, type Resource, type Scope } from '@deltos/shared';
import {
  parseBearerToken,
  principalForGrant,
  grantAllows,
  resolvePrincipal,
  can,
} from '../src/auth.js';
import type { AuthStore } from '../src/db/authStore.js';
import type { AppContext } from '../src/context.js';

/**
 * The chokepoint's server-side grant resolution + CF-5 grant-token authorization. `grantAllows` is
 * the pure decision (revocation, NUMERIC expiry, scope, resource coverage); resolvePrincipal proves
 * the Bearer→hash→grant path never trusts the body and that a present-but-unknown token is not
 * silently honored.
 */

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const noteRes = (n: number): Resource => ResourceSchema.parse({ kind: 'note', id: uuid(n) });
const NOW = 1_750_000_000_000;

type Grant = Parameters<typeof grantAllows>[0];
const grant = (over: Partial<Grant> = {}): Grant => ({
  grantId: 'g1',
  principal: { kind: 'owner', id: 'acct-fp' },
  resource: { kind: 'workspace' },
  scope: ['read', 'write'] as Scope[],
  expiresAtMs: null,
  revokedAt: null,
  ...over,
});

/** A fake AppContext exposing only the Authorization header the resolver reads. */
const ctxWith = (authHeader?: string): AppContext =>
  ({ req: { header: (n: string) => (n === 'Authorization' ? authHeader : undefined) }, env: {} }) as unknown as AppContext;

/** A fake store whose grant lookup returns `g` (or null) regardless of the hash. */
const storeReturning = (g: Grant | null): AuthStore =>
  ({ resolveGrantByTokenHash: async () => g }) as unknown as AuthStore;

describe('parseBearerToken', () => {
  it.each([
    ['Bearer abc.def', 'abc.def'],
    ['bearer abc', 'abc'], // scheme is case-insensitive
    ['Bearer   spaced', 'spaced'],
  ])('extracts the token from %o', (header, token) => {
    expect(parseBearerToken(header)).toBe(token);
  });
  it.each([[undefined], ['abc'], ['Bearer '], ['Basic abc']])('returns null for %o', (header) => {
    expect(parseBearerToken(header as string | undefined)).toBeNull();
  });
});

describe('principalForGrant', () => {
  it('maps an owner grant to a grant-token principal', () => {
    expect(principalForGrant(grant())).toEqual({
      kind: 'owner',
      id: 'acct-fp',
      verification: { method: 'grant-token', grantId: 'g1' },
    });
  });
  it('maps an agent grant to a capability principal', () => {
    const p = principalForGrant(grant({ principal: { kind: 'agent', id: 'bot' } }));
    expect(p.verification).toEqual({ method: 'capability', grantId: 'g1' });
  });
});

describe('grantAllows (CF-5 — fail-closed at every gate)', () => {
  it('allows read on a covered resource within a live, unrevoked, in-scope grant', () => {
    expect(grantAllows(grant(), 'read', noteRes(1), NOW)).toBe(true);
  });
  it('DENIES a revoked grant (PIN-ID-5, immediate)', () => {
    expect(grantAllows(grant({ revokedAt: '2026-01-01T00:00:00.000Z' }), 'read', noteRes(1), NOW)).toBe(false);
  });
  it('DENIES an expired grant — NUMERIC compare, expiresAtMs <= now', () => {
    expect(grantAllows(grant({ expiresAtMs: NOW - 1 }), 'read', noteRes(1), NOW)).toBe(false);
    expect(grantAllows(grant({ expiresAtMs: NOW }), 'read', noteRes(1), NOW)).toBe(false); // boundary
  });
  it('allows a grant expiring in the future', () => {
    expect(grantAllows(grant({ expiresAtMs: NOW + 1000 }), 'read', noteRes(1), NOW)).toBe(true);
  });
  it('DENIES an op outside the granted scope (F5 clamp upheld)', () => {
    expect(grantAllows(grant(), 'delete', noteRes(1), NOW)).toBe(false);
  });
  it('a workspace grant covers any resource; a note grant only its exact note', () => {
    expect(grantAllows(grant({ resource: noteRes(1) }), 'read', noteRes(1), NOW)).toBe(true);
    expect(grantAllows(grant({ resource: noteRes(1) }), 'read', noteRes(2), NOW)).toBe(false);
  });
});

describe('resolvePrincipal + can() integration', () => {
  it('a valid bearer resolves a grant-token principal that can() enforces', async () => {
    const p = await resolvePrincipal(ctxWith('Bearer tok'), storeReturning(grant()));
    expect(p.verification).toEqual({ method: 'grant-token', grantId: 'g1' });
    expect(await can(p, 'read', noteRes(1))).toBe(true); // workspace grant covers note, read in scope
    expect(await can(p, 'delete', noteRes(1))).toBe(false); // delete not granted
  });

  it('a revoked grant resolves a principal but can() denies it immediately', async () => {
    const p = await resolvePrincipal(ctxWith('Bearer tok'), storeReturning(grant({ revokedAt: '2026-01-01T00:00:00.000Z' })));
    expect(await can(p, 'read', noteRes(1))).toBe(false);
  });

  it('no Authorization header → the unverified dev stub (prod refuses it at the tripwire)', async () => {
    const p = await resolvePrincipal(ctxWith(undefined), storeReturning(grant()));
    expect(p.verification).toEqual({ method: 'unverified' });
    expect(p.id).toBe('local-account'); // dev stub id = a sentinel accountId (re-point), not a fingerprint
  });

  it('a present but UNKNOWN token is not honored — falls to unverified, not a real principal', async () => {
    const p = await resolvePrincipal(ctxWith('Bearer ghost'), storeReturning(null));
    expect(p.verification).toEqual({ method: 'unverified' });
  });

  it('a principal built OUTSIDE the resolver (no resolved grant) denies on grant-token', async () => {
    const fabricated = { kind: 'owner', id: 'x', verification: { method: 'grant-token', grantId: 'g' } } as const;
    expect(await can(fabricated, 'read', noteRes(1))).toBe(false);
  });
});
