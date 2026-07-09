import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Note, NotebookId } from '@deltos/shared';

/**
 * ROAD-0019 library-based custom-order reorder — rendered-tree + PERF-GATE test.
 *
 * Proves the two contract halves that jsdom CAN check (real drag feel = on-device):
 *  1. CUSTOM sort: after the lazy dnd-kit module resolves, HomeView mounts the reorder provider and rows
 *     render inside the reorderable list. The provider is fed the sorted notes.
 *  2. NON-CUSTOM sort: the reorder module is NEVER loaded — the perf gate in test form. We spy on the module's
 *     members and assert they are never invoked, and the plain (non-reorderable) list renders.
 *
 * The lazy chunk is mocked (so we don't stand up real @dnd-kit in jsdom) with spy members; the useCustomReorder
 * loader still only dynamic-imports it when enabled=true, so a never-invoked provider proves the gate.
 */

const desktop = vi.hoisted(() => ({ value: false }));
vi.mock('./lib/useIsDesktop.js', () => ({ useIsDesktop: () => desktop.value }));
vi.mock('./lib/useKeypadMode.js', () => ({ useKeypadMode: () => false }));
vi.mock('./lib/dnd/useNoteDnd.js', () => ({ useNoteDnd: () => null }));
vi.mock('./lib/dnd/useFileNoteDnd.js', () => ({ useFileNoteDnd: () => null }));
vi.mock('./lib/upload/useFilePickerUpload.js', () => ({ useFilePickerUpload: () => null }));
vi.mock('./components/NavSheet.js', () => ({ useNavSheetArm: () => ({}) }));
vi.mock('./db/mutate.js', () => ({ mutateNotes: {} }));
vi.mock('./lib/syncEngine.js', () => ({ notifyQueueWrite: vi.fn() }));
vi.mock('./lib/toastEvents.js', () => ({ showToast: vi.fn(), showActionToast: vi.fn() }));

// The lazy dnd-kit impl — mocked with SPYABLE members so we can prove it's exercised ONLY in custom sort.
// CustomReorderProvider renders a marker + its children; useSortableRow returns a no-op ref (jsdom = no drag).
const provider = vi.hoisted(() => vi.fn());
const sortableRow = vi.hoisted(() => vi.fn());
vi.mock('./lib/dnd/customReorderImpl.js', () => ({
  CustomReorderProvider: (props: { notes: Note[]; children: React.ReactNode }) => {
    provider(props);
    return <div data-testid="reorder-provider" data-count={props.notes.length}>{props.children}</div>;
  },
  useSortableRow: (input: unknown) => {
    sortableRow(input);
    return { ref: () => {}, isDragging: false };
  },
}));

// activeSort is derived from the current notebook's noteSort — control it per test.
const noteSort = vi.hoisted(() => ({ value: null as string | null }));
const notesRef: { current: Note[] } = { current: [] };
vi.mock('./db/storeHooks.js', () => ({
  useNotes: () => notesRef.current,
  useNotebooks: () => [],
  useCurrentNotebook: () => ({ id: 'nb-1', name: 'Nb', noteSort: noteSort.value }),
}));
vi.mock('./lib/notebookStore.js', () => ({
  useNotebookStore: (sel: (s: unknown) => unknown) => sel({ currentNotebookId: 'nb-1' }),
}));

import { HomeView } from './App.js';
import { DeckHostProvider } from './components/DeckHost.js';

function fakeNote(id: string, order: number): Note {
  const now = Date.now();
  return {
    id,
    notebookId: 'nb-1',
    title: 'Note ' + id,
    content: { type: 'doc', content: [] },
    properties: { 'sys:notebookOrder': { type: 'number', value: order } },
    createdAt: now,
    updatedAt: now,
  } as unknown as Note;
}

function mount(nbId: NotebookId | null) {
  return render(
    <MemoryRouter>
      <DeckHostProvider enabled>
        <HomeView notebookId={nbId} />
      </DeckHostProvider>
    </MemoryRouter>,
  ).container;
}

beforeEach(() => {
  desktop.value = false;
  noteSort.value = null;
  notesRef.current = [fakeNote('a', 0), fakeNote('b', 10), fakeNote('c', 20)];
  provider.mockClear();
  sortableRow.mockClear();
});
afterEach(() => cleanup());

describe('HomeView custom-order reorder — lazy wiring', () => {
  it('CUSTOM sort: loads the dnd module, mounts the reorder provider, and renders sortable rows', async () => {
    noteSort.value = 'custom';
    const c = mount('nb-1' as NotebookId);

    // The lazy loader resolves a frame later → the provider mounts around the reorderable list.
    await waitFor(() => expect(c.querySelector('[data-testid="reorder-provider"]')).not.toBeNull());
    expect(c.querySelector('.home__notes--reorderable')).not.toBeNull();
    // Provider fed the sorted notes; one useSortableRow call per row.
    expect(provider).toHaveBeenCalled();
    expect(c.querySelector('[data-testid="reorder-provider"]')?.getAttribute('data-count')).toBe('3');
    expect(sortableRow).toHaveBeenCalledTimes(3);
    // Rows still render (the note Links are present inside the provider).
    expect(c.querySelectorAll('.home__note-link').length).toBe(3);
  });

  it('NON-CUSTOM sort: never loads the dnd module (perf gate) and renders a plain list', async () => {
    noteSort.value = 'updated'; // any non-custom mode
    const c = mount('nb-1' as NotebookId);

    // Give the (would-be) lazy loader ample time — it must NEVER fire in non-custom sort.
    await new Promise((r) => setTimeout(r, 50));

    expect(c.querySelector('[data-testid="reorder-provider"]')).toBeNull();
    expect(c.querySelector('.home__notes--reorderable')).toBeNull();
    expect(c.querySelector('.home__notes')).not.toBeNull(); // plain list
    expect(provider).not.toHaveBeenCalled();
    expect(sortableRow).not.toHaveBeenCalled();
    expect(c.querySelectorAll('.home__note-link').length).toBe(3);
  });
});
