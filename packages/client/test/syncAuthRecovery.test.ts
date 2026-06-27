/**
 * The "stuck yellow, only a hard reload fixes it" bug.
 *
 * The in-memory ACCESS token expires after 15 min (worker authPolicy.ts). On the sync routes an
 * expired/revoked access token comes back as a 403 (the worker's grant lookup finds the row but
 * grantAllows fails the expiry check → the guard denies with 403 — NOT 401; an unknown/absent token
 * is a 503). Before the fix, syncEngine threw on any !res.ok → runSync setState('error') (yellow), and
 * the 2s cadence re-ran with the SAME dead bearer → 403 forever. Only a full reload re-minted via
 * init(). The fix: on a 403 (or 401/503) the sync fetch re-mints the bearer once and retries.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Note, NotebookId } from '@deltos/shared';

const NB = 'nb-test-00000000-0000-4000-8000-000000000001' as NotebookId;
const NOW = '2026-06-15T12:00:00.000Z';

function res(status: number, body: unknown = {}): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function makeNote(id: string, version = 0): Note {
  return {
    id: id as Note['id'], notebookId: NB, title: 'T', properties: {}, body: [],
    version, createdAt: NOW, updatedAt: NOW, syncStatus: 'local-only',
  };
}

const settle = () => new Promise((r) => setTimeout(r, 80));

beforeEach(async () => {
  const { db } = await import('../src/db/schema.js');
  await Promise.all([db.notes.clear(), db.syncQueue.clear(), db.notebooks.clear(), db.noteVersions.clear()]);
  // Stub localStorage for the per-account sync cursor (node env has none; matches syncEngine.test.ts).
  const storage: Record<string, string> = {};
  global.localStorage = {
    getItem: (k: string) => storage[k] ?? null,
    setItem: (k: string, v: string) => { storage[k] = v; },
    removeItem: (k: string) => { delete storage[k]; },
  } as unknown as Storage;
});
afterEach(() => { vi.restoreAllMocks(); });

describe('sync auth recovery — expired access token (403) self-heals without a reload', () => {
  it('403 → re-mints the bearer and retries → push succeeds, queue drains, status returns to synced', async () => {
    const { db } = await import('../src/db/schema.js');
    const { useAuthStore } = await import('../src/auth/store.js');
    const { syncNow, getSyncState } = await import('../src/lib/syncEngine.js');

    useAuthStore.setState({ accountId: 'acct-1', bearerToken: 'stale-token', sessionState: 'active', isAuthed: true });

    await db.notes.put(makeNote('note-1', 0));
    await db.syncQueue.add({ id: crypto.randomUUID(), recordId: 'note-1', payload: makeNote('note-1', 0), baseVersion: 0, createdAt: NOW });

    let pushCalls = 0;
    let refreshCalls = 0;
    global.fetch = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/auth/refresh')) {
        refreshCalls++;
        return res(200, { token: 'fresh-token', accountId: 'acct-1', username: 'jim', recoveryEstablished: true });
      }
      if (u.includes('/sync/push')) {
        pushCalls++;
        if (pushCalls === 1) return res(403, { error: { code: 'forbidden' } }); // expired access token
        return res(200, { results: [{ outcome: 'accepted', id: 'note-1', version: 1 }], notebookResults: [], dictionaryResults: [] });
      }
      if (u.includes('/sync/pull')) return res(200, { notes: [], notebooks: [], dictionaryWords: [], nextCursor: 0, hasMore: false });
      throw new Error('unexpected url ' + u);
    }) as typeof fetch;

    syncNow(NB, '');
    await settle();

    expect(refreshCalls).toBe(1);                                   // re-minted once
    expect(pushCalls).toBe(2);                                      // 403, then retried
    expect(useAuthStore.getState().bearerToken).toBe('fresh-token'); // fresh token now in memory
    expect(await db.syncQueue.count()).toBe(0);                     // the edit actually pushed (no data stuck)
    expect(getSyncState()).toBe('idle');                           // GREEN — not latched on yellow 'error'
  });

  it('403 then a DEAD refresh cookie (401 on /refresh) → revoked session, grey not scary-yellow, loop stops', async () => {
    const { db } = await import('../src/db/schema.js');
    const { useAuthStore } = await import('../src/auth/store.js');
    const { syncNow, getSyncState } = await import('../src/lib/syncEngine.js');

    useAuthStore.setState({ accountId: 'acct-1', bearerToken: 'stale-token', sessionState: 'active', isAuthed: true });
    await db.notes.put(makeNote('note-2', 0));
    await db.syncQueue.add({ id: crypto.randomUUID(), recordId: 'note-2', payload: makeNote('note-2', 0), baseVersion: 0, createdAt: NOW });

    global.fetch = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/auth/refresh')) return res(401); // refresh cookie itself is dead → genuinely signed out
      if (u.includes('/sync/push')) return res(403, { error: { code: 'forbidden' } });
      if (u.includes('/sync/pull')) return res(403, { error: { code: 'forbidden' } });
      throw new Error('unexpected url ' + u);
    }) as typeof fetch;

    syncNow(NB, '');
    await settle();

    expect(useAuthStore.getState().sessionState).toBe('revoked'); // #89: needs a full re-login to resume
    expect(getSyncState()).not.toBe('error');                    // never the scary yellow for a signed-out device
  });
});
