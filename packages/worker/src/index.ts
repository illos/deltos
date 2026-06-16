import { Hono } from 'hono';
import {
  CreateNoteRequestSchema,
  NoteRefSchema,
  UpdateNoteRequestSchema,
  AppendBlockRequestSchema,
  SetPropertyRequestSchema,
  SearchQuerySchema,
  API_ROUTES,
} from '@deltos/shared';
import type { Resource, NoteResponse } from '@deltos/shared';
import type { Env } from './env.js';
import { guard, apiError, type AppContext } from './http.js';
import { d1Adapter } from './db/schema.js';
import type { NoteRow } from './db/schema.js';
import {
  insertNote,
  patchNote,
  deleteNote,
  searchNotes,
} from './db/mutate.js';
import { sync } from './routes/sync.js';
import { auth } from './routes/auth.js';

const app = new Hono<{ Bindings: Env }>();

/**
 * Liveness + readiness. The worker answering at all is liveness; the D1 probe (reading the
 * baseline `meta` row) is readiness — it proves the binding is wired and migrations applied.
 */
app.get('/api/health', async (c) => {
  let db: 'ok' | 'unmigrated' | 'unavailable' = 'unavailable';
  let spineContractVersion: string | null = null;
  try {
    const row = await c.env.DB.prepare('SELECT value FROM meta WHERE key = ?')
      .bind('spineContractVersion')
      .first<{ value: string }>();
    if (row) {
      db = 'ok';
      spineContractVersion = row.value;
    } else {
      db = 'unmigrated';
    }
  } catch {
    db = 'unavailable';
  }
  return c.json({
    status: db === 'ok' ? 'ok' : 'degraded',
    service: 'deltos',
    db,
    spineContractVersion,
  });
});

// ---------------------------------------------------------------------------
// Sync substrate routes — mounted before the REST layer (PIN-SYNC-1/2)
// ---------------------------------------------------------------------------

app.route('/api/sync', sync);

// ---------------------------------------------------------------------------
// Stream A identity auth routes — the unauthenticated bootstrap that mints request auth.
// Handlers are contract-only skeletons (501) until authCrypto + authStore land.
// ---------------------------------------------------------------------------

app.route('/api/auth', auth);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read a JSON body without throwing on empty/invalid input — schema validation reports the 400. */
async function readBody(c: AppContext): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

