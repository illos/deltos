/**
 * Collections sync round-trip (fake-indexeddb + mocked push/pull fetch).
 *
 * SYN-COL-1  mergeCollections / mergeCollectionMembers put server rows
 * SYN-COL-2  push accept updates version + drains queue
 * SYN-COL-3  push conflict re-puts server row
 * SYN-COL-4  remove tombstones survive merge of a server tombstone
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { collectionMemberId } from '@deltos/shared';
import type { NotebookId, NoteId, CollectionId } from '@deltos/shared';

const NB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as NotebookId;
const NOTE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as NoteId;
const COLL = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' as CollectionId;

beforeEach(async () => {
  const { db } = await import('../src/db/schema.js');
  await db.collections.clear();
  await db.collectionQueue.clear();
  await db.collectionMembers.clear();
  await db.collectionMemberQueue.clear();
  await db.syncQueue.clear();
  await db.notebookQueue.clear();
  await db.dictionaryQueue.clear();
  const { useAuthStore } = await import('../src/auth/store.js');
  useAuthStore.setState({
    accountId: 'acct-1',
    bearerToken: 'test-token',
    sessionState: 'active',
    username: 'jim',
  } as never);
  const { resumeSync } = await import('../src/lib/syncEngine.js');
  resumeSync();
  vi.restoreAllMocks();
  const storage: Record<string, string> = {};
  global.localStorage = {
    getItem: (k: string) => storage[k] ?? null,
    setItem: (k: string, v: string) => {
      storage[k] = v;
    },
    removeItem: (k: string) => {
      delete storage[k];
    },
  } as unknown as Storage;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('SYN-COL-1 — merge puts incoming SyncCollection / SyncCollectionMember rows', () => {
  it('writes live rows from the pull stream', async () => {
    const { mergeCollections, mergeCollectionMembers } = await import('../src/lib/syncEngine.js');
    const { db } = await import('../src/db/schema.js');
    const mid = collectionMemberId(COLL, NOTE);

    await mergeCollections([
      {
        id: COLL,
        notebookId: NB,
        name: 'From server',
        ord: 2,
        rule: null,
        version: 3,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        deletedAt: null,
        syncSeq: 10,
      },
    ]);
    await mergeCollectionMembers([
      {
        id: mid,
        collectionId: COLL,
        noteId: NOTE,
        ord: 1,
        version: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        deletedAt: null,
        syncSeq: 11,
      },
    ]);

    const c = await db.collections.get(COLL);
    expect(c?.name).toBe('From server');
    expect(c?.version).toBe(3);
    const m = await db.collectionMembers.get(mid);
    expect(m?.noteId).toBe(NOTE);
    expect(m?.deletedAt).toBeNull();
  });
});

describe('SYN-COL-2 — push accept updates version and drains queue', () => {
  it('accepts a create and bumps local version', async () => {
    const { mutateCollections } = await import('../src/db/mutateCollections.js');
    const { db } = await import('../src/db/schema.js');
    const { syncNow } = await import('../src/lib/syncEngine.js');

    const id = await mutateCollections.create(NB, 'Push me');
    expect(await db.collectionQueue.count()).toBe(1);

    global.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/sync/push')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          collectionEntries?: Array<{ id: string }>;
        };
        if (body.collectionEntries?.length) {
          return new Response(
            JSON.stringify({
              results: [],
              notebookResults: [],
              collectionResults: [{ id, outcome: 'accepted', version: 1, syncSeq: 5 }],
              collectionMemberResults: [],
              dictionaryResults: [],
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            results: [],
            notebookResults: [],
            collectionResults: [],
            collectionMemberResults: [],
            dictionaryResults: [],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          notes: [],
          notebooks: [],
          collections: [],
          collectionMembers: [],
          dictionaryWords: [],
          alerts: [],
          nextCursor: 0,
          hasMore: false,
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    syncNow(NB, '/api');
    await vi.waitFor(async () => {
      expect(await db.collectionQueue.count()).toBe(0);
    });

    const row = await db.collections.get(id);
    expect(row?.version).toBe(1);
  });
});

describe('SYN-COL-3 — push conflict re-puts server collection row', () => {
  it('adopts serverCollection on conflict', async () => {
    const { mutateCollections } = await import('../src/db/mutateCollections.js');
    const { db } = await import('../src/db/schema.js');
    const { syncNow } = await import('../src/lib/syncEngine.js');

    const id = await mutateCollections.create(NB, 'Local name');

    global.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/sync/push')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          collectionEntries?: Array<{ id: string }>;
        };
        if (body.collectionEntries?.length) {
          return new Response(
            JSON.stringify({
              results: [],
              notebookResults: [],
              collectionResults: [
                {
                  id,
                  outcome: 'conflict',
                  serverCollection: {
                    id,
                    notebookId: NB,
                    name: 'Server wins',
                    ord: 9,
                    rule: null,
                    version: 7,
                  },
                },
              ],
              collectionMemberResults: [],
              dictionaryResults: [],
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            results: [],
            notebookResults: [],
            collectionResults: [],
            collectionMemberResults: [],
            dictionaryResults: [],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          notes: [],
          notebooks: [],
          collections: [],
          collectionMembers: [],
          dictionaryWords: [],
          alerts: [],
          nextCursor: 0,
          hasMore: false,
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    syncNow(NB, '/api');
    await vi.waitFor(async () => {
      expect(await db.collectionQueue.count()).toBe(0);
    });

    const row = await db.collections.get(id);
    expect(row?.name).toBe('Server wins');
    expect(row?.version).toBe(7);
    expect(row?.ord).toBe(9);
  });
});

describe('SYN-COL-4 — server tombstone merge marks member deleted', () => {
  it('mergeCollectionMembers applies deletedAt', async () => {
    const { mergeCollectionMembers } = await import('../src/lib/syncEngine.js');
    const { db } = await import('../src/db/schema.js');
    const mid = collectionMemberId(COLL, NOTE);
    await db.collectionMembers.put({
      id: mid,
      collectionId: COLL,
      noteId: NOTE,
      ord: 0,
      version: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      deletedAt: null,
      syncSeq: 1,
    });

    await mergeCollectionMembers([
      {
        id: mid,
        collectionId: COLL,
        noteId: NOTE,
        ord: 0,
        version: 2,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-03T00:00:00.000Z',
        deletedAt: '2026-01-03T00:00:00.000Z',
        syncSeq: 20,
      },
    ]);

    const m = await db.collectionMembers.get(mid);
    expect(m?.deletedAt).toBe('2026-01-03T00:00:00.000Z');
    expect(m?.version).toBe(2);
  });
});
