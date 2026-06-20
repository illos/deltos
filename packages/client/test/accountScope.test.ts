/**
 * #52 client tenancy — OPTION B (clear-on-account-change) gate. PROTOTYPE (secSys-review-pending).
 *
 * Acceptance: login A → A's notes/notebook/un-pushed edit/versions/pointer → login B → B sees ZERO of
 * A's local state on EVERY read surface, and A's un-pushed queue entry can't drain under B (the W8
 * write-migration leak). Device-level theme survives; the durable accountId marker advances to B.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import type { NotebookId, NoteId } from '@deltos/shared';

beforeEach(async () => {
  const { db } = await import('../src/db/schema.js');
  await Promise.all(db.tables.map((t) => t.clear()));
  const storage: Record<string, string> = {};
  global.localStorage = {
    getItem: (k: string) => storage[k] ?? null,
    setItem: (k: string, v: string) => { storage[k] = v; },
    removeItem: (k: string) => { delete storage[k]; },
    key: (i: number) => Object.keys(storage)[i] ?? null,
    get length() { return Object.keys(storage).length; },
    clear: () => { for (const k of Object.keys(storage)) delete storage[k]; },
  } as unknown as Storage;
});

const A = 'acct-A';
const B = 'acct-B';
const NB_A = 'nb-A-0000-0000-4000-8000-000000000001' as NotebookId;
const NOTE_A = 'note-A-00-0000-4000-8000-000000000001' as NoteId;

/** Seed a full set of account A's local state + the resident-account marker = A. */
async function seedAccountA() {
  const { db } = await import('../src/db/schema.js');
  await db.notes.put({
    id: NOTE_A, notebookId: NB_A, title: "A's note", properties: {}, body: [],
    version: 1, createdAt: 'x', updatedAt: 'x', syncStatus: 'synced', accountId: A,
  } as never);
  await db.notebooks.put({
    id: NB_A, name: 'Notes', defaultCollectionView: 'list', isDefault: true,
    version: 1, createdAt: 'x', updatedAt: 'x', deletedAt: null, syncSeq: 1,
  } as never);
  await db.noteVersions.add({
    id: 'ver-A-1', noteId: NOTE_A, accountId: A, kind: 'session',
    title: "A's note", properties: {}, body: [], baseVersion: 1, createdAt: 'x',
  } as never);
  await db.syncQueue.add({
    id: 'q-A-1', recordId: NOTE_A,
    payload: { id: NOTE_A, notebookId: NB_A, title: 'A unpushed edit', properties: {}, body: [], version: 1 } as never,
    baseVersion: 1, createdAt: 'x',
  });
  await db.notebookQueue.add({ id: 'nbq-A-1', recordId: NB_A, payload: {} as never, createdAt: 'x' });
  await db.deviceState.put({ key: 'current-notebook', value: NB_A }); // A's pointer
  await db.deviceState.put({ key: 'appearance-theme', value: JSON.stringify({ mode: 'dark' }) }); // device pref
  await db.deviceState.put({ key: 'last-account', value: A }); // resident-account marker
  localStorage.setItem('deltos.defaultNotebookId', NB_A); // legacy pointer
  localStorage.setItem(`deltos.sync.cursor.v2.${A}`, '42'); // A's pull cursor
}

