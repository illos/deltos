/**
 * Swipe-actions Lane-1 data-layer regression tests (Fork P — trash flag in PropertyBag).
 *
 *   SA-T1 softDelete → trashed: hidden from the main list, shown in the trash view, ROW PERSISTS
 *                      (recoverable), enqueued as a plain upsert at the live CAS base.
 *   SA-T2 restore    → un-trashed: back in the main list, gone from the trash view, no key residue.
 *   SA-T3 duplicate  → new id, both rows, copied content, reserved (sys:) keys STRIPPED (a copy of a
 *                      TRASHED note is always LIVE + clean).
 *   SA-T4 no-loss    → trash toggle WHILE a pending (unsynced) edit exists: the edit is NOT dropped
 *                      (the trash upsert carries the latest content; own queue entries).
 *   secSys-A         → trash/restore enqueue at the LIVE persisted version (CAS base, not LWW): a
 *                      stale caller note.version cannot become the base → a replayed toggle CAS-misses.
 *   secSys-B         → FAIL-SAFE list filter: a malformed/garbage sys:trashedAt value defaults to
 *                      VISIBLE (never silently hidden) and stays out of the trash view (not lost).
 *
 * The server round-trip on real D1 (worker CAS) + the deeper in-flight sync-engine races are devSys's
 * lane (the worker-side regression suite).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import type { Note, NoteId, NotebookId, PropertyBag } from '@deltos/shared';
import { setTrashedAt, trashedAt, isTrashed, SYS_TRASHED_AT_KEY } from '@deltos/shared';
import { useAuthStore } from '../src/auth/store.js';
import { getStore } from '../src/db/store.js';
import { mutateNotes } from '../src/db/mutate.js';
import type { ClientNote } from '../src/db/schema.js';

const NB = 'nb-sa-00000000-0000-4000-8000-000000000001' as NotebookId;
const NOTE_ID = 'note-sa-0000-0000-4000-8000-000000000001' as NoteId;
const NOW = '2026-06-17T10:00:00.000Z';

beforeEach(async () => {
  const { db } = await import('../src/db/schema.js');
  await Promise.all([db.notes.clear(), db.syncQueue.clear(), db.notebooks.clear(), db.noteVersions.clear()]);
  useAuthStore.setState({ accountId: 'sa-acct', bearerToken: 'sa-tok', sessionState: 'active' });
});

afterEach(() => vi.restoreAllMocks());

function makeNote(id: string, version: number, title: string, properties: PropertyBag = {}): Note {
  return {
    id: id as NoteId, notebookId: NB, title, properties, body: [],
    version, createdAt: NOW, updatedAt: NOW, syncStatus: 'synced',
  };
}

function liveOnce(): Promise<ClientNote[]> {
  return new Promise((resolve) => { const u = getStore().observeNotes((n) => { u(); resolve(n); }); });
}
function trashOnce(): Promise<ClientNote[]> {
  return new Promise((resolve) => { const u = getStore().observeTrashedNotes((n) => { u(); resolve(n); }); });
}
async function seedSynced(version = 1, title = 'My note') {
  const { db } = await import('../src/db/schema.js');
  const note = makeNote(NOTE_ID, version, title);
  await db.notes.put(note);
  return note;
}

describe('SA-T1 — softDelete: trashed (hidden + recoverable + enqueued at live base)', () => {
  it('sets sys:trashedAt, persists the row, hides from the list / shows in trash, enqueues a plain upsert', async () => {
    const { db } = await import('../src/db/schema.js');
    const note = await seedSynced(1);

    await mutateNotes.softDelete(note);

    const row = (await db.notes.get(NOTE_ID)) as ClientNote;
    expect(row).toBeDefined();                                   // ROW PERSISTS (recoverable)
    expect(trashedAt(row.properties)).toBeTruthy();              // trash flag set
    expect((await liveOnce()).find((n) => n.id === NOTE_ID)).toBeUndefined();  // out of the main list
    expect((await trashOnce()).find((n) => n.id === NOTE_ID)).toBeDefined();   // in the trash view
    const entries = await db.syncQueue.where('recordId').equals(NOTE_ID).toArray();
    expect(entries).toHaveLength(1);
    expect((entries[0] as { op?: unknown }).op).toBeUndefined(); // plain upsert (no op)
    expect(entries[0].baseVersion).toBe(1);                      // live CAS base
    expect(trashedAt(entries[0].payload.properties)).toBeTruthy(); // the pushed payload carries the flag
  });
});

describe('SA-T2 — restore (undo): un-trashed (back in list, no residue)', () => {
  it('clears sys:trashedAt (omitted), returns to the list / leaves trash, enqueues a plain upsert', async () => {
    const { db } = await import('../src/db/schema.js');
    const note = await seedSynced(1);
    await mutateNotes.softDelete(note);

    await mutateNotes.restore(note);

    const row = (await db.notes.get(NOTE_ID)) as ClientNote;
    expect(trashedAt(row.properties)).toBeNull();                // flag cleared
    expect(SYS_TRASHED_AT_KEY in row.properties).toBe(false);    // key OMITTED — no residue
    expect((await liveOnce()).find((n) => n.id === NOTE_ID)).toBeDefined();    // back in the list
    expect((await trashOnce()).find((n) => n.id === NOTE_ID)).toBeUndefined(); // gone from trash
    // A restore entry was enqueued whose payload carries a CLEAN bag (no trash key) — order-independent.
    const entries = await db.syncQueue.where('recordId').equals(NOTE_ID).toArray();
    expect(entries.some((e) => !(SYS_TRASHED_AT_KEY in e.payload.properties))).toBe(true);
  });
});

describe('SA-T3 — duplicate: new id, both rows, reserved keys stripped (live + clean copy)', () => {
  it('a duplicate of a TRASHED note is LIVE (no sys: keys), new id, copied content, both rows present', async () => {
    const { db } = await import('../src/db/schema.js');
    await seedSynced(3, 'Original');
    await mutateNotes.softDelete(await db.notes.get(NOTE_ID) as Note); // give it a sys:trashedAt
    const trashedRow = (await db.notes.get(NOTE_ID)) as Note;

    const dup = await mutateNotes.duplicate(trashedRow);

    expect(dup.id).not.toBe(NOTE_ID);
    expect(dup.title).toBe('Original');
    expect(dup.version).toBe(0);
    expect(isTrashed(dup.properties)).toBe(false);                       // not trashed
    expect(Object.keys(dup.properties).some((k) => k.startsWith('sys:'))).toBe(false); // NO reserved keys
    expect((await liveOnce()).find((n) => n.id === dup.id)).toBeDefined();             // in the LIVE list
    expect((await trashOnce()).find((n) => n.id === dup.id)).toBeUndefined();          // not trashed
    const dupEntries = await db.syncQueue.where('recordId').equals(dup.id).toArray();
    expect(dupEntries).toHaveLength(1);
    expect(dupEntries[0].baseVersion).toBe(0);                          // INSERT
  });
});

describe('SA-T4 — trash toggle while a pending edit exists: no data loss', () => {
  it('softDelete after an unsynced edit retains the edit content + trashes it; both entries enqueued (own ids)', async () => {
    const { db } = await import('../src/db/schema.js');
    await seedSynced(1, 'A');

    // Pending edit (not yet synced) — content advances to 'AB'.
    await mutateNotes.put(makeNote(NOTE_ID, 1, 'AB'));
    // Now trash the edited note (the UI passes the current, edited note).
    await mutateNotes.softDelete(makeNote(NOTE_ID, 1, 'AB'));

    const row = (await db.notes.get(NOTE_ID)) as ClientNote;
    expect(row.title).toBe('AB');                          // the edit is NOT lost
    expect(trashedAt(row.properties)).toBeTruthy();        // and it's trashed
    const entries = await db.syncQueue.where('recordId').equals(NOTE_ID).toArray();
    expect(entries.length).toBeGreaterThanOrEqual(2);      // edit entry + trash entry survive
    expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length); // distinct entry ids
    // The trash entry (an ordinary upsert) carries the LATEST content — pushing 'AB' + trashed, no loss.
    const trashEntry = entries.find((e) => trashedAt(e.payload.properties) !== null);
    expect(trashEntry).toBeDefined();
    expect(trashEntry!.payload.title).toBe('AB');
  });
});

describe('secSys-A — toggle uses the live CAS base, never last-write-wins', () => {
  it('softDelete enqueues at the LIVE persisted version even when the caller passes a stale note.version', async () => {
    const { db } = await import('../src/db/schema.js');
    await seedSynced(5, 'X');                          // server-confirmed at version 5
    const stale = makeNote(NOTE_ID, 1, 'X');           // caller still holds version 1

    await mutateNotes.softDelete(stale);

    const entry = (await db.syncQueue.where('recordId').equals(NOTE_ID).toArray())[0];
    expect(entry.baseVersion).toBe(5);                 // live base, NOT the stale 1 → CAS, not LWW
  });
});

describe('secSys-B — fail-safe: a garbage trash value stays VISIBLE', () => {
  it('a malformed (non-date) sys:trashedAt value reads as NOT trashed: visible in the list, absent from trash', async () => {
    const { db } = await import('../src/db/schema.js');
    const corruptProps = { [SYS_TRASHED_AT_KEY]: { type: 'text', value: 'corrupt' } } as unknown as PropertyBag;
    await db.notes.put(makeNote(NOTE_ID, 1, 'Garbage', corruptProps));

    expect((await liveOnce()).find((n) => n.id === NOTE_ID)).toBeDefined();    // VISIBLE (never silently hidden)
    expect((await trashOnce()).find((n) => n.id === NOTE_ID)).toBeUndefined(); // and not lost into trash
  });
});
