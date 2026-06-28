/**
 * createFileNote size-routing (direct-r2-upload.md §6.1, gate DR-3) — the file.size branch in createFileNote.
 *
 * A file at/under DIRECT_R2_THRESHOLD rides the EXISTING buffered `uploadBlob`; a file OVER it rides the NEW
 * direct-to-R2 `uploadBlobDirect`. Below the branch the note minting is identical, so the minted note's shape
 * is the same regardless of which path produced the { hash, size }. The inline attachmentDrop path is a
 * separate module that imports uploadBlob directly and is NOT exercised here (it never routes).
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { isFileNote } from '@deltos/shared';
import { DIRECT_R2_THRESHOLD } from '../plugins/attachment/blobLimits.js';

// Mock BOTH upload paths so no network is touched; distinct hashes prove which path produced the note.
type DirectOpts = { onProgress?: (f: number) => void; signal?: AbortSignal };
const uploadBlob = vi.fn(async (_file: File) => ({ hash: 'a'.repeat(64), size: 11 }));
const uploadBlobDirect = vi.fn(async (_file: File, _opts?: DirectOpts) => ({ hash: 'b'.repeat(64), size: 999_999_999 }));
vi.mock('../plugins/attachment/blobClient.js', () => ({ uploadBlob, uploadBlobDirect }));

/** A File whose reported .size is forced (you can't allocate 26 MB of bytes in a unit test). */
function fileOfSize(name: string, type: string, size: number): File {
  const file = new File(['x'], name, { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

beforeEach(async () => {
  uploadBlob.mockClear();
  uploadBlobDirect.mockClear();
  const { db } = await import('./schema.js');
  await Promise.all(db.tables.map((t) => t.clear()));
});

describe('createFileNote routes by file.size', () => {
  it('a file AT the threshold takes the buffered uploadBlob (boundary is inclusive of buffered)', async () => {
    const { mutateNotes } = await import('./mutate.js');
    const note = await mutateNotes.createFileNote(fileOfSize('exact.bin', 'application/octet-stream', DIRECT_R2_THRESHOLD));

    expect(uploadBlob).toHaveBeenCalledTimes(1);
    expect(uploadBlobDirect).not.toHaveBeenCalled();
    expect(note.body[0]!.content).toMatchObject({ hash: 'a'.repeat(64), size: 11 });
  });

  it('a small file (< threshold) takes the buffered uploadBlob', async () => {
    const { mutateNotes } = await import('./mutate.js');
    await mutateNotes.createFileNote(fileOfSize('small.pdf', 'application/pdf', 1024));

    expect(uploadBlob).toHaveBeenCalledTimes(1);
    expect(uploadBlobDirect).not.toHaveBeenCalled();
  });

  it('a large file (> threshold) takes the direct-to-R2 uploadBlobDirect and mints from its { hash, size }', async () => {
    const { mutateNotes } = await import('./mutate.js');
    const big = fileOfSize('huge.pdf', 'application/pdf', DIRECT_R2_THRESHOLD + 1);
    const note = await mutateNotes.createFileNote(big);

    expect(uploadBlobDirect).toHaveBeenCalledTimes(1);
    expect(uploadBlob).not.toHaveBeenCalled();
    // uploadBlobDirect is passed the file + an options object carrying onProgress + an AbortSignal.
    const [passedFile, opts] = uploadBlobDirect.mock.calls[0]!;
    expect(passedFile).toBe(big);
    expect(typeof opts?.onProgress).toBe('function');
    expect(opts?.signal).toBeInstanceOf(AbortSignal);

    // Note minted from the DIRECT path's { hash, size } — identical minting below the branch.
    expect(isFileNote(note)).toBe(true);
    expect(note.title).toBe('huge.pdf');
    expect(note.body[0]!.content).toMatchObject({ hash: 'b'.repeat(64), size: 999_999_999 });
  });

  it('a cancelled/failed direct upload mints NO note and leaves no queued sync entry', async () => {
    const { mutateNotes } = await import('./mutate.js');
    const { db } = await import('./schema.js');
    uploadBlobDirect.mockRejectedValueOnce(new DOMException('upload aborted', 'AbortError'));

    await expect(mutateNotes.createFileNote(fileOfSize('huge.pdf', 'application/pdf', DIRECT_R2_THRESHOLD + 1)))
      .rejects.toThrow();

    // Upload-first: nothing was minted, nothing queued (no orphan note).
    const notes = await db.notes.toArray();
    const queued = await db.syncQueue.toArray();
    expect(notes).toHaveLength(0);
    expect(queued).toHaveLength(0);
  });

  it('registers + clears the upload-tracking entry for the direct path (transient indicator)', async () => {
    const { mutateNotes } = await import('./mutate.js');
    const { useUploadStore } = await import('../lib/uploadStore.js');
    // Capture in-flight count by snapshotting inside the mocked upload.
    let inFlightDuringUpload = -1;
    uploadBlobDirect.mockImplementationOnce(async () => {
      inFlightDuringUpload = useUploadStore.getState().uploads.length;
      return { hash: 'b'.repeat(64), size: 5 };
    });

    await mutateNotes.createFileNote(fileOfSize('huge.pdf', 'application/pdf', DIRECT_R2_THRESHOLD + 1));

    expect(inFlightDuringUpload).toBe(1); // registered while uploading
    expect(useUploadStore.getState().uploads).toHaveLength(0); // cleared on settle
  });
});
