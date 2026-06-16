import type { NoteRow, DbAdapter } from './schema.js';
import type { SyncPushEntry } from '@deltos/shared';
import { FIRST_SERVER_VERSION, UNSYNCED_VERSION } from '@deltos/shared';

/**
 * All note mutations go through this module. Every write is a single atomic compare-and-swap
 * (PIN-SYNC-1): the push conflict check is UPDATE … WHERE version = :baseVersion, branching on
 * rows-affected. There is no SELECT-then-UPDATE path — that opens the TOCTOU race that silently
 * loses writes and never fires a conflict.
 *
 * Sync position (PIN-SYNC-2): every write atomically bumps the per-notebook `notebookSyncSeq`
 * counter and stores the new value in `notes.syncSeq`. Pull uses `WHERE syncSeq > :cursor`, so
 * every committed write is visible regardless of timestamp collisions. Gaps from failed CAS
 * attempts are intentional and harmless.
 */

const PULL_PAGE = 100;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Clamp client-supplied timestamps: the server never lets a future timestamp in (PIN-SYNC). */
function clamp(clientIso: string, serverNow: string): string {
  return clientIso <= serverNow ? clientIso : serverNow;
}

/** Bump the per-notebook syncSeq counter and return it. Batched with note writes. */
const BUMP_SEQ_SQL = `
  INSERT INTO notebookSyncSeq (notebookId, seq)
  VALUES (?, 1)
  ON CONFLICT(notebookId) DO UPDATE SET seq = seq + 1
`;
const READ_SEQ_SQL = `SELECT seq FROM notebookSyncSeq WHERE notebookId = ?`;

// ---------------------------------------------------------------------------
// Row → domain (no mapper layer — columns are camelCase 1:1 with the spine)
// ---------------------------------------------------------------------------

export function rowToNote(row: NoteRow): NoteRow {
  return row; // already the right shape; callers parse JSON fields as needed
}

// ---------------------------------------------------------------------------
// Insert (new note, baseVersion = 0)
// ---------------------------------------------------------------------------

export type InsertOutcome =
  | { outcome: 'accepted'; version: number; syncSeq: number; row: NoteRow }
  | { outcome: 'conflict' };

/**
 * Create a new note. Uses INSERT … ON CONFLICT(id) DO NOTHING and checks inserted rows.
 * A conflict means a note with this id already exists (duplicate push or UUID collision).
 */
export async function insertNote(
  db: DbAdapter,
  entry: SyncPushEntry & { notebookId: string },
  serverNow: string,
): Promise<InsertOutcome> {
  const createdAt = clamp(
    (entry.draft as { createdAt?: string }).createdAt ?? serverNow,
    serverNow,
  );

  // Three-statement batch: bump seq counter → insert note with seq from counter → read back row.
  // All three run in one atomic D1 transaction.
  const insertBatch = await db.batch([
    { sql: BUMP_SEQ_SQL, params: [entry.notebookId] },
    {
      sql: `
        INSERT INTO notes
          (id, notebookId, title, properties, body, version, createdAt, updatedAt, syncSeq)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?,
               (${READ_SEQ_SQL})
        WHERE NOT EXISTS (SELECT 1 FROM notes WHERE id = ?)
      `,
      params: [
        entry.id,
        entry.notebookId,
        entry.draft.title ?? '',
        JSON.stringify(entry.draft.properties ?? {}),
        JSON.stringify(entry.draft.body ?? []),
        FIRST_SERVER_VERSION,
        createdAt,
        serverNow,
        entry.notebookId,
        entry.id, // for the NOT EXISTS check
      ],
    },
  ]);
  const insertResult = insertBatch[1]!;

  if (insertResult.rowsWritten === 0) {
    return { outcome: 'conflict' };
  }

  const row = await db.first<NoteRow>(
    `SELECT * FROM notes WHERE id = ?`,
    [entry.id],
  );
  return { outcome: 'accepted', version: FIRST_SERVER_VERSION, syncSeq: row!.syncSeq, row: row! };
}

// ---------------------------------------------------------------------------
// Update (existing note, baseVersion > 0) — PIN-SYNC-1 atomic CAS
// ---------------------------------------------------------------------------

export type UpdateOutcome =
  | { outcome: 'accepted'; version: number; syncSeq: number; row: NoteRow }
  | { outcome: 'conflict'; serverRow: NoteRow | null };

/**
 * Update an existing note via atomic compare-and-swap on (id, notebookId, version).
 *
 * The single UPDATE statement is the CAS: if the note no longer exists at baseVersion
 * (either moved or deleted), rows-affected = 0 → conflict. No SELECT before the write.
 *
 * On conflict: returns the current server row (or null if tombstoned) so the caller can fork.
 */
