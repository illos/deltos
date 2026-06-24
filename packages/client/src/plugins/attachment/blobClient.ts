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

/** Whether a stored mime is a previewable image (drives image-vs-chip rendering). */
export function isPreviewableImage(mime: string | undefined): boolean {
  return !!mime && SAFE_IMAGE_TYPES.has(mime);
}
