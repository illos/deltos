/**
 * #59 All Notes synthetic-default gate render tests.
 *
 * AN-1  All Notes appears in the switcher as the first entry (undeletable — no more-options button)
 * AN-2  HomeView with notebookId=null shows ALL notes regardless of their notebookId
 * AN-3  Uncategorized note (notebookId=null) is visible in All Notes and hidden in a specific notebook
 * AN-4  Move-note picker includes "All Notes" as a target (uncategorize)
 * AN-5  No-duplicate-default: no code path yields more than one live default notebook row in IDB
 * AN-6  All Notes is the device-default: fresh init() → currentNotebookId is null (no stored pointer)
 *
 * [[ui-features-need-rendered-ui-gate]]: routed-tree render tests + no-duplicate-default assertion
 * + green + prod typecheck.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { Note, NotebookId } from '@deltos/shared';
import { screen } from './renderHelpers.js';

// ── fixtures ─────────────────────────────────────────────────────────────────

const NB_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as NotebookId;
const NB_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as NotebookId;
const NOTE_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' as Note['id'];
const NOTE_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' as Note['id'];
const NOTE_UNCAT = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' as Note['id'];

function makeNote(id: string, notebookId: NotebookId | null, title: string): Note {
  return {
    id: id as Note['id'],
    notebookId,
    title,
    properties: {},
    body: [],
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
  const { useNotebookStore } = await import('../src/lib/notebookStore.js');
  useNotebookStore.setState({ _ready: true, currentNotebookId: null });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ── AN-1: All Notes in switcher, undeletable ──────────────────────────────────

describe('AN-1 — All Notes appears in switcher as undeletable first entry', () => {
  it('renders All Notes button and has no more-options button for it', async () => {
    const { db } = await import('../src/db/schema.js');
    await db.notebooks.put({
      id: NB_A, name: 'Work', defaultCollectionView: 'list',
      version: 1, createdAt: '2026-06-18T00:00:00.000Z', updatedAt: '2026-06-18T00:00:00.000Z',
      deletedAt: null, syncSeq: 1,
    });

    const { NavContent } = await import('../src/views/NavContent.js');
    render(
      <MemoryRouter>
        <NavContent />
      </MemoryRouter>,
    );

    // All Notes must appear as a nav entry
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /^All Notes/ })).not.toBeNull();
    });

    // All Notes is undeletable. Pass C (UI refresh) removed the per-row ⋮ kebab entirely (packet §1),
    // so there's no "more options" anywhere — All Notes is undeletable by construction either way.
    expect(screen.queryByLabelText('More options for All Notes')).toBeNull();
    expect(screen.queryByLabelText('More options for Work')).toBeNull();
  });
});

// ── AN-2: All Notes shows all notes ──────────────────────────────────────────

describe('AN-2 — HomeView with notebookId=null shows every note', () => {
  it('null notebookId is unfiltered — shows notes from any notebook', async () => {
    const { db } = await import('../src/db/schema.js');
    await db.notes.bulkPut([
      makeNote(NOTE_A, NB_A, 'Work note'),
      makeNote(NOTE_B, NB_B, 'Personal note'),
    ]);

    const { HomeView } = await import('../src/App.js');
    render(
      <MemoryRouter>
        <HomeView notebookId={null} />
      </MemoryRouter>,
    );

    // Both notes from different notebooks are visible in All Notes
    await waitFor(() => {
      expect(screen.queryByText('Work note')).not.toBeNull();
    });
    expect(screen.queryByText('Personal note')).not.toBeNull();
  });
});

// ── AN-3: Uncategorized note appears in All Notes, hidden in notebook filter ─

describe('AN-3 — uncategorized note (notebookId=null) visibility', () => {
  it('appears in All Notes (notebookId=null) but is hidden when filtering by a real notebook', async () => {
    const { db } = await import('../src/db/schema.js');
    await db.notes.bulkPut([
      makeNote(NOTE_UNCAT, null, 'Uncategorized note'),
      makeNote(NOTE_A,    NB_A, 'NB_A note'),
    ]);

    const { HomeView } = await import('../src/App.js');

    // All Notes view — uncategorized note is visible
    const { unmount } = render(
      <MemoryRouter>
        <HomeView notebookId={null} />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.queryByText('Uncategorized note')).not.toBeNull();
    });
    unmount();

    // NB_A filter — uncategorized note is hidden
    cleanup();
    render(
      <MemoryRouter>
        <HomeView notebookId={NB_A} />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.queryByText('NB_A note')).not.toBeNull();
    });
    expect(screen.queryByText('Uncategorized note')).toBeNull();
  });
});

// ── AN-4: Move picker includes All Notes ────────────────────────────────────

describe('AN-4 — move-note picker includes All Notes as an uncategorize target', () => {
  it('All Notes button appears in the move picker when the picker is open', async () => {
    const { db } = await import('../src/db/schema.js');
    const note = makeNote(NOTE_A, NB_A, 'A note to move');
    await db.notes.put(note);
    await db.notebooks.put({
      id: NB_A, name: 'Work', defaultCollectionView: 'list',
      version: 1, createdAt: '2026-06-18T00:00:00.000Z', updatedAt: '2026-06-18T00:00:00.000Z',
      deletedAt: null, syncSeq: 1,
    });

    const { NoteRoute } = await import('../src/routes/NoteRoute.js');
    render(
      <MemoryRouter initialEntries={[`/note/${NOTE_A}`]}>
        <Routes>
          <Route path="/note/:id" element={<NoteRoute />} />
        </Routes>
      </MemoryRouter>,
    );

    // Wait for NoteRoute to load
    await waitFor(() => {
      expect(screen.queryByLabelText('More options')).not.toBeNull();
    });

    // Open the move picker
    const moveBtn = screen.getByLabelText('More options');
    await act(async () => { moveBtn.click(); });

    // All Notes must appear as a target in the picker
    await waitFor(() => {
      const dialog = document.querySelector('[aria-label="Move note to notebook"]');
      expect(dialog).not.toBeNull();
      expect(dialog!.textContent).toContain('All Notes');
    });
  });
});

// ── AN-5: No duplicate default ───────────────────────────────────────────────

describe('AN-5 — no-duplicate-default: merge never duplicates notebooks', () => {
  it('after merging 2 server notebooks, IDB contains exactly those 2 (no duplication, no fabrication)', async () => {
    const { db } = await import('../src/db/schema.js');
    const { mergeNotebooks } = await import('../src/lib/syncEngine.js');
    const NOW = '2026-06-20T12:00:00.000Z';

    // isDefault is gone (#61) — the no-duplicate invariant is now structural (no column to duplicate).
    // This test asserts the client stores exactly what the server sends, no more.
    await mergeNotebooks([
      {
        id: NB_A as NotebookId,
        accountId: 'acct-1',
        name: 'Notes',
        defaultCollectionView: 'list',
        version: 1,
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
        syncSeq: 1,
      },
      {
        id: NB_B as NotebookId,
        accountId: 'acct-1',
        name: 'Work',
        defaultCollectionView: 'list',
        version: 1,
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
        syncSeq: 2,
      },
    ] as Parameters<typeof mergeNotebooks>[0]);

    const allNotebooks = await db.notebooks.toArray();
    expect(allNotebooks).toHaveLength(2);
    const ids = allNotebooks.map((nb) => nb.id).sort();
    expect(ids).toEqual([NB_A, NB_B].sort());
  });
});

// ── AN-6: All Notes is the device default ────────────────────────────────────

describe('AN-6 — All Notes is the device-local default (null after fresh init)', () => {
  it('init() with no stored pointer → currentNotebookId is null (All Notes)', async () => {
    const { db } = await import('../src/db/schema.js');
    // Confirm deviceState is clear (no stored pointer)
    const stored = await db.deviceState.get('current-notebook');
    expect(stored).toBeUndefined();

    const { useNotebookStore } = await import('../src/lib/notebookStore.js');
    // Reset to pre-init state and re-init
    useNotebookStore.setState({ _ready: false, currentNotebookId: null });
    await useNotebookStore.getState().init();

    expect(useNotebookStore.getState().currentNotebookId).toBeNull();
  });

  it('setCurrentNotebook(null) clears the IDB pointer; re-init yields null again', async () => {
    const { useNotebookStore } = await import('../src/lib/notebookStore.js');
    // First set a real notebook
    await useNotebookStore.getState().setCurrentNotebook(NB_A);
    expect(useNotebookStore.getState().currentNotebookId).toBe(NB_A);

    // Select All Notes
    await useNotebookStore.getState().setCurrentNotebook(null);
    expect(useNotebookStore.getState().currentNotebookId).toBeNull();

    // Re-init: should still be null (IDB key was deleted, not set to null)
    useNotebookStore.setState({ _ready: false, currentNotebookId: null });
    await useNotebookStore.getState().init();
    expect(useNotebookStore.getState().currentNotebookId).toBeNull();
  });
});
