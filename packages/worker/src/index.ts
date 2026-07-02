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
import { guard, apiError, type AppContext } from './http.js';
import type { AppEnv } from './context.js';
import { d1Adapter } from './db/schema.js';
import { noteRowToResponse } from './present.js';
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
import { sessions } from './routes/sessions.js';
import { transcribe } from './routes/transcribe.js';
import { unfurl } from './routes/unfurl.js';
import { blob } from './routes/blob.js';
import { agentTokens } from './routes/agentTokens.js';
import { auditRoutes } from './routes/audit.js';
import { mcp } from './routes/mcp.js';
import { oauth, oauthWellKnown, oauthConsentSurface } from './routes/oauth.js';
import { createAuthStore } from './db/authStore.js';
import {
  AUDIT_LOG_RETENTION_DAYS,
  USAGE_COUNTER_RETENTION_DAYS,
  OAUTH_CLIENT_RETENTION_DAYS,
  dayBucket,
} from './abusePolicy.js';

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
// Active-sessions surface (Phase 2 — sessions management) — owner-authed list / revoke-one /
// sign-out-others over the durable refresh SESSIONS (logged-in devices). Mounted UNDER /api/auth so it
// rides the auth surface; every route runs the same guard() chokepoint with op 'share', which an agent
// token's read-only scope can never satisfy — so a connected MCP/agent credential can never enumerate or
// revoke the human's sessions. Every store call is BOLA-scoped on the server-derived accountId.
// ---------------------------------------------------------------------------

app.route('/api/auth/sessions', sessions);

// ---------------------------------------------------------------------------
// Account-activity surface (ROAD-0005 P3 — the user-facing audit view). Owner-authed read of the account's
// recent security events from the `auditLog` D1 projection (the live trust surface). op:'share' so agent
// tokens 403 — a connected AI can never read the owner's access history. BOLA-scoped on server accountId.
// ---------------------------------------------------------------------------

app.route('/api/audit', auditRoutes);

// ---------------------------------------------------------------------------
// Voice-to-text TRANSCRIBE route (custom-keyboard spec §6, stage 2) — authenticated Workers AI Whisper.
// Decoupled plumbing: returns the transcript as a first-class artifact (no insert-at-caret coupling).
// ---------------------------------------------------------------------------

app.route('/api/transcribe', transcribe);

// ---------------------------------------------------------------------------
// Rich-embed UNFURL route (rich-embeds spec §2, rung-2) — authenticated server-side link
// metadata fetch. Returns { url, title, description, image, favicon, siteName } parsed from
// og: tags + <title>. KV-cached per URL. SSRF controls + F13 auth guard built in.
// ---------------------------------------------------------------------------

app.route('/api/unfurl', unfurl);

// ---------------------------------------------------------------------------
// BLOB host capability (plugin-support §7, A4 #126) — the first server-enforced plugin host capability.
// Content-addressed file/photo storage in a PRIVATE R2 bucket, behind the authenticated Worker. Upload
// hash-verifies + keys on the SERVER-derived accountId; download is BOLA-safe (own-prefix only) + served
// with safe headers (attachment + nosniff). First consumer: the attachment plugin.
// ---------------------------------------------------------------------------

app.route('/api/plugin/blob', blob);

// ---------------------------------------------------------------------------
// Agent-token surface (llm-mcp-integration.md §5) — owner-authed mint/list/revoke of the long-lived
// READ-ONLY credential a remote MCP connector (Claude) bears. An agent token is just a `grants` row with
// principalKind='agent', non-expiring, scope-clamped read-only, principalId = the owner's accountId. All
// three routes run through the same guard() chokepoint with op 'share', which an agent token's read-only
// scope can never satisfy — so an agent can never mint/list/revoke tokens itself.
// ---------------------------------------------------------------------------

app.route('/api/agent-tokens', agentTokens);

