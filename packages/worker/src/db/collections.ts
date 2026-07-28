/**
 * Collection + CollectionMember mutations (collections.md §3/§4). Both entities are first-class,
 * account-scoped, SYNCED rows that ride the SAME per-account `accountSyncSeq` stream as notes +
 * notebooks — every write bumps that one counter, so collection changes pull alongside the rest on
 * a single cursor (pullSince).
 *
 * Every query is scoped to the server-derived accountId (never client-asserted). Ownership belts:
 *   - insertCollection verifies notebookId is owned by accountId (v1: home always required)
 *   - addMember verifies collectionId + noteId owned by same accountId AND note lives in the
 *     collection's home notebook
 * Foreign/missing targets are CONFLICT, never a throw/400 (GOTCHA-0008: one bad entry must not
 * wedge the whole sync batch).
 */
import type { CollectionRow, CollectionMemberRow, DbAdapter } from './schema.js';
import type { CollectionPushEntry, CollectionMemberPushEntry } from '@deltos/shared';
import { collectionMemberId } from '@deltos/shared';
import { BUMP_SEQ_SQL, READ_SEQ_SQL } from './mutate.js';

export type CollectionOutcome =
  | { outcome: 'accepted'; version: number; syncSeq: number; row: CollectionRow }
  | { outcome: 'conflict'; serverRow: CollectionRow | null };

export type CollectionMemberOutcome =
  | { outcome: 'accepted'; version: number; syncSeq: number; row: CollectionMemberRow }
  | { outcome: 'conflict'; serverRow: CollectionMemberRow | null };

const FIRST_VERSION = 1;

/**
 * @internal test-only hooks for fault-injection catch-tests (resumable cascade).
 * Production code never sets these.
 */
export const collectionsTestHooks: {
  beforeMemberCascade: null | (() => void);
  beforeNotebookCollectionCascade: null | (() => void);
} = {
  beforeMemberCascade: null,
  beforeNotebookCollectionCascade: null,
};

async function fetchCollection(
  db: DbAdapter,
  id: string,
  accountId: string,
): Promise<CollectionRow | null> {
  return db.first<CollectionRow>(
    `SELECT * FROM collections WHERE id = ? AND accountId = ?`,
    [id, accountId],
  );
}

async function fetchMember(
  db: DbAdapter,
  id: string,
  accountId: string,
): Promise<CollectionMemberRow | null> {
  return db.first<CollectionMemberRow>(
    `SELECT * FROM collectionMembers WHERE id = ? AND accountId = ?`,
    [id, accountId],
  );
}

function ruleToStore(rule: unknown): string | null {
  if (rule === null || rule === undefined) return null;
  return JSON.stringify(rule);
}

/** Create a collection (push baseVersion 0). Conflicts if id exists, home is null, or notebook foreign. */
export async function insertCollection(
  db: DbAdapter,
  entry: CollectionPushEntry,
  accountId: string,
  nowIso: string,
): Promise<CollectionOutcome> {
  const draft = entry.draft!;

  // v1: home notebook is required (null reserved for a future cross-notebook/global option).
  if (draft.notebookId === null) {
    return { outcome: 'conflict', serverRow: await fetchCollection(db, entry.id, accountId) };
  }

  // Ownership belt: home notebook must be a live notebook owned by this account.
  const owned = await db.first<{ id: string }>(
    `SELECT id FROM notebooks WHERE id = ? AND accountId = ? AND deletedAt IS NULL`,
    [draft.notebookId, accountId],
  );
  if (!owned) {
    return { outcome: 'conflict', serverRow: await fetchCollection(db, entry.id, accountId) };
  }

  const batch = await db.batch([
    { sql: BUMP_SEQ_SQL, params: [accountId] },
    {
      sql: `
        INSERT INTO collections (id, accountId, notebookId, name, icon, color, ord, rule, version, createdAt, updatedAt, syncSeq)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (${READ_SEQ_SQL})
        WHERE NOT EXISTS (SELECT 1 FROM collections WHERE id = ?)
      `,
      params: [
        entry.id,
        accountId,
        draft.notebookId,
        draft.name,
        draft.icon ?? null,
        draft.color ?? null,
        draft.ord,
        ruleToStore(draft.rule),
        FIRST_VERSION,
        nowIso,
        nowIso,
        accountId,
        entry.id,
      ],
    },
  ]);
  if (batch[1]!.rowsWritten === 0) {
    return { outcome: 'conflict', serverRow: await fetchCollection(db, entry.id, accountId) };
  }
  const row = (await fetchCollection(db, entry.id, accountId))!;
  return { outcome: 'accepted', version: row.version, syncSeq: row.syncSeq, row };
}

