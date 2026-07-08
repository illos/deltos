import { Hono } from 'hono';
import { z } from 'zod';
import {
  AlertActionRequestSchema,
  type Resource,
  type RequestPrincipal,
} from '@deltos/shared';
import type { AppEnv } from '../context.js';
import { guard, apiError, type AppContext } from '../http.js';
import { createAuthStore, type AuthStore, type WriteApprovalRow } from '../db/authStore.js';
import { d1Adapter } from '../db/schema.js';
import { stampAccountId } from '../db/accountScope.js';
import { audit, credentialRefOf } from '../audit.js';
import { dayBucket } from '../abusePolicy.js';
import { getActiveAlerts } from '../alerts.js';

/**
 * ALERT-ACTION surface (alert-banner-system.md §6.4) — the human's Approve/Deny on an actionable alert, plus
 * a list of the account's pending alerts for the banner. Both run through the SAME `guard()` chokepoint the
 * PWA uses, op `'share'` (owner-only — the human owner holds `share` over their workspace; an agent token,
 * clamped to read/search, can NEVER act, mirroring agentTokens.ts).
 *
 * BOLA: the owning account is ALWAYS the server-derived `stampAccountId(principal)`, never a body field.
 * Every read/mutation filters `WHERE ... accountId = ?`, so one account can never see or act on another's
 * approval — a cross-account id is indistinguishable from not-found (404), no existence oracle.
 *
 * GENERIC ACTION DISPATCH: `POST /api/alerts/:id/action { actionId }` dispatches on the alert's own
 * `targetKind` (read from the owned row, never the body). Today that is `writeApproval`; a new actionable
 * kind adds one handler branch (the `ALERT_ACTION_HANDLERS` seam in the design) with no new route.
 *
 * RESIDENCY: server — pure backend plumbing, zero client-bundle weight.
 */
export const alerts = new Hono<AppEnv>();

/**
 * GET /api/alerts — the account's active alerts (feeds the client banner). Same PROJECTION the sync-pull
 * carries (getActiveAlerts), but token-agnostic (tokenGroupId=null → all of the account's actionable asks),
 * because the human owner sees + acts on EVERY pending approval regardless of which agent token raised it.
 */
alerts.get(
  '/',
  guard({
    op: 'share',
    schema: z.object({}).strict(),
    input: () => ({}),
    resource: (): Resource => ({ kind: 'workspace' }),
    handle: async (_req, c, principal) => {
      const store = createAuthStore(d1Adapter(c.env.DB));
      const accountId = stampAccountId(principal);
      const active = await getActiveAlerts(store, accountId, null, Date.now());
      return c.json({ alerts: active });
    },
  }),
);

/**
 * POST /api/alerts/:id/action — Approve/Deny an actionable alert. Body: { actionId: 'approve' | 'deny' }.
 * Resolves the OWNED alert row (BOLA), dispatches on its `targetKind`, CAS-mutates, and audits the act as a
 * security event (auth surface → projects to the D1 auditLog trust-surface). No step-up: the acting owner is
 * present in-session looking at scale+intent — that IS the control (§6.4).
 */
alerts.post(
  '/:id/action',
  guard({
    op: 'share',
    schema: AlertActionRequestSchema,
    input: async (c) => {
      try { return await c.req.json(); } catch { return undefined; }
    },
    resource: (): Resource => ({ kind: 'workspace' }),
    handle: async (req, c, principal) => {
      const store = createAuthStore(d1Adapter(c.env.DB));
      const accountId = stampAccountId(principal);
      const alertId = c.req.param('id');
      if (!alertId) return apiError(c, 404, 'not_found', 'alert not found');
      const nowMs = Date.now();

      // Resolve the OWNED approval row (BOLA — accountId in the WHERE). A foreign/absent id → 404, no oracle.
      const row = await store.getWriteApprovalForAccount(alertId, accountId, nowMs);
      if (!row) return apiError(c, 404, 'not_found', 'alert not found');

      // Dispatch on the row's own targetKind (the generic action seam). Today only `writeApproval`.
      // (getWriteApprovalForAccount is the only targetKind's reader; a new kind adds its own resolve+branch.)
      return handleWriteApprovalAction(c, store, accountId, row, req.actionId, nowMs, principal);
    },
  }),
);

/**
 * The `writeApproval` action handler (the `ALERT_ACTION_HANDLERS['writeApproval']` binding, §3.2). CAS the
 * owned pending row and audit the act. `approve` grants the requested count for the current UTC day
 * (time-boxed); `deny` closes it. Either transition makes the alert stop projecting on the next pull.
 */
async function handleWriteApprovalAction(
  c: AppContext,
  store: AuthStore,
  accountId: string,
  row: WriteApprovalRow,
  actionId: string,
  nowMs: number,
  principal: RequestPrincipal,
): Promise<Response> {
  // A resolved/expired request can no longer be acted on (idempotent-close). 409 so the client refreshes.
  if (row.status !== 'pending') {
    return apiError(c, 409, 'already_resolved', `this request is already ${row.status}`);
  }

  if (actionId === 'approve') {
    const updated = await store.approveWriteApproval({
      id: row.id,
      accountId,
      windowDayBucket: dayBucket(nowMs), // TIME-BOX: the lift applies to THIS UTC day only
      approvedAt: nowMs,
    });
    // A lost CAS (a concurrent resolve of the same row) → the pending guard matched nothing.
    if (!updated) return apiError(c, 409, 'already_resolved', 'this request is no longer pending');
    await audit(c, {
      surface: 'auth',
      action: 'approval.grant',
      result: 'allow',
      principalKind: principal.kind,
      accountId,
      credentialRef: credentialRefOf(principal),
      resourceKind: 'workspace',
      detail: `writeApproval ${updated.id} +${updated.grantedCount ?? 0}`,
    });
    return c.json({
      id: updated.id,
      status: updated.status,
      grantedCount: updated.grantedCount,
      windowDayBucket: updated.windowDayBucket,
    });
  }

  if (actionId === 'deny') {
    const updated = await store.denyWriteApproval(row.id, accountId);
    if (!updated) return apiError(c, 409, 'already_resolved', 'this request is no longer pending');
    await audit(c, {
      surface: 'auth',
      action: 'approval.deny',
      result: 'allow',
      principalKind: principal.kind,
      accountId,
      credentialRef: credentialRefOf(principal),
      resourceKind: 'workspace',
      detail: `writeApproval ${updated.id}`,
    });
    return c.json({ id: updated.id, status: updated.status });
  }

  return apiError(c, 400, 'invalid_action', `unknown action "${actionId}" for this alert`);
}
