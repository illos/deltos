import { z } from 'zod';
import { NoteIdSchema, NotebookIdSchema } from '../spine/ids.js';

/**
 * Resource-picker data for the SEPARATE OAuth consent surface (ROAD-0011 P1 §1.3). That surface has NO
 * Dexie and NO app shell, so the consent screen's resource picker cannot read notebooks/notes from the
 * local store the way the in-app Settings picker does — it fetches them from the server instead.
 *
 * `GET /api/account/pickables?q=` returns the account's notebooks (the bounded LIST-select set) plus, when
 * `q` is present, the server-searched note matches (the SEARCH-select set — search IS the picker). Note
 * search here is the SERVER engine (D1/FTS via `searchNotes`), NOT the client fuzzy engine — the two-engines
 * -by-consumer split is deliberate (the in-app picker uses `lib/search.ts`; this surface uses D1). Owner-
 * authed + account-scoped at the route; only non-secret id/name/title metadata crosses.
 */

/** One notebook the owner can scope a grant to — id + display name (the LIST-select rows). */
export const PickableNotebookSchema = z.object({
  id: NotebookIdSchema,
  name: z.string(),
});
export type PickableNotebook = z.infer<typeof PickableNotebookSchema>;

/** One note match for the SEARCH-select — id + title (+ its notebook, or null when uncategorized). */
export const PickableNoteSchema = z.object({
  id: NoteIdSchema,
  title: z.string(),
  notebookId: NotebookIdSchema.nullable(),
});
export type PickableNote = z.infer<typeof PickableNoteSchema>;

/**
 * The pickables response. `notebooks` is the full account list (LIST select); `notes` is the server-search
 * result for `q` (empty when no query was given — search is the note picker). Both are capped small at the
 * route (notebooks are a bounded set; notes ride `searchNotes`'s LIMIT 50).
 */
export const PickablesResponseSchema = z.object({
  notebooks: z.array(PickableNotebookSchema),
  notes: z.array(PickableNoteSchema),
});
export type PickablesResponse = z.infer<typeof PickablesResponseSchema>;
