/**
 * Notebook mutations (Notebooks task #16). Notebooks are a first-class, account-scoped, SYNCED entity
 * that rides the SAME per-account `accountSyncSeq` stream as notes (see db/mutate.ts) — every write
 * bumps that one counter, so notebook changes pull alongside notes on a single cursor (pullSince).
 *
 * Every query is scoped to the server-derived accountId (never client-asserted) — the same isolation
 * the note path holds. notebookId is an organizing tag, not a security boundary.
 */
import type { NotebookRow, NoteRow, DbAdapter } from './schema.js';
import type { NotebookPushEntry } from '@deltos/shared';
import { DEFAULT_COLLECTION_VIEW } from '@deltos/shared';
import { BUMP_SEQ_SQL, READ_SEQ_SQL } from './mutate.js';

export type NotebookOutcome =
  | { outcome: 'accepted'; version: number; syncSeq: number; row: NotebookRow }
  | { outcome: 'conflict'; serverRow: NotebookRow | null; reason: 'stale' | 'default_undeletable' };

const FIRST_NOTEBOOK_VERSION = 1;

async function fetchNotebook(db: DbAdapter, id: string, accountId: string): Promise<NotebookRow | null> {
  return db.first<NotebookRow>(`SELECT * FROM notebooks WHERE id = ? AND accountId = ?`, [id, accountId]);
}

/**
 * Create the account's single UNDELETABLE DEFAULT notebook (isDefault = 1). Server-only — a client can
 * never assert isDefault. The partial unique index `notebooks_oneDefault` makes a second default for the
 * same account fail atomically. Used at signup (new account) and by the backfill migration's analogue.
 */
export async function createDefaultNotebook(
  db: DbAdapter,
  accountId: string,
  name: string,
  nowIso: string,
): Promise<NotebookRow> {
  // Idempotent: exactly one default per account (enforced hard by the `notebooks_oneDefault` partial
  // unique index). If one already exists (a retried signup / double-call), return it rather than tripping
  // the constraint. Called serially per account at signup, so the check-then-insert window is benign.
  const existing = await db.first<NotebookRow>(
    `SELECT * FROM notebooks WHERE accountId = ? AND isDefault = 1`,
    [accountId],
  );
  if (existing) return existing;

  const id = crypto.randomUUID();
  await db.batch([
    { sql: BUMP_SEQ_SQL, params: [accountId] },
    {
      sql: `
        INSERT INTO notebooks (id, accountId, name, defaultCollectionView, isDefault, version, createdAt, updatedAt, syncSeq)
        SELECT ?, ?, ?, ?, 1, ?, ?, ?, (${READ_SEQ_SQL})
      `,
      params: [id, accountId, name, DEFAULT_COLLECTION_VIEW, FIRST_NOTEBOOK_VERSION, nowIso, nowIso, accountId],
    },
  ]);
  return (await fetchNotebook(db, id, accountId))!;
}

/** Create a NON-default notebook (push baseVersion 0). Conflicts if the id already exists. */
export async function insertNotebook(
  db: DbAdapter,
  entry: NotebookPushEntry,
  accountId: string,
  nowIso: string,
): Promise<NotebookOutcome> {
  const draft = entry.draft!;
  const batch = await db.batch([
    { sql: BUMP_SEQ_SQL, params: [accountId] },
    {
      sql: `
        INSERT INTO notebooks (id, accountId, name, defaultCollectionView, isDefault, version, createdAt, updatedAt, syncSeq)
        SELECT ?, ?, ?, ?, 0, ?, ?, ?, (${READ_SEQ_SQL})
        WHERE NOT EXISTS (SELECT 1 FROM notebooks WHERE id = ?)
      `,
      params: [
        entry.id,
        accountId,
        draft.name,
        draft.defaultCollectionView,
        FIRST_NOTEBOOK_VERSION,
        nowIso,
        nowIso,
        accountId,
        entry.id,
      ],
    },
  ]);
  if (batch[1]!.rowsWritten === 0) {
    // id already exists — scoped fetch (a cross-account id collision returns null → no leak).
    return { outcome: 'conflict', serverRow: await fetchNotebook(db, entry.id, accountId), reason: 'stale' };
  }
  const row = (await fetchNotebook(db, entry.id, accountId))!;
  return { outcome: 'accepted', version: row.version, syncSeq: row.syncSeq, row };
}

