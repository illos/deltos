/**
 * Render tests (jsdom) for the editor undo/redo toolbar — task #44 Part A.
 *
 * UB-1  Toolbar renders with Undo + Redo buttons on mount
 * UB-2  Both buttons are disabled initially (empty history)
 * UB-3  Buttons become enabled after a doc-changing transaction
 * UB-4  Undo button disabled again after undo empties the stack
 * UB-5  Buttons reset to disabled when noteId changes (entering a new note)
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { EditorView } from 'prosemirror-view';
import { ProseMirrorEditor } from '../src/editor/ProseMirrorEditor.js';
import { DeckHostProvider } from '../src/components/DeckHost.js';

const emptyBody = [] as const;

// ── Mount helper ──────────────────────────────────────────────────────────────
// Native mode (jsdom touch-first default, custom keyboard off) publishes the editor TOOLBAR to the
// shell-level Deck — so the undo/redo buttons live in the Deck now, not a standalone bottom bar. Mount the
// editor inside the real DeckHostProvider so the toolbar (and its depth-driven Undo/Redo) renders.
function mountEditor(
  noteId: string,
  opts: {
    onViewInit?: (v: EditorView | null) => void;
    onChange?: () => void;
  } = {},
) {
  return render(
    <MemoryRouter>
      <DeckHostProvider enabled>
        <ProseMirrorEditor
          noteId={noteId}
          initialTitle="Test Note"
          initialBody={emptyBody}
          onChange={opts.onChange ?? (() => {})}
          onViewInit={opts.onViewInit}
        />
      </DeckHostProvider>
    </MemoryRouter>,
  );
}

function undoBtn() {
  return document.querySelector('button[aria-label="Undo"]') as HTMLButtonElement | null;
}
function redoBtn() {
  return document.querySelector('button[aria-label="Redo"]') as HTMLButtonElement | null;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ── UB-1: Toolbar structure ───────────────────────────────────────────────────

describe('UB-1 — toolbar renders with Undo + Redo buttons', () => {
  it('both buttons are present in the DOM on mount', async () => {
    mountEditor('note-1');

    await waitFor(() => {
      expect(undoBtn()).not.toBeNull();
      expect(redoBtn()).not.toBeNull();
    });

    // Deploy 3: undo/redo moved into the mobile MobileEditorBar as ICON buttons (aria-label only,
    // no text). The buttons + their depth-driven disabled logic are unchanged.
    expect(undoBtn()!.querySelector('svg')).not.toBeNull();
    expect(redoBtn()!.querySelector('svg')).not.toBeNull();
  });
});

// ── UB-2: Initially disabled ──────────────────────────────────────────────────

describe('UB-2 — buttons are disabled initially', () => {
  it('Undo and Redo are disabled before any edit', async () => {
    mountEditor('note-2');

    await waitFor(() => {
      expect(undoBtn()).not.toBeNull();
    });

    expect(undoBtn()!.disabled).toBe(true);
    expect(redoBtn()!.disabled).toBe(true);
  });
});

// ── UB-3 & UB-4: Enable after change, disable after undo ─────────────────────

describe('UB-3/UB-4 — buttons track undo/redo depth', () => {
  it('Undo enabled after doc change; disabled again after undo exhausts the stack', async () => {
    let capturedView: EditorView | null = null;

    mountEditor('note-3', {
      onViewInit: (v) => { capturedView = v; },
    });

    await waitFor(() => { expect(capturedView).not.toBeNull(); });
    expect(undoBtn()!.disabled).toBe(true); // still empty history

    // Dispatch a text insertion through the PM view.
    await act(async () => {
      const view = capturedView!;
      const pos = view.state.doc.content.size - 1;
      const tr = view.state.tr.insertText('hello', pos);
      view.dispatch(tr);
    });

    // Undo button must be enabled now.
    await waitFor(() => {
      expect(undoBtn()!.disabled).toBe(false);
    });
    // Redo not yet available.
    expect(redoBtn()!.disabled).toBe(true);

    // Undo the change.
    await act(async () => {
      const { undo: pmUndo } = await import('prosemirror-history');
      const view = capturedView!;
      pmUndo(view.state, (tr) => view.dispatch(tr));
    });

    // Undo stack is now empty → Undo disabled; Redo available.
    await waitFor(() => {
      expect(undoBtn()!.disabled).toBe(true);
    });
    expect(redoBtn()!.disabled).toBe(false);
  });
});

// ── UB-5: Reset on noteId change ─────────────────────────────────────────────

describe('UB-5 — buttons reset to disabled on noteId change', () => {
  it('enabled buttons become disabled after switching to a new note', async () => {
    let capturedView: EditorView | null = null;

    const { rerender } = mountEditor('note-a', {
      onViewInit: (v) => { capturedView = v; },
    });

    await waitFor(() => { expect(capturedView).not.toBeNull(); });

    // Make an edit so the Undo button is enabled.
    await act(async () => {
      const view = capturedView!;
      const pos = view.state.doc.content.size - 1;
      view.dispatch(view.state.tr.insertText('x', pos));
    });

    await waitFor(() => { expect(undoBtn()!.disabled).toBe(false); });

    // Switch to a different note.
    await act(async () => {
      rerender(
        <MemoryRouter>
          <DeckHostProvider enabled>
            <ProseMirrorEditor
              noteId="note-b"
              initialTitle="Other Note"
              initialBody={emptyBody}
              onChange={() => {}}
              onViewInit={(v) => { capturedView = v; }}
            />
          </DeckHostProvider>
        </MemoryRouter>,
      );
    });

    // After noteId change the history resets — both buttons disabled.
    await waitFor(() => {
      expect(undoBtn()!.disabled).toBe(true);
    });
    expect(redoBtn()!.disabled).toBe(true);
  });
});
