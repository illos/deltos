/**
 * Agent-token client — the three owner-authed calls behind the "Connect to Claude" Settings section
 * (llm-mcp-integration.md §5). Mints / lists / revokes the long-lived, read-only credential a remote MCP
 * connector (claude.ai / Claude Desktop / Claude Code) bears.
 *
 * RESIDENCY (llm-mcp §4): this is a LAZY off-track-route module — it is imported only by
 * ConnectClaudeSection, which rides the already code-split SettingsRoute chunk, so it never enters the
 * mobile first-load bundle. Shared types come in `import type`-only (erased at build) — no zod runtime
 * tags along; this matches the auth store's "cast the response shape" convention.
 *
 * AUTH: every call bears the in-memory access token (auth/store) and, on a 401/403/503, re-mints the
 * bearer ONCE from the refresh cookie and retries — the SAME contract syncEngine.syncFetch uses. The token
 * is read FRESH per request so it is never persisted at rest (F7).
 */
import { useAuthStore } from '../auth/store.js';
import type {
  AgentToken,
  ListAgentTokensResponse,
  MintAgentTokenRequest,
  MintAgentTokenResponse,
} from '@deltos/shared';

const BASE = '/api/agent-tokens';

/** A failed agent-token call, carrying the HTTP status (when the server responded) for the UI to message on. */
export class AgentTokenError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'AgentTokenError';
  }
}

function authHeader(): Record<string, string> {
  const token = useAuthStore.getState().bearerToken;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * fetch() for an agent-token call. Mirrors syncEngine.syncFetch: on an auth rejection (403 = expired access
 * token · 401 = defensive · 503 = absent-bearer cold-boot) it re-mints the in-memory bearer ONCE and retries.
 * A re-mint that can't restore a usable bearer ('revoked'/'offline') surfaces a typed AgentTokenError.
 */
async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const send = () =>
    fetch(`${BASE}${path}`, { ...init, headers: { ...(init.headers ?? {}), ...authHeader() } });
  let res: Response;
  try {
    res = await send();
  } catch {
    throw new AgentTokenError('Could not reach the server — check your connection.');
  }
  if (res.status !== 401 && res.status !== 403 && res.status !== 503) return res;
  const outcome = await useAuthStore.getState().remintBearer();
  if (outcome !== 'ok') {
    throw new AgentTokenError(
      outcome === 'revoked'
        ? 'Your session expired — sign in again to manage connections.'
        : 'Could not reach the server — check your connection.',
      res.status,
    );
  }
  try {
    return await send();
  } catch {
    throw new AgentTokenError('Could not reach the server — check your connection.');
  }
}

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** List the account's active agent tokens (the response never includes a token value). */
export async function listAgentTokens(): Promise<AgentToken[]> {
  const res = await authedFetch('', { method: 'GET' });
  if (!res.ok) throw new AgentTokenError(`Could not load connections (${res.status}).`, res.status);
  const data = await readJson<Partial<ListAgentTokensResponse>>(res);
  return Array.isArray(data.tokens) ? data.tokens : [];
}

/**
 * Mint a new read-only agent token. The raw `token` is returned ONCE — capture it now, it is never
 * re-served. v1 sends only an optional label; the server clamps scope to read-only regardless, so the UI
 * needs no scope picker.
 */
export async function mintAgentToken(label?: string): Promise<MintAgentTokenResponse> {
  const trimmed = label?.trim();
  const body: MintAgentTokenRequest = trimmed ? { label: trimmed } : {};
  const res = await authedFetch('', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new AgentTokenError(`Could not generate a token (${res.status}).`, res.status);
  return readJson<MintAgentTokenResponse>(res);
}

/**
 * Revoke an agent token by grantId. The server returns 404 for not-found / already-revoked / not-owned
 * (no cross-account disclosure) — all benign for a revoke, so we treat 404 as success and simply drop the
 * row. Any other non-OK is a real failure.
 */
export async function revokeAgentToken(grantId: string): Promise<void> {
  const res = await authedFetch(`/${encodeURIComponent(grantId)}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) {
    throw new AgentTokenError(`Could not revoke the connection (${res.status}).`, res.status);
  }
}

export type { AgentToken };
