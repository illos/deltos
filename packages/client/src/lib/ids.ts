import { NoteIdSchema, BlockIdSchema, NotebookIdSchema } from '@deltos/shared';
import type { NoteId, BlockId, NotebookId } from '@deltos/shared';

/**
 * Client-side UUID minters. IDs are generated at creation time, never at sync time — this is
 * what makes every note and block addressable before a server round-trip and prevents
 * dup-on-sync when two devices create the same entity offline.
 */
export const newNoteId = (): NoteId => NoteIdSchema.parse(crypto.randomUUID());
export const newBlockId = (): BlockId => BlockIdSchema.parse(crypto.randomUUID());
export const newNotebookId = (): NotebookId => NotebookIdSchema.parse(crypto.randomUUID());
