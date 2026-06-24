/**
 * #76/#77/#82 V1-polish note chrome. The move UI is gone (no move-picker / "More options"). The edited-time
 * is a faint NON-EDITABLE line above the title (both devices, #77). Per the #82 correction, editor__meta is
 * DESKTOP-ONLY (history + delete there); on MOBILE there's NO editor__meta — the global shell__bar (rendered
 * in AuthedShell, not here) is the single bar and carries history. NoteRoute mounts standalone here.
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
  await waitFor(() => expect(document.querySelector('.editor__edited-line')).not.toBeNull());
}

beforeEach(async () => {
  const { db } = await import('../src/db/schema.js');
  await Promise.all(db.tables.map((t) => t.clear()));
  localStorage.clear();
  global.fetch = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })) as typeof fetch;
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('#76/#82 — move UI removed; editor__meta desktop-only', () => {
  it('mobile: NO editor__meta at all (history moved to the shell bar, #82); no move UI', async () => {
    stubDevice(false);
    await renderNoteRoute();
    expect(document.querySelector('.editor__meta')).toBeNull(); // editor__meta is desktop-only now
    expect(screen.queryByLabelText('Version history')).toBeNull(); // history lives in the global shell bar
    expect(screen.queryByLabelText('More options')).toBeNull();
    expect(document.querySelector('.editor__move-picker')).toBeNull();
  });

  it('desktop: editor__meta has history + delete, still NO move-picker / "More options"', async () => {
    stubDevice(true);
    await renderNoteRoute();
    expect(document.querySelector('.editor__meta')).not.toBeNull();
    expect(screen.getByLabelText('Version history')).toBeTruthy();
    expect(screen.getByLabelText('Delete note')).toBeTruthy(); // desktop delete unchanged
    expect(screen.queryByLabelText('More options')).toBeNull();
    expect(document.querySelector('.editor__move-picker')).toBeNull();
  });
});

describe('#82 — ?history opens the version panel (the shell-bar History seam)', () => {
  it('NoteRoute at /note/:id?history shows the HistoryPanel instead of the note', async () => {
    stubDevice(false);
    const { db } = await import('../src/db/schema.js');
    await db.notes.put(makeNote() as Parameters<typeof db.notes.put>[0]);
    const { NoteRoute } = await import('../src/routes/NoteRoute.js');
    render(
      <MemoryRouter initialEntries={[`/note/${NOTE_ID}?history`]}>
        <Routes><Route path="/note/:id" element={<NoteRoute />} /></Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText('Version History')).toBeTruthy();
  });

  it('without ?history the note renders (no version panel)', async () => {
    stubDevice(false);
    await renderNoteRoute();
    expect(screen.queryByText('Version History')).toBeNull();
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
