/**
 * Blob host-capability CLIENT (plugin-support §7, A4 #126). The client SEAM to the server-enforced blob
 * route — upload bytes, load bytes back as an object URL. It is NOT the gate: the server derives the
 * accountId + enforces scope/quota/safe-serving; this just carries the bearer and the bytes.
 *
 * Used only by the EDIT path (the attachment NodeView / insertion). The render-only path is fetch-free
 * (light previews), so it never imports this.
 */
import { useAuthStore } from '../../auth/store.js';
import { db } from '../../db/schema.js';
import { onLocalWipe } from '../../db/accountScope.js';

const BLOB_API = '/api/plugin/blob';

export interface UploadedBlob {
  hash: string;
  size: number;
}

function authHeaders(): Record<string, string> {
  const token = useAuthStore.getState().bearerToken;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Which cache tier a successful byte-load came from — surfaced to callers (the PDF reader) for diagnosis. */
export type BlobLoadTier = 'memory' | 'indexeddb' | 'network';

/** Optional sink a caller passes to `loadBlobBytes` to learn which tier served the bytes (diagnostics only). */
export interface BlobLoadMeta {
  tier?: BlobLoadTier;
}

/**
 * A byte-fetch failure carrying the ground-truth a UI error path needs to diagnose it (the PDF reader surfaces
 * this under "Couldn't open this PDF" so an on-device/iOS failure can be screenshotted without a console):
 *   - `status`  — the HTTP status when the network responded non-OK (e.g. 401/404); undefined when offline;
 *   - `hadBearer` — whether an Authorization bearer was attached to the request (a 401 with no bearer = the
 *      pre-auth cold-boot race; a 401 WITH a bearer = a genuinely rejected token);
 *   - `offline` — the fetch itself rejected (network down / no response).
 * It is a plain `Error` subclass with the historical `blob load failed (…)` message, so existing generic
 * `catch`/degrade paths are unaffected.
 */
export class BlobLoadError extends Error {
  readonly status: number | undefined;
  readonly hadBearer: boolean;
  readonly offline: boolean;
  constructor(message: string, info: { status?: number; hadBearer: boolean; offline: boolean }) {
    super(message);
    this.name = 'BlobLoadError';
    this.status = info.status;
    this.hadBearer = info.hadBearer;
    this.offline = info.offline;
  }
}

/** The resident data-ownership account (D6 scope). null = truly unauthed → the local cache is OFF (no
 *  anonymous bucket; never read or write under a null account). Read live each call so a switch is honored. */
function currentAccountId(): string | null {
  return useAuthStore.getState().accountId;
}

/**
 * Content-addressed local blob cache (blob-cache feature). Fixes BOTH the "PDF doesn't reload on mobile
 * return" latch AND makes reopening any blob (PDF/image) instant + offline-capable:
 *   - memory cache (session) → IndexedDB (`db.blobCache`, account-scoped, survives reload/eviction) → network.
 *   - an IndexedDB hit returns WITHOUT touching the network or the bearer — this is what makes a cold/evicted
 *     mobile return open the PDF without re-racing the pre-auth refresh window (the 401-latch bug), and what
 *     makes a reopen zero-cost + fully offline.
 *
 * ACCOUNT ISOLATION (HARD): the row PK is `[accountId+resourceKey]`, scoped to the LIVE accountId. Account B
 * can never read account A's bytes even for an identical hash (different PK row). `accountId===null` → no
 * read, no write (network-only; the caller degrades on the inevitable 401). The whole table is dropped by
 * `wipeLocalState` on account-switch + logout. F7: only bytes + accountId + hash + mime + size persist —
 * NEVER the bearer/token.
 */

// ~200 MB LRU budget across the (single-resident-account) table; single entries are ≤25 MB (server cap).
const CACHE_BUDGET_BYTES = 200 * 1024 * 1024;

// Session memory caches, keyed by `${accountId}::${resourceKey}` (account-scoped even in memory). Wiped on
// reload; the IndexedDB layer is the durable tier.
const bytesMem = new Map<string, ArrayBuffer>();
const urlMem = new Map<string, string>();

function memKey(accountId: string, resourceKey: string): string {
  return `${accountId}::${resourceKey}`;
}

/**
 * Release the session memory tiers (bytes + object URLs) and `revokeObjectURL` every live `blob:` URL.
 * Called by the account-scope wipe seam (db/accountScope.ts `onLocalWipe`) on switch/logout so a prior
 * account's in-memory bytes/URLs don't linger this session (memory hygiene + no leaked object URLs).
 * Account ISOLATION is already enforced by the per-account PK + the IndexedDB wipe; this is the in-memory
 * counterpart. Idempotent and safe to call anytime (including in a non-DOM/test env — revoke is guarded).
 */
export function resetBlobMemory(): void {
  for (const url of urlMem.values()) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* no DOM URL in this env (or already revoked) — nothing to release */
    }
  }
  urlMem.clear();
  bytesMem.clear();
}

