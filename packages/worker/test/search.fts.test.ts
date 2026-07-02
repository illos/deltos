/**
 * Server-side FTS5 note search (migration 0018 + db/searchIndex.ts + db/mutate.ts searchNotes).
 *
 * These pin the SERVER (D1) search engine used by REST note.search and the MCP search_notes tool —
 * full-text over title + body, account-isolated, trash/liveness-aware, injection-safe. The client fuzzy
 * engine (client/src/lib/search.ts) is a SEPARATE engine and is untouched.
 *
 * Harness mirrors conflict.test.ts: better-sqlite3 (D1-compatible SQLite, FTS5 compiled in) + the real
 * migration files applied in order. FTS maintenance is exercised THROUGH the real mutators (insertNote /
 * updateNote / deleteNote) so the index-on-success wiring is covered end-to-end, not mocked.
 *
 * secSys focus: account isolation (the standing BOLA bar — A's search never returns B's note) and
 * injection safety (no user query can error or inject FTS5 operators).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { insertNote, updateNote, deleteNote, searchNotes, toFtsMatch } from '../src/db/mutate.js';
import type { DbAdapter } from '../src/db/schema.js';
import type { SyncPushEntry } from '@deltos/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

// Same migration list the production D1 uses (0018 adds the notesFts virtual table).
const migrations = [
  '0000_baseline.sql',
  '0001_stream-b-sync.sql',
  '0002_stream-a-auth.sql',
  '0003_account-identity.sql',
  '0006_account-sync-seq.sql',
  '0007_reconcile-account-sync-seq.sql',
  '0008_notebooks.sql',
  '0009_backfill-default-notebooks.sql',
  '0010_nullable-notebookid-all-notes.sql',
  '0011_drop-isdefault-notebooksyncseg-notes_pull.sql',
  '0012_custom-dictionary.sql',
  '0013_agent-token-label.sql',
  '0014_grant-family-link.sql',
  '0015_audit-log.sql',
  '0016_usage-counter.sql',
  '0017_oauth-provider.sql',
  '0018_fts5-note-search.sql',
].map((f) => readFileSync(join(__dirname, '../migrations', f), 'utf8'));

function freshDb(): DbAdapter {
  const raw = new Database(':memory:');
  for (const migration of migrations) raw.exec(migration);
  return sqliteAdapter(raw);
}

// ---------------------------------------------------------------------------
// Body helpers — build spine Block[] with paragraph text and nested children
// ---------------------------------------------------------------------------

let blockCounter = 0;
function para(text: string, children?: unknown[]): unknown {
  blockCounter += 1;
  return {
    id: `00000000-0000-4000-8000-${String(blockCounter).padStart(12, '0')}`,
    type: 'paragraph',
    content: { segments: [{ text }] },
    ...(children ? { children } : {}),
  };
}

const NOW = '2026-06-15T12:00:00.000Z';
const NB = '00000000-0000-4000-8000-0000000000a1';

function entry(
  id: string,
  baseVersion: number,
  title: string,
  body: unknown[] = [],
  properties: Record<string, unknown> = {},
): SyncPushEntry & { notebookId: string | null } {
  return {
    id: id as SyncPushEntry['id'],
    notebookId: NB as SyncPushEntry['notebookId'] & string,
    baseVersion,
    draft: {
      title,
      properties: properties as SyncPushEntry['draft']['properties'],
      body: body as SyncPushEntry['draft']['body'],
    },
  };
}

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ACCT = 'acct-fts-0001';

// ---------------------------------------------------------------------------
// toFtsMatch — pure sanitizer/tokenizer
// ---------------------------------------------------------------------------

describe('toFtsMatch — query sanitizer', () => {
  it('tokenizes and quotes each term as a prefix, AND-joined', () => {
    expect(toFtsMatch('foo bar')).toBe('"foo"* AND "bar"*');
    expect(toFtsMatch('Hello')).toBe('"hello"*');
  });

  it('returns null for empty / whitespace-only / punctuation-only input', () => {
    expect(toFtsMatch('')).toBeNull();
    expect(toFtsMatch('   ')).toBeNull();
    expect(toFtsMatch('!!!')).toBeNull();
    expect(toFtsMatch('  -  ')).toBeNull();
  });

  it('neutralizes FTS5 operators + special chars (no injection): they become quoted literals', () => {
    // The bareword operator AND, the column-filter ':', quote, star, caret all reduce to quoted tokens.
    expect(toFtsMatch('foo AND bar')).toBe('"foo"* AND "and"* AND "bar"*');
    expect(toFtsMatch('a:b')).toBe('"a"* AND "b"*');
    expect(toFtsMatch('"; DROP')).toBe('"drop"*');
    expect(toFtsMatch('foo*^bar')).toBe('"foo"* AND "bar"*');
  });
});

// ---------------------------------------------------------------------------
// searchNotes — FTS behavior
// ---------------------------------------------------------------------------

describe('searchNotes — server FTS5 over title + body', () => {
  let db: DbAdapter;
  beforeEach(() => { db = freshDb(); });

  it('finds a note by BODY text (not just title)', async () => {
    await insertNote(db, entry(uuid(1), 0, 'Untitled', [para('the quick brown fox')]), ACCT, NOW);
    const rows = await searchNotes(db, undefined, ACCT, 'brown');
    expect(rows.map((r) => r.id)).toEqual([uuid(1)]);
  });

  it('finds a note by text nested in block CHILDREN (recursive extractor)', async () => {
    // Top-level block carries no matching text; the term lives only in a child block.
    await insertNote(
      db,
      entry(uuid(2), 0, 'Parent', [para('outer', [para('deeplyNestedNeedle')])]),
      ACCT,
      NOW,
    );
    const rows = await searchNotes(db, undefined, ACCT, 'deeplyNestedNeedle');
    expect(rows.map((r) => r.id)).toEqual([uuid(2)]);
  });

  it('🚨 BOLA: account A\'s search never returns account B\'s note', async () => {
    await insertNote(db, entry(uuid(3), 0, 'B secret', [para('confidential pineapple')]), 'acct-B', NOW);
    const rows = await searchNotes(db, undefined, ACCT, 'pineapple');
    expect(rows).toHaveLength(0);
    // And B still finds its own.
    const bRows = await searchNotes(db, undefined, 'acct-B', 'pineapple');
    expect(bRows.map((r) => r.id)).toEqual([uuid(3)]);
  });

  it('excludes trashed notes and re-includes them on restore', async () => {
    await insertNote(db, entry(uuid(4), 0, 'Recipe', [para('marmalade toast')]), ACCT, NOW);
    expect((await searchNotes(db, undefined, ACCT, 'marmalade')).map((r) => r.id)).toEqual([uuid(4)]);

    // Trash it (Fork P: set the sys:trashedAt date property via a normal edit).
    const trashProps = { 'sys:trashedAt': { type: 'date', value: NOW } };
    await updateNote(db, entry(uuid(4), 1, 'Recipe', [para('marmalade toast')], trashProps), ACCT, NOW);
    expect(await searchNotes(db, undefined, ACCT, 'marmalade')).toHaveLength(0);

    // Restore (clear the flag) → searchable again.
    await updateNote(db, entry(uuid(4), 2, 'Recipe', [para('marmalade toast')], {}), ACCT, NOW);
    expect((await searchNotes(db, undefined, ACCT, 'marmalade')).map((r) => r.id)).toEqual([uuid(4)]);
  });

  it('excludes soft-deleted (tombstoned) notes', async () => {
    await insertNote(db, entry(uuid(5), 0, 'Ephemeral', [para('vanishing sardine')]), ACCT, NOW);
    expect((await searchNotes(db, undefined, ACCT, 'sardine')).map((r) => r.id)).toEqual([uuid(5)]);
    await deleteNote(db, uuid(5), NB, ACCT, 1, NOW);
    expect(await searchNotes(db, undefined, ACCT, 'sardine')).toHaveLength(0);
  });

  it('ranks a TITLE match above a deep BODY-only match (bm25 relevance)', async () => {
    // Note T: the term is in the title. Note B: the term is buried in a long body only.
    await insertNote(db, entry(uuid(6), 0, 'aardvark notes', [para('nothing relevant here')]), ACCT, NOW);
    await insertNote(
      db,
      entry(uuid(7), 0, 'misc', [para('lorem ipsum dolor sit amet '.repeat(20) + ' aardvark ' + 'tail words '.repeat(20))]),
      ACCT,
      NOW,
    );
    const rows = await searchNotes(db, undefined, ACCT, 'aardvark');
    expect(rows.map((r) => r.id)).toEqual([uuid(6), uuid(7)]); // title hit ranks first
  });

  it('scopes to a notebook when notebookId is supplied', async () => {
    const NB1 = uuid(100);
    const NB2 = uuid(101);
    // Both notes contain "walrus"; only one is in NB1.
    await insertNote(db, { ...entry(uuid(8), 0, 'In nb1', [para('walrus tusk')]), notebookId: NB1 }, ACCT, NOW);
    await insertNote(db, { ...entry(uuid(9), 0, 'In nb2', [para('walrus tusk')]), notebookId: NB2 }, ACCT, NOW);
    const rows = await searchNotes(db, NB1, ACCT, 'walrus');
    expect(rows.map((r) => r.id)).toEqual([uuid(8)]);
  });

  it('lazy body-fill: a title-only-seeded note becomes body-searchable after an edit', async () => {
    // Simulate the migration seed (title-only FTS row, no body) then edit → upsertNoteFts fills body.
    await insertNote(db, entry(uuid(10), 0, 'Journal', []), ACCT, NOW);
    expect(await searchNotes(db, undefined, ACCT, 'kumquat')).toHaveLength(0);
    await updateNote(db, entry(uuid(10), 1, 'Journal', [para('bought a kumquat today')]), ACCT, NOW);
    expect((await searchNotes(db, undefined, ACCT, 'kumquat')).map((r) => r.id)).toEqual([uuid(10)]);
  });

  it('prefix matching: a partial token matches a longer word', async () => {
    await insertNote(db, entry(uuid(11), 0, 'Notebook', [para('encyclopedia')]), ACCT, NOW);
    expect((await searchNotes(db, undefined, ACCT, 'encyc')).map((r) => r.id)).toEqual([uuid(11)]);
  });

  it('special-char / injection queries never throw and return safely', async () => {
    await insertNote(db, entry(uuid(12), 0, 'Guard', [para('normal content')]), ACCT, NOW);
    for (const q of ['"', '*', 'a:b', 'foo AND', '', '   ', '^', 'NEAR(', ')(', '"; DROP TABLE notes;--']) {
      await expect(searchNotes(db, undefined, ACCT, q)).resolves.toBeInstanceOf(Array);
    }
  });

  it('text-present-but-sanitized-to-empty with no notebook returns []', async () => {
    await insertNote(db, entry(uuid(13), 0, 'Guard', [para('content')]), ACCT, NOW);
    expect(await searchNotes(db, undefined, ACCT, '!!!')).toEqual([]);
  });

  it('no text + notebookId falls back to the notebook listing (trash-filtered)', async () => {
    const NB1 = uuid(102);
    await insertNote(db, { ...entry(uuid(14), 0, 'a', [para('x')]), notebookId: NB1 }, ACCT, NOW);
    await insertNote(
      db,
      { ...entry(uuid(15), 0, 'trashed', [para('y')], { 'sys:trashedAt': { type: 'date', value: NOW } }), notebookId: NB1 },
      ACCT,
      NOW,
    );
    const rows = await searchNotes(db, NB1, ACCT, undefined);
    expect(rows.map((r) => r.id)).toEqual([uuid(14)]); // trashed one excluded
  });
});
