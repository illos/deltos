/**
 * Route-level integration tests for POST /api/sync/push with COLLECTION + COLLECTION-MEMBER entries
 * (collections.md §4, secSys #19 ordering, GOTCHA-0008 one-bad-entry-doesn't-400).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { collectionMemberId } from '@deltos/shared';
import app from '../src/index.js';
import type { Env } from '../src/env.js';
import { signupToken } from './helpers/passwordToken.js';
import { allMigrations } from './helpers/migrations.js';

const ALL_MIGRATIONS = allMigrations();

function d1Over(raw: Database.Database): D1Database {
  const prepare = (sql: string) => {
    const stmt = {
      sql,
      _params: [] as unknown[],
      bind(...p: unknown[]) {
        stmt._params = p;
        return stmt;
      },
      async first<T>() {
        return (raw.prepare(sql).get(...(stmt._params as never[])) ?? null) as T | null;
      },
      async all<T>() {
        return { results: raw.prepare(sql).all(...(stmt._params as never[])) as T[] };
      },
      async run() {
        const info = raw.prepare(sql).run(...(stmt._params as never[]));
        return { meta: { rows_written: info.changes } };
      },
    };
    return stmt;
  };
  return {
    prepare,
    async batch(prepared: Array<{ sql: string; _params: unknown[] }>) {
      return prepared.map((s) => {
        const info = raw.prepare(s.sql).run(...(s._params as never[]));
        return { meta: { rows_written: info.changes } };
      });
    },
  } as unknown as D1Database;
}

const AUD = 'deltos.collections.routes';
const makeEnv = (raw: Database.Database): Env =>
  ({
    DB: d1Over(raw),
    ENVIRONMENT: 'development',
    AUTH_AUDIENCE: AUD,
    AUTH_PEPPER: 'collections-routes-pepper',
  }) as unknown as Env;

const post = (env: Env, path: string, body: unknown, token: string) =>
  app.request(
    path,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    },
    env,
  );

type PullBody = {
  notes: Array<{ id: string; notebookId: string | null; version: number }>;
  notebooks: Array<{ id: string; version: number }>;
  collections: Array<{
    id: string;
    notebookId: string | null;
    name: string;
    deletedAt: string | null;
    version: number;
    ord: number;
  }>;
  collectionMembers: Array<{
    id: string;
    collectionId: string;
    noteId: string;
    deletedAt: string | null;
    version: number;
    ord: number;
  }>;
};

const pull = async (env: Env, token: string): Promise<PullBody> => {
  const res = await app.request(
    '/api/sync/pull?cursor=0',
    { headers: { Authorization: `Bearer ${token}` } },
    env,
  );
  return res.json() as Promise<PullBody>;
};

const NOTE = '00000000-0000-4000-e000-000000000001';
const NOTE2 = '00000000-0000-4000-e000-000000000011';
const NB = '00000000-0000-4000-e000-000000000002';
const COL = '00000000-0000-4000-e000-000000000003';
const COL2 = '00000000-0000-4000-e000-000000000013';
const MEM = collectionMemberId(COL, NOTE);
const MEM2 = collectionMemberId(COL, NOTE2);
const FOREIGN_COL = '00000000-0000-4000-e000-0000000000fc';
const FOREIGN_NOTE = '00000000-0000-4000-e000-0000000000f1';
const MEM_FOREIGN_COL = collectionMemberId(FOREIGN_COL, NOTE);
const MEM_FOREIGN_NOTE = collectionMemberId(COL, FOREIGN_NOTE);

describe('POST /api/sync/push — collection + member batch (route-level)', () => {
  let env: Env;
  let token: string;

  beforeEach(async () => {
    const raw = new Database(':memory:');
    for (const m of ALL_MIGRATIONS) raw.exec(m);
    env = makeEnv(raw);
    ({ token } = await signupToken(env, 'col-routes-user', 'col-routes-password'));
  });

  it('same-batch create-collection-THEN-add-member is ACCEPTED (locks push-loop ordering)', async () => {
    // Seed notebook + note first (member needs a live note; collections still before members).
    await post(
      env,
      '/api/sync/push',
      {
        notebookEntries: [
          { id: NB, baseVersion: 0, draft: { name: 'Work', defaultCollectionView: 'list', noteSort: 'modified' } },
        ],
        entries: [{ id: NOTE, notebookId: NB, baseVersion: 0, draft: { title: 'n', properties: {}, body: [] } }],
      },
      token,
    );

    // ONE batch: create COL + add MEM. Only passes if collections are processed before members.
    const res = await post(
      env,
      '/api/sync/push',
      {
        collectionEntries: [
          {
            id: COL,
            baseVersion: 0,
            draft: { notebookId: NB, name: 'Folder', ord: 0, rule: null },
          },
        ],
        collectionMemberEntries: [
          {
            id: MEM,
            baseVersion: 0,
            draft: { collectionId: COL, noteId: NOTE, ord: 0 },
          },
        ],
      },
      token,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      collectionResults: Array<{ outcome: string }>;
      collectionMemberResults: Array<{ outcome: string }>;
    };
    expect(body.collectionResults[0]!.outcome).toBe('accepted');
    expect(body.collectionMemberResults[0]!.outcome).toBe('accepted');

    const after = await pull(env, token);
    expect(after.collections.find((c) => c.id === COL)?.name).toBe('Folder');
    expect(after.collectionMembers.find((m) => m.id === MEM)?.noteId).toBe(NOTE);
  });

  it('[P1] four-entry one-request: new notebook + collection + note + member(C,newNote) all accept', async () => {
    // notebooks → collections → notes → members: create-note-and-file in one offline flush.
    const res = await post(
      env,
      '/api/sync/push',
      {
        notebookEntries: [
          { id: NB, baseVersion: 0, draft: { name: 'Work', defaultCollectionView: 'list', noteSort: 'modified' } },
        ],
        collectionEntries: [
          { id: COL, baseVersion: 0, draft: { notebookId: NB, name: 'Folder', ord: 0, rule: null } },
        ],
        entries: [{ id: NOTE, notebookId: NB, baseVersion: 0, draft: { title: 'fresh', properties: {}, body: [] } }],
        collectionMemberEntries: [
          { id: MEM, baseVersion: 0, draft: { collectionId: COL, noteId: NOTE, ord: 0 } },
        ],
      },
      token,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      notebookResults: Array<{ outcome: string }>;
      collectionResults: Array<{ outcome: string }>;
      results: Array<{ outcome: string }>;
      collectionMemberResults: Array<{ outcome: string; id: string }>;
    };
    expect(body.notebookResults[0]!.outcome).toBe('accepted');
    expect(body.collectionResults[0]!.outcome).toBe('accepted');
    expect(body.results[0]!.outcome).toBe('accepted');
    expect(body.collectionMemberResults[0]!.outcome).toBe('accepted');
    expect(body.collectionMemberResults[0]!.id).toBe(MEM);

    const after = await pull(env, token);
    expect(after.notes.find((n) => n.id === NOTE)?.notebookId).toBe(NB);
    expect(after.collections.find((c) => c.id === COL)?.name).toBe('Folder');
    const mem = after.collectionMembers.find((m) => m.id === MEM)!;
    expect(mem.noteId).toBe(NOTE);
    expect(mem.collectionId).toBe(COL);
    expect(mem.id).toBe(collectionMemberId(COL, NOTE));
  });

  it('[P1] mismatched member id is per-entry conflict; mixed batch stays HTTP 200', async () => {
    await post(
      env,
      '/api/sync/push',
      {
        notebookEntries: [
          { id: NB, baseVersion: 0, draft: { name: 'Work', defaultCollectionView: 'list', noteSort: 'modified' } },
        ],
        entries: [
          { id: NOTE, notebookId: NB, baseVersion: 0, draft: { title: 'n1', properties: {}, body: [] } },
          { id: NOTE2, notebookId: NB, baseVersion: 0, draft: { title: 'n2', properties: {}, body: [] } },
        ],
        collectionEntries: [
          { id: COL, baseVersion: 0, draft: { notebookId: NB, name: 'Folder', ord: 0, rule: null } },
        ],
      },
      token,
    );

    const randomId = '99999999-9999-4999-8999-999999999999';
    // Mixed: one good member + one mismatched id (would have been a PK-collision 500 before the fix).
    const res = await post(
      env,
      '/api/sync/push',
      {
        collectionMemberEntries: [
          { id: MEM, baseVersion: 0, draft: { collectionId: COL, noteId: NOTE, ord: 0 } },
          { id: randomId, baseVersion: 0, draft: { collectionId: COL, noteId: NOTE2, ord: 1 } },
        ],
      },
      token,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      collectionMemberResults: Array<{ outcome: string; id: string }>;
    };
    expect(body.collectionMemberResults.find((r) => r.id === MEM)!.outcome).toBe('accepted');
    expect(body.collectionMemberResults.find((r) => r.id === randomId)!.outcome).toBe('conflict');

    const after = await pull(env, token);
    expect(after.collectionMembers.find((m) => m.id === MEM)?.noteId).toBe(NOTE);
    expect(after.collectionMembers.find((m) => m.noteId === NOTE2)).toBeUndefined();
  });

  it('member to foreign collection/note is REJECTED (conflict, no orphan)', async () => {
    await post(
      env,
      '/api/sync/push',
      {
        notebookEntries: [
          { id: NB, baseVersion: 0, draft: { name: 'Work', defaultCollectionView: 'list', noteSort: 'modified' } },
        ],
        entries: [{ id: NOTE, notebookId: NB, baseVersion: 0, draft: { title: 'n', properties: {}, body: [] } }],
        collectionEntries: [
          { id: COL, baseVersion: 0, draft: { notebookId: NB, name: 'Folder', ord: 0, rule: null } },
        ],
      },
      token,
    );

    const foreignCol = await post(
      env,
      '/api/sync/push',
      {
        collectionMemberEntries: [
          { id: MEM_FOREIGN_COL, baseVersion: 0, draft: { collectionId: FOREIGN_COL, noteId: NOTE, ord: 0 } },
        ],
      },
      token,
    );
    expect(foreignCol.status).toBe(200);
    expect(
      ((await foreignCol.json()) as { collectionMemberResults: Array<{ outcome: string }> })
        .collectionMemberResults[0]!.outcome,
    ).toBe('conflict');

    const foreignNote = await post(
      env,
      '/api/sync/push',
      {
        collectionMemberEntries: [
          { id: MEM_FOREIGN_NOTE, baseVersion: 0, draft: { collectionId: COL, noteId: FOREIGN_NOTE, ord: 0 } },
        ],
      },
      token,
    );
    expect(foreignNote.status).toBe(200);
    expect(
      ((await foreignNote.json()) as { collectionMemberResults: Array<{ outcome: string }> })
        .collectionMemberResults[0]!.outcome,
    ).toBe('conflict');

    const after = await pull(env, token);
    expect(after.collectionMembers.filter((m) => m.deletedAt === null)).toHaveLength(0);
  });

  it('CAS reorder member accepts at current version and conflicts when stale', async () => {
    // Notes must exist before members (push order: notebooks → collections → members → notes).
    await post(
      env,
      '/api/sync/push',
      {
        notebookEntries: [
          { id: NB, baseVersion: 0, draft: { name: 'Work', defaultCollectionView: 'list', noteSort: 'modified' } },
        ],
        entries: [{ id: NOTE, notebookId: NB, baseVersion: 0, draft: { title: 'n', properties: {}, body: [] } }],
      },
      token,
    );
    await post(
      env,
      '/api/sync/push',
      {
        collectionEntries: [
          { id: COL, baseVersion: 0, draft: { notebookId: NB, name: 'Folder', ord: 0, rule: null } },
        ],
        collectionMemberEntries: [
          { id: MEM, baseVersion: 0, draft: { collectionId: COL, noteId: NOTE, ord: 0 } },
        ],
      },
      token,
    );

    const ok = await post(
      env,
      '/api/sync/push',
      {
        collectionMemberEntries: [
          { id: MEM, baseVersion: 1, draft: { collectionId: COL, noteId: NOTE, ord: 7 } },
        ],
      },
      token,
    );
    expect(ok.status).toBe(200);
    expect(
      ((await ok.json()) as { collectionMemberResults: Array<{ outcome: string }> })
        .collectionMemberResults[0]!.outcome,
    ).toBe('accepted');

    const stale = await post(
      env,
      '/api/sync/push',
      {
        collectionMemberEntries: [
          { id: MEM, baseVersion: 1, draft: { collectionId: COL, noteId: NOTE, ord: 9 } },
        ],
      },
      token,
    );
    expect(stale.status).toBe(200);
    expect(
      ((await stale.json()) as { collectionMemberResults: Array<{ outcome: string }> })
        .collectionMemberResults[0]!.outcome,
    ).toBe('conflict');

    const after = await pull(env, token);
    expect(after.collectionMembers.find((m) => m.id === MEM)!.ord).toBe(7);
  });

  it('delete-collection cascades member tombstones', async () => {
    await post(
      env,
      '/api/sync/push',
      {
        notebookEntries: [
          { id: NB, baseVersion: 0, draft: { name: 'Work', defaultCollectionView: 'list', noteSort: 'modified' } },
        ],
        entries: [
          { id: NOTE, notebookId: NB, baseVersion: 0, draft: { title: 'n1', properties: {}, body: [] } },
          { id: NOTE2, notebookId: NB, baseVersion: 0, draft: { title: 'n2', properties: {}, body: [] } },
        ],
      },
      token,
    );
    await post(
      env,
      '/api/sync/push',
      {
        collectionEntries: [
          { id: COL, baseVersion: 0, draft: { notebookId: NB, name: 'Folder', ord: 0, rule: null } },
        ],
        collectionMemberEntries: [
          { id: MEM, baseVersion: 0, draft: { collectionId: COL, noteId: NOTE, ord: 0 } },
          { id: MEM2, baseVersion: 0, draft: { collectionId: COL, noteId: NOTE2, ord: 1 } },
        ],
      },
      token,
    );

    const del = await post(
      env,
      '/api/sync/push',
      { collectionEntries: [{ id: COL, baseVersion: 1, delete: true }] },
      token,
    );
    expect(del.status).toBe(200);
    expect(
      ((await del.json()) as { collectionResults: Array<{ outcome: string }> }).collectionResults[0]!
        .outcome,
    ).toBe('accepted');

    const after = await pull(env, token);
    expect(after.collections.find((c) => c.id === COL)!.deletedAt).not.toBeNull();
    for (const id of [MEM, MEM2]) {
      expect(after.collectionMembers.find((m) => m.id === id)!.deletedAt).not.toBeNull();
    }
  });

  it('delete-notebook cascades its collections + members', async () => {
    await post(
      env,
      '/api/sync/push',
      {
        notebookEntries: [
          { id: NB, baseVersion: 0, draft: { name: 'Work', defaultCollectionView: 'list', noteSort: 'modified' } },
        ],
        entries: [{ id: NOTE, notebookId: NB, baseVersion: 0, draft: { title: 'n', properties: {}, body: [] } }],
      },
      token,
    );
    await post(
      env,
      '/api/sync/push',
      {
        collectionEntries: [
          { id: COL, baseVersion: 0, draft: { notebookId: NB, name: 'A', ord: 0, rule: null } },
          { id: COL2, baseVersion: 0, draft: { notebookId: NB, name: 'B', ord: 1, rule: null } },
        ],
        collectionMemberEntries: [
          { id: MEM, baseVersion: 0, draft: { collectionId: COL, noteId: NOTE, ord: 0 } },
        ],
      },
      token,
    );

    const seeded = await pull(env, token);
    const nbVersion = seeded.notebooks.find((n) => n.id === NB)!.version;

    const del = await post(
      env,
      '/api/sync/push',
      { notebookEntries: [{ id: NB, baseVersion: nbVersion, delete: true }] },
      token,
    );
    expect(del.status).toBe(200);

    const after = await pull(env, token);
    expect(after.collections.find((c) => c.id === COL)!.deletedAt).not.toBeNull();
    expect(after.collections.find((c) => c.id === COL2)!.deletedAt).not.toBeNull();
    expect(after.collectionMembers.find((m) => m.id === MEM)!.deletedAt).not.toBeNull();
  });

  it('one bad member entry does NOT 400 the whole batch (GOTCHA-0008)', async () => {
    await post(
      env,
      '/api/sync/push',
      {
        notebookEntries: [
          { id: NB, baseVersion: 0, draft: { name: 'Work', defaultCollectionView: 'list', noteSort: 'modified' } },
        ],
        entries: [{ id: NOTE, notebookId: NB, baseVersion: 0, draft: { title: 'n', properties: {}, body: [] } }],
        collectionEntries: [
          { id: COL, baseVersion: 0, draft: { notebookId: NB, name: 'Folder', ord: 0, rule: null } },
        ],
      },
      token,
    );

    // Batch: one good member + one foreign-collection member + one good collection rename.
    const res = await post(
      env,
      '/api/sync/push',
      {
        collectionEntries: [
          {
            id: COL,
            baseVersion: 1,
            draft: { notebookId: NB, name: 'Renamed', ord: 0, rule: null },
          },
        ],
        collectionMemberEntries: [
          { id: MEM, baseVersion: 0, draft: { collectionId: COL, noteId: NOTE, ord: 0 } },
          { id: MEM_FOREIGN_COL, baseVersion: 0, draft: { collectionId: FOREIGN_COL, noteId: NOTE, ord: 0 } },
        ],
      },
      token,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      collectionResults: Array<{ outcome: string }>;
      collectionMemberResults: Array<{ outcome: string; id: string }>;
    };
    expect(body.collectionResults[0]!.outcome).toBe('accepted');
    expect(body.collectionMemberResults.find((r) => r.id === MEM)!.outcome).toBe('accepted');
    expect(body.collectionMemberResults.find((r) => r.id === MEM_FOREIGN_COL)!.outcome).toBe('conflict');

    const after = await pull(env, token);
    expect(after.collections.find((c) => c.id === COL)!.name).toBe('Renamed');
    expect(after.collectionMembers.find((m) => m.id === MEM)?.deletedAt ?? null).toBeNull();
    expect(after.collectionMembers.find((m) => m.id === MEM_FOREIGN_COL)).toBeUndefined();
  });
});
