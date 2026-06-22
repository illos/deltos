/**
 * Auto-focus tests for #37 — focus title on NEW note only.
 *
 * AF-1  NoteEditor with autoFocus=true → PM editor receives focus on mount
 * AF-2  NoteEditor with autoFocus=false → PM editor is NOT focused
 * AF-3  NoteRoute with router state { isNew: true } → editor auto-focuses (new note)
 * AF-4  NoteRoute with no router state → editor does NOT auto-focus (existing note)
 *
 * AF-3 + AF-4 exercise the full wiring: router state → NoteRoute → NoteEditor → PM.
 * They guard the regression where blank existing notes would have been incorrectly focused
 * by the prior content-derived autoFocus condition.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { Note, NotebookId } from '@deltos/shared';
import { screen } from './renderHelpers.js';

const NB_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as NotebookId;
const NOTE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' as Note['id'];

function makeNote(version: number, title: string): Note {
  return {
    id: NOTE_ID,
    notebookId: NB_A,
    title,
    properties: {},
    body: [],
    version,
    createdAt: '2026-06-19T00:00:00.000Z',
    updatedAt: '2026-06-19T00:00:00.000Z',
    syncStatus: version === 0 ? 'local-only' : 'synced',
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
  // Reset focus to body so tests don't bleed into each other.
  if (document.activeElement && document.activeElement !== document.body) {
    (document.activeElement as HTMLElement).blur();
  }
});

// ---------------------------------------------------------------------------
// AF-1: NoteEditor with autoFocus=true → PM editor focused
// ---------------------------------------------------------------------------
describe('AF-1 — NoteEditor autoFocus=true focuses the PM editor on mount', () => {
  it('PM editor container has active focus when autoFocus=true', async () => {
    const { NoteEditor } = await import('../src/editor/NoteEditor.js');
    const note = makeNote(0, '');

    const { container } = render(
      <MemoryRouter>
        <NoteEditor note={note} onSave={async () => { /* no-op */ }} autoFocus={true} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      const pmEl = container.querySelector('.editor__pm');
      expect(pmEl).not.toBeNull();
      // The PM editor or one of its children should be the active element.
      expect(pmEl?.contains(document.activeElement) || document.activeElement === pmEl).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// AF-2: NoteEditor with autoFocus=false → PM editor NOT focused
// ---------------------------------------------------------------------------
describe('AF-2 — NoteEditor autoFocus=false does not steal focus', () => {
  it('document.activeElement remains body when autoFocus=false', async () => {
    const { NoteEditor } = await import('../src/editor/NoteEditor.js');
    const note = makeNote(1, '');  // existing blank note — must NOT steal focus

    const { container } = render(
      <MemoryRouter>
        <NoteEditor note={note} onSave={async () => { /* no-op */ }} autoFocus={false} />
      </MemoryRouter>,
    );

    // Wait for PM to initialise fully before checking.
    await waitFor(() => {
      expect(container.querySelector('.editor__pm')).not.toBeNull();
    });

    const pmEl = container.querySelector('.editor__pm');
    expect(pmEl?.contains(document.activeElement)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AF-3: NoteRoute with { isNew: true } router state → editor auto-focuses
// ---------------------------------------------------------------------------
describe('AF-3 — NoteRoute with isNew router state passes autoFocus=true to editor', () => {
  it('editor is focused when opening a new note via { isNew: true } state', async () => {
    const { db } = await import('../src/db/schema.js');
    await db.notes.put(makeNote(0, '') as Parameters<typeof db.notes.put>[0]);

    const { NoteRoute } = await import('../src/routes/NoteRoute.js');

    const { container } = render(
      <MemoryRouter
        initialEntries={[{ pathname: `/note/${NOTE_ID}`, state: { isNew: true } }]}
      >
        <Routes>
          <Route path="/note/:id" element={<NoteRoute />} />
        </Routes>
      </MemoryRouter>,
    );

    // Wait for note to load and PM to mount.
    await waitFor(() => {
      expect(screen.queryByLabelText('Back to list')).not.toBeNull();
    });

    await waitFor(() => {
      const pmEl = container.querySelector('.editor__pm');
      expect(pmEl?.contains(document.activeElement) || document.activeElement === pmEl).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// AF-4: NoteRoute without isNew state → editor does NOT auto-focus
// ---------------------------------------------------------------------------
describe('AF-4 — NoteRoute without isNew state does not steal focus (existing note)', () => {
  it('editor is NOT focused when opening an existing note (even if blank)', async () => {
    const { db } = await import('../src/db/schema.js');
    // version=1, blank body: this is the exact scenario the old content-derived condition
    // would have focused incorrectly. The new state-driven approach must NOT focus here.
    await db.notes.put(makeNote(1, '') as Parameters<typeof db.notes.put>[0]);

    const { NoteRoute } = await import('../src/routes/NoteRoute.js');

    const { container } = render(
      <MemoryRouter initialEntries={[`/note/${NOTE_ID}`]}>
        <Routes>
          <Route path="/note/:id" element={<NoteRoute />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.queryByLabelText('Back to list')).not.toBeNull();
    });

    // Wait for PM to init fully before asserting absence of focus.
    await waitFor(() => {
      expect(container.querySelector('.editor__pm')).not.toBeNull();
    });

    const pmEl = container.querySelector('.editor__pm');
    expect(pmEl?.contains(document.activeElement)).toBe(false);
  });
});