/** Rename / restyle / reorder an existing collection via atomic CAS on (id, accountId, version). */
export async function renameCollection(
  db: DbAdapter,
  entry: CollectionPushEntry,
  accountId: string,
  nowIso: string,
): Promise<CollectionOutcome> {
  const draft = entry.draft!;

  // v1: home is required and fixed at create — reject null and reject a notebookId move.
  if (draft.notebookId === null) {
    return { outcome: 'conflict', serverRow: await fetchCollection(db, entry.id, accountId) };
  }
  const current = await fetchCollection(db, entry.id, accountId);
  if (current && current.deletedAt === null && current.notebookId !== draft.notebookId) {
    return { outcome: 'conflict', serverRow: current };
  }

  // Ownership belt on the (unchanging) home notebook.
  const owned = await db.first<{ id: string }>(
    `SELECT id FROM notebooks WHERE id = ? AND accountId = ? AND deletedAt IS NULL`,
    [draft.notebookId, accountId],
  );
  if (!owned) {
    return { outcome: 'conflict', serverRow: await fetchCollection(db, entry.id, accountId) };
  }

  const batch = await db.batch([
    { sql: BUMP_SEQ_SQL, params: [accountId] },
    {
      sql: `
        UPDATE collections
        SET name = ?, icon = ?, color = ?, ord = ?, rule = ?,
            updatedAt = ?, version = version + 1, syncSeq = (${READ_SEQ_SQL})
        WHERE id = ? AND accountId = ? AND version = ? AND deletedAt IS NULL
          AND notebookId = ?
      `,
      // notebookId is NOT in the SET — home is immutable in v1 (belt also enforced above).
      params: [
        draft.name,
        draft.icon ?? null,
        draft.color ?? null,
        draft.ord,
        ruleToStore(draft.rule),
        nowIso,
        accountId,
        entry.id,
        accountId,
        entry.baseVersion,
        draft.notebookId,
      ],
    },
  ]);
  // CAS hit ⇔ rowsWritten > 0 (real D1 counts index writes; see d1-rowswritten-index-inflation).
  if (batch[1]!.rowsWritten > 0) {
    const row = (await fetchCollection(db, entry.id, accountId))!;
    return { outcome: 'accepted', version: row.version, syncSeq: row.syncSeq, row };
  }
  return { outcome: 'conflict', serverRow: await fetchCollection(db, entry.id, accountId) };
}

/**
 * DELETE a collection (push entry with delete:true). Resumable:
 *   1. CAS-tombstone the collection (no-op if already tombstoned)
 *   2. ALWAYS cascade-tombstone live members when the parent is dead (so a retry after a mid-cascade
 *      failure finishes the stragglers instead of CAS-conflicting forever)
 * Notes are untouched — they only lost a grouping.
 */
export async function deleteCollection(
  db: DbAdapter,
  entry: CollectionPushEntry,
  accountId: string,
  nowIso: string,
): Promise<CollectionOutcome> {
  await db.batch([
    { sql: BUMP_SEQ_SQL, params: [accountId] },
    {
      sql: `
        UPDATE collections
        SET deletedAt = ?, updatedAt = ?, version = version + 1, syncSeq = (${READ_SEQ_SQL})
        WHERE id = ? AND accountId = ? AND version = ? AND deletedAt IS NULL
      `,
      params: [nowIso, nowIso, accountId, entry.id, accountId, entry.baseVersion],
    },
  ]);

  const row = await fetchCollection(db, entry.id, accountId);
  // Parent still live → CAS missed on a live row (stale version) → conflict; do NOT cascade.
  if (!row || row.deletedAt === null) {
    return { outcome: 'conflict', serverRow: row };
  }

  // Parent is dead (just now or on a prior attempt) — always sweep live member stragglers.
  await tombstoneLiveMembersOfCollection(db, accountId, entry.id, nowIso);

  const after = (await fetchCollection(db, entry.id, accountId))!;
  return { outcome: 'accepted', version: after.version, syncSeq: after.syncSeq, row: after };
}

