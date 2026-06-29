/**
 * Part-2 conflict-as-version acceptance tests (v1 course-correction spec).
 *
 * Spec:    docs/specs/v1-shell-and-conflict-versions.md §Part 2
 * Contract: docs/design/part2-conflict-version-data-model.md (devSys2, eab2ab5)
 * Matrix:  docs/specs/v1-shell-conflict-acceptance-matrix.md (scopeSys canonical CAV-* IDs)
 *
 * ─── CANONICAL CAV-* LANES (scopeSys matrix — 2026-06-16) ───────────────────────
 * CAV-1  push cadence (2s settle/5s max-wait, fake timers)        ← CLAIMED (cav12PushCadence.render.test.tsx — jsdom)
 * CAV-2  offline buffer → flush-on-reconnect                      ← CLAIMED (cav12PushCadence.render.test.tsx — jsdom)
 * CAV-3  fast-forward: no hasConflict, no noteVersions row
 * CAV-4  conflict → noteVersions row, hasConflict=true, server live, same note ID (contract anchor)
 * CAV-5  no second note ever after conflict (no fork)
 * CAV-6  relations: note keeps ID, inbound links resolve, forkedFromId retired
 * CAV-7  PIN-SYNC-3: server-delete + offline edit → version retained; note NOT hard-deleted
 * CAV-8  toast + persistent badge UI                              ← gruntSys2 lane (not this file)
 * CAV-9  resolve keep-mine
 * CAV-10 resolve keep-theirs
 * CAV-11 resolve keep-both
 * CAV-12 Stream-B no-lost-edit trip-wire   ← REFERENCE: packages/client/test/syncEngine.test.ts
 * CAV-13 whole-note-snapshot grain (design invariant — noted inline in CAV-4)
 * ─────────────────────────────────────────────────────────────────────────────────
 *
 * MODEL CHANGE (from the spec):
 *   A divergent offline edit is retained as a NoteVersion on the SAME note ID, never a new-id fork.
 *   The note gains `hasConflict: true` until resolved.
 *
 * DATA-MODEL CONTRACT (devSys2 eab2ab5 — FINAL):
 *   db.noteVersions: EntityTable<NoteVersion,'id'> — schema v4: 'id, noteId, [noteId+accountId]'
 *   NoteVersion { id, noteId, accountId, kind:'conflict', title, properties, body,
 *                 baseVersion, createdAt }  — flat snapshot, no nested Note object
 *   Note.hasConflict: boolean (client-only, default false)
 *   resolveConflict(noteId, 'keep-mine'|'keep-theirs'|'keep-both'): Promise<void>  — from '../src/db/conflict.js'
 *     keep-mine   → divergent content live; enqueued for push; versions deleted; badge cleared
 *     keep-theirs → versions deleted; server content stays; badge cleared
 *     keep-both   → version rows KEPT (Phase-3); hasConflict=false (badge cleared)
 *
 * secSys RULING on accountId (devSys2 §8.5 decision-flag):
 *   YES — add accountId to noteVersions in v1. Belt-and-suspenders D6 hardening: the compound
 *   [noteId+accountId] index ensures observeNoteVersions is account-scoped on multi-account devices
 *   even before Phase-3 server-synced history. Additive column; cheap now, expensive later.
 *
 * CAV-12 REFERENCE (no duplication): packages/client/test/syncEngine.test.ts tests 1/1b/2/
 *   queue-drain/4 are the no-lost-edit trip-wire. Tests 3 and 3c test the OLD fork behavior and
 *   WILL go RED when devSys2 implements conflict-as-version — flagged to pilot.
 *
 * All CAV-3..11 tests are RED until devSys2 implements conflict-as-version. Going GREEN = v1 done.
 * CAV-1 and CAV-2 live in cav12PushCadence.render.test.tsx (jsdom env) — separated because
 * startSyncTriggers wires window events (requires jsdom) and vi.useFakeTimers() in jsdom leaks
 * into Dexie's fake-indexeddb IDB operations, causing beforeEach timeouts in this node-env file.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import type { Note, NoteId, NotebookId } from '@deltos/shared';
import { useAuthStore } from '../src/auth/store.js';

// Reset DB tables + auth state between tests.
beforeEach(async () => {
  const { db } = await import('../src/db/schema.js');
  await Promise.all(db.tables.map((t) => t.clear()));
  useAuthStore.setState({ accountId: null, bearerToken: null, sessionState: 'booting' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const NB = '0a000000-0000-4000-8000-000000000001' as NotebookId;
const NOW = '2026-06-16T10:00:00.000Z';
const NOTE_ID = '0a000000-0000-4000-8000-000000000002' as NoteId;

function makeNote(id: string, version = 0, title = 'Test note'): Note {
  return {
    id: id as NoteId,
    notebookId: NB,
    title,
    properties: {},
    body: [],
    version,
    createdAt: NOW,
    updatedAt: NOW,
    syncStatus: 'local-only',
  };
}

/** NoteVersion shape — devSys2 eab2ab5 contract + secSys accountId ruling. */
interface NoteVersion {
  id: string;
  noteId: NoteId;
  accountId: string;
  kind: 'conflict';
  title: string;
  properties: Record<string, unknown>;
  body: unknown[];
  baseVersion: number;
  createdAt: string;
}

