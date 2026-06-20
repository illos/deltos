import type { NoteRow, NotebookRow, DbAdapter } from './schema.js';
import type { SyncPushEntry } from '@deltos/shared';
import { FIRST_SERVER_VERSION, UNSYNCED_VERSION, isTrashed } from '@deltos/shared';

/**
 * All note mutations go through this module. Every write is a single atomic compare-and-swap
 * (PIN-SYNC-1): the push conflict check is UPDATE … WHERE version = :baseVersion, branching on
 * rows-affected. There is no SELECT-then-UPDATE path — that opens the TOCTOU race that silently
 * loses writes and never fires a conflict.
 *
 * Sync position (PIN-SYNC-2): every write atomically bumps the per-ACCOUNT `accountSyncSeq`
 * counter (Option B, 2026-06-18 — the sync boundary is the account, not a device-local notebookId)
 * and stores the new value in `notes.syncSeq`. Pull uses `WHERE accountId = :id AND syncSeq > :cursor`,
 * so every committed write is visible to all of the account's devices regardless of which notebookId
 * tag the note carries or timestamp collisions. Gaps from failed CAS attempts are intentional and
 * harmless. syncSeq is unique + monotonic PER ACCOUNT (migration 0007 renumbers legacy rows that were
 * sequenced on the old per-notebook counter).
 */

const PULL_PAGE = 100;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Timestamps are server-authoritative in v1: the sync wire (NoteDraftSchema) carries NO client
// timestamps — the server stamps createdAt/updatedAt itself, and the pull cursor is the monotonic
// syncSeq (PIN-SYNC-2), not time. So there is nothing client-supplied to clamp here. If a future
// protocol ever carries a client createdAt/updatedAt, reinstate a `min(client, serverNow)` clamp
// at the write boundary (the PIN-SYNC timestamp-clamp landmine) before persisting it.

/**
 * Bump the per-ACCOUNT syncSeq counter and return it. Batched with note writes. The counter is
 * keyed on accountId (server-derived from the principal, never the body) so the whole account
 * shares one monotonic pull stream — the device-local notebookId no longer gates sync (Option B).
 */
