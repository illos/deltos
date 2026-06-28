import { describe, it, expect, vi } from 'vitest';
import type { DragEvent } from 'react';
import { isFileDrag, allowFileDrop } from './fileNoteDnd.js';

/**
 * The OS-file-drag detection guard (file-notes.md §5.1) — the seam that keeps the list-drop = file-note
 * path from firing on an INTERNAL note→notebook reorder drag. An external OS file drag advertises the
 * `Files` type on the dataTransfer; a deltos note drag carries the deltos-note MIME instead, so only the
 * former is accepted. Pure (no db/jsdom) — locks the don't-regress contract from the dropzone work.
 */
function fakeDragEvent(types: string[]): {
  ev: DragEvent;
  preventDefault: ReturnType<typeof vi.fn>;
  dataTransfer: { types: string[]; dropEffect: string };
} {
  const preventDefault = vi.fn();
  const dataTransfer = { types, dropEffect: 'none' };
  const ev = { preventDefault, dataTransfer } as unknown as DragEvent;
  return { ev, preventDefault, dataTransfer };
}

describe('fileNoteDnd OS-file-drag guard', () => {
  it('isFileDrag is true ONLY when the drag advertises the OS `Files` type', () => {
    expect(isFileDrag(fakeDragEvent(['Files']).ev)).toBe(true);
    expect(isFileDrag(fakeDragEvent(['Files', 'text/plain']).ev)).toBe(true);
    // internal note→notebook reorder drag → carries the deltos MIME, NOT Files → not a file drop
    expect(isFileDrag(fakeDragEvent(['application/x-deltos-note']).ev)).toBe(false);
    expect(isFileDrag(fakeDragEvent([]).ev)).toBe(false);
  });

  it('allowFileDrop accepts (copy effect + preventDefault) a file drag and rejects a non-file drag', () => {
    const file = fakeDragEvent(['Files']);
    expect(allowFileDrop(file.ev)).toBe(true);
    expect(file.preventDefault).toHaveBeenCalledTimes(1);
    expect(file.dataTransfer.dropEffect).toBe('copy');

    const note = fakeDragEvent(['application/x-deltos-note']);
    expect(allowFileDrop(note.ev)).toBe(false);
    expect(note.preventDefault).not.toHaveBeenCalled(); // must not swallow an internal-reorder drag
    expect(note.dataTransfer.dropEffect).toBe('none');
  });
});
