import { Hono } from 'hono';
import type { AppEnv, AppContext } from '../context.js';
import type { Env } from '../env.js';
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
const ACCOUNT_BLOB_QUOTA = 10 * 1024 * 1024 * 1024;

/** Content-types safe to hand back with their real type (images can't execute). Everything else → octet. */
const SAFE_INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/**
 * Image inputs we pre-bake WebP derivatives for (file-notes spec §4.2). The SAFE_INLINE image set plus HEIC/HEIF
 * — `env.IMAGES` decodes HEIC on all plans (FN-W4), and the user never sees the raw HEIC bytes inline (browsers
 * can't decode them), only the host-baked WebP. The derivative bake is content-format-agnostic; this set only
 * decides WHICH uploads are worth a bake.
 */
const BAKEABLE_IMAGE_TYPES = new Set([...SAFE_INLINE_TYPES, 'image/heic', 'image/heif']);

/**
 * The two WebP derivatives pre-baked per image (file-notes spec §4.2, gate FN-W2). Keys live under the SAME
 * server-derived `{accountId}/` prefix as the original blob (HC-A4-1 access boundary), suffixed so a user upload
 * — whose key is `{accountId}/{64-hex-hash}` — can NEVER land bytes at a derivative key. That key-namespace gap is
 * what makes the inline derivative routes safe to serve non-attachment: they only ever return host-generated WebP.
 */
const DERIVATIVES = [
  /** Square center-crop tile for the list artifact-pill. */
  { suffix: 'thumb.webp', transform: { width: 256, height: 256, fit: 'cover' as const } },
  /** Long-edge ≤2048px contain (never upscales) for the open-view preview. */
  { suffix: 'view.webp', transform: { width: 2048, height: 2048, fit: 'scale-down' as const } },
];

/** Never serve active/ambiguous content with its real type on the app origin (nosniff + attachment also apply). */
function safeServeType(stored: string | undefined): string {
  return stored && SAFE_INLINE_TYPES.has(stored) ? stored : 'application/octet-stream';
}

/**
 * Pre-bake the two WebP derivatives for an uploaded image (file-notes spec §4.2; gate FN-W2). The `env.IMAGES`
 * call is the mockable seam — unit tests inject a stub binding (the real binding has NO local impl, only
 * `wrangler dev --remote`). Every derive is:
 *   - IDEMPOTENT: content-addressed key + a head()-precheck → a re-upload of the same hash skips an already-baked
 *     derivative (never double-bakes destructively), and a derive that failed last time is retried.
 *   - NON-FATAL: the original blob is already stored, so a transform/store failure is logged and swallowed — the
 *     upload still succeeds; the list just falls back to the format icon and the open-view to the large icon.
 * Degrades cleanly (no-op) when IMAGES is unbound (gate FN-W1).
 */
async function bakeImageDerivatives(env: Env, accountId: string, hash: string, buf: ArrayBuffer): Promise<void> {
  const images = env.IMAGES;
  const bucket = env.BLOBS;
  if (!images || !bucket) return;
  for (const d of DERIVATIVES) {
    const derivKey = `${accountId}/${hash}.${d.suffix}`;
    try {
      if (await bucket.head(derivKey)) continue; // already baked — idempotent skip
      const result = await images
        .input(new Response(buf).body as ReadableStream<Uint8Array>)
        .transform(d.transform)
        .output({ format: 'image/webp' });
      // Collect to bytes before storing so the value is an ArrayBuffer (portable across R2 impls).
      const out = await new Response(result.image()).arrayBuffer();
      await bucket.put(derivKey, out, {
        httpMetadata: { contentType: 'image/webp' },
        customMetadata: { accountId, derived: d.suffix, sourceHash: hash },
      });
    } catch (err) {
      console.error(`blob: WebP derivative bake failed for ${derivKey} (non-fatal)`, err);
    }
  }
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
  const mime = c.req.header('x-blob-mime') ?? c.req.header('content-type') ?? 'application/octet-stream';

  // Dedup: content-addressed, so an identical upload is a no-op (and must not double-count quota).
  const existing = await c.env.BLOBS.head(key);
  if (!existing) {
    const used = await accountUsage(c.env.BLOBS, accountId);
    if (used + buf.byteLength > ACCOUNT_BLOB_QUOTA) {
      return apiError(c, 413, 'quota_exceeded', 'account storage quota exceeded');
    }
    await c.env.BLOBS.put(key, buf, {
      // Store metadata for serving; the content-type is re-sanitized on the way out regardless.
      httpMetadata: { contentType: mime },
      customMetadata: { accountId, mime, size: String(buf.byteLength) },
    });
  }

  // file-notes spec §4.2 — pre-bake the two WebP derivatives for image uploads (gate FN-W2). Runs on every
  // upload (even a dedup hit) because the bake is idempotent + non-fatal: it retries a previously-failed derive
  // and skips an already-baked one, and a failure here NEVER fails the upload (the original blob is stored).
  // Images > 20 MB exceed the IMAGES input cap (§4.5) → the transform simply fails non-fatally (no thumbnail),
  // which is the spec's chosen behavior (store original, fall back to icon).
  if (BAKEABLE_IMAGE_TYPES.has(mime)) {
    await bakeImageDerivatives(c.env, accountId, hash, buf);
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

/**
 * Inline WebP derivative serving (file-notes spec §4.4; gate FN-W5). The ONE place blob bytes are served
 * NON-attachment — safe ONLY because it exclusively serves the HOST-GENERATED WebP derivatives baked at upload
 * (§4.2), never user-supplied bytes/mime, so the active-content XSS surface stays closed:
 *   - The Content-Type is HARDCODED `image/webp` — never the stored/user mime (defense even if a stub mislabels).
 *   - The R2 key is `{server-derived accountId}/{hash}.{suffix}.webp`. A user upload can only ever write
 *     `{accountId}/{64-hex-hash}` (no suffix), so it is structurally impossible to plant bytes at a derivative
 *     key → these routes can only ever return host-baked output.
 *   - Same accountId-prefix BOLA boundary as the main GET: another account's prefix simply has nothing → 404.
 * nosniff + the fully-sandboxed CSP still ride along (defense-in-depth). Disposition is `inline` (vs the main
 * GET's `attachment`); the main blob GET's attachment serving is unchanged.
 */
function serveDerivative(suffix: string) {
  return async (c: AppContext): Promise<Response> => {
    const accountId = await resolveAccountId(c);
    if (!accountId) return apiError(c, 401, 'unauthorized', 'blob storage requires an authenticated session');
    if (!c.env.BLOBS) return apiError(c, 503, 'blob_not_configured', 'blob storage is unavailable (R2 unbound)');

    const hash = c.req.param('hash');
    if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return apiError(c, 400, 'invalid_request', 'invalid blob id');

    const object = await c.env.BLOBS.get(`${accountId}/${hash}.${suffix}`);
    if (!object) return apiError(c, 404, 'not_found', 'derivative not found');

    return new Response(object.body, {
      headers: {
        // HARDCODED — a derivative is ALWAYS host-baked WebP; never echo a stored/user-supplied content-type.
        'Content-Type': 'image/webp',
        'Content-Disposition': 'inline',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cache-Control': 'private, max-age=31536000, immutable', // content-addressed → immutable
      },
    });
  };
}

/** GET /:hash/thumb — the 256² square list tile (inline WebP). */
blob.get('/:hash/thumb', serveDerivative('thumb.webp'));
/** GET /:hash/view — the ≤2048px open-view preview (inline WebP). */
blob.get('/:hash/view', serveDerivative('view.webp'));
