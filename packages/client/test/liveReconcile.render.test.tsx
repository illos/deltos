/**
 * #90 LIVE note-refresh — ProseMirrorEditor reconciles remote content into a CLEAN open editor (the 2s pull
 * changes initialTitle/initialBody for the same note). Dirty editor (pending save) is never replaced; an
 * echo (same content) is a no-op.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act, waitFor } from '@testing-library/react';
import { TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import type { BlockBody, BlockId } from '@deltos/shared';
import { ProseMirrorEditor } from '../src/editor/ProseMirrorEditor.js';

const PID = '22222222-2222-4222-8222-222222222222' as BlockId;
const body = (text: string): BlockBody => [{ id: PID, type: 'paragraph', content: { segments: [{ text }] } }];

beforeEach(() => {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function el(initialBody: BlockBody, onView: (v: EditorView | null) => void, noteId = 'n1') {
  return (
    <ProseMirrorEditor noteId={noteId} initialTitle="T" initialBody={initialBody} onChange={() => {}} onViewInit={onView} />
  );
}

describe('#90 live reconcile', () => {
  it('CLEAN editor: new initialBody for the same note replaces the doc (live refresh)', async () => {
    let view: EditorView | null = null;
    const onView = (v: EditorView | null) => { if (v) view = v; };
    const { rerender } = render(el(body('hello'), onView));
    await waitFor(() => expect(view).not.toBeNull());
    expect(view!.state.doc.textContent).toContain('hello');

    act(() => { rerender(el(body('world'), onView)); });
    await waitFor(() => expect(view!.state.doc.textContent).toContain('world'));
    expect(view!.state.doc.textContent).not.toContain('hello');
  });

  it('ECHO: re-rendering with the SAME body is a no-op (no replace dispatched)', async () => {
    let view: EditorView | null = null;
    const onView = (v: EditorView | null) => { if (v) view = v; };
    const { rerender } = render(el(body('same'), onView));
    await waitFor(() => expect(view).not.toBeNull());
    const docBefore = view!.state.doc;
    act(() => { rerender(el(body('same'), onView)); });
    expect(view!.state.doc).toBe(docBefore); // identical doc object — incoming.eq(current) → no dispatch
  });

  it('DIRTY editor (pending debounced save) is NOT replaced — conflict engine owns concurrent edits', async () => {
    let view: EditorView | null = null;
    const onView = (v: EditorView | null) => { if (v) view = v; };
    const { rerender } = render(el(body('mine'), onView));
    await waitFor(() => expect(view).not.toBeNull());
    // A local edit → schedules a debounced save (saveTimerRef set = dirty).
    act(() => {
      const tr = view!.state.tr.setSelection(TextSelection.atEnd(view!.state.doc)).insertText('X');
      view!.dispatch(tr);
    });
    act(() => { rerender(el(body('remote'), onView)); });
    // Reconcile skipped while dirty → the local content stays, the remote body is NOT applied.
    expect(view!.state.doc.textContent).not.toContain('remote');
    expect(view!.state.doc.textContent).toContain('mine');
  });
});
