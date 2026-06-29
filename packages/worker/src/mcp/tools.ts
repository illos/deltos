import { z } from 'zod';
import { NoteIdSchema, NotebookIdSchema, type Op, type Resource } from '@deltos/shared';
import type { DbAdapter } from '../db/schema.js';
import { searchNotes } from '../db/mutate.js';
import { getNoteForAccount } from '../db/accountScope.js';
import { listNotebooksForAccount } from '../db/notebooks.js';
import { noteRowToResponse, noteRowToSummary } from '../present.js';
import { type McpToolResult, toolOk, toolError } from './protocol.js';

/**
 * The deltos read-only MCP tool surface (llm-mcp-integration.md §6) — a THIN adapter. Every tool reuses
 * the SAME account-scoped data-layer reader the PWA's REST route uses (`searchNotes`, `getNoteForAccount`,
 * `listNotebooksForAccount`) and emits the SAME wire shape (`present.ts`); no tool hand-writes a query, so
 * account isolation (`WHERE accountId = ?`) is inherited by construction. The route additionally gates each
 * call through the same `can(principal, op, resource)` chokepoint before `execute` runs.
 *
 * v1 is READ-ONLY: no create/append/set tools exist (§9 Phase 1 de-risk). The agent guide below + the
 * per-tool descriptions are RESIDENT ON THE SERVER (§4 §6.1) — author them richly; they never touch the
 * client bundle and the offline case can't arise.
 */

export interface McpToolContext {
  db: DbAdapter;
  /** The server-derived owning account (= principal.id). NEVER a client-asserted value. */
  accountId: string;
}

export interface McpTool<A> {
  name: string;
  description: string;
  /** JSON Schema advertised in `tools/list` (hand-authored to mirror `argsSchema`). */
  inputSchema: Record<string, unknown>;
  /** Zod validation of the call `arguments` at the boundary (schema-first). */
  argsSchema: z.ZodType<A>;
  /** The scope op checked at the `can()` chokepoint. */
  op: Op;
  /** The resource the call addresses — drives the `can()` resource-coverage + ownership belt. */
  resource: (args: A) => Resource;
  execute: (args: A, ctx: McpToolContext) => Promise<McpToolResult>;
}

/** Infer the arg type from the zod schema (output type, incl. brands) for full internal type-checking,
 *  then erase to McpTool<unknown> for the heterogeneous registry. */
function defineTool<S extends z.ZodTypeAny>(tool: {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  argsSchema: S;
  op: Op;
  resource: (args: z.infer<S>) => Resource;
  execute: (args: z.infer<S>, ctx: McpToolContext) => Promise<McpToolResult>;
}): McpTool<unknown> {
  return tool as unknown as McpTool<unknown>;
}

