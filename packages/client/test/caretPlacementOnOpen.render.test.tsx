/**
 * Caret placement on open (Jim 2026-06-27).
 *   - An EMPTY note (the new-note flow) keeps PM's default caret at the START of the title, so you can type
 *     the title immediately.
 *   - A note that ALREADY HAS CONTENT opens with the caret at the END of the doc, so the first keystroke
 *     (incl. via the Deck, which dispatches at the current selection) continues the note instead of
 *     prepending to the title.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { Selection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { ProseMirrorEditor } from '../src/editor/ProseMirrorEditor.js';

const emptyBody = [] as const;

function mountEditor(title: string, onViewInit: (v: EditorView | null) => void) {
  return render(
    <ProseMirrorEditor
      noteId="note-1"
      initialTitle={title}
      initialBody={emptyBody}
      onChange={() => {}}
      onViewInit={onViewInit}
    />,
  );
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('caret placement on open', () => {
  it('a note WITH content opens with the caret at the END of the doc (not the title start)', async () => {
    let view: EditorView | null = null;
    mountEditor('Existing note', (v) => { if (v) view = v; });
    await waitFor(() => expect(view).not.toBeNull());
    const v = view as unknown as EditorView;
    const end = Selection.atEnd(v.state.doc).from;
    expect(v.state.selection.from).toBe(end);   // caret at the end
    expect(v.state.selection.from).toBeGreaterThan(Selection.atStart(v.state.doc).from); // ...and NOT at title start
  });

  it('an EMPTY note opens with the caret at the START of the title (new-note behavior, unchanged)', async () => {
    let view: EditorView | null = null;
    mountEditor('', (v) => { if (v) view = v; });
    await waitFor(() => expect(view).not.toBeNull());
    const v = view as unknown as EditorView;
    expect(v.state.selection.from).toBe(Selection.atStart(v.state.doc).from); // default = title start
  });

  it('clicking the EMPTY body area (the wrapper itself) focuses the editor with the caret at the END', async () => {
    let view: EditorView | null = null;
    const { container } = mountEditor('A note', (v) => { if (v) view = v; });
    await waitFor(() => expect(view).not.toBeNull());
    const v = view as unknown as EditorView;
    // Put the caret at the START so we can prove the empty-area click moves it to the END.
    v.dispatch(v.state.tr.setSelection(Selection.atStart(v.state.doc)));
    expect(v.state.selection.from).toBe(Selection.atStart(v.state.doc).from);
    // A click whose target is the .editor__pm wrapper itself = the blank area below the text.
    const pm = container.querySelector('.editor__pm') as HTMLElement;
    fireEvent.click(pm);
    expect(v.state.selection.from).toBe(Selection.atEnd(v.state.doc).from);
  });
});
