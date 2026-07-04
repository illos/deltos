import { describe, it, expect } from 'vitest';
import { resolvePrincipal, can, canWith, type CanContext, type ResourceOwner } from '../src/auth.js';
import type { AuthStore, ResolvedGrantRow } from '../src/db/authStore.js';
import { ResourceSchema, type Resource, type RequestPrincipal } from '@deltos/shared';
import type { AppContext } from '../src/context.js';

/**
 * The EXTENDED chokepoint — grant SETS + the notebook→note hierarchy resolver (ROAD-0011 P1 §1). This is
 * the auth chokepoint, so the bar is exhaustive: any-of over live rows, live notebook→note coverage, the
 * cross-account ownership belt, per-row revocation, and the fail-closed no-resolver default of plain `can()`.
 */

const ACCT_A = 'acct-A';
const ACCT_B = 'acct-B';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const nb = (n: number): Resource => ResourceSchema.parse({ kind: 'notebook', id: uuid(n) });
const note = (n: number): Resource => ResourceSchema.parse({ kind: 'note', id: uuid(n) });
const workspace: Resource = { kind: 'workspace' };

/** A resolved grant row (one resource of a token). Defaults: agent, account A, read-only, live. */
function row(over: Partial<ResolvedGrantRow> = {}): ResolvedGrantRow {
  return {
    grantId: 'g1',
    tokenGroupId: 'tok',
    principal: { kind: 'agent', id: ACCT_A },
    resource: workspace,
    scope: ['read', 'search'],
    expiresAtMs: null,
    revokedAt: null,
    ...over,
  };
}

const ctxWithBearer = (): AppContext =>
  ({ req: { header: (n: string) => (n === 'Authorization' ? 'Bearer any' : undefined) }, env: {} }) as unknown as AppContext;

/** Resolve a live agent principal carrying `grants` as its set (populates the request-scoped WeakMap). */
async function principalFor(grants: ResolvedGrantRow[]): Promise<RequestPrincipal> {
  const store = { resolveGrantsByTokenHash: async () => grants } as unknown as AuthStore;
  return resolvePrincipal(ctxWithBearer(), store);
}

/** An owner-resolver over a fixed {noteId → owner} map; unknown ids resolve to null (nonexistent). */
function resolverOf(map: Record<string, ResourceOwner>): CanContext {
  return {
    resolveResourceOwner: async (r: Resource) =>
      r.kind === 'note' || r.kind === 'notebook' ? (map[r.kind === 'note' ? r.id : r.id] ?? null) : null,
  };
}

describe('canWith — notebook→note hierarchy coverage (live)', () => {
  it('a notebook(X) grant covers a note CURRENTLY in X, and denies once it moves out', async () => {
    const p = await principalFor([row({ resource: nb(1) })]);
    const inX = resolverOf({ [uuid(9)]: { accountId: ACCT_A, notebookId: uuid(1) } });
    expect(await canWith(inX, p, 'read', note(9))).toBe(true);
    // Same note, now in a different notebook → coverage lost (live semantics).
    const moved = resolverOf({ [uuid(9)]: { accountId: ACCT_A, notebookId: uuid(2) } });
    expect(await canWith(moved, p, 'read', note(9))).toBe(false);
  });

  it('a notebookId=null note (All-Notes pool) is DENIED to a notebook grant, ALLOWED to a workspace grant', async () => {
    const uncategorized = resolverOf({ [uuid(9)]: { accountId: ACCT_A, notebookId: null } });
    const notebookTok = await principalFor([row({ resource: nb(1) })]);
    expect(await canWith(uncategorized, notebookTok, 'read', note(9))).toBe(false);
    const workspaceTok = await principalFor([row({ resource: workspace })]);
    expect(await canWith(uncategorized, workspaceTok, 'read', note(9))).toBe(true);
  });

  it('an unresolvable (nonexistent) note is fail-closed DENY for a notebook grant', async () => {
    const p = await principalFor([row({ resource: nb(1) })]);
    expect(await canWith(resolverOf({}), p, 'read', note(9))).toBe(false);
  });

  it('a workspace grant covers a note WITHOUT resolving the owner (data-layer scoped; not-found stays not-found)', async () => {
    const p = await principalFor([row({ resource: workspace })]);
    let resolverCalls = 0;
    const ctx: CanContext = {
      resolveResourceOwner: async () => {
        resolverCalls++;
        return null;
      },
    };
    expect(await canWith(ctx, p, 'read', note(9))).toBe(true);
    expect(resolverCalls).toBe(0); // workspace coverage never touches the resolver
  });
});

