import { Hono } from 'hono';
import type { AppEnv, AppContext } from '../context.js';
import { apiError, NON_PROD_ENVIRONMENTS } from '../http.js';
import { resolvePrincipal } from '../auth.js';

/**
 * BLOB host capability (docs/specs/plugin-support.md §7, A4 #126) — the first SERVER-ENFORCED plugin host
 * capability. Content-addressed file/photo storage in R2, behind the authenticated Worker (R2 is PRIVATE;
 * there is no public bucket URL). The attachment plugin is the first consumer (drop image/file → store →
 * embed → sync across devices, cached offline).
 *
 * SECURITY MODEL (§12-A4 checklist + HC-A1-1/2/3 — secSys re-audits this route):
 *   1. The R2 KEY is `{accountId}/{hash}` where:
 *        - accountId is SERVER-DERIVED from the bearer (principal.id), NEVER client-supplied → BOLA-safe:
 *          a caller can only ever read/write under their own prefix, so cross-account access is impossible
 *          by key construction (HC-A1-2).
 *        - hash is SERVER-COMPUTED (SHA-256 of the actual bytes) — content-addressing the host controls. A
 *          client-claimed hash is VERIFIED against it (mismatch → 400); the key always uses the server hash.
 *   2. Enforcement is at THIS route, on the server-derived accountId + the host-assigned pluginId (HC-A1-1);
 *      the client handle is the seam, never the gate. Bounded structured ops only — put/get/head, no raw
 *      egress or arbitrary key access (HC-A1-3).
 *   3. SAFE SERVING: GET always sets Content-Disposition: attachment + X-Content-Type-Options: nosniff and
 *      sanitizes the content-type (html/svg/xml → octet-stream) so a stored file can never execute as
 *      active content on the app origin. (Inline preview is the CLIENT fetching bytes + an object URL.)
 *   4. Per-account QUOTA + per-object SIZE cap enforced HERE (the host, never the plugin). Durable
 *      per-account RATE limiting is deferred pre-real-users (cf. the transcribe-throttle ruling) but
 *      HARD-required before >1 user — flagged, not silently skipped.
 */

/** Per-object hard cap. Matches the transcribe final-pass ceiling; raise only with a secSys ruling. */
const MAX_BLOB_SIZE = 25 * 1024 * 1024;
/** Per-account total stored bytes. Coarse v1 quota (summed from R2 list); a durable counter is a later add. */
const ACCOUNT_BLOB_QUOTA = 250 * 1024 * 1024;

/** Content-types safe to hand back with their real type (images can't execute). Everything else → octet. */
const SAFE_INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Never serve active/ambiguous content with its real type on the app origin (nosniff + attachment also apply). */
function safeServeType(stored: string | undefined): string {
  return stored && SAFE_INLINE_TYPES.has(stored) ? stored : 'application/octet-stream';
}

function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/** Resolve the caller's verified accountId, or null if unauthenticated (mirrors transcribe's F13 tripwire). */
async function resolveAccountId(c: AppContext): Promise<string | null> {
  const principal = await resolvePrincipal(c);
  if (principal.verification.method === 'unverified' && !NON_PROD_ENVIRONMENTS.has(c.env.ENVIRONMENT ?? '')) {
    return null;
  }
  return principal.id;
}

async function accountUsage(bucket: R2Bucket, accountId: string): Promise<number> {
  let total = 0;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: `${accountId}/`, ...(cursor ? { cursor } : {}) });
    for (const obj of page.objects) total += obj.size;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return total;
}

export const blob = new Hono<AppEnv>();

/** Upload: hash-verify + content-address under the caller's own prefix; dedup; quota + size enforced here. */
blob.post('/', async (c: AppContext) => {
  const accountId = await resolveAccountId(c);
  if (!accountId) return apiError(c, 401, 'unauthorized', 'blob storage requires an authenticated session');
  if (!c.env.BLOBS) return apiError(c, 503, 'blob_not_configured', 'blob storage is unavailable (R2 unbound)');

  // Reject oversize BEFORE buffering (memory-pressure guard on the 128MB budget) — see transcribe.
  const declaredLen = parseInt(c.req.header('content-length') ?? '', 10);
  if (!Number.isNaN(declaredLen) && declaredLen > MAX_BLOB_SIZE) {
    return apiError(c, 413, 'payload_too_large', 'file exceeds the maximum size');
  }

  const buf = await c.req.arrayBuffer();
  if (buf.byteLength === 0) return apiError(c, 400, 'invalid_request', 'empty file body');
  if (buf.byteLength > MAX_BLOB_SIZE) return apiError(c, 413, 'payload_too_large', 'file exceeds the maximum size');

  // Server-computed content hash — the host's address, not the client's word for it.
  const hash = toHex(await crypto.subtle.digest('SHA-256', buf));
  // If the client sent a hash hint, it MUST equal the server hash (integrity; a mismatch is a client bug
  // or tamper). The key uses the SERVER hash regardless.
  const claimed = c.req.header('x-blob-sha256');
  if (claimed && claimed.toLowerCase() !== hash) {
    return apiError(c, 400, 'hash_mismatch', 'declared content hash does not match the uploaded bytes');
  }

  const key = `${accountId}/${hash}`;

  // Dedup: content-addressed, so an identical upload is a no-op (and must not double-count quota).
  const existing = await c.env.BLOBS.head(key);
  if (!existing) {
    const used = await accountUsage(c.env.BLOBS, accountId);
    if (used + buf.byteLength > ACCOUNT_BLOB_QUOTA) {
      return apiError(c, 413, 'quota_exceeded', 'account storage quota exceeded');
    }
    const mime = c.req.header('x-blob-mime') ?? c.req.header('content-type') ?? 'application/octet-stream';
    await c.env.BLOBS.put(key, buf, {
      // Store metadata for serving; the content-type is re-sanitized on the way out regardless.
      httpMetadata: { contentType: mime },
      customMetadata: { accountId, mime, size: String(buf.byteLength) },
    });
  }

  return c.json({ hash, size: buf.byteLength });
});

/** Download: only ever under the caller's own prefix (BOLA-safe); safe headers; no inline active content. */
blob.get('/:hash', async (c: AppContext) => {
  const accountId = await resolveAccountId(c);
  if (!accountId) return apiError(c, 401, 'unauthorized', 'blob storage requires an authenticated session');
  if (!c.env.BLOBS) return apiError(c, 503, 'blob_not_configured', 'blob storage is unavailable (R2 unbound)');

  const hash = c.req.param('hash');
  // hex SHA-256 only — reject anything that isn't a clean hash so the key can't be steered.
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return apiError(c, 400, 'invalid_request', 'invalid blob id');

  const object = await c.env.BLOBS.get(`${accountId}/${hash}`);
  if (!object) return apiError(c, 404, 'not_found', 'blob not found');

  const stored = object.customMetadata?.['mime'] ?? object.httpMetadata?.contentType;
  return new Response(object.body, {
    headers: {
      'Content-Type': safeServeType(stored),
      // Never let a stored file run as active content on the app origin.
      'Content-Disposition': 'attachment',
      'X-Content-Type-Options': 'nosniff',
      // secSys #694 Q2: defense-in-depth — even if a blob were ever rendered, a fully-sandboxed CSP that
      // allows nothing means it can neither execute script nor load any subresource.
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, max-age=31536000, immutable', // content-addressed → immutable
    },
  });
});
