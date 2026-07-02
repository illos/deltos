import type { Env } from './env.js';
import { createAuthStore } from './db/authStore.js';
import { d1Adapter } from './db/schema.js';
import { DAILY_QUOTA, dayBucket } from './abusePolicy.js';
import type { UsageDecision } from './usage.js';

/**
 * Content-addressed BLOB STORE — the internal store+bake helper shared by the buffered upload route
 * (routes/blob.ts POST /) and the MCP file write-tools (mcp/tools.ts create_file_note / embed_file). It owns
 * the SECURITY-LOAD-BEARING invariants once, so every caller inherits them and none can drift:
 *   - the R2 key is `{accountId}/{hash}` where accountId is SERVER-DERIVED (the caller passes the principal's
 *     accountId, NEVER a client value) and hash is SERVER-COMPUTED SHA-256 of the actual bytes → BOLA-safe by
 *     key construction (a caller can only ever write under its own prefix);
 *   - the daily blobWrite denial-of-wallet quota is charged HERE (fail-closed) before the R2 put;
 *   - content-addressed dedup (an identical upload is a no-op and never double-counts the byte quota);
 *   - image WebP derivatives are pre-baked (idempotent + non-fatal).
 * Serving (safe headers), presign, and confirm stay in routes/blob.ts — this is only the write/store path.
 */

/** Per-object hard cap. Matches the transcribe final-pass ceiling; raise only with a secSys ruling. */
export const MAX_BLOB_SIZE = 25 * 1024 * 1024;
/** Per-account total stored bytes. Coarse v1 quota (summed from R2 list); a durable counter is a later add. */
export const ACCOUNT_BLOB_QUOTA = 10 * 1024 * 1024 * 1024;

/** Content-types safe to hand back with their real type (images can't execute). Everything else → octet. */
export const SAFE_INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/**
 * Image inputs we pre-bake WebP derivatives for (file-notes spec §4.2). The SAFE_INLINE image set plus HEIC/HEIF
 * — `env.IMAGES` decodes HEIC on all plans (FN-W4), and the user never sees the raw HEIC bytes inline (browsers
 * can't decode them), only the host-baked WebP. The derivative bake is content-format-agnostic; this set only
 * decides WHICH uploads are worth a bake.
 */
export const BAKEABLE_IMAGE_TYPES = new Set([...SAFE_INLINE_TYPES, 'image/heic', 'image/heif']);

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
export function safeServeType(stored: string | undefined): string {
  return stored && SAFE_INLINE_TYPES.has(stored) ? stored : 'application/octet-stream';
}

export function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

export async function accountUsage(bucket: R2Bucket, accountId: string): Promise<number> {
  let total = 0;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: `${accountId}/`, ...(cursor ? { cursor } : {}) });
    for (const obj of page.objects) total += obj.size;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return total;
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

/** The outcome of a store attempt — the union both callers map to their own error surface (HTTP vs tool-error). */
export type StoreBlobResult =
  | { ok: true; hash: string; size: number }
  | { ok: false; kind: 'unconfigured' }
  | { ok: false; kind: 'empty' }
  | { ok: false; kind: 'too_large' }
  | { ok: false; kind: 'hash_mismatch' }
  | { ok: false; kind: 'quota_write'; decision: UsageDecision }
  | { ok: false; kind: 'account_quota' };

/**
 * Store `bytes` under the server-derived `{accountId}/{hash}` key, charging the daily blobWrite quota, deduping,
 * enforcing the per-account byte quota, and pre-baking image derivatives. Returns a discriminated union so the
 * caller renders its own error (routes/blob.ts → HTTP status; MCP tools → tool-error). `accountId` MUST be the
 * principal's server-derived account — never a client value — or the BOLA key boundary is void.
 *
 * `opts.claimedHash`: an optional client-asserted hash checked against the SERVER hash BEFORE any quota charge
 * (integrity; the key always uses the server hash). MCP tools don't send one; the upload route forwards its
 * `x-blob-sha256` header.
 */
export async function storeBlob(
  env: Env,
  accountId: string,
  bytes: ArrayBuffer,
  mime: string,
  opts: { claimedHash?: string } = {},
): Promise<StoreBlobResult> {
  const bucket = env.BLOBS;
  if (!bucket) return { ok: false, kind: 'unconfigured' };
  if (bytes.byteLength === 0) return { ok: false, kind: 'empty' };
  if (bytes.byteLength > MAX_BLOB_SIZE) return { ok: false, kind: 'too_large' };

  // Server-computed content hash — the host's address, not the client's word for it.
  const hash = toHex(await crypto.subtle.digest('SHA-256', bytes));
  // Integrity: a client hash hint MUST equal the server hash (checked BEFORE charging so a tamper/bug doesn't
  // burn quota). The key uses the SERVER hash regardless.
  if (opts.claimedHash && opts.claimedHash.toLowerCase() !== hash) {
    return { ok: false, kind: 'hash_mismatch' };
  }

  // Tier-2 denial-of-wallet daily quota (ROAD-0005 P4): meter the WRITE on the server-derived account BEFORE
  // touching R2; over-cap → deny until the UTC day rolls. Fail-CLOSED.
  const nowMs = Date.now();
  const store = createAuthStore(d1Adapter(env.DB));
  const { allowed, count } = await store.chargeUsage(
    accountId,
    'blobWrite',
    dayBucket(nowMs),
    DAILY_QUOTA.blobWrite,
    new Date(nowMs).toISOString(),
  );
  if (!allowed) {
    return {
      ok: false,
      kind: 'quota_write',
      decision: { allowed, count, cap: DAILY_QUOTA.blobWrite, metric: 'blobWrite' },
    };
  }

  const key = `${accountId}/${hash}`;
  // Dedup: content-addressed, so an identical upload is a no-op (and must not double-count the byte quota).
  const existing = await bucket.head(key);
  if (!existing) {
    const used = await accountUsage(bucket, accountId);
    if (used + bytes.byteLength > ACCOUNT_BLOB_QUOTA) {
      return { ok: false, kind: 'account_quota' };
    }
    await bucket.put(key, bytes, {
      // Store metadata for serving; the content-type is re-sanitized on the way out regardless.
      httpMetadata: { contentType: mime },
      customMetadata: { accountId, mime, size: String(bytes.byteLength) },
    });
  }

  // Pre-bake the two WebP derivatives for image uploads (gate FN-W2). Runs on every store (even a dedup hit)
  // because the bake is idempotent + non-fatal: it retries a previously-failed derive and skips an already-baked
  // one, and a failure here NEVER fails the store (the original blob is stored).
  if (BAKEABLE_IMAGE_TYPES.has(mime)) {
    await bakeImageDerivatives(env, accountId, hash, bytes);
  }

  return { ok: true, hash, size: bytes.byteLength };
}
