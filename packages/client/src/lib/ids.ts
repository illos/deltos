import { NoteIdSchema, BlockIdSchema, NotebookIdSchema, CollectionIdSchema } from '@deltos/shared';
import type { NoteId, BlockId, NotebookId, CollectionId } from '@deltos/shared';

/**
 * Client-side UUID minters. IDs are generated at creation time, never at sync time — this is
 * what makes every note and block addressable before a server round-trip and prevents
 * dup-on-sync when two devices create the same entity offline.
 *
 * Collection MEMBER ids are NOT random — use {@link collectionMemberId} from @deltos/shared
 * (deterministic uuidv5 over collectionId+noteId).
 */
export const newNoteId = (): NoteId => NoteIdSchema.parse(crypto.randomUUID());
export const newBlockId = (): BlockId => BlockIdSchema.parse(crypto.randomUUID());
export const newNotebookId = (): NotebookId => NotebookIdSchema.parse(crypto.randomUUID());
export const newCollectionId = (): CollectionId => CollectionIdSchema.parse(crypto.randomUUID());
