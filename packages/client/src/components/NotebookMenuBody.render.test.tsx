import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';

/**
 * NotebookMenuBody render test (notebook-menu-and-keep-view.md §2–§7, standing ui-features-need-rendered-ui-gate).
 * Proves the four residents render and fire their mutators:
 *   - Rename → expands an inline field → mutateNotebooks.rename + notifyQueueWrite on Save;
 *   - Sort → the 4-mode select fires mutateNotebooks.setNoteSort with the chosen mode + reflects the active one;
 *   - View → fires mutateNotebooks.setDefaultCollectionView (options come from the registry + the 'list' default);
 *   - All Notes (null notebook) hides Rename + Share; Sort/View still render.
 */

const { rename, setNoteSort, setDefaultCollectionView, notifyQueueWrite, createCollection } = vi.hoisted(() => ({
  rename: vi.fn(),
  setNoteSort: vi.fn(),
  setDefaultCollectionView: vi.fn(),
  notifyQueueWrite: vi.fn(),
  createCollection: vi.fn().mockResolvedValue('coll-1'),
}));

const nb = { current: { id: 'nb-1', name: 'Work', defaultCollectionView: 'list', noteSort: 'alpha' } as
  { id: string; name: string; defaultCollectionView: string; noteSort: string } | null };

vi.mock('../db/storeHooks.js', () => ({ useCurrentNotebook: () => nb.current }));
vi.mock('../auth/store.js', () => ({
  useAuthStore: (sel: (s: { accountId: string | null }) => unknown) => sel({ accountId: 'acct-1' }),
}));
vi.mock('../db/mutateNotebooks.js', () => ({ mutateNotebooks: { rename, setNoteSort, setDefaultCollectionView } }));
vi.mock('../db/mutateCollections.js', () => ({ mutateCollections: { create: createCollection } }));
vi.mock('../lib/syncEngine.js', () => ({ notifyQueueWrite }));
// Registry: 'board' is registered so the View list shows List + Board.
vi.mock('../lib/collectionViews.js', () => ({
  listCollectionViews: () => [{ key: 'board', matches: () => false, component: () => null }],
}));

import { NotebookMenuBody } from './NotebookMenuBody.js';

beforeEach(() => {
  vi.clearAllMocks();
  nb.current = { id: 'nb-1', name: 'Work', defaultCollectionView: 'list', noteSort: 'alpha' };
});
afterEach(cleanup);

describe('NotebookMenuBody', () => {
  it('Rename expands an inline field and commits via mutateNotebooks.rename + notifyQueueWrite', async () => {
    const onClose = vi.fn();
    const { getByText, getByLabelText } = render(
      <NotebookMenuBody notebookId={'nb-1' as never} onClose={onClose} />,
    );
    fireEvent.click(getByText('Rename notebook'));
    const field = getByLabelText('Notebook name') as HTMLInputElement;
    expect(field.value).toBe('Work'); // pre-filled with the current name
    fireEvent.change(field, { target: { value: 'Personal' } });
    fireEvent.click(getByText('Save'));
    await waitFor(() => expect(rename).toHaveBeenCalledWith('nb-1', 'Personal'));
    expect(notifyQueueWrite).toHaveBeenCalledWith('nb-1');
    expect(onClose).toHaveBeenCalled();
  });

  it('Sort reflects the active mode and fires setNoteSort on select', () => {
    const { getByText, getByRole } = render(
      <NotebookMenuBody notebookId={'nb-1' as never} onClose={() => {}} />,
    );
    fireEvent.click(getByText('Sort'));
    // Active mode 'alpha' is checked.
    expect(getByRole('radio', { name: /Alphabetical/ }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(getByRole('radio', { name: /Date created/ }));
    expect(setNoteSort).toHaveBeenCalledWith('nb-1', 'created');
  });

  it('View lists List + Board (from the registry) and fires setDefaultCollectionView', () => {
    const { getByText, getByRole } = render(
      <NotebookMenuBody notebookId={'nb-1' as never} onClose={() => {}} />,
    );
    fireEvent.click(getByText('View'));
    expect(getByRole('radio', { name: /List/ })).not.toBeNull();
    fireEvent.click(getByRole('radio', { name: /Board/ }));
    expect(setDefaultCollectionView).toHaveBeenCalledWith('nb-1', 'board');
  });

  it('New collection expands an inline field and commits via mutateCollections.create', async () => {
    const onClose = vi.fn();
    const { getByText, getByLabelText } = render(
      <NotebookMenuBody notebookId={'nb-1' as never} onClose={onClose} />,
    );
    fireEvent.click(getByText('New collection'));
    const field = getByLabelText('Collection name') as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'Invoices' } });
    fireEvent.click(getByText('Create'));
    await waitFor(() => expect(createCollection).toHaveBeenCalledWith('nb-1', 'Invoices'));
    expect(notifyQueueWrite).toHaveBeenCalledWith('nb-1');
    expect(onClose).toHaveBeenCalled();
  });

  it('All Notes (null notebook) hides Rename + Share + New collection, keeps Sort + View', () => {
    nb.current = null;
    const { queryByText, getByText } = render(
      <NotebookMenuBody notebookId={null} onClose={() => {}} />,
    );
    expect(queryByText('New collection')).toBeNull();
    expect(queryByText('Rename notebook')).toBeNull();
    expect(queryByText('Share notebook')).toBeNull();
    expect(getByText('Sort')).not.toBeNull();
    expect(getByText('View')).not.toBeNull();
  });
});
