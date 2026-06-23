/**
 * unfurl() client service tests (§5 E2c). Fetch is mocked — not blocked on the server endpoint.
 *
 * UF-1  Happy path: resolves with typed metadata from the server response
 * UF-2  Memo cache: second call with same URL returns cached result (no second fetch)
 * UF-3  Network failure: throws UnfurlError with status 0
 * UF-4  HTTP error (4xx/5xx): throws UnfurlError with the HTTP status
 * UF-5  Bearer token is sent in the Authorization header
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the auth store before importing unfurl (which imports it at module level).
vi.mock('../src/auth/store.js', () => ({
  useAuthStore: {
    getState: () => ({ bearerToken: 'test-token' }),
  },
}));

const URL = 'https://example.com/article';
const METADATA = {
  url: URL,
  title: 'Example Article',
  description: 'A great read.',
  favicon: 'https://example.com/favicon.ico',
  siteName: 'Example',
};

beforeEach(async () => {
  // Clear the module-level memo between tests.
  const { _clearMemoForTest } = await import('../src/plugins/embeds/unfurl.js');
  _clearMemoForTest();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── UF-1: Happy path ──────────────────────────────────────────────────────────

describe('UF-1 — happy path returns typed metadata', () => {
  it('calls /api/unfurl?url=... and returns parsed metadata', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify(METADATA), { status: 200 })) as typeof fetch;
    const { unfurl } = await import('../src/plugins/embeds/unfurl.js');
    const result = await unfurl(URL);
    expect(result.url).toBe(URL);
    expect(result.title).toBe('Example Article');
    expect(result.favicon).toBe('https://example.com/favicon.ico');
    expect(result.siteName).toBe('Example');

    const [fetchUrl] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(fetchUrl).toContain('/api/unfurl?url=');
    expect(fetchUrl).toContain(encodeURIComponent(URL));
  });
});

// ── UF-2: Memo cache ──────────────────────────────────────────────────────────

describe('UF-2 — memo cache avoids a second fetch for the same URL', () => {
  it('second call returns cached result without fetching again', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify(METADATA), { status: 200 })) as typeof fetch;
    const { unfurl } = await import('../src/plugins/embeds/unfurl.js');
    const r1 = await unfurl(URL);
    const r2 = await unfurl(URL);
    expect(r1).toBe(r2); // same object reference from memo
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });
});

// ── UF-3: Network failure ─────────────────────────────────────────────────────

describe('UF-3 — network failure throws UnfurlError(status=0)', () => {
  it('throws UnfurlError with status 0 when fetch rejects', async () => {
    global.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch;
    const { unfurl, UnfurlError } = await import('../src/plugins/embeds/unfurl.js');
    await expect(unfurl(URL)).rejects.toBeInstanceOf(UnfurlError);
    try {
      await unfurl(URL);
    } catch (e) {
      expect((e as InstanceType<typeof UnfurlError>).status).toBe(0);
    }
  });
});

// ── UF-4: HTTP error ──────────────────────────────────────────────────────────

describe('UF-4 — HTTP 4xx/5xx throws UnfurlError with the HTTP status', () => {
  it('throws UnfurlError(404) when the server returns 404', async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: 'not found' } }), { status: 404 }),
    ) as typeof fetch;
    const { unfurl, UnfurlError } = await import('../src/plugins/embeds/unfurl.js');
    let caught: unknown;
    try { await unfurl(URL); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(UnfurlError);
    expect((caught as InstanceType<typeof UnfurlError>).status).toBe(404);
  });

  it('throws UnfurlError(500) on server error', async () => {
    global.fetch = vi.fn(async () =>
      new Response('Internal Server Error', { status: 500, headers: { 'Content-Type': 'text/plain' } }),
    ) as typeof fetch;
    const { unfurl, UnfurlError } = await import('../src/plugins/embeds/unfurl.js');
    let caught: unknown;
    try { await unfurl(URL); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(UnfurlError);
    expect((caught as InstanceType<typeof UnfurlError>).status).toBe(500);
  });
});

// ── UF-5: Auth header ─────────────────────────────────────────────────────────

describe('UF-5 — bearer token sent in Authorization header', () => {
  it('includes Authorization: Bearer <token> in the fetch headers', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify(METADATA), { status: 200 })) as typeof fetch;
    const { unfurl } = await import('../src/plugins/embeds/unfurl.js');
    await unfurl(URL);
    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect((init?.headers as Record<string, string>)['Authorization']).toBe('Bearer test-token');
  });
});