export const BUMP_SEQ_SQL = `
  INSERT INTO accountSyncSeq (accountId, seq)
  VALUES (?, 1)
  ON CONFLICT(accountId) DO UPDATE SET seq = seq + 1
`;
export const READ_SEQ_SQL = `SELECT seq FROM accountSyncSeq WHERE accountId = ?`;

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
  accountId: string,
  serverNow: string,
): Promise<InsertOutcome> {
  // The client never sends createdAt: NoteDraftSchema deliberately omits it because the server
  // owns createdAt/updatedAt/version (the client owns syncStatus). New notes are server-stamped
  // at first sync — so there is no client timestamp to clamp here.
  const createdAt = serverNow;

  // Three-statement batch: bump seq counter → insert note with seq from counter → read back row.
  // All three run in one atomic D1 transaction.
  const insertBatch = await db.batch([
    { sql: BUMP_SEQ_SQL, params: [accountId] },
    {
      sql: `
        INSERT INTO notes
          (id, notebookId, accountId, title, properties, body, version, createdAt, updatedAt, syncSeq)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?,
               (${READ_SEQ_SQL})
        WHERE NOT EXISTS (SELECT 1 FROM notes WHERE id = ?)
      `,
      params: [
        entry.id,
        entry.notebookId, // organizing tag stamped at creation; NOT the sync boundary
        accountId,
        entry.draft.title ?? '',
        JSON.stringify(entry.draft.properties ?? {}),
        JSON.stringify(entry.draft.body ?? []),
        FIRST_SERVER_VERSION,
        createdAt,
        serverNow,
        accountId, // READ_SEQ_SQL: read back the per-account counter
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
  entry: SyncPushEntry,
  accountId: string,
  serverNow: string,
): Promise<UpdateOutcome> {
  // CAS identity is (id, accountId, version) — notebookId is NOT part of note identity (Option B): an
  // edit pushed from another device under a different notebookId tag still hits the same row (was a
  // phantom-conflict source). notebookId handling (Notebooks #16/#22 + secSys gate #19 crit-3 / #23):
  //  - MOVE (notebookId DIFFERS from current): ownership-check the target FIRST; if not an account-owned
  //    live notebook, REJECT (conflict, no write) — never orphan a note on a non-owned/deleted id.
  //  - PLAIN EDIT / RESTORE (notebookId omitted or unchanged, note will be LIVE): keep the current
  //    notebookId if it still resolves to a live owned notebook, else reassign to the account DEFAULT
  //    (the #22 restore rule), falling back to the current id when no default exists yet (COALESCE →
  //    never NULL; covers the backfill-held state).
  //  - TRASHING (incoming trashed): leave notebookId untouched so a later restore can return it home.
  // All subqueries are accountId-scoped — same isolation class as the write itself.
  // A MOVE is an update whose notebookId DIFFERS from the note's current one. A client that merely echoes
  // the current notebookId (or omits it) is NOT moving — so it is never ownership-rejected (that would
  // break ordinary edits, and every edit during the backfill-held window when no notebook rows exist
  // yet). Only a genuine move is ownership-checked: the target must be an account-owned, live notebook,
  // else REJECT (conflict) so we never orphan the note on a non-owned/deleted id (secSys gate #19 / #23).
  // Determine whether this is a genuine MOVE (incoming notebookId differs from the note's current one).
  // This read only SELECTS which SET/guard branch to run; it is NOT the racy step — a concurrent change
  // to the note (move/edit on another device) bumps version, so the CAS below misses → conflict, never a
  // stale-read write. (#25: it is the target-OWNERSHIP check, formerly a second read here, that was racy.)
  let move = false;
  if (entry.notebookId !== undefined) {
    const cur = await db.first<{ notebookId: string }>(
      `SELECT notebookId FROM notes WHERE id = ? AND accountId = ?`,
      [entry.id, accountId],
    );
    move = cur !== null && cur.notebookId !== entry.notebookId;
  }
  const incomingLive = !isTrashed(entry.draft.properties ?? {});
  let notebookSetSql = '';
  let notebookParams: unknown[] = [];
  // #25: the move target-ownership existence-check is FOLDED INTO the CAS WHERE (was a separate pre-read,
  // a TOCTOU window: a concurrent self-delete of the target between the check and the write transiently
  // dangled the note on a just-deleted notebook). As an EXISTS guard on the UPDATE it is evaluated
  // atomically with the write — a target that is no longer an account-owned live notebook at write time
  // yields a 0-row CAS → conflict (note unchanged), never an orphaning write. Same reject behavior as
  // before, now race-free. accountId-scoped like every other subquery here.
  let moveGuardSql = '';
  let moveGuardParams: unknown[] = [];
  if (move) {
    notebookSetSql = 'notebookId = ?,';
    notebookParams = [entry.notebookId];
    moveGuardSql = `AND EXISTS (SELECT 1 FROM notebooks WHERE id = ? AND accountId = ? AND deletedAt IS NULL)`;
    moveGuardParams = [entry.notebookId, accountId];
  } else if (incomingLive) {
    notebookSetSql = `notebookId = CASE
            WHEN EXISTS (SELECT 1 FROM notebooks nb WHERE nb.id = notes.notebookId AND nb.accountId = ? AND nb.deletedAt IS NULL)
              THEN notes.notebookId
            ELSE COALESCE((SELECT id FROM notebooks WHERE accountId = ? AND isDefault = 1), notes.notebookId)
          END,`;
    notebookParams = [accountId, accountId];
  }
  // Batch: bump the per-account seq → CAS update reading new seq as subquery.
  const updateBatch = await db.batch([
    { sql: BUMP_SEQ_SQL, params: [accountId] },
    {
      sql: `
        UPDATE notes
        SET title      = ?,
            properties = ?,
            body       = ?,
            ${notebookSetSql}
            updatedAt  = ?,
            version    = version + 1,
            syncSeq    = (${READ_SEQ_SQL})
        WHERE id         = ?
          AND accountId  = ?
          AND version    = ?
          AND deletedAt  IS NULL
          ${moveGuardSql}
      `,
      params: [
        entry.draft.title ?? '',
        JSON.stringify(entry.draft.properties ?? {}),
        JSON.stringify(entry.draft.body ?? []),
        ...notebookParams,
        serverNow,
        accountId,
        entry.id,
        accountId,
        entry.baseVersion,
        ...moveGuardParams,
      ],
    },
  ]);
  const updateResult = updateBatch[1]!;

  // CAS hit ⇔ rowsWritten > 0. The WHERE clause uniquely identifies at most ONE note (id +
  // accountId + version + deletedAt IS NULL — id is the PK, so id+accountId is exact), so a miss writes
  // 0 rows. We must NOT test `=== 1`: on real D1 `meta.rows_written` counts INDEX writes too, so a
  // successful single-row UPDATE on this multi-index table (notes_pull/notes_list/notes_byAccount/
  // notes_accountPull) reports >1 →
  // `=== 1` would mislabel an accepted write as a CONFLICT (the row IS updated server-side, but the
  // client gets a phantom conflict on every edit). better-sqlite3's `changes` reports rows-changed
  // (=1), so the test suite masks this — same class as the D1 CREATE-TEMP-TABLE landmine.
  if (updateResult.rowsWritten > 0) {
    const row = await db.first<NoteRow>(`SELECT * FROM notes WHERE id = ?`, [entry.id]);
    return { outcome: 'accepted', version: row!.version, syncSeq: row!.syncSeq, row: row! };
  }

  // CAS missed — return current server state so the client can fork (PIN-SYNC-3/4).
  // Scoped by accountId (NOT notebookId — secSys: the conflict-path SELECT stays accountId-scoped so a
  // cross-account push can never read another account's row): a cross-account push (caller A, note
  // owned by B) gets a 0-row CAS, then this SELECT finds nothing under A → serverNote=null → client
  // forks under a new id. No leak of B's note, no clobber.
  const serverRow = await db.first<NoteRow>(
    `SELECT * FROM notes WHERE id = ? AND accountId = ?`,
    [entry.id, accountId],
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
  accountId: string,
  expectedVersion: number | undefined,
  serverNow: string,
): Promise<DeleteOutcome> {
  // CAS on expectedVersion when supplied — bound as a parameter (consistent with patchNote),
  // never string-interpolated into the SQL.
  const versionClause = expectedVersion !== undefined ? `AND version = ?` : '';
  const versionParam = expectedVersion !== undefined ? [expectedVersion] : [];

  const deleteBatch = await db.batch([
    { sql: BUMP_SEQ_SQL, params: [accountId] },
    {
      // Identity is (id, accountId) — notebookId is not part of it (Option B); the per-account counter
      // feeds the same account-scoped pull stream as insert/update.
      sql: `
        UPDATE notes
        SET deletedAt = ?,
            updatedAt = ?,
            version   = version + 1,
            syncSeq   = (${READ_SEQ_SQL})
        WHERE id         = ?
          AND accountId  = ?
          AND deletedAt  IS NULL
          ${versionClause}
      `,
      params: [serverNow, serverNow, accountId, id, accountId, ...versionParam],
    },
  ]);
  const deleteResult = deleteBatch[1]!;

  // CAS hit ⇔ rowsWritten > 0 (see updateNote): real D1 `meta.rows_written` includes index writes, so
  // a successful single-row soft-delete UPDATE reports >1 — `=== 1` would mislabel it a conflict.
  if (deleteResult.rowsWritten > 0) {
    const row = await db.first<NoteRow>(`SELECT syncSeq FROM notes WHERE id = ?`, [id]);
    return { outcome: 'accepted', syncSeq: row!.syncSeq };
  }

  const serverRow = await db.first<NoteRow>(
    `SELECT * FROM notes WHERE id = ? AND accountId = ?`,
    [id, accountId],
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
  accountId: string,
  patch: { title?: string; properties?: string; body?: string },
  expectedVersion: number | undefined,
  serverNow: string,
): Promise<{ outcome: 'accepted'; row: NoteRow } | { outcome: 'conflict' } | { outcome: 'not_found' }> {
  const setParts: string[] = ['updatedAt = ?', 'version = version + 1', `syncSeq = (${READ_SEQ_SQL})`];
  const setParams: unknown[] = [serverNow, accountId]; // accountId feeds the per-account syncSeq counter
  if (patch.title !== undefined) { setParts.unshift('title = ?'); setParams.unshift(patch.title); }
  if (patch.properties !== undefined) { setParts.unshift('properties = ?'); setParams.unshift(patch.properties); }
  if (patch.body !== undefined) { setParts.unshift('body = ?'); setParams.unshift(patch.body); }

  const versionClause = expectedVersion !== undefined ? `AND version = ?` : '';
  const versionParam = expectedVersion !== undefined ? [expectedVersion] : [];

  // Identity is (id, accountId) — notebookId is no longer part of it (Option B). The `notebookId`
  // parameter is retained for signature stability with the REST callers but is intentionally unused.
  const patchBatch = await db.batch([
    { sql: BUMP_SEQ_SQL, params: [accountId] },
    {
      sql: `UPDATE notes SET ${setParts.join(', ')} WHERE id = ? AND accountId = ? AND deletedAt IS NULL ${versionClause}`,
      params: [...setParams, id, accountId, ...versionParam],
    },
  ]);
  const result = patchBatch[1]!;

  if (result.rowsWritten === 0) {
    // Scoped by accountId: a row owned by another account is invisible here → not_found (404),
    // not a 409 conflict — no cross-account existence oracle.
    const exists = await db.first<{ id: string }>(
      `SELECT id FROM notes WHERE id = ? AND accountId = ?`,
      [id, accountId],
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
 * Fetch the ACCOUNT's notes whose syncSeq > cursor, ordered ascending (monotone). The sync boundary
 * is the accountId (Option B) — the whole account is one pull stream, spanning every notebookId tag,
 * so all of an account's devices converge. Includes tombstones (deletedAt IS NOT NULL) so the client
 * can apply PIN-SYNC-3.
 *
 * `cursor = 0` is a full account sync; `cursor = N` is incremental. syncSeq is unique + monotonic per
 * account (migration 0007 renumbers legacy per-notebook rows); the `id` tiebreak is a deterministic
 * belt for any pre-migration duplicate so pagination never straddles a tie.
 */
export async function pullNotes(
  db: DbAdapter,
  accountId: string,
  cursor: number,
): Promise<PullResult> {
  // Fetch one extra to detect hasMore without a separate COUNT query. Account-scoped read isolation:
  // the accountId comes from the verified principal, so only this account's notes are ever returned.
  const rows = await db.all<NoteRow>(
    `SELECT * FROM notes WHERE accountId = ? AND syncSeq > ? ORDER BY syncSeq ASC, id ASC LIMIT ?`,
    [accountId, cursor, PULL_PAGE + 1],
  );

  const hasMore = rows.length > PULL_PAGE;
  const page = hasMore ? rows.slice(0, PULL_PAGE) : rows;
  const nextCursor = page.length > 0 ? page[page.length - 1]!.syncSeq : cursor;

  return { notes: page, hasMore, nextCursor };
}

// ---------------------------------------------------------------------------
// Unified pull — notes AND notebooks on the one per-account syncSeq stream (Notebooks task #16)
// ---------------------------------------------------------------------------

export interface PullSinceResult {
  notes: NoteRow[];
  notebooks: NotebookRow[];
  nextCursor: number;
  hasMore: boolean;
}

/**
 * Fetch the account's NOTES and NOTEBOOKS with syncSeq > cursor as ONE ordered stream. Both entity
 * kinds share `accountSyncSeq`, so a single cursor walks both. We page over the union by syncSeq, then
 * hydrate full rows for the ids in the page — so a page boundary never skips an entity of either kind
 * (the bug a per-kind cursor would have). Account-scoped on every query (read isolation).
 */
export async function pullSince(
  db: DbAdapter,
  accountId: string,
  cursor: number,
): Promise<PullSinceResult> {
  const window = await db.all<{ id: string; syncSeq: number; kind: string }>(
    `SELECT id, syncSeq, 'note' AS kind FROM notes WHERE accountId = ? AND syncSeq > ?
     UNION ALL
     SELECT id, syncSeq, 'notebook' AS kind FROM notebooks WHERE accountId = ? AND syncSeq > ?
     ORDER BY syncSeq ASC, kind ASC, id ASC
     LIMIT ?`,
    [accountId, cursor, accountId, cursor, PULL_PAGE + 1],
  );

  const hasMore = window.length > PULL_PAGE;
  const page = hasMore ? window.slice(0, PULL_PAGE) : window;
  const noteIds = page.filter((w) => w.kind === 'note').map((w) => w.id);
  const nbIds = page.filter((w) => w.kind === 'notebook').map((w) => w.id);

  const notes = noteIds.length
    ? await db.all<NoteRow>(
        `SELECT * FROM notes WHERE accountId = ? AND id IN (${noteIds.map(() => '?').join(',')}) ORDER BY syncSeq ASC`,
        [accountId, ...noteIds],
      )
    : [];
  const notebooks = nbIds.length
    ? await db.all<NotebookRow>(
        `SELECT * FROM notebooks WHERE accountId = ? AND id IN (${nbIds.map(() => '?').join(',')}) ORDER BY syncSeq ASC`,
        [accountId, ...nbIds],
      )
    : [];
  const nextCursor = page.length > 0 ? page[page.length - 1]!.syncSeq : cursor;

  return { notes, notebooks, nextCursor, hasMore };
}

// ---------------------------------------------------------------------------
// REST read
// ---------------------------------------------------------------------------

export async function getNote(
  db: DbAdapter,
  id: string,
  notebookId: string,
  accountId: string,
): Promise<NoteRow | null> {
  return db.first<NoteRow>(
    `SELECT * FROM notes WHERE id = ? AND notebookId = ? AND accountId = ? AND deletedAt IS NULL`,
    [id, notebookId, accountId],
  );
}

// ---------------------------------------------------------------------------
// REST search (FTS stub — full-text search is Phase 3)
// ---------------------------------------------------------------------------

export async function searchNotes(
  db: DbAdapter,
  notebookId: string | undefined,
  accountId: string,
  text: string | undefined,
): Promise<NoteRow[]> {
  // Phase 1: title-only LIKE search as a placeholder. Full FTS (SQLite FTS5) is Phase 3.
  // EVERY branch is account-scoped — the no-notebookId branch was the original cross-account leak
  // (a bare `title LIKE` returned all accounts' notes). notebookId is a bare client string, so the
  // notebookId branches scope too — A's and B's "notebook-X" are distinct invisible rows.
  if (text && notebookId) {
    return db.all<NoteRow>(
      `SELECT * FROM notes WHERE notebookId = ? AND accountId = ? AND title LIKE ? AND deletedAt IS NULL ORDER BY updatedAt DESC LIMIT 50`,
      [notebookId, accountId, `%${text}%`],
    );
  }
  if (text) {
    return db.all<NoteRow>(
      `SELECT * FROM notes WHERE accountId = ? AND title LIKE ? AND deletedAt IS NULL ORDER BY updatedAt DESC LIMIT 50`,
      [accountId, `%${text}%`],
    );
  }
  if (notebookId) {
    return db.all<NoteRow>(
      `SELECT * FROM notes WHERE notebookId = ? AND accountId = ? AND deletedAt IS NULL ORDER BY updatedAt DESC LIMIT 50`,
      [notebookId, accountId],
    );
  }
  // Caller guarantees at least one constraint (SearchQuerySchema refine).
  return [];
}

export { UNSYNCED_VERSION };
