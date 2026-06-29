/**
 * #54 — awaitable push-drain primitive (flushPushQueue).
 *
 * The "ensure everything is pushed" moment. Logout uses it to flush ALL queued edits BEFORE the local
 * wipe — today suspendSync only lets an already-in-flight push finish, so an edit queued in the ~2s
 * debounce window at the sign-out instant would be dropped by the wipe (data-loss on logout). This
 * gate proves a queued-but-not-yet-pushed edit IS flushed to the server, the queue drains, and an
 * empty queue is a no-op (no network).
 *
 * Faithful in-memory CAS server (push = expectedVersion CAS) — same harness as the sync reconcile tests.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import type { Note, NotebookId, NoteId } from '@deltos/shared';

const NB = '0d000000-0000-4000-8000-000000000001' as NotebookId;
const NOTE_ID = '0d000000-0000-4000-8000-000000000002' as NoteId;
const NOTE_2 = '0d000000-0000-4000-8000-000000000003' as NoteId;
const NOW = '2026-06-20T12:00:00.000Z';

beforeEach(async () => {
  const { db } = await import('../src/db/schema.js');
  await Promise.all([db.notes.clear(), db.syncQueue.clear(), db.notebooks.clear(), db.noteVersions.clear()]);
  const { useAuthStore } = await import('../src/auth/store.js');
  useAuthStore.setState({ accountId: 'flush-acct', bearerToken: 'flush-tok', sessionState: 'active' });
  const storage: Record<string, string> = {};
  global.localStorage = {
    getItem: (k: string) => storage[k] ?? null,
    setItem: (k: string, v: string) => { storage[k] = v; },
    removeItem: (k: string) => { delete storage[k]; },
  } as unknown as Storage;
});

afterEach(() => vi.restoreAllMocks());

type ServerMap = Map<string, { note: Note; version: number; syncSeq: number }>;

function installServer(): ServerMap {
  const notes: ServerMap = new Map();
  let seq = 0;
  global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/sync/push')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        entries: Array<{ id: string; notebookId?: NotebookId; draft: { title: string; properties: Record<string, unknown>; body: unknown[] }; baseVersion: number }>;
      };
      const results = body.entries.map((e) => {
        const cur = notes.get(e.id);
        const curVersion = cur?.version ?? 0;
        if (e.baseVersion === curVersion) {
          const version = curVersion + 1;
          seq += 1;
          const note: Note = {
            id: e.id as NoteId, notebookId: (e.notebookId ?? cur?.note.notebookId ?? NB),
            title: e.draft.title, properties: e.draft.properties, body: e.draft.body as Note['body'],
            version, createdAt: cur?.note.createdAt ?? NOW, updatedAt: NOW, syncStatus: 'synced',
          };
          notes.set(e.id, { note, version, syncSeq: seq });
          return { id: e.id, outcome: 'accepted' as const, version, syncSeq: seq };
        }
        return { id: e.id, outcome: 'conflict' as const, serverNote: cur ? { ...cur.note, syncSeq: cur.syncSeq, deletedAt: null } : null };
      });
      return new Response(JSON.stringify({ results }), { status: 200 });
    }
    return new Response(JSON.stringify({ notes: [], nextCursor: 0, hasMore: false }), { status: 200 });
  }) as typeof fetch;
  return notes;
}

const blankNote = (id: NoteId = NOTE_ID): Note => ({
  id, notebookId: NB, title: '', properties: {}, body: [],
  version: 0, createdAt: NOW, updatedAt: NOW, syncStatus: 'local-only',
});

describe('#54 — flushPushQueue (awaitable push drain)', () => {
  it('flushes a QUEUED-but-not-yet-pushed edit to the server, then the queue is empty', async () => {
    const server = installServer();
    const { db } = await import('../src/db/schema.js');
    const { mutateNotes } = await import('../src/db/mutate.js');
    const { flushPushQueue } = await import('../src/lib/syncEngine.js');

    await mutateNotes.put(blankNote()); // create — #32-deferred, not queued
    await mutateNotes.put({ ...blankNote(), title: 'edit at logout instant' }); // first content → QUEUED, not pushed
    expect(await db.syncQueue.count()).toBe(1);

    await flushPushQueue(''); // the awaitable drain (what logout awaits before the wipe)

    expect(await db.syncQueue.count(), 'queue drained').toBe(0);
    const stored = (await db.notes.get(NOTE_ID))!;
    expect(stored.version).toBe(1);
    expect(stored.syncStatus).toBe('synced');
    expect(server.get(NOTE_ID)!.note.title).toBe('edit at logout instant'); // server received the edit
  });

  it('drains MULTIPLE queued notes in one call', async () => {
    const server = installServer();
    const { db } = await import('../src/db/schema.js');
    const { mutateNotes } = await import('../src/db/mutate.js');
    const { flushPushQueue } = await import('../src/lib/syncEngine.js');

    await mutateNotes.put({ ...blankNote(NOTE_ID), title: 'note one' });
    await mutateNotes.put({ ...blankNote(NOTE_2), title: 'note two' });
    expect(await db.syncQueue.count()).toBe(2);

    await flushPushQueue('');

    expect(await db.syncQueue.count()).toBe(0);
    expect(server.get(NOTE_ID)!.note.title).toBe('note one');
    expect(server.get(NOTE_2)!.note.title).toBe('note two');
  });

  it('an EMPTY queue resolves immediately with no network call', async () => {
    installServer();
    const { flushPushQueue } = await import('../src/lib/syncEngine.js');
    await flushPushQueue('');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
