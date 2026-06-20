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
import type { AppEnv } from './context.js';
import { d1Adapter } from './db/schema.js';
import type { NoteRow } from './db/schema.js';
import {
  insertNote,
  patchNote,
  deleteNote,
  searchNotes,
} from './db/mutate.js';
import {
  callerAccountId,
  stampAccountId,
  getNoteForAccount,
  getNoteForAccountIncludingDeleted,
} from './db/accountScope.js';
import { sync } from './routes/sync.js';
import { passwordAuth } from './routes/passwordAuth.js';

const app = new Hono<AppEnv>();

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

// ---------------------------------------------------------------------------
// Password-auth routes (the 2026-06-17 pivot) — username+password (+optional TOTP), recovery-phrase
// reset, durable httpOnly-refresh-cookie sessions. The retired signed-challenge auth (devices /
// challenges / signed register+session) has been DELETED — this is the sole auth surface.
// ---------------------------------------------------------------------------

app.route('/api/auth', passwordAuth);

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
    // #58: an uncategorized note (notebookId null) scopes to the workspace (account), not a notebook.
    resource: (req): Resource => (req.notebookId ? { kind: 'notebook', id: req.notebookId } : { kind: 'workspace' }),
    handle: async (req, c, principal) => {
      const db = d1Adapter(c.env.DB);
      const now = new Date().toISOString();
      // Stamp the owning account server-side from the principal — never a body field (F2).
      const accountId = stampAccountId(principal);
      const entry = {
        id: req.id,
        notebookId: req.notebookId,
        baseVersion: 0 as const,
        draft: { title: req.title, properties: req.properties, body: req.body },
      };
      const outcome = await insertNote(db, entry, accountId, now);
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
    handle: async (req, c, principal) => {
      const db = d1Adapter(c.env.DB);
      // Account-scoped read: a note owned by another account returns null → 404, indistinguishable
      // from not-found (no cross-account existence oracle).
      const row = await getNoteForAccount(db, callerAccountId(principal), req.id);
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
    handle: async (req, c, principal) => {
      const db = d1Adapter(c.env.DB);
      const now = new Date().toISOString();
      const accountId = callerAccountId(principal);

      // Pre-fetch the caller's own note — scoped by account so a cross-account id yields 404, and
      // gives patchNote the notebookId it needs for the CAS.
      const lookup = await getNoteForAccount(db, accountId, req.id);
      if (!lookup) return apiError(c, 404, 'not_found', 'note not found');

      const patch: { title?: string; properties?: string; body?: string } = {};
      if (req.patch.title !== undefined) patch.title = req.patch.title;
      if (req.patch.properties !== undefined) patch.properties = JSON.stringify(req.patch.properties);
      if (req.patch.body !== undefined) patch.body = JSON.stringify(req.patch.body);

      const outcome = await patchNote(db, req.id, lookup.notebookId, accountId, patch, req.expectedVersion, now);
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
    handle: async (req, c, principal) => {
      const db = d1Adapter(c.env.DB);
      const now = new Date().toISOString();
      const accountId = callerAccountId(principal);

      // Include tombstones (idempotent delete) but stay account-scoped — a cross-account id is 404.
      const lookup = await getNoteForAccountIncludingDeleted(db, accountId, req.id);
      if (!lookup) return apiError(c, 404, 'not_found', 'note not found');

      const outcome = await deleteNote(db, req.id, lookup.notebookId, accountId, undefined, now);
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
    handle: async (req, c, principal) => {
      const db = d1Adapter(c.env.DB);
      // Account-scoped: a text-only search returns ONLY the caller's notes (this was the original
      // cross-account disclosure — an unscoped `title LIKE` exposed every account's content).
      const rows = await searchNotes(db, req.notebookId, callerAccountId(principal), req.text);
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
    handle: async (req, c, principal) => {
      const db = d1Adapter(c.env.DB);
      const now = new Date().toISOString();
      const accountId = callerAccountId(principal);

      const rawRow = await getNoteForAccount(db, accountId, req.noteId);
      if (!rawRow) return apiError(c, 404, 'not_found', 'note not found');

      const currentBody = JSON.parse(rawRow.body) as unknown[];
      const newBody = [...currentBody, req.block];

      const outcome = await patchNote(
        db, req.noteId, rawRow.notebookId, accountId,
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
    handle: async (req, c, principal) => {
      const db = d1Adapter(c.env.DB);
      const now = new Date().toISOString();
      const accountId = callerAccountId(principal);

      const rawRow = await getNoteForAccount(db, accountId, req.noteId);
      if (!rawRow) return apiError(c, 404, 'not_found', 'note not found');

      const currentProps = JSON.parse(rawRow.properties) as Record<string, unknown>;
      const newProps = { ...currentProps, [req.key]: req.value };

      const outcome = await patchNote(
        db, req.noteId, rawRow.notebookId, accountId,
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
