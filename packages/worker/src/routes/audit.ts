import { Hono } from 'hono';
import { z } from 'zod';
import type { Resource } from '@deltos/shared';
import type { AppEnv } from '../context.js';
import { guard } from '../http.js';
import { createAuthStore } from '../db/authStore.js';
import { d1Adapter } from '../db/schema.js';
import { stampAccountId } from '../db/accountScope.js';

/**
 * Account-activity surface (ROAD-0005 P3 — the user-facing audit view). ONE owner-authed route that reads
 * the account's recent security events from the `auditLog` D1 projection (audit.ts writes it), feeding the
 * lazy "Account activity" Settings section. The live trust surface: the owner can self-audit anytime and
 * notice anomalous access — a sign-in from nowhere, an agent reading more than expected, a token they
 * didn't mint — as it happens, not just forensically after a suspected breach.
 *
 * AUTHZ — same chokepoint + op as the sessions / agent-token surfaces: `guard({ op: 'share' })`. The
 * audit log is OWNER-ONLY by the same invariant — an AGENT token's scope is clamped read-only (NO 'share')
 * so a connected Claude/MCP credential can NEVER read the owner's access history, IPs, or other tokens
 * (it 403s at the chokepoint). Reading your own security log is a management capability, not a data read.
 *
 * BOLA / ACCOUNT-SCOPING — the account is ALWAYS the server-derived `stampAccountId(principal)`
 * (= accountId after the 0003 re-point), NEVER a body/query field. The store query filters on it, so a
 * caller sees ONLY their own events. The response carries no secrets (credentialRef is a grantId, never a
 * token).
 *
 * RESIDENCY: server — pure backend plumbing; the view is a lazy off-track Settings route (zero first-load).
 */
export const auditRoutes = new Hono<AppEnv>();

const workspaceResource = (): Resource => ({ kind: 'workspace' });

/** Cap the page size: a bounded read so a caller can't request an unbounded table scan. Default 100. */
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

/**
 * GET /api/audit/recent?limit=N — the account's recent security events, newest-first. Account-scoped on
 * the server-derived accountId. Returns non-secret metadata only.
 */
auditRoutes.get(
  '/recent',
  guard({
    op: 'share',
    schema: z.object({ limit: z.coerce.number().int().positive().max(MAX_LIMIT).optional() }),
    input: (c) => ({ limit: c.req.query('limit') }),
    resource: workspaceResource,
    handle: async (req, c, principal) => {
      const store = createAuthStore(d1Adapter(c.env.DB));
      const accountId = stampAccountId(principal);
      const entries = await store.listAuditLogForAccount(accountId, req.limit ?? DEFAULT_LIMIT);
      return c.json({
        events: entries.map((e) => ({
          id: e.id,
          ts: e.ts,
          surface: e.surface,
          action: e.action,
          result: e.result,
          principalKind: e.principalKind,
          resourceKind: e.resourceKind,
          resourceId: e.resourceId,
          ip: e.ip,
          country: e.country,
          detail: e.detail,
        })),
      });
    },
  }),
);