/**
 * Tombstone every live member of a collection, each with a distinct syncSeq. Account-scoped.
 * Seq reservation is atomic with the assignment (COUNT inside the same batch — no external COUNT
 * that a concurrent add could inflate past).
 */
async function tombstoneLiveMembersOfCollection(
  db: DbAdapter,
  accountId: string,
  collectionId: string,
  nowIso: string,
): Promise<void> {
  collectionsTestHooks.beforeMemberCascade?.();

  // One atomic batch: reserve N = live-count, then assign syncSeqs from that same snapshot.
  // D1/better-sqlite3 batch is a transaction — no concurrent add can interleave between the two.
  await db.batch([
    {
      sql: `
        UPDATE accountSyncSeq
        SET seq = seq + (
          SELECT COUNT(*) FROM collectionMembers
          WHERE accountId = ? AND collectionId = ? AND deletedAt IS NULL
        )
        WHERE accountId = ?
      `,
      params: [accountId, collectionId, accountId],
    },
    {
      sql: `
        WITH t AS (
          SELECT id, ROW_NUMBER() OVER (ORDER BY createdAt, id) AS rn
          FROM collectionMembers
          WHERE accountId = ? AND collectionId = ? AND deletedAt IS NULL
        ),
        cnt AS (SELECT COUNT(*) AS n FROM t)
        UPDATE collectionMembers
        SET deletedAt = ?,
            updatedAt = ?,
            version   = version + 1,
            syncSeq   = (
              (SELECT seq FROM accountSyncSeq WHERE accountId = ?)
              - (SELECT n FROM cnt)
              + (SELECT rn FROM t WHERE t.id = collectionMembers.id)
            )
        WHERE id IN (SELECT id FROM t)
      `,
      params: [accountId, collectionId, nowIso, nowIso, accountId],
    },
  ]);
}

/**
 * Tombstone every live collection (and all their live members) whose home notebook is `notebookId`.
 * Set-based: one atomic batch for collection tombstones + one for all their members (no O(n) loop).
 * Seq reservation is atomic with assignment (P0). Re-runnable: only touches still-live rows (P1).
 */
export async function tombstoneCollectionsForNotebook(
  db: DbAdapter,
  accountId: string,
  notebookId: string,
  nowIso: string,
): Promise<void> {
  collectionsTestHooks.beforeNotebookCollectionCascade?.();

  // Atomic batch: reserve + tombstone live home collections; then reserve + tombstone ALL live
  // members of any collection (live or already-tombstoned) under this home notebook.
  await db.batch([
    {
      sql: `
        UPDATE accountSyncSeq
        SET seq = seq + (
          SELECT COUNT(*) FROM collections
          WHERE accountId = ? AND notebookId = ? AND deletedAt IS NULL
        )
        WHERE accountId = ?
      `,
      params: [accountId, notebookId, accountId],
    },
    {
      sql: `
        WITH t AS (
          SELECT id, ROW_NUMBER() OVER (ORDER BY createdAt, id) AS rn
          FROM collections
          WHERE accountId = ? AND notebookId = ? AND deletedAt IS NULL
        ),
        cnt AS (SELECT COUNT(*) AS n FROM t)
        UPDATE collections
        SET deletedAt = ?,
            updatedAt = ?,
            version   = version + 1,
            syncSeq   = (
              (SELECT seq FROM accountSyncSeq WHERE accountId = ?)
              - (SELECT n FROM cnt)
              + (SELECT rn FROM t WHERE t.id = collections.id)
            )
        WHERE id IN (SELECT id FROM t)
      `,
      params: [accountId, notebookId, nowIso, nowIso, accountId],
    },
    {
      // Members of collections whose home is this notebook (collection may already be tombstoned
      // from stmt 2, or from a prior partial attempt — join does not require collection.deletedAt IS NULL).
      sql: `
        UPDATE accountSyncSeq
        SET seq = seq + (
          SELECT COUNT(*) FROM collectionMembers m
          INNER JOIN collections c ON c.id = m.collectionId AND c.accountId = m.accountId
          WHERE m.accountId = ? AND c.notebookId = ? AND m.deletedAt IS NULL
        )
        WHERE accountId = ?
      `,
      params: [accountId, notebookId, accountId],
    },
    {
      sql: `
        WITH t AS (
          SELECT m.id AS id, ROW_NUMBER() OVER (ORDER BY m.createdAt, m.id) AS rn
          FROM collectionMembers m
          INNER JOIN collections c ON c.id = m.collectionId AND c.accountId = m.accountId
          WHERE m.accountId = ? AND c.notebookId = ? AND m.deletedAt IS NULL
        ),
        cnt AS (SELECT COUNT(*) AS n FROM t)
        UPDATE collectionMembers
        SET deletedAt = ?,
            updatedAt = ?,
            version   = version + 1,
            syncSeq   = (
              (SELECT seq FROM accountSyncSeq WHERE accountId = ?)
              - (SELECT n FROM cnt)
              + (SELECT rn FROM t WHERE t.id = collectionMembers.id)
            )
        WHERE id IN (SELECT id FROM t)
      `,
      params: [accountId, notebookId, nowIso, nowIso, accountId],
    },
  ]);
}

