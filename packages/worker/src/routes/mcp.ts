import { Hono } from 'hono';
import type { RequestPrincipal } from '@deltos/shared';
import type { AppEnv, AppContext } from '../context.js';
import { resolvePrincipal, can, resolvedGrantFor, grantIsLive } from '../auth.js';
import { callerAccountId } from '../db/accountScope.js';
import { d1Adapter } from '../db/schema.js';
import { createAuthStore } from '../db/authStore.js';
import { fixedWindowAllow } from '../rateLimit.js';
import { MCP_RATE_LIMIT } from '../authPolicy.js';
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
  MCP_SERVER_INFO,
  MCP_INSTRUCTIONS,
} from '../mcp/tools.js';

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
  const grant = resolvedGrantFor(principal);
  const live =
    principal.verification.method !== 'unverified' &&
    grant !== undefined &&
    grantIsLive(grant, Date.now());
  if (!live) {
    c.header('WWW-Authenticate', 'Bearer');
    return c.json(rpcError(id, RPC.UNAUTHORIZED, 'missing or invalid bearer token'), 401);
  }

  // 3. Notifications (e.g. notifications/initialized) get a bare 202 ack — never a JSON-RPC response.
  if (isNotification) {
    return c.body(null, 202);
  }

  // 3b. C RATE-LIMIT (ROAD-0005 P0): coarse per-TOKEN request ceiling — bounds a runaway/abusive client
  //     (e.g. an agent loop) from hammering the read path / D1. Reuses the authThrottle store as a fixed
  //     window, keyed per-token (grantId, guaranteed present by the `live` gate above) so one token can't
  //     exhaust another's budget. Over-limit → JSON-RPC error + HTTP 429. Abuse/cost guard, not a security
  //     invariant — so it sits AFTER the auth gate (only authenticated callers consume budget).
  const allowed = await fixedWindowAllow(
    createAuthStore(d1Adapter(c.env.DB)),
    `mcp:${grant!.grantId}`,
    MCP_RATE_LIMIT.limit,
    MCP_RATE_LIMIT.windowMs,
    Date.now(),
  );
  if (!allowed) {
    return c.json(rpcError(id, RPC.RATE_LIMITED, 'rate limit exceeded — slow down and retry shortly'), 429);
  }

  // 4. Method dispatch.
  switch (req.method) {
    case 'initialize':
      return c.json(
        rpcSuccess(id, {
          protocolVersion: negotiateProtocolVersion(
            (req.params as { protocolVersion?: unknown } | undefined)?.protocolVersion,
          ),
          serverInfo: MCP_SERVER_INFO,
          capabilities: { tools: {} },
          instructions: MCP_INSTRUCTIONS,
        }),
        200,
      );
    case 'ping':
      return c.json(rpcSuccess(id, {}), 200);
    case 'tools/list':
      return c.json(rpcSuccess(id, toolListPayload()), 200);
    case 'tools/call':
      return handleToolsCall(c, id, req.params, principal);
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

  // SAME chokepoint as the PWA: scope (read/search), resource coverage, expiry, and revocation all here.
  const allowed = await can(principal, tool.op, tool.resource(args));
  if (!allowed) {
    return c.json(
      rpcSuccess(id, toolError('forbidden: this token is not authorized for that operation or resource')),
      200,
    );
  }

  // accountId is the SERVER-derived principal.id; every data read filters WHERE accountId = ? — a note
  // owned by another account is invisible (get_note → "not found"), inheriting account isolation.
  const accountId = callerAccountId(principal);
  const db = d1Adapter(c.env.DB);
  const result = await tool.execute(args, { db, accountId });
  return c.json(rpcSuccess(id, result), 200);
}