/** Rename / re-view an existing notebook via atomic CAS on (id, accountId, version). The default may be renamed. */
export async function renameNotebook(
  db: DbAdapter,
  entry: NotebookPushEntry,
  accountId: string,
  nowIso: string,
): Promise<NotebookOutcome> {
  const draft = entry.draft!;
  const batch = await db.batch([
    { sql: BUMP_SEQ_SQL, params: [accountId] },
    {
      sql: `
        UPDATE notebooks
        SET name = ?, defaultCollectionView = ?, updatedAt = ?, version = version + 1, syncSeq = (${READ_SEQ_SQL})
        WHERE id = ? AND accountId = ? AND version = ? AND deletedAt IS NULL
      `,
      params: [draft.name, draft.defaultCollectionView, nowIso, accountId, entry.id, accountId, entry.baseVersion],
    },
  ]);
  // CAS hit ⇔ rowsWritten > 0 (real D1 counts index writes; see d1-rowswritten-index-inflation).
  if (batch[1]!.rowsWritten > 0) {
    const row = (await fetchNotebook(db, entry.id, accountId))!;
    return { outcome: 'accepted', version: row.version, syncSeq: row.syncSeq, row };
  }
  return { outcome: 'conflict', serverRow: await fetchNotebook(db, entry.id, accountId), reason: 'stale' };
}

/**
 * DELETE a notebook (push entry with delete:true). Behavior (ui-backbone-notebooks §B proposal):
 *   - The DEFAULT notebook cannot be deleted → conflict {reason:'default_undeletable'} (no tombstone).
 *   - Otherwise CAS-tombstone the notebook (set deletedAt), THEN move its live notes to TRASH
 *     (`sys:trashedAt` Fork-P property), each getting a distinct syncSeq so every device pulls the
 *     trashing. Notes are NOT hard-deleted (recoverable from Trash).
 *
 * Two steps (tombstone, then trash) because a CAS result can't gate a conditional inside one batch; the
 * window is tiny and benign (worst case a tombstoned notebook with not-yet-trashed notes, recoverable).
 */
export async function deleteNotebook(
  db: DbAdapter,
  entry: NotebookPushEntry,
  accountId: string,
  nowIso: string,
): Promise<NotebookOutcome> {
  // Step 1 — CAS-tombstone, refusing the default via `AND isDefault = 0`.
  const tombstone = await db.batch([
    { sql: BUMP_SEQ_SQL, params: [accountId] },
    {
      sql: `
        UPDATE notebooks
        SET deletedAt = ?, updatedAt = ?, version = version + 1, syncSeq = (${READ_SEQ_SQL})
        WHERE id = ? AND accountId = ? AND version = ? AND deletedAt IS NULL AND isDefault = 0
      `,
      params: [nowIso, nowIso, accountId, entry.id, accountId, entry.baseVersion],
    },
  ]);

  if (tombstone[1]!.rowsWritten === 0) {
    const serverRow = await fetchNotebook(db, entry.id, accountId);
    const reason = serverRow?.isDefault === 1 ? 'default_undeletable' : 'stale';
    return { outcome: 'conflict', serverRow, reason };
  }

  // Step 2 — move the notebook's live, not-already-trashed notes to Trash, each with a distinct syncSeq.
  const countRow = await db.first<{ n: number }>(
    `SELECT COUNT(*) AS n FROM notes
     WHERE accountId = ? AND notebookId = ? AND deletedAt IS NULL
       AND json_extract(properties, '$."sys:trashedAt"') IS NULL`,
    [accountId, entry.id],
  );
  const n = countRow?.n ?? 0;
  if (n > 0) {
    await db.batch([
      // Advance the per-account counter by N up front; the note UPDATE derives each note's syncSeq from it.
      { sql: `UPDATE accountSyncSeq SET seq = seq + ? WHERE accountId = ?`, params: [n, accountId] },
      {
        // Each note: set sys:trashedAt = {type:'date',value:now} (matches setTrashedAt), bump version,
        // and assign syncSeq = (newCounter - N + rank) → the N notes get the N seq values just reserved.
        // ROW_NUMBER orders by IMMUTABLE columns (createdAt,id), never the syncSeq being rewritten.
        sql: `
          WITH t AS (
            SELECT id, ROW_NUMBER() OVER (ORDER BY createdAt, id) AS rn
            FROM notes
            WHERE accountId = ? AND notebookId = ? AND deletedAt IS NULL
              AND json_extract(properties, '$."sys:trashedAt"') IS NULL
          )
          UPDATE notes
          SET properties = json_set(properties, '$."sys:trashedAt"', json_object('type', 'date', 'value', ?)),
              updatedAt  = ?,
              version    = version + 1,
              syncSeq    = ((SELECT seq FROM accountSyncSeq WHERE accountId = ?) - ? + (SELECT rn FROM t WHERE t.id = notes.id))
          WHERE id IN (SELECT id FROM t)
        `,
        params: [accountId, entry.id, nowIso, nowIso, accountId, n],
      },
    ]);
  }

  const row = (await fetchNotebook(db, entry.id, accountId))!;
  return { outcome: 'accepted', version: row.version, syncSeq: row.syncSeq, row };
}

/** Affected note ids for a just-deleted notebook (used by callers/tests to confirm the cascade). */
export async function notesInNotebook(db: DbAdapter, accountId: string, notebookId: string): Promise<NoteRow[]> {
  return db.all<NoteRow>(`SELECT * FROM notes WHERE accountId = ? AND notebookId = ?`, [accountId, notebookId]);
}
