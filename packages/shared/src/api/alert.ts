import { z } from 'zod';

/**
 * ALERT / notification model (docs/design/alert-banner-system.md §3) — the single, extensible, schema-first
 * data shape a GENERIC in-app alert surface renders. ONE surface, many producers: server producers (agent
 * bulk-write approval, a future storage warning) ride the sync-pull `alerts` array (api/sync.ts); local
 * producers push straight into the client store. This module is the SOURCE OF TRUTH — the TS types are
 * DERIVED from the zod schemas, never hand-written (schema-first).
 *
 * RESIDENCY: `@deltos/shared` — it crosses the sync HTTP boundary, so BOTH the worker (which computes the
 * projection) and the client (which renders it) reference exactly this shape, byte-for-byte.
 *
 * BOUNDARY DISCIPLINE: `AlertSchema` is NOT `.strict()` — it rides the pull RESPONSE, which the client
 * type-casts rather than `.strict()`-parses (syncEngine.ts). Leaving it open (defaults fill absent optional
 * fields) makes a future field forward-compatible and, critically, makes an unknown/extra field HARMLESS —
 * an alert can never 400 a sync batch. The client→server action REQUEST (AlertActionRequestSchema) IS
 * `.strict()` — that's a hard client write, validated at the boundary.
 */

/** Alert urgency — drives the banner tint + the severity-desc sort (§5.2). */
export const AlertSeveritySchema = z.enum(['info', 'warning', 'critical']);
export type AlertSeverity = z.infer<typeof AlertSeveritySchema>;

/**
 * One actionable choice on an alert (e.g. Approve / Deny). `id` is the intent the client echoes back to the
 * generic action endpoint (`POST /api/alerts/:id/action` — §6.4); `style` is a presentation hint. Passive
 * alerts carry NO actions (`actions: []`).
 */
export const AlertActionSchema = z.object({
  id: z.string().min(1), // 'approve' | 'deny' | …
  label: z.string().min(1), // 'Approve'
  style: z.enum(['primary', 'danger', 'neutral']).default('neutral'),
});
export type AlertAction = z.infer<typeof AlertActionSchema>;

/**
 * The single extensible alert shape (§3.1). `kind` is the discriminator that routes rendering (declared in
 * {@link ALERT_KINDS}); `actions`/`targetKind`/`targetId` are the ACTIONABLE extension — a passive alert
 * leaves them empty/null and renders as a warning strip, an actionable alert carries the choices + the
 * opaque `targetId` the action route needs (the client never interprets it, just echoes it).
 */
export const AlertSchema = z.object({
  id: z.string().min(1), // stable id (server row id, or a client-minted uuid); de-dupes across pulls
  kind: z.string().min(1), // discriminator → declared in ALERT_KINDS (below)
  severity: AlertSeveritySchema,
  source: z.enum(['server', 'client']), // provenance (drives store aggregation + dismiss routing)
  title: z.string().min(1),
  message: z.string(), // human copy ("This agent wants to make ~430 writes: …")
  createdAt: z.number().int().nonnegative(), // ms epoch
  dismissible: z.boolean().default(true),
  expiresAt: z.number().int().nonnegative().nullable().default(null), // optional TTL; null = sticky
  actions: z.array(AlertActionSchema).default([]),
  targetKind: z.string().nullable().default(null), // 'writeApproval' | 'storage' | … | null for passive
  targetId: z.string().nullable().default(null),
});
export type Alert = z.infer<typeof AlertSchema>;

/**
 * The generic action REQUEST body — `POST /api/alerts/:id/action` (§6.4). STRICT: it's a client→server
 * write, validated hard at the boundary. `actionId` is one of the alert's declared action ids; the server
 * dispatches on the row's `targetKind` (never a body field), so the account-scoped BOLA check is inherited.
 */
export const AlertActionRequestSchema = z.object({
  actionId: z.string().min(1),
}).strict();
export type AlertActionRequest = z.infer<typeof AlertActionRequestSchema>;

/**
 * A DECLARED alert kind (§3.2) — mirrors the `PLUGIN_AGENT_TOOLS` aggregate-registry seam (mcp/agentTools.ts):
 * adding a new alert type is ONE entry here, never surgery on the banner host. `glyph` is a declarative accent
 * hint the host maps to an existing icon; `targetKind` (actionable kinds only) names the server handler the
 * kind's actions dispatch to (the worker keeps a parallel `ALERT_ACTION_HANDLERS` map keyed on it).
 */
export interface AlertKindDef {
  kind: string; // matches Alert.kind
  glyph: 'agent' | 'storage' | 'info' | 'warning';
  targetKind?: string; // 'writeApproval' | … ; omitted for passive kinds
}

export const ALERT_KINDS: readonly AlertKindDef[] = [
  // Consumer #1 (actionable): an agent asks to lift its daily write cap; the human Approves/Denies in-app.
  { kind: 'agent.writeApproval', glyph: 'agent', targetKind: 'writeApproval' },
  // Consumer #2 (passive, DESIGNED-FOR — the producer is NOT built yet, §7): a storage-almost-full warning.
  // Its presence here proves a new kind is a declaration: the client can render it the day the producer lands.
  { kind: 'storage.quota', glyph: 'storage' },
];

/** Look up a declared alert kind (the client for presentation, the worker for action dispatch). */
export function findAlertKind(kind: string): AlertKindDef | undefined {
  return ALERT_KINDS.find((k) => k.kind === kind);
}