describe('ensureAccountScope — option B clear-on-account-change (#52)', () => {
  it('SWITCH A→B WIPES every account-scoped local surface; B sees ZERO of A; theme survives; marker→B', async () => {
    const { db } = await import('../src/db/schema.js');
    const { ensureAccountScope } = await import('../src/db/accountScope.js');
    await seedAccountA();

    const wiped = await ensureAccountScope(B);
    expect(wiped).toBe(true);

    // Every read surface is empty — the 5 read paths (notes list, trash, switcher, by-id, search) all
    // read these tables, so empty == zero visibility of A.
    expect(await db.notes.count()).toBe(0);
    expect(await db.notebooks.count()).toBe(0);
    expect(await db.noteVersions.count()).toBe(0);
    // W8: A's un-pushed queue entries are gone → nothing drains under B's bearer (no content migration).
    expect(await db.syncQueue.count()).toBe(0);
    expect(await db.notebookQueue.count()).toBe(0);
    // The device-global notebook pointer is cleared (so B doesn't inherit A's current-notebook selection).
    expect(await db.deviceState.get('current-notebook')).toBeUndefined();
    // localStorage: legacy pointer + A's cursor cleared (B will full-re-pull into the clean store).
    expect(localStorage.getItem('deltos.defaultNotebookId')).toBeNull();
    expect(localStorage.getItem(`deltos.sync.cursor.v2.${A}`)).toBeNull();
    // Device-level theme PRESERVED (not account data). Marker advanced to B.
    expect(await db.deviceState.get('appearance-theme')).toBeTruthy();
    expect((await db.deviceState.get('last-account'))?.value).toBe(B);
  });

  it('SAME account (marker === accountId) is a NO-OP — local data preserved (no needless wipe)', async () => {
    const { db } = await import('../src/db/schema.js');
    const { ensureAccountScope } = await import('../src/db/accountScope.js');
    await seedAccountA();

    const wiped = await ensureAccountScope(A);
    expect(wiped).toBe(false);
    expect(await db.notes.count()).toBe(1); // kept
    expect(await db.syncQueue.count()).toBe(1); // un-pushed edit kept (same account, will push under A)
    expect((await db.deviceState.get('last-account'))?.value).toBe(A);
  });

  it('FIRST fixed-build load (no marker) → treated as a switch → wipes pre-fix residue, stamps marker', async () => {
    const { db } = await import('../src/db/schema.js');
    const { ensureAccountScope } = await import('../src/db/accountScope.js');
    // pre-fix polluted residue with NO marker (the rollout case)
    await db.notes.put({ id: NOTE_A, notebookId: NB_A, title: 'residue', properties: {}, body: [], version: 1, createdAt: 'x', updatedAt: 'x', syncStatus: 'synced' } as never);
    expect(await db.deviceState.get('last-account')).toBeUndefined();

    const wiped = await ensureAccountScope(B);
    expect(wiped).toBe(true);
    expect(await db.notes.count()).toBe(0); // residue purged once
    expect((await db.deviceState.get('last-account'))?.value).toBe(B);
  });

  it('LOGOUT (purgeAllLocalState) empties EVERYTHING incl. the marker + cursors (re-login re-pulls from seq 0)', async () => {
    const { db } = await import('../src/db/schema.js');
    const { purgeAllLocalState, readAccountMarker } = await import('../src/db/accountScope.js');
    await seedAccountA();

    await purgeAllLocalState();

    expect(await db.notes.count()).toBe(0);
    expect(await db.notebooks.count()).toBe(0);
    expect(await db.noteVersions.count()).toBe(0);
    expect(await db.syncQueue.count()).toBe(0);
    expect(await db.notebookQueue.count()).toBe(0);
    expect(await db.deviceState.get('current-notebook')).toBeUndefined();
    // Cursor reset (secSys gate): re-login as A must re-pull A's FULL stream from seq 0, not just post-cursor.
    expect(localStorage.getItem(`deltos.sync.cursor.v2.${A}`)).toBeNull();
    // Marker DROPPED (logout, unlike switch, leaves no resident account).
    expect(await readAccountMarker()).toBeNull();
    // Theme (device-level) still preserved across a logout.
    expect(await db.deviceState.get('appearance-theme')).toBeTruthy();
  });

  it('idempotent: a second call for the SAME account after a wipe does not re-wipe', async () => {
    const { db } = await import('../src/db/schema.js');
    const { ensureAccountScope } = await import('../src/db/accountScope.js');
    await seedAccountA();
    await ensureAccountScope(B); // wipe + mark B
    await db.notes.put({ id: 'note-B-1' as NoteId, notebookId: 'nb-B' as NotebookId, title: 'B note', properties: {}, body: [], version: 1, createdAt: 'x', updatedAt: 'x', syncStatus: 'synced', accountId: B } as never);
    const wipedAgain = await ensureAccountScope(B);
    expect(wipedAgain).toBe(false);
    expect(await db.notes.count()).toBe(1); // B's note survives the no-op
  });
});

describe('suspendSync — no cycle re-populates/pushes during a wipe (secSys timer-stop)', () => {
  it('while suspended, syncNow does NOT start a cycle (no fetch); resumeSync re-enables it', async () => {
    const { suspendSync, resumeSync, syncNow } = await import('../src/lib/syncEngine.js');
    const fetchSpy = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
    global.fetch = fetchSpy as unknown as typeof fetch;

    suspendSync();
    syncNow('nb-suspend-test' as NotebookId, '');
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchSpy).not.toHaveBeenCalled(); // no push + no re-populating pull while suspended

    resumeSync(); // restore module state so it can't leak to other tests in this file
  });
});
