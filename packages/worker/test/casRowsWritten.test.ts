/**
 * CAS hit-detection must be robust to D1's `meta.rows_written` counting INDEX writes.
 *
 * THE phantom-conflict root cause: updateNote/deleteNote decided CAS-hit-vs-conflict with
 * `rowsWritten === 1`. On real D1, `meta.rows_written` includes secondary-index writes, and the
 * `notes` table has 4 indexes covering the columns an UPDATE changes (syncSeq, updatedAt) — so a
 * successful single-row UPDATE reports rows_written > 1 → `=== 1` mislabeled an accepted write as a
 * CONFLICT (phantom conflict on every edit). better-sqlite3's `.changes` reports rows-CHANGED (=1),
 * so the rest of the suite (real-SQLite-backed) CANNOT catch this class — hence this mock-adapter
 * unit test that simulates D1's inflated rows_written directly.
 */

import { describe, it, expect } from 'vitest';
import type { SyncPushEntry } from '@deltos/shared';
import { updateNote } from '../src/db/mutate.js';
import type { DbAdapter, NoteRow } from '../src/db/schema.js';

const ENTRY: SyncPushEntry & { notebookId: string } = {
  id: 'note-1',
  notebookId: 'nb-1',
  baseVersion: 1,
  draft: { title: 'edited', properties: {}, body: [] },
};

const ROW = (version: number, syncSeq: number): NoteRow => ({
  id: 'note-1', notebookId: 'nb-1', accountId: 'acct-1',
  title: 'edited', properties: '{}', body: '[]',
  version, syncSeq, createdAt: 'now', updatedAt: 'now', deletedAt: null,
} as NoteRow);

/** Mock adapter: the UPDATE statement (batch index 1) reports `updateRows`; `first` returns `row`. */
function mockDb(updateRows: number, row: NoteRow): DbAdapter {
  return {
    async batch(stmts) { return stmts.map((_s, i) => ({ rowsWritten: i === 1 ? updateRows : 0 })); },
    async first<T>() { return row as unknown as T; },
    async all<T>() { return [] as T[]; },
  };
}

describe('updateNote CAS hit-detection — robust to D1 rows_written index inflation', () => {
  it('rowsWritten > 1 (real-D1 index writes) on a matched CAS is ACCEPTED, not a phantom conflict', async () => {
    const out = await updateNote(mockDb(4, ROW(2, 6)), ENTRY, 'acct-1', 'now');
    expect(out.outcome).toBe('accepted');
    expect(out.outcome === 'accepted' ? out.version : -1).toBe(2);
    expect(out.outcome === 'accepted' ? out.syncSeq : -1).toBe(6);
  });

  it('rowsWritten === 1 (single-index / better-sqlite3) is also ACCEPTED', async () => {
    const out = await updateNote(mockDb(1, ROW(2, 6)), ENTRY, 'acct-1', 'now');
    expect(out.outcome).toBe('accepted');
  });

  it('rowsWritten === 0 (the CAS matched no row) is a CONFLICT', async () => {
    const out = await updateNote(mockDb(0, ROW(5, 9)), ENTRY, 'acct-1', 'now');
    expect(out.outcome).toBe('conflict');
  });
});
