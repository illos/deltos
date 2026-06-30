import type { RequestPrincipal } from '@deltos/shared';
import type { AppContext } from './context.js';

/**
 * SECURITY AUDIT LOG — the append-only who/what/where trail (ROAD-0005 P3).
 *
 * ONE chokepoint helper writes EVERY security-relevant event to the `AUDIT` Workers Analytics Engine
 * dataset: the two access chokepoints (`guard()` for REST/sync, the MCP `tools/call` dispatcher) plus the
 * credential-lifecycle events (login, agent-token mint/revoke, session revoke). AE's `writeDataPoint()`
 * has no update/delete API → the log is append-only BY CONSTRUCTION, the tamper-resistance the design
 * requires before OAuth widens the surface (api-access-security-model.md §3).
 *
 * SEPARATION OF DUTIES: the `AUDIT` binding is reached ONLY through this module, which takes the request
 * `AppContext` — never the data layer. The data layer (`db/*`, `mutate.ts`, MCP tool `execute`) takes its
 * `DbAdapter` by argument and never touches `c.env`, so a fully-compromised data path has no handle to
 * the log and structurally cannot rewrite history. Pinned by audit.separation.test.ts; this is the P5
 * red-team scoreboard invariant ("attack the audit log with a write token").
 *
 * FAIL-SOFT: audit is NEVER on a request's critical path. When the binding is unbound (local dev / unit
 * tests without a stub) the helper no-ops; if `writeDataPoint` throws it is swallowed. A missing audit
 * line must never turn a good request into an error — observability degrades, the request does not.
 */

/** allow = the chokepoint authorized the access; deny = it refused (a 403 / forbidden tool call). */
export type AuditResult = 'allow' | 'deny';

/** Which surface produced the event — lets queries slice the agent/MCP path from the owner's own traffic. */
export type AuditSurface = 'rest' | 'mcp' | 'auth';

export interface AuditEvent {
  /** rest = REST/sync guard · mcp = MCP tools/call · auth = credential-lifecycle handler. */
  surface: AuditSurface;
  /** The operation: the grant `op` for access events; `login` / `token.mint` / `session.revoke` / … for lifecycle. */
  action: string;
  result: AuditResult;
  /** The principal kind — `owner` vs `agent` is THE high-value signal (agent = a connected AI consumer). */
  principalKind: string;
  /**
   * The account the event is scoped to (the server-derived accountId). For an agent token this is the
   * OWNER's accountId — so agent access ties back to the human account; `principalKind` separates them.
   * Use the empty string only when no account resolved (e.g. a failed login for an unknown username).
   */
  accountId: string;
  /** The acting credential's grant id — NEVER the secret token. Null for unauthenticated events (login). */
  credentialRef?: string | null;
  /** The targeted resource kind (`workspace` / `notebook` / `note`), when the event has one. */
  resourceKind?: string | null;
  /** The targeted resource id, when scoped to a specific notebook/note (null for workspace-wide). */
  resourceId?: string | null;
  /** Freeform extra — denial reason, the MCP tool name, the revoked grant/family id, etc. */
  detail?: string | null;
}

/**
 * The acting credential's grant id, pulled from the principal's verification proof — never the raw token.
 * Only `grant-token` / `capability` principals carry one; the dev `unverified` / step-up principals do not.
 */
export function credentialRefOf(principal: RequestPrincipal): string | null {
  const v = principal.verification;
  if (v.method === 'grant-token' || v.method === 'capability') return v.grantId;
  return null;
}

/** Cap a field so the per-datapoint blob budget (5120 bytes total across blobs) can't be blown by one value. */
function cap(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Record one security event. Fire-and-forget: reads IP/geo off the request, writes one AE datapoint, and
 * never throws into the caller. The blob ORDER is the schema — query it positionally via the AE SQL API
 * (`blob1` = surface, `blob2` = action, …). Index = accountId so per-account queries sample accurately.
 */
export function audit(c: AppContext, ev: AuditEvent): void {
  const dataset = c.env.AUDIT;
  if (!dataset) return; // unbound (local dev / test without a stub) → no-op, never an error.
  try {
    const cf = (c.req.raw.cf ?? {}) as { country?: unknown; colo?: unknown };
    const country = typeof cf.country === 'string' ? cf.country : '';
    const colo = typeof cf.colo === 'string' ? cf.colo : '';
    dataset.writeDataPoint({
      // AE allows ONE index (the sampling key, ≤96 bytes). accountId keeps per-account history accurate.
      indexes: [cap(ev.accountId, 96)],
      // ORDER IS THE SCHEMA — blob1..blob15. Keep this list and the SQL queries in lockstep.
      blobs: [
        ev.surface, // blob1
        cap(ev.action, 64), // blob2
        ev.result, // blob3
        cap(ev.principalKind, 32), // blob4
        cap(ev.accountId, 96), // blob5
        cap(ev.credentialRef ?? '', 96), // blob6
        cap(ev.resourceKind ?? '', 32), // blob7
        cap(ev.resourceId ?? '', 96), // blob8
        cap(c.req.header('cf-connecting-ip') ?? '', 64), // blob9
        cap(country, 8), // blob10
        cap(colo, 16), // blob11
        cap(c.req.header('user-agent') ?? '', 256), // blob12
        cap(c.req.method, 8), // blob13
        cap(safePath(c.req.url), 256), // blob14
        cap(ev.detail ?? '', 256), // blob15
      ],
      // double1 = 1 → SUM(_sample_interval * double1) reconstructs event counts under AE sampling.
      doubles: [1],
    });
  } catch {
    // Observability must never break the request path — swallow (see FAIL-SOFT above).
  }
}

/** The request path, defensively parsed (a malformed URL must not throw inside the fail-soft writer). */
function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}
