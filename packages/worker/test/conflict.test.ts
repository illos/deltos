/**
 * Conflict engine tests — RED before implementation, GREEN after.
 *
 * These test the atomic CAS + sync-cursor logic in db/mutate.ts using better-sqlite3
 * (D1-compatible SQLite). Each test maps to a named acceptance criterion from the spec
 * (phase-1-vertical-slice.md Stream B).
 *
 * secSys focus: PIN-SYNC-1 (CAS must raise conflict, not silently lose writes).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { insertNote, updateNote, deleteNote, pullNotes } from '../src/db/mutate.js';
import type { DbAdapter, NoteRow } from '../src/db/schema.js';
import type { SyncPushEntry } from '@deltos/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// better-sqlite3 adapter (mirrors d1Adapter, synchronous API, same SQL dialect)
// ---------------------------------------------------------------------------

function sqliteAdapter(db: Database.Database): DbAdapter {
  return {
    async batch(stmts) {
      const results: { rowsWritten: number }[] = [];
      const txn = db.transaction(() => {
        for (const s of stmts) {
          const info = db.prepare(s.sql).run(...(s.params as Array<string | number | null>));
          results.push({ rowsWritten: info.changes });
        }
      });
      txn();
      return results;
    },
    async first<T>(sql: string, params: unknown[]) {
      const row = db.prepare(sql).get(...(params as Array<string | number | null>));
      return (row ?? null) as T | null;
    },
    async all<T>(sql: string, params: unknown[]) {
      return db.prepare(sql).all(...(params as Array<string | number | null>)) as T[];
    },
  };
}

// ---------------------------------------------------------------------------
// Schema setup: apply the same migration files the production D1 uses
// ---------------------------------------------------------------------------

// 0002 (auth) + 0003 (account-identity) are applied too: 0003 adds the notes.accountId column the
// scoped mutate.ts queries filter on, and its back-fill/re-point reference the 0002 devices/grants tables.
// On a fresh empty DB the 0003 guard + back-fill are no-ops (no devices, no notes yet).
const migrations = [
  '0000_baseline.sql',
  '0001_stream-b-sync.sql',
  '0002_stream-a-auth.sql',
  '0003_account-identity.sql',
  '0006_account-sync-seq.sql',
  '0007_reconcile-account-sync-seq.sql',
  '0008_notebooks.sql',
  '0009_backfill-default-notebooks.sql',
].map((f) =>
  readFileSync(join(__dirname, '../migrations', f), 'utf8'),
);

function freshDb(): { db: DbAdapter; raw: Database.Database } {
  const raw = new Database(':memory:');
  // db.exec() runs a full multi-statement SQL file, handling ';' inside comments correctly.
  for (const migration of migrations) {
    raw.exec(migration);
  }
  return { db: sqliteAdapter(raw), raw };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = '2026-06-15T12:00:00.000Z';
const NB = '00000000-0000-4000-8000-000000000001' as const;
// All notes in these single-account CAS/cursor tests belong to one account; the accountId param is
// required (fail-closed) but the scoping is exercised by isolation.acceptance.test.ts, not here.
const ACCT = 'acct-conflict-test-0001';

function entry(id: string, baseVersion: number, title = 'Test'): SyncPushEntry & { notebookId: string } {
  return {
    id: id as SyncPushEntry['id'],
    notebookId: NB as SyncPushEntry['notebookId'] & string,
    baseVersion,
    draft: {
      title,
      properties: {},
      body: [],
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('conflict engine — server-side CAS (PIN-SYNC-1)', () => {
  let db: DbAdapter;

  beforeEach(() => {
    ({ db } = freshDb());
  });

  /**
   * Acceptance criterion: concurrent-push-raises-conflict
   * Two pushes at the same baseVersion → first accepted, second raises conflict.
   * Both copies must survive (the original at version 2, conflict result carries server state).
   */
  it('concurrent push on the same base version raises conflict and both copies survive', async () => {
    const id = '00000000-0000-4000-8000-000000000002';

    // Insert the note (baseVersion = 0 → new note)
    const first = await insertNote(db, entry(id, 0, 'Original'), ACCT, NOW);
    expect(first.outcome).toBe('accepted');
    if (first.outcome !== 'accepted') throw new Error('setup failed');
    expect(first.version).toBe(1);

    // Two concurrent UPDATE attempts at the same baseVersion = 1
    const [aResult, bResult] = await Promise.all([
      updateNote(db, entry(id, 1, 'Device A edit'), ACCT, NOW),
      updateNote(db, entry(id, 1, 'Device B edit'), ACCT, NOW),
    ]);

    // Exactly one must succeed and one must raise a conflict
    const outcomes = [aResult.outcome, bResult.outcome].sort();
    expect(outcomes).toEqual(['accepted', 'conflict']);

    // The accepted write bumped the version; the conflicting result returns the server row
    const accepted = aResult.outcome === 'accepted' ? aResult : bResult;
    const conflicted = aResult.outcome === 'conflict' ? aResult : bResult;

    expect(accepted.outcome).toBe('accepted');
    expect(accepted.version).toBe(2); // version incremented from 1 → 2

    expect(conflicted.outcome).toBe('conflict');
    // Server row returned so the client can fork — must exist and carry the committed title
    const serverRow = (conflicted as { outcome: 'conflict'; serverRow: NoteRow | null }).serverRow;
    expect(serverRow).not.toBeNull();
    expect(serverRow!.version).toBe(2); // reflects the winning write
  });

  /**
   * Acceptance criterion: delete-vs-edit (PIN-SYNC-3)
   * The server tombstones a note; a concurrent push update sees conflict with
   * serverNote.deletedAt non-null, signalling the client to apply the resurrection fork.
   */
  it('push to a tombstoned note returns conflict with serverNote.deletedAt set', async () => {
    const id = '00000000-0000-4000-8000-000000000003';

    // Create the note
    await insertNote(db, entry(id, 0, 'Will be deleted'), ACCT, NOW);

    // Tombstone it (simulating a delete from another device)
    const del = await deleteNote(db, id, NB, ACCT, 1, NOW);
    expect(del.outcome).toBe('accepted');

    // Now push an update at the old baseVersion — should conflict
    const conflict = await updateNote(db, entry(id, 1, 'Offline edit'), ACCT, NOW);
    expect(conflict.outcome).toBe('conflict');

    const serverRow = (conflict as { outcome: 'conflict'; serverRow: NoteRow | null }).serverRow;
    expect(serverRow).not.toBeNull();
    // deletedAt must be non-null so the client knows this is a resurrection scenario
    expect(serverRow!.deletedAt).not.toBeNull();
  });

  /**
   * deleteNote CAS: when expectedVersion is supplied it gates on the version (PIN-SYNC-1).
   * A delete at a STALE expectedVersion must conflict — not tombstone the moved-on note.
   */
  it('deleteNote with a stale expectedVersion raises conflict, leaving the note live', async () => {
    const id = '00000000-0000-4000-8000-000000000009';

    // Create (version 1), then a concurrent edit moves it to version 2.
    await insertNote(db, entry(id, 0, 'Original'), ACCT, NOW);
    const edit = await updateNote(db, entry(id, 1, 'Edited elsewhere'), ACCT, NOW);
    expect(edit.outcome).toBe('accepted');

    // Delete still believing the note is at version 1 — must CAS-miss → conflict.
    const del = await deleteNote(db, id, NB, ACCT, 1, NOW);
    expect(del.outcome).toBe('conflict');
    const serverRow = (del as { outcome: 'conflict'; serverRow: NoteRow | null }).serverRow;
    expect(serverRow).not.toBeNull();
    expect(serverRow!.version).toBe(2);
    expect(serverRow!.deletedAt).toBeNull(); // not tombstoned — the stale delete was refused

    // A delete at the correct version still succeeds (the clause gates, it doesn't block).
    const ok = await deleteNote(db, id, NB, ACCT, 2, NOW);
    expect(ok.outcome).toBe('accepted');
  });

  /**
   * Pull cursor (PIN-SYNC-2): notes are returned in syncSeq order;
   * the nextCursor advances correctly; a pull with the returned cursor yields no duplicates.
   */
  it('pull returns notes in syncSeq order and cursor advances without duplication', async () => {
    const id1 = '00000000-0000-4000-8000-000000000004';
    const id2 = '00000000-0000-4000-8000-000000000005';

    await insertNote(db, entry(id1, 0, 'Note 1'), ACCT, NOW);
    await insertNote(db, entry(id2, 0, 'Note 2'), ACCT, NOW);

    // Full sync (cursor = 0) — pull is account-scoped (Option B); notebookId is not a sync boundary.
    const page1 = await pullNotes(db, ACCT, 0);
    expect(page1.notes).toHaveLength(2);
    expect(page1.hasMore).toBe(false);
    // Monotone order
    expect(page1.notes[0].syncSeq).toBeLessThan(page1.notes[1].syncSeq);

    const cursor = page1.nextCursor;
    expect(cursor).toBe(page1.notes[1].syncSeq);

    // Incremental pull — nothing new
    const page2 = await pullNotes(db, ACCT, cursor);
    expect(page2.notes).toHaveLength(0);
    expect(page2.nextCursor).toBe(cursor); // cursor unchanged when no results

    // Update note 1 — it must now appear in a pull since cursor
    await updateNote(db, entry(id1, 1, 'Note 1 updated'), ACCT, NOW);
    const page3 = await pullNotes(db, ACCT, cursor);
    expect(page3.notes).toHaveLength(1);
    expect(page3.notes[0].id).toBe(id1);
    expect(page3.notes[0].title).toBe('Note 1 updated');
    expect(page3.notes[0].syncSeq).toBeGreaterThan(cursor);
  });
});

