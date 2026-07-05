/**
 * FileNoteView — rendered-UI gate for the PDF preview rev (Jim). jsdom does NO layout, so the flex-fill SIZING
 * (full-width + full-height + internal scroll) is asserted STRUCTURALLY via classes/DOM nesting and is
 * feel-tested on deploy. What we lock here:
 *   - a PDF file note uses the `.file-view--pdf` layout where the preview is a SIBLING of `.file-view__inner`
 *     (hoisted OUT of the centered 680 column so it can bleed full-width), with header/actions/metadata staying
 *     inside `__inner`, and the lazy reader mounts;
 *   - a non-PDF (image / unknown) file note keeps the ORIGINAL structure: the preview stays INSIDE `__inner`
 *     between the header and the actions row, and no `--pdf` modifier is applied.
 *
 * PdfReader + blobClient are mocked so no pdf.js worker / network is touched.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Note } from '@deltos/shared';

vi.mock('./pdf/PdfReader.js', () => ({ PdfReader: () => <div data-testid="pdf-reader" /> }));
vi.mock('../plugins/attachment/blobClient.js', () => ({
  loadViewUrl: vi.fn(async () => 'blob:view'),
  downloadBlob: vi.fn(async () => {}),
}));
vi.mock('../db/mutate.js', () => ({ mutateNotes: { softDelete: vi.fn(async () => {}), restore: vi.fn(async () => {}) } }));
vi.mock('../lib/toastEvents.js', () => ({ showActionToast: vi.fn() }));

import { FileNoteView } from './FileNoteView.js';

const UUID = '22222222-2222-4222-8222-222222222222';

function fileNoteWith(mime: string, name: string): Note {
  return {
    id: UUID as Note['id'],
    title: name,
    notebookId: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    version: 2,
    syncStatus: 'synced',
    properties: { fileType: { type: 'text', value: 'file' } },
    body: [{ id: 'b1', type: 'attachment', content: { hash: 'h', name, mime, size: 1234 } }] as Note['body'],
  } as Note;
}

function mount(note: Note) {
  return render(
    <MemoryRouter>
      <FileNoteView note={note} onSave={async () => {}} autoFocus={false} />
    </MemoryRouter>,
  );
}

afterEach(cleanup);

describe('FileNoteView — PDF preview rev layout', () => {
  it('a PDF file note hoists the full-width preview OUT of __inner and mounts the reader', async () => {
    const { container } = mount(fileNoteWith('application/pdf', 'Q3-report.pdf'));

    const root = container.querySelector('.file-view--pdf');
    expect(root).not.toBeNull();

    const inner = root!.querySelector('.file-view__inner');
    const preview = root!.querySelector('.file-view__preview--pdf');
    expect(inner).not.toBeNull();
    expect(preview).not.toBeNull();

    // The preview is a SIBLING of __inner (direct child of the pdf root), NOT nested inside the 680 column.
    expect(preview!.parentElement).toBe(root);
    expect(inner!.contains(preview)).toBe(false);

    // Header + actions stay in the centered column. (File metadata moved to the Info panel — no longer inline.)
    expect(inner!.querySelector('.file-view__header')).not.toBeNull();
    expect(inner!.querySelector('.file-view__actions')).not.toBeNull();
    expect(inner!.querySelector('.file-view__metadata')).toBeNull();

    // The lazy reader resolves inside the preview.
    expect(await screen.findByTestId('pdf-reader')).not.toBeNull();
  });

  it('a non-PDF file note keeps the original structure (preview INSIDE __inner, no --pdf modifier)', () => {
    const { container } = mount(fileNoteWith('image/png', 'photo.png'));

    expect(container.querySelector('.file-view--pdf')).toBeNull();
    const inner = container.querySelector('.file-view__inner');
    expect(inner).not.toBeNull();

    // The (image/no-preview) preview lives INSIDE the centered column, between the header and the actions.
    const preview = inner!.querySelector('.file-view__preview');
    expect(preview).not.toBeNull();
    expect(preview!.classList.contains('file-view__preview--pdf')).toBe(false);
    expect(inner!.querySelector('.file-view__actions')).not.toBeNull();
    // File metadata moved to the Info panel — the inline dl is gone from the file view.
    expect(inner!.querySelector('.file-view__metadata')).toBeNull();
  });
});
