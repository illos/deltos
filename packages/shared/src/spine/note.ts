import { z } from 'zod';
import { NoteIdentitySchema } from './identity.js';
import { PropertyBagSchema } from './property.js';
import { BlockBodySchema } from './block.js';

/**
 * A note is simultaneously a *record* and a *document* — that duality is the entire spine.
 * The three layers are composed here and nowhere else:
 *
 *   1. identity & metadata  (system-owned, fixed shape)
 *   2. properties           (loose typed record)
 *   3. body                 (ordered, nestable block tree)
 */
export const NoteSchema = NoteIdentitySchema.extend({
  properties: PropertyBagSchema,
  body: BlockBodySchema,
});
export type Note = z.infer<typeof NoteSchema>;

/**
 * The client-authored slice of a note. The server owns `createdAt` / `updatedAt` / `version`
 * and the client owns `syncStatus`, so a create/replace payload carries only what the author
 * supplies — including the client-generated `id`, which is stable from creation.
 */
export const NoteDraftSchema = NoteSchema.pick({
  id: true,
  notebookId: true,
  title: true,
  properties: true,
  body: true,
});
export type NoteDraft = z.infer<typeof NoteDraftSchema>;

/**
 * A compact projection for list/search results — enough to render a row and address the note,
 * without shipping the full body.
 */
export const NoteSummarySchema = NoteSchema.pick({
  id: true,
  notebookId: true,
  title: true,
  updatedAt: true,
  syncStatus: true,
});
export type NoteSummary = z.infer<typeof NoteSummarySchema>;
