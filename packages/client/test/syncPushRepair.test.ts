/**
 * Fix B — one bad note must NOT wedge ALL sync (push validate → repair → quarantine).
 *
 * The regression: a render-only block id (e.g. `${atomId}~w`) leaked into a note's persisted body. Block
 * ids are strict UUIDs (BlockIdSchema), so that note fails SyncPushEntrySchema and the worker returns
 * `push 400` on the WHOLE batch → the queue never drains → every other edit piles up behind it.
 *
 * The fix validates each entry CLIENT-SIDE against the same SyncPushEntrySchema the server uses, REPAIRs
 * the common case (re-mint non-UUID block ids in the body — self-heals already-leaked corruption), and
 * QUARANTINEs anything still invalid so it can never block the good entries. The invariant: the push body
 * sent to the server contains ONLY schema-valid entries.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import type { Note, NotebookId, BlockId } from '@deltos/shared';
import { SyncPushEntrySchema, BlockIdSchema } from '@deltos/shared';

beforeEach(async () => {
  const { db } = await import('../src/db/schema.js');
  await Promise.all([db.notes.clear(), db.syncQueue.clear(), db.notebooks.clear(), db.noteVersions.clear()]);
});

const NB = '33333333-0000-4000-8000-000000000001' as NotebookId;
const NOW = '2026-06-15T12:00:00.000Z';
const isUuid = (id: unknown) => BlockIdSchema.safeParse(id).success;

function makeNote(id: string, body: Note['body'] = [], title = 'Test note'): Note {
  return {
    id: id as Note['id'],
    notebookId: NB,
    title,
    properties: {},
    body,
    version: 0,
    createdAt: NOW,
    updatedAt: NOW,
    syncStatus: 'local-only',
  };
}

/** Mock server: accept every entry that arrives in the push body; record what was sent. */
function mockAcceptAll(capturedEntries: unknown[]): void {
  const storage: Record<string, string> = {};
  global.localStorage = {
    getItem: (k: string) => storage[k] ?? null,
    setItem: (k: string, v: string) => { storage[k] = v; },
    removeItem: (k: string) => { delete storage[k]; },
  } as unknown as Storage;

  global.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/sync/push')) {
      const parsed = JSON.parse(String(init!.body)) as { entries: { id: string }[] };
      capturedEntries.push(...parsed.entries);
      return new Response(
        JSON.stringify({ results: parsed.entries.map((e) => ({ id: e.id, outcome: 'accepted', version: 1, syncSeq: 1 })) }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ notes: [], nextCursor: 0, hasMore: false }), { status: 200 });
  }) as typeof fetch;
}

const CORRUPT_BODY = (uuid: string): Note['body'] => [
  // The exact leak shape from the prod snapshot: a paragraph carrying a `${uuid}~w` (render-only) id.
  { id: `${uuid}~w` as BlockId, type: 'paragraph', content: { segments: [{ text: 'orphaned wrapper' }] } },
];

describe('push resilience: a corrupt note is repaired + drains, and never blocks a sibling', () => {
  it('repairs a non-UUID block id in the body, drains the corrupt AND a valid sibling, sends only valid entries', async () => {
    const { db } = await import('../src/db/schema.js');

    const corruptId = '5fbad000-0000-4000-8000-000000000001';
    const validId = '600d0000-0000-4000-8000-000000000002';
    const corrupt = makeNote(corruptId, CORRUPT_BODY('c668eee8-b091-4d27-a933-d3dabfa94de6'), 'HOUSE ORDER');
    const valid = makeNote(validId, [{ id: '0000aaaa-0000-4000-8000-000000000003' as BlockId, type: 'paragraph', content: { segments: [{ text: 'fine' }] } }], 'fine note');

    await db.notes.bulkPut([corrupt, valid]);
    await db.syncQueue.bulkAdd([
      { id: crypto.randomUUID(), recordId: corruptId, payload: corrupt, baseVersion: 0, createdAt: '2026-06-15T12:00:00.001Z' },
      { id: crypto.randomUUID(), recordId: validId, payload: valid, baseVersion: 0, createdAt: '2026-06-15T12:00:00.002Z' },
    ]);

    const captured: unknown[] = [];
    mockAcceptAll(captured);

    const { syncNow } = await import('../src/lib/syncEngine.js');
    syncNow(NB, '');
    await new Promise((r) => setTimeout(r, 80));

    // INVARIANT: every entry POSTed to the server is schema-valid (no 400 possible on validation).
    expect(captured.length).toBe(2);
    for (const e of captured) expect(SyncPushEntrySchema.safeParse(e).success).toBe(true);

    // The corrupt note's body was re-minted in the canonical record (self-heal) — valid UUID, no `~w`.
    const healed = await db.notes.get(corruptId as Note['id']);
    expect(healed!.body[0]!.id).not.toContain('~');
    expect(isUuid(healed!.body[0]!.id)).toBe(true);
    // content preserved through the repair.
    expect(healed!.body[0]!.content).toEqual({ segments: [{ text: 'orphaned wrapper' }] });

    // BOTH entries drained — the bad one didn't wedge the good one.
    expect(await db.syncQueue.where('recordId').equals(corruptId).count()).toBe(0);
    expect(await db.syncQueue.where('recordId').equals(validId).count()).toBe(0);
  });

  it('quarantines an unrepairable entry (corrupt note id) while a valid sibling still drains', async () => {
    const { db } = await import('../src/db/schema.js');
    const { getLastSyncError } = await import('../src/lib/syncEngine.js');

    // A non-UUID NOTE id can't be repaired (re-minting it would lose identity) → must quarantine.
    const badNoteId = 'not-a-valid-uuid-at-all';
    const validId = '600d0000-0000-4000-8000-000000000099';
    const bad = makeNote(badNoteId, [], 'unrepairable');
    const valid = makeNote(validId, [{ id: '0000bbbb-0000-4000-8000-000000000003' as BlockId, type: 'paragraph', content: { segments: [{ text: 'ok' }] } }], 'good note');

    await db.notes.bulkPut([bad, valid]);
    await db.syncQueue.bulkAdd([
      { id: crypto.randomUUID(), recordId: badNoteId, payload: bad, baseVersion: 0, createdAt: '2026-06-15T12:00:00.001Z' },
      { id: crypto.randomUUID(), recordId: validId, payload: valid, baseVersion: 0, createdAt: '2026-06-15T12:00:00.002Z' },
    ]);

    const captured: unknown[] = [];
    mockAcceptAll(captured);

    const { syncNow } = await import('../src/lib/syncEngine.js');
    syncNow(NB, '');
    await new Promise((r) => setTimeout(r, 80));

    // ONLY the valid entry was sent — and it is schema-valid.
    expect(captured.length).toBe(1);
    expect((captured[0] as { id: string }).id).toBe(validId);
    expect(SyncPushEntrySchema.safeParse(captured[0]).success).toBe(true);

    // The valid sibling drained; the quarantined entry is isolated (left in the queue), recorded for diag.
    expect(await db.syncQueue.where('recordId').equals(validId).count()).toBe(0);
    expect(await db.syncQueue.where('recordId').equals(badNoteId).count()).toBe(1);
    expect(getLastSyncError()).toContain('quarantined');
  });
});
