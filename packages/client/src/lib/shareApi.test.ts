import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * shareApi.createShare boundary test (ROAD-0011 P2): the mint POST body carries the owner's theme stamp
 * (palette+voice) when provided, and omits it when not — so an older/theme-less call still mints. The bearer
 * is attached from the in-memory auth store (never persisted).
 */
const { getState } = vi.hoisted(() => ({
  getState: vi.fn(() => ({ bearerToken: 'tok-abc', remintBearer: vi.fn() })),
}));
vi.mock('../auth/store.js', () => ({ useAuthStore: { getState } }));

import { createShare } from './shareApi.js';

const OK = { shareId: 's1', token: 'dltos_share_x', url: 'https://x/s/dltos_share_x' };

function mockFetchOnce(body: unknown, status = 201) {
  const fetchMock = vi.fn(
    async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('createShare — theme stamp in the mint body', () => {
  it('includes palette + voice when a theme is passed', async () => {
    const fetchMock = mockFetchOnce(OK);
    await createShare('note', 'note-1', { palette: 'ember', voice: 'mono' });
    const init = fetchMock.mock.calls[0]![1]!;
    expect(JSON.parse(init.body as string)).toEqual({
      resourceType: 'note',
      resourceId: 'note-1',
      palette: 'ember',
      voice: 'mono',
    });
    // Bearer rides from the in-memory auth store.
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-abc');
  });

  it('omits palette/voice when no theme is passed (older/theme-less call still mints)', async () => {
    const fetchMock = mockFetchOnce(OK);
    await createShare('notebook', 'nb-1');
    const init = fetchMock.mock.calls[0]![1]!;
    expect(JSON.parse(init.body as string)).toEqual({ resourceType: 'notebook', resourceId: 'nb-1' });
  });
});