// ---------------------------------------------------------------------------
// Fix A regression (P0 sync, 2026-06-18) — Option B: the sync boundary is the ACCOUNT, not a
// device-local notebookId. These lock in the behavior that fixes cross-device sync.
// ---------------------------------------------------------------------------

describe('Fix A — account-scoped sync (Option B): notebookId is not the sync boundary', () => {
  let db: DbAdapter;
  beforeEach(() => {
    ({ db } = freshDb());
  });

  const ACCT2 = 'acct-fixA-0001';
  const NB_A = '11111111-1111-4111-8111-111111111111'; // "laptop" notebookId tag
  const NB_B = '22222222-2222-4222-8222-222222222222'; // "phone" notebookId tag

  function entryNb(
    id: string,
    notebookId: string,
    baseVersion: number,
    title = 'T',
    body: SyncPushEntry['draft']['body'] = [],
  ): SyncPushEntry & { notebookId: string } {
    return {
      id: id as SyncPushEntry['id'],
      notebookId: notebookId as SyncPushEntry['notebookId'] & string,
      baseVersion,
      draft: { title, properties: {}, body },
    };
  }

  it('one account-scoped pull returns notes created under DIFFERENT notebookIds (cross-device convergence — the P0 fix)', async () => {
    const idA = '33333333-3333-4333-8333-333333333333';
    const idB = '44444444-4444-4444-8444-444444444444';
    await insertNote(db, entryNb(idA, NB_A, 0, 'from device A'), ACCT2, NOW);
    await insertNote(db, entryNb(idB, NB_B, 0, 'from device B'), ACCT2, NOW);

    const { notes } = await pullNotes(db, ACCT2, 0);
    expect(notes.map((n) => n.id).sort()).toEqual([idA, idB].sort());
    // Each note keeps its own organizing notebookId tag in the payload.
    expect(notes.find((n) => n.id === idA)!.notebookId).toBe(NB_A);
    expect(notes.find((n) => n.id === idB)!.notebookId).toBe(NB_B);
    // syncSeq is unique + monotonic across the whole account (not per notebook).
    expect(new Set(notes.map((n) => n.syncSeq)).size).toBe(2);
  });

  it('a plain edit (no notebookId in the entry) hits the same note id and does NOT move it (no phantom conflict, no accidental move)', async () => {
    const id = '55555555-5555-4555-8555-555555555555';
    expect((await insertNote(db, entryNb(id, NB_A, 0, 'orig'), ACCT2, NOW)).outcome).toBe('accepted');

    // An ordinary edit OMITS notebookId. Pre-Fix-A a notebookId mismatch missed the CAS → phantom
    // conflict; now the CAS hits on (id, accountId, version) and the note stays in NB_A (no restamp).
    const editEntry: SyncPushEntry = {
      id: id as SyncPushEntry['id'],
      baseVersion: 1,
      draft: { title: 'edited', properties: {}, body: [] },
    };
    const upd = await updateNote(db, editEntry, ACCT2, NOW);
    expect(upd.outcome).toBe('accepted');

    const { notes } = await pullNotes(db, ACCT2, 0);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.title).toBe('edited');
    expect(notes[0]!.notebookId).toBe(NB_A); // unchanged — a plain edit never moves the note
  });

  // (move-note + restore-resolution are tested in notebooks.test.ts, where real notebook entities exist
  // to validate the move-target ownership check (#23) and the restore-to-default rule (#22).)

  it('title-only notes (body=[]) push, persist, and pull like any note (title-only is first-class)', async () => {
    const id = '66666666-6666-4666-8666-666666666666';
    expect((await insertNote(db, entryNb(id, NB_A, 0, 'just a title', []), ACCT2, NOW)).outcome).toBe('accepted');

    const { notes } = await pullNotes(db, ACCT2, 0);
    expect(notes).toHaveLength(1); // NOT skipped/dropped for having an empty body
    expect(notes[0]!.title).toBe('just a title');
    expect(notes[0]!.body).toBe('[]'); // empty body persisted verbatim and returned
  });

  it('account isolation holds — a different account never sees these notes', async () => {
    await insertNote(db, entryNb('77777777-7777-4777-8777-777777777777', NB_A, 0, 'acct2 note'), ACCT2, NOW);
    const { notes } = await pullNotes(db, 'acct-other-9999', 0);
    expect(notes).toHaveLength(0);
  });
});
