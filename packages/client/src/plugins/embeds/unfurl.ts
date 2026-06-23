import { useAuthStore } from '../../auth/store.js';

/**
 * Client-side unfurl service (§5 E2c). Calls GET /api/unfurl?url=… and returns typed metadata
 * matching the server contract. The server KV-caches results; this module adds a lightweight
 * in-session memo so re-visiting the same URL in one session skips the round-trip entirely.
 *
 * Returned title/description/siteName are UNTRUSTED TEXT from the remote page — render as text only.
 * Returned image/favicon are UNTRUSTED URLS — validate scheme (https) before loading as img src.
 */

/** Metadata shape returned by the server (and echoed here). All optional except url. */
export interface UnfurlMetadata {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  favicon?: string;
  siteName?: string;
}

/** Thrown when the unfurl endpoint fails or is unreachable. */
export class UnfurlError extends Error {
  constructor(
    message: string,
    /** HTTP status, or 0 for a network/transport failure. */
    readonly status: number,
  ) {
    super(message);
    this.name = 'UnfurlError';
  }
}

/** Bearer header read FRESH from the in-memory auth store (F7 — never persisted). */
function authHeader(): Record<string, string> {
  const token = useAuthStore.getState().bearerToken;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** In-session memo: avoids re-calling the same URL within one page session. */
const memo = new Map<string, UnfurlMetadata>();

/**
 * Fetch resolved metadata for `url` from the unfurl endpoint.
 * Returns cached result immediately if the URL was already fetched this session.
 * Throws {@link UnfurlError} on network failure or a non-OK HTTP response.
 */
export async function unfurl(url: string, apiBase = '/api'): Promise<UnfurlMetadata> {
  const hit = memo.get(url);
  if (hit) return hit;

  let res: Response;
  try {
    res = await fetch(`${apiBase}/unfurl?url=${encodeURIComponent(url)}`, {
      headers: { ...authHeader() },
    });
  } catch {
    throw new UnfurlError('could not reach the unfurl service', 0);
  }

  if (!res.ok) {
    let message = res.statusText || 'unfurl failed';
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      if (body?.error?.message) message = body.error.message;
    } catch {
      // Non-JSON error body — keep status-text fallback.
    }
    throw new UnfurlError(message, res.status);
  }

  const data = (await res.json()) as UnfurlMetadata;
  memo.set(url, data);
  return data;
}

/** Clear the in-session memo (exposed for testing). */
export function _clearMemoForTest(): void {
  memo.clear();
}
