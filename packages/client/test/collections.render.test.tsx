/**
 * Collections UI — mounted component/integration tests (collections.md §5.1,
 * standing [ui-features-need-rendered-ui-gate]).
 *
 * Proves the routed note-list tree:
 *   - accordion headers appear for the notebook's live collections
 *   - expand reveals member notes (local join; trashed hidden)
 *   - All Notes (null notebookId) mounts NO collection accordions
 *   - add-to-collection sheet reflects membership after mutateCollections.addNotes
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Note, NoteId, NotebookId, CollectionId } from '@deltos/shared';
import { collectionMemberId } from '@deltos/shared';

const NB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as NotebookId;
const NOTE_A = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as NoteId;
const NOTE_B = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' as NoteId;
const COLL = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' as CollectionId;

vi.mock('../src/lib/useIsDesktop.js', () => ({ useIsDesktop: () => false }));
vi.mock('../src/lib/useKeypadMode.js', () => ({ useKeypadMode: () => false }));
vi.mock('../src/lib/dnd/useNoteDnd.js', () => ({ useNoteDnd: () => null }));
vi.mock('../src/lib/dnd/useFileNoteDnd.js', () => ({ useFileNoteDnd: () => null }));
vi.mock('../src/lib/upload/useFilePickerUpload.js', () => ({ useFilePickerUpload: () => null }));
vi.mock('../src/components/NavSheet.js', () => ({ useNavSheetArm: () => ({}) }));
vi.mock('../src/lib/syncEngine.js', () => ({ notifyQueueWrite: vi.fn(), syncNow: vi.fn() }));
vi.mock('../src/lib/toastEvents.js', () => ({ showToast: vi.fn(), showActionToast: vi.fn() }));

// Lazy chunks resolve immediately in vitest; still need Suspense. Seed Dexie so liveQuery hooks work.

function note(id: NoteId, title: string, props: Record<string, unknown> = {}): Note {
  return {
    id,
    notebookId: NB,
    title,
    properties: props,
    body: [],
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    syncStatus: 'synced',
  };
}

beforeEach(async () => {
  const { db } = await import('../src/db/schema.js');
  await Promise.all([
    db.notes.clear(),
    db.collections.clear(),
    db.collectionMembers.clear(),
    db.collectionQueue.clear(),
    db.collectionMemberQueue.clear(),
    db.notebooks.clear(),
  ]);
  await db.notebooks.put({
    id: NB,
    name: 'Work',
    defaultCollectionView: 'list',
    noteSort: 'modified',
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    syncSeq: 1,
  });
  await db.notes.put(note(NOTE_A, 'Invoice April'));
  await db.notes.put(note(NOTE_B, 'Trash candidate', {
    'sys:trashedAt': { type: 'date', value: '2026-01-03T00:00:00.000Z' },
  }));
  await db.collections.put({
    id: COLL,
    notebookId: NB,
    name: 'Invoices',
    ord: 0,
    rule: null,
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    syncSeq: 1,
  });
  await db.collectionMembers.put({
    id: collectionMemberId(COLL, NOTE_A),
    collectionId: COLL,
    noteId: NOTE_A,
    ord: 0,
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    syncSeq: 1,
  });
  // Trashed note also a member — must stay hidden in the accordion body.
  await db.collectionMembers.put({
    id: collectionMemberId(COLL, NOTE_B),
    collectionId: COLL,
    noteId: NOTE_B,
    ord: 1,
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    syncSeq: 1,
  });

  const { useNotebookStore } = await import('../src/lib/notebookStore.js');
  useNotebookStore.setState({
    _ready: true,
    currentNotebookId: NB,
    openCollectionIds: new Set(),
  });
});

afterEach(() => {
  cleanup();
});

describe('HomeView collections accordion (mounted)', () => {
  it('renders collection headers for the notebook and expands to show live members only', async () => {
    const { HomeView } = await import('../src/App.js');
    const { DeckHostProvider } = await import('../src/components/DeckHost.js');

    const { getByText, queryByText, getByRole } = render(
      <MemoryRouter>
        <DeckHostProvider enabled>
          <HomeView notebookId={NB} />
        </DeckHostProvider>
      </MemoryRouter>,
    );

    // Accordion header appears (lazy chunk).
    await waitFor(() => expect(getByText('Invoices')).not.toBeNull());

    // Collapsed by default — member title not yet in the accordion body region.
    // (It still appears in the flat loose list below — overlay, not partition.)
    expect(getByText('Invoice April')).not.toBeNull(); // flat list

    // Wait for the member join (liveQuery) so the count reflects live non-trashed members.
    await waitFor(() => {
      const toggle = document.querySelector('.home__collection-toggle') as HTMLButtonElement | null;
      expect(toggle?.textContent).toMatch(/Invoices/);
      expect(toggle?.querySelector('.home__collection-count')?.textContent).toBe('1');
    });

    // Expand in place (toggle button, not the manage "…" which also contains the name).
    await act(async () => {
      fireEvent.click(document.querySelector('.home__collection-toggle')!);
    });

    await waitFor(() => {
      // Expanded region labeled with the collection name.
      expect(getByRole('region', { name: /Invoices notes/i })).not.toBeNull();
    });
    // Trashed member must not render as a note row title in the accordion (filter).
    // NOTE_B title should not appear — only in trash; useNotes excludes it so flat list hides it too.
    expect(queryByText('Trash candidate')).toBeNull();
  });

  it('All Notes (notebookId=null) shows NO collection accordions', async () => {
    const { HomeView } = await import('../src/App.js');
    const { DeckHostProvider } = await import('../src/components/DeckHost.js');
    const { useNotebookStore } = await import('../src/lib/notebookStore.js');
    useNotebookStore.setState({ currentNotebookId: null });

    const { queryByText, queryByLabelText } = render(
      <MemoryRouter>
        <DeckHostProvider enabled>
          <HomeView notebookId={null} />
        </DeckHostProvider>
      </MemoryRouter>,
    );

    // Give lazy/liveQuery a tick; section must not mount.
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(queryByLabelText('Collections')).toBeNull();
    expect(queryByText('Invoices')).toBeNull();
  });
});

describe('CollectionsSection + addNotes reflection', () => {
  it('after addNotes, expanding shows the new member', async () => {
    const { db } = await import('../src/db/schema.js');
    const NOTE_C = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' as NoteId;
    await db.notes.put(note(NOTE_C, 'New member'));

    const { CollectionsSection } = await import('../src/components/CollectionsSection.js');
    const { useNotebookStore } = await import('../src/lib/notebookStore.js');
    const { mutateCollections } = await import('../src/db/mutateCollections.js');

    const allNotes = [note(NOTE_A, 'Invoice April'), note(NOTE_C, 'New member')];

    const { getByText, getByRole, queryByText } = render(
      <MemoryRouter>
        <CollectionsSection
          notebookId={NB}
          notes={allNotes}
          renderNoteRow={(n) => (
            <li key={n.id}>
              <span>{n.title}</span>
            </li>
          )}
        />
      </MemoryRouter>,
    );

    await waitFor(() => expect(getByText('Invoices')).not.toBeNull());

    await act(async () => {
      await mutateCollections.addNotes(COLL, [NOTE_C]);
    });

    await act(async () => {
      fireEvent.click(document.querySelector('.home__collection-toggle')!);
    });

    await waitFor(() => {
      expect(getByText('New member')).not.toBeNull();
      expect(getByText('Invoice April')).not.toBeNull();
    });
    expect(queryByText('Trash candidate')).toBeNull();

    // Open state is device-local in the zustand store.
    expect(useNotebookStore.getState().openCollectionIds.has(COLL)).toBe(true);
  });
});
