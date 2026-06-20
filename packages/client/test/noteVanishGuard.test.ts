/**
 * #52 DATA-LAYER REGRESSION GUARD — "create → edit → sync → note vanishes".
 *
 * The P0 live regression (history deploy hid notes) must be pinned MUTATE-vs-DISPLAY. This gate
 * proves the DATA layer (sync reconcile + the #32 blank-deferral + the #45 capture's neighbours) does
 * NOT lose a freshly created+edited note across a sync cycle: after create→edit→sync the note is
 * PRESENT in the all-notes view (db row exists, deletedAt null, not trashed) at the accepted version.
 *
 * "All-notes presence" replicates observeNotes' exact filter (`!deletedAt && !isInTrash`) so a row
 * that the list would hide counts as vanished here too. A faithful in-memory CAS server (push =
 * expectedVersion CAS, returning conflict+serverNote:null for an update on a note it doesn't have;
 * pull = syncSeq>cursor) exercises the reconcile exactly as production does.
 *
 * The final case ADVERSARIALLY drives the one data-layer vanish vector (a push whose note is not on
 * the server at baseVersion>0 → conflict+null → applyConflict tombstone) to prove these assertions
 * actually catch a disappearance — so a green guard means the create→edit→sync path is genuinely safe.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { isTrashed } from '@deltos/shared';
import type { Note, NotebookId, NoteId } from '@deltos/shared';

const NB = 'nb-vanish-0000-0000-4000-8000-000000000001' as NotebookId;
const NOTE_ID = 'note-vanish-00-0000-4000-8000-000000000001' as NoteId;
const NOW = '2026-06-20T12:00:00.000Z';

beforeEach(async () => {
  const { db } = await import('../src/db/schema.js');
  await Promise.all([db.notes.clear(), db.syncQueue.clear(), db.notebooks.clear(), db.noteVersions.clear()]);
  const { useAuthStore } = await import('../src/auth/store.js');
  useAuthStore.setState({ accountId: 'vanish-acct', bearerToken: 'vanish-tok', sessionState: 'active' });
  const storage: Record<string, string> = {};
  global.localStorage = {
    getItem: (k: string) => storage[k] ?? null,
    setItem: (k: string, v: string) => { storage[k] = v; },
    removeItem: (k: string) => { delete storage[k]; },
  } as unknown as Storage;
});

afterEach(() => vi.restoreAllMocks());

type ServerMap = Map<string, { note: Note; version: number; syncSeq: number }>;

/** Faithful server: per-note version + monotonic syncSeq, CAS on push (conflict+null if absent). */
function installServer(): ServerMap {
  const notes: ServerMap = new Map();
  let seq = 0;
  global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/sync/push')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        notebookId: NotebookId;
        entries: Array<{ id: string; draft: { title: string; properties: Record<string, unknown>; body: unknown[] }; baseVersion: number }>;
      };
      const results = body.entries.map((e) => {
        const cur = notes.get(e.id);
        const curVersion = cur?.version ?? 0;
        if (e.baseVersion === curVersion) {
          const version = curVersion + 1;
          seq += 1;
          const note: Note = {
            id: e.id as NoteId, notebookId: body.notebookId,
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
    const cursor = Number(new URL(u, 'https://x').searchParams.get('cursor') ?? '0');
    const out = [...notes.values()].filter((n) => n.syncSeq > cursor)
      .map((n) => ({ ...n.note, syncStatus: 'synced' as const, deletedAt: null, syncSeq: n.syncSeq }));
    const nextCursor = out.reduce((m, n) => Math.max(m, n.syncSeq), cursor);
    return new Response(JSON.stringify({ notes: out, nextCursor, hasMore: false }), { status: 200 });
  }) as typeof fetch;
  return notes;
}

async function tick() {
  const { syncNow } = await import('../src/lib/syncEngine.js');
  syncNow(NB, '');
  await new Promise((r) => setTimeout(r, 60));
}

/** A brand-new blank note exactly as NewNote creates it (version 0, empty title + body). */
const blankNote = (): Note => ({
  id: NOTE_ID, notebookId: NB, title: '', properties: {}, body: [],
  version: 0, createdAt: NOW, updatedAt: NOW, syncStatus: 'local-only',
});

/** The all-notes predicate, identical to dexieLocalStore.observeNotes (`!deletedAt && !isInTrash`). */
async function presentInAllNotes(id: NoteId): Promise<boolean> {
  const { db } = await import('../src/db/schema.js');
  const n = await db.notes.get(id);
  return !!n && !(n as { deletedAt?: string | null }).deletedAt && !isTrashed(n.properties);
}

describe('#52 — create → edit → sync keeps the note (data layer)', () => {
  it('create (blank, #32-deferred) → edit → sync: note PRESENT at v1, synced, not trashed', async () => {
    const server = installServer();
    const { db } = await import('../src/db/schema.js');
    const { mutateNotes } = await import('../src/db/mutate.js');

    // 1. Create — blank note, #32 push-deferral means it is NOT queued yet.
    await mutateNotes.put(blankNote());
    expect(await db.syncQueue.where('recordId').equals(NOTE_ID).count()).toBe(0);

    // 2. Edit — first content arms the push (INSERT at baseVersion 0).
    await mutateNotes.put({ ...blankNote(), title: 'first real edit' });
    expect(await db.syncQueue.where('recordId').equals(NOTE_ID).count()).toBe(1);

    // 3. Sync.
    await tick();

    expect(await presentInAllNotes(NOTE_ID), 'note must NOT vanish from all-notes').toBe(true);
    const stored = (await db.notes.get(NOTE_ID))!;
    expect(stored.title).toBe('first real edit');
    expect(stored.version).toBe(1);
    expect(stored.syncStatus).toBe('synced');
    expect((stored as { hasConflict?: boolean }).hasConflict ?? false).toBe(false);
    expect(await db.noteVersions.count(), 'no spurious conflict version').toBe(0);
    expect(server.get(NOTE_ID)!.version).toBe(1);
  });

  it('create → edit → sync → edit → sync: still present, advances to v2', async () => {
    installServer();
    const { db } = await import('../src/db/schema.js');
    const { mutateNotes } = await import('../src/db/mutate.js');

    await mutateNotes.put(blankNote());
    await mutateNotes.put({ ...blankNote(), title: 'edit one' });
    await tick();
    await mutateNotes.put({ ...blankNote(), version: 0, title: 'edit two' }); // stale caller version ignored
    await tick();

    expect(await presentInAllNotes(NOTE_ID)).toBe(true);
    const stored = (await db.notes.get(NOTE_ID))!;
    expect(stored.title).toBe('edit two');
    expect(stored.version).toBe(2);
    expect(await db.syncQueue.where('recordId').equals(NOTE_ID).count()).toBe(0);
  });

  it('a pull after the create cycle does NOT stomp the freshly-synced note', async () => {
    installServer();
    const { mutateNotes } = await import('../src/db/mutate.js');

    await mutateNotes.put(blankNote());
    await mutateNotes.put({ ...blankNote(), title: 'edit then pull' });
    await tick(); // push (insert) + pull in the same cycle
    await tick(); // a second pull cycle (cursor advanced) must not drop it
    expect(await presentInAllNotes(NOTE_ID)).toBe(true);
  });

  it('ADVERSARIAL: the one data-layer vanish vector IS caught (update on a server-absent note → conflict+null → tombstone)', async () => {
    installServer();
    const { db } = await import('../src/db/schema.js');

    // A note local at version 1 (as if synced) that the SERVER does not have, with a queued UPDATE at
    // baseVersion 1. Push → server has no such note → conflict + serverNote:null → applyConflict sets
    // deletedAt. This is the only data-layer path that hides a note; the guard above asserts it never
    // happens on create→edit→sync, and this proves the assertion is real.
    await db.notes.put({ ...blankNote(), title: 'orphaned', version: 1, syncStatus: 'synced' });
    await db.syncQueue.add({
      id: crypto.randomUUID(), recordId: NOTE_ID,
      payload: { ...blankNote(), title: 'orphaned', version: 1 }, baseVersion: 1, createdAt: new Date().toISOString(),
    });
    expect(await presentInAllNotes(NOTE_ID)).toBe(true); // present before the bad push
    await tick();
    expect(await presentInAllNotes(NOTE_ID), 'tombstoned → must read as vanished').toBe(false);
    expect((await db.notes.get(NOTE_ID)) !== undefined).toBe(true); // soft tombstone (row retained, deletedAt set)
  });
});
