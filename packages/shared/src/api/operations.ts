import { z } from 'zod';
import { NoteIdSchema, NotebookIdSchema, BlockIdSchema } from '../spine/ids.js';
import { VersionSchema } from '../spine/identity.js';
import { BlockSchema } from '../spine/block.js';
import { PropertyValueSchema } from '../spine/property.js';
import { NoteSchema, NoteDraftSchema, NoteSummarySchema } from '../spine/note.js';
import { OpSchema } from './grant.js';
import type { Op } from './grant.js';

/**
 * Optimistic-concurrency precondition shared by every mutating request: the version the caller
 * believes it is editing. Optional, so a simple "last-write-from-this-client" caller need not
 * supply it — but PRESENT in the frozen contract so the server can enforce the atomic
 * compare-and-swap (`UPDATE … WHERE version = expectedVersion`) on the REST write path, exactly
 * as the S2 sync flush does. When omitted, the server applies its own default reconciliation;
 * when supplied, a mismatch forks rather than silently clobbering (no lost updates).
 */
export const ExpectedVersionSchema = VersionSchema;

/**
 * The API *is* the product: every surface (PWA, MCP agent, Shortcut) is a client of these
 * operations and none bypass them. Each op's request/response shapes derive from the spine
 * schemas — there is one definition of a note, reused — and each maps to one route whose `op`
 * is the scope checked at the `can()` chokepoint.
 *
 * Phase 0 ships the *contract*: schemas, route signatures, and stub handlers. Real persistence
 * and sync arrive in Phase 1 against these exact shapes.
 */

// ---------------------------------------------------------------------------
// Request shapes
// ---------------------------------------------------------------------------

/** Address a single note. */
export const NoteRefSchema = z.object({ id: NoteIdSchema });
export type NoteRef = z.infer<typeof NoteRefSchema>;

/** Create (or client-replace) a note from its author-supplied slice. */
export const CreateNoteRequestSchema = NoteDraftSchema;
export type CreateNoteRequest = z.infer<typeof CreateNoteRequestSchema>;

/**
 * Partial update. A note never changes id or notebook via update (that would be transport, a
 * separate op), so the patch covers only the author-owned fields.
 */
export const UpdateNoteRequestSchema = z.object({
  id: NoteIdSchema,
  patch: NoteDraftSchema.omit({ id: true, notebookId: true }).partial(),
  expectedVersion: ExpectedVersionSchema.optional(),
});
export type UpdateNoteRequest = z.infer<typeof UpdateNoteRequestSchema>;

/** Append a block, optionally nested under an existing block; else appended at top level. */
export const AppendBlockRequestSchema = z.object({
  noteId: NoteIdSchema,
  parentBlockId: BlockIdSchema.optional(),
  block: BlockSchema,
  expectedVersion: ExpectedVersionSchema.optional(),
});
export type AppendBlockRequest = z.infer<typeof AppendBlockRequestSchema>;

/** Set one property key to a typed value (idempotent). */
export const SetPropertyRequestSchema = z.object({
  noteId: NoteIdSchema,
  key: z.string().min(1),
  value: PropertyValueSchema,
  expectedVersion: ExpectedVersionSchema.optional(),
});
export type SetPropertyRequest = z.infer<typeof SetPropertyRequestSchema>;

/** One equality facet over a property key — mirrors how search treats properties as facets. */
export const SearchFilterSchema = z.object({
  key: z.string().min(1),
  value: PropertyValueSchema,
});
export type SearchFilter = z.infer<typeof SearchFilterSchema>;

/**
 * Search runs over title + indexable properties + each block's `searchText()`. A query must
 * narrow by at least one of full-text, notebook, or a property facet — an unbounded search is
 * rejected at the boundary rather than scanning everything.
 */
export const SearchQuerySchema = z
  .object({
    text: z.string().optional(),
    notebookId: NotebookIdSchema.optional(),
    filters: z.array(SearchFilterSchema).optional(),
  })
  .refine(
    (q) => q.text !== undefined || q.notebookId !== undefined || (q.filters?.length ?? 0) > 0,
    { message: 'search requires at least one of: text, notebookId, or a property filter' },
  );
export type SearchQuery = z.infer<typeof SearchQuerySchema>;

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

/** Mutating ops return the full, server-reconciled note. */
export const NoteResponseSchema = NoteSchema;
export type NoteResponse = z.infer<typeof NoteResponseSchema>;

export const DeleteNoteResponseSchema = z.object({
  id: NoteIdSchema,
  deleted: z.literal(true),
});
export type DeleteNoteResponse = z.infer<typeof DeleteNoteResponseSchema>;

export const SearchResultsSchema = z.object({
  results: z.array(NoteSummarySchema),
});
export type SearchResults = z.infer<typeof SearchResultsSchema>;

// ---------------------------------------------------------------------------
// Route table — the single source of truth for method/path/scope per operation
// ---------------------------------------------------------------------------

export const HTTP_METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface ApiRoute {
  readonly method: HttpMethod;
  readonly path: string;
  /** The scope checked at the `can()` chokepoint before the handler runs. */
  readonly op: Op;
}

export type OperationKey =
  | 'note.create'
  | 'note.get'
  | 'note.update'
  | 'note.delete'
  | 'note.search'
  | 'block.append'
  | 'property.set';

export const API_ROUTES = {
  'note.create': { method: 'POST', path: '/api/notes', op: 'create' },
  'note.get': { method: 'GET', path: '/api/notes/:id', op: 'read' },
  'note.update': { method: 'PATCH', path: '/api/notes/:id', op: 'write' },
  'note.delete': { method: 'DELETE', path: '/api/notes/:id', op: 'delete' },
  'note.search': { method: 'GET', path: '/api/search', op: 'search' },
  'block.append': { method: 'POST', path: '/api/notes/:id/blocks', op: 'write' },
  'property.set': { method: 'PUT', path: '/api/notes/:id/properties/:key', op: 'write' },
} as const satisfies Record<OperationKey, ApiRoute>;

/** Paired request/response schemas per operation — what each handler validates in and out. */
export const OPERATION_SCHEMAS = {
  'note.create': { request: CreateNoteRequestSchema, response: NoteResponseSchema },
  'note.get': { request: NoteRefSchema, response: NoteResponseSchema },
  'note.update': { request: UpdateNoteRequestSchema, response: NoteResponseSchema },
  'note.delete': { request: NoteRefSchema, response: DeleteNoteResponseSchema },
  'note.search': { request: SearchQuerySchema, response: SearchResultsSchema },
  'block.append': { request: AppendBlockRequestSchema, response: NoteResponseSchema },
  'property.set': { request: SetPropertyRequestSchema, response: NoteResponseSchema },
} as const satisfies Record<OperationKey, { request: z.ZodTypeAny; response: z.ZodTypeAny }>;

/** Validate that an arbitrary string is one of the enumerated ops (handy at the worker edge). */
export const isOp = (value: string): value is Op => OpSchema.safeParse(value).success;