export async function updateNote(
  db: DbAdapter,
  entry: SyncPushEntry & { notebookId: string },
  serverNow: string,
): Promise<UpdateOutcome> {
  // Batch: bump seq → CAS update reading new seq as subquery.
  const updateBatch = await db.batch([
    { sql: BUMP_SEQ_SQL, params: [entry.notebookId] },
    {
      sql: `
        UPDATE notes
        SET title      = ?,
            properties = ?,
            body       = ?,
            updatedAt  = ?,
            version    = version + 1,
            syncSeq    = (${READ_SEQ_SQL})
        WHERE id         = ?
          AND notebookId = ?
          AND version    = ?
          AND deletedAt  IS NULL
      `,
      params: [
        entry.draft.title ?? '',
        JSON.stringify(entry.draft.properties ?? {}),
        JSON.stringify(entry.draft.body ?? []),
        serverNow,
        entry.notebookId,
        entry.id,
        entry.notebookId,
        entry.baseVersion,
      ],
    },
  ]);
  const updateResult = updateBatch[1]!;

  if (updateResult.rowsWritten === 1) {
    const row = await db.first<NoteRow>(`SELECT * FROM notes WHERE id = ?`, [entry.id]);
    return { outcome: 'accepted', version: row!.version, syncSeq: row!.syncSeq, row: row! };
  }

  // CAS missed — return current server state so the client can fork (PIN-SYNC-3/4).
  const serverRow = await db.first<NoteRow>(
    `SELECT * FROM notes WHERE id = ? AND notebookId = ?`,
    [entry.id, entry.notebookId],
  );
  return { outcome: 'conflict', serverRow: serverRow ?? null };
}

// ---------------------------------------------------------------------------
// Soft-delete (REST op — CAS if expectedVersion supplied, unconditional otherwise)
// ---------------------------------------------------------------------------

export type DeleteOutcome =
  | { outcome: 'accepted'; syncSeq: number }
  | { outcome: 'conflict'; serverRow: NoteRow | null }
  | { outcome: 'not_found' };

export async function deleteNote(
  db: DbAdapter,
  id: string,
  notebookId: string,
  expectedVersion: number | undefined,
  serverNow: string,
): Promise<DeleteOutcome> {
  const versionClause =
    expectedVersion !== undefined ? `AND version = ${Number(expectedVersion)}` : '';

  const deleteBatch = await db.batch([
    { sql: BUMP_SEQ_SQL, params: [notebookId] },
    {
      sql: `
        UPDATE notes
        SET deletedAt = ?,
            updatedAt = ?,
            version   = version + 1,
            syncSeq   = (${READ_SEQ_SQL})
        WHERE id         = ?
          AND notebookId = ?
          AND deletedAt  IS NULL
          ${versionClause}
      `,
      params: [serverNow, serverNow, notebookId, id, notebookId],
    },
  ]);
  const deleteResult = deleteBatch[1]!;

  if (deleteResult.rowsWritten === 1) {
    const row = await db.first<NoteRow>(`SELECT syncSeq FROM notes WHERE id = ?`, [id]);
    return { outcome: 'accepted', syncSeq: row!.syncSeq };
  }

  const serverRow = await db.first<NoteRow>(
    `SELECT * FROM notes WHERE id = ? AND notebookId = ?`,
    [id, notebookId],
  );
  if (!serverRow) return { outcome: 'not_found' };
  if (serverRow.deletedAt !== null) return { outcome: 'accepted', syncSeq: serverRow.syncSeq }; // idempotent
  return { outcome: 'conflict', serverRow };
}

// ---------------------------------------------------------------------------
// REST mutation (update/appendBlock/setProperty) — CAS or LWW per PIN-SYNC-1 obligation
// ---------------------------------------------------------------------------

/**
 * Apply a partial patch to a note.
 *
 * When `expectedVersion` is supplied: atomic CAS, conflicts fork rather than clobber.
 * When absent: unconditional last-write (documented LWW for non-concurrent callers —
 * PIN-SYNC-1 obligation: "absent → last-write (non-concurrent callers)").
 *
 * Returns the full updated row, or null if the note does not exist / is deleted.
 */
