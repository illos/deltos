/**
 * MCP wire/protocol types + helpers — JSON-RPC 2.0 over Streamable HTTP, for the deltos read-only MCP
 * server (llm-mcp-integration.md §6). RESIDENCY: server (§4) — these types live in the WORKER package, NOT
 * in @deltos/shared, so they never reach the client bundle and never contend with the shared schemas.
 *
 * v1 is a STATELESS Streamable-HTTP endpoint: one JSON-RPC request per POST → one JSON-RPC response (no
 * SSE streaming, no JSON-RPC batching — batching was removed in MCP 2025-06-18). The session-id / resume
 * machinery of the full transport is intentionally not built; a remote connector re-sends `initialize`
 * each connection, which a stateless server answers fresh.
 */

export const JSONRPC_VERSION = '2.0' as const;

/** A JSON-RPC id is a string, number, or null; absent entirely on a notification. */
export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: typeof JSONRPC_VERSION;
  /** Absent ⇒ this is a notification (no response is sent). */
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: typeof JSONRPC_VERSION;
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: typeof JSONRPC_VERSION;
  id: JsonRpcId;
  error: { code: number; message: string; data?: unknown };
}

/** Standard JSON-RPC 2.0 error codes (+ a reserved server-error range for auth). */
export const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  /** -32000..-32099 is the implementation-defined server-error range; we use one for "unauthorized". */
  UNAUTHORIZED: -32001,
  /** Per-token request ceiling exceeded (ROAD-0005 P0 item C) — also returned with HTTP 429. */
  RATE_LIMITED: -32029,
} as const;

export function rpcSuccess(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

export function rpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcErrorResponse {
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

// ---------------------------------------------------------------------------
// Protocol-version negotiation
// ---------------------------------------------------------------------------

/**
 * The protocol revisions this server speaks. Newest first. On `initialize` we ECHO the client's requested
 * version when we support it (the spec's MUST), else fall back to our latest — a connector that asked for
 * something unknown still gets a workable server rather than a hard failure.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

export function negotiateProtocolVersion(requested: unknown): string {
  return typeof requested === 'string' &&
    (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
    ? requested
    : LATEST_PROTOCOL_VERSION;
}

// ---------------------------------------------------------------------------
// tools/call result shape
// ---------------------------------------------------------------------------

export interface McpTextContent {
  type: 'text';
  text: string;
}

export interface McpToolResult {
  content: McpTextContent[];
  /** Machine-readable mirror of the content (modern MCP) — the parsed object the text serializes. */
  structuredContent?: unknown;
  /** A handled tool-side failure (e.g. note not found, scope-denied) — distinct from a protocol error. */
  isError?: boolean;
}

/** A successful tool result: the structured payload, mirrored as pretty JSON text for non-structured clients. */
export function toolOk(structured: unknown): McpToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
  };
}

/** A handled tool error (returned as a result with isError, NOT a JSON-RPC error — so the model sees it). */
export function toolError(message: string): McpToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}