/** Narrow an unknown body to a plain object so its fields can be merged with path params. */
function asObject(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/**
 * Convert a DB row to the NoteResponse wire shape.
 * The server always returns `syncStatus: 'synced'` — it is client-side-only state.
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

// ---------------------------------------------------------------------------
// REST operations
// ---------------------------------------------------------------------------

// note.create — authorized against the destination notebook.
app.post(
  API_ROUTES['note.create'].path,
  guard({
    op: API_ROUTES['note.create'].op,
    schema: CreateNoteRequestSchema,
    input: (c) => readBody(c),
    resource: (req): Resource => ({ kind: 'notebook', id: req.notebookId }),
    handle: async (req, c) => {
      const db = d1Adapter(c.env.DB);
      const now = new Date().toISOString();
      const entry = {
        id: req.id,
        notebookId: req.notebookId,
        baseVersion: 0 as const,
        draft: { title: req.title, properties: req.properties, body: req.body },
      };
      const outcome = await insertNote(db, entry, now);
      if (outcome.outcome === 'conflict') {
        return apiError(c, 400, 'conflict', 'a note with this id already exists');
      }
      return c.json(rowToResponse(outcome.row), 201);
    },
  }),
);

// note.get
app.get(
  API_ROUTES['note.get'].path,
  guard({
    op: API_ROUTES['note.get'].op,
    schema: NoteRefSchema,
    input: (c) => ({ id: c.req.param('id') }),
    resource: (req): Resource => ({ kind: 'note', id: req.id }),
    handle: async (req, c) => {
      const db = d1Adapter(c.env.DB);
      // Note id is globally unique (UUID); notebookId scoping is in the auth layer.
      const row = await db.first<NoteRow>(
        `SELECT * FROM notes WHERE id = ? AND deletedAt IS NULL`,
        [req.id],
      );
      if (!row) return apiError(c, 404, 'not_found', 'note not found');
      return c.json(rowToResponse(row));
    },
  }),
);

// note.update
app.patch(
  API_ROUTES['note.update'].path,
  guard({
    op: API_ROUTES['note.update'].op,
    schema: UpdateNoteRequestSchema,
    input: async (c) => ({ ...asObject(await readBody(c)), id: c.req.param('id') }),
    resource: (req): Resource => ({ kind: 'note', id: req.id }),
    handle: async (req, c) => {
      const db = d1Adapter(c.env.DB);
      const now = new Date().toISOString();

      // Pre-fetch notebookId — it's not in the update request, but patchNote needs it for CAS.
      const lookup = await db.first<{ notebookId: string }>(
        `SELECT notebookId FROM notes WHERE id = ? AND deletedAt IS NULL`,
        [req.id],
      );
      if (!lookup) return apiError(c, 404, 'not_found', 'note not found');

      const patch: { title?: string; properties?: string; body?: string } = {};
      if (req.patch.title !== undefined) patch.title = req.patch.title;
      if (req.patch.properties !== undefined) patch.properties = JSON.stringify(req.patch.properties);
      if (req.patch.body !== undefined) patch.body = JSON.stringify(req.patch.body);

      const outcome = await patchNote(db, req.id, lookup.notebookId, patch, req.expectedVersion, now);
      if (outcome.outcome === 'not_found') return apiError(c, 404, 'not_found', 'note not found');
      if (outcome.outcome === 'conflict') return apiError(c, 409, 'conflict', 'version mismatch — note was modified concurrently');
      return c.json(rowToResponse(outcome.row));
    },
  }),
);

// note.delete
app.delete(
  API_ROUTES['note.delete'].path,
  guard({
    op: API_ROUTES['note.delete'].op,
    schema: NoteRefSchema,
    input: (c) => ({ id: c.req.param('id') }),
    resource: (req): Resource => ({ kind: 'note', id: req.id }),
    handle: async (req, c) => {
      const db = d1Adapter(c.env.DB);
      const now = new Date().toISOString();

      const lookup = await db.first<{ notebookId: string }>(
        `SELECT notebookId FROM notes WHERE id = ?`,
        [req.id],
      );
      if (!lookup) return apiError(c, 404, 'not_found', 'note not found');

      const outcome = await deleteNote(db, req.id, lookup.notebookId, undefined, now);
      if (outcome.outcome === 'not_found') return apiError(c, 404, 'not_found', 'note not found');
      if (outcome.outcome === 'conflict') return apiError(c, 409, 'conflict', 'note was modified concurrently');
      return c.json({ id: req.id, deleted: true });
    },
  }),
);

// note.search — scoped to a notebook when given, else the whole workspace.
app.get(
  API_ROUTES['note.search'].path,
  guard({
    op: API_ROUTES['note.search'].op,
    schema: SearchQuerySchema,
    input: (c) => {
      const text = c.req.query('text');
      const notebookId = c.req.query('notebookId');
      return {
        ...(text === undefined ? {} : { text }),
        ...(notebookId === undefined ? {} : { notebookId }),
      };
    },
    resource: (req): Resource =>
      req.notebookId === undefined
        ? { kind: 'workspace' }
        : { kind: 'notebook', id: req.notebookId },
    handle: async (req, c) => {
      const db = d1Adapter(c.env.DB);
      const rows = await searchNotes(db, req.notebookId, req.text);
      const results = rows.map((row) => ({
        id: row.id,
        notebookId: row.notebookId,
        title: row.title,
        updatedAt: row.updatedAt,
        syncStatus: 'synced' as const,
      }));
      return c.json({ results });
    },
  }),
);

// block.append — fetch current note body, append, then patch the whole body.
app.post(
  API_ROUTES['block.append'].path,
  guard({
    op: API_ROUTES['block.append'].op,
    schema: AppendBlockRequestSchema,
    input: async (c) => ({ ...asObject(await readBody(c)), noteId: c.req.param('id') }),
    resource: (req): Resource => ({ kind: 'note', id: req.noteId }),
    handle: async (req, c) => {
      const db = d1Adapter(c.env.DB);
      const now = new Date().toISOString();

      const rawRow = await db.first<NoteRow>(
        `SELECT * FROM notes WHERE id = ? AND deletedAt IS NULL`,
        [req.noteId],
      );
      if (!rawRow) return apiError(c, 404, 'not_found', 'note not found');

      const currentBody = JSON.parse(rawRow.body) as unknown[];
      const newBody = [...currentBody, req.block];

      const outcome = await patchNote(
        db, req.noteId, rawRow.notebookId,
        { body: JSON.stringify(newBody) },
        req.expectedVersion, now,
      );
      if (outcome.outcome === 'not_found') return apiError(c, 404, 'not_found', 'note not found');
      if (outcome.outcome === 'conflict') return apiError(c, 409, 'conflict', 'version mismatch');
      return c.json(rowToResponse(outcome.row));
    },
  }),
);

// property.set — fetch current properties, merge key, then patch.
app.put(
  API_ROUTES['property.set'].path,
  guard({
    op: API_ROUTES['property.set'].op,
    schema: SetPropertyRequestSchema,
    input: async (c) => ({
      ...asObject(await readBody(c)),
      noteId: c.req.param('id'),
      key: c.req.param('key'),
    }),
    resource: (req): Resource => ({ kind: 'note', id: req.noteId }),
    handle: async (req, c) => {
      const db = d1Adapter(c.env.DB);
      const now = new Date().toISOString();

      const rawRow = await db.first<NoteRow>(
        `SELECT * FROM notes WHERE id = ? AND deletedAt IS NULL`,
        [req.noteId],
      );
      if (!rawRow) return apiError(c, 404, 'not_found', 'note not found');

      const currentProps = JSON.parse(rawRow.properties) as Record<string, unknown>;
      const newProps = { ...currentProps, [req.key]: req.value };

      const outcome = await patchNote(
        db, req.noteId, rawRow.notebookId,
        { properties: JSON.stringify(newProps) },
        req.expectedVersion, now,
      );
      if (outcome.outcome === 'not_found') return apiError(c, 404, 'not_found', 'note not found');
      if (outcome.outcome === 'conflict') return apiError(c, 409, 'conflict', 'version mismatch');
      return c.json(rowToResponse(outcome.row));
    },
  }),
);

// Unknown /api/* paths get a JSON 404, never an HTML page.
app.notFound((c) => apiError(c as AppContext, 404, 'not_found', 'no such API route'));

export default app;
