/**
 * Collection + member mutation unit tests (node env — fake-indexeddb + real timers).
 *
 * COL-1  create: row + queue entry (baseVersion 0)
 * COL-2  rename: updates name + CAS enqueue
 * COL-3  addNotes: deterministic member id, idempotent re-add
 * COL-4  removeNotes: tombstones member
 * COL-5  delete: tombstones collection + cascades local members
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { collectionMemberId } from '@deltos/shared';
import type { NotebookId, NoteId, CollectionId } from '@deltos/shared';

const NB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as NotebookId;
const NOTE_A = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as NoteId;
const NOTE_B = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' as NoteId;

beforeEach(async () => {
  const { db } = await import('../src/db/schema.js');
  await db.collections.clear();
  await db.collectionQueue.clear();
  await db.collectionMembers.clear();
  await db.collectionMemberQueue.clear();
});

describe('COL-1 — create adds collection row + queue entry (baseVersion 0)', () => {
  it('creates a live row and a queue entry with baseVersion 0', async () => {
    const { mutateCollections } = await import('../src/db/mutateCollections.js');
    const { db } = await import('../src/db/schema.js');
    const id = await mutateCollections.create(NB, 'Invoices');
    const row = await db.collections.get(id);
    expect(row?.name).toBe('Invoices');
    expect(row?.notebookId).toBe(NB);
    expect(row?.deletedAt).toBeNull();
    expect(row?.rule).toBeNull();
    const queue = await db.collectionQueue.toArray();
    expect(queue).toHaveLength(1);
    expect(queue[0]?.recordId).toBe(id);
    expect(queue[0]?.payload.baseVersion).toBe(0);
    expect(queue[0]?.payload.draft?.name).toBe('Invoices');
  });
});

describe('COL-2 — rename updates name + queues CAS entry', () => {
  it('updates the local name and queues a rename', async () => {
    const { mutateCollections } = await import('../src/db/mutateCollections.js');
    const { db } = await import('../src/db/schema.js');
    const id = await mutateCollections.create(NB, 'Old');
    await db.collectionQueue.clear();
    await db.collections.where('id').equals(id).modify((c) => {
      c.version = 1;
    });
    await mutateCollections.rename(id, 'New');
    const row = await db.collections.get(id);
    expect(row?.name).toBe('New');
    const queue = await db.collectionQueue.toArray();
    expect(queue).toHaveLength(1);
    expect(queue[0]?.payload.baseVersion).toBe(1);
    expect(queue[0]?.payload.draft?.name).toBe('New');
  });
});

describe('COL-3 — addNotes uses deterministic member id and is idempotent', () => {
  it('mints collectionMemberId and a second add is a no-op', async () => {
    const { mutateCollections } = await import('../src/db/mutateCollections.js');
    const { db } = await import('../src/db/schema.js');
    const collId = await mutateCollections.create(NB, 'Folder');
    await db.collectionQueue.clear();

    await mutateCollections.addNotes(collId, [NOTE_A, NOTE_B]);
    const expectedA = collectionMemberId(collId, NOTE_A);
    const expectedB = collectionMemberId(collId, NOTE_B);
    const members = await db.collectionMembers.toArray();
    expect(members).toHaveLength(2);
    expect(members.map((m) => m.id).sort()).toEqual([expectedA, expectedB].sort());
    expect(members.every((m) => m.deletedAt === null)).toBe(true);

    const queue1 = await db.collectionMemberQueue.toArray();
    expect(queue1).toHaveLength(2);
    expect(queue1.every((e) => e.payload.baseVersion === 0)).toBe(true);

    // Idempotent re-add: same ids, no extra queue noise.
    await mutateCollections.addNotes(collId, [NOTE_A]);
    expect(await db.collectionMembers.count()).toBe(2);
    expect(await db.collectionMemberQueue.count()).toBe(2);
  });
});

describe('COL-4 — removeNotes tombstones the member', () => {
  it('soft-removes membership without deleting the note identity', async () => {
    const { mutateCollections } = await import('../src/db/mutateCollections.js');
    const { db } = await import('../src/db/schema.js');
    const collId = await mutateCollections.create(NB, 'Folder');
    await mutateCollections.addNotes(collId, [NOTE_A]);
    await db.collectionMemberQueue.clear();
    const mid = collectionMemberId(collId, NOTE_A);
    await db.collectionMembers.where('id').equals(mid).modify((m) => {
      m.version = 1;
    });

    await mutateCollections.removeNotes(collId, [NOTE_A]);
    const row = await db.collectionMembers.get(mid);
    expect(row?.deletedAt).not.toBeNull();
    const queue = await db.collectionMemberQueue.toArray();
    expect(queue).toHaveLength(1);
    expect(queue[0]?.payload.delete).toBe(true);
    expect(queue[0]?.payload.baseVersion).toBe(1);
  });
});

describe('COL-5 — delete cascades local member tombstones', () => {
  it('tombstones the collection and its live members', async () => {
    const { mutateCollections } = await import('../src/db/mutateCollections.js');
    const { db } = await import('../src/db/schema.js');
    const collId = (await mutateCollections.create(NB, 'Doomed')) as CollectionId;
    await mutateCollections.addNotes(collId, [NOTE_A, NOTE_B]);
    await db.collectionQueue.clear();
    await db.collectionMemberQueue.clear();
    await db.collections.where('id').equals(collId).modify((c) => {
      c.version = 2;
    });

    await mutateCollections.delete(collId);
    const coll = await db.collections.get(collId);
    expect(coll?.deletedAt).not.toBeNull();
    const members = await db.collectionMembers.toArray();
    expect(members).toHaveLength(2);
    expect(members.every((m) => m.deletedAt !== null)).toBe(true);
    const queue = await db.collectionQueue.toArray();
    expect(queue[0]?.payload.delete).toBe(true);
    expect(queue[0]?.payload.baseVersion).toBe(2);
  });
});