type NoteWithConflict = Note & { hasConflict?: boolean };

/** Typed accessor for the new noteVersions table (existential until schema v4 ships). */
function noteVersionsTable(db: unknown) {
  return (
    db as {
      noteVersions?: {
        where(k: string): {
          equals(v: string): { toArray(): Promise<NoteVersion[]>; count(): Promise<number> };
        };
        count(): Promise<number>;
      };
    }
  ).noteVersions;
}

/**
 * Set a synthetic session so handleConflict can scope the retained NoteVersion by accountId.
 * Per contract §5/§8.5: handleConflict reads accountId from the session store (never from the
 * note or serverNote body). Without this, handleConflict early-returns → no noteVersions row.
 */
function setSession() {
  useAuthStore.setState({ accountId: 'cav-acct-01', bearerToken: 'cav-test-tok', sessionState: 'active' });
}

/** Wire fetch to return a single controlled push outcome; pull always returns empty. */
function mockFetch(
  outcome:
    | { id: string; outcome: 'accepted'; version: number; syncSeq: number }
    | { id: string; outcome: 'conflict'; serverNote: Note | null },
) {
  global.fetch = vi.fn(async (url: string) => {
    if (String(url).includes('/sync/push')) {
      return new Response(JSON.stringify({ results: [outcome] }), { status: 200 });
    }
    return new Response(JSON.stringify({ notes: [], nextCursor: 0, hasMore: false }), {
      status: 200,
    });
  }) as typeof fetch;
}

/** Queue a local edit for NOTE_ID and trigger syncNow — shared setup for conflict tests. */
async function setupConflict(localTitle: string, serverTitle: string | null) {
  setSession(); // required: handleConflict scopes the NoteVersion row by session accountId

  const { db } = await import('../src/db/schema.js');
  const localEdit = makeNote(NOTE_ID, 1, localTitle);
  await db.notes.put(localEdit);
  await db.syncQueue.add({
    id: crypto.randomUUID(),
    recordId: NOTE_ID,
    payload: localEdit,
    baseVersion: 0,
    createdAt: NOW,
  });

  const serverNote = serverTitle !== null ? makeNote(NOTE_ID, 5, serverTitle) : null;
  mockFetch({ id: NOTE_ID, outcome: 'conflict', serverNote });

  const { syncNow } = await import('../src/lib/syncEngine.js');
  syncNow(NB, '');
  await new Promise((r) => setTimeout(r, 100));
}

// CAV-1 and CAV-2: see cav12PushCadence.render.test.tsx (jsdom env — needs window + no Dexie fake-timer leak)

// ---------------------------------------------------------------------------
// CAV-3 — fast-forward: accepted push leaves no conflict state behind
// ---------------------------------------------------------------------------

