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
import { tombstoneCollectionsForNotebook } from './collections.js';

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
        INSERT INTO notebooks (id, accountId, name, defaultCollectionView, noteSort, version, createdAt, updatedAt, syncSeq)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, (${READ_SEQ_SQL})
        WHERE NOT EXISTS (SELECT 1 FROM notebooks WHERE id = ?)
      `,
      params: [
        entry.id,
        accountId,
        draft.name,
        draft.defaultCollectionView,
        draft.noteSort,
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
        SET name = ?, defaultCollectionView = ?, noteSort = ?, updatedAt = ?, version = version + 1, syncSeq = (${READ_SEQ_SQL})
        WHERE id = ? AND accountId = ? AND version = ? AND deletedAt IS NULL
      `,
      params: [draft.name, draft.defaultCollectionView, draft.noteSort, nowIso, accountId, entry.id, accountId, entry.baseVersion],
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
  // notebook at the expected version is deletable. Resumable: if already tombstoned, we still run the
  // cascades below so a retry after a mid-cascade failure finishes stragglers (never gates cascade on
  // a freshly-won CAS).
  await db.batch([
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

  const parent = await fetchNotebook(db, entry.id, accountId);
  // Still live → CAS missed on a live row (stale version) → conflict; do NOT cascade.
  if (!parent || parent.deletedAt === null) {
    return { outcome: 'conflict', serverRow: parent, reason: 'stale' };
  }

  // Step 2 — UNCATEGORIZE the notebook's live notes (notebookId → NULL), account-scoped, each with a
  // distinct syncSeq. Seq reservation is atomic with the assignment (COUNT inside the same batch).
  // Re-runnable: only touches still-live notes that still carry this notebookId.
  await db.batch([
    {
      sql: `
        UPDATE accountSyncSeq
        SET seq = seq + (
          SELECT COUNT(*) FROM notes
          WHERE accountId = ? AND notebookId = ? AND deletedAt IS NULL
        )
        WHERE accountId = ?
      `,
      params: [accountId, entry.id, accountId],
    },
    {
      // Each note: notebookId → NULL, bump version, assign syncSeq = (newCounter - N + rank).
      sql: `
        WITH t AS (
          SELECT id, ROW_NUMBER() OVER (ORDER BY createdAt, id) AS rn
          FROM notes
          WHERE accountId = ? AND notebookId = ? AND deletedAt IS NULL
        ),
        cnt AS (SELECT COUNT(*) AS n FROM t)
        UPDATE notes
        SET notebookId = NULL,
            updatedAt  = ?,
            version    = version + 1,
            syncSeq    = (
              (SELECT seq FROM accountSyncSeq WHERE accountId = ?)
              - (SELECT n FROM cnt)
              + (SELECT rn FROM t WHERE t.id = notes.id)
            )
        WHERE id IN (SELECT id FROM t)
      `,
      params: [accountId, entry.id, nowIso, accountId],
    },
  ]);

  // Step 3 — tombstone the notebook's home collections + their members (collections.md §4 cascade).
  // Set-based + re-runnable (only live stragglers). A collection cannot outlive its home notebook in v1.
  await tombstoneCollectionsForNotebook(db, accountId, entry.id, nowIso);

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
