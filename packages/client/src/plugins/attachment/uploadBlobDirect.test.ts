/**
 * uploadBlobDirect (direct-r2-upload.md §3 / §6.2, gates DR-4/DR-5) — the client direct-to-R2 helper:
 * hash → presign → XHR PUT (with progress + cancel) → confirm. The network is fully mocked here (crypto.subtle,
 * the presign/confirm fetches, and XMLHttpRequest); the REAL R2 PUT / checksum-rejection / CORS is the Slice-3
 * live S3 smoke, which a unit test can't fake.
 *
 * Asserts: presign is POSTed with { hash, size, mime }; the XHR PUTs to the presigned URL with the signed
 * headers; progress callbacks fire; a non-2xx PUT throws; abort throws an AbortError; on success confirm is
 * called and the helper returns confirm's { hash, size }.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── A controllable fake XMLHttpRequest (node has none; we drive progress/load/abort by hand) ──────────────
interface FakeUpload { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null }
class FakeXHR {
  static last: FakeXHR | null = null;
  method = '';
  url = '';
  headers: Record<string, string> = {};
  body: unknown = null;
  status = 0;
  upload: FakeUpload = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  aborted = false;

  constructor() { FakeXHR.last = this; }
  open(method: string, url: string) { this.method = method; this.url = url; }
  setRequestHeader(k: string, v: string) { this.headers[k] = v; }
  send(body: unknown) { this.body = body; }
  abort() { this.aborted = true; this.onabort?.(); }

  /** Test helper: fire a progress tick. */
  emitProgress(loaded: number, total: number) {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total });
  }
  /** Test helper: complete the PUT with a status. */
  complete(status: number) { this.status = status; this.onload?.(); }
}

const PRESIGN_URL = 'https://acc.r2.cloudflarestorage.com/deltos-blobs/acct/abc?X-Amz-Algorithm=sig';
const SIGNED_HEADERS = { 'x-amz-checksum-sha256': 'Y2hlY2tzdW0=', 'content-type': 'application/pdf' };
// crypto.subtle.digest is mocked to a 32-byte buffer of 0xab → hex is 'ab' * 32.
const EXPECTED_HASH = 'ab'.repeat(32);

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  FakeXHR.last = null;
  vi.stubGlobal('XMLHttpRequest', FakeXHR);

  // presign → { url, headers }; confirm → { hash, size } (R2-measured size).
  fetchMock = vi.fn(async (input: string) => {
    if (input.endsWith('/presign')) {
      return { ok: true, json: async () => ({ url: PRESIGN_URL, headers: SIGNED_HEADERS }) } as Response;
    }
    if (input.endsWith('/confirm')) {
      return { ok: true, json: async () => ({ hash: EXPECTED_HASH, size: 104_857_600 }) } as Response;
    }
    throw new Error(`unexpected fetch ${input}`);
  });
  vi.stubGlobal('fetch', fetchMock);

  const digest = new Uint8Array(32).fill(0xab).buffer;
  vi.spyOn(crypto.subtle, 'digest').mockResolvedValue(digest);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function bigFile(): File {
  const f = new File(['x'], 'huge.pdf', { type: 'application/pdf' });
  Object.defineProperty(f, 'size', { value: 104_857_600 }); // 100 MB
  return f;
}

/** Spin the microtask queue until the helper has created its XHR (after the async hash + presign). */
async function waitForXhr(): Promise<FakeXHR> {
  for (let i = 0; i < 50 && !FakeXHR.last; i++) await Promise.resolve();
  if (!FakeXHR.last) throw new Error('XHR was never created');
  return FakeXHR.last;
}

describe('uploadBlobDirect', () => {
  it('presigns with { hash, size, mime }, PUTs to the signed URL with the signed headers, then confirms', async () => {
    const { uploadBlobDirect } = await import('./blobClient.js');
    const onProgress = vi.fn();
    const promise = uploadBlobDirect(bigFile(), { onProgress });

    const xhr = await waitForXhr();

    // presign was POSTed with the right body.
    const presignCall = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/presign'))!;
    expect(presignCall).toBeTruthy();
    const presignBody = JSON.parse((presignCall[1] as RequestInit).body as string);
    expect(presignBody).toEqual({ hash: EXPECTED_HASH, size: 104_857_600, mime: 'application/pdf' });

    // The PUT goes to the presigned URL with the signed headers + the file body.
    expect(xhr.method).toBe('PUT');
    expect(xhr.url).toBe(PRESIGN_URL);
    expect(xhr.headers).toEqual(SIGNED_HEADERS);
    expect(xhr.body).toBeInstanceOf(File);

    // Progress callbacks fire.
    xhr.emitProgress(50_000_000, 104_857_600);
    expect(onProgress).toHaveBeenCalledWith(50_000_000 / 104_857_600);

    // Complete the PUT → confirm runs → returns confirm's { hash, size }.
    xhr.complete(200);
    const result = await promise;
    expect(result).toEqual({ hash: EXPECTED_HASH, size: 104_857_600 });
    expect(onProgress).toHaveBeenLastCalledWith(1); // settle at 100%
    expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/confirm'))).toBe(true);
  });

  it('throws on a non-2xx PUT (R2 checksum reject) and never calls confirm', async () => {
    const { uploadBlobDirect } = await import('./blobClient.js');
    const promise = uploadBlobDirect(bigFile(), {});
    const xhr = await waitForXhr();

    xhr.complete(400); // R2 BadDigest
    await expect(promise).rejects.toThrow(/rejected by R2 \(400\)/);
    expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/confirm'))).toBe(false);
  });

  it('aborts the XHR on signal and rejects with AbortError (no confirm → no note)', async () => {
    const { uploadBlobDirect } = await import('./blobClient.js');
    const controller = new AbortController();
    const promise = uploadBlobDirect(bigFile(), { signal: controller.signal });
    const xhr = await waitForXhr();

    controller.abort();
    expect(xhr.aborted).toBe(true);
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/confirm'))).toBe(false);
  });

  it('throws if presign fails (no PUT attempted)', async () => {
    fetchMock.mockImplementationOnce(async () => ({ ok: false, status: 503 }) as Response);
    const { uploadBlobDirect } = await import('./blobClient.js');
    await expect(uploadBlobDirect(bigFile(), {})).rejects.toThrow(/presign failed \(503\)/);
    expect(FakeXHR.last).toBeNull(); // never reached the PUT
  });
});
