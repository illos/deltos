/**
 * Collection + CollectionMember entity tests (collections.md §3/§4) — create / rename / delete-cascade,
 * member add/remove/reorder, ownership belts, and the unified per-account pull stream arms.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type {
  CollectionPushEntry,
  CollectionMemberPushEntry,
  NotebookPushEntry,
  PropertyBag,
  SyncPushEntry,
} from '@deltos/shared';
import { collectionMemberId } from '@deltos/shared';
import { insertNote, pullSince } from '../src/db/mutate.js';
import { insertNotebook, deleteNotebook } from '../src/db/notebooks.js';
import {
  insertCollection,
  renameCollection,
  deleteCollection,
  addMember,
  removeMember,
  reorderMember,
  membersForCollection,
  listCollectionsForAccount,
  collectionsTestHooks,
} from '../src/db/collections.js';
import type { DbAdapter } from '../src/db/schema.js';
import { allMigrations } from './helpers/migrations.js';

const MIGRATIONS = allMigrations();

function sqliteAdapter(db: Database.Database): DbAdapter {
  return {
    async batch(stmts) {
      const results: Array<{ rowsWritten: number }> = [];
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

const NOW = '2026-07-28T12:00:00.000Z';
const ACCT = 'acct-collections-0001';
const ACCT2 = 'acct-collections-0002';
const NB1 = '11111111-1111-4111-8111-111111111111';
const NB2 = '22222222-2222-4222-8222-222222222222';
const COL1 = 'c1111111-1111-4111-8111-111111111111';
const COL2 = 'c2222222-2222-4222-8222-222222222222';
const NOTE1 = 'a1111111-1111-4111-8111-111111111111';
const NOTE2 = 'a2222222-2222-4222-8222-222222222222';
const NOTE_NB2 = 'a3333333-3333-4333-8333-333333333333';
// Deterministic member ids (client + server must both use collectionMemberId).
const MEM1 = collectionMemberId(COL1, NOTE1);
const MEM2 = collectionMemberId(COL1, NOTE2);
const FOREIGN_NB = 'f1111111-1111-4111-8111-111111111111';
const FOREIGN_COL = 'f2222222-2222-4222-8222-222222222222';
const FOREIGN_NOTE = 'f3333333-3333-4333-8333-333333333333';

function nbEntry(id: string, baseVersion: number, name = 'Work'): NotebookPushEntry {
  return {
    id: id as NotebookPushEntry['id'],
    baseVersion,
    draft: { name, defaultCollectionView: 'list', noteSort: 'modified' },
  };
}

function colEntry(
  id: string,
  baseVersion: number,
  opts: { name?: string; notebookId?: string | null; ord?: number; del?: boolean } = {},
): CollectionPushEntry {
  if (opts.del) {
    return { id: id as CollectionPushEntry['id'], baseVersion, delete: true };
  }
  return {
    id: id as CollectionPushEntry['id'],
    baseVersion,
    draft: {
      notebookId: (opts.notebookId === undefined ? NB1 : opts.notebookId) as CollectionPushEntry extends {
        draft?: { notebookId: infer N };
      }
        ? N
        : never,
      name: opts.name ?? 'Folder',
      ord: opts.ord ?? 0,
      rule: null,
    },
  };
}

function memEntry(
  id: string,
  baseVersion: number,
  opts: { collectionId?: string; noteId?: string; ord?: number; del?: boolean } = {},
): CollectionMemberPushEntry {
  const collectionId = opts.collectionId ?? COL1;
  const noteId = opts.noteId ?? NOTE1;
  if (opts.del) {
    return { id: id as CollectionMemberPushEntry['id'], baseVersion, delete: true };
  }
  return {
    id: id as CollectionMemberPushEntry['id'],
    baseVersion,
    draft: {
      collectionId: collectionId as CollectionMemberPushEntry extends {
        draft?: { collectionId: infer C };
      }
        ? C
        : never,
      noteId: noteId as CollectionMemberPushEntry extends { draft?: { noteId: infer N } } ? N : never,
      ord: opts.ord ?? 0,
    },
  };
}

function noteEntry(id: string, notebookId: string | null, baseVersion = 0): SyncPushEntry & { notebookId: string | null } {
  return {
    id: id as SyncPushEntry['id'],
    notebookId: notebookId as (SyncPushEntry['notebookId'] & string) | null,
    baseVersion,
    draft: { title: 'n', properties: {} as PropertyBag, body: [] },
  };
}

describe('collections — sync entity (mutate layer)', () => {
  let db: DbAdapter;

  beforeEach(async () => {
    const raw = new Database(':memory:');
    for (const m of MIGRATIONS) raw.exec(m);
    db = sqliteAdapter(raw);
    // Seed account sync counter + a home notebook + two notes.
    await db.batch([{ sql: `INSERT INTO accountSyncSeq (accountId, seq) VALUES (?, 0)`, params: [ACCT] }]);
    await insertNotebook(db, nbEntry(NB1, 0), ACCT, NOW);
    await insertNote(db, noteEntry(NOTE1, NB1), ACCT, NOW);
    await insertNote(db, noteEntry(NOTE2, NB1), ACCT, NOW);
  });

  it('create + rename a collection (CAS); stale rename conflicts', async () => {
    const created = await insertCollection(db, colEntry(COL1, 0, { name: 'Alpha' }), ACCT, NOW);
    expect(created.outcome).toBe('accepted');
    if (created.outcome === 'accepted') {
      expect(created.row.name).toBe('Alpha');
      expect(created.row.notebookId).toBe(NB1);
      expect(created.row.ord).toBe(0);
      expect(created.row.rule).toBeNull();
    }

    const renamed = await renameCollection(db, colEntry(COL1, 1, { name: 'Beta', ord: 2 }), ACCT, NOW);
    expect(renamed.outcome).toBe('accepted');
    if (renamed.outcome === 'accepted') {
      expect(renamed.row.name).toBe('Beta');
      expect(renamed.row.ord).toBe(2);
    }

    const stale = await renameCollection(db, colEntry(COL1, 1, { name: 'Nope' }), ACCT, NOW);
    expect(stale.outcome).toBe('conflict');
    if (stale.outcome === 'conflict') expect(stale.serverRow?.name).toBe('Beta');
  });

  it('insertCollection rejects a foreign / missing notebookId as conflict', async () => {
    const bad = await insertCollection(
      db,
      colEntry(COL1, 0, { notebookId: FOREIGN_NB }),
      ACCT,
      NOW,
    );
    expect(bad.outcome).toBe('conflict');
    const listed = await listCollectionsForAccount(db, ACCT);
    expect(listed).toHaveLength(0);
  });

  it('addMember + reorderMember (CAS); removeMember tombstones', async () => {
    await insertCollection(db, colEntry(COL1, 0), ACCT, NOW);

    const added = await addMember(db, memEntry(MEM1, 0, { ord: 1 }), ACCT, NOW);
    expect(added.outcome).toBe('accepted');
    if (added.outcome === 'accepted') expect(added.row.ord).toBe(1);

    const reordered = await reorderMember(db, memEntry(MEM1, 1, { ord: 5 }), ACCT, NOW);
    expect(reordered.outcome).toBe('accepted');
    if (reordered.outcome === 'accepted') expect(reordered.row.ord).toBe(5);

    const stale = await reorderMember(db, memEntry(MEM1, 1, { ord: 9 }), ACCT, NOW);
    expect(stale.outcome).toBe('conflict');

    const removed = await removeMember(db, memEntry(MEM1, 2, { del: true }), ACCT, NOW);
    expect(removed.outcome).toBe('accepted');
    if (removed.outcome === 'accepted') expect(removed.row.deletedAt).not.toBeNull();

    const live = await membersForCollection(db, ACCT, COL1);
    expect(live).toHaveLength(0);
  });

  it('addMember rejects foreign collection or foreign note as conflict (no orphan row)', async () => {
    await insertCollection(db, colEntry(COL1, 0), ACCT, NOW);

    const foreignColId = collectionMemberId(FOREIGN_COL, NOTE1);
    const foreignCol = await addMember(
      db,
      memEntry(foreignColId, 0, { collectionId: FOREIGN_COL, noteId: NOTE1 }),
      ACCT,
      NOW,
    );
    expect(foreignCol.outcome).toBe('conflict');

    const foreignNoteId = collectionMemberId(COL1, FOREIGN_NOTE);
    const foreignNote = await addMember(
      db,
      memEntry(foreignNoteId, 0, { collectionId: COL1, noteId: FOREIGN_NOTE }),
      ACCT,
      NOW,
    );
    expect(foreignNote.outcome).toBe('conflict');

    expect(await membersForCollection(db, ACCT, COL1)).toHaveLength(0);
  });

  it('remove→readd of the same (collection, note) reuses the SAME deterministic member id (one live row)', async () => {
    await insertCollection(db, colEntry(COL1, 0), ACCT, NOW);
    const first = await addMember(db, memEntry(MEM1, 0), ACCT, NOW);
    expect(first.outcome).toBe('accepted');
    if (first.outcome === 'accepted') expect(first.row.id).toBe(MEM1);

    await removeMember(db, memEntry(MEM1, 1, { del: true }), ACCT, NOW);

    // Same deterministic id for the same triple — revive in place, never a second row / re-key.
    const sameId = collectionMemberId(COL1, NOTE1);
    expect(sameId).toBe(MEM1);
    const revived = await addMember(db, memEntry(sameId, 0, { ord: 3 }), ACCT, NOW);
    expect(revived.outcome).toBe('accepted');
    if (revived.outcome === 'accepted') {
      expect(revived.row.id).toBe(MEM1);
      expect(revived.row.deletedAt).toBeNull();
      expect(revived.row.ord).toBe(3);
    }
    const live = await membersForCollection(db, ACCT, COL1);
    expect(live).toHaveLength(1);
    expect(live[0]!.id).toBe(MEM1);

    // Two independent adds of the same triple converge to one row.
    const again = await addMember(db, memEntry(MEM1, 0, { ord: 9 }), ACCT, NOW);
    expect(again.outcome).toBe('accepted');
    if (again.outcome === 'accepted') {
      expect(again.row.id).toBe(MEM1);
      expect(again.row.ord).toBe(9);
    }
    expect(await membersForCollection(db, ACCT, COL1)).toHaveLength(1);
  });

  it('collectionMemberId is stable and distinct per (collection, note) pair', () => {
    expect(collectionMemberId(COL1, NOTE1)).toBe(collectionMemberId(COL1, NOTE1));
    expect(collectionMemberId(COL1, NOTE1)).not.toBe(collectionMemberId(COL1, NOTE2));
    expect(collectionMemberId(COL1, NOTE1)).not.toBe(collectionMemberId(COL2, NOTE1));
  });

  it('deleteCollection tombstones the collection AND all live members (distinct syncSeq)', async () => {
    await insertCollection(db, colEntry(COL1, 0), ACCT, NOW);
    await addMember(db, memEntry(MEM1, 0, { noteId: NOTE1 }), ACCT, NOW);
    await addMember(db, memEntry(MEM2, 0, { noteId: NOTE2 }), ACCT, NOW);

    const del = await deleteCollection(db, colEntry(COL1, 1, { del: true }), ACCT, NOW);
    expect(del.outcome).toBe('accepted');

    const { collections, collectionMembers } = await pullSince(db, ACCT, 0);
    const col = collections.find((c) => c.id === COL1)!;
    expect(col.deletedAt).not.toBeNull();

    const mems = collectionMembers.filter((m) => m.collectionId === COL1);
    expect(mems).toHaveLength(2);
    for (const m of mems) expect(m.deletedAt).not.toBeNull();
    expect(new Set(mems.map((m) => m.syncSeq)).size).toBe(2);
  });

  it('deleteNotebook cascades: tombstones home collections + their members', async () => {
    await insertCollection(db, colEntry(COL1, 0), ACCT, NOW);
    await insertCollection(db, colEntry(COL2, 0, { name: 'Other' }), ACCT, NOW);
    await addMember(db, memEntry(MEM1, 0, { collectionId: COL1, noteId: NOTE1 }), ACCT, NOW);

    const { notebooks } = await pullSince(db, ACCT, 0);
    const nbVersion = notebooks.find((n) => n.id === NB1)!.version;

    const del = await deleteNotebook(
      db,
      { id: NB1 as NotebookPushEntry['id'], baseVersion: nbVersion, delete: true },
      ACCT,
      NOW,
    );
    expect(del.outcome).toBe('accepted');

    const after = await pullSince(db, ACCT, 0);
    for (const id of [COL1, COL2]) {
      expect(after.collections.find((c) => c.id === id)!.deletedAt).not.toBeNull();
    }
    expect(after.collectionMembers.find((m) => m.id === MEM1)!.deletedAt).not.toBeNull();
  });

  it('collections + members ride the unified pull stream', async () => {
    await insertCollection(db, colEntry(COL1, 0), ACCT, NOW);
    await addMember(db, memEntry(MEM1, 0), ACCT, NOW);

    const page = await pullSince(db, ACCT, 0);
    expect(page.collections.some((c) => c.id === COL1)).toBe(true);
    expect(page.collectionMembers.some((m) => m.id === MEM1)).toBe(true);
  });

  it('cross-account: another account cannot see or mutate collections', async () => {
    await insertCollection(db, colEntry(COL1, 0), ACCT, NOW);
    await db.batch([{ sql: `INSERT INTO accountSyncSeq (accountId, seq) VALUES (?, 0)`, params: [ACCT2] }]);

    const otherPull = await pullSince(db, ACCT2, 0);
    expect(otherPull.collections).toHaveLength(0);

    // ACCT2 tries to add a member into ACCT's collection → ownership belt rejects.
    const bad = await addMember(db, memEntry(MEM1, 0), ACCT2, NOW);
    expect(bad.outcome).toBe('conflict');
  });

  // ---------------------------------------------------------------------------
  // Red-team catch-tests (Lane 1 revision 2)
  // ---------------------------------------------------------------------------

  it('[P0] cascade seqs are unique, ≤ accountSyncSeq, and a later write still pulls', async () => {
    await insertCollection(db, colEntry(COL1, 0), ACCT, NOW);
    await addMember(db, memEntry(MEM1, 0, { noteId: NOTE1 }), ACCT, NOW);
    await addMember(db, memEntry(MEM2, 0, { noteId: NOTE2 }), ACCT, NOW);

    const before = await pullSince(db, ACCT, 0);
    const cursorBeforeDelete = before.nextCursor;

    const del = await deleteCollection(db, colEntry(COL1, 1, { del: true }), ACCT, NOW);
    expect(del.outcome).toBe('accepted');

    const counter = await db.first<{ seq: number }>(
      `SELECT seq FROM accountSyncSeq WHERE accountId = ?`,
      [ACCT],
    );
    const seqCeiling = counter!.seq;

    const after = await pullSince(db, ACCT, 0);
    const mems = after.collectionMembers.filter((m) => m.collectionId === COL1);
    expect(mems).toHaveLength(2);
    const seqs = mems.map((m) => m.syncSeq);
    expect(new Set(seqs).size).toBe(2);
    for (const s of seqs) {
      expect(s).toBeGreaterThan(0);
      expect(s).toBeLessThanOrEqual(seqCeiling);
    }
    // Parent collection tombstone also ≤ ceiling.
    expect(after.collections.find((c) => c.id === COL1)!.syncSeq).toBeLessThanOrEqual(seqCeiling);

    // A write after the cascade must still be returned by a pull from the pre-delete cursor.
    await insertCollection(db, colEntry(COL2, 0, { name: 'After' }), ACCT, NOW);
    const page = await pullSince(db, ACCT, cursorBeforeDelete);
    expect(page.collections.some((c) => c.id === COL2 && c.deletedAt === null)).toBe(true);
    // Cascaded tombstones also stream past that cursor.
    expect(page.collectionMembers.filter((m) => m.deletedAt !== null).length).toBeGreaterThanOrEqual(2);
  });

  it('[P1] deleteCollection is resumable after mid-cascade throw (no live member stragglers)', async () => {
    await insertCollection(db, colEntry(COL1, 0), ACCT, NOW);
    await addMember(db, memEntry(MEM1, 0, { noteId: NOTE1 }), ACCT, NOW);
    await addMember(db, memEntry(MEM2, 0, { noteId: NOTE2 }), ACCT, NOW);

    collectionsTestHooks.beforeMemberCascade = () => {
      collectionsTestHooks.beforeMemberCascade = null;
      throw new Error('injected member-cascade failure');
    };
    await expect(deleteCollection(db, colEntry(COL1, 1, { del: true }), ACCT, NOW)).rejects.toThrow(
      /injected member-cascade/,
    );

    // Parent is tombstoned; members may still be live (partial state).
    const mid = await pullSince(db, ACCT, 0);
    expect(mid.collections.find((c) => c.id === COL1)!.deletedAt).not.toBeNull();

    // Retry with the same baseVersion — resumable path finishes the cascade.
    const retry = await deleteCollection(db, colEntry(COL1, 1, { del: true }), ACCT, NOW);
    expect(retry.outcome).toBe('accepted');
    expect(await membersForCollection(db, ACCT, COL1)).toHaveLength(0);
    const after = await pullSince(db, ACCT, 0);
    for (const id of [MEM1, MEM2]) {
      expect(after.collectionMembers.find((m) => m.id === id)!.deletedAt).not.toBeNull();
    }
  });

  it('[P1] deleteNotebook is resumable after mid notebook-collection cascade throw', async () => {
    await insertCollection(db, colEntry(COL1, 0), ACCT, NOW);
    await insertCollection(db, colEntry(COL2, 0, { name: 'Other' }), ACCT, NOW);
    await addMember(db, memEntry(MEM1, 0, { collectionId: COL1, noteId: NOTE1 }), ACCT, NOW);

    const { notebooks } = await pullSince(db, ACCT, 0);
    const nbVersion = notebooks.find((n) => n.id === NB1)!.version;

    collectionsTestHooks.beforeNotebookCollectionCascade = () => {
      collectionsTestHooks.beforeNotebookCollectionCascade = null;
      throw new Error('injected notebook-collection cascade failure');
    };
    await expect(
      deleteNotebook(
        db,
        { id: NB1 as NotebookPushEntry['id'], baseVersion: nbVersion, delete: true },
        ACCT,
        NOW,
      ),
    ).rejects.toThrow(/injected notebook-collection/);

    // Retry completes: no live collections or members under the notebook.
    const retry = await deleteNotebook(
      db,
      { id: NB1 as NotebookPushEntry['id'], baseVersion: nbVersion, delete: true },
      ACCT,
      NOW,
    );
    expect(retry.outcome).toBe('accepted');
    expect(await listCollectionsForAccount(db, ACCT)).toHaveLength(0);
    expect(await membersForCollection(db, ACCT, COL1)).toHaveLength(0);
  });

  it('[P1] mismatched member id → per-entry conflict; response id === persisted id', async () => {
    await insertCollection(db, colEntry(COL1, 0), ACCT, NOW);
    const randomId = '99999999-9999-4999-8999-999999999999';
    const bad = await addMember(
      db,
      memEntry(randomId, 0, { collectionId: COL1, noteId: NOTE1 }),
      ACCT,
      NOW,
    );
    expect(bad.outcome).toBe('conflict');
    expect(await membersForCollection(db, ACCT, COL1)).toHaveLength(0);

    const good = await addMember(db, memEntry(MEM1, 0), ACCT, NOW);
    expect(good.outcome).toBe('accepted');
    if (good.outcome === 'accepted') {
      expect(good.row.id).toBe(MEM1);
      expect(good.row.id).toBe(collectionMemberId(COL1, NOTE1));
    }
    const pulled = (await pullSince(db, ACCT, 0)).collectionMembers.find((m) => m.noteId === NOTE1)!;
    expect(pulled.id).toBe(MEM1);
  });

  it('[P2] null-home create/rename → conflict; home move → conflict; cross-notebook member → conflict', async () => {
    await insertNotebook(db, nbEntry(NB2, 0, 'OtherNB'), ACCT, NOW);
    await insertNote(db, noteEntry(NOTE_NB2, NB2), ACCT, NOW);

    // null home create
    const nullCreate = await insertCollection(db, colEntry(COL1, 0, { notebookId: null }), ACCT, NOW);
    expect(nullCreate.outcome).toBe('conflict');

    await insertCollection(db, colEntry(COL1, 0, { notebookId: NB1 }), ACCT, NOW);

    // null home rename
    const nullRename = await renameCollection(
      db,
      colEntry(COL1, 1, { notebookId: null, name: 'X' }),
      ACCT,
      NOW,
    );
    expect(nullRename.outcome).toBe('conflict');

    // home move attempt
    const move = await renameCollection(
      db,
      colEntry(COL1, 1, { notebookId: NB2, name: 'Moved' }),
      ACCT,
      NOW,
    );
    expect(move.outcome).toBe('conflict');
    const still = await listCollectionsForAccount(db, ACCT);
    expect(still.find((c) => c.id === COL1)!.notebookId).toBe(NB1);
    expect(still.find((c) => c.id === COL1)!.name).toBe('Folder');

    // cross-notebook member (note lives in NB2, collection home is NB1)
    const crossId = collectionMemberId(COL1, NOTE_NB2);
    const cross = await addMember(
      db,
      memEntry(crossId, 0, { collectionId: COL1, noteId: NOTE_NB2 }),
      ACCT,
      NOW,
    );
    expect(cross.outcome).toBe('conflict');
    expect(await membersForCollection(db, ACCT, COL1)).toHaveLength(0);
  });
});
