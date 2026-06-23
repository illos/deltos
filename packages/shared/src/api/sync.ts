import { z } from 'zod';
import { NoteIdSchema, NotebookIdSchema, TimestampSchema } from '../spine/ids.js';
import { VersionSchema } from '../spine/identity.js';
import { NoteDraftSchema } from '../spine/note.js';
import { NotebookSchema, NotebookDraftSchema } from '../spine/notebook.js';
import { NoteResponseSchema } from './operations.js';

/**
 * Sync protocol schemas — the internal client↔server contract for the offline-first
 * write buffer (push) and server-authoritative pull stream (PIN-SYNC-1/2/3/4).
 *
 * These are separate from the REST operation schemas because sync is a substrate protocol,
 * not a user-facing CRUD operation. Both sides build against exactly these shapes.
 *
 * BOUNDARY: every entity (note + notebook) is account-scoped — the server derives the accountId
 * from the bearer token and rides ONE per-account `syncSeq` stream (Option B,
 * [[sync-notebookid-per-device-regression]]). notebookId is a per-note organizing tag, NOT a sync
 * or security boundary; notebooks are a first-class synced entity in the SAME stream.
 */

// ---------------------------------------------------------------------------
// Push — client flushes its offline write buffer (notes AND notebooks)
// ---------------------------------------------------------------------------

/**
 * One queued NOTE write to push. `baseVersion` is the CAS precondition:
 *   0  = new note (server INSERTs; conflicts if the id already exists)
 *   N  = update at this version (server CAS on version = N; conflicts if moved)
 *
 * `notebookId` resolution — TRI-STATE (#58 All Notes / nullable notebookId):
 *   - INSERT (baseVersion 0): the note's notebook = `entry.notebookId` if present, else the batch-level
 *     `SyncPushRequest.notebookId`, else NULL (uncategorized → All Notes). Nothing is required anymore —
 *     a note with no notebook is valid (there is no default to fall back to).
 *   - UPDATE (baseVersion N): the move signal is the PRESENCE of `entry.notebookId`:
 *       · OMITTED (undefined)  → no move; the note keeps its current notebook (an ordinary edit).
 *       · explicit `null`      → MOVE to uncategorized (All Notes); no ownership guard (null is valid).
 *       · a notebook id        → MOVE there; server ownership-guards the target (gate #19/#23, #25 CAS).
 *     A note whose current notebook no longer resolves to a live owned notebook is re-homed to NULL
 *     (uncategorized), never a default. Server-stamped on the CAS path, isolation-safe (accountId is the
 *     boundary; notebookId is an organizing tag).
 * Trash (Fork P) needs no wire signal — `sys:trashedAt` rides the property bag.
 */
export const SyncPushEntrySchema = z.object({
  id: NoteIdSchema,
  // Tri-state: undefined = no move, null = move-to-uncategorized, id = move-to-that-notebook.
  notebookId: NotebookIdSchema.nullable().optional(),
  draft: NoteDraftSchema.omit({ id: true, notebookId: true }),
  baseVersion: VersionSchema,
});
export type SyncPushEntry = z.infer<typeof SyncPushEntrySchema>;

/**
 * One queued NOTEBOOK write to push. `baseVersion`: 0 = create, N = mutate at version N.
 *  - `draft` present, `delete` absent → create (baseVersion 0) or rename/retitle (baseVersion N).
 *  - `delete: true` → tombstone the notebook; its live notes are moved to Trash server-side
 *    (`sys:trashedAt`). Every notebook is deletable — there is no stored default (#58/#61).
 * A client creates/deletes any owned notebook; the server CAS-guards the operation.
 */
export const NotebookPushEntrySchema = z
  .object({
    id: NotebookIdSchema,
    baseVersion: VersionSchema,
    draft: NotebookDraftSchema.optional(),
    delete: z.literal(true).optional(),
  })
  .refine((e) => e.delete === true || e.draft !== undefined, {
    message: 'a notebook entry must carry a draft (create/rename) or delete:true',
  });
export type NotebookPushEntry = z.infer<typeof NotebookPushEntrySchema>;

/**
 * One queued CUSTOM-DICTIONARY write to push (§5.2). The dictionary is a per-account SET of words with
 * SET SEMANTICS → conflict-free: there is no CAS/version (unlike notes/notebooks). Identity is the word
 * itself (scoped to the account server-side); `delete` distinguishes add from remove:
 *   - `delete` absent → ADD the word (server upserts; re-adding is idempotent + un-tombstones).
 *   - `delete: true`  → REMOVE the word (server tombstones so the removal syncs to other devices).
 * The word is the normalized form the client stores (trim + lowercase); the server treats it opaquely.
 */
export const DictionaryWordValueSchema = z.string().trim().min(1).max(100);
export const DictionaryPushEntrySchema = z.object({
  word: DictionaryWordValueSchema,
  delete: z.literal(true).optional(),
});
export type DictionaryPushEntry = z.infer<typeof DictionaryPushEntrySchema>;

/**
 * Push request — notes, notebooks, and/or dictionary words in one batch. `notebookId` is the OPTIONAL
 * batch-level default notebook for note INSERTS that omit their own `entry.notebookId` (the "current
 * notebook"); it is never applied to updates. At least one entry across the three arrays is required.
 */
