import { z } from 'zod';

/**
 * Account-scoped user settings (owner-authed). Currently just the NOTE ROUTING GUIDE — a freeform text
 * blob the owner edits in Settings that tells the MCP agent where to file saved notes. Freeform ON PURPOSE
 * (the user writes it naturally; the assistant interprets it) — no rigid schema, no server-side processing.
 *
 * The guide is surfaced to the agent via the MCP `list_notebooks` response (`routingGuide`), so the agent
 * gets notebooks + filing rules in one round trip. NULL = unset → the agent asks, else files under All
 * Notes (uncategorized). The single control here is the ~8KB length cap (fail-closed at the boundary).
 */

/** Soft size cap for the routing guide (plain text / markdown). ~8KB. */
export const ROUTING_GUIDE_MAX = 8192;

/** GET/PUT body + response for the note routing guide. `null` clears / means unset. */
export const RoutingGuideSchema = z.object({
  routingGuide: z.string().max(ROUTING_GUIDE_MAX).nullable(),
});
export type RoutingGuide = z.infer<typeof RoutingGuideSchema>;