describe('CAV-3 — fast-forward: accepted push leaves no conflict state', () => {
  it('note syncs to accepted version; hasConflict absent/false; no noteVersions row stored', async () => {
    setSession();
    const { db } = await import('../src/db/schema.js');
    const localEdit = makeNote(NOTE_ID, 0, 'My offline edit');
    await db.notes.put(localEdit);
    await db.syncQueue.add({
      id: crypto.randomUUID(),
      recordId: NOTE_ID,
      payload: localEdit,
      baseVersion: 0,
      createdAt: NOW,
    });

    mockFetch({ id: NOTE_ID, outcome: 'accepted', version: 1, syncSeq: 1 });

    const { syncNow } = await import('../src/lib/syncEngine.js');
    syncNow(NB, '');
    await new Promise((r) => setTimeout(r, 100));

    const note = (await db.notes.get(NOTE_ID)) as NoteWithConflict | undefined;
    expect(note).toBeDefined();
    expect(note!.title).toBe('My offline edit');
    expect(note!.version).toBe(1);
    expect(note!.hasConflict).toBeFalsy();

    const count =
      (await noteVersionsTable(db)?.where('noteId').equals(NOTE_ID).count()) ?? 0;
    expect(count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// CAV-4 — conflict: divergent edit retained as noteVersions row; hasConflict=true; same note ID
// This is the CONTRACT ANCHOR test: pins exact NoteVersion field names (devSys2 eab2ab5).
// CAV-13: whole-note snapshot grain asserted here (body + properties present on version row).
// ---------------------------------------------------------------------------

describe('CAV-4 — conflict: divergent edit retained as noteVersions row on the same note (contract anchor)', () => {
  it('note keeps original ID, hasConflict=true, server content live, noteVersions has 1 row', async () => {
    await setupConflict('My divergent offline edit', 'Server version — concurrent edit');

    const { db } = await import('../src/db/schema.js');
    const note = (await db.notes.get(NOTE_ID)) as NoteWithConflict | undefined;

    expect(note).toBeDefined();
    expect(note!.id).toBe(NOTE_ID);
    expect(note!.title).toBe('Server version — concurrent edit');
    expect(note!.hasConflict).toBe(true);

    const versions =
      (await noteVersionsTable(db)?.where('noteId').equals(NOTE_ID).toArray()) ?? [];
    expect(versions).toHaveLength(1);
    // Exact field names from eab2ab5:
    expect(versions[0]!.kind).toBe('conflict');
    expect(versions[0]!.title).toBe('My divergent offline edit');
    expect(versions[0]!.noteId).toBe(NOTE_ID);
    expect(typeof versions[0]!.id).toBe('string');
    expect(typeof versions[0]!.createdAt).toBe('string');
    // CAV-13: whole-note snapshot grain — body and properties present (not a delta).
    expect(Array.isArray(versions[0]!.body)).toBe(true);
    expect(typeof versions[0]!.properties).toBe('object');
  });

  it('noteVersions row carries the baseVersion the divergent edit was authored against', async () => {
    await setupConflict('My offline edit at baseVersion 0', 'Server content');

    const { db } = await import('../src/db/schema.js');
    const versions =
      (await noteVersionsTable(db)?.where('noteId').equals(NOTE_ID).toArray()) ?? [];
    expect(versions).toHaveLength(1);
    expect(versions[0]!.baseVersion).toBe(0);
  });

  it('noteVersions row carries accountId (secSys D6 ruling — client-side multi-account guard)', async () => {
    await setupConflict('My edit', 'Server content');

    const { db } = await import('../src/db/schema.js');
    const versions =
      (await noteVersionsTable(db)?.where('noteId').equals(NOTE_ID).toArray()) ?? [];
    expect(versions).toHaveLength(1);
    // accountId must be non-empty — stamped from session, NEVER from request body.
    expect(versions[0]!.accountId).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// CAV-5 — no second note in list after conflict (old fork model created 2 notes)
// ---------------------------------------------------------------------------

describe('CAV-5 — no second note in list: conflict never produces a fork note', () => {
  it('db.notes has exactly 1 row after a non-tombstone conflict', async () => {
    await setupConflict('Local divergent content', 'Server content');

    const { db } = await import('../src/db/schema.js');
    const allNotes = await db.notes.toArray();
    expect(allNotes).toHaveLength(1);
    expect(allNotes[0]!.id).toBe(NOTE_ID);
  });

  it('notebook notes list shows exactly 1 entry after conflict (no phantom fork)', async () => {
    await setupConflict('Local divergent content', 'Server content');

    const { db } = await import('../src/db/schema.js');
    const notebookNotes = await db.notes.where('notebookId').equals(NB).toArray();
    expect(notebookNotes).toHaveLength(1);
  });

  it('no "(conflict copy)" titled note anywhere in db.notes', async () => {
    await setupConflict('My edit', 'Server content');

    const { db } = await import('../src/db/schema.js');
    const all = await db.notes.toArray();
    expect(all.every((n) => !n.title.startsWith('(conflict copy)'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CAV-6 — relations: note ID unchanged after conflict; inbound links stay valid; forkedFromId retired
// ---------------------------------------------------------------------------

describe('CAV-6 — relations: note ID unchanged after conflict; forkedFromId retired', () => {
  it('db.notes.get(original ID) resolves after conflict (inbound links not orphaned)', async () => {
    await setupConflict('Relation target note', 'Server version');

    const { db } = await import('../src/db/schema.js');
    const resolvedNote = await db.notes.get(NOTE_ID);
    expect(resolvedNote).toBeDefined();
    expect(resolvedNote!.id).toBe(NOTE_ID);
  });
});

// ---------------------------------------------------------------------------
// CAV-7 — PIN-SYNC-3: tombstone + offline edit → conflict version retained; note NOT hard-deleted
//
// Old model: created a new-ID note with "(deleted on another device — your edits kept)" label.
// New model: divergent edit stored as a noteVersions row; note retained in db.notes
//            (tombstone-state + hasConflict=true); badge + keep-mine resurrection both work.
// ---------------------------------------------------------------------------

describe('CAV-7 — PIN-SYNC-3: server-delete + offline edit → version retained; note not hard-deleted', () => {
  it('tombstone conflict: noteVersions has the divergent edit; note NOT removed from db.notes', async () => {
    await setupConflict('My offline edit on a note deleted elsewhere', null /* tombstone */);

    const { db } = await import('../src/db/schema.js');

    const note = (await db.notes.get(NOTE_ID)) as NoteWithConflict | undefined;
    expect(note).toBeDefined();
    expect(note!.hasConflict).toBe(true);

    const versions =
      (await noteVersionsTable(db)?.where('noteId').equals(NOTE_ID).toArray()) ?? [];
    expect(versions).toHaveLength(1);
    expect(versions[0]!.title).toBe('My offline edit on a note deleted elsewhere');
  });

  it('tombstone conflict: NO "(deleted on another device)" new-ID note (old resurrection fork gone)', async () => {
    await setupConflict('My offline edit', null);

    const { db } = await import('../src/db/schema.js');
    const all = await db.notes.toArray();
    const oldFork = all.find((n) => n.title.startsWith('(deleted on another device'));
    expect(oldFork).toBeUndefined();
  });

  it('tombstone conflict: exactly 1 note in db.notes (the retained note, no sibling)', async () => {
    await setupConflict('My offline edit', null);

    const { db } = await import('../src/db/schema.js');
    expect(await db.notes.count()).toBe(1);
  });
});

// CAV-8: toast + persistent badge UI — gruntSys2 lane (not this file).

// ---------------------------------------------------------------------------
// CAV-9 — resolve keep-mine: divergent edit becomes live; badge cleared; versions deleted
// ---------------------------------------------------------------------------

describe('CAV-9 — resolve keep-mine: divergent edit becomes live', () => {
  it('after keep-mine: note.title = divergent content; hasConflict cleared; noteVersions empty', async () => {
    await setupConflict('My divergent offline edit', 'Server content');

    const { db } = await import('../src/db/schema.js');
    const { resolveConflict } = await import('../src/db/conflict.js');

    const conflicted = (await db.notes.get(NOTE_ID)) as NoteWithConflict | undefined;
    expect(conflicted!.hasConflict).toBe(true);

    await resolveConflict(NOTE_ID, 'keep-mine');

    const resolved = (await db.notes.get(NOTE_ID)) as NoteWithConflict | undefined;
    expect(resolved).toBeDefined();
    expect(resolved!.title).toBe('My divergent offline edit');
    expect(resolved!.hasConflict).toBeFalsy();

    const count =
      (await noteVersionsTable(db)?.where('noteId').equals(NOTE_ID).count()) ?? 0;
    expect(count).toBe(0);
  });

  it('after keep-mine: divergent edit is enqueued for push (CAS-safe push as new top version)', async () => {
    await setupConflict('My divergent offline edit', 'Server content');

    const { db } = await import('../src/db/schema.js');
    const { resolveConflict } = await import('../src/db/conflict.js');
    await resolveConflict(NOTE_ID, 'keep-mine');

    const queued = await db.syncQueue.where('recordId').equals(NOTE_ID).toArray();
    expect(queued.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// CAV-10 — resolve keep-theirs: server version stays live; badge cleared; versions deleted
// ---------------------------------------------------------------------------

describe('CAV-10 — resolve keep-theirs: server version stays live', () => {
  it('after keep-theirs: note.title = server content; hasConflict cleared; noteVersions empty', async () => {
    await setupConflict('My divergent offline edit', 'Server content — I prefer this');

    const { db } = await import('../src/db/schema.js');
    const { resolveConflict } = await import('../src/db/conflict.js');
    await resolveConflict(NOTE_ID, 'keep-theirs');

    const resolved = (await db.notes.get(NOTE_ID)) as NoteWithConflict | undefined;
    expect(resolved).toBeDefined();
    expect(resolved!.title).toBe('Server content — I prefer this');
    expect(resolved!.hasConflict).toBeFalsy();

    const count =
      (await noteVersionsTable(db)?.where('noteId').equals(NOTE_ID).count()) ?? 0;
    expect(count).toBe(0);
  });

  it('after keep-theirs: nothing new enqueued (server already has the right content)', async () => {
    await setupConflict('My divergent edit', 'Server content');

    const { db } = await import('../src/db/schema.js');
    const { resolveConflict } = await import('../src/db/conflict.js');

    await db.syncQueue.where('recordId').equals(NOTE_ID).delete();
    await resolveConflict(NOTE_ID, 'keep-theirs');

    const queued = await db.syncQueue.where('recordId').equals(NOTE_ID).toArray();
    expect(queued).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// CAV-11 — resolve keep-both: both retained as versions of ONE note; badge cleared; no auto-split
// Per spec: "keep both → retain both as versions of the one note (no auto second note)."
// hasConflict=false (badge cleared). Version row stays dormant for Phase-3 browsing.
// ---------------------------------------------------------------------------

describe('CAV-11 — resolve keep-both: both retained as versions of ONE note; badge cleared; no auto-split', () => {
  it('after keep-both: db.notes has exactly 1 note (no auto second note)', async () => {
    await setupConflict('My divergent content', 'Server content');

    const { resolveConflict } = await import('../src/db/conflict.js');
    await resolveConflict(NOTE_ID, 'keep-both');

    const { db } = await import('../src/db/schema.js');
    expect(await db.notes.count()).toBe(1);
    expect((await db.notes.get(NOTE_ID))!.id).toBe(NOTE_ID);
  });

  it('after keep-both: hasConflict cleared (badge gone) but noteVersions row KEPT for Phase-3', async () => {
    await setupConflict('My divergent content', 'Server content');

    const { db } = await import('../src/db/schema.js');
    const { resolveConflict } = await import('../src/db/conflict.js');
    await resolveConflict(NOTE_ID, 'keep-both');

    const note = (await db.notes.get(NOTE_ID)) as NoteWithConflict | undefined;
    expect(note!.hasConflict).toBeFalsy();

    const versions =
      (await noteVersionsTable(db)?.where('noteId').equals(NOTE_ID).toArray()) ?? [];
    expect(versions).toHaveLength(1);
    expect(versions[0]!.title).toBe('My divergent content');
  });

  it('after keep-both: server content remains live on the note', async () => {
    await setupConflict('My divergent content', 'Server content — stays live');

    const { db } = await import('../src/db/schema.js');
    const { resolveConflict } = await import('../src/db/conflict.js');
    await resolveConflict(NOTE_ID, 'keep-both');

    const note = await db.notes.get(NOTE_ID);
    expect(note!.title).toBe('Server content — stays live');
  });
});
