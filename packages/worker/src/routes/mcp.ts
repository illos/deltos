import { Hono } from 'hono';
import type { RequestPrincipal } from '@deltos/shared';
import type { AppEnv, AppContext } from '../context.js';
import { resolvePrincipal, canWith, resolvedGrantFor, grantIsLive } from '../auth.js';
import { createResourceOwnerResolver } from '../db/resourceOwner.js';
import { audit, credentialRefOf } from '../audit.js';
import { callerAccountId } from '../db/accountScope.js';
import { d1Adapter } from '../db/schema.js';
import { createAuthStore } from '../db/authStore.js';
import {
  JSONRPC_VERSION,
  RPC,
  rpcSuccess,
  rpcError,
  negotiateProtocolVersion,
  toolError,
  type JsonRpcId,
} from '../mcp/protocol.js';
import {
  findTool,
  toolListPayload,
  mcpInstructions,
  WRITE_OPS,
  MCP_SERVER_INFO,
} from '../mcp/tools.js';
import type { Op, Resource } from '@deltos/shared';

/**
 * The deltos remote MCP server (llm-mcp-integration.md §6) — JSON-RPC 2.0 over a STATELESS Streamable-HTTP
 * POST, READ-ONLY. Consumed by claude.ai connectors / Claude Desktop / Claude Code, authenticated by the
 * Bearer AGENT TOKEN (§5). It is a thin protocol adapter: methods dispatch to the SAME data-layer readers +
 * the SAME `can(principal, op, resource)` chokepoint the PWA uses, so account isolation is inherited.
 *
 * RESIDENCY: server (§4) — pure backend plumbing, zero client-bundle weight.
 *
 * Auth posture: a live owner/agent bearer is required for EVERY method (including `initialize`). A missing,
 * unrecognized, revoked, or expired token is rejected at the transport with HTTP 401 + a JSON-RPC error —
 * it never reaches a tool. Per-tool scope/resource is then enforced through `can()`.
 */
export const mcp = new Hono<AppEnv>();

/** GET is for an optional server→client SSE stream; the stateless v1 doesn't offer one → 405 (spec-allowed). */
mcp.get('/', (c) => {
  c.header('Allow', 'POST');
  return c.body(null, 405);
});

