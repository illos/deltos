import { Hono } from 'hono';
import { z } from 'zod';
import {
  RoutingGuideSchema,
  type PickablesResponse,
  type Resource,
} from '@deltos/shared';
import type { AppEnv } from '../context.js';
import { guard } from '../http.js';
import { d1Adapter } from '../db/schema.js';
import { callerAccountId } from '../db/accountScope.js';
import { getAccountRoutingGuide, setAccountRoutingGuide } from '../db/accountSettings.js';
import { listNotebooksForAccount } from '../db/notebooks.js';
import { searchNotes } from '../db/mutate.js';

/** Resource-picker query — an optional note-search string (`?q=`). Absent/blank ⇒ notebooks-only. */
const PickablesQuerySchema = z.object({ q: z.string().optional() }).strict();

/**
 * Account-scoped user settings (owner-authed). v1 = the NOTE ROUTING GUIDE (freeform text that tells the
 * MCP agent where to file saved notes). Both routes gate `op:'share'` — the owner's session grant carries
 * it, an AGENT token's scope never does, so an agent token 403s here (it can READ the guide via
 * `list_notebooks`, but it can NEVER edit the owner's settings). accountId is ALWAYS the server-derived
 * `principal.id` (BOLA-safe). RESIDENCY: server plumbing — zero client-bundle weight.
 */
export const account = new Hono<AppEnv>();

/** GET /api/account/routing-guide — the owner's note routing guide (or null when unset). */
account.get(
  '/routing-guide',
  guard({
    op: 'share',
    schema: z.object({}).strict(),
    input: () => ({}),
    resource: (): Resource => ({ kind: 'workspace' }),
    handle: async (_req, c, principal) => {
      const db = d1Adapter(c.env.DB);
      const routingGuide = await getAccountRoutingGuide(db, callerAccountId(principal));
      return c.json({ routingGuide });
    },
  }),
);

/**
 * PUT /api/account/routing-guide — set (or clear) the note routing guide. Body { routingGuide: string|null }.
 * An empty / whitespace-only string NORMALIZES to null (clearing the guide), so an emptied textarea unsets
 * it. The ~8KB cap is enforced by `RoutingGuideSchema` at the boundary (a longer body 400s).
 */
account.put(
  '/routing-guide',
  guard({
    op: 'share',
    schema: RoutingGuideSchema,
    input: async (c) => {
      try {
        return await c.req.json();
      } catch {
        return {};
      }
    },
    resource: (): Resource => ({ kind: 'workspace' }),
    handle: async (req, c, principal) => {
      const db = d1Adapter(c.env.DB);
      // Freeform, no server-side processing beyond the empty→null normalization + the schema length cap.
      const trimmed = req.routingGuide?.trim();
      const guide = trimmed && trimmed.length > 0 ? req.routingGuide : null;
      await setAccountRoutingGuide(db, callerAccountId(principal), guide);
      return c.json({ routingGuide: guide });
    },
  }),
);

/**
 * GET /api/account/pickables?q= — the resource-picker data source for the SEPARATE OAuth consent surface
 * (ROAD-0011 P1 §1.3). That surface has no Dexie, so its picker fetches notebooks + note matches from here
 * instead of the local store (the in-app Settings picker reads Dexie directly and never calls this).
 *
 * Returns the account's `notebooks` (the bounded LIST-select set — always) plus `notes` (the SEARCH-select
 * matches for `q`, empty when no query is given — search IS the note picker). Note search reuses the SERVER
 * engine (`searchNotes` → D1/FTS, LIMIT 50), NOT the client fuzzy engine — the two-engines-by-consumer split.
 *
 * `op:'share'` like the sibling account routes: the owner's session grant carries it, an AGENT token's never
 * does, so an agent token 403s (it can't enumerate the owner's notebooks/notes here). accountId is ALWAYS the
 * server-derived `principal.id` — every read is account-scoped + BOLA-safe. RESIDENCY: server plumbing.
 */
account.get(
  '/pickables',
  guard({
    op: 'share',
    schema: PickablesQuerySchema,
    input: (c) => ({ q: c.req.query('q') }),
    resource: (): Resource => ({ kind: 'workspace' }),
    handle: async (req, c, principal) => {
      const db = d1Adapter(c.env.DB);
      const accountId = callerAccountId(principal);

      const notebookRows = await listNotebooksForAccount(db, accountId);
      const notebooks = notebookRows.map((nb) => ({ id: nb.id, name: nb.name }));

      // Notes come from the SEARCH select — only when a query is present (search is the note picker). Reuse
      // the server search engine (account-scoped, trash/liveness-filtered, LIMIT 50); an all-punctuation query
      // sanitizes to zero matches inside searchNotes.
      const query = req.q?.trim();
      const noteRows = query ? await searchNotes(db, undefined, accountId, query) : [];
      const notes = noteRows.map((n) => ({
        id: n.id,
        title: n.title,
        notebookId: (n.notebookId as string | null) ?? null,
      }));

      const body: PickablesResponse = {
        notebooks: notebooks as PickablesResponse['notebooks'],
        notes: notes as PickablesResponse['notes'],
      };
      return c.json(body);
    },
  }),
);
