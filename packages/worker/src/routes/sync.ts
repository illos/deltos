import { Hono } from 'hono';
import {
  SyncPushRequestSchema,
  SyncPullRequestSchema,
} from '@deltos/shared';
import type { SyncPushResult, SyncNote, NoteResponse } from '@deltos/shared';
import type { Resource } from '@deltos/shared';
import type { AppEnv } from '../context.js';
import { guard, apiError } from '../http.js';
import { d1Adapter } from '../db/schema.js';
import type { NoteRow } from '../db/schema.js';
import { insertNote, updateNote, pullNotes } from '../db/mutate.js';
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

      for (const entry of req.entries) {
        const fullEntry = { ...entry, notebookId: req.notebookId };

        if (entry.baseVersion === 0) {
          // New note — INSERT guarded on id uniqueness, accountId stamped from the principal
          const outcome = await insertNote(db, fullEntry, accountId, now);
          if (outcome.outcome === 'accepted') {
            results.push({ id: entry.id, outcome: 'accepted', version: outcome.version, syncSeq: outcome.syncSeq });
          } else {
            // id already exists — return null serverNote (client forks under new id)
            results.push({ id: entry.id, outcome: 'conflict', serverNote: null });
          }
        } else {
          // Update — atomic CAS on (id, notebookId, version, accountId); the conflict-path serverNote
          // SELECT is also accountId-scoped inside updateNote, so a cross-account push gets a 0-row CAS
          // → conflict with a NULL serverNote (no leak), and the client forks under a new id.
          const outcome = await updateNote(db, fullEntry, accountId, now);
          if (outcome.outcome === 'accepted') {
            results.push({ id: entry.id, outcome: 'accepted', version: outcome.version, syncSeq: outcome.syncSeq });
          } else {
            const serverNote = outcome.serverRow ? rowToResponse(outcome.serverRow) : null;
            results.push({ id: entry.id, outcome: 'conflict', serverNote });
          }
        }
      }

      return c.json({ results });
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
      const { notes, nextCursor, hasMore } = await pullNotes(db, accountId, req.cursor);
      const syncNotes: SyncNote[] = notes.map(rowToSyncNote);
      return c.json({ notes: syncNotes, nextCursor, hasMore });
    },
  }),
);

export { sync };
