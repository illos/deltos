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
import { insertNote, updateNote, pullSince } from '../src/db/mutate.js';
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

  // --- move-note (#16) + target-ownership check (secSys gate #19 / #23) ---

  function moveEntry(id: string, baseVersion: number, toNotebook: string): SyncPushEntry {
    return {
      id: id as SyncPushEntry['id'],
      notebookId: toNotebook as SyncPushEntry['notebookId'],
      baseVersion,
      draft: { title: 'n', properties: {} as PropertyBag, body: [] },
    };
  }
  function editEntry(id: string, baseVersion: number, properties: PropertyBag): SyncPushEntry {
    return { id: id as SyncPushEntry['id'], baseVersion, draft: { title: 'n', properties, body: [] } };
  }
  const TRASHED: PropertyBag = { 'sys:trashedAt': { type: 'date', value: NOW } };
  const NOTE = 'cccccccc-0000-4000-8000-000000000001';

  it('move-note to an OWNED, LIVE notebook is accepted and restamps notebookId', async () => {
    const def = await createDefaultNotebook(db, ACCT, 'Notes', NOW);
    await insertNotebook(db, nbEntry(NB1, 0, 'Work'), ACCT, NOW);
    await insertNote(db, noteEntry(NOTE, def.id), ACCT, NOW); // born in default

    const moved = await updateNote(db, moveEntry(NOTE, 1, NB1), ACCT, NOW);
    expect(moved.outcome).toBe('accepted');
    const rows = await notesInNotebook(db, ACCT, NB1);
    expect(rows.map((r) => r.id)).toContain(NOTE);
  });

  it('move-note to a NON-OWNED / non-existent notebook is REJECTED (conflict), note stays put', async () => {
    const def = await createDefaultNotebook(db, ACCT, 'Notes', NOW);
    await insertNote(db, noteEntry(NOTE, def.id), ACCT, NOW);

    // NB2 was never created for this account (a forged / foreign / deleted notebookId).
    const res = await updateNote(db, moveEntry(NOTE, 1, NB2), ACCT, NOW);
    expect(res.outcome).toBe('conflict'); // rejected — no orphaning
    const stillInDefault = await notesInNotebook(db, ACCT, def.id);
    expect(stillInDefault.map((r) => r.id)).toContain(NOTE);
    expect(stillInDefault.find((r) => r.id === NOTE)!.version).toBe(1); // unchanged (no write)
  });

  it("move-note targeting ANOTHER account's notebook is REJECTED (ownership check)", async () => {
    const def = await createDefaultNotebook(db, ACCT, 'Notes', NOW);
    await insertNote(db, noteEntry(NOTE, def.id), ACCT, NOW);
    // A notebook that exists but belongs to a DIFFERENT account.
    await insertNotebook(db, nbEntry(NB2, 0, 'Theirs'), 'acct-other-9999', NOW);

    const res = await updateNote(db, moveEntry(NOTE, 1, NB2), ACCT, NOW);
    expect(res.outcome).toBe('conflict');
    const rows = await notesInNotebook(db, ACCT, NB2);
    expect(rows).toHaveLength(0); // never landed on the foreign notebook
  });

  it('move-note to a TOMBSTONED notebook is REJECTED — the ownership-existence check rides the atomic CAS (#25)', async () => {
    // The #25 hardening: the target-ownership check is folded into the UPDATE WHERE (EXISTS ... deletedAt
    // IS NULL), so a target that is no longer a live owned notebook AT WRITE TIME can never receive the
    // note — closing the TOCTOU window where a concurrent self-delete of the target between a separate
    // pre-read and the write transiently dangled the note on a just-deleted notebook.
    const def = await createDefaultNotebook(db, ACCT, 'Notes', NOW);
    await insertNotebook(db, nbEntry(NB1, 0, 'Work'), ACCT, NOW);
    await insertNote(db, noteEntry(NOTE, def.id), ACCT, NOW);
    // Tombstone NB1 (the would-be move target).
    const nbVersion = (await pullSince(db, ACCT, 0)).notebooks.find((n) => n.id === NB1)!.version;
    expect((await deleteNotebook(db, nbEntry(NB1, nbVersion, '', true), ACCT, NOW)).outcome).toBe('accepted');

    const res = await updateNote(db, moveEntry(NOTE, 1, NB1), ACCT, NOW);
    expect(res.outcome).toBe('conflict'); // rejected by the atomic guard — no orphaning onto a dead notebook
    const stillInDefault = await notesInNotebook(db, ACCT, def.id);
    expect(stillInDefault.find((r) => r.id === NOTE)!.notebookId).toBe(def.id); // never landed on NB1
    expect(stillInDefault.find((r) => r.id === NOTE)!.version).toBe(1); // 0-row CAS — note unchanged
  });

  // --- restore-from-Trash notebookId resolution (#22) ---

  it('restore (clear trash) when the notebook is LIVE keeps the note where it was', async () => {
    const def = await createDefaultNotebook(db, ACCT, 'Notes', NOW);
    await insertNotebook(db, nbEntry(NB1, 0, 'Work'), ACCT, NOW);
    await insertNote(db, noteEntry(NOTE, NB1), ACCT, NOW);

    await updateNote(db, editEntry(NOTE, 1, TRASHED), ACCT, NOW); // trash (v2)
    const restored = await updateNote(db, editEntry(NOTE, 2, {}), ACCT, NOW); // restore (v3)
    expect(restored.outcome).toBe('accepted');
    if (restored.outcome === 'accepted') expect(restored.row.notebookId).toBe(NB1); // unchanged
    expect(def.id).not.toBe(NB1);
  });

  it('restore of a note orphaned by notebook-deletion reassigns it to the DEFAULT notebook', async () => {
    const def = await createDefaultNotebook(db, ACCT, 'Notes', NOW);
    await insertNotebook(db, nbEntry(NB1, 0, 'Work'), ACCT, NOW);
    await insertNote(db, noteEntry(NOTE, NB1), ACCT, NOW);

    // Delete NB1 → cascade-trashes the note (server-side) + bumps its version.
    const nbVersion = (await pullSince(db, ACCT, 0)).notebooks.find((n) => n.id === NB1)!.version;
    await deleteNotebook(db, nbEntry(NB1, nbVersion, '', true), ACCT, NOW);

    const note = (await notesInNotebook(db, ACCT, NB1))[0]!;
    expect(isTrashed(JSON.parse(note.properties) as PropertyBag)).toBe(true);

    // Restore (clear trash). notebookId NB1 is now tombstoned → must reassign to the default.
    const restored = await updateNote(db, editEntry(NOTE, note.version, {}), ACCT, NOW);
    expect(restored.outcome).toBe('accepted');
    if (restored.outcome === 'accepted') expect(restored.row.notebookId).toBe(def.id); // → default
  });

  it('restore when NO default exists yet (backfill-held state) keeps current notebookId — never NULL', async () => {
    // No default notebook for this account; note points at a notebookId with no live notebook row.
    await insertNote(db, noteEntry(NOTE, NB1), ACCT, NOW);
    await updateNote(db, editEntry(NOTE, 1, TRASHED), ACCT, NOW);
    const restored = await updateNote(db, editEntry(NOTE, 2, {}), ACCT, NOW);
    expect(restored.outcome).toBe('accepted');
    if (restored.outcome === 'accepted') expect(restored.row.notebookId).toBe(NB1); // COALESCE fallback, not NULL
  });
});
