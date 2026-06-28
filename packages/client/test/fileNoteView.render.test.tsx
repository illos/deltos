/**
 * FileNoteView (file-notes.md §3.2, gates FN-6/FN-7) — the OPEN surface for a file note, mounted through the
 * REAL routed tree (NoteRoute → resolveNoteView). Standing UI gate: mount the routed tree and assert real
 * DOM, not just unit predicates.
 *
 * FNV-1  An IMAGE file note opens in FileNoteView (NOT the PM editor); the inline preview <img> points at the
 *        mocked `…/:hash/view` derivative URL.
 * FNV-2  A PDF file note opens the in-app PDF reader (pdf-reader.md Slice 1), NOT the old "no preview" icon and
 *        NOT an <img>. (Deep reader behavior is covered in pdfReader.render.test.tsx; pdf.js is mocked here.)
 * FNV-3  A NORMAL note still resolves to the PM block editor — no regression.
 * FNV-4  Delete soft-deletes the note (sys:trashedAt, the real db effect) and returns to the list.
 * FNV-5  Rename edits the note title (persisted via the real onSave → mutateNotes.put).
 * FNV-6  When the view fetch REJECTS, the preview falls back to the format icon (no broken <img>).
 *
 * The registration is imported as a side-effect so resolveNoteView knows the file descriptor (App.tsx does
 * this at app init; the test mounts NoteRoute directly, so it imports it here). The blob client is mocked so
 * no network is touched.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { Note, NotebookId } from '@deltos/shared';
import { isTrashed, setFileType } from '@deltos/shared';
import { screen } from './renderHelpers.js';

const NB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as NotebookId;
const IMG_ID = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1' as Note['id'];
const PDF_ID = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2' as Note['id'];
const TXT_ID = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3' as Note['id'];

const VIEW_URL = 'blob:mock-view-url';

// Mock the blob client: loadViewUrl resolves to a fixed object URL (the mocked `…/:hash/view` derivative),
// downloadBlob is a no-op spy. Per-test we can override loadViewUrl to reject (FNV-6).
const loadViewUrl = vi.fn(async () => VIEW_URL);
const downloadBlob = vi.fn(async () => {});
const loadBlobBytes = vi.fn(async () => new ArrayBuffer(8));
vi.mock('../src/plugins/attachment/blobClient.js', () => ({
  loadViewUrl,
  downloadBlob,
  loadBlobBytes,
  // loadThumbUrl is referenced by the list pill; harmless to provide.
  loadThumbUrl: vi.fn(async () => VIEW_URL),
}));

// Mock the pdf.js engine seam so a pdf note's reader mounts without a real PDF engine / Worker (PDF-UI gate).
vi.mock('../src/views/pdf/pdfEngine.js', () => ({
  openPdf: vi.fn(async () => ({
    numPages: 1,
    getPageDims: vi.fn(async () => ({ width: 600, height: 800 })),
    renderPage: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
    destroy: vi.fn(async () => {}),
  })),
}));

function makeNote(over: Partial<Note>): Note {
  return {
    id: IMG_ID,
    notebookId: NB,
    title: 'file',
    properties: {},
    body: [],
    version: 1,
    createdAt: '2026-06-19T00:00:00.000Z',
    updatedAt: '2026-06-19T00:00:00.000Z',
    syncStatus: 'synced',
    ...over,
  };
}

function fileNote(id: Note['id'], filename: string, mime: string): Note {
  return makeNote({
    id,
    title: filename,
    properties: setFileType({}),
    body: [{ id: `${id}-b` as never, type: 'attachment', content: { hash: `${id}hash`, name: filename, mime, size: 4242 } }],
  });
}

async function mountRoute(id: Note['id'], note: Note) {
  const { db } = await import('../src/db/schema.js');
  await db.notes.put(note as Parameters<typeof db.notes.put>[0]);
  // Side-effect: register FileNoteView (App.tsx does this at init; we mount NoteRoute directly).
  await import('../src/views/registerFileNoteView.js');
  const { NoteRoute } = await import('../src/routes/NoteRoute.js');
  return render(
    <MemoryRouter initialEntries={[`/note/${id}`]}>
      <Routes>
        <Route path="/note/:id" element={<NoteRoute />} />
        <Route path="/" element={<div>LIST VIEW</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(async () => {
  const { db } = await import('../src/db/schema.js');
  await Promise.all(db.tables.map((t) => t.clear()));
  localStorage.clear();
  loadViewUrl.mockReset().mockResolvedValue(VIEW_URL);
  downloadBlob.mockReset().mockResolvedValue(undefined);
  loadBlobBytes.mockReset().mockResolvedValue(new ArrayBuffer(8));
  // Desktop so the route renders predictably; matchMedia → true.
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} }));
  global.fetch = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })) as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('FileNoteView — open surface', () => {
  it('FNV-1 — image file note opens in FileNoteView with the mocked view-derivative preview, not the PM editor', async () => {
    await mountRoute(IMG_ID, fileNote(IMG_ID, 'photo.png', 'image/png'));

    // Resolves to the file viewer, not the ProseMirror editor.
    await waitFor(() => expect(document.querySelector('.file-view')).not.toBeNull());
    expect(document.querySelector('.editor__edited-line')).toBeNull(); // PM editor's edited line absent

    // The inline preview <img> paints from the mocked `…/:hash/view` derivative URL.
    await waitFor(() => {
      const img = document.querySelector('.file-view__image') as HTMLImageElement | null;
      expect(img).not.toBeNull();
      expect(img!.getAttribute('src')).toBe(VIEW_URL);
    });
    expect(loadViewUrl).toHaveBeenCalledWith(`${IMG_ID}hash`);
  });

  it('FNV-2 — pdf file note opens the in-app PDF reader, not the "no preview" icon or an <img>', async () => {
    await mountRoute(PDF_ID, fileNote(PDF_ID, 'Q3-report.pdf', 'application/pdf'));

    await waitFor(() => expect(document.querySelector('.pdf-reader')).not.toBeNull());
    expect(document.querySelector('.file-view__nopreview')).toBeNull(); // old branch gone for pdfs
    expect(document.querySelector('.file-view__image')).toBeNull(); // no <img> at all
    // pdf goes through loadBlobBytes (raw bytes), never the image-derivative path.
    expect(loadViewUrl).not.toHaveBeenCalled();
    await waitFor(() => expect(loadBlobBytes).toHaveBeenCalledWith(`${PDF_ID}hash`));
  });

  it('FNV-3 — a normal note still resolves to the PM block editor (no regression)', async () => {
    await mountRoute(TXT_ID, makeNote({ id: TXT_ID, title: 'Just prose', properties: {}, body: [] }));

    // PM editor renders (its edited line); the file viewer does NOT.
    await waitFor(() => expect(document.querySelector('.editor__edited-line')).not.toBeNull());
    expect(document.querySelector('.file-view')).toBeNull();
  });

  it('FNV-4 — Delete soft-deletes the note (sys:trashedAt) and returns to the list', async () => {
    await mountRoute(IMG_ID, fileNote(IMG_ID, 'photo.png', 'image/png'));
    await waitFor(() => expect(document.querySelector('.file-view')).not.toBeNull());

    fireEvent.click(screen.getByText('Delete'));

    const { db } = await import('../src/db/schema.js');
    await waitFor(async () => {
      const stored = await db.notes.get(IMG_ID);
      expect(stored && isTrashed(stored.properties)).toBe(true);
    });
    await waitFor(() => expect(screen.queryByText('LIST VIEW')).not.toBeNull());
  });

  it('FNV-5 — Rename edits the note title (persisted via onSave → mutateNotes.put)', async () => {
    await mountRoute(IMG_ID, fileNote(IMG_ID, 'photo.png', 'image/png'));
    await waitFor(() => expect(document.querySelector('.file-view')).not.toBeNull());

    fireEvent.click(screen.getByText('Rename'));
    const input = screen.getByLabelText('Filename') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'renamed.png' } });
    fireEvent.click(screen.getByText('Save'));

    const { db } = await import('../src/db/schema.js');
    await waitFor(async () => {
      const stored = await db.notes.get(IMG_ID);
      expect(stored?.title).toBe('renamed.png');
    });
  });

  it('FNV-6 — preview falls back to the format icon when the view fetch rejects', async () => {
    loadViewUrl.mockReset().mockRejectedValue(new Error('404 not baked'));
    await mountRoute(IMG_ID, fileNote(IMG_ID, 'photo.png', 'image/png'));

    await waitFor(() => expect(document.querySelector('.file-view')).not.toBeNull());
    // No broken <img>; the format icon fallback is shown instead.
    await waitFor(() => expect(document.querySelector('.file-view__nopreview-icon')).not.toBeNull());
    expect(document.querySelector('.file-view__image')).toBeNull();
  });
});
