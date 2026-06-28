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

const BLOB_API = '/api/plugin/blob';

export interface UploadedBlob {
  hash: string;
  size: number;
}

function authHeaders(): Record<string, string> {
  const token = useAuthStore.getState().bearerToken;
  return token ? { Authorization: `Bearer ${token}` } : {};
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

/** Persist bytes for `[accountId+resourceKey]` then LRU-evict to the size budget. Best-effort (fire-and-forget):
 *  a storage error never breaks the read path — the network already returned the bytes. */
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
 * The single cached-fetch primitive every blob read goes through. memory → IndexedDB (account-scoped) →
 * network (authed). On an IndexedDB hit: touch lastAccess, populate memory, return — no network, no bearer.
 * On a network success: populate memory + persist fire-and-forget. With `accountId===null` the cache is
 * bypassed entirely (network-only). Throws on a network miss/offline → the caller degrades.
 */
async function fetchBytesCached(
  accountId: string | null,
  resourceKey: string,
  fetchPath: string,
  mime?: string,
): Promise<ArrayBuffer> {
  if (accountId) {
    const mk = memKey(accountId, resourceKey);
    const mem = bytesMem.get(mk);
    if (mem) return mem;
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
      return row.bytes;
    }
  }
  const res = await fetch(fetchPath, { headers: authHeaders() });
  if (!res.ok) throw new Error(`blob load failed (${res.status})`);
  const bytes = await res.arrayBuffer();
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
export async function loadBlobBytes(hash: string): Promise<ArrayBuffer> {
  return fetchBytesCached(currentAccountId(), hash, `${BLOB_API}/${hash}`);
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