// Register the in-memory release with the core wipe seam. The dependency points plugin → core (core never
// imports this lazily-split module — see db/mutate.ts), so registering here keeps blobClient OUT of the core
// bundle while still being released on every account switch/logout. Runs once when this module first loads;
// a session that never loaded blobClient holds no blob memory, so the absent registration is a correct no-op.
onLocalWipe(resetBlobMemory);

/** Persist bytes for `[accountId+resourceKey]` (+ its size-only meta mirror) then LRU-evict to the size budget.
 *  Best-effort (fire-and-forget): a storage error never breaks the read path — the network already returned the
 *  bytes. The bytes row and its meta row are written in ONE transaction so they can never diverge. */
async function persistBytes(
  accountId: string,
  resourceKey: string,
  bytes: ArrayBuffer,
  mime: string | undefined,
): Promise<void> {
  try {
    const now = Date.now();
    const size = bytes.byteLength;
    await db.transaction('rw', db.blobCache, db.blobCacheMeta, async () => {
      await db.blobCache.put({
        accountId,
        resourceKey,
        bytes,
        ...(mime ? { mime } : {}),
        size,
        lastAccess: now,
      });
      await db.blobCacheMeta.put({ accountId, resourceKey, size, lastAccess: now });
    });
    await evictToBudget();
  } catch {
    /* cache is best-effort; the caller already has its bytes */
  }
}

/**
 * Delete oldest-by-lastAccess entries until the total cached size is within budget. Runs after each write.
 *
 * PERF (Jim's load north-star): the size math + victim selection operate ENTIRELY on the size-only
 * `blobCacheMeta` sidecar — tiny rows that carry no `bytes` — so a normal blob persist NEVER deserializes any
 * cached `ArrayBuffer` (up to ~200 MB) just to sum sizes. Victims are removed from BOTH tables in lockstep.
 */
async function evictToBudget(): Promise<void> {
  const metas = await db.blobCacheMeta.orderBy('lastAccess').toArray(); // no bytes loaded — meta is size-only
  let total = 0;
  for (const m of metas) total += m.size;
  for (const m of metas) {
    if (total <= CACHE_BUDGET_BYTES) break;
    await db.transaction('rw', db.blobCache, db.blobCacheMeta, async () => {
      await db.blobCache.delete([m.accountId, m.resourceKey]);
      await db.blobCacheMeta.delete([m.accountId, m.resourceKey]);
    });
    total -= m.size;
  }
}

/**
 * Coalesce the on-auth-reject access-token re-mint so N blob reads on one note share ONE `/refresh` (mirrors
 * `syncEngine.remintOnce`). A blob GET carries the SHORT-TTL (15-min) in-memory access token; the sync engine
 * already re-mints-and-retries on this exact 401/403/503 family (GOTCHA-0001), but the blob path did NOT — so
 * a note opened with a just-expired token got a 403 straight to the placeholder chip, and only a LATER bearer-
 * identity change (a sync cycle's own re-mint) re-fired the load. That's the "images render as placeholders
 * until I leave and come back" bug: leave+return remounts the NodeView after the sync remint has landed. Now
 * the blob path re-mints in place and retries, so the image resolves on FIRST open. Module-level = shared.
 */
let _blobRemintInFlight: Promise<'ok' | 'revoked' | 'offline'> | null = null;
function remintBlobBearerOnce(): Promise<'ok' | 'revoked' | 'offline'> {
  if (!_blobRemintInFlight) {
    _blobRemintInFlight = useAuthStore.getState().remintBearer().finally(() => { _blobRemintInFlight = null; });
  }
  return _blobRemintInFlight;
}

/**
 * The single cached-fetch primitive every blob read goes through. memory → IndexedDB (account-scoped) →
 * network (authed). On an IndexedDB hit: touch lastAccess, populate memory, return — no network, no bearer.
 * On a network success: populate memory + persist fire-and-forget. With `accountId===null` the cache is
 * bypassed entirely (network-only). On a 401/403/503 (expired/absent access token) it re-mints the bearer
 * ONCE and retries — the same recovery the sync engine does (GOTCHA-0001), so a stale-token open self-heals
 * instead of latching the placeholder. Throws on a network miss/offline → the caller degrades (shows the chip).
 */