describe('canWith — the cross-account ownership belt', () => {
  it('a notebook grant can NEVER cover another account\'s note, even with a matching notebookId', async () => {
    const p = await principalFor([row({ principal: { kind: 'agent', id: ACCT_A }, resource: nb(1) })]);
    // The note has the SAME notebookId as the grant — but it is owned by account B.
    const foreign = resolverOf({ [uuid(9)]: { accountId: ACCT_B, notebookId: uuid(1) } });
    expect(await canWith(foreign, p, 'read', note(9))).toBe(false);
  });
});

describe('canWith — any-of over the grant set', () => {
  it('covers a note in ANY granted notebook, denies one in none', async () => {
    const p = await principalFor([
      row({ grantId: 'gA', resource: nb(1) }),
      row({ grantId: 'gB', resource: nb(2) }),
    ]);
    const ctx = resolverOf({
      [uuid(11)]: { accountId: ACCT_A, notebookId: uuid(1) }, // in A
      [uuid(12)]: { accountId: ACCT_A, notebookId: uuid(2) }, // in B
      [uuid(13)]: { accountId: ACCT_A, notebookId: uuid(3) }, // in neither
    });
    expect(await canWith(ctx, p, 'read', note(11))).toBe(true);
    expect(await canWith(ctx, p, 'read', note(12))).toBe(true);
    expect(await canWith(ctx, p, 'read', note(13))).toBe(false);
  });

  it('per-row revocation drops ONE resource; siblings stay live', async () => {
    const p = await principalFor([
      row({ grantId: 'gA', resource: nb(1), revokedAt: '2026-01-01T00:00:00.000Z' }), // revoked
      row({ grantId: 'gB', resource: nb(2) }), // live
    ]);
    const ctx = resolverOf({
      [uuid(11)]: { accountId: ACCT_A, notebookId: uuid(1) },
      [uuid(12)]: { accountId: ACCT_A, notebookId: uuid(2) },
    });
    expect(await canWith(ctx, p, 'read', note(11))).toBe(false); // its grant row is revoked
    expect(await canWith(ctx, p, 'read', note(12))).toBe(true); // sibling still live
  });

  it('an expired row is excluded from the any-of', async () => {
    const p = await principalFor([row({ resource: nb(1), expiresAtMs: 1 })]); // epoch-ms 1 = long past
    const ctx = resolverOf({ [uuid(11)]: { accountId: ACCT_A, notebookId: uuid(1) } });
    expect(await canWith(ctx, p, 'read', note(11))).toBe(false);
  });

  it('the op must be in scope (a read grant does not authorize write)', async () => {
    const p = await principalFor([row({ resource: nb(1), scope: ['read', 'search'] })]);
    const ctx = resolverOf({ [uuid(11)]: { accountId: ACCT_A, notebookId: uuid(1) } });
    expect(await canWith(ctx, p, 'read', note(11))).toBe(true);
    expect(await canWith(ctx, p, 'write', note(11))).toBe(false);
  });
});

describe('can() — fail-closed WITHOUT a resolver (the deliberate default)', () => {
  it('a notebook grant + note resource DENIES on the plain path, but canWith (with resolver) ALLOWS', async () => {
    const p = await principalFor([row({ resource: nb(1) })]);
    // Plain can() has no resolver → exact-match only → a notebook grant never covers a note.
    expect(await can(p, 'read', note(9))).toBe(false);
    // canWith upgrades it: the resolver proves the note lives in the granted notebook.
    const ctx = resolverOf({ [uuid(9)]: { accountId: ACCT_A, notebookId: uuid(1) } });
    expect(await canWith(ctx, p, 'read', note(9))).toBe(true);
  });

  it('a workspace grant still covers everything on the plain path (unchanged behavior)', async () => {
    const p = await principalFor([row({ resource: workspace })]);
    expect(await can(p, 'read', note(9))).toBe(true);
    expect(await can(p, 'read', nb(1))).toBe(true);
  });
});
