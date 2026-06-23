import { describe, it, expect, vi, afterEach } from 'vitest';
import { transcribe, TranscribeError } from '../src/lib/voiceTranscribe.js';
import { useAuthStore } from '../src/auth/store.js';

/**
 * Voice CONSUME service tests (custom-keyboard spec §6, stage 3). The service POSTs an audio blob to
 * /api/transcribe and returns { transcript, audio } — decoupled from any consumer (no insert-at-caret).
 * It is also CHUNK-AGNOSTIC: it transcribes whatever blob it is handed, so the future live-preview layer
 * (per-chunk previews) composes with it without change.
 */

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => {
  vi.restoreAllMocks();
  useAuthStore.setState({ bearerToken: null });
});

describe('transcribe() — voice CONSUME service', () => {
  it('POSTs the blob and returns the transcript PLUS the original audio (audio does not round-trip)', async () => {
    const audio = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' });
    const fetchMock = vi.fn(() => Promise.resolve(jsonRes(200, { transcript: 'hello there' })));
    vi.stubGlobal('fetch', fetchMock);

    const result = await transcribe(audio);

    expect(result.transcript).toBe('hello there');
    expect(result.audio).toBe(audio); // SAME blob object — kept for a future VOICE MEMO consumer
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/transcribe');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(audio); // raw blob as the body
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('audio/webm');
  });

  it('sends the in-memory bearer when authed (read fresh from the auth store)', async () => {
    useAuthStore.setState({ bearerToken: 'tok-123' });
    const fetchMock = vi.fn(() => Promise.resolve(jsonRes(200, { transcript: 'x' })));
    vi.stubGlobal('fetch', fetchMock);

    await transcribe(new Blob(['a'], { type: 'audio/webm' }));

    const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-123');
  });

  it('omits Authorization when there is no live session', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonRes(200, { transcript: 'x' })));
    vi.stubGlobal('fetch', fetchMock);

    await transcribe(new Blob(['a'], { type: 'audio/webm' }));

    const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('throws TranscribeError with the server error message + status on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonRes(401, { error: { code: 'unauthorized', message: 'transcription requires an authenticated session' } }))));

    await expect(transcribe(new Blob(['a'], { type: 'audio/webm' }))).rejects.toMatchObject({
      name: 'TranscribeError',
      status: 401,
      message: 'transcription requires an authenticated session',
    });
  });

  it('throws TranscribeError(status 0) on a transport/network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));

    const err = await transcribe(new Blob(['a'], { type: 'audio/webm' })).catch((e) => e);
    expect(err).toBeInstanceOf(TranscribeError);
    expect((err as TranscribeError).status).toBe(0);
  });

  it('is chunk-agnostic: transcribes an arbitrary blob with no whole-recording assumption', async () => {
    const chunk = new Blob([new Uint8Array(64)], { type: 'audio/webm' });
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonRes(200, { transcript: 'partial' }))));
    const result = await transcribe(chunk);
    expect(result.transcript).toBe('partial');
    expect(result.audio).toBe(chunk);
  });
});
