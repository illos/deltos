/**
 * File-note artifact pill — mounted-DOM gate (file-notes.md §3.1; gates FN-4, FN-5).
 *
 * [[ui-features-need-rendered-ui-gate]]: unit-green ≠ usable. These MOUNT the routed HomeView list tree and
 * assert the real DOM:
 *   - an IMAGE file note renders a square thumbnail TILE painted from the /:hash/thumb derivative (FN-5);
 *   - a NON-IMAGE file note renders the right extension-first format ICON, not a thumbnail (FN-4);
 *   - a NORMAL note still renders as an ordinary prose row — no pill, no regression.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setFileType } from '@deltos/shared';
import type { Note, NotebookId, BlockId } from '@deltos/shared';
import { screen } from './renderHelpers.js';

// The pill's leading visual dynamic-imports the blob client for image thumbnails — mock it so the tile
// fetch resolves to a deterministic object URL (no network), and uploadBlob is stubbed for completeness.
const THUMB_URL = 'blob:mock-thumb-url';
vi.mock('../src/plugins/attachment/blobClient.js', () => ({
  loadThumbUrl: vi.fn(async () => THUMB_URL),
  loadViewUrl: vi.fn(async () => 'blob:mock-view-url'),
  uploadBlob: vi.fn(async () => ({ hash: 'h', size: 1 })),
}));

const NB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as NotebookId;

function attachmentBlock(content: { hash: string; name: string; mime: string; size: number }) {
  return { id: '11111111-1111-4111-8111-111111111111' as BlockId, type: 'attachment', content };
}

function fileNote(id: string, name: string, mime: string, hash: string): Note {
  return {
    id: id as Note['id'],
    notebookId: NB,
    title: name,
    properties: setFileType({}),
    body: [attachmentBlock({ hash, name, mime, size: 4096 })],
    version: 1,
    createdAt: '2026-06-28T00:00:00.000Z',
    updatedAt: '2026-06-28T00:00:00.000Z',
    syncStatus: 'synced',
  };
}

function normalNote(id: string, title: string): Note {
  return {
    id: id as Note['id'],
    notebookId: NB,
    title,
    properties: {},
    body: [],
    version: 1,
    createdAt: '2026-06-28T00:00:00.000Z',
    updatedAt: '2026-06-28T00:00:00.000Z',
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

async function mountWith(notes: Note[]) {
  const { db } = await import('../src/db/schema.js');
  await db.notes.bulkPut(notes);
  const { HomeView } = await import('../src/App.js');
  render(
    <MemoryRouter>
      <HomeView notebookId={null} />
    </MemoryRouter>,
  );
}

describe('file-note list pill', () => {
  it('FN-5: an IMAGE file note renders a square thumbnail tile from the /:hash/thumb derivative', async () => {
    await mountWith([fileNote('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'sunset.png', 'image/png', 'imghash')]);

    // filename shows…
    await waitFor(() => expect(screen.queryByText('sunset.png')).not.toBeNull());
    // …and the leading visual is a thumbnail <img> pointing at the mocked derivative URL (not a format icon).
    const row = screen.getByText('sunset.png').closest('a')!;
    await waitFor(() => {
      const tile = row.querySelector('img.home__pill-thumb') as HTMLImageElement | null;
      expect(tile).not.toBeNull();
      expect(tile!.getAttribute('src')).toBe(THUMB_URL);
    });
    expect(row.querySelector('.home__pill-icon')).toBeNull();
  });

  it('FN-4: a NON-IMAGE file note renders the extension-first format icon (PDF), not a thumbnail', async () => {
    await mountWith([fileNote('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'Q3-report.pdf', 'application/pdf', 'pdfhash')]);

    await waitFor(() => expect(screen.queryByText('Q3-report.pdf')).not.toBeNull());
    const row = screen.getByText('Q3-report.pdf').closest('a')!;
    // a format-icon container, NOT a thumbnail tile…
    expect(row.querySelector('img.home__pill-thumb')).toBeNull();
    expect(row.querySelector('.home__pill-icon')).not.toBeNull();
    // …and specifically the PDF glyph (its inline <text> label).
    expect(row.querySelector('.home__pill-icon svg text')?.textContent).toBe('PDF');
  });

  it('a NORMAL note still renders as an ordinary prose row — no pill, no regression', async () => {
    await mountWith([normalNote('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'Plain note')]);

    await waitFor(() => expect(screen.queryByText('Plain note')).not.toBeNull());
    const row = screen.getByText('Plain note').closest('a')!;
    expect(row.className).not.toContain('home__note-link--file');
    expect(row.querySelector('.home__pill')).toBeNull();
    // the standard prose-row meta line is present.
    expect(row.querySelector('.home__note-meta')).not.toBeNull();
  });
});
