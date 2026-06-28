/**
 * createFileNote (file-notes.md §5.1, gate FN-2) — the desktop list-drop creation path.
 *
 * Asserts the minted note has the §2 file-note shape: title = filename, properties carry the
 * `fileType:'file'` marker (isFileNote → true), body is the SINGLE attachment block with the exact
 * { hash, name, mime, size } payload the editor insert path produces, and it is persisted atomically.
 * Also locks FN-1's duplication clause at the client mutator: duplicating a file note keeps it a file note.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { isFileNote } from '@deltos/shared';

// createFileNote dynamic-imports the blob client; mock it so no network is touched. The mocked uploadBlob
// returns the server-computed hash + size (size deliberately != the File's byte length, to prove the note
// carries the SERVER size, not File.size).
vi.mock('../plugins/attachment/blobClient.js', () => ({
  uploadBlob: vi.fn(async () => ({ hash: 'abc123hash', size: 4242 })),
}));

beforeEach(async () => {
  const { db } = await import('./schema.js');
  await Promise.all(db.tables.map((t) => t.clear()));
});

describe('mutateNotes.createFileNote', () => {
  it('mints a file note with the §2 shape (title=filename, fileType marker, single attachment block)', async () => {
    const { mutateNotes } = await import('./mutate.js');
    const file = new File(['the bytes'], 'Q3-report.pdf', { type: 'application/pdf' });

    const note = await mutateNotes.createFileNote(file);

    expect(isFileNote(note)).toBe(true);
    expect(note.title).toBe('Q3-report.pdf');
    expect(note.properties['fileType']).toEqual({ type: 'text', value: 'file' });
    expect(note.syncStatus).toBe('local-only');

    // body is exactly ONE attachment block carrying the canonical { hash, name, mime, size } payload.
    expect(note.body).toHaveLength(1);
    const block = note.body[0]!;
    expect(block.type).toBe('attachment');
    expect(block.content).toEqual({
      hash: 'abc123hash',
      name: 'Q3-report.pdf',
      mime: 'application/pdf',
      size: 4242, // the server size from uploadBlob, NOT File.size
    });
  });

  it('persists the note atomically (note row + a queued sync entry land together)', async () => {
    const { mutateNotes } = await import('./mutate.js');
    const { getStore } = await import('./store.js');
    const { db } = await import('./schema.js');
    const file = new File(['x'], 'photo.png', { type: 'image/png' });

    const note = await mutateNotes.createFileNote(file);

    const stored = await getStore().getNote(note.id);
    expect(stored).toBeDefined();
    expect(isFileNote(stored!)).toBe(true);
    // the matching sync-queue entry exists (atomic enqueue).
    const queued = await db.syncQueue.where('recordId').equals(note.id).toArray();
    expect(queued).toHaveLength(1);
  });

  it('duplicating a file note keeps it a file note (fileType is user-namespace, survives userProperties)', async () => {
    const { mutateNotes } = await import('./mutate.js');
    const file = new File(['x'], 'clip.mov', { type: 'video/quicktime' });

    const original = await mutateNotes.createFileNote(file);
    const copy = await mutateNotes.duplicate(original);

    expect(copy.id).not.toBe(original.id);
    expect(isFileNote(copy)).toBe(true);
    expect(copy.body[0]!.type).toBe('attachment');
  });
});
