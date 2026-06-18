/**
 * Notebook CRUD unit tests (node env — fake-indexeddb + real timers).
 *
 * NB-1  create: adds a row to db.notebooks + a queue entry
 * NB-2  create: queue entry has baseVersion 0 (INSERT)
 * NB-3  rename: updates the name locally + queues a RENAME entry
 * NB-4  delete: marks deletedAt + queues a delete:true entry; default notebook is protected
 * NB-5  delete default: no-op (isDefault guard)
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import type { NotebookId } from '@deltos/shared';

const DEFAULT_NB_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff' as NotebookId;

beforeEach(async () => {
  const { db } = await import('../src/db/schema.js');
  await db.notebooks.clear();
  await db.notebookQueue.clear();
  // Seed a default notebook (undeletable)
  await db.notebooks.put({
    id: DEFAULT_NB_ID,
    name: 'Notes',
    defaultCollectionView: 'list',
    isDefault: true,
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    syncSeq: 1,
  });
});

describe('NB-1 — create adds notebook row + queue entry', () => {
  it('creates a live row and a queue entry', async () => {
    const { mutateNotebooks } = await import('../src/db/mutateNotebooks.js');
    const { db } = await import('../src/db/schema.js');
    const id = await mutateNotebooks.create('Work');
    const row = await db.notebooks.get(id);
    expect(row?.name).toBe('Work');
    expect(row?.deletedAt).toBeNull();
    expect(row?.isDefault).toBe(false);
    const queue = await db.notebookQueue.toArray();
    expect(queue).toHaveLength(1);
    expect(queue[0]?.recordId).toBe(id);
  });
});

describe('NB-2 — create queue entry has baseVersion 0', () => {
  it('queue entry baseVersion is 0 (INSERT)', async () => {
    const { mutateNotebooks } = await import('../src/db/mutateNotebooks.js');
    const { db } = await import('../src/db/schema.js');
    await mutateNotebooks.create('Personal');
    const queue = await db.notebookQueue.toArray();
    expect(queue[0]?.payload.baseVersion).toBe(0);
  });
});

describe('NB-3 — rename updates name + queues rename entry', () => {
  it('updates the local name and queues a rename', async () => {
    const { mutateNotebooks } = await import('../src/db/mutateNotebooks.js');
    const { db } = await import('../src/db/schema.js');
    const id = await mutateNotebooks.create('Old Name');
    await db.notebookQueue.clear(); // clear create queue
    // Simulate server acceptance: bump version so rename has correct CAS base
    await db.notebooks.where('id').equals(id).modify((nb) => { nb.version = 1; });
    await mutateNotebooks.rename(id, 'New Name');
    const row = await db.notebooks.get(id);
    expect(row?.name).toBe('New Name');
    const queue = await db.notebookQueue.toArray();
    expect(queue).toHaveLength(1);
    expect(queue[0]?.payload.draft?.name).toBe('New Name');
  });
});

describe('NB-4 — delete marks deletedAt + queues delete entry', () => {
  it('tombstones the notebook and queues delete:true', async () => {
    const { mutateNotebooks } = await import('../src/db/mutateNotebooks.js');
    const { db } = await import('../src/db/schema.js');
    const id = await mutateNotebooks.create('To Delete');
    await db.notebookQueue.clear();
    await db.notebooks.where('id').equals(id).modify((nb) => { nb.version = 1; });
    await mutateNotebooks.delete(id);
    const row = await db.notebooks.get(id);
    expect(row?.deletedAt).not.toBeNull();
    const queue = await db.notebookQueue.toArray();
    expect(queue[0]?.payload.delete).toBe(true);
  });
});

describe('NB-5 — delete default is a no-op', () => {
  it('does not tombstone the default notebook', async () => {
    const { mutateNotebooks } = await import('../src/db/mutateNotebooks.js');
    const { db } = await import('../src/db/schema.js');
    await mutateNotebooks.delete(DEFAULT_NB_ID);
    const row = await db.notebooks.get(DEFAULT_NB_ID);
    expect(row?.deletedAt).toBeNull();
    const queue = await db.notebookQueue.toArray();
    expect(queue).toHaveLength(0);
  });
});
