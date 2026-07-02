import { Hono } from 'hono';
import { AwsClient } from 'aws4fetch';
import type { AppEnv, AppContext } from '../context.js';
import { apiError, NON_PROD_ENVIRONMENTS } from '../http.js';
import { resolvePrincipal } from '../auth.js';
import { chargeUsage, quotaExceeded } from '../usage.js';
import {
  storeBlob,
  safeServeType,
  accountUsage,
  ACCOUNT_BLOB_QUOTA,
  MAX_BLOB_SIZE,
} from '../blobStore.js';

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
 *      per-account RATE limiting is now ENFORCED (Tier-2 daily blobWrite quota, ROAD-0005 P4) on the WRITE
 *      paths (buffered upload + presign) — the deferral the transcribe-throttle ruling flagged is closed.
 */

/**
 * Direct-to-R2 large-file path (direct-r2-upload.md §3, Slice 1). Files > MAX_BLOB_SIZE can't ride the
 * buffered path (the Worker would buffer the whole body against the 128 MB memory / ~100 MB request limits),
 * so the client uploads them STRAIGHT to R2 over a presigned PUT URL the Worker signs for exactly one key.
 */
/** Upper bound for a single presigned PUT (§3.4 — single-PUT regime; multipart is the documented v2 upgrade). */
const MAX_DIRECT_BLOB_SIZE = 2 * 1024 * 1024 * 1024;
/** Presigned-URL TTL (§3.4). Generous (1h) — safe BECAUSE the URL is scoped to one key + one checksum, so a
 * leaked URL can only re-upload the identical pre-chosen bytes to the owner's own slot (no marginal risk). */
const PRESIGN_TTL_SECONDS = 3600;
/** R2 S3-API bucket name (matches `wrangler.jsonc` r2_buckets bucket_name — the BLOBS binding's target). */
const BLOB_BUCKET = 'deltos-blobs';

/**
 * Convert a validated 64-char hex SHA-256 into the base64 of the raw 32 hash bytes — the value R2 expects in
 * `x-amz-checksum-sha256`. Derived from the SAME hash that fixes the key, so the signed checksum and the key's
 * hash can NEVER be decoupled by the client (the integrity binding; direct-r2-upload.md §3.1 / DR-S ②).
 */
function hexToChecksumBase64(hex: string): string {
  let bin = '';
  for (let i = 0; i < hex.length; i += 2) bin += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  return btoa(bin);
}

/** Resolve the caller's verified accountId, or null if unauthenticated (mirrors transcribe's F13 tripwire). */
async function resolveAccountId(c: AppContext): Promise<string | null> {
  const principal = await resolvePrincipal(c);
  if (principal.verification.method === 'unverified' && !NON_PROD_ENVIRONMENTS.has(c.env.ENVIRONMENT ?? '')) {
    return null;
  }
  return principal.id;
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
  const mime = c.req.header('x-blob-mime') ?? c.req.header('content-type') ?? 'application/octet-stream';

  // The shared store owns hash + BOLA key + blobWrite quota + dedup + byte-quota + image bake (blobStore.ts);
  // this route just maps its outcome to the HTTP contract. The client's optional `x-blob-sha256` hint is
  // integrity-checked (against the SERVER hash) before any quota charge.
  const claimedHash = c.req.header('x-blob-sha256');
  const result = await storeBlob(c.env, accountId, buf, mime, claimedHash ? { claimedHash } : {});
  if (result.ok) return c.json({ hash: result.hash, size: result.size });
  switch (result.kind) {
    case 'unconfigured':
      return apiError(c, 503, 'blob_not_configured', 'blob storage is unavailable (R2 unbound)');
    case 'empty':
      return apiError(c, 400, 'invalid_request', 'empty file body');
    case 'too_large':
      return apiError(c, 413, 'payload_too_large', 'file exceeds the maximum size');
    case 'hash_mismatch':
      return apiError(c, 400, 'hash_mismatch', 'declared content hash does not match the uploaded bytes');
    case 'quota_write':
      return quotaExceeded(c, result.decision);
    case 'account_quota':
      return apiError(c, 413, 'quota_exceeded', 'account storage quota exceeded');
  }
});

/**
 * Presign a direct-to-R2 PUT for a LARGE file (direct-r2-upload.md §3.1, Slice 1). The Worker authorizes only:
 * it derives the accountId from the bearer, FIXES the key to `${accountId}/${hash}` (never client-supplied), and
 * signs a short-lived presigned PUT URL with `x-amz-checksum-sha256` as a SIGNED header whose value is the base64
 * of the SAME validated hash — so the key and the integrity checksum cannot be decoupled by the client (DR-S ①②).
 * The bytes never touch the Worker; R2 enforces the content-address (SHA-256(body) === hash) on receipt.
 */
