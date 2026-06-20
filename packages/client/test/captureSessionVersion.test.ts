/**
 * Store-level test for the #45 history-capture write+prune path: dexieLocalStore.captureSessionVersion.
 * Runs against the real Dexie schema over fake-indexeddb (no fake timers — see dexie-faketimers-deadlock).
 * Verifies: the atomic insert; retention pruning of the OLDEST 'session' rows beyond the cap; that
 * 'conflict' rows are NEVER pruned; and that pruning is account-scoped (one account's cap can't evict
 * another account's versions).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import type { NoteId } from '@deltos/shared';
import type { NoteVersion } from '../src/db/schema.js';
import { dexieLocalStore } from '../src/db/dexieLocalStore.js';

const NOTE = 'note-hist-00000000-0000-4000-8000-000000000001' as NoteId;
const ACCT = 'acct-hist-1';

beforeEach(async () => {
  const { db } = await import('../src/db/schema.js');
  await Promise.all(db.tables.map((t) => t.clear()));
});

function sessionRow(seq: number, accountId = ACCT, noteId = NOTE): NoteVersion {
  return {
    id: `v-${accountId}-${seq}`,
    noteId,
    accountId,
    kind: 'session',
    title: `Title ${seq}`,
    properties: {},
    body: [{ id: 'b1', type: 'paragraph', content: { segments: [{ text: `body ${seq}` }] } }],
    baseVersion: 1,
    // monotonically increasing createdAt — seq 0 is the OLDEST
    createdAt: new Date(Date.UTC(2026, 5, 20, 0, 0, seq)).toISOString(),
    charsAdded: seq,
    charsRemoved: 0,
  };
}

async function versionsFor(noteId = NOTE, accountId = ACCT): Promise<NoteVersion[]> {
  const { db } = await import('../src/db/schema.js');
  return db.noteVersions.where('[noteId+accountId]').equals([noteId, accountId]).toArray();
}

describe('captureSessionVersion — write + retention prune', () => {
  it('inserts the session version row', async () => {
    await dexieLocalStore.captureSessionVersion(sessionRow(0), 50);
    const rows = await versionsFor();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('session');
    expect(rows[0]!.charsAdded).toBe(0);
  });

  it('prunes the OLDEST session rows beyond the cap (newest retained)', async () => {
    const cap = 3;
    for (let i = 0; i < 5; i++) {
      await dexieLocalStore.captureSessionVersion(sessionRow(i), cap);
    }
    const rows = (await versionsFor()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    expect(rows).toHaveLength(cap);
    // seq 0 and 1 (the two oldest) pruned; 2,3,4 retained
    expect(rows.map((r) => r.id)).toEqual(['v-acct-hist-1-2', 'v-acct-hist-1-3', 'v-acct-hist-1-4']);
  });

  it('NEVER prunes conflict rows, even when over the session cap', async () => {
    const { db } = await import('../src/db/schema.js');
    // a pre-existing unresolved conflict version
    await db.noteVersions.add({ ...sessionRow(0), id: 'conflict-1', kind: 'conflict' });
    const cap = 2;
    for (let i = 1; i <= 4; i++) {
      await dexieLocalStore.captureSessionVersion(sessionRow(i), cap);
    }
    const rows = await versionsFor();
    const conflicts = rows.filter((r) => r.kind === 'conflict');
    const sessions = rows.filter((r) => r.kind === 'session');
    expect(conflicts).toHaveLength(1); // conflict survives regardless of the session cap
    expect(sessions).toHaveLength(cap); // only sessions are capped
  });

  it('prune is account-scoped: one account hitting its cap does not evict another account', async () => {
    const cap = 2;
    // account A: 3 versions (will prune to 2); account B: 2 versions (untouched)
    for (let i = 0; i < 2; i++) await dexieLocalStore.captureSessionVersion(sessionRow(i, 'acct-B'), cap);
    for (let i = 0; i < 3; i++) await dexieLocalStore.captureSessionVersion(sessionRow(i, ACCT), cap);
    expect(await versionsFor(NOTE, ACCT)).toHaveLength(2);
    expect(await versionsFor(NOTE, 'acct-B')).toHaveLength(2); // B unaffected by A's prune
  });
});
