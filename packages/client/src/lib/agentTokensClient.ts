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
  AgentWriteOpt,
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
    /** Server error code (e.g. 'password_invalid') — set for step-up failures so the UI can target the field. */
    readonly code?: string,
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
async function authedFetch(
  path: string,
  init: RequestInit = {},
  opts: { remintOn401?: boolean } = {},
): Promise<Response> {
  // On the MINT route a 401 means a STEP-UP failure (wrong/missing password), NOT an expired bearer —
  // an expired access token is a 403 and an absent one a 503. So mint passes remintOn401:false to keep a
  // step-up rejection from being swallowed by a bearer re-mint + silent retry (which would mask it as
  // "session expired"). All other calls keep the defensive 401→re-mint behavior.
  const remintOn401 = opts.remintOn401 ?? true;
  const send = () =>
    fetch(`${BASE}${path}`, { ...init, headers: { ...(init.headers ?? {}), ...authHeader() } });
  let res: Response;
  try {
    res = await send();
  } catch {
    throw new AgentTokenError('Could not reach the server — check your connection.');
  }
  const authReject = (res.status === 401 && remintOn401) || res.status === 403 || res.status === 503;
  if (!authReject) return res;
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

/** Turn a step-up error code (or none) into a human message keyed to the field at fault. */
function stepUpMessage(code?: string): string {
  switch (code) {
    case 'password_required':
      return 'Enter your password to generate a token.';
    case 'password_invalid':
      return 'That password is incorrect.';
    case 'totp_required':
      return 'Enter your two-factor code.';
    case 'totp_invalid':
      return 'That two-factor code is not valid.';
    default:
      return 'Re-authentication failed — check your password and try again.';
  }
}

async function readErrorCode(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { error?: { code?: string } };
    return body.error?.code;
  } catch {
    return undefined;
  }
}

/**
 * Mint a new agent token. Requires STEP-UP re-auth (H1): `password` always, plus `totp` when the account
 * has 2FA. The raw `token` is returned ONCE — capture it now, it is never re-served. Read is the FLOOR;
 * pass `write` to opt the token into the write tools (create/edit/trash) — omitted ⇒ a read-only token
 * (the server clamps fail-closed either way). A step-up failure surfaces as an AgentTokenError with status
 * 401 and the server `code` so the caller can target the right field.
 */
export async function mintAgentToken(params: {
  label?: string;
  password: string;
  totp?: string;
  write?: AgentWriteOpt;
}): Promise<MintAgentTokenResponse> {
  const trimmed = params.label?.trim();
  const body: MintAgentTokenRequest = {
    password: params.password,
    ...(trimmed ? { label: trimmed } : {}),
    ...(params.totp ? { totp: params.totp } : {}),
    ...(params.write ? { write: params.write } : {}),
  };
  const res = await authedFetch(
    '',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    { remintOn401: false },
  );
  if (res.status === 401) {
    const code = await readErrorCode(res);
    throw new AgentTokenError(stepUpMessage(code), 401, code);
  }
  if (!res.ok) throw new AgentTokenError(`Could not generate a token (${res.status}).`, res.status);
  return readJson<MintAgentTokenResponse>(res);
}

/**
 * Revoke a WHOLE token (all its resources) by tokenId — the "revoke connection" button (grant sets, ROAD-0011
 * P1). The server returns 404 for not-found / already-revoked / not-owned (no cross-account disclosure) — all
 * benign for a revoke, so we treat 404 as success. Any other non-OK is a real failure.
 */
export async function revokeAgentToken(tokenId: string): Promise<void> {
  const res = await authedFetch(`/token/${encodeURIComponent(tokenId)}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) {
    throw new AgentTokenError(`Could not revoke the connection (${res.status}).`, res.status);
  }
}

/**
 * Revoke ONE resource of a token by its per-resource grantId (per-resource revocation) — drops a single
 * notebook/note from a token without re-minting. Same benign-404 handling as {@link revokeAgentToken}.
 */
export async function revokeAgentTokenResource(grantId: string): Promise<void> {
  const res = await authedFetch(`/${encodeURIComponent(grantId)}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) {
    throw new AgentTokenError(`Could not revoke the connection (${res.status}).`, res.status);
  }
}

export type { AgentToken };
