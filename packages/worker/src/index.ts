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
import type { Resource } from '@deltos/shared';
import type { Env } from './env.js';
import { guard, apiError, notImplemented, type AppContext } from './http.js';

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

// note.create — authorized against the destination notebook.
app.post(
  API_ROUTES['note.create'].path,
  guard({
    op: API_ROUTES['note.create'].op,
    schema: CreateNoteRequestSchema,
    input: (c) => readBody(c),
    resource: (req): Resource => ({ kind: 'notebook', id: req.notebookId }),
    handle: (_req, c) => notImplemented(c, 'note.create'),
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
    handle: (_req, c) => notImplemented(c, 'note.get'),
  }),
);

// note.update
app.patch(
  API_ROUTES['note.update'].path,
  guard({
    op: API_ROUTES['note.update'].op,
    schema: UpdateNoteRequestSchema,
    // Body carries { patch, expectedVersion? }; the note id comes from the path. Path params
    // are overlaid LAST so the URL's addressing id always wins over any id smuggled in the body.
    input: async (c) => ({ ...asObject(await readBody(c)), id: c.req.param('id') }),
    resource: (req): Resource => ({ kind: 'note', id: req.id }),
    handle: (_req, c) => notImplemented(c, 'note.update'),
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
    handle: (_req, c) => notImplemented(c, 'note.delete'),
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
    handle: (_req, c) => notImplemented(c, 'note.search'),
  }),
);

// block.append
app.post(
  API_ROUTES['block.append'].path,
  guard({
    op: API_ROUTES['block.append'].op,
    schema: AppendBlockRequestSchema,
    // Body carries { block, parentBlockId?, expectedVersion? }; noteId comes from the path and
    // is overlaid LAST so a body field can never override the URL's addressing.
    input: async (c) => ({ ...asObject(await readBody(c)), noteId: c.req.param('id') }),
    resource: (req): Resource => ({ kind: 'note', id: req.noteId }),
    handle: (_req, c) => notImplemented(c, 'block.append'),
  }),
);

// property.set
app.put(
  API_ROUTES['property.set'].path,
  guard({
    op: API_ROUTES['property.set'].op,
    schema: SetPropertyRequestSchema,
    // Body carries { value, expectedVersion? }; noteId + key come from the path and are overlaid
    // LAST so body fields can never override the URL's addressing.
    input: async (c) => ({
      ...asObject(await readBody(c)),
      noteId: c.req.param('id'),
      key: c.req.param('key'),
    }),
    resource: (req): Resource => ({ kind: 'note', id: req.noteId }),
    handle: (_req, c) => notImplemented(c, 'property.set'),
  }),
);

// Unknown /api/* paths get a JSON 404, never an HTML page.
app.notFound((c) => apiError(c as AppContext, 404, 'not_found', 'no such API route'));

export default app;
