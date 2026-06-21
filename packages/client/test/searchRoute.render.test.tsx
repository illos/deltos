/**
 * SearchRoute render tests — closes the UI gate for #20 Search v1.
 *
 * SR-R1  Search input is focused on mount
 * SR-R2  Blank query shows the hint empty-state (no results yet)
 * SR-R3  Query matching current-notebook notes renders them under "In <Notebook>" header
 * SR-R4  Query matching cross-notebook notes renders a collapsed accordion header "Name (N)"
 * SR-R5  Current notebook pointer is NOT changed after search (peek semantics)
 * SR-R6  Accordion header expands to show cross-notebook results on click
 *
 * All tests mount the real SearchRoute component via MemoryRouter so the full
 * rendering path (store hooks → search engine → DOM) is exercised.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { Note, NotebookId } from '@deltos/shared';
import { screen } from './renderHelpers.js';

const NB_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as NotebookId;
const NB_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as NotebookId;
const NOTE_A1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' as Note['id'];
const NOTE_B1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' as Note['id'];

function makeNote(id: string, notebookId: NotebookId, title: string): Note {
  return {
    id: id as Note['id'],
    notebookId,
    title,
    body: [],
    properties: {},
    version: 1,
    createdAt: '2026-06-19T00:00:00.000Z',
    updatedAt: '2026-06-19T00:00:00.000Z',
    syncStatus: 'synced',
  };
}

/** Seed IDB notebooks and notes, set the current notebook to NB_A. */
async function seedStore() {
  const { db } = await import('../src/db/schema.js');
  const { writeCurrentNotebookId } = await import('../src/db/notebookPointer.js');

  await db.notebooks.bulkPut([
    {
      id: NB_A,
      name: 'Notes',
      defaultCollectionView: 'list',
      version: 1,
      createdAt: '2026-06-19T00:00:00.000Z',
      updatedAt: '2026-06-19T00:00:00.000Z',
      deletedAt: null,
      syncSeq: 1,
    },
    {
      id: NB_B,
      name: 'Work',
      defaultCollectionView: 'list',
      version: 1,
      createdAt: '2026-06-19T00:00:00.000Z',
      updatedAt: '2026-06-19T00:00:00.000Z',
      deletedAt: null,
      syncSeq: 2,
    },
  ]);

  await db.notes.bulkPut([
    makeNote(NOTE_A1, NB_A, 'Coffee brewing guide'),
    makeNote(NOTE_B1, NB_B, 'Coffee work meeting'),
  ]);

  await writeCurrentNotebookId(NB_A);
}

async function mountSearch() {
  const { SearchRoute } = await import('../src/routes/SearchRoute.js');
  const { useNotebookStore } = await import('../src/lib/notebookStore.js');
  // Pre-init the notebook store so currentNotebookId is set before render.
  await useNotebookStore.getState().init();

  return render(
    <MemoryRouter initialEntries={['/search']}>
      <Routes>
        <Route path="/search" element={<SearchRoute />} />
        <Route path="/note/:id" element={<div data-testid="note-route" />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(async () => {
  const { db } = await import('../src/db/schema.js');
  await Promise.all(db.tables.map((t) => t.clear()));
  localStorage.clear();
  global.fetch = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })) as typeof fetch;
  await seedStore();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (document.activeElement && document.activeElement !== document.body) {
    (document.activeElement as HTMLElement).blur();
  }
});

// ---------------------------------------------------------------------------
// SR-R1: search input focused on mount
// ---------------------------------------------------------------------------
describe('SR-R1 — search input is focused on mount', () => {
  it('input element is the active element after render', async () => {
    await mountSearch();

    await waitFor(() => {
      const input = document.querySelector('.search__input') as HTMLInputElement | null;
      expect(input).not.toBeNull();
      expect(document.activeElement).toBe(input);
    });
  });
});

// ---------------------------------------------------------------------------
// SR-R2: blank query shows hint
// ---------------------------------------------------------------------------
describe('SR-R2 — blank query shows the hint empty-state', () => {
  it('renders "Start typing" hint before any query is entered', async () => {
    await mountSearch();

    await waitFor(() => {
      expect(screen.queryByText(/start typing/i)).not.toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// SR-R3: current-notebook results rendered under "In <Notebook>" header
// ---------------------------------------------------------------------------
describe('SR-R3 — query matching current-notebook note renders under flat header', () => {
  it('shows "In Notes" header and the matching note', async () => {
    const { container } = await mountSearch();
    const input = container.querySelector('.search__input') as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'coffee' } });

    // Debounce: wait 200ms + React flush
    await waitFor(
      () => {
        expect(screen.queryByText(/in notes/i)).not.toBeNull();
      },
      { timeout: 1000 },
    );

    // Highlight splits title text across <mark> nodes; check via link href.
    expect(container.querySelector(`a[href="/note/${NOTE_A1}"]`)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SR-R4: cross-notebook results in collapsed accordion
// ---------------------------------------------------------------------------
describe('SR-R4 — cross-notebook note shown as collapsed accordion', () => {
  it('renders "Work (1)" collapsed header for the NB_B result', async () => {
    const { container } = await mountSearch();
    const input = container.querySelector('.search__input') as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'coffee' } });

    await waitFor(
      () => {
        // The accordion header button should contain "Work (1)"
        const btn = container.querySelector('.search__nb-header');
        expect(btn).not.toBeNull();
        expect(btn!.textContent).toMatch(/Work\s*\(1\)/);
      },
      { timeout: 1000 },
    );

    // Result from NB_B must NOT be visible (accordion is collapsed)
    expect(screen.queryByText('Coffee work meeting')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SR-R5: current notebook pointer unchanged after search
// ---------------------------------------------------------------------------
describe('SR-R5 — current notebook pointer not changed by search', () => {
  it('currentNotebookId remains NB_A after typing a query', async () => {
    const { container } = await mountSearch();
    const input = container.querySelector('.search__input') as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'coffee' } });

    await waitFor(
      () => { expect(screen.queryByText(/in notes/i)).not.toBeNull(); },
      { timeout: 1000 },
    );

    const { useNotebookStore } = await import('../src/lib/notebookStore.js');
    expect(useNotebookStore.getState().currentNotebookId).toBe(NB_A);
  });
});

// ---------------------------------------------------------------------------
// SR-R6: accordion expands on click
// ---------------------------------------------------------------------------
describe('SR-R6 — accordion header expands to show cross-notebook results', () => {
  it('clicking "Work (1)" reveals the NB_B note', async () => {
    const { container } = await mountSearch();
    const input = container.querySelector('.search__input') as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'coffee' } });

    // Wait for accordion to appear
    await waitFor(
      () => {
        const btn = container.querySelector('.search__nb-header');
        expect(btn).not.toBeNull();
      },
      { timeout: 1000 },
    );

    const accordionBtn = container.querySelector('.search__nb-header') as HTMLButtonElement;
    fireEvent.click(accordionBtn);

    // Highlight splits title text across <mark> nodes; check via link href.
    await waitFor(() => {
      expect(container.querySelector(`a[href="/note/${NOTE_B1}"]`)).not.toBeNull();
    });
  });
});