async function fetchBytesCached(
  accountId: string | null,
  resourceKey: string,
  fetchPath: string,
  mime?: string,
  meta?: BlobLoadMeta,
): Promise<ArrayBuffer> {
  if (accountId) {
    const mk = memKey(accountId, resourceKey);
    const mem = bytesMem.get(mk);
    if (mem) {
      if (meta) meta.tier = 'memory';
      return mem;
    }
    let row: { bytes: ArrayBuffer; size: number } | undefined;
    try {
      row = await db.blobCache.get([accountId, resourceKey]);
    } catch {
      row = undefined; // storage unavailable — fall through to network
    }
    if (row) {
      bytesMem.set(mk, row.bytes);
      // Touch the LRU timestamp on the size-only sidecar ONLY (fire-and-forget) — a failed touch loses recency,
      // not correctness. Doing it on the meta row (not the bytes row) keeps a hit from rewriting up to 25 MB of
      // bytes just to bump recency, and backfills meta for any legacy row written before the sidecar existed.
      void db.blobCacheMeta
        .put({ accountId, resourceKey, size: row.size, lastAccess: Date.now() })
        .catch(() => {});
      if (meta) meta.tier = 'indexeddb';
      return row.bytes;
    }
  }
  // Send with the CURRENT bearer each attempt (re-read after a re-mint so the retry carries the fresh token).
  let hadBearer = false;
  const send = (): Promise<Response> => {
    const headers = authHeaders();
    hadBearer = 'Authorization' in headers;
    return fetch(fetchPath, { headers });
  };
  let res: Response;
  try {
    res = await send();
    // 403 = expired access token (the common 15-min-TTL case), 401 = defensive, 503 = absent bearer. Re-mint
    // from the httpOnly refresh cookie ONCE and retry — mirrors syncFetch. A dead cookie ('revoked') or no
    // network ('offline') means the retry can't help, so fall through and let the !ok / catch degrade to the chip.
    if (res.status === 401 || res.status === 403 || res.status === 503) {
      const outcome = await remintBlobBearerOnce();
      if (outcome === 'ok') res = await send();
    }
  } catch {
    // The fetch itself rejected → offline / no response. Carry that (no HTTP status) for diagnosis.
    throw new BlobLoadError('blob load failed (network)', { hadBearer, offline: true });
  }
  if (!res.ok) throw new BlobLoadError(`blob load failed (${res.status})`, { status: res.status, hadBearer, offline: false });
  const bytes = await res.arrayBuffer();
  if (meta) meta.tier = 'network';
  if (accountId) {
    bytesMem.set(memKey(accountId, resourceKey), bytes);
    // Fire-and-forget persist under the account captured at fetch time. A switch DURING this persist is
    // isolation-safe: the store is content-addressed and the server enforces per-account hash ownership, so a
    // row written under the captured account can only ever hold content that account already references —
    // never another account's bytes, even if the resident account changed mid-flight.
    void persistBytes(accountId, resourceKey, bytes, mime);
  }
  return bytes;
}

/** Upload a file to content-addressed R2. The server hashes + keys it under the caller's account. */
export async function uploadBlob(file: File): Promise<UploadedBlob> {
  const mime = file.type || 'application/octet-stream';
  const res = await fetch(BLOB_API, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': mime, 'X-Blob-Mime': mime },
    body: file,
  });
  if (!res.ok) throw new Error(`blob upload failed (${res.status})`);
  return (await res.json()) as UploadedBlob;
}

/** What the presign endpoint returns (direct-r2-upload.md §3.1): the URL to PUT to + the EXACT headers to send. */
interface PresignResponse {
  url: string;
  headers: Record<string, string>;
}

/** Options for {@link uploadBlobDirect}: a progress sink (0..1) + an AbortSignal to cancel the in-flight PUT. */
export interface DirectUploadOptions {
  /** Called with fractional progress (loaded/total, 0..1) as the bytes stream to R2. */
  onProgress?: (fraction: number) => void;
  /** Abort the upload — aborts the XHR; the promise rejects with an AbortError and NO note is minted. */
  signal?: AbortSignal;
}

/** Hex-encode an ArrayBuffer (SHA-256 digest → 64-char lowercase hex), matching the Worker's key/hash form. */
function bufferToHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/**
 * PUT the file bytes STRAIGHT to R2 over the presigned URL (direct-r2-upload.md §3.2). Uses XMLHttpRequest —
 * not fetch — because only XHR exposes `upload.onprogress` for a request BODY (fetch has no upload-progress
 * in browsers). The PUT carries NO bearer: it is authorized by the presigned SigV4 signature, not the deltos
 * session (R2 has no notion of the session). R2 rejects the object unless the body's SHA-256 matches the
 * signed `x-amz-checksum-sha256` → a non-2xx (incl. R2's checksum 400) rejects the promise → no note minted.
 */