/**
 * ADD a member (baseVersion 0). Ownership belt: both ends live+owned → else conflict.
 * Idempotent upsert on unique (accountId, collectionId, noteId); revives tombstones in place.
 * Member id MUST equal collectionMemberId(collectionId, noteId) — mismatched id → conflict.
 */
export async function addMember(
  db: DbAdapter,
  entry: CollectionMemberPushEntry,
  accountId: string,
  nowIso: string,
): Promise<CollectionMemberOutcome> {
  const draft = entry.draft!;

  // Enforce deterministic id so PK and unique triple always coincide (no PK-collision 500, no desync).
  const expectedId = collectionMemberId(draft.collectionId, draft.noteId);
  if (entry.id !== expectedId) {
    return { outcome: 'conflict', serverRow: await fetchMember(db, entry.id, accountId) };
  }

  // Ownership belt — both ends must be live + owned. Foreign/missing → conflict (never 400).
  const col = await db.first<CollectionRow>(
    `SELECT * FROM collections WHERE id = ? AND accountId = ? AND deletedAt IS NULL`,
    [draft.collectionId, accountId],
  );
  const note = await db.first<{ id: string; notebookId: string | null }>(
    `SELECT id, notebookId FROM notes WHERE id = ? AND accountId = ? AND deletedAt IS NULL`,
    [draft.noteId, accountId],
  );
  if (!col || !note) {
    return { outcome: 'conflict', serverRow: await fetchMember(db, entry.id, accountId) };
  }

  // v1 home-notebook membership invariant: note must live in the collection's home notebook.
  // FUTURE(cross-notebook/global): this is the exact seam that relaxes when collection.notebookId
  // is null (global) or membership may span notebooks — keep it a single clearly-marked check.
  if (note.notebookId !== col.notebookId) {
    return { outcome: 'conflict', serverRow: await fetchMember(db, entry.id, accountId) };
  }

  // Upsert on the TRIPLE (source of truth). entry.id is the deterministic collectionMemberId —
  // PK and unique triple coincide; ON CONFLICT never rewrites id.
  await db.batch([
    { sql: BUMP_SEQ_SQL, params: [accountId] },
    {
      sql: `
        INSERT INTO collectionMembers (id, accountId, collectionId, noteId, ord, version, createdAt, updatedAt, deletedAt, syncSeq)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, (${READ_SEQ_SQL}))
        ON CONFLICT(accountId, collectionId, noteId) DO UPDATE SET
          deletedAt = NULL,
          ord       = excluded.ord,
          updatedAt = excluded.updatedAt,
          version   = version + 1,
          syncSeq   = excluded.syncSeq
      `,
      params: [
        entry.id,
        accountId,
        draft.collectionId,
        draft.noteId,
        draft.ord,
        FIRST_VERSION,
        nowIso,
        nowIso,
        accountId,
      ],
    },
  ]);
  // Fetch by the unique triple (not PK) so a pre-existing row is always found after upsert.
  const row = (await db.first<CollectionMemberRow>(
    `SELECT * FROM collectionMembers WHERE accountId = ? AND collectionId = ? AND noteId = ?`,
    [accountId, draft.collectionId, draft.noteId],
  ))!;
  return { outcome: 'accepted', version: row.version, syncSeq: row.syncSeq, row };
}