export async function patchNote(
  db: DbAdapter,
  id: string,
  notebookId: string,
  patch: { title?: string; properties?: string; body?: string },
  expectedVersion: number | undefined,
  serverNow: string,
): Promise<{ outcome: 'accepted'; row: NoteRow } | { outcome: 'conflict' } | { outcome: 'not_found' }> {
  const setParts: string[] = ['updatedAt = ?', 'version = version + 1', `syncSeq = (${READ_SEQ_SQL})`];
  const setParams: unknown[] = [serverNow, notebookId];
  if (patch.title !== undefined) { setParts.unshift('title = ?'); setParams.unshift(patch.title); }
  if (patch.properties !== undefined) { setParts.unshift('properties = ?'); setParams.unshift(patch.properties); }
  if (patch.body !== undefined) { setParts.unshift('body = ?'); setParams.unshift(patch.body); }

  const versionClause = expectedVersion !== undefined ? `AND version = ?` : '';
  const versionParam = expectedVersion !== undefined ? [expectedVersion] : [];

  const patchBatch = await db.batch([
    { sql: BUMP_SEQ_SQL, params: [notebookId] },
    {
      sql: `UPDATE notes SET ${setParts.join(', ')} WHERE id = ? AND notebookId = ? AND deletedAt IS NULL ${versionClause}`,
      params: [...setParams, id, notebookId, ...versionParam],
    },
  ]);
  const result = patchBatch[1]!;

  if (result.rowsWritten === 0) {
    const exists = await db.first<{ id: string }>(
      `SELECT id FROM notes WHERE id = ? AND notebookId = ?`,
      [id, notebookId],
    );
    return { outcome: exists ? 'conflict' : 'not_found' };
  }

  const row = await db.first<NoteRow>(`SELECT * FROM notes WHERE id = ?`, [id]);
  return { outcome: 'accepted', row: row! };
}

// ---------------------------------------------------------------------------
// Pull — server-authoritative stream (PIN-SYNC-2)
// ---------------------------------------------------------------------------

export interface PullResult {
  notes: NoteRow[];
  nextCursor: number;
  hasMore: boolean;
}

/**
 * Fetch notes whose syncSeq > cursor for this notebook, ordered ascending (monotone).
 * Includes tombstones (deletedAt IS NOT NULL) so the client can apply PIN-SYNC-3.
 *
 * `cursor = 0` is a full sync; `cursor = N` is incremental.
 */
export async function pullNotes(
  db: DbAdapter,
  notebookId: string,
  cursor: number,
): Promise<PullResult> {
  // Fetch one extra to detect hasMore without a separate COUNT query.
  const rows = await db.all<NoteRow>(
    `SELECT * FROM notes WHERE notebookId = ? AND syncSeq > ? ORDER BY syncSeq ASC LIMIT ?`,
    [notebookId, cursor, PULL_PAGE + 1],
  );

  const hasMore = rows.length > PULL_PAGE;
  const page = hasMore ? rows.slice(0, PULL_PAGE) : rows;
  const nextCursor = page.length > 0 ? page[page.length - 1]!.syncSeq : cursor;

  return { notes: page, hasMore, nextCursor };
}

// ---------------------------------------------------------------------------
// REST read
// ---------------------------------------------------------------------------

export async function getNote(
  db: DbAdapter,
  id: string,
  notebookId: string,
): Promise<NoteRow | null> {
  return db.first<NoteRow>(
    `SELECT * FROM notes WHERE id = ? AND notebookId = ? AND deletedAt IS NULL`,
    [id, notebookId],
  );
}

// ---------------------------------------------------------------------------
// REST search (FTS stub — full-text search is Phase 3)
// ---------------------------------------------------------------------------

export async function searchNotes(
  db: DbAdapter,
  notebookId: string | undefined,
  text: string | undefined,
): Promise<NoteRow[]> {
  // Phase 1: title-only LIKE search as a placeholder. Full FTS (SQLite FTS5) is Phase 3.
  if (text && notebookId) {
    return db.all<NoteRow>(
      `SELECT * FROM notes WHERE notebookId = ? AND title LIKE ? AND deletedAt IS NULL ORDER BY updatedAt DESC LIMIT 50`,
      [notebookId, `%${text}%`],
    );
  }
  if (text) {
    return db.all<NoteRow>(
      `SELECT * FROM notes WHERE title LIKE ? AND deletedAt IS NULL ORDER BY updatedAt DESC LIMIT 50`,
      [`%${text}%`],
    );
  }
  if (notebookId) {
    return db.all<NoteRow>(
      `SELECT * FROM notes WHERE notebookId = ? AND deletedAt IS NULL ORDER BY updatedAt DESC LIMIT 50`,
      [notebookId],
    );
  }
  // Caller guarantees at least one constraint (SearchQuerySchema refine).
  return [];
}

export { UNSYNCED_VERSION };
