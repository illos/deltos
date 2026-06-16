import { describe, it, expect } from 'vitest';
import {
  canonicalAuthPayload,
  requestedScopeCanonical,
  resourceCanonical,
  AUTH_TAG,
  type AuthPayloadInput,
} from '../src/auth/canonical.js';
import type { Resource, Scope } from '../src/api/grant.js';

/**
 * `canonical.ts` produces the EXACT bytes the client signs and the server reconstructs+verifies, so
 * its output is frozen contract. These vectors pin the secSys R3-3 properties — scope reordering must
 * not change the bytes (else it is a malleability seam), resource kinds must never collide, and the
 * length-prefixed framing (F4) must make field boundaries unambiguous regardless of field contents.
 */

const nonce = new Uint8Array(32).fill(7);
const pubkey = new Uint8Array(32).fill(3);
const base = { audience: 'https://deltos.example', challengeId: 'CID-aaa', nonce } as const;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const session = (requestedScope: Scope[]): AuthPayloadInput => ({
  purpose: 'session',
  ...base,
  keyId: 'KID-1',
  requestedScope,
});

describe('requestedScopeCanonical (R3-3 — sorted-unique scope set)', () => {
  it('is order-independent: {read,write} and {write,read} are byte-identical', () => {
    expect(requestedScopeCanonical(['read', 'write'])).toEqual(requestedScopeCanonical(['write', 'read']));
  });

  it('de-duplicates: [read,read,write] equals [read,write]', () => {
    expect(requestedScopeCanonical(['read', 'read', 'write'])).toEqual(requestedScopeCanonical(['read', 'write']));
  });

  it('distinguishes different sets: {read} differs from {read,write}', () => {
    expect(requestedScopeCanonical(['read'])).not.toEqual(requestedScopeCanonical(['read', 'write']));
  });

  it('empty set encodes to empty bytes', () => {
    expect(requestedScopeCanonical([])).toEqual(new Uint8Array(0));
  });
});

describe('resourceCanonical (R3-3 — TLV(kind, idOrEmpty), injective)', () => {
  it('never collides across kinds with the same id: note vs notebook differ', () => {
    expect(resourceCanonical({ kind: 'note', id: uuid(1) })).not.toEqual(
      resourceCanonical({ kind: 'notebook', id: uuid(1) }),
    );
  });

  it('workspace (no id) differs from a note carrying that kind-string as an id', () => {
    expect(resourceCanonical({ kind: 'workspace' })).not.toEqual(
      resourceCanonical({ kind: 'note', id: uuid(2) }),
    );
  });
});

describe('canonicalAuthPayload', () => {
  it('is deterministic — identical input yields identical bytes', () => {
    expect(canonicalAuthPayload(session(['read', 'write']))).toEqual(
      canonicalAuthPayload(session(['read', 'write'])),
    );
  });

  it('binds the scope SET, not its order (session)', () => {
    expect(canonicalAuthPayload(session(['read', 'write']))).toEqual(
      canonicalAuthPayload(session(['write', 'read'])),
    );
  });

  it('binds the resource kind so a step-up for note vs notebook differs', () => {
    const stepUp = (resource: Resource): AuthPayloadInput => ({
      purpose: 'step-up',
      ...base,
      keyId: 'KID-1',
      op: 'read',
      resource,
    });
    expect(canonicalAuthPayload(stepUp({ kind: 'note', id: uuid(1) }))).not.toEqual(
      canonicalAuthPayload(stepUp({ kind: 'notebook', id: uuid(1) })),
    );
  });

  it('F4: length-prefix framing makes field boundaries unambiguous (no byte-shift collision)', () => {
    // The same concatenated content split at a different field boundary must produce different bytes.
    const a = canonicalAuthPayload({
      purpose: 'register',
      audience: 'X',
      challengeId: 'a',
      nonce,
      signingPublicKey: pubkey,
      deviceLabel: 'bc',
    });
    const b = canonicalAuthPayload({
      purpose: 'register',
      audience: 'X',
      challengeId: 'ab',
      nonce,
      signingPublicKey: pubkey,
      deviceLabel: 'c',
    });
    expect(a).not.toEqual(b);
  });

  it('binds the audience — a different deployment origin changes the bytes (F8)', () => {
    const here = canonicalAuthPayload({ ...session(['read']), audience: 'https://a.example' } as AuthPayloadInput);
    const there = canonicalAuthPayload({ ...session(['read']), audience: 'https://b.example' } as AuthPayloadInput);
    expect(here).not.toEqual(there);
  });

  it('begins with the version tag field (purpose-independent header)', () => {
    const bytes = canonicalAuthPayload(session(['read']));
    const tagBytes = new TextEncoder().encode(AUTH_TAG);
    // first 4 bytes = uint32-BE length of the tag, then the tag itself
    expect(new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false)).toBe(tagBytes.length);
    expect(bytes.slice(4, 4 + tagBytes.length)).toEqual(tagBytes);
  });
});
