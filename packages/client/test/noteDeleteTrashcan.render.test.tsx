/**
 * Desktop note-delete trashcan (post-ship, Jim-directed) — the §3 meta-row Trash button.
 *
 * NDT-1  Desktop (≥769px): the Trash button renders in the note-region meta, next to Version history,
 *        and clicking it soft-deletes the note → Trash (recoverable, same path as the mobile SwipeRow)
 *        and returns region 3 to the list (navigates to '/').
 * NDT-2  Mobile (≤768px): the Trash button is ABSENT — mobile keeps swipe-to-delete unchanged.
 *
 * Reuses mutateNotes.softDelete (sys:trashedAt flag), so a deleted note is sticky + recoverable; the
 * test asserts the real db effect (isTrashed) rather than a spy, proving the wired behavior end-to-end.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { Note, NotebookId } from '@deltos/shared';
import { isTrashed } from '@deltos/shared';
import { screen } from './renderHelpers.js';

const NB_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as NotebookId;
const NOTE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' as Note['id'];

function makeNote(): Note {
  return {
    id: NOTE_ID,
    notebookId: NB_A,
    title: 'Trash me',
    properties: {},
    body: [],
    version: 1,
    createdAt: '2026-06-19T00:00:00.000Z',
    updatedAt: '2026-06-19T00:00:00.000Z',
    syncStatus: 'synced',
  };
}

/** Stub matchMedia so useIsDesktop resolves to the requested device class. */
function stubDevice(isDesktop: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: isDesktop,
    media: q,
    addEventListener() {},
    removeEventListener() {},
  }));
}

async function renderNoteRoute() {
  const { db } = await import('../src/db/schema.js');
  await db.notes.put(makeNote() as Parameters<typeof db.notes.put>[0]);
  const { NoteRoute } = await import('../src/routes/NoteRoute.js');
  const view = render(
    <MemoryRouter initialEntries={[`/note/${NOTE_ID}`]}>
      <Routes>
        <Route path="/note/:id" element={<NoteRoute />} />
        <Route path="/" element={<div>LIST VIEW</div>} />
      </Routes>
    </MemoryRouter>,
  );
  // Wait for the note to load (meta row present).
  await waitFor(() => expect(document.querySelector('.editor__edited-line')).not.toBeNull());
  return view;
}

beforeEach(async () => {
  const { db } = await import('../src/db/schema.js');
  await Promise.all(db.tables.map((t) => t.clear()));
  localStorage.clear();
  global.fetch = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })) as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('NDT-1 — desktop note-delete trashcan: renders in §3 meta + deletes to Trash', () => {
  it('shows the Trash button by Version history, soft-deletes on click, and returns to the list', async () => {
    stubDevice(true);
    await renderNoteRoute();

    // Renders next to Version history (both meta-row icon buttons present).
    const trashBtn = screen.getByLabelText('Delete note');
    expect(trashBtn).toBeTruthy();
    expect(screen.getByLabelText('Version history')).toBeTruthy();

    fireEvent.click(trashBtn);

    // Soft-deleted → Trash (recoverable sys:trashedAt flag), via the same path as the mobile swipe.
    const { db } = await import('../src/db/schema.js');
    await waitFor(async () => {
      const stored = await db.notes.get(NOTE_ID);
      expect(stored && isTrashed(stored.properties)).toBe(true);
    });

    // Region 3 returns to the list/empty state (navigates to '/').
    await waitFor(() => expect(screen.queryByText('LIST VIEW')).not.toBeNull());
  });
});

describe('NDT-2 — mobile keeps swipe-to-delete: no trashcan in the meta', () => {
  it('does not render the Delete note button on mobile', async () => {
    stubDevice(false);
    await renderNoteRoute();

    expect(screen.queryByLabelText('Delete note')).toBeNull();
    // #82: mobile has NO editor__meta at all (the global shell bar is the single bar; history lives there,
    // not in NoteRoute). So neither the delete trashcan nor an in-route history button renders here.
    expect(document.querySelector('.editor__meta')).toBeNull();
    expect(screen.queryByLabelText('Version history')).toBeNull();
  });
});