blob.post('/presign', async (c: AppContext) => {
  const accountId = await resolveAccountId(c);
  if (!accountId) return apiError(c, 401, 'unauthorized', 'blob storage requires an authenticated session');
  if (!c.env.BLOBS) return apiError(c, 503, 'blob_not_configured', 'blob storage is unavailable (R2 unbound)');

  // Presigning needs the R2 S3-API token (Worker SECRETS, never the client/bundle) + the S3 endpoint host
  // (derived from the account_id; a non-secret var). Fail-closed if any is unset.
  const accessKeyId = c.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = c.env.R2_SECRET_ACCESS_KEY;
  const endpoint = c.env.R2_S3_ENDPOINT;
  if (!accessKeyId || !secretAccessKey || !endpoint) {
    return apiError(c, 503, 'blob_direct_not_configured', 'direct upload is unavailable (R2 S3 credentials unset)');
  }

  const body = (await c.req.json().catch(() => null)) as { hash?: unknown; size?: unknown; mime?: unknown } | null;
  const hash = body?.hash;
  const size = body?.size;
  const mime = body?.mime;

  // hex SHA-256 only — the SAME guard the GET route uses, so the key can never be steered (no traversal, no prefix).
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) {
    return apiError(c, 400, 'invalid_request', 'hash must be a 64-char lowercase hex SHA-256');
  }
  if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0) {
    return apiError(c, 400, 'invalid_request', 'size must be a positive integer');
  }
  // Presign is ONLY the large path: a request at/under the buffered cap is a client routing bug (use POST /).
  if (size <= MAX_BLOB_SIZE) {
    return apiError(c, 400, 'invalid_request', 'size is within the buffered upload range; use POST /api/plugin/blob');
  }
  if (size > MAX_DIRECT_BLOB_SIZE) {
    return apiError(c, 413, 'payload_too_large', 'file exceeds the maximum direct-upload size');
  }
  if (typeof mime !== 'string' || mime.length === 0) {
    return apiError(c, 400, 'invalid_request', 'mime is required');
  }

  // Tier-2 denial-of-wallet daily quota (ROAD-0005 P4): meter the presign (= a WRITE intent) on the
  // server-derived account BEFORE signing; over-cap → 429 until the UTC day rolls. Fail-CLOSED. Charging
  // presign covers the upload — /confirm is a cheap finalize and is NOT metered.
  const decision = await chargeUsage(c, accountId, 'blobWrite');
  if (!decision.allowed) return quotaExceeded(c, decision);

  // Advisory pre-flight quota (§3.1): block an obviously-over-quota upload BEFORE it starts. The DECLARED size is
  // client-claimed; the AUTHORITATIVE enforcement is the post-hoc HEAD in /confirm (§3.3). Courtesy gate only.
  const used = await accountUsage(c.env.BLOBS, accountId);
  if (used + size > ACCOUNT_BLOB_QUOTA) {
    return apiError(c, 413, 'quota_exceeded', 'account storage quota exceeded');
  }

  // THE control: the key is server-fixed `${accountId}/${hash}` — accountId from the bearer, hash the validated
  // 64-hex. The client supplies neither the prefix nor an arbitrary key, so a caller can only ever write its own slot.
  const key = `${accountId}/${hash}`;
  const checksumB64 = hexToChecksumBase64(hash);
  const signUrl = `${endpoint.replace(/\/$/, '')}/${BLOB_BUCKET}/${key}?X-Amz-Expires=${PRESIGN_TTL_SECONDS}`;

  // Local SigV4 signing — NO network call. `x-amz-checksum-sha256` is passed in the headers so it is captured in
  // X-Amz-SignedHeaders (it is NOT in aws4fetch's UNSIGNABLE set, unlike content-type) → R2 binds it into the URL
  // and rejects any body whose SHA-256 doesn't match. region 'auto' is R2's SigV4 region.
  const client = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' });
  const signed = await client.sign(signUrl, {
    method: 'PUT',
    headers: { 'x-amz-checksum-sha256': checksumB64, 'content-type': mime },
    aws: { signQuery: true },
  });

  // The client must PUT to `url` sending EXACTLY these headers (the checksum is the signed one; content-type the
  // declared mime). The R2 token never crosses to the client — only the presigned URL does.
  return c.json({
    url: signed.url,
    headers: { 'x-amz-checksum-sha256': checksumB64, 'content-type': mime },
    key,
    expiresIn: PRESIGN_TTL_SECONDS,
  });
});

/**
 * Confirm a direct-to-R2 upload (direct-r2-upload.md §3.3, Slice 1). After the client's PUT lands, the Worker
 * HEADs `${accountId}/${hash}` (the existing BLOBS binding — no S3 creds needed for HEAD/DELETE), reads the REAL
 * R2-measured size, and enforces ACCOUNT_BLOB_QUOTA POST-HOC: an object that pushed the account over quota is
 * DELETED (rollback) and 413'd. Returns `{ hash, size }` — the identical shape `uploadBlob` returns, so
 * `createFileNote` consumes it path-agnostically. No WebP bake (>25 MB ⇒ over the 20 MB IMAGES cap by construction).
 */
blob.post('/confirm', async (c: AppContext) => {
  const accountId = await resolveAccountId(c);
  if (!accountId) return apiError(c, 401, 'unauthorized', 'blob storage requires an authenticated session');
  if (!c.env.BLOBS) return apiError(c, 503, 'blob_not_configured', 'blob storage is unavailable (R2 unbound)');

  const body = (await c.req.json().catch(() => null)) as { hash?: unknown; mime?: unknown } | null;
  const hash = body?.hash;
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) {
    return apiError(c, 400, 'invalid_request', 'hash must be a 64-char lowercase hex SHA-256');
  }

  const key = `${accountId}/${hash}`;
  // HEAD the object — the client claims it uploaded. 404 if absent: never mint a note for a blob that isn't there.
  const head = await c.env.BLOBS.head(key);
  if (!head) {
    return apiError(c, 404, 'not_found', 'no uploaded object found for this hash');
  }
  const size = head.size;

  // Authoritative post-hoc quota: the object is already in R2 (so already counted by accountUsage). If the account
  // is now over quota, roll the just-uploaded object back (DELETE) and 413. A content-addressed re-upload of bytes
  // the account already stored is a same-key overwrite (zero net usage) → never trips this on its own (§3.3 dedup edge).
  const used = await accountUsage(c.env.BLOBS, accountId);
  if (used > ACCOUNT_BLOB_QUOTA) {
    await c.env.BLOBS.delete(key);
    return apiError(c, 413, 'quota_exceeded', 'account storage quota exceeded');
  }

  // Identical shape to uploadBlob's response, so createFileNote is path-agnostic below the size router.
  return c.json({ hash, size });
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
