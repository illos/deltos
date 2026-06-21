/**
 * Lane 2 Pass D — §2 note-list content (routed-tree DOM gate). Proves the static-vibe list treatment:
 * the header carries the notebook name + N-notes count + a compose affordance + the persistent search
 * field, "All Notes" names the null aggregate, and the open note's row is marked selected (the
 * master-detail accent). Visual fidelity (spacing/type/colors) is navSys-3's screenshot diff.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { NotebookId, NoteId } from '@deltos/shared';
import { HomeView } from '../src/App.js';

const NB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as NotebookId;
const NOTE_1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as NoteId;
const NOTE_2 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' as NoteId;

beforeEach(async () => {
  const { db } = await import('../src/db/schema.js');
  await Promise.all(db.tables.map((t) => t.clear()));
  localStorage.clear();
  const { useAuthStore } = await import('../src/auth/store.js');
  useAuthStore.setState({ accountId: 'acct-1', bearerToken: 'tok', sessionState: 'active' });
  const { useNotebookStore } = await import('../src/lib/notebookStore.js');
  useNotebookStore.setState({ _ready: true, currentNotebookId: NB });
  await db.notebooks.put({
    id: NB, name: 'Field Notes', defaultCollectionView: 'list', isDefault: true,
    version: 1, createdAt: 'x', updatedAt: 'x', deletedAt: null, syncSeq: 1,
  } as never);
  await db.notes.bulkPut([
    { id: NOTE_1, notebookId: NB, title: 'First note', properties: {}, body: [], version: 1, createdAt: 'x', updatedAt: '2026-06-20T14:00:00.000Z', syncStatus: 'synced', accountId: 'acct-1' },
    { id: NOTE_2, notebookId: NB, title: 'Second note', properties: {}, body: [], version: 1, createdAt: 'x', updatedAt: '2026-06-20T13:00:00.000Z', syncStatus: 'synced', accountId: 'acct-1' },
  ] as never);
  global.fetch = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })) as typeof fetch;
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('HomeView — §2 list content (Pass D)', () => {
  it('header = notebook name + N-notes count + compose affordance + search field', async () => {
    render(<MemoryRouter><HomeView notebookId={NB} /></MemoryRouter>);
    expect(await screen.findByRole('heading', { name: 'Field Notes' })).toBeTruthy();
    expect(screen.getByText('2 notes')).toBeTruthy();
    expect(screen.getByLabelText('New note')).toBeTruthy(); // compose, top-right (off the FAB)
    expect(screen.getByText('Search')).toBeTruthy(); // persistent search field placeholder
  });

  it('null notebookId names the aggregate "All Notes" in the header', async () => {
    const { useNotebookStore } = await import('../src/lib/notebookStore.js');
    useNotebookStore.setState({ _ready: true, currentNotebookId: null });
    render(<MemoryRouter><HomeView notebookId={null} /></MemoryRouter>);
    expect(await screen.findByRole('heading', { name: 'All Notes' })).toBeTruthy();
  });

  it('the open note row is marked selected (master-detail accent) via aria-current + --selected', async () => {
    render(
      <MemoryRouter initialEntries={[`/note/${NOTE_1}`]}>
        <HomeView notebookId={NB} />
      </MemoryRouter>,
    );
    const openLink = (await screen.findByText('First note')).closest('a')!;
    expect(openLink.getAttribute('aria-current')).toBe('page');
    expect(openLink.className).toContain('home__note-link--selected');
    // the other row is NOT selected
    const otherLink = screen.getByText('Second note').closest('a')!;
    expect(otherLink.className).not.toContain('home__note-link--selected');
  });
});
