/**
 * createFileNotesFromPicker (mobile file-picker → file-note, file-notes.md §5.1) — the touch sibling of
 * the desktop dropFilesOnList. Proves the per-file semantics: one createFileNote per selected file, a
 * single sync notify with the resulting notebookId, per-file failure isolation (one bad file never sinks
 * the rest, no orphan), and a silent AbortError (deliberate Cancel).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { createFileNote, notifyQueueWrite, showToast } = vi.hoisted(() => ({
  createFileNote: vi.fn(),
  notifyQueueWrite: vi.fn(),
  showToast: vi.fn(),
}));
vi.mock('../../db/mutate.js', () => ({ mutateNotes: { createFileNote } }));
vi.mock('../syncEngine.js', () => ({ notifyQueueWrite }));
vi.mock('../toastEvents.js', () => ({ showToast }));

import { createFileNotesFromPicker } from './filePickerUpload.js';

const file = (name: string) => new File(['x'], name, { type: 'application/octet-stream' });

beforeEach(() => {
  createFileNote.mockReset();
  notifyQueueWrite.mockClear();
  showToast.mockClear();
});

describe('createFileNotesFromPicker', () => {
  it('is a no-op on an empty selection (no mint, no sync)', async () => {
    await createFileNotesFromPicker([]);
    expect(createFileNote).not.toHaveBeenCalled();
    expect(notifyQueueWrite).not.toHaveBeenCalled();
  });

  it('mints one file note per file and notifies sync once with the notebookId', async () => {
    createFileNote.mockResolvedValue({ id: 'n1', notebookId: 'nb_x' });
    await createFileNotesFromPicker([file('a.pdf'), file('b.png')]);
    expect(createFileNote).toHaveBeenCalledTimes(2);
    expect(notifyQueueWrite).toHaveBeenCalledTimes(1);
    expect(notifyQueueWrite).toHaveBeenCalledWith('nb_x');
    expect(showToast).toHaveBeenCalledWith('2 files added');
  });

  it('isolates a per-file failure (toast for the bad one, others still mint + sync)', async () => {
    createFileNote
      .mockResolvedValueOnce({ id: 'ok', notebookId: null })
      .mockRejectedValueOnce(new Error('R2 reject'));
    await createFileNotesFromPicker([file('good.pdf'), file('bad.pdf')]);
    expect(createFileNote).toHaveBeenCalledTimes(2);
    expect(showToast).toHaveBeenCalledWith('Couldn\'t add "bad.pdf"');
    expect(notifyQueueWrite).toHaveBeenCalledTimes(1); // the good one still pushes
    expect(showToast).toHaveBeenCalledWith('File added');
  });

  it('stays silent on a deliberate Cancel (AbortError → no error toast)', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    createFileNote.mockRejectedValue(abort);
    await createFileNotesFromPicker([file('cancelled.bin')]);
    expect(showToast).not.toHaveBeenCalled();
    expect(notifyQueueWrite).not.toHaveBeenCalled();
  });
});