/** REMOVE a member (push delete:true) — CAS-tombstone so the removal streams to other devices. */
export async function removeMember(
  db: DbAdapter,
  entry: CollectionMemberPushEntry,
  accountId: string,
  nowIso: string,
): Promise<CollectionMemberOutcome> {
  const batch = await db.batch([
    { sql: BUMP_SEQ_SQL, params: [accountId] },
    {
      sql: `
        UPDATE collectionMembers
        SET deletedAt = ?, updatedAt = ?, version = version + 1, syncSeq = (${READ_SEQ_SQL})
        WHERE id = ? AND accountId = ? AND version = ? AND deletedAt IS NULL
      `,
      params: [nowIso, nowIso, accountId, entry.id, accountId, entry.baseVersion],
    },
  ]);
  if (batch[1]!.rowsWritten > 0) {
    const row = (await fetchMember(db, entry.id, accountId))!;
    return { outcome: 'accepted', version: row.version, syncSeq: row.syncSeq, row };
  }
  return { outcome: 'conflict', serverRow: await fetchMember(db, entry.id, accountId) };
}

/** Reorder a member (push baseVersion N + draft) via atomic CAS on (id, accountId, version). */
export async function reorderMember(
  db: DbAdapter,
  entry: CollectionMemberPushEntry,
  accountId: string,
  nowIso: string,
): Promise<CollectionMemberOutcome> {
  const draft = entry.draft!;

  // Enforce deterministic id (same rule as addMember) so a reorder can't rebind PK→triple.
  const expectedId = collectionMemberId(draft.collectionId, draft.noteId);
  if (entry.id !== expectedId) {
    return { outcome: 'conflict', serverRow: await fetchMember(db, entry.id, accountId) };
  }

  const batch = await db.batch([
    { sql: BUMP_SEQ_SQL, params: [accountId] },
    {
      sql: `
        UPDATE collectionMembers
        SET ord = ?, updatedAt = ?, version = version + 1, syncSeq = (${READ_SEQ_SQL})
        WHERE id = ? AND accountId = ? AND version = ? AND deletedAt IS NULL
          AND collectionId = ? AND noteId = ?
      `,
      params: [
        draft.ord,
        nowIso,
        accountId,
        entry.id,
        accountId,
        entry.baseVersion,
        draft.collectionId,
        draft.noteId,
      ],
    },
  ]);
  if (batch[1]!.rowsWritten > 0) {
    const row = (await fetchMember(db, entry.id, accountId))!;
    return { outcome: 'accepted', version: row.version, syncSeq: row.syncSeq, row };
  }
  return { outcome: 'conflict', serverRow: await fetchMember(db, entry.id, accountId) };
}

/** Live collections for an account (most-recently-touched first). */
// TODO(perf): paginate once accounts grow past a few hundred collections.
export async function listCollectionsForAccount(
  db: DbAdapter,
  accountId: string,
): Promise<CollectionRow[]> {
  return db.all<CollectionRow>(
    `SELECT * FROM collections WHERE accountId = ? AND deletedAt IS NULL ORDER BY updatedAt DESC`,
    [accountId],
  );
}

/** Live members of a collection, ordered by ord then createdAt. */
// TODO(perf): paginate once collections grow past a few hundred members.
export async function membersForCollection(
  db: DbAdapter,
  accountId: string,
  collectionId: string,
): Promise<CollectionMemberRow[]> {
  return db.all<CollectionMemberRow>(
    `SELECT * FROM collectionMembers
     WHERE accountId = ? AND collectionId = ? AND deletedAt IS NULL
     ORDER BY ord ASC, createdAt ASC`,
    [accountId, collectionId],
  );
}
