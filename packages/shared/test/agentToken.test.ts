import { describe, it, expect } from 'vitest';
import {
  clampAgentScopes,
  clampToReadOnlyScopes,
  clampAgentResources,
  MAX_GRANT_RESOURCES,
  MintAgentTokenRequestSchema,
  ResourceSchema,
  type Resource,
  type Scope,
} from '../src/api/index.js';

/**
 * The mint clamp is THE control that keeps write off by default (write-tools.md §2): READ is the floor,
 * WRITE is per-scope opt-in, `share` is never grantable. These pin that fail-closed behavior.
 */
describe('clampAgentScopes — read floor + opt-in write, fail-closed', () => {
  it('defaults to the full read-only surface when nothing is requested', () => {
    expect(clampAgentScopes()).toEqual(['read', 'search']);
  });

  it('never adds a write verb without an explicit opt-in — even if requested in scope', () => {
    expect(clampAgentScopes(['read', 'write', 'create', 'delete', 'share'] as Scope[]))
      .toEqual(['read']); // only read survives the read-floor filter; no write, no share
  });

  it('adds ONLY the opted-in write ops, mapped create→create / update→write / trash→delete', () => {
    expect(clampAgentScopes(undefined, { allowWrite: { create: true } }))
      .toEqual(['read', 'search', 'create']);
    expect(clampAgentScopes(undefined, { allowWrite: { update: true } }))
      .toEqual(['read', 'search', 'write']);
    expect(clampAgentScopes(undefined, { allowWrite: { trash: true } }))
      .toEqual(['read', 'search', 'delete']);
  });

  it('a full opt-in yields read+search+create+write+delete in canonical order (never share)', () => {
    const scope = clampAgentScopes(undefined, { allowWrite: { create: true, update: true, trash: true } });
    expect(scope).toEqual(['read', 'search', 'create', 'write', 'delete']);
    expect(scope).not.toContain('share');
  });

  it('an all-dropped request floors to ["read"], never an empty scope', () => {
    expect(clampAgentScopes(['share'] as Scope[])).toEqual(['read']);
  });

  it('clampToReadOnlyScopes is the write-free delegate (identical read floor)', () => {
    expect(clampToReadOnlyScopes(['read', 'write'] as Scope[])).toEqual(['read']);
    expect(clampToReadOnlyScopes()).toEqual(['read', 'search']);
  });
});

describe('clampAgentResources — the resource-set half of the ONE mint clamp (ROAD-0011 P1 §1.3)', () => {
  const nb = (n: number): Resource => ResourceSchema.parse({ kind: 'notebook', id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` });
  const note = (n: number): Resource => ResourceSchema.parse({ kind: 'note', id: `00000000-0000-4000-9000-${String(n).padStart(12, '0')}` });

  it('absent / empty ⇒ [{workspace}] (back-compat default = the whole account)', () => {
    expect(clampAgentResources()).toEqual([{ kind: 'workspace' }]);
    expect(clampAgentResources([])).toEqual([{ kind: 'workspace' }]);
  });

  it('workspace anywhere COLLAPSES to [{workspace}] (it subsumes any finer selection)', () => {
    expect(clampAgentResources([nb(1), { kind: 'workspace' }, note(2)])).toEqual([{ kind: 'workspace' }]);
  });

  it('keeps a de-duplicated notebook/note selection (a resource unchecked never survives)', () => {
    const out = clampAgentResources([nb(1), nb(1), note(2)]);
    expect(out).toHaveLength(2); // the duplicate notebook collapsed
    expect(out).toEqual([nb(1), note(2)]);
  });

  it('caps the set at MAX_GRANT_RESOURCES (bounds a runaway mint)', () => {
    const many = Array.from({ length: MAX_GRANT_RESOURCES + 25 }, (_, i) => nb(i + 1));
    expect(clampAgentResources(many)).toHaveLength(MAX_GRANT_RESOURCES);
  });
});

describe('MintAgentTokenRequestSchema — write opt-in shape', () => {
  it('accepts a per-scope write opt-in', () => {
    const parsed = MintAgentTokenRequestSchema.safeParse({ password: 'x', write: { create: true, trash: true } });
    expect(parsed.success).toBe(true);
  });

  it('rejects an unknown key inside write (.strict — no ride-along widening)', () => {
    const parsed = MintAgentTokenRequestSchema.safeParse({ password: 'x', write: { create: true, admin: true } });
    expect(parsed.success).toBe(false);
  });

  it('absent write ⇒ a read-only mint (back-compat with every existing caller)', () => {
    const parsed = MintAgentTokenRequestSchema.safeParse({ password: 'x' });
    expect(parsed.success).toBe(true);
    expect((parsed as any).data.write).toBeUndefined();
  });
});
