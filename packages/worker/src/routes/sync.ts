import { Hono } from 'hono';
import {
  SyncPushRequestSchema,
  SyncPullRequestSchema,
} from '@deltos/shared';
import type { SyncPushResult, NotebookPushResult, SyncNote, SyncNotebook, NoteResponse } from '@deltos/shared';
import type { Resource } from '@deltos/shared';
import type { AppEnv } from '../context.js';
import { guard, apiError } from '../http.js';
import { d1Adapter } from '../db/schema.js';
import type { NoteRow, NotebookRow } from '../db/schema.js';
import { insertNote, updateNote, pullSince } from '../db/mutate.js';
import { insertNotebook, renameNotebook, deleteNotebook } from '../db/notebooks.js';
import { requireAccountId } from '../db/accountScope.js';

// Sync is scoped to the ACCOUNT, not a notebook (Option B, 2026-06-18): the boundary is the caller's
// accountId, derived server-side from the bearer token (requireAccountId), never a client-supplied
// notebookId. The guard resource is therefore the workspace — the same resource the session grant is
// minted against (grantAllows: a workspace grant authorizes any resource), and a TYPED resource, not a
// bare id. notebookId survives only as a per-note organizing tag carried on each note.
const workspaceResource = (): Resource => ({ kind: 'workspace' });

const sync = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a NoteRow (DB wire) to the NoteResponse shape (parsed body/properties + syncStatus).
 * The server always returns `syncStatus: 'synced'` — that field is client-side-only state.
 */
function rowToResponse(row: NoteRow): NoteResponse {
  return {
    id: row.id as NoteResponse['id'],
    notebookId: row.notebookId as NoteResponse['notebookId'],
    title: row.title,
    properties: JSON.parse(row.properties) as NoteResponse['properties'],
    body: JSON.parse(row.body) as NoteResponse['body'],
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    syncStatus: 'synced',
  };
}

function rowToSyncNote(row: NoteRow): SyncNote {
  return { ...rowToResponse(row), deletedAt: row.deletedAt ?? null, syncSeq: row.syncSeq };
}

/** NotebookRow (DB) → SyncNotebook (wire). isDefault is the SQLite 0/1 ⇒ boolean. */
function notebookRowToSync(row: NotebookRow): SyncNotebook {
  return {
    id: row.id as SyncNotebook['id'],
    name: row.name,
    defaultCollectionView: row.defaultCollectionView,
    isDefault: row.isDefault === 1,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt ?? null,
    syncSeq: row.syncSeq,
  };
}

/** NotebookRow → the conflict-result serverNotebook shape (notebook + version, no sync fields). */
function notebookConflictRow(row: NotebookRow): NonNullable<Extract<NotebookPushResult, { outcome: 'conflict' }>['serverNotebook']> {
  return {
    id: row.id as SyncNotebook['id'],
    name: row.name,
    defaultCollectionView: row.defaultCollectionView,
    isDefault: row.isDefault === 1,
    version: row.version,
  };
}

// ---------------------------------------------------------------------------
// POST /api/sync/push  (PIN-SYNC-1)
// ---------------------------------------------------------------------------

sync.post(
  '/push',
  guard({
    op: 'write',
    schema: SyncPushRequestSchema,
    input: async (c) => {
      try { return await c.req.json(); } catch { return undefined; }
    },
    resource: workspaceResource,
    handle: async (req, c) => {
      const db = d1Adapter(c.env.DB);
      // accountId is the caller's verified account (principal.id post-D6 re-point), resolved
      // server-side off the guard-set principal — NEVER from the request body. It scopes every write
      // to this account: insert STAMPS it, update CAS + conflict-path SELECT filter on it (no
      // cross-account write or leak). Fail-closed: requireAccountId throws if absent.
      const accountId = requireAccountId(c);
      const now = new Date().toISOString();
      const results: SyncPushResult[] = [];
      const notebookResults: NotebookPushResult[] = [];

      // NOTES — each entry carries its own notebookId (Option B; stamped on insert, restamped on
      // update for "move note"). accountId is server-derived and scopes every write + conflict SELECT.
      for (const entry of req.entries) {
        if (entry.baseVersion === 0) {
          // INSERT notebookId = per-entry, else the batch-level default ("current notebook").
          const notebookId = entry.notebookId ?? req.notebookId;
          if (notebookId === undefined) {
            return apiError(c, 400, 'invalid_request', 'note insert requires a notebookId (per-entry or batch-level)');
          }
          const outcome = await insertNote(db, { ...entry, notebookId }, accountId, now);
          if (outcome.outcome === 'accepted') {
            results.push({ id: entry.id, outcome: 'accepted', version: outcome.version, syncSeq: outcome.syncSeq });
          } else {
            results.push({ id: entry.id, outcome: 'conflict', serverNote: null });
          }
        } else {
          const outcome = await updateNote(db, entry, accountId, now);
          if (outcome.outcome === 'accepted') {
            results.push({ id: entry.id, outcome: 'accepted', version: outcome.version, syncSeq: outcome.syncSeq });
          } else {
            const serverNote = outcome.serverRow ? rowToResponse(outcome.serverRow) : null;
            results.push({ id: entry.id, outcome: 'conflict', serverNote });
          }
        }
      }

      // NOTEBOOKS — create (baseVersion 0) / rename (baseVersion N) / delete (delete:true → tombstone
      // + cascade live notes to Trash). Same accountId scope + accountSyncSeq stream as notes.
      for (const nb of req.notebookEntries) {
        const outcome = nb.delete === true
          ? await deleteNotebook(db, nb, accountId, now)
          : nb.baseVersion === 0
            ? await insertNotebook(db, nb, accountId, now)
            : await renameNotebook(db, nb, accountId, now);
        if (outcome.outcome === 'accepted') {
          notebookResults.push({ id: nb.id, outcome: 'accepted', version: outcome.version, syncSeq: outcome.syncSeq });
        } else {
          notebookResults.push({
            id: nb.id,
            outcome: 'conflict',
            serverNotebook: outcome.serverRow ? notebookConflictRow(outcome.serverRow) : null,
            reason: outcome.reason,
          });
        }
      }

      return c.json({ results, notebookResults });
    },
  }),
);

// ---------------------------------------------------------------------------
// GET /api/sync/pull  (PIN-SYNC-2)
// ---------------------------------------------------------------------------

sync.get(
  '/pull',
  guard({
    op: 'read',
    schema: SyncPullRequestSchema,
    input: (c) => {
      const cursorRaw = c.req.query('cursor');
      const cursor = cursorRaw !== undefined ? Number(cursorRaw) : undefined;
      return { cursor };
    },
    resource: workspaceResource,
    handle: async (req, c) => {
      const db = d1Adapter(c.env.DB);
      // Read isolation: pull returns ONLY the caller's account's notes (accountId resolved server-side
      // off the principal, never the body), across every notebookId the account owns. Fail-closed if
      // absent.
      const accountId = requireAccountId(c);
      const { notes, notebooks, nextCursor, hasMore } = await pullSince(db, accountId, req.cursor);
      return c.json({
        notes: notes.map(rowToSyncNote),
        notebooks: notebooks.map(notebookRowToSync),
        nextCursor,
        hasMore,
      });
    },
  }),
);

export { sync };
