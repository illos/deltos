/**
 * Notebook-filter render tests — closes the gaps that let P0-1 and P0-2 reach prod.
 *
 * NF-1  Real HomeView mounts with notebookId prop and filters the rendered list
 *         (guards P0-1: HomeView discarding the prop → all notes visible)
 * NF-2  NoteRoute mounts the routed tree and renders note content — not blank
 *         (guards P0-2: rules-of-hooks crash → empty DOM)
 * NF-3  Collection-view seam: resolveCollectionView(NB_A, HomeView) resolves to HomeView
 *         and the rendered output filters to the active notebook
 *         (guards the #17 seam: resolver hands off to the right component)
 * NF-4  P0 #52 regression gate: note server-re-stamped to canonical notebookId stays visible
 *         after the notebook pointer reconciles to canonical (post-fix state visible; stale
 *         state hides — documents WHY reconcile is needed)
 *
 * All tests mount real React components against a real fake-indexeddb store.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { Note, NotebookId } from '@deltos/shared';
import { screen } from './renderHelpers.js';

const NB_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as NotebookId;
const NB_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as NotebookId;
const NOTE_ID_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' as Note['id'];
const NOTE_ID_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' as Note['id'];

// NF-4 fixtures: the server's canonical default vs a legacy per-device stale ID
const CANONICAL_NB_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' as NotebookId;
const STALE_NB_ID     = 'ffffffff-ffff-4fff-8fff-ffffffffffff' as NotebookId;
const NOTE_ID_C       = '11111111-1111-4111-8111-111111111111' as Note['id'];

function makeNote(id: string, notebookId: NotebookId, title: string): Note {
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
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// NF-1: Real HomeView filters by notebookId
// ---------------------------------------------------------------------------
describe('NF-1 — real HomeView renders only the active notebook\'s notes', () => {
  it('HomeView with notebookId=NB_A shows NB_A note and hides NB_B note', async () => {
    const { db } = await import('../src/db/schema.js');
    await db.notes.bulkPut([
      makeNote(NOTE_ID_A, NB_A, 'Note in NB_A'),
      makeNote(NOTE_ID_B, NB_B, 'Note in NB_B'),
    ]);

    // Import the real exported HomeView — tests the ACTUAL component, not a replica.
    // If HomeView ever ignores the prop again, this test goes red.
    const { HomeView } = await import('../src/App.js');

    render(
      <MemoryRouter>
        <HomeView notebookId={NB_A} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.queryByText('Note in NB_A')).not.toBeNull();
    });
    // NB_B note must be absent — catches P0-1 regression
    expect(screen.queryByText('Note in NB_B')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// NF-2: NoteRoute renders note content (rules-of-hooks fix)
// ---------------------------------------------------------------------------
describe('NF-2 — NoteRoute renders note content (not blank)', () => {
  it('mounts /note/:id routed tree and asserts the back link and move button render', async () => {
    const { db } = await import('../src/db/schema.js');
    const note = makeNote(NOTE_ID_A, NB_A, 'Test note title');
    await db.notes.put(note);

    const { NoteRoute } = await import('../src/routes/NoteRoute.js');

    render(
      <MemoryRouter initialEntries={[`/note/${NOTE_ID_A}`]}>
        <Routes>
          <Route path="/note/:id" element={<NoteRoute />} />
        </Routes>
      </MemoryRouter>,
    );

    // "← Notes" and "Move to notebook…" are outside the editor chrome — if the component
    // crashes (P0-2 blank screen), neither renders. Their presence proves the hook fix holds.
    await waitFor(() => {
      expect(screen.queryByText('← Notes')).not.toBeNull();
    });
    expect(screen.queryByText('Move to notebook…')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// NF-3: Collection-view seam (resolveCollectionView → HomeView renders filtered)
// ---------------------------------------------------------------------------
describe('NF-3 — collection-view seam: resolver hands off to HomeView and it filters', () => {
  it('resolveCollectionView(NB_A, HomeView) returns HomeView; rendered output shows only NB_A notes', async () => {
    const { db } = await import('../src/db/schema.js');
    await db.notes.bulkPut([
      makeNote(NOTE_ID_A, NB_A, 'Seam note NB_A'),
      makeNote(NOTE_ID_B, NB_B, 'Seam note NB_B'),
    ]);

    const { resolveCollectionView, _clearRegistryForTest } = await import('../src/lib/collectionViews.js');
    const { HomeView } = await import('../src/App.js');

    // No other views registered in v1 — resolver must fall back to HomeView.
    _clearRegistryForTest();
    const ResolvedView = resolveCollectionView(NB_A, HomeView);

    // The seam hands off to the real HomeView — assert it filters correctly.
    render(
      <MemoryRouter>
        <ResolvedView notebookId={NB_A} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.queryByText('Seam note NB_A')).not.toBeNull();
    });
    // Cross-notebook note must not leak through the seam
    expect(screen.queryByText('Seam note NB_B')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// NF-4: P0 #52 regression gate — server-re-stamped note visibility
//
// Scenario: device had a legacy random notebookId (STALE_NB_ID) from the
// localStorage migration. Notes created there carry that ID. On first edit+sync,
// the server reassigns the note to the account's canonical default (CANONICAL_NB_ID).
// After the reconcile fix, currentNotebookId becomes CANONICAL_NB_ID and the note
// stays visible. Without reconcile (pre-fix), the pointer is still STALE_NB_ID and
// the note vanishes from the list.
// ---------------------------------------------------------------------------
describe('NF-4 — P0 #52 regression gate: server-re-stamped note visibility', () => {
  async function seedCanonicalState() {
    const { db } = await import('../src/db/schema.js');
    await db.notebooks.put({
      id: CANONICAL_NB_ID, name: 'Notes', defaultCollectionView: 'list',
      version: 1, createdAt: '2026-06-18T00:00:00.000Z', updatedAt: '2026-06-18T00:00:00.000Z',
      deletedAt: null, syncSeq: 1,
    });
    // Note after server re-stamp: its notebookId = canonical (not the stale device ID)
    await db.notes.put(makeNote(NOTE_ID_C, CANONICAL_NB_ID, 'Re-stamped note'));
  }

  it('NF-4a (post-reconcile): note with canonical notebookId is visible when pointer = canonical', async () => {
    await seedCanonicalState();
    const { HomeView } = await import('../src/App.js');

    render(
      <MemoryRouter>
        <HomeView notebookId={CANONICAL_NB_ID} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.queryByText('Re-stamped note')).not.toBeNull();
    });
  });

  it('NF-4b (pre-reconcile regression doc): same note is HIDDEN when pointer is still stale', async () => {
    await seedCanonicalState();
    const { HomeView } = await import('../src/App.js');

    // Pointer points to the old stale ID — no notebook with that ID exists
    render(
      <MemoryRouter>
        <HomeView notebookId={STALE_NB_ID} />
      </MemoryRouter>,
    );

    // Note filtered out — this is the bug state that the reconcile fix eliminates
    await waitFor(() => {
      expect(screen.queryByText('No notes yet.')).not.toBeNull();
    });
    expect(screen.queryByText('Re-stamped note')).toBeNull();
  });
});