export const MCP_TOOLS: ReadonlyArray<McpTool<unknown>> = [
  defineTool({
    name: 'search_notes',
    description:
      'Find the user\'s notes by free text. Searches note titles (full-text search over body + ' +
      'properties is rolling out). Returns lightweight summaries (id, title, notebookId, updatedAt) ' +
      'ordered most-recently-edited first — NOT the note bodies. Typical flow: search_notes to locate ' +
      'the right note(s), then get_note(id) to read the full content. Prefer a few specific keywords ' +
      'over long phrases. Optionally pass a notebookId (from list_notebooks) to scope the search to one ' +
      'notebook; omit it to search everything the user owns.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keywords (matched against note titles).' },
        notebookId: {
          type: 'string',
          description: 'Optional notebook id (from list_notebooks) to scope the search to one notebook.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    argsSchema: z
      .object({ query: z.string().min(1), notebookId: NotebookIdSchema.optional() })
      .strict(),
    op: 'search',
    resource: (a): Resource =>
      a.notebookId ? { kind: 'notebook', id: a.notebookId } : { kind: 'workspace' },
    execute: async (a, { db, accountId }) => {
      const rows = await searchNotes(db, a.notebookId, accountId, a.query);
      return toolOk({ results: rows.map(noteRowToSummary) });
    },
  }),

  defineTool({
    name: 'get_note',
    description:
      'Read one note in full by its id (the id comes from search_notes or list_notebooks). Returns the ' +
      'title, the property bag, and the full body. The body is an ordered array of typed blocks (the ' +
      '"spine"): each block has a "type" (paragraph, heading, list item, etc.) and its content; an ' +
      'unfamiliar block type still carries readable text — summarise around it rather than failing. ' +
      'Properties is an open key→value bag of note metadata (tags, status, dates, and app system keys ' +
      'like sys:trashedAt). If the id is unknown or belongs to someone else, the tool reports not found.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The note id (a UUID).' } },
      required: ['id'],
      additionalProperties: false,
    },
    argsSchema: z.object({ id: NoteIdSchema }).strict(),
    op: 'read',
    resource: (a): Resource => ({ kind: 'note', id: a.id }),
    execute: async (a, { db, accountId }) => {
      const row = await getNoteForAccount(db, accountId, a.id);
      if (!row) return toolError(`note not found: ${a.id}`);
      return toolOk(noteRowToResponse(row));
    },
  }),

  defineTool({
    name: 'list_notebooks',
    description:
      'List the user\'s notebooks (their top-level collections), most-recently-touched first. A notebook ' +
      'groups related notes; a note may also be uncategorized (notebookId null) and live only in the ' +
      'synthetic "All Notes" view — so absence of a notebook is normal, not an error. Use this to learn ' +
      'what collections exist and to pick the right notebookId for a scoped search: rank softly by name ' +
      'match to the user\'s intent, then by recency. Takes no arguments.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    argsSchema: z.object({}).strict(),
    op: 'read',
    resource: (): Resource => ({ kind: 'workspace' }),
    execute: async (_a, { db, accountId }) => {
      const rows = await listNotebooksForAccount(db, accountId);
      return toolOk({
        notebooks: rows.map((nb) => ({
          id: nb.id,
          name: nb.name,
          defaultCollectionView: nb.defaultCollectionView,
          createdAt: nb.createdAt,
          updatedAt: nb.updatedAt,
        })),
      });
    },
  }),
];

export function findTool(name: unknown): McpTool<unknown> | undefined {
  return typeof name === 'string' ? MCP_TOOLS.find((t) => t.name === name) : undefined;
}

/** The `tools/list` payload — the advertised name/description/inputSchema, no handlers. */
export function toolListPayload(): { tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> } {
  return {
    tools: MCP_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  };
}

// ---------------------------------------------------------------------------
// Server identity + the agent guide (§6.1) — server-resident, returned on `initialize`.
// ---------------------------------------------------------------------------

export const MCP_SERVER_INFO = {
  name: 'deltos',
  title: 'deltos notes',
  version: '1.0.0',
} as const;

/**
 * The `instructions` string handed to Claude at `initialize` — the magic-vs-mechanical difference (§6.1).
 * It teaches deltos conventions so the model uses the tools well. Backend-resident: free to be rich.
 */
export const MCP_INSTRUCTIONS = [
  'deltos is the user\'s personal notes app. You are connected to THEIR account in READ-ONLY mode: you ',
  'can search and read notes and list notebooks, but you cannot create, edit, move, or delete anything ',
  '(no write tools exist in this version). Never claim to have changed a note.',
  '',
  'Model of the data:',
  '- A NOTE has a title, a body, and a property bag. The body is an ordered list of typed blocks (the ',
  '  "spine") — paragraphs, headings, list items, and richer block types; read them in order. Properties ',
  '  is an open key→value bag (tags, status, dates; keys prefixed "sys:" are app internals, e.g. ',
  '  sys:trashedAt marks a note the user trashed — treat trashed notes as deleted unless asked otherwise).',
  '- A NOTEBOOK is a named collection of notes. A note can also be uncategorized (no notebook) and appear ',
  '  only in the synthetic "All Notes" view, so a missing notebook is normal.',
  '',
  'How to work:',
  '- To answer a question about the user\'s notes, start with search_notes using a few specific keywords, ',
  '  then get_note(id) on the best hit(s) to read full content. search_notes returns summaries, not bodies.',
  '- To target a collection, call list_notebooks first and pick the notebookId by soft-ranking: best name ',
  '  match to the user\'s intent, then most recent. Pass that notebookId to search_notes to scope it.',
  '- Cite note titles when you summarise. If nothing matches, say so plainly rather than guessing.',
].join('\n');
