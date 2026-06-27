/**
 * Auth bearer lifecycle around the network (the fix behind BOTH common bugs):
 *   - init() bounds the cold-boot /refresh with a timeout so a WEAK (not absent) network can't hang
 *     the boot spinner forever — on timeout it falls into the SAME resident-shell offline open as #85.
 *   - remintBearer() re-mints the in-memory access token MID-SESSION (the shell is already open) from
 *     the httpOnly refresh cookie, bounded the same way. The sync engine calls it when a request is
 *     rejected for an expired/revoked access token (a 403 on the sync routes — see syncAuthRecovery).
 *
 * The in-memory ACCESS token has a 15-min TTL (worker authPolicy.ts). Before this, the ONLY re-mint
 * path was a full page reload (init at boot) — hence "stuck until I hard-reload".
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useAuthStore } from '../src/auth/store.js';
import { db } from '../src/db/schema.js';

const ACCT = 'acct-1';

function res(status: number, body: unknown = {}): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  useAuthStore.setState({
    isAuthed: true, isAuthing: false, sessionState: 'offline',
    accountId: ACCT, bearerToken: null, recoveryEstablished: true, totpEnabled: false,
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('remintBearer() — mid-session access-token re-mint', () => {
  it('/refresh 200 → swaps in the fresh bearer, lifts sessionState back to active, returns ok', async () => {
    global.fetch = vi.fn(async () =>
      res(200, { token: 'fresh-token', accountId: ACCT, username: 'jim', recoveryEstablished: true, totpEnabled: false }),
    ) as typeof fetch;
    const outcome = await useAuthStore.getState().remintBearer();
    expect(outcome).toBe('ok');
    const s = useAuthStore.getState();
    expect(s.bearerToken).toBe('fresh-token');
    expect(s.sessionState).toBe('active');
  });

  it('/refresh 401 (dead refresh cookie) → returns revoked, invents no bearer', async () => {
    global.fetch = vi.fn(async () => res(401)) as typeof fetch;
    const outcome = await useAuthStore.getState().remintBearer();
    expect(outcome).toBe('revoked');
    expect(useAuthStore.getState().bearerToken).toBeNull();
  });

  it('/refresh network error / timeout → returns offline (stay offline; reconnect retries)', async () => {
    global.fetch = vi.fn(async () => { throw new Error('offline'); }) as typeof fetch;
    const outcome = await useAuthStore.getState().remintBearer();
    expect(outcome).toBe('offline');
  });

  it('/refresh 200 for a DIFFERENT account → revoked (never swap a live session into a foreign account)', async () => {
    global.fetch = vi.fn(async () =>
      res(200, { token: 't', accountId: 'someone-else', username: 'x', recoveryEstablished: true }),
    ) as typeof fetch;
    const outcome = await useAuthStore.getState().remintBearer();
    expect(outcome).toBe('revoked');
    expect(useAuthStore.getState().bearerToken).toBeNull();
  });
});

describe('init() — bounded /refresh so a weak network cannot hang the boot spinner', () => {
  it('a /refresh that never resolves aborts after the timeout → resident shell opens OFFLINE (not a stuck spinner)', async () => {
    // IDB writes must happen on REAL timers (fake-indexeddb schedules on the macrotask queue).
    await db.deviceState.put({ key: 'last-account', value: ACCT });
    useAuthStore.setState({ isAuthed: null, sessionState: 'booting', accountId: null, bearerToken: null });
    vi.useFakeTimers();
    // A weak-network fetch: pending forever, but honours the AbortController signal init() now attaches.
    global.fetch = vi.fn((_url, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })) as typeof fetch;
    const p = useAuthStore.getState().init();
    await vi.advanceTimersByTimeAsync(30_000); // push past the boot-refresh timeout
    await p;
    const s = useAuthStore.getState();
    expect(s.isAuthed).toBe(true);            // opened — did NOT hang on the blue spinner
    expect(s.sessionState).toBe('offline');
    expect(s.accountId).toBe(ACCT);
    expect(s.bearerToken).toBeNull();         // remints on reconnect (via the sync 403 path)
  });
});
