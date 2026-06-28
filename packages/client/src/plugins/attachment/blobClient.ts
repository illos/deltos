/**
 * Blob host-capability CLIENT (plugin-support §7, A4 #126). The client SEAM to the server-enforced blob
 * route — upload bytes, load bytes back as an object URL. It is NOT the gate: the server derives the
 * accountId + enforces scope/quota/safe-serving; this just carries the bearer and the bytes.
 *
 * Used only by the EDIT path (the attachment NodeView / insertion). The render-only path is fetch-free
 * (light previews), so it never imports this.
 */
import { useAuthStore } from '../../auth/store.js';

const BLOB_API = '/api/plugin/blob';

export interface UploadedBlob {
  hash: string;
  size: number;
}

function authHeaders(): Record<string, string> {
  const token = useAuthStore.getState().bearerToken;
  return token ? { Authorization: `Bearer ${token}` } : {};
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

// Session object-URL cache — content-addressed + immutable, so one fetch per hash per session.
const urlCache = new Map<string, string>();

/**
 * Load a blob's bytes and return an object URL for inline display (the EDIT path's image preview). Throws
 * when offline / not cached — the caller degrades (shows the chip). Content-addressed → cached for the
 * session.
 */
export async function loadBlobUrl(hash: string, mime: string): Promise<string> {
  const cached = urlCache.get(hash);
  if (cached) return cached;
  const res = await fetch(`${BLOB_API}/${hash}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`blob load failed (${res.status})`);
  const bytes = await res.arrayBuffer();
  const url = URL.createObjectURL(new Blob([bytes], { type: safeClientType(mime) }));
  urlCache.set(hash, url);
  return url;
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
  const cacheKey = `${variant}:${hash}`;
  const cached = urlCache.get(cacheKey);
  if (cached) return cached;
  const res = await fetch(`${BLOB_API}/${hash}/${variant}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`blob ${variant} load failed (${res.status})`);
  const bytes = await res.arrayBuffer();
  const url = URL.createObjectURL(new Blob([bytes], { type: 'image/webp' }));
  urlCache.set(cacheKey, url);
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
