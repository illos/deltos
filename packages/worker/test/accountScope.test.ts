/**
 * accountScope — the per-query account-scope helper (the PRIMARY cross-account control) + the
 * grantAllows ownership BELT. These pin the foundation contract route-owners (scopeSys notes /
 * devSys2 sync) build on:
 *  - callerAccountId/requireAccountId surface principal.id (= accountId, the re-point) fail-closed.
 *  - getNoteForAccount returns a note ONLY for its owning account (no cross-account read; no oracle).
 *  - ownedByAccount + the grantAllows resourceAccountId belt deny on mismatch / null (fail-closed).
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { RequestPrincipal, Resource } from '@deltos/shared';
import type { AppContext } from '../src/context.js';
import type { DbAdapter } from '../src/db/schema.js';
import {
  callerAccountId,
  requireAccountId,
  stampAccountId,
  getNoteForAccount,
  ownedByAccount,
  ACCOUNT_CLAUSE,
} from '../src/db/accountScope.js';
import { grantAllows } from '../src/auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrations = [
  '0000_baseline.sql',
  '0001_stream-b-sync.sql',
  '0002_stream-a-auth.sql',
  '0003_account-identity.sql',
  '0018_fts5-note-search.sql', // FTS table; searchIndex.ts is invoked by the note mutators (0018)
].map((f) => readFileSync(join(__dirname, '../migrations', f), 'utf8'));

function sqliteAdapter(db: Database.Database): DbAdapter {
  return {
    async batch(stmts) {
      const results: { rowsWritten: number }[] = [];
      db.transaction(() => {
        for (const s of stmts) {
          const info = db.prepare(s.sql).run(...(s.params as Array<string | number | null>));
          results.push({ rowsWritten: info.changes });
        }
      })();
      return results;
    },
    async first<T>(sql: string, params: unknown[]) {
      return (db.prepare(sql).get(...(params as Array<string | number | null>)) ?? null) as T | null;
    },
    async all<T>(sql: string, params: unknown[]) {
      return db.prepare(sql).all(...(params as Array<string | number | null>)) as T[];
    },
  };
}

function freshDb(): Database.Database {
  const raw = new Database(':memory:');
  for (const m of migrations) raw.exec(m);
  return raw;
}

const principal = (id: string): RequestPrincipal => ({
  kind: 'owner',
  id,
  verification: { method: 'unverified' },
});

/** Minimal AppContext stub exposing only c.get('principal'). */
const ctxWith = (p: RequestPrincipal | undefined): AppContext =>
  ({ get: (k: string) => (k === 'principal' ? p : undefined) }) as unknown as AppContext;

function seedNote(raw: Database.Database, id: string, notebookId: string, accountId: string) {
  raw
    .prepare(
      `INSERT INTO notes (id, notebookId, title, properties, body, version, createdAt, updatedAt, accountId)
       VALUES (?, ?, '', '{}', '[]', 1, '2026-06-16T00:00:00.000Z', '2026-06-16T00:00:00.000Z', ?)`,
    )
    .run(id, notebookId, accountId);
}

describe('callerAccountId / requireAccountId / stampAccountId', () => {
  it('callerAccountId returns principal.id (= accountId after the re-point)', () => {
    expect(callerAccountId(principal('acct-A'))).toBe('acct-A');
    expect(stampAccountId(principal('acct-A'))).toBe('acct-A');
  });

  it('requireAccountId reads the principal off the context', () => {
    expect(requireAccountId(ctxWith(principal('acct-A')))).toBe('acct-A');
  });

  it('requireAccountId FAILS CLOSED when no principal is on the context (guard regression guard)', () => {
    expect(() => requireAccountId(ctxWith(undefined))).toThrow(/no principal/);
  });

  it('callerAccountId FAILS CLOSED on an empty id rather than scoping to "" and matching nothing', () => {
    expect(() => callerAccountId(principal(''))).toThrow(/no accountId/);
  });
});

describe('getNoteForAccount — per-query account scope (PRIMARY control, no cross-account read)', () => {
  it('returns the note for its owning account, and NULL for another account (indistinguishable from not-found)', async () => {
    const raw = freshDb();
    const db = sqliteAdapter(raw);
    seedNote(raw, 'note-A', 'nb-shared', 'acct-A');

    expect(await getNoteForAccount(db, 'acct-A', 'note-A')).not.toBeNull();
    // Account B asking for A's note id by UUID gets null — no read, no existence oracle.
    expect(await getNoteForAccount(db, 'acct-B', 'note-A')).toBeNull();
  });

  it("two accounts' same notebookId are distinct invisible rows under (accountId, notebookId)", async () => {
    const raw = freshDb();
    const db = sqliteAdapter(raw);
    seedNote(raw, 'note-A', 'notebook-X', 'acct-A');
    seedNote(raw, 'note-B', 'notebook-X', 'acct-B');

    // The ACCOUNT_CLAUSE fragment scopes a notebookId-keyed query to one account.
    const aRows = await db.all<{ id: string }>(
      `SELECT id FROM notes WHERE notebookId = ? AND ${ACCOUNT_CLAUSE}`,
      ['notebook-X', 'acct-A'],
    );
    expect(aRows.map((r) => r.id)).toEqual(['note-A']);
  });
});

describe('ownedByAccount belt comparator', () => {
  it('true only on an exact match; false on mismatch; false on a null row account (fail-closed)', () => {
    expect(ownedByAccount('acct-A', 'acct-A')).toBe(true);
    expect(ownedByAccount('acct-B', 'acct-A')).toBe(false);
    expect(ownedByAccount(null, 'acct-A')).toBe(false);
  });
});

describe('grantAllows ownership belt (defense-in-depth)', () => {
  const note = { kind: 'note', id: 'n1' } as unknown as Resource;
  const grant = (accountId: string) =>
    ({
      grantId: 'g1',
      principal: { kind: 'owner', id: accountId } as const,
      resource: { kind: 'workspace' } as Resource,
      scope: ['read'] as const,
      expiresAtMs: null,
      revokedAt: null,
    }) as unknown as Parameters<typeof grantAllows>[0];

  it('without resourceAccountId: workspace grant covers the note (belt not requested)', () => {
    expect(grantAllows(grant('acct-A'), 'read', note, 0)).toBe(true);
  });

  it('with a MATCHING resourceAccountId: allowed', () => {
    expect(grantAllows(grant('acct-A'), 'read', note, 0, 'acct-A')).toBe(true);
  });

  it('with a MISMATCHED resourceAccountId: DENIED (cross-account belt)', () => {
    expect(grantAllows(grant('acct-A'), 'read', note, 0, 'acct-B')).toBe(false);
  });

  it('with a NULL resource owner + belt requested: DENIED (fail-closed)', () => {
    expect(grantAllows(grant('acct-A'), 'read', note, 0, null)).toBe(false);
  });
});