function putToR2(url: string, headers: Record<string, string>, file: File, opts: DirectUploadOptions): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const { signal, onProgress } = opts;
    if (signal?.aborted) {
      reject(new DOMException('upload aborted', 'AbortError'));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);

    const onAbort = () => xhr.abort();
    signal?.addEventListener('abort', onAbort);
    const cleanup = () => signal?.removeEventListener('abort', onAbort);

    xhr.upload.onprogress = (e) => {
      if (onProgress && e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      cleanup();
      if (xhr.status >= 200 && xhr.status < 300) {
        if (onProgress) onProgress(1); // settle the bar at 100% on success
        resolve();
      } else {
        reject(new Error(`direct upload rejected by R2 (${xhr.status})`));
      }
    };
    // A network-level failure (offline, CORS) — direct path is online-only; surface it so no note is minted.
    xhr.onerror = () => { cleanup(); reject(new Error('direct upload failed (network)')); };
    xhr.onabort = () => { cleanup(); reject(new DOMException('upload aborted', 'AbortError')); };

    xhr.send(file);
  });
}

/**
 * Upload a LARGE file (> DIRECT_R2_THRESHOLD) STRAIGHT to R2, bypassing the Worker's byte path
 * (direct-r2-upload.md §3 / §6.2). The sibling of {@link uploadBlob}; returns the SAME `{ hash, size }` shape
 * so `createFileNote` mints the note path-agnostically. Three steps, the Worker in only steps 1 + 3 (no bytes):
 *   1. HASH the file client-side (SHA-256 → hex) — the content-address R2 will enforce.
 *   2. POST /presign (bearer-authed) → a presigned PUT URL + the exact signed headers.
 *   3. PUT the bytes direct to R2 with upload-progress (XHR), then POST /confirm → `{ hash, size }`.
 *
 * PERF / mobile-memory (§8 OQ-3): step 1 reads the whole file into an ArrayBuffer to hash it — acceptable for
 * v1 (desktop-drop is the only entry; `crypto.subtle` has NO streaming digest). A chunked/WASM streaming hash
 * is the documented later optimization for multi-hundred-MB mobile uploads; NOT built here.
 */
export async function uploadBlobDirect(file: File, opts: DirectUploadOptions = {}): Promise<UploadedBlob> {
  const mime = file.type || 'application/octet-stream';

  // 1. Client-side content hash. (Whole-file arrayBuffer read — fine for v1; streaming-hash is the §8 OQ-3 later add.)
  const hash = bufferToHex(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()));
  if (opts.signal?.aborted) throw new DOMException('upload aborted', 'AbortError');

  // 2. Authorize: the Worker fixes the key to {accountId}/{hash} + signs the PUT (the bytes never touch it).
  const presignRes = await fetch(`${BLOB_API}/presign`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ hash, size: file.size, mime }),
  });
  if (!presignRes.ok) throw new Error(`presign failed (${presignRes.status})`);
  const { url, headers } = (await presignRes.json()) as PresignResponse;

  // 3a. PUT the bytes direct to R2 (XHR, progress + cancel). A reject here (R2 checksum 400 / abort / offline)
  //     propagates → createFileNote aborts → no note (upload-first: the note is minted only after confirm).
  await putToR2(url, headers, file, opts);

  // 3b. Record: HEAD-measure the real size + enforce quota post-hoc, returning the SAME shape as uploadBlob.
  const confirmRes = await fetch(`${BLOB_API}/confirm`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ hash, mime }),
  });
  if (!confirmRes.ok) throw new Error(`confirm failed (${confirmRes.status})`);
  return (await confirmRes.json()) as UploadedBlob;
}

const SAFE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Clamp the object-URL type to a known-safe image (the server already sanitized + sent nosniff). */
function safeClientType(mime: string): string {
  return SAFE_IMAGE_TYPES.has(mime) ? mime : 'application/octet-stream';
}

/**
 * Load a blob's bytes and return an object URL for inline display (the EDIT path's image preview). Routes
 * through the content-addressed cache (memory → IndexedDB → network), so a reopen is instant + offline.
 * Throws when offline AND not cached — the caller degrades (shows the chip). The object URL itself is
 * session-memoized per `[accountId+hash]` (immutable content), so repeated mounts reuse one URL.
 */