mcp.post('/', async (c) => {
  // 1. Parse the JSON-RPC envelope.
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(rpcError(null, RPC.PARSE_ERROR, 'invalid JSON'), 200);
  }
  if (Array.isArray(body)) {
    // JSON-RPC batching was removed in MCP 2025-06-18; the stateless v1 takes one request per POST.
    return c.json(rpcError(null, RPC.INVALID_REQUEST, 'JSON-RPC batching is not supported'), 200);
  }
  const req = (typeof body === 'object' && body !== null ? body : {}) as {
    jsonrpc?: unknown;
    id?: JsonRpcId;
    method?: unknown;
    params?: unknown;
  };
  const id: JsonRpcId = req.id ?? null;
  const isNotification = req.id === undefined; // JSON-RPC: no id ⇒ notification (no response body)

  if (req.jsonrpc !== JSONRPC_VERSION || typeof req.method !== 'string') {
    return c.json(rpcError(id, RPC.INVALID_REQUEST, 'malformed JSON-RPC request'), 200);
  }

  // 2. Transport auth gate (§8) — the WHOLE endpoint is bearer-gated. Reject missing / unrecognized /
  //    revoked / expired tokens here at 401, BEFORE any method or tool runs. `grantIsLive` is the same
  //    revoked+expired check the per-op `can()` chokepoint applies, so liveness is decided one way.
  const principal = await resolvePrincipal(c);
  // Grant SETS (ROAD-0011 P1): a token may resolve to many rows. The bearer is usable iff AT LEAST ONE row
  // is live (any-of). The rate-limit key + scope surface read from a live representative (scope is uniform).
  const nowMs = Date.now();
  const liveGrants = (resolvedGrantFor(principal) ?? []).filter((g) => grantIsLive(g, nowMs));
  const primaryGrant = liveGrants[0];
  const live = principal.verification.method !== 'unverified' && primaryGrant !== undefined;
  if (!live || !primaryGrant) {
    // Point a tokenless client at the Protected Resource Metadata (RFC 9728) so it can DISCOVER the OAuth
    // Authorization Server and run the connect flow — this is what turns a bare 401 into a one-click OAuth
    // handshake (oauth-provider.md §1). Same-origin, derived from the request so it's right on any deploy.
    const origin = new URL(c.req.url).origin;
    c.header(
      'WWW-Authenticate',
      `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
    );
    return c.json(rpcError(id, RPC.UNAUTHORIZED, 'missing or invalid bearer token'), 401);
  }

  // 3. C RATE-LIMIT (ROAD-0005 P0): coarse per-TOKEN request ceiling — bounds a runaway/abusive client
  //    (e.g. an agent loop) from hammering the auth/read path / D1. Reuses the authThrottle store as a
  //    fixed window, keyed per-token (grantId, guaranteed present by the `live` gate above) so one token
  //    can't exhaust another's budget. Meters EVERY authenticated request — INCLUDING notifications — so a
  //    notification flood can't pound the auth/D1 read path uncapped (it sits ABOVE the notification ack).
  //    After the auth gate (only authenticated callers consume budget); over-limit → JSON-RPC error + 429.
  const store = createAuthStore(d1Adapter(c.env.DB));
  // Per-TOKEN key: the shared tokenGroupId is stable across per-resource revocation (revoking one notebook
  // from a set doesn't reset the token's window); legacy single-row grants fall back to the row grantId.
  const rateKey = primaryGrant.tokenGroupId ?? primaryGrant.grantId;

  // RATE LIMITS + DAILY QUOTA DISABLED (Jim, 2026-07-27): an authenticated agent token has full,
  // unmetered access to all tools — no per-token burst window, no per-account/UTC-day request quota,
  // no write cap. Jim kept hitting the ceilings during dogfood and wants none while the agent is
  // authorized. The transport bearer gate (401 above) and per-tool scope/authorization checks are the
  // only controls. To restore, re-add fixedWindowAllow(MCP_RATE_LIMIT) + chargeUsage(DAILY_QUOTA.mcp)
  // here (see git history / ROAD-0005 P4).

  // 4. Notifications (e.g. notifications/initialized) get a bare 202 ack — never a JSON-RPC response.
  if (isNotification) {
    return c.body(null, 202);
  }

  // The token's granted scopes drive the least-privilege surface: a read-only token is told it's
  // read-only + never SEES the write tools; a write token is taught the live-apply/recoverability model
  // + sees them. Scope is uniform across a grant set, so a live representative row speaks for the token.
  const scopes = primaryGrant.scope as Op[];
  const canWrite = scopes.some((s) => WRITE_OPS.has(s));

  // 5. Method dispatch.
  switch (req.method) {
    case 'initialize':
      return c.json(
        rpcSuccess(id, {
          protocolVersion: negotiateProtocolVersion(
            (req.params as { protocolVersion?: unknown } | undefined)?.protocolVersion,
          ),
          serverInfo: MCP_SERVER_INFO,
          capabilities: { tools: {} },
          instructions: mcpInstructions(canWrite),
        }),
        200,
      );
    case 'ping':
      return c.json(rpcSuccess(id, {}), 200);
    case 'tools/list':
      return c.json(rpcSuccess(id, toolListPayload(scopes)), 200);
    case 'tools/call':
      // Pass the requesting token's group id (same key as the rate-limit above) — the write-approval tools
      // scope their pending record to it, and the effective-cap keys the approved lift on it.
      return handleToolsCall(c, id, req.params, principal, store, rateKey);
    default:
      return c.json(rpcError(id, RPC.METHOD_NOT_FOUND, `unknown method: ${req.method}`), 200);
  }
});

/** `tools/call`: validate name + arguments, run the `can()` chokepoint, then the thin data-layer adapter. */
async function handleToolsCall(
  c: AppContext,
  id: JsonRpcId,
  params: unknown,
  principal: RequestPrincipal,
  store: ReturnType<typeof createAuthStore>,
  tokenGroupId: string,
): Promise<Response> {
  const p = (typeof params === 'object' && params !== null ? params : {}) as {
    name?: unknown;
    arguments?: unknown;
  };
  const tool = findTool(p.name);
  if (!tool) {
    return c.json(rpcError(id, RPC.INVALID_PARAMS, `unknown tool: ${String(p.name)}`), 200);
  }

  // Schema-first: validate the call arguments at the boundary.
  const parsed = tool.argsSchema.safeParse(p.arguments ?? {});
  if (!parsed.success) {
    return c.json(rpcError(id, RPC.INVALID_PARAMS, 'invalid tool arguments', parsed.error.format()), 200);
  }
  const args = parsed.data;

  // SAME chokepoint as the PWA, EXTENDED with the owner-resolver so a notebook grant covers its notes
  // (ROAD-0011 P1 §1): scope, hierarchy coverage, ownership belt, expiry, and revocation all decided here.
  const db = d1Adapter(c.env.DB);
  const ctx = { resolveResourceOwner: createResourceOwnerResolver(db) };
  const toolResource = tool.resource(args);
  // COLLECTION tools (list_notebooks) are scope-gated, not resource-gated: any read-scoped token may call
  // them, and the tool self-filters each item through the SAME evaluator (least-privilege visibility §1.5).
  // Everything else is gated on hierarchy coverage of the addressed resource.
  const allowed =
    tool.gate === 'collection'
      ? (resolvedGrantFor(principal) ?? []).some((g) => grantIsLive(g, Date.now()) && g.scope.includes(tool.op))
      : await canWith(ctx, principal, tool.op, toolResource);
  // P3 audit: the MCP/agent path is exactly the "compromised client" case — record every tool-call
  // decision (allow + deny), tagged surface:'mcp', so the connected-AI access trail is queryable on its own.
  await audit(c, {
    surface: 'mcp',
    action: tool.op,
    result: allowed ? 'allow' : 'deny',
    principalKind: principal.kind,
    accountId: callerAccountId(principal),
    credentialRef: credentialRefOf(principal),
    resourceKind: toolResource.kind,
    resourceId: 'id' in toolResource ? toolResource.id : null,
    detail: String(p.name),
  });
  if (!allowed) {
    return c.json(
      rpcSuccess(id, toolError('forbidden: this token is not authorized for that operation or resource')),
      200,
    );
  }

  // accountId is the SERVER-derived principal.id; every data read filters WHERE accountId = ? — a note
  // owned by another account is invisible (get_note → "not found"), inheriting account isolation.
  const accountId = callerAccountId(principal);
  const now = new Date().toISOString();

  // WRITE cap DISABLED (Jim, 2026-07-27): the per-account/UTC-day mcpWrite ceiling was removed at Jim's
  // request — he kept hitting it during dogfood. WRITE tools now go straight through (still gated by
  // authorization + scope above). The read ceiling is untouched. To restore, re-charge effectiveWriteCap
  // against 'mcpWrite' here for WRITE_OPS (see git history / write-tools.md §7).

  // OP-AWARE authorize: collection tools self-filter with authorize('read', …); create_note filing
  // checks authorize('write', {kind:'collection'}) so membership needs the same authority as add_notes.
  const authorize = (op: Op, resource: Resource): Promise<boolean> =>
    canWith(ctx, principal, op, resource);
  // Citation origin for ChatGPT-connector search/fetch. Prefer the CONFIGURED deployment host
  // (AUTH_AUDIENCE, the canonical hostname) so a spoofed Host header can't poison the citation links
  // ChatGPT renders as trusted; fall back to the request origin only when unset (dev/test deploys).
  const appOrigin = c.env.AUTH_AUDIENCE ? `https://${c.env.AUTH_AUDIENCE}` : new URL(c.req.url).origin;
  const result = await tool.execute(args, {
    db,
    accountId,
    now,
    env: c.env,
    authorize,
    tokenGroupId,
    store,
    appOrigin,
  });
  return c.json(rpcSuccess(id, result), 200);
}
