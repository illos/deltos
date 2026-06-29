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

// #58: createDefaultNotebook is RETIRED — there is no stored default notebook. A new account starts with
// zero notebooks; uncategorized notes (notebookId = null) surface in the synthetic "All Notes" view. With
// no creation path AND the `notebooks_oneDefault` unique index dropped (migration 0010), a duplicate
// default is structurally impossible (the 2026-06-20 incident's root bug class is eliminated by absence).

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
        INSERT INTO notebooks (id, accountId, name, defaultCollectionView, version, createdAt, updatedAt, syncSeq)
        SELECT ?, ?, ?, ?, ?, ?, ?, (${READ_SEQ_SQL})
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
 * DELETE a notebook (push entry with delete:true). #58 model — no stored default exists, so EVERY
 * notebook is freely deletable, and deleting one UNCATEGORIZES its notes (notebookId → NULL) rather than
 * cascading them to Trash. The notes fall back to the synthetic "All Notes" view; nothing is hidden.
 * (Supersedes the #28 trash-cascade — Jim-confirmed, locked.)
 *   - CAS-tombstone the notebook (set deletedAt), THEN null out its live notes' notebookId, each getting
 *     a distinct syncSeq so every device pulls the uncategorize.
 *
 * Two steps (tombstone, then uncategorize) because a CAS result can't gate a conditional inside one
 * batch; the window is tiny and benign (worst case a tombstoned notebook with not-yet-uncategorized
 * notes — they self-heal to All Notes on the next pull). The uncategorize UPDATE is account-scoped
 * (`AND accountId = ?`) — a cross-account notebookId can never touch another account's notes (secSys BOLA,
 * same class as the #25 move check).
 */
export async function deleteNotebook(
  db: DbAdapter,
  entry: NotebookPushEntry,
  accountId: string,
  nowIso: string,
): Promise<NotebookOutcome> {
  // Step 1 — CAS-tombstone. No default exists anymore, so there is no isDefault guard: any owned, live
  // notebook at the expected version is deletable.
  const tombstone = await db.batch([
    { sql: BUMP_SEQ_SQL, params: [accountId] },
    {
      sql: `
        UPDATE notebooks
        SET deletedAt = ?, updatedAt = ?, version = version + 1, syncSeq = (${READ_SEQ_SQL})
        WHERE id = ? AND accountId = ? AND version = ? AND deletedAt IS NULL
      `,
      params: [nowIso, nowIso, accountId, entry.id, accountId, entry.baseVersion],
    },
  ]);

  if (tombstone[1]!.rowsWritten === 0) {
    return { outcome: 'conflict', serverRow: await fetchNotebook(db, entry.id, accountId), reason: 'stale' };
  }

  // Step 2 — UNCATEGORIZE the notebook's live notes (notebookId → NULL), account-scoped, each with a
  // distinct syncSeq so every device pulls the move to All Notes. Covers ALL live notes (trashed or not —
  // a trashed note also loses its notebook so a later restore lands it in All Notes).
  const countRow = await db.first<{ n: number }>(
    `SELECT COUNT(*) AS n FROM notes WHERE accountId = ? AND notebookId = ? AND deletedAt IS NULL`,
    [accountId, entry.id],
  );
  const n = countRow?.n ?? 0;
  if (n > 0) {
    await db.batch([
      // Reserve N seq values up front; the note UPDATE derives each note's syncSeq from the counter.
      { sql: `UPDATE accountSyncSeq SET seq = seq + ? WHERE accountId = ?`, params: [n, accountId] },
      {
        // Each note: notebookId → NULL, bump version, assign syncSeq = (newCounter - N + rank). ROW_NUMBER
        // orders by IMMUTABLE columns (createdAt,id), never the syncSeq being rewritten. Account-scoped.
        sql: `
          WITH t AS (
            SELECT id, ROW_NUMBER() OVER (ORDER BY createdAt, id) AS rn
            FROM notes
            WHERE accountId = ? AND notebookId = ? AND deletedAt IS NULL
          )
          UPDATE notes
          SET notebookId = NULL,
              updatedAt  = ?,
              version    = version + 1,
              syncSeq    = ((SELECT seq FROM accountSyncSeq WHERE accountId = ?) - ? + (SELECT rn FROM t WHERE t.id = notes.id))
          WHERE id IN (SELECT id FROM t)
        `,
        params: [accountId, entry.id, nowIso, accountId, n],
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

/**
 * List the account's LIVE notebooks, most-recently-touched first. The single account-scoped read the
 * MCP `list_notebooks` tool reuses — same `WHERE accountId = ? AND deletedAt IS NULL` isolation the rest
 * of the notebook path holds (the client otherwise only ever learns notebooks via the sync pull stream;
 * there is no REST list route to share, so this thin reader is the §6 "tiny new work"). `accountId` is
 * always the server-derived principal.id — never a client-asserted value.
 */
export async function listNotebooksForAccount(db: DbAdapter, accountId: string): Promise<NotebookRow[]> {
  return db.all<NotebookRow>(
    `SELECT * FROM notebooks WHERE accountId = ? AND deletedAt IS NULL ORDER BY updatedAt DESC`,
    [accountId],
  );
}