export async function loadBlobUrl(hash: string, mime: string): Promise<string> {
  const accountId = currentAccountId();
  const urlKey = accountId ? memKey(accountId, hash) : null;
  if (urlKey) {
    const cached = urlMem.get(urlKey);
    if (cached) return cached;
  }
  const bytes = await fetchBytesCached(accountId, hash, `${BLOB_API}/${hash}`, safeClientType(mime));
  const url = URL.createObjectURL(new Blob([bytes], { type: safeClientType(mime) }));
  if (urlKey) urlMem.set(urlKey, url);
  return url;
}

/**
 * Load a blob's raw bytes for a parser that needs the ArrayBuffer — the PDF reader (pdf-reader.md §2.2).
 * Routes through the content-addressed cache (memory → IndexedDB → network): an IndexedDB hit returns the
 * bytes with NO network and NO bearer dependency, which is what lets a cold/evicted mobile return reopen the
 * PDF without re-racing the pre-auth window (the 401-latch bug) — and makes a reopen zero-cost + offline.
 * Authenticated `GET /api/plugin/blob/:hash` on a miss — the SAME route + octet-stream + `attachment` serving
 * as every other blob fetch: no inline serving, no new route, `blob.ts` untouched. Returns the bytes; the
 * caller hands them to pdf.js. Throws on miss/offline → the reader degrades to the icon + Download (gate PDF-2).
 *
 * PIN-STORAGE-1 (pin-storage-1-sw-cache-invariant): the durable tier here is the APP store (Dexie IndexedDB),
 * NOT the SW Cache Storage that PIN-STORAGE-1 governs — like notes, not like `/api/*` runtime-caching. The
 * network miss still hits `/api/*`, which the SW navigation denylist already excludes from Cache Storage.
 */
export async function loadBlobBytes(hash: string, meta?: BlobLoadMeta): Promise<ArrayBuffer> {
  return fetchBytesCached(currentAccountId(), hash, `${BLOB_API}/${hash}`, undefined, meta);
}

/**
 * Load a host-generated WebP derivative (the list-tile `thumb` or the open-view `view`) as an object URL
 * (file-notes.md §4.4). The Slice-1 worker pre-bakes both at upload and serves them INLINE (`image/webp` +
 * nosniff) from `GET /:hash/{thumb|view}` — a plain authenticated R2.get, NO per-render transform. WebP is
 * always safe to inline (it is never user-uploaded active content — only the host derivative), so the type
 * is fixed to `image/webp`. Session-cached by `{variant}:{hash}` (content-addressed → one fetch per session).
 * Throws on miss (404 = derivative not baked yet / non-image); the caller falls back to the format icon.
 */
async function loadDerivativeUrl(hash: string, variant: 'thumb' | 'view'): Promise<string> {
  // resourceKey distinguishes the derivative from the original under the same hash (different content).
  const resourceKey = `${hash}:${variant}`;
  const accountId = currentAccountId();
  const urlKey = accountId ? memKey(accountId, resourceKey) : null;
  if (urlKey) {
    const cached = urlMem.get(urlKey);
    if (cached) return cached;
  }
  const bytes = await fetchBytesCached(accountId, resourceKey, `${BLOB_API}/${hash}/${variant}`, 'image/webp');
  const url = URL.createObjectURL(new Blob([bytes], { type: 'image/webp' }));
  if (urlKey) urlMem.set(urlKey, url);
  return url;
}

/** The square 256² list-tile WebP derivative as an object URL (file-notes.md §3.1 / §4.4). */
export function loadThumbUrl(hash: string): Promise<string> {
  return loadDerivativeUrl(hash, 'thumb');
}

/** The ≤2048px full-view WebP derivative as an object URL for the open viewer (file-notes.md §3.2 / §4.4). */
export function loadViewUrl(hash: string): Promise<string> {
  return loadDerivativeUrl(hash, 'view');
}

/**
 * The HARD safe-type gate (secSys #694): a stored blob may be object-URL-rendered INLINE only when it is a
 * known-safe raster image (png/jpeg/gif/webp). Everything else — html, svg, pdf, unknown — must NEVER be
 * inline-rendered (a blob: URL of html/svg would re-introduce the XSS the server prevents); it becomes a
 * download chip. This is THE allowlist the node-view gates on.
 */
export function isInlineRenderableImage(mime: string | undefined): boolean {
  return !!mime && SAFE_IMAGE_TYPES.has(mime);
}

/** Download a stored blob (the non-image / unsafe path — never inline). Forces octet-stream bytes. */
export async function downloadBlob(hash: string, name: string): Promise<void> {
  const url = await loadBlobUrl(hash, 'application/octet-stream');
  const a = document.createElement('a');
  a.href = url;
  a.download = name || 'download';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