export const SyncPushRequestSchema = z
  .object({
    notebookId: NotebookIdSchema.optional(),
    entries: z.array(SyncPushEntrySchema).max(100).default([]),
    notebookEntries: z.array(NotebookPushEntrySchema).max(100).default([]),
    dictionaryEntries: z.array(DictionaryPushEntrySchema).max(100).default([]),
  })
  .refine((r) => r.entries.length + r.notebookEntries.length + r.dictionaryEntries.length >= 1, {
    message: 'push must carry at least one note, notebook, or dictionary entry',
  });
export type SyncPushRequest = z.infer<typeof SyncPushRequestSchema>;

/**
 * Per-NOTE result. `accepted` = the CAS committed; `conflict` = the server row moved (or was deleted)
 * under us — the full server state is returned so the client can fork.
 */
export const SyncPushResultSchema = z.discriminatedUnion('outcome', [
  z.object({
    id: NoteIdSchema,
    outcome: z.literal('accepted'),
    version: VersionSchema,
    syncSeq: z.number().int().positive(),
  }),
  z.object({
    id: NoteIdSchema,
    outcome: z.literal('conflict'),
    /** Full current server state — null when the note was deleted (tombstone conflict). */
    serverNote: NoteResponseSchema.nullable(),
  }),
]);
export type SyncPushResult = z.infer<typeof SyncPushResultSchema>;

/** Per-NOTEBOOK result. Mirrors the note result; conflict carries the current server notebook (or null). */
export const NotebookPushResultSchema = z.discriminatedUnion('outcome', [
  z.object({
    id: NotebookIdSchema,
    outcome: z.literal('accepted'),
    version: VersionSchema,
    syncSeq: z.number().int().positive(),
  }),
  z.object({
    id: NotebookIdSchema,
    outcome: z.literal('conflict'),
    /** Current server notebook — null when it does not exist for this account. */
    serverNotebook: NotebookSchema.extend({ version: VersionSchema }).nullable(),
    /** Set when the conflict is because the target is the undeletable default (delete rejected). */
    reason: z.enum(['stale', 'default_undeletable']).optional(),
  }),
]);
export type NotebookPushResult = z.infer<typeof NotebookPushResultSchema>;

/**
 * Per-DICTIONARY-WORD result (§5.2). Set semantics are conflict-free, so the only outcome is `accepted`
 * — there is no conflict variant. `syncSeq` is the word's new stream position (the client confirms its
 * queue entry against it). Keyed by `word` (the account-scoped identity).
 */
export const DictionaryPushResultSchema = z.object({
  word: DictionaryWordValueSchema,
  outcome: z.literal('accepted'),
  syncSeq: z.number().int().positive(),
});
export type DictionaryPushResult = z.infer<typeof DictionaryPushResultSchema>;

export const SyncPushResponseSchema = z.object({
  results: z.array(SyncPushResultSchema),
  notebookResults: z.array(NotebookPushResultSchema).default([]),
  dictionaryResults: z.array(DictionaryPushResultSchema).default([]),
});
export type SyncPushResponse = z.infer<typeof SyncPushResponseSchema>;

// ---------------------------------------------------------------------------
// Pull — client fetches server updates since its last cursor (notes AND notebooks)
// ---------------------------------------------------------------------------

/**
 * A server note in the pull stream. Extends the core NoteResponse with `deletedAt`
 * (tombstone marker) so the client can apply PIN-SYNC-3 (delete-vs-edit resurrection)
 * and clear locally-deleted notes.
 */
export const SyncNoteSchema = NoteResponseSchema.extend({
  deletedAt: TimestampSchema.nullable(),
  syncSeq: z.number().int().nonnegative(),
});
export type SyncNote = z.infer<typeof SyncNoteSchema>;

/**
 * A server notebook in the pull stream. `deletedAt` is the tombstone (a deleted notebook is streamed
 * so the client can drop it locally + reconcile a dangling "current notebook" pointer).
 */
export const SyncNotebookSchema = NotebookSchema.extend({
  version: VersionSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  deletedAt: TimestampSchema.nullable(),
  syncSeq: z.number().int().nonnegative(),
});
export type SyncNotebook = z.infer<typeof SyncNotebookSchema>;

/**
 * Pull request. The sync boundary is the ACCOUNT (Option B, 2026-06-18): the server scopes the pull
 * stream to the caller's accountId (derived from the bearer token), NOT to a notebookId. `cursor` is
 * the caller's per-ACCOUNT stream position; `cursor = 0` triggers a full account sync. The server
 * returns every NOTE and NOTEBOOK the account owns with `syncSeq > cursor`, ordered ascending over the
 * unified stream.
 */
export const SyncPullRequestSchema = z.object({
  cursor: z.number().int().nonnegative(),
});
export type SyncPullRequest = z.infer<typeof SyncPullRequestSchema>;

/**
 * A server custom-dictionary word in the pull stream (§5.2). `deletedAt` is the tombstone (a removed
 * word is streamed so the client drops it locally). Rides the same per-account syncSeq stream.
 */
export const SyncDictionaryWordSchema = z.object({
  word: DictionaryWordValueSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  deletedAt: TimestampSchema.nullable(),
  syncSeq: z.number().int().nonnegative(),
});
export type SyncDictionaryWord = z.infer<typeof SyncDictionaryWordSchema>;

export const SyncPullResponseSchema = z.object({
  notes: z.array(SyncNoteSchema),
  notebooks: z.array(SyncNotebookSchema).default([]),
  dictionaryWords: z.array(SyncDictionaryWordSchema).default([]),
  /** The highest syncSeq in this batch (across notes, notebooks AND dictionary); use as the next cursor. */
  nextCursor: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});
export type SyncPullResponse = z.infer<typeof SyncPullResponseSchema>;
