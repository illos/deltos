import type { DbAdapter, NoteRow, NotebookRow } from './schema.js';

/**
 * shareReads — the OWNER-account-scoped reads the public URL-share surface (ROAD-0011 P2 §3) needs to render
 * a shared note/notebook. Every read is scoped to the OWNER's accountId (= the share grant's principalId,
 * resolved from the grant, NEVER the caller — there is no caller account on an anonymous surface; assumption
 * guard #3). Live rows only (deletedAt IS NULL). The surface additionally hides trashed notes in code
 * (the `sys:trashedAt` property flag) so the read-only render matches the app's list.
 */

/** A live notebook owned by `accountId`, or null. */
export async function getNotebookForAccount(
  db: DbAdapter,
  accountId: string,
  notebookId: string,
): Promise<NotebookRow | null> {
  return db.first<NotebookRow>(
    `SELECT * FROM notebooks WHERE id = ? AND accountId = ? AND deletedAt IS NULL`,
    [notebookId, accountId],
  );
}

/** Live notes in a notebook owned by `accountId`, newest-updated first (the shared note list). */
export async function listNotesInNotebookForAccount(
  db: DbAdapter,
  accountId: string,
  notebookId: string,
): Promise<NoteRow[]> {
  return db.all<NoteRow>(
    `SELECT * FROM notes WHERE notebookId = ? AND accountId = ? AND deletedAt IS NULL
      ORDER BY updatedAt DESC, id`,
    [notebookId, accountId],
  );
}

/**
 * The notebook REVISION — a monotonic "did anything in this notebook change" counter for the heartbeat. It is
 * MAX(syncSeq) across the notebook's live notes AND the notebook row itself (rename bumps the notebook's
 * syncSeq). `syncSeq` is the per-account monotonic sync counter bumped on EVERY mutation, so this strictly
 * increases when any note is added/edited/removed or the notebook is renamed — a correct change signal (a
 * plain MAX(version) would miss an edit to a non-max-version note). Account-scoped (owner). 0 if empty.
 */
export async function notebookRevision(
  db: DbAdapter,
  accountId: string,
  notebookId: string,
): Promise<number> {
  const row = await db.first<{ rev: number | null }>(
    `SELECT MAX(rev) AS rev FROM (
        SELECT COALESCE(MAX(syncSeq), 0) AS rev FROM notes
          WHERE notebookId = ? AND accountId = ? AND deletedAt IS NULL
        UNION ALL
        SELECT COALESCE(syncSeq, 0) AS rev FROM notebooks
          WHERE id = ? AND accountId = ?
      )`,
    [notebookId, accountId, notebookId, accountId],
  );
  return row?.rev ?? 0;
}
