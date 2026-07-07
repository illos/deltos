/**
 * Share client — the three owner-authed calls behind read-only URL sharing of a note or notebook
 * (ROAD-0011 P2). Mints a share link for a resource, lists the resource's existing (non-revoked) links,
 * and revokes one. A share link is a capability grant the owner hands out; the SECRET token is returned
 * ONCE at mint and never again (the list only carries non-secret metadata).
 *
 * RESIDENCY: this is a LAZY off-track-route module — it is imported only by ShareLinkSection (in the
 * combined ShareExportPanel), which NoteRoute `lazy()`-loads (its own chunk) on the `?share` param, so it
 * never enters the mobile first-load bundle.
 * The contract types are declared inline (the backend is the schema-first source of truth; the shapes
 * here are read-only views the UI casts the response into — no zod tags along), matching the
 * sessionsClient / auditClient convention. If `@deltos/shared` later exports Share* schemas, swap these
 * for the imports (the lead reconciles at merge).
 *
 * AUTH: every call bears the in-memory access token (auth/store) and, on a 401/403/503, re-mints the
 * bearer ONCE from the refresh cookie and retries — the SAME contract syncEngine.syncFetch,
 * sessionsClient, and agentTokensClient use (GOTCHA-0001). The token is read FRESH per request so it is
 * never persisted at rest (F7).
 */
import { useAuthStore } from '../auth/store.js';
import type { Palette, Voice } from './themeStore.js';

const BASE = '/api/shares';

/** What a share link points at — a single note or a whole notebook. */
export type ShareResourceType = 'note' | 'notebook';

/**
 * The owner's current theme, STAMPED onto a share at mint (ROAD-0011 P2) so the public `/s/<token>` render
 * uses the owner's palette + font (honoring the viewer's system light/dark). Read from themeStore at the
 * call site (ShareLinkSection); the server validates both against strict enums before storing.
 */
export interface ShareThemeStamp {
  palette: Palette;
  voice: Voice;
}

/**
 * The one-time result of minting a share link. `token` + `url` are shown ONCE here and can never be
 * re-fetched — the list endpoint deliberately never returns them.
 */
export interface MintedShare {
  /** Stable id of the created share — the unit of revocation. */
  shareId: string;
  /** The secret share token. Shown once; not recoverable. */
  token: string;
  /** The full public read-only URL to hand out. Shown once (embeds the token). */
  url: string;
}

/** One existing share link, as the list endpoint returns it — non-secret metadata only (never a token). */
export interface ShareRecord {
  /** Stable id of the share — the unit of revocation. */
  shareId: string;
  /** Whether this link points at a note or a notebook. */
  resourceType: ShareResourceType;
  /** The id of the shared note or notebook. */
  resourceId: string;
  /** ISO-8601 timestamp the link was created. */
  createdAt: string;
  /** Always false in a list response (revoked links are not returned); kept for shape-parity. */
  revoked: boolean;
}

interface ListSharesResponse {
  shares: ShareRecord[];
}

/** A failed share call, carrying the HTTP status (when the server responded) for the UI to message on. */
export class ShareError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ShareError';
  }
}

function authHeader(): Record<string, string> {
  const token = useAuthStore.getState().bearerToken;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * fetch() for a share call. Mirrors syncEngine.syncFetch / sessionsClient: on an auth rejection
 * (403 = expired access token · 401 = defensive · 503 = absent-bearer cold-boot) it re-mints the
 * in-memory bearer ONCE and retries. A re-mint that can't restore a usable bearer ('revoked'/'offline')
 * surfaces a typed ShareError.
 */
async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const send = () =>
    fetch(`${BASE}${path}`, { ...init, headers: { ...(init.headers ?? {}), ...authHeader() } });
  let res: Response;
  try {
    res = await send();
  } catch {
    throw new ShareError('Could not reach the server — check your connection.');
  }
  if (res.status !== 401 && res.status !== 403 && res.status !== 503) return res;
  const outcome = await useAuthStore.getState().remintBearer();
  if (outcome !== 'ok') {
    throw new ShareError(
      outcome === 'revoked'
        ? 'Your session expired — sign in again to manage share links.'
        : 'Could not reach the server — check your connection.',
      res.status,
    );
  }
  try {
    return await send();
  } catch {
    throw new ShareError('Could not reach the server — check your connection.');
  }
}

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/**
 * Mint a read-only share link for a note or notebook. The returned token + url are shown ONCE and cannot
 * be recovered — surface them immediately at the call site. `theme` (the owner's current palette+voice) is
 * STAMPED onto the share so the public render matches the owner's theme; omitted when unavailable (the render
 * then falls back).
 */
export async function createShare(
  resourceType: ShareResourceType,
  resourceId: string,
  theme?: ShareThemeStamp,
): Promise<MintedShare> {
  const res = await authedFetch('', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(
      theme ? { resourceType, resourceId, palette: theme.palette, voice: theme.voice } : { resourceType, resourceId },
    ),
  });
  if (!res.ok) throw new ShareError(`Could not create the share link (${res.status}).`, res.status);
  const data = await readJson<Partial<MintedShare>>(res);
  if (!data.shareId || typeof data.token !== 'string' || typeof data.url !== 'string') {
    throw new ShareError('The server returned an unexpected share response.');
  }
  return { shareId: data.shareId, token: data.token, url: data.url };
}

/** List the existing (non-revoked) share links for one resource. Never includes a token. */
export async function listShares(
  resourceType: ShareResourceType,
  resourceId: string,
): Promise<ShareRecord[]> {
  const query = `?resourceType=${encodeURIComponent(resourceType)}&resourceId=${encodeURIComponent(resourceId)}`;
  const res = await authedFetch(query, { method: 'GET' });
  if (!res.ok) throw new ShareError(`Could not load share links (${res.status}).`, res.status);
  const data = await readJson<Partial<ListSharesResponse>>(res);
  return Array.isArray(data.shares) ? data.shares : [];
}

/**
 * Revoke one share link by shareId, killing that URL immediately. The server returns 404 for
 * not-found / already-revoked / not-owned (no cross-account disclosure) — all benign for a revoke, so we
 * treat 404 as success and simply drop the row. Any other non-OK is a real failure.
 */
export async function revokeShare(shareId: string): Promise<void> {
  const res = await authedFetch(`/${encodeURIComponent(shareId)}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) {
    throw new ShareError(`Could not revoke that share link (${res.status}).`, res.status);
  }
}
