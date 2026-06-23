/**
 * #75 — notebook-name PILL on All-Notes rows. In the null (All-Notes) aggregate, a categorized note shows
 * a pill with its notebook's name; an uncategorized note (notebookId null) shows none; a specific-notebook
 * view shows no pills (redundant). Seeds the store via Dexie like the §2 list gate.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { NotebookId, NoteId } from '@deltos/shared';
import { HomeView } from '../src/App.js';

const NB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as NotebookId;
const CAT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as NoteId;   // categorized → notebook NB
const UNCAT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' as NoteId; // uncategorized → notebookId null

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
    { id: CAT, notebookId: NB, title: 'Categorized', properties: {}, body: [], version: 1, createdAt: 'x', updatedAt: '2026-06-20T14:00:00.000Z', syncStatus: 'synced', accountId: 'acct-1' },
    { id: UNCAT, notebookId: null, title: 'Uncategorized', properties: {}, body: [], version: 1, createdAt: 'x', updatedAt: '2026-06-20T13:00:00.000Z', syncStatus: 'synced', accountId: 'acct-1' },
  ] as never);
  global.fetch = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })) as typeof fetch;
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('#75 notebook pill — All-Notes list', () => {
  it('categorized note shows its notebook pill; uncategorized note shows none', async () => {
    const { useNotebookStore } = await import('../src/lib/notebookStore.js');
    useNotebookStore.setState({ _ready: true, currentNotebookId: null }); // All-Notes header
    render(<MemoryRouter><HomeView notebookId={null} /></MemoryRouter>);
    await screen.findByText('Categorized');

    // exactly one pill — on the categorized row — with the notebook name
    const pills = document.querySelectorAll('.home__note-nb-pill');
    expect(pills.length).toBe(1);
    expect(pills[0]!.textContent).toBe('Field Notes');

    const catRow = screen.getByText('Categorized').closest('a')!;
    expect(catRow.querySelector('.home__note-nb-pill')?.textContent).toBe('Field Notes');
    const uncatRow = screen.getByText('Uncategorized').closest('a')!;
    expect(uncatRow.querySelector('.home__note-nb-pill')).toBeNull();
  });

  it('specific-notebook view shows NO pills (redundant)', async () => {
    render(<MemoryRouter><HomeView notebookId={NB} /></MemoryRouter>);
    await screen.findByText('Categorized');
    expect(document.querySelectorAll('.home__note-nb-pill').length).toBe(0);
  });
});
