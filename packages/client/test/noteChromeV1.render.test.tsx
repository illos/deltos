/**
 * #76/#77 V1-polish note chrome. NoteRoute renders the single meta bar (history; desktop also delete) with
 * the move UI REMOVED (no move-picker, no "More options"/ellipsis), and the edited-time relocated to a
 * faint NON-EDITABLE line ABOVE the title (outside the contenteditable) on both desktop + mobile.
 * (The mobile global shell__bar suppression is a one-line `!useMatch('/note/:id')` guard in AuthedShell —
 * not rendered here, where NoteRoute mounts standalone — verified on-device at the deploy gate.)
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { Note, NotebookId } from '@deltos/shared';
import { screen } from './renderHelpers.js';

const NB_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as NotebookId;
const NOTE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' as Note['id'];

function makeNote(): Note {
  return {
    id: NOTE_ID, notebookId: NB_A, title: 'Chrome note', properties: {}, body: [],
    version: 1, createdAt: '2026-06-19T00:00:00.000Z', updatedAt: '2026-06-19T00:00:00.000Z', syncStatus: 'synced',
  };
}
function stubDevice(isDesktop: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: isDesktop, media: q, addEventListener() {}, removeEventListener() {} }));
}
async function renderNoteRoute() {
  const { db } = await import('../src/db/schema.js');
  await db.notes.put(makeNote() as Parameters<typeof db.notes.put>[0]);
  const { NoteRoute } = await import('../src/routes/NoteRoute.js');
  render(
    <MemoryRouter initialEntries={[`/note/${NOTE_ID}`]}>
      <Routes>
        <Route path="/note/:id" element={<NoteRoute />} />
        <Route path="/" element={<div>LIST VIEW</div>} />
      </Routes>
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.queryByLabelText('Back to list')).not.toBeNull());
}

beforeEach(async () => {
  const { db } = await import('../src/db/schema.js');
  await Promise.all(db.tables.map((t) => t.clear()));
  localStorage.clear();
  global.fetch = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })) as typeof fetch;
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('#76 — move UI removed; history stays', () => {
  it('mobile: history present, NO move-picker / "More options"', async () => {
    stubDevice(false);
    await renderNoteRoute();
    expect(screen.getByLabelText('Version history')).toBeTruthy();
    expect(screen.queryByLabelText('More options')).toBeNull(); // the ellipsis (only opened the move picker)
    expect(document.querySelector('.editor__move-picker')).toBeNull();
    expect(screen.queryByLabelText('Delete note')).toBeNull(); // mobile keeps swipe-delete, no meta trashcan
  });

  it('desktop: history + delete present, still NO move-picker / "More options"', async () => {
    stubDevice(true);
    await renderNoteRoute();
    expect(screen.getByLabelText('Version history')).toBeTruthy();
    expect(screen.getByLabelText('Delete note')).toBeTruthy(); // desktop delete unchanged
    expect(screen.queryByLabelText('More options')).toBeNull();
    expect(document.querySelector('.editor__move-picker')).toBeNull();
  });
});

describe('#77 — edited-time is a non-editable line above the title', () => {
  for (const isDesktop of [false, true]) {
    it(`${isDesktop ? 'desktop' : 'mobile'}: "Edited …" renders above the title, outside the contenteditable`, async () => {
      stubDevice(isDesktop);
      await renderNoteRoute();
      const edited = await waitFor(() => {
        const el = document.querySelector('.editor__edited-line');
        expect(el).not.toBeNull();
        return el!;
      });
      expect(edited.textContent).toMatch(/^Edited /);
      // NOT inside the PM editable surface → can't capture caret/selection.
      expect(edited.closest('.editor__pm')).toBeNull();
      // Sits BEFORE the editor surface in the DOM (above the title).
      const pm = document.querySelector('.editor__pm')!;
      expect(edited.compareDocumentPosition(pm) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      // It is NOT the meta-row edited span anymore (that span was removed from .editor__meta).
      expect(document.querySelector('.editor__meta .editor__edited')).toBeNull();
    });
  }
});
