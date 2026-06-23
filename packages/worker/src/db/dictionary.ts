/**
 * Custom-dictionary mutations (custom-keyboard spec §5.2). The dictionary is a first-class, account-scoped,
 * SYNCED entity that rides the SAME per-account `accountSyncSeq` stream as notes + notebooks (see
 * db/mutate.ts) — every write bumps that one counter, so dictionary changes pull alongside the rest on a
 * single cursor (pullSince).
 *
 * SET SEMANTICS → conflict-free. Identity is (accountId, word), the composite PK; there is no version/CAS.
 *   - addWord    = upsert that CLEARS any tombstone (idempotent; multi-device adds of the same word
 *                  converge to one live row).
 *   - removeWord = set deletedAt (a streamed tombstone so the removal reaches other devices).
 * Every query is scoped to the server-derived accountId (never client-asserted) — the same isolation the
 * note + notebook paths hold. A cross-account word can never be read or written.
 */
import type { DictionaryWordRow, DbAdapter } from './schema.js';
import { BUMP_SEQ_SQL, READ_SEQ_SQL } from './mutate.js';

export interface DictionaryOutcome {
  word: string;
  syncSeq: number;
  row: DictionaryWordRow;
}

async function fetchWord(db: DbAdapter, accountId: string, word: string): Promise<DictionaryWordRow | null> {
  return db.first<DictionaryWordRow>(
    `SELECT * FROM dictionaryWords WHERE accountId = ? AND word = ?`,
    [accountId, word],
  );
}

/**
 * ADD a word (upsert). Inserts a live row, or — if the word already exists (possibly tombstoned) — clears
 * the tombstone and bumps its syncSeq so other devices re-learn it. Conflict-free + idempotent.
 */
export async function addWord(
  db: DbAdapter,
  accountId: string,
  word: string,
  nowIso: string,
): Promise<DictionaryOutcome> {
  await db.batch([
    { sql: BUMP_SEQ_SQL, params: [accountId] },
    {
      sql: `
        INSERT INTO dictionaryWords (accountId, word, createdAt, updatedAt, deletedAt, syncSeq)
        VALUES (?, ?, ?, ?, NULL, (${READ_SEQ_SQL}))
        ON CONFLICT(accountId, word) DO UPDATE SET
          deletedAt = NULL,
          updatedAt = excluded.updatedAt,
          syncSeq   = excluded.syncSeq
      `,
      params: [accountId, word, nowIso, nowIso, accountId],
    },
  ]);
  const row = (await fetchWord(db, accountId, word))!;
  return { word, syncSeq: row.syncSeq, row };
}

/**
 * REMOVE a word (tombstone). Sets deletedAt + bumps syncSeq so the removal streams to other devices. If
 * the word does not exist for this account it is a no-op against a fresh tombstone row — we still upsert a
 * tombstone so a remove that races ahead of an add on another device converges to "removed". Account-scoped.
 */
export async function removeWord(
  db: DbAdapter,
  accountId: string,
  word: string,
  nowIso: string,
): Promise<DictionaryOutcome> {
  await db.batch([
    { sql: BUMP_SEQ_SQL, params: [accountId] },
    {
      sql: `
        INSERT INTO dictionaryWords (accountId, word, createdAt, updatedAt, deletedAt, syncSeq)
        VALUES (?, ?, ?, ?, ?, (${READ_SEQ_SQL}))
        ON CONFLICT(accountId, word) DO UPDATE SET
          deletedAt = excluded.deletedAt,
          updatedAt = excluded.updatedAt,
          syncSeq   = excluded.syncSeq
      `,
      params: [accountId, word, nowIso, nowIso, nowIso, accountId],
    },
  ]);
  const row = (await fetchWord(db, accountId, word))!;
  return { word, syncSeq: row.syncSeq, row };
}

/** All live (non-tombstoned) words for an account — used by tests/callers to confirm the set. */
export async function liveWords(db: DbAdapter, accountId: string): Promise<DictionaryWordRow[]> {
  return db.all<DictionaryWordRow>(
    `SELECT * FROM dictionaryWords WHERE accountId = ? AND deletedAt IS NULL ORDER BY word ASC`,
    [accountId],
  );
}
