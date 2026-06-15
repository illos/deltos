import { z } from 'zod';

/**
 * Identifiers are client-generated UUIDs, stable from the moment of creation — this is
 * what makes every note (and block) addressable for sync, share URLs, relations, and
 * agents without a server round-trip. We brand each id kind so a `NotebookId` can never be
 * passed where a `NoteId` is expected; on the wire and in storage they are plain strings.
 */

export const NoteIdSchema = z.string().uuid().brand<'NoteId'>();
export type NoteId = z.infer<typeof NoteIdSchema>;

export const NotebookIdSchema = z.string().uuid().brand<'NotebookId'>();
export type NotebookId = z.infer<typeof NotebookIdSchema>;

export const BlockIdSchema = z.string().uuid().brand<'BlockId'>();
export type BlockId = z.infer<typeof BlockIdSchema>;

/**
 * All instants are ISO-8601 strings (offset permitted). The substrate never stores native
 * `Date` objects: strings survive JSON transport and D1's text storage unchanged, and a
 * monotonic lexical order falls out for free.
 */
export const TimestampSchema = z.string().datetime({ offset: true });
export type Timestamp = z.infer<typeof TimestampSchema>;
