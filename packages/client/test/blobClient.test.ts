/**
 * #126 A4 — the blob host-capability CLIENT seam. Upload carries the bearer + mime; load fetches once then
 * caches an object URL. (The SERVER is the gate — these tests cover the client carrier, with fetch mocked.)
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { uploadBlob, loadBlobUrl, isInlineRenderableImage } from '../src/plugins/attachment/blobClient.js';
import { useAuthStore } from '../src/auth/store.js';

beforeEach(() => {
  // accountId is required for the content-addressed local cache to engage (no anonymous bucket — the cache
  // is account-scoped, like notes). A real loaded blob always has a resident account; set one here so the
  // session-memoization path is exercised. IndexedDB is absent in this jsdom env (no fake-indexeddb import),
  // so the durable tier is skipped gracefully and the memory tier provides the fetch-once caching asserted.
  useAuthStore.setState({ bearerToken: 'tok-123', accountId: 'acct-test' });
  const createObjectURL = vi.fn(() => 'blob:cached');
  // jsdom lacks URL.createObjectURL — install a stub.
  (URL as unknown as { createObjectURL: unknown }).createObjectURL = createObjectURL;
});
afterEach(() => vi.restoreAllMocks());

describe('#126 blobClient', () => {
  it('uploadBlob POSTs bytes with the bearer + mime, returns {hash,size}', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ hash: 'a'.repeat(64), size: 3 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const file = new File([new Uint8Array([1, 2, 3])], 'x.png', { type: 'image/png' });

    const r = await uploadBlob(file);
    expect(r).toEqual({ hash: 'a'.repeat(64), size: 3 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/plugin/blob');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-123');
    expect((init.headers as Record<string, string>)['X-Blob-Mime']).toBe('image/png');
  });

  it('uploadBlob throws on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 413 })));
    await expect(uploadBlob(new File(['x'], 'big.bin'))).rejects.toThrow(/413/);
  });

  it('loadBlobUrl fetches once and caches the object URL by hash', async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([9, 9]).buffer, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const u1 = await loadBlobUrl('hash-A', 'image/png');
    const u2 = await loadBlobUrl('hash-A', 'image/png');
    expect(u1).toBe(u2);
    expect(fetchMock).toHaveBeenCalledTimes(1); // second call served from cache
  });

  it('isInlineRenderableImage allows ONLY png/jpeg/gif/webp (secSys #694 inline gate)', () => {
    expect(isInlineRenderableImage('image/png')).toBe(true);
    expect(isInlineRenderableImage('image/jpeg')).toBe(true);
    expect(isInlineRenderableImage('image/gif')).toBe(true);
    expect(isInlineRenderableImage('image/webp')).toBe(true);
    // unsafe / non-raster — NEVER inline-rendered
    expect(isInlineRenderableImage('image/svg+xml')).toBe(false);
    expect(isInlineRenderableImage('text/html')).toBe(false);
    expect(isInlineRenderableImage('application/pdf')).toBe(false);
    expect(isInlineRenderableImage(undefined)).toBe(false);
  });
});
