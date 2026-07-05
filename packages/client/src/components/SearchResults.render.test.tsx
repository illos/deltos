import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * ROAD-0014 result surfacing: a search hit that came from inside a PDF renders a "p. N" page badge AND its
 * result link deep-links the peek to that page (`/note/:id?page=N`). An image OCR hit (page null) shows no
 * badge and links without a page. jsdom pins the structural contract; feel is verified on deploy.
 */

const searchNotesMock = vi.fn();
vi.mock('../lib/search.js', () => ({ searchNotes: (...a: unknown[]) => searchNotesMock(...a) }));
vi.mock('../db/storeHooks.js', () => ({ useNotes: () => [], useNotebooks: () => [] }));
vi.mock('../lib/notebookStore.js', () => ({
  useNotebookStore: (sel: (s: unknown) => unknown) => sel({ currentNotebookId: null }),
}));
vi.mock('../lib/notePreview.js', () => ({ formatSmartDate: () => 'today' }));

async function importBody() {
  return (await import('./SearchResults.js')).SearchResultsBody;
}

const result = (over: Record<string, unknown>) => ({
  note: { id: 'r1', notebookId: null, title: 'report.pdf', updatedAt: '2026-07-05T00:00:00.000Z' },
  score: 100,
  snippet: '…quarterly revenue reached a pineapple milestone…',
  snippetRanges: [],
  titleRanges: [],
  page: null,
  ...over,
});

afterEach(() => { cleanup(); searchNotesMock.mockReset(); });

describe('SearchResults — extract page badge + deep-link', () => {
  it('renders a "p. N" badge and links to ?page=N when the match came from a PDF page', async () => {
    searchNotesMock.mockReturnValue([result({ page: 12 })]);
    const Body = await importBody();
    const { getByText, container } = render(
      <MemoryRouter><Body debouncedQuery="pineapple" /></MemoryRouter>,
    );
    expect(getByText('p. 12')).toBeTruthy();
    const link = container.querySelector('a.search__row-link') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/note/r1?page=12');
  });

  it('no badge + no page in the link for a body / image (page null) match', async () => {
    searchNotesMock.mockReturnValue([result({ page: null })]);
    const Body = await importBody();
    const { queryByText, container } = render(
      <MemoryRouter><Body debouncedQuery="pineapple" /></MemoryRouter>,
    );
    expect(queryByText(/^p\. /)).toBeNull();
    const link = container.querySelector('a.search__row-link') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/note/r1');
  });
});
