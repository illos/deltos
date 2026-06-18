/**
 * Render tests for glass-test #2 bugs (task #30):
 *
 *   B1-a  NavContent shows a "⋮" affordance on non-default notebooks
 *   B1-b  NavContent shows NO delete affordance on the default notebook
 *   B1-c  Clicking ⋮ → Delete removes the notebook from the list
 *   B2    Selecting a notebook while on /note/:id navigates to the list route
 *   B3-a  Leaving a truly blank note discards it from the store
 *   B3-b  A title-only note (no body) is NOT discarded (first-class ruling)
 *   B3-c  A note with content navigated-to then left WITHOUT typing is NOT discarded
 *
 * All tests mount real React components against a real fake-indexeddb store.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { Note, NotebookId } from '@deltos/shared';
import { screen } from './renderHelpers.js';

// ─── shared fixtures ────────────────────────────────────────────────────────

const NB_DEFAULT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as NotebookId;
const NB_CUSTOM  = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as NotebookId;
const NOTE_ID    = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' as Note['id'];
const NOTE_ID_2  = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' as Note['id'];

function makeNote(id: string, notebookId: NotebookId, title: string, body: Note['body'] = []): Note {
  return {
    id: id as Note['id'],
    notebookId,
    title,
    properties: {},
    body,
    version: 1,
    createdAt: '2026-06-18T00:00:00.000Z',
    updatedAt: '2026-06-18T00:00:00.000Z',
    syncStatus: 'synced',
  };
}

beforeEach(async () => {
  const { db } = await import('../src/db/schema.js');
  await Promise.all(db.tables.map((t) => t.clear()));
  localStorage.clear();
  global.fetch = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })) as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ─── B1: delete notebook affordance ─────────────────────────────────────────

describe('B1 — NavContent delete affordance', () => {
  async function renderNav() {
    const { db } = await import('../src/db/schema.js');
    await db.notebooks.bulkPut([
      { id: NB_DEFAULT, name: 'Notes', isDefault: true,  defaultCollectionView: 'list', version: 1, createdAt: '2026-06-18T00:00:00.000Z', updatedAt: '2026-06-18T00:00:00.000Z', deletedAt: null, syncSeq: 1 },
      { id: NB_CUSTOM,  name: 'Work',  isDefault: false, defaultCollectionView: 'list', version: 1, createdAt: '2026-06-18T00:00:00.000Z', updatedAt: '2026-06-18T00:00:00.000Z', deletedAt: null, syncSeq: 1 },
    ]);
    const { NavContent } = await import('../src/views/NavContent.js');
    render(
      <MemoryRouter>
        <NavContent />
      </MemoryRouter>,
    );
  }

  it('B1-a: non-default notebook has a more-options (⋮) button', async () => {
    await renderNav();
    await waitFor(() => {
      expect(screen.queryByLabelText('More options for Work')).not.toBeNull();
    });
  });

  it('B1-b: default notebook has NO more-options button', async () => {
    await renderNav();
    await waitFor(() => {
      // Wait until both notebooks are rendered
      expect(screen.queryByText('Notes')).not.toBeNull();
    });
    expect(screen.queryByLabelText('More options for Notes')).toBeNull();
  });

  it('B1-c: clicking ⋮ → Delete removes the notebook from the rendered list', async () => {
    await renderNav();
    await waitFor(() => {
      expect(screen.queryByLabelText('More options for Work')).not.toBeNull();
    });

    // Open the menu
    const moreBtn = screen.getByLabelText('More options for Work');
    await act(async () => { moreBtn.click(); });

    // Delete button should appear
    await waitFor(() => {
      expect(screen.queryByRole('menuitem', { name: 'Delete' })).not.toBeNull();
    });

    // Click Delete
    const deleteBtn = screen.getByRole('menuitem', { name: 'Delete' });
    await act(async () => { deleteBtn.click(); });

    // Notebook should disappear from the list
    await waitFor(() => {
      expect(screen.queryByText('Work')).toBeNull();
    });
  });
});

// ─── B2: notebook tap navigates to list ──────────────────────────────────────

describe('B2 — selecting a notebook navigates to the list', () => {
  it('clicking a notebook from /note/:id lands on /', async () => {
    const { db } = await import('../src/db/schema.js');
    await db.notebooks.put({
      id: NB_DEFAULT, name: 'Notes', isDefault: true, defaultCollectionView: 'list',
      version: 1, createdAt: '2026-06-18T00:00:00.000Z', updatedAt: '2026-06-18T00:00:00.000Z', deletedAt: null, syncSeq: 1,
    });
    await db.notes.put(makeNote(NOTE_ID, NB_DEFAULT, 'A note'));

    const { NavContent } = await import('../src/views/NavContent.js');

    // Track navigation via a sentinel route rendered at /
    let landedOnList = false;
    render(
      <MemoryRouter initialEntries={[`/note/${NOTE_ID}`]}>
        <Routes>
          <Route path="/note/:id" element={
            <div>
              <span>note-open</span>
              <NavContent />
            </div>
          } />
          <Route path="/" element={<div>list-view</div>} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.queryByText('note-open')).not.toBeNull();
    });

    // NavContent should show the 'Notes' notebook
    await waitFor(() => {
      expect(screen.queryByText('Notes')).not.toBeNull();
    });

    // Clicking the notebook button must navigate away from the note to the list
    const nbBtn = screen.getByRole('button', { name: /Notes/ });
    await act(async () => { nbBtn.click(); });

    await waitFor(() => {
      landedOnList = screen.queryByText('list-view') !== null;
      expect(landedOnList).toBe(true);
    });
  });
});

// ─── B3: blank note discard ───────────────────────────────────────────────────

describe('B3 — blank note discard on unmount', () => {
  it('B3-a: truly blank note (no title, no body) is deleted from the store on unmount', async () => {
    const { db } = await import('../src/db/schema.js');
    const blankNote = makeNote(NOTE_ID, NB_DEFAULT, '');
    blankNote.syncStatus = 'local-only';
    (blankNote as Note & { version: number }).version = 0;
    await db.notes.put(blankNote);

    const { NoteRoute } = await import('../src/routes/NoteRoute.js');
    const { unmount } = render(
      <MemoryRouter initialEntries={[`/note/${NOTE_ID}`]}>
        <Routes>
          <Route path="/note/:id" element={<NoteRoute />} />
        </Routes>
      </MemoryRouter>,
    );

    // Wait for NoteRoute to fully load — "← Notes" appears only after the note
    // row is fetched from IDB and noteWasInitiallyBlankRef is set in the render body.
    await waitFor(() => {
      expect(screen.queryByText('← Notes')).not.toBeNull();
    });

    // Unmount triggers the blank-note discard
    unmount();

    await waitFor(async () => {
      const row = await db.notes.get(NOTE_ID);
      expect(row).toBeUndefined();
    });
  });

  it('B3-b: title-only note (title set, no body) is NOT discarded on unmount', async () => {
    const { db } = await import('../src/db/schema.js');
    const titleOnlyNote = makeNote(NOTE_ID_2, NB_DEFAULT, 'My title');
    await db.notes.put(titleOnlyNote);

    const { NoteRoute } = await import('../src/routes/NoteRoute.js');
    const { unmount } = render(
      <MemoryRouter initialEntries={[`/note/${NOTE_ID_2}`]}>
        <Routes>
          <Route path="/note/:id" element={<NoteRoute />} />
        </Routes>
      </MemoryRouter>,
    );

    // Wait for NoteRoute to fully load
    await waitFor(() => {
      expect(screen.queryByText('← Notes')).not.toBeNull();
    });

    unmount();

    // Title-only note must still be in the store after unmount
    await waitFor(async () => {
      const row = await db.notes.get(NOTE_ID_2);
      expect(row).toBeDefined();
      expect(row?.title).toBe('My title');
    });
  });

  it('B3-c: note with body content navigated-to (no edit) is NOT discarded on unmount', async () => {
    const { db } = await import('../src/db/schema.js');
    const contentNote = makeNote(NOTE_ID, NB_DEFAULT, 'Title', [{ type: 'paragraph', id: 'b1', content: [{ type: 'text', text: 'body' }] }] as Note['body']);
    await db.notes.put(contentNote);

    const { NoteRoute } = await import('../src/routes/NoteRoute.js');
    const { unmount } = render(
      <MemoryRouter initialEntries={[`/note/${NOTE_ID}`]}>
        <Routes>
          <Route path="/note/:id" element={<NoteRoute />} />
        </Routes>
      </MemoryRouter>,
    );

    // Wait for NoteRoute to fully load
    await waitFor(() => {
      expect(screen.queryByText('← Notes')).not.toBeNull();
    });

    unmount();

    // Content note must still be in the store after unmount
    await waitFor(async () => {
      const row = await db.notes.get(NOTE_ID);
      expect(row).toBeDefined();
    });
  });
});
