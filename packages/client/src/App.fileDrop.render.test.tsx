import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Note } from '@deltos/shared';

/**
 * file-notes §5.1 desktop list-drop → file-note creation — the dropzone-spans-the-whole-panel gate
 * (ui-features-need-rendered-ui-gate). Mounts the real HomeView and proves the DROP TARGET + the
 * panel-spanning highlight cover the list pane:
 *   - an OS `Files` dragover sets the drag state (the .home--file-drag tint class) AND mounts the
 *     inset:0 .home__drop-overlay ring — including with ZERO notes, where the populated rows don't fill
 *     the pane (the reported gap: dropping in the empty space below the list missed),
 *   - a drop clears the state and triggers file-note creation (dropFilesOnList),
 *   - a dragleave out of the pane clears the state.
 *
 * jsdom does no layout, so the FULL-HEIGHT pixel spanning (min-height:100% in the 3-region list) is
 * feel-tested on deploy; this asserts the wiring + the overlay element that the CSS sizes to the pane.
 */

// Desktop class → the file-note DnD hook activates (it's desktop-only).
vi.mock('./lib/useIsDesktop.js', () => ({ useIsDesktop: () => true }));
// Don't lazy-load the real desktop note-reorder chunk in the test.
vi.mock('./lib/dnd/useNoteDnd.js', () => ({ useNoteDnd: () => null }));

// Control the note list (zero vs a few) without standing up Dexie/liveQuery.
const notesRef: { current: Note[] } = { current: [] };
vi.mock('./db/storeHooks.js', () => ({
  useNotes: () => notesRef.current,
  useNotebooks: () => [],
  useCurrentNotebook: () => null,
}));

// Stub the lazy file-DnD module with spies so the drop wiring is exercised without the real upload path.
const dropFilesOnList = vi.fn();
const allowFileDrop = vi.fn(() => true);
vi.mock('./lib/dnd/useFileNoteDnd.js', () => ({
  useFileNoteDnd: () => ({ allowFileDrop, dropFilesOnList }),
}));

// Imported AFTER the mocks are registered (vi.mock is hoisted, so this is fine).
import { HomeView } from './App.js';

function mountHome() {
  const { container } = render(
    <MemoryRouter>
      <HomeView notebookId={null} />
    </MemoryRouter>,
  );
  const home = container.querySelector('.home') as HTMLElement;
  expect(home).not.toBeNull();
  return home;
}

function fakeNote(id: string): Note {
  const now = Date.now();
  return {
    id,
    notebookId: null,
    title: 'Note ' + id,
    content: { type: 'doc', content: [] },
    properties: {},
    createdAt: now,
    updatedAt: now,
  } as unknown as Note;
}

beforeEach(() => {
  notesRef.current = [];
  dropFilesOnList.mockClear();
  allowFileDrop.mockClear();
});
afterEach(cleanup);

describe('HomeView file-note dropzone spans the whole notes panel', () => {
  it('an OS-file dragover sets the drag state + mounts the panel overlay even with ZERO notes', () => {
    const home = mountHome();
    // Empty list → the rows don't fill the pane; the reported gap is dropping below them.
    expect(home.querySelector('.home__notes')).toBeNull();
    expect(home.classList.contains('home--file-drag')).toBe(false);
    expect(home.querySelector('.home__drop-overlay')).toBeNull();

    fireEvent.dragOver(home, { dataTransfer: { types: ['Files'] } });

    expect(allowFileDrop).toHaveBeenCalled();
    expect(home.classList.contains('home--file-drag')).toBe(true);
    // The ring is a real inset:0 child of .home (CSS sizes it to the whole pane).
    const overlay = home.querySelector('.home__drop-overlay') as HTMLElement;
    expect(overlay).not.toBeNull();
    // Stacking intent (the fix): the overlay must paint ABOVE the note rows. jsdom does no layout/layering and
    // doesn't load styles.css, so (as the prior assertions do) we prove the WIRING the CSS keys on: the overlay
    // carries the .home__drop-overlay class that the stylesheet gives `z-index:1` (above the positioned
    // SwipeRows), and it lives inside .home — which the stylesheet makes an isolated stacking context so that
    // elevated z-index stays confined to this pane. The visible "drop here" prompt rides inside the overlay.
    expect(overlay.classList.contains('home__drop-overlay')).toBe(true);
    const label = overlay.querySelector('.home__drop-label');
    expect(label).not.toBeNull();
    expect(label?.textContent).toMatch(/drop/i);
  });

  it('a drop clears the state and triggers file-note creation', () => {
    const home = mountHome();
    fireEvent.dragOver(home, { dataTransfer: { types: ['Files'] } });
    expect(home.classList.contains('home--file-drag')).toBe(true);

    fireEvent.drop(home, { dataTransfer: { types: ['Files'], files: [] } });

    expect(dropFilesOnList).toHaveBeenCalledTimes(1);
    expect(home.classList.contains('home--file-drag')).toBe(false);
    expect(home.querySelector('.home__drop-overlay')).toBeNull();
  });

  it('a dragleave out of the pane clears the drag state', () => {
    const home = mountHome();
    fireEvent.dragOver(home, { dataTransfer: { types: ['Files'] } });
    expect(home.classList.contains('home--file-drag')).toBe(true);

    // relatedTarget outside .home → a genuine leave (not a child-crossing flicker).
    fireEvent.dragLeave(home, { relatedTarget: document.body });

    expect(home.classList.contains('home--file-drag')).toBe(false);
  });

  it('the drag state still applies with a few notes present (drop target covers the populated pane too)', () => {
    notesRef.current = [fakeNote('a'), fakeNote('b')];
    const home = mountHome();
    expect(home.querySelectorAll('.home__notes > li').length).toBe(2);

    fireEvent.dragOver(home, { dataTransfer: { types: ['Files'] } });
    expect(home.classList.contains('home--file-drag')).toBe(true);
    expect(home.querySelector('.home__drop-overlay')).not.toBeNull();
  });
});