// ---------------------------------------------------------------------------
// Remote MCP server (llm-mcp-integration.md §6) — JSON-RPC 2.0 over a stateless Streamable-HTTP POST,
// READ-ONLY. A thin protocol adapter consumed by claude.ai / Claude Desktop / Claude Code, bearing the
// agent token (§5). Every tool dispatches to the SAME account-scoped data readers + the SAME can()
// chokepoint the PWA uses, so account isolation is inherited; the endpoint is bearer-gated for every
// method. Server-resident (§4): adds zero to the client bundle.
// ---------------------------------------------------------------------------

app.route('/api/mcp', mcp);

// ---------------------------------------------------------------------------
// OAuth 2.1 provider (ROAD-0005 first capability) — deltos as the Authorization Server for its own MCP
// resource. Discovery docs are ROOT-level (/.well-known/*, also in wrangler run_worker_first so the SPA
// shell can't shadow them); the register/authorize/token endpoints are under /api/oauth. The consent SURFACE
// is a SEPARATE standalone app (oauth-consent-surface-separation.md / DEC-0005) served at /oauth/* — the
// worker returns its oauth.html with no-store (oauthConsentSurface), decoupled from the notes SPA/router/SW.
// Server-resident: zero notes-client-bundle cost.
// ---------------------------------------------------------------------------

app.route('/.well-known', oauthWellKnown);
app.route('/api/oauth', oauth);
app.route('/oauth', oauthConsentSurface);

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
      return c.json(noteRowToResponse(outcome.row), 201);
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
      return c.json(noteRowToResponse(row));
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
      return c.json(noteRowToResponse(outcome.row));
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
      return c.json(noteRowToResponse(outcome.row));
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
      return c.json(noteRowToResponse(outcome.row));
    },
  }),
);

// Unknown /api/* paths get a JSON 404, never an HTML page.
app.notFound((c) => apiError(c as AppContext, 404, 'not_found', 'no such API route'));

/**
 * ROAD-0005 P4 (Tier 3) — retention prune for the D1 mirrors. Bounds the user-facing `auditLog` projection
 * and the `usageCounter` daily counters so they stay small + cheap. The append-only AE audit dataset (the
 * forensic truth) is NEVER touched here. Cutoffs come from `abusePolicy.ts`. Errors are swallowed by the
 * scheduled wrapper's `waitUntil` — a failed prune must never be load-bearing.
 */
async function pruneRetention(env: Env): Promise<void> {
  const store = createAuthStore(d1Adapter(env.DB));
  const nowMs = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  await store.pruneAuditLog(new Date(nowMs - AUDIT_LOG_RETENTION_DAYS * dayMs).toISOString());
  await store.pruneUsage(dayBucket(nowMs - USAGE_COUNTER_RETENTION_DAYS * dayMs));
  // OAuth authorization codes (migration 0017): 60s TTL, so reaping everything already-expired-or-consumed
  // as of `nowMs` leaves only the handful of still-live codes. The raw code is unrecoverable regardless.
  await store.pruneOauthCodes(nowMs);
  // OAuth clients: drop stale registrations (no live grant, older than the retention window) — the durable
  // backstop against DCR row-spam (adversarial-review MED-2). A client with a live grant is always kept.
  await store.pruneOauthClients(new Date(nowMs - OAUTH_CLIENT_RETENTION_DAYS * dayMs).toISOString());
}

// The default export carries BOTH entrypoints. We attach `scheduled` to the Hono `app` itself (rather than
// wrapping it in a fresh `{ fetch, scheduled }` object) so the app keeps its `.fetch`/`.request` surface —
// the test harness drives routes via `app.request(...)`, and the runtime reads `.fetch` + `.scheduled` off
// the same object. `app.fetch` is already account-bound by Hono, so `this` resolves correctly.
const worker = app as typeof app & {
  scheduled: (controller: ScheduledController, env: Env, ctx: ExecutionContext) => void;
};
/** Cron entrypoint (wrangler.jsonc `triggers.crons`) — fire-and-forget the retention prune (P4 Tier 3). */
worker.scheduled = (_controller, env, ctx) => {
  ctx.waitUntil(pruneRetention(env));
};

export default worker;

