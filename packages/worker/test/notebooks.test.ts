/**
 * Notebook entity tests (Notebooks task #16) — create / rename / delete-cascade / default-undeletable,
 * and the unified per-account pull (notes + notebooks on one syncSeq stream). Mutate layer over
 * better-sqlite3 (D1-compatible), same harness as conflict.test.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { isTrashed } from '@deltos/shared';
import type { NotebookPushEntry, PropertyBag, SyncPushEntry } from '@deltos/shared';
import { insertNote, pullSince } from '../src/db/mutate.js';
import {
  createDefaultNotebook,
  insertNotebook,
  renameNotebook,
  deleteNotebook,
  notesInNotebook,
} from '../src/db/notebooks.js';
import type { DbAdapter } from '../src/db/schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = [
  '0000_baseline.sql', '0001_stream-b-sync.sql', '0002_stream-a-auth.sql', '0003_account-identity.sql',
  '0004_password-auth.sql', '0005_recovery-established.sql', '0006_account-sync-seq.sql',
  '0007_reconcile-account-sync-seq.sql', '0008_notebooks.sql', '0009_backfill-default-notebooks.sql',
].map((f) => readFileSync(join(__dirname, '../migrations', f), 'utf8'));

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

const NOW = '2026-06-18T12:00:00.000Z';
const ACCT = 'acct-notebooks-0001';
const NB1 = '11111111-1111-4111-8111-111111111111';
const NB2 = '22222222-2222-4222-8222-222222222222';

function nbEntry(id: string, baseVersion: number, name = 'Work', del = false): NotebookPushEntry {
  return del
    ? { id: id as NotebookPushEntry['id'], baseVersion, delete: true }
    : { id: id as NotebookPushEntry['id'], baseVersion, draft: { name, defaultCollectionView: 'list' } };
}

function noteEntry(id: string, notebookId: string, baseVersion = 0): SyncPushEntry & { notebookId: string } {
  return {
    id: id as SyncPushEntry['id'],
    notebookId: notebookId as SyncPushEntry['notebookId'] & string,
    baseVersion,
    draft: { title: 'n', properties: {} as PropertyBag, body: [] },
  };
}

describe('notebooks — sync entity (mutate layer)', () => {
  let db: DbAdapter;
  beforeEach(() => {
    const raw = new Database(':memory:');
    for (const m of MIGRATIONS) raw.exec(m);
    db = sqliteAdapter(raw);
  });

  it('createDefaultNotebook makes exactly one undeletable default; second default is rejected', async () => {
    const def = await createDefaultNotebook(db, ACCT, 'Notes', NOW);
    expect(def.isDefault).toBe(1);
    // A second default for the same account violates the partial unique index → createDefaultNotebook
    // surfaces the existing one rather than a duplicate.
    const again = await createDefaultNotebook(db, ACCT, 'Notes', NOW);
    expect(again.id).toBe(def.id);
    const { notebooks } = await pullSince(db, ACCT, 0);
    expect(notebooks.filter((n) => n.isDefault).length).toBe(1);
  });

  it('create + rename a notebook (CAS); a stale rename conflicts', async () => {
    const created = await insertNotebook(db, nbEntry(NB1, 0, 'Work'), ACCT, NOW);
    expect(created.outcome).toBe('accepted');

    const renamed = await renameNotebook(db, nbEntry(NB1, 1, 'Job'), ACCT, NOW);
    expect(renamed.outcome).toBe('accepted');
    if (renamed.outcome === 'accepted') expect(renamed.row.name).toBe('Job');

    // Stale baseVersion (1, but it is now 2) → conflict with the current server notebook.
    const stale = await renameNotebook(db, nbEntry(NB1, 1, 'Nope'), ACCT, NOW);
    expect(stale.outcome).toBe('conflict');
    if (stale.outcome === 'conflict') {
      expect(stale.reason).toBe('stale');
      expect(stale.serverRow?.name).toBe('Job');
    }
  });

  it('the default notebook cannot be deleted', async () => {
    const def = await createDefaultNotebook(db, ACCT, 'Notes', NOW);
    const res = await deleteNotebook(db, nbEntry(def.id, def.version, '', true), ACCT, NOW);
    expect(res.outcome).toBe('conflict');
    if (res.outcome === 'conflict') expect(res.reason).toBe('default_undeletable');
    // Still live.
    const { notebooks } = await pullSince(db, ACCT, 0);
    expect(notebooks.find((n) => n.id === def.id)!.deletedAt).toBeNull();
  });

  it('deleting a non-default notebook tombstones it and moves its live notes to Trash (distinct syncSeq)', async () => {
    await insertNotebook(db, nbEntry(NB2, 0, 'Scratch'), ACCT, NOW);
    await insertNote(db, noteEntry('aaaaaaa1-0000-4000-8000-000000000001', NB2), ACCT, NOW);
    await insertNote(db, noteEntry('aaaaaaa1-0000-4000-8000-000000000002', NB2), ACCT, NOW);

    const created = await pullSince(db, ACCT, 0);
    const nbVersion = created.notebooks.find((n) => n.id === NB2)!.version;

    const del = await deleteNotebook(db, nbEntry(NB2, nbVersion, '', true), ACCT, NOW);
    expect(del.outcome).toBe('accepted');

    // Notebook tombstoned.
    const after = await pullSince(db, ACCT, 0);
    expect(after.notebooks.find((n) => n.id === NB2)!.deletedAt).not.toBeNull();

    // Both notes are now trashed (sys:trashedAt set), with DISTINCT syncSeq (no pagination-skip hazard),
    // and NOT hard-deleted.
    const rows = await notesInNotebook(db, ACCT, NB2);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(isTrashed(JSON.parse(r.properties) as PropertyBag)).toBe(true);
      expect(r.deletedAt).toBeNull(); // trashed, not hard-deleted
    }
    expect(new Set(rows.map((r) => r.syncSeq)).size).toBe(2);
  });

  it('pullSince returns notes AND notebooks on one cursor, ordered by the shared syncSeq', async () => {
    await createDefaultNotebook(db, ACCT, 'Notes', NOW);
    await insertNotebook(db, nbEntry(NB1, 0, 'Work'), ACCT, NOW);
    await insertNote(db, noteEntry('bbbbbbb1-0000-4000-8000-000000000001', NB1), ACCT, NOW);

    const { notes, notebooks, hasMore } = await pullSince(db, ACCT, 0);
    expect(hasMore).toBe(false);
    expect(notebooks.map((n) => n.name).sort()).toEqual(['Notes', 'Work']);
    expect(notes).toHaveLength(1);
    // Every entity carries a syncSeq from the SAME per-account counter (all distinct).
    const seqs = [...notes.map((n) => n.syncSeq), ...notebooks.map((n) => n.syncSeq)];
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('account isolation: a notebook is never visible to another account', async () => {
    await insertNotebook(db, nbEntry(NB1, 0, 'Secret'), ACCT, NOW);
    const { notebooks } = await pullSince(db, 'acct-other-9999', 0);
    expect(notebooks).toHaveLength(0);
  });
});
