import { collectionMemberId } from '@deltos/shared';
import type { CollectionId, NoteId, NotebookId } from '@deltos/shared';
import { getStore } from './store.js';
import { newCollectionId } from '../lib/ids.js';
import type { CollectionMemberRow, CollectionRow } from './schema.js';

/**
 * Collection + member mutations — the ONLY writer for collection/collectionMember rows + queues.
 * Every operation is atomic: the row and the queue entry land in one transaction (mirrors
 * mutateNotebooks). Member ids are ALWAYS {@link collectionMemberId} — never crypto.randomUUID.
 *
 * Guards:
 *   - create: new collection under a home notebook (version 0 → server INSERT)
 *   - rename/setIcon/setColor/reorder: CAS on version; no-op on missing/deleted
 *   - delete: tombstone collection + local cascade tombstone of live members
 *   - addNotes: idempotent upsert (deterministic member id); baseVersion 0 on the wire
 *   - removeNotes: member tombstone with current version as CAS base
 */
export const mutateCollections = {
  async create(
    notebookId: NotebookId,
    name: string,
    opts?: { icon?: string; color?: string; ord?: number },
  ): Promise<CollectionId> {
    const id = newCollectionId();
    const now = new Date().toISOString();
    const ord = opts?.ord ?? 0;
    const row: CollectionRow = {
      id,
      notebookId,
      name,
      ...(opts?.icon !== undefined ? { icon: opts.icon } : {}),
      ...(opts?.color !== undefined ? { color: opts.color } : {}),
      ord,
      rule: null,
      version: 0,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      syncSeq: 0,
    };
    await getStore().putCollectionAndEnqueue(row, {
      id: crypto.randomUUID(),
      recordId: id,
      payload: {
        id,
        baseVersion: 0,
        draft: {
          notebookId,
          name,
          ...(opts?.icon !== undefined ? { icon: opts.icon } : {}),
          ...(opts?.color !== undefined ? { color: opts.color } : {}),
          ord,
          rule: null,
        },
      },
      createdAt: now,
    });
    return id;
  },

  async rename(id: CollectionId, name: string): Promise<void> {
    const c = await getStore().getCollection(id);
    if (!c || c.deletedAt !== null) return;
    await enqueueCollectionUpdate({ ...c, name, updatedAt: new Date().toISOString() });
  },

  async setIcon(id: CollectionId, icon: string | undefined): Promise<void> {
    const c = await getStore().getCollection(id);
    if (!c || c.deletedAt !== null) return;
    const { icon: _drop, ...rest } = c;
    const next: CollectionRow = icon !== undefined
      ? { ...rest, icon, updatedAt: new Date().toISOString() }
      : { ...rest, updatedAt: new Date().toISOString() };
    await enqueueCollectionUpdate(next);
  },

  async setColor(id: CollectionId, color: string | undefined): Promise<void> {
    const c = await getStore().getCollection(id);
    if (!c || c.deletedAt !== null) return;
    const { color: _drop, ...rest } = c;
    const next: CollectionRow = color !== undefined
      ? { ...rest, color, updatedAt: new Date().toISOString() }
      : { ...rest, updatedAt: new Date().toISOString() };
    await enqueueCollectionUpdate(next);
  },

  async reorder(id: CollectionId, ord: number): Promise<void> {
    const c = await getStore().getCollection(id);
    if (!c || c.deletedAt !== null) return;
    await enqueueCollectionUpdate({ ...c, ord, updatedAt: new Date().toISOString() });
  },

  async delete(id: CollectionId): Promise<void> {
    const c = await getStore().getCollection(id);
    if (!c || c.deletedAt !== null) return;
    const now = new Date().toISOString();
    // Local cascade: hide members immediately (server also cascades on delete).
    await getStore().tombstoneMembersForCollection(id, now);
    await getStore().putCollectionAndEnqueue(
      { ...c, deletedAt: now, updatedAt: now },
      {
        id: crypto.randomUUID(),
        recordId: id,
        payload: { id, baseVersion: c.version, delete: true },
        createdAt: now,
      },
    );
  },

  /**
   * Add notes to a collection. Member id = `collectionMemberId(collectionId, noteId)` — deterministic
   * and idempotent. Already-live members are no-ops; tombstoned members are revived (baseVersion 0).
   */
  async addNotes(collectionId: CollectionId, noteIds: NoteId[]): Promise<void> {
    const collection = await getStore().getCollection(collectionId);
    if (!collection || collection.deletedAt !== null) return;
    const now = new Date().toISOString();
    for (const noteId of noteIds) {
      const memberId = collectionMemberId(collectionId, noteId);
      const existing = await getStore().getCollectionMember(memberId);
      if (existing && existing.deletedAt === null) continue; // already live — idempotent no-op
      const row: CollectionMemberRow = {
        id: memberId,
        collectionId,
        noteId,
        ord: existing?.ord ?? 0,
        version: 0,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        deletedAt: null,
        syncSeq: existing?.syncSeq ?? 0,
      };
      await getStore().putCollectionMemberAndEnqueue(row, {
        id: crypto.randomUUID(),
        recordId: memberId,
        payload: {
          id: memberId,
          baseVersion: 0,
          draft: { collectionId, noteId, ord: row.ord },
        },
        createdAt: now,
      });
    }
  },

  /**
   * Soft-remove notes from a collection (member tombstone). Notes themselves are untouched.
   */
  async removeNotes(collectionId: CollectionId, noteIds: NoteId[]): Promise<void> {
    const now = new Date().toISOString();
    for (const noteId of noteIds) {
      const memberId = collectionMemberId(collectionId, noteId);
      const existing = await getStore().getCollectionMember(memberId);
      if (!existing || existing.deletedAt !== null) continue;
      await getStore().putCollectionMemberAndEnqueue(
        { ...existing, deletedAt: now, updatedAt: now },
        {
          id: crypto.randomUUID(),
          recordId: memberId,
          payload: { id: memberId, baseVersion: existing.version, delete: true },
          createdAt: now,
        },
      );
    }
  },
};

async function enqueueCollectionUpdate(row: CollectionRow): Promise<void> {
  const now = row.updatedAt;
  await getStore().putCollectionAndEnqueue(row, {
    id: crypto.randomUUID(),
    recordId: row.id,
    payload: {
      id: row.id,
      baseVersion: row.version,
      draft: {
        notebookId: row.notebookId,
        name: row.name,
        ...(row.icon !== undefined ? { icon: row.icon } : {}),
        ...(row.color !== undefined ? { color: row.color } : {}),
        ord: row.ord,
        rule: row.rule,
      },
    },
    createdAt: now,
  });
}
