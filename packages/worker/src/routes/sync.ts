import { Hono } from 'hono';
import {
  SyncPushRequestSchema,
  SyncPullRequestSchema,
} from '@deltos/shared';
import type { SyncPushResult, SyncNote, NoteResponse } from '@deltos/shared';
import type { Env } from '../env.js';
import { guard, apiError } from '../http.js';
import { d1Adapter } from '../db/schema.js';
import type { NoteRow } from '../db/schema.js';
import { insertNote, updateNote, pullNotes } from '../db/mutate.js';

const sync = new Hono<{ Bindings: Env }>();

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
    resource: (req) => ({ kind: 'notebook', id: req.notebookId }),
    handle: async (req, c) => {
      const db = d1Adapter(c.env.DB);
      const now = new Date().toISOString();
      const results: SyncPushResult[] = [];

      for (const entry of req.entries) {
        const fullEntry = { ...entry, notebookId: req.notebookId };

        if (entry.baseVersion === 0) {
          // New note — INSERT guarded on id uniqueness
          const outcome = await insertNote(db, fullEntry, now);
          if (outcome.outcome === 'accepted') {
            results.push({ id: entry.id, outcome: 'accepted', version: outcome.version, syncSeq: outcome.syncSeq });
          } else {
            // id already exists — return null serverNote (client forks under new id)
            results.push({ id: entry.id, outcome: 'conflict', serverNote: null });
          }
        } else {
          // Update — atomic CAS on (id, notebookId, version)
          const outcome = await updateNote(db, fullEntry, now);
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
      const notebookId = c.req.query('notebookId');
      const cursorRaw = c.req.query('cursor');
      const cursor = cursorRaw !== undefined ? Number(cursorRaw) : undefined;
      return { notebookId, cursor };
    },
    resource: (req) => ({ kind: 'notebook', id: req.notebookId }),
    handle: async (req, c) => {
      const db = d1Adapter(c.env.DB);
      const { notes, nextCursor, hasMore } = await pullNotes(db, req.notebookId, req.cursor);
      const syncNotes: SyncNote[] = notes.map(rowToSyncNote);
      return c.json({ notes: syncNotes, nextCursor, hasMore });
    },
  }),
);

export { sync };
