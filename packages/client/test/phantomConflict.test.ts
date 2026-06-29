/**
 * P1 phantom-conflict spam — repro + regression gate (sync base-version lockstep).
 *
 * Symptom: single device, stable connection, NO second device — typing one char → conflict, on
 * EVERY edit incl. the first. Cause: a content save enqueued a STALE CAS baseVersion (the editor
 * held the pre-sync version), so the server (already advanced) CAS-missed it → a phantom conflict
 * re-fired every sync tick. Fix: the `version` field is data-layer-owned (sync-authoritative) — a
 * write preserves the CURRENT persisted version as both the stored version and the enqueued base,
 * so the client base advances in lockstep with the server and a stale editor version can't conflict.
 *
 * Faithful in-memory CAS server (push = expectedVersion CAS; pull = syncSeq>cursor) so the
 * base-version advancement is exercised exactly as in production. A conflict materialises as a
 * noteVersions row (applyConflict retention), so any growth == the spam.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import type { Note, NotebookId, NoteId } from '@deltos/shared';

const NB = '0c000000-0000-4000-8000-000000000001' as NotebookId;
const NOTE_ID = '0c000000-0000-4000-8000-000000000002' as NoteId;
const NOW = '2026-06-16T12:00:00.000Z';

beforeEach(async () => {
  const { db } = await import('../src/db/schema.js');
  await Promise.all([db.notes.clear(), db.syncQueue.clear(), db.notebooks.clear(), db.noteVersions.clear()]);
  const { useAuthStore } = await import('../src/auth/store.js');
  useAuthStore.setState({ accountId: 'phan-acct', bearerToken: 'phan-tok', sessionState: 'active' });
  const storage: Record<string, string> = {};
  global.localStorage = {
    getItem: (k: string) => storage[k] ?? null,
    setItem: (k: string, v: string) => { storage[k] = v; },
    removeItem: (k: string) => { delete storage[k]; },
  } as unknown as Storage;
});

afterEach(() => vi.restoreAllMocks());

type ServerMap = Map<string, { note: Note; version: number; syncSeq: number }>;

/** Faithful server: per-note version + monotonic syncSeq, CAS on push. Returns its note map. */
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

const freshNote = (): Note => ({
  id: NOTE_ID, notebookId: NB, title: 'My note', properties: {}, body: [],
  version: 0, createdAt: NOW, updatedAt: NOW, syncStatus: 'local-only',
});

describe('P1 — sync base-version lockstep: no phantom conflicts on a single device', () => {
  it('steady-state ticks of an UNCHANGED note never conflict', async () => {
    installServer();
    const { db } = await import('../src/db/schema.js');
    const { mutateNotes } = await import('../src/db/mutate.js');
    await mutateNotes.put(freshNote());
    await tick();                              // INSERT → accept v1
    for (let i = 0; i < 5; i++) await tick();  // steady state

    expect(await db.noteVersions.count()).toBe(0);
    const stored = await db.notes.get(NOTE_ID);
    expect((stored as { hasConflict?: boolean }).hasConflict ?? false).toBe(false);
    expect(stored!.version).toBe(1);
    expect(await db.syncQueue.where('recordId').equals(NOTE_ID).count()).toBe(0);
  });

  it('type → sync → type → sync repeatedly: ZERO conflicts, base advances in lockstep with the server — even when the editor saves a STALE version', async () => {
    const server = installServer();
    const { db } = await import('../src/db/schema.js');
    const { mutateNotes } = await import('../src/db/mutate.js');

    // Note creation + first sync: base seeded (0 → INSERT) and advanced to the server's v1.
    await mutateNotes.put(freshNote());
    await tick();
    expect(await db.noteVersions.count()).toBe(0);
    expect((await db.notes.get(NOTE_ID))!.version).toBe(1);
    expect(server.get(NOTE_ID)!.version).toBe(1);

    // Each edit simulates the editor still holding the STALE pre-sync version (version: 0) — the
    // exact field that caused the phantom. The data layer must ignore it and use the live version.
    for (let i = 1; i <= 4; i++) {
      await mutateNotes.put({ ...freshNote(), version: 0, title: `edit ${i}` });
      await tick();

      expect(await db.noteVersions.count()).toBe(0); // STILL zero conflicts — no phantom
      const stored = await db.notes.get(NOTE_ID);
      expect(stored!.title).toBe(`edit ${i}`);                  // the edit content is kept
      expect(stored!.version).toBe(1 + i);                      // advanced: 2, 3, 4, 5
      expect(stored!.version).toBe(server.get(NOTE_ID)!.version); // LOCKSTEP with the server
    }
    expect(await db.syncQueue.where('recordId').equals(NOTE_ID).count()).toBe(0); // fully drained
  });

  it('a STALE-BASE queue entry (the cross-cycle editor-race duplicate) is re-stamped to the live version at push time and does NOT conflict', async () => {
    const server = installServer();
    const { db } = await import('../src/db/schema.js');
    const { mutateNotes } = await import('../src/db/mutate.js');

    // Advance the note to v2.
    await mutateNotes.put(freshNote());
    await tick();
    await mutateNotes.put({ ...freshNote(), title: 'edit-1' });
    await tick();
    expect((await db.notes.get(NOTE_ID))!.version).toBe(2);

    // Inject a duplicate entry carrying a STALE base (1 < live 2) — exactly what the editor's
    // double-save produces in the window between a prior push and its applyAccepted. Pre-belt this
    // CAS-missed the server (base 1 vs v2) → phantom conflict every tick.
    const live = (await db.notes.get(NOTE_ID))!;
    await db.syncQueue.add({
      id: crypto.randomUUID(), recordId: NOTE_ID,
      payload: { ...live, title: 'stale-dup' }, baseVersion: 1, createdAt: new Date().toISOString(),
    });
    await tick();

    // Re-stamped to the live version (2) at push time → accepted v3, NOT a conflict.
    expect(await db.noteVersions.count()).toBe(0);          // ZERO phantom conflicts
    expect((await db.notes.get(NOTE_ID))!.version).toBe(3);
    expect(server.get(NOTE_ID)!.version).toBe(3);
    expect(await db.syncQueue.where('recordId').equals(NOTE_ID).count()).toBe(0);
  });
});
